// ============================================================
// $SABOTEUR - per-match settlement (back-your-vote + rank rewards) and the
// ledger every player / the admin / judges can read.
// Numbers live in ./rules.js. Chain calls live in ./saboteurToken.js.
// ============================================================
const mongoose = require("mongoose");
const { RULES, rewardFor, humanMultiplier } = require("./rules");
const T = require("./saboteurToken");

const ledgerSchema = new mongoose.Schema({
  matchId: { type: String, index: true },
  roomCode: String,
  holderType: { type: String, enum: ["player", "bot"], index: true },
  holderId: { type: String, index: true },   // Player _id, or bot persona name
  name: String,
  wallet: String,
  rank: Number,
  players: Number,
  humans: Number,
  points: Number,                            // final match points (incl. backed-vote result)
  backs: { type: [{ target: String, correct: Boolean, delta: Number }], default: [] },
  multiplier: Number,
  reducedForDay: Boolean,
  playPass: Boolean,                         // reward doubled for a Play Pass holder
  toBotTreasury: Boolean,                    // bot was over its cap: paid to the Bot Treasury
  amount: Number,                            // whole $SABOTEUR
  status: { type: String, enum: ["pending", "sent", "failed", "skipped"], default: "pending", index: true },
  txHash: String,
  // [NO DOUBLE PAY] the batch's transaction is signed and saved BEFORE it is
  // sent; a retry re-sends this exact transaction (same nonce) instead of a new one
  signedTx: String,
  error: String,
  createdAt: { type: Date, default: Date.now, index: true },
});
const TokenLedger = mongoose.models.TokenLedger || mongoose.model("TokenLedger", ledgerSchema);

// ---- back your vote ----
function backVoteAllowed(room) {
  return !(RULES.backVote.freePlayOnly && room && room.pool);
}
function recordBack(room, voterId, targetId) {
  if (!room || !targetId || targetId === "skip" || !backVoteAllowed(room)) return false;
  room.backVotes = room.backVotes || [];
  room.backVotes.push({ voterId, targetId, meetingNo: room.meetingNo || 1 });
  return true;
}
// +points for every backed vote on a real saboteur, -points otherwise.
function backsFor(room, playerId) {
  const out = [];
  for (const b of room.backVotes || []) {
    if (b.voterId !== playerId) continue;
    const t = room.players[b.targetId];
    if (!t || !t.role) continue; // target left the room: no result either way
    const correct = t.role === "saboteur";
    out.push({ target: t.name, correct, delta: correct ? RULES.backVote.points : -RULES.backVote.points });
  }
  return out;
}
function backDelta(room, playerId) {
  return backsFor(room, playerId).reduce((s, b) => s + b.delta, 0);
}

function startOfUtcDay() { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; }

// Called right after match points are staged (room.winner is decided).
// computePoints(player, winner) is the game's own point formula.
// Emits "matchRewards" to the room and pays out in the background.
async function settleMatch({ io, roomCode, room, computePoints, hasDb }) {
  try {
    const entries = Object.entries(room.players).filter(([, p]) => p && p.role);
    if (!entries.length) return;
    const humans = entries.filter(([, p]) => !p.isBot).length;
    const matchId = room.currentMatchId || `${roomCode}-${Date.now()}`;

    // Final points: humans with an account already have pendingPoints
    // (incl. backed votes, see stagePendingPointsForRoom); everyone else is
    // computed the same way here so bots and guests rank fairly too.
    const rows = entries.map(([id, p]) => {
      const backs = backsFor(room, id);
      const points = typeof p.pendingPoints === "number" && p.accountId
        ? p.pendingPoints
        : Math.max(0, computePoints(p, room.winner) + backs.reduce((s, b) => s + b.delta, 0));
      return { id, p, backs, points, won: p.role === room.winner };
    });
    rows.sort((a, b) => b.points - a.points || (b.won - a.won));
    rows.forEach((r, i) => { r.rank = i + 1; });

    // Daily cap: how many paid matches did each account already have today?
    const accountIds = rows.filter((r) => !r.p.isBot && r.p.accountId).map((r) => r.p.accountId);
    const todayCounts = {};
    if (hasDb && accountIds.length) {
      const agg = await TokenLedger.aggregate([
        { $match: { holderType: "player", holderId: { $in: accountIds }, createdAt: { $gte: startOfUtcDay() }, amount: { $gt: 0 } } },
        { $group: { _id: "$holderId", n: { $sum: 1 } } },
      ]).catch(() => []);
      for (const a of agg) todayCounts[a._id] = a.n;
    }

    // Bot cap: a bot already at/over RULES.botBalanceCap sends this match's
    // reward to the Bot Treasury instead of its own wallet.
    const botNames = rows.filter((r) => r.p.isBot).map((r) => r.p.name);
    const botEarned = {};
    if (hasDb && botNames.length) {
      const agg = await TokenLedger.aggregate([
        { $match: { holderType: "bot", holderId: { $in: botNames }, toBotTreasury: { $ne: true }, status: { $in: ["sent", "pending", "failed"] } } },
        { $group: { _id: "$holderId", sum: { $sum: "$amount" } } },
      ]).catch(() => []);
      for (const a of agg) botEarned[a._id] = a.sum;
    }

    const mult = humanMultiplier(humans);
    for (const r of rows) {
      const { p } = r;
      let holderType = p.isBot ? "bot" : "player";
      let eligible = true;
      if (p.isBot && !RULES.botsEarn) eligible = false;
      if (!p.isBot && !p.accountId && RULES.noRewardForGuests) eligible = false;
      const reducedForDay = !p.isBot && (todayCounts[p.accountId] || 0) >= RULES.dailyFullMatches;
      r.reducedForDay = reducedForDay;
      r.playPass = !p.isBot && !!p.accountId && !!p.hasPlayPass;
      r.amount = eligible ? rewardFor(r.rank, humans, { reducedForDay }) : 0;
      if (r.playPass && r.amount > 0) r.amount = Math.round(r.amount * (RULES.playPassMultiplier || 1) * 100) / 100;
      r.toBotTreasury = !!(p.isBot && T.BOT_TREASURY && (botEarned[p.name] || 0) >= RULES.botBalanceCap);
      r.wallet = !T.configured() || !eligible ? null : (p.isBot ? (r.toBotTreasury ? T.BOT_TREASURY : T.walletForBot(p.name)) : T.walletForPlayer(p.accountId));
      r.holderType = holderType;
      r.holderId = p.isBot ? p.name : (p.accountId || null);
      r.guest = !p.isBot && !p.accountId;
    }

    io.to(roomCode).emit("matchRewards", {
      matchId, humans, multiplier: mult, token: "SABOTEUR", network: "testnet",
      rows: rows.map((r) => ({
        id: r.id, name: r.p.name, isBot: !!r.p.isBot, guest: r.guest, rank: r.rank, points: r.points,
        backs: r.backs, backDelta: r.backs.reduce((s, b) => s + b.delta, 0),
        tokens: r.amount, reducedForDay: !!r.reducedForDay, playPass: !!r.playPass, wallet: r.wallet,
      })),
    });

    if (!hasDb) return;
    const docs = await TokenLedger.insertMany(rows.filter((r) => r.holderId).map((r) => ({
      matchId, roomCode, holderType: r.holderType, holderId: r.holderId, name: r.p.name, wallet: r.wallet,
      rank: r.rank, players: rows.length, humans, points: r.points, backs: r.backs, multiplier: mult,
      reducedForDay: !!r.reducedForDay, playPass: !!r.playPass, toBotTreasury: !!r.toBotTreasury, amount: r.amount, status: r.amount > 0 && r.wallet ? "pending" : "skipped",
    }))).catch((e) => { console.warn("[SABOTEUR] ledger write failed:", e.message); return []; });

    payPending(docs.filter((d) => d.status === "pending"), matchId);
  } catch (e) {
    console.warn("[SABOTEUR] settleMatch error:", e.message);
  }
}

async function payPending(docs, matchId) {
  if (!docs.length) return;
  const ids = docs.map((d) => d._id);
  const prior = docs.find((d) => d.signedTx && d.txHash);
  const res = await T.payMatch(docs.map((d) => ({ wallet: d.wallet, amount: d.amount })), `match ${matchId}`, {
    prior: prior ? { txHash: prior.txHash, signedTx: prior.signedTx } : null,
    onSigned: (txHash, signedTx) => TokenLedger.updateMany({ _id: { $in: ids } }, { $set: { txHash, signedTx } }),
  });
  await TokenLedger.updateMany({ _id: { $in: ids } },
    res.ok ? { $set: { status: "sent", txHash: res.txHash, error: null }, $unset: { signedTx: 1 } } : { $set: { status: "failed", error: res.error } },
  ).catch(() => {});
  if (res.ok) console.log(`[SABOTEUR] paid ${docs.length} wallets for ${matchId} (tx ${res.txHash})`);
}

// Retry anything that failed (chain hiccup, empty gas) - every 5 minutes.
let retryTimer = null;
function startRetryLoop() {
  if (retryTimer || !T.configured()) return;
  retryTimer = setInterval(async () => {
    try {
      const failed = await TokenLedger.find({ status: "failed", createdAt: { $gte: new Date(Date.now() - 7 * 864e5) } }).limit(50);
      const byMatch = {};
      for (const d of failed) (byMatch[d.matchId] ||= []).push(d);
      for (const [m, list] of Object.entries(byMatch)) await payPending(list, m);
    } catch (e) { /* next round */ }
  }, 5 * 60 * 1000);
}

// ---- reads (player wallet screen, bot page, admin) ----
async function playerSummary(accountId) {
  const wallet = T.configured() ? T.walletForPlayer(accountId) : null;
  const history = await TokenLedger.find({ holderType: "player", holderId: accountId }).sort({ createdAt: -1 }).limit(40).lean();
  const earned = history.reduce((s, h) => s + (h.status === "sent" ? h.amount : 0), 0);
  const pending = history.reduce((s, h) => s + (h.status === "pending" || h.status === "failed" ? h.amount : 0), 0);
  const onChain = wallet && history.length ? await T.balanceOf(wallet) : 0;
  return {
    token: "SABOTEUR", network: "testnet", tokenContract: T.TOKEN, wallet,
    walletUrl: wallet ? T.explorerAccount(wallet) : null,
    balance: onChain == null ? earned : onChain, pending,
    history: history.map((h) => ({
      matchId: h.matchId, rank: h.rank, players: h.players, humans: h.humans, points: h.points, backs: h.backs,
      amount: h.amount, reducedForDay: h.reducedForDay, status: h.status,
      txUrl: h.txHash ? T.explorerTx(h.txHash) : null, at: h.createdAt,
    })),
  };
}

let botCache = { at: 0, data: null };
async function botsSummary(botNames) {
  if (botCache.data && Date.now() - botCache.at < 60000) return botCache.data;
  const agg = await TokenLedger.aggregate([
    { $match: { holderType: "bot" } },
    { $group: {
      _id: "$holderId", matches: { $sum: 1 }, firsts: { $sum: { $cond: [{ $eq: ["$rank", 1] }, 1, 0] } },
      earned: { $sum: { $cond: [{ $eq: ["$status", "sent"] }, "$amount", 0] } },
      backs: { $push: "$backs" },
    } },
  ]).catch(() => []);
  const byName = Object.fromEntries(agg.map((a) => [a._id, a]));
  const bots = await Promise.all(botNames.map(async (name) => {
    const a = byName[name] || { matches: 0, firsts: 0, earned: 0, backs: [] };
    const flat = (a.backs || []).flat();
    const wallet = T.configured() ? T.walletForBot(name) : null;
    return {
      name, wallet, walletUrl: wallet ? T.explorerAccount(wallet) : null,
      matches: a.matches, firsts: a.firsts, earned: a.earned,
      backedVotes: flat.length, backedRight: flat.filter((b) => b.correct).length,
      balance: wallet ? await T.balanceOf(wallet) : null,
    };
  }));
  const data = {
    token: "SABOTEUR", network: "testnet", tokenContract: T.TOKEN, tokenUrl: T.TOKEN ? `https://testnet.nearblocks.io/token/${T.TOKEN}` : null,
    treasury: T.TREASURY, treasuryBalance: T.configured() ? await T.balanceOf(T.TREASURY) : null,
    botTreasury: T.BOT_TREASURY, botTreasuryBalance: T.configured() ? await T.balanceOf(T.BOT_TREASURY) : null, botCap: RULES.botBalanceCap, bots,
  };
  botCache = { at: Date.now(), data };
  return data;
}

async function adminSummary() {
  const since = new Date(Date.now() - 864e5);
  const [totals, last24, topPlayers, farm] = await Promise.all([
    TokenLedger.aggregate([{ $group: { _id: { t: "$holderType", s: "$status" }, amount: { $sum: "$amount" }, rows: { $sum: 1 } } }]),
    TokenLedger.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: "$holderType", amount: { $sum: "$amount" }, matches: { $addToSet: "$matchId" } } }]),
    TokenLedger.aggregate([{ $match: { holderType: "player" } }, { $group: { _id: "$holderId", name: { $last: "$name" }, earned: { $sum: "$amount" }, matches: { $sum: 1 } } }, { $sort: { earned: -1 } }, { $limit: 20 }]),
    // Farm flags: unusually many top-3 finishes, or grinding solo-with-bots, in the last 24h.
    TokenLedger.aggregate([
      { $match: { holderType: "player", createdAt: { $gte: since } } },
      { $group: { _id: "$holderId", name: { $last: "$name" }, matches: { $sum: 1 }, top3: { $sum: { $cond: [{ $lte: ["$rank", 3] }, 1, 0] } }, solo: { $sum: { $cond: [{ $eq: ["$humans", 1] }, 1, 0] } } } },
      { $match: { $or: [{ top3: { $gte: 8 } }, { solo: { $gte: 15 } }] } },
      { $sort: { matches: -1 } },
    ]),
  ]);
  const rewardsBalance = T.configured() ? await T.balanceOf(T.REWARDS) : null;
  return {
    token: T.TOKEN, treasury: T.TREASURY, treasuryBalance: T.configured() ? await T.balanceOf(T.TREASURY) : null,
    rewards: T.REWARDS, rewardsBalance, rewardsLow: rewardsBalance != null && rewardsBalance < RULES.rewardsLowWarning,
    botTreasury: T.BOT_TREASURY, botTreasuryBalance: T.configured() ? await T.balanceOf(T.BOT_TREASURY) : null,
    totals, last24: last24.map((x) => ({ holderType: x._id, amount: x.amount, matches: x.matches.length })), topPlayers, farmFlags: farm,
    rules: RULES,
  };
}

module.exports = { recordBack, backVoteAllowed, backDelta, backsFor, settleMatch, startRetryLoop, playerSummary, botsSummary, adminSummary, TokenLedger };
