// ============================================================
// Weekly Rewards Agent
// Every week the top 3 on the weekly Ranks get real NEAR (mainnet), paid
// by an agent account on NEAR Intents (NEAR Intents Agent API).
//
// Who can do what:
//   - saboteur.near (the OWNER) signs the agent's rules (its "policy") and
//     the game server's permission (a "grant"). The server never holds the
//     owner's key.
//   - The game server holds only the grant token (encrypted in MongoDB) and
//     the partner API key (env). With them it can ask the agent to withdraw
//     wNEAR, and only inside the owner-signed policy: withdraw-only, wNEAR
//     only, a weekly USD cap and a per-payment cap.
//
// Flow: at the weekly reset the top 3 are queued as ONE batch with ONE
// 30-minute timer (stored in the DB, so it survives restarts). Admin can
// "Send now" or "Cancel this week". At 0:00 all three are sent together.
// Every payment saves its Idempotency-Key BEFORE it is sent, so a crash or a
// lost response can never pay twice (a retry replays the same key).
// ============================================================
const mongoose = require("mongoose");
const crypto = require("crypto");

const BASE = (process.env.NEAR_INTENTS_AGENT_API_URL || "https://api.demo.agentsonintents.com").replace(/\/+$/, "");
const apiKey = () => String(process.env.NEAR_INTENTS_AGENT_API_KEY || "").trim();
const OWNER = String(process.env.WEEKLY_AGENT_OWNER || "saboteur.near").trim().toLowerCase();
const WNEAR = "nep141:wrap.near";
const DEFAULT_SPLIT = [50, 30, 20];
const COUNTDOWN_MS = 30 * 60 * 1000;
const HOLD_MS = 30 * 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const LATE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // never queue a week that ended more than 3 days ago
const AGENT_NAME = "NEAR Saboteur Weekly Rewards";
const OWNER_TERMS_URL = "https://partners.demo.agentsonintents.com/terms";
const OUTLAYER_TERMS_URL = "https://outlayer.fastnear.com/terms";
const RISK_NOTICE = "The NEAR Intents Agent API is an experimental, mainnet-only beta. You may lose all assets you put in this wallet, or lose access to them. Keep amounts small.";
const TERMINAL = new Set(["SUCCESS", "FAILED", "REFUNDED", "NEEDS_REVIEW"]);

// ---------------- models ----------------
const stateSchema = new mongoose.Schema({
  key: { type: String, default: "main", unique: true },
  enabled: { type: Boolean, default: false },
  enabledAt: { type: Date, default: null },
  // "Pay this week, then stop": the batch for the week ending at this time is
  // still created and paid, then the switch turns itself off.
  stopAfterWeekEnd: { type: Date, default: null },
  prizeUsd: { type: Number, default: 10 },
  split: { type: [Number], default: DEFAULT_SPLIT },
  agentId: { type: String, default: null },
  walletNearId: { type: String, default: null },
  grantEnc: { type: String, default: null },
  grantExpiresAt: { type: Date, default: null },
  mode: { type: String, enum: ["payout", "withdraw_to_owner"], default: "payout" },
  termsAcceptedAt: { type: Date, default: null },
  termsAcceptedBy: { type: String, default: null },
  onAnnouncedAt: { type: Date, default: null }, // last "weekly prizes are ON" News post
  // The owner action waiting for (or just given) saboteur.near's signature.
  pending: {
    correlationId: String,
    kind: String,
    createdAt: Date,
    expiresAt: Date,
    agentId: String,
    grantEnc: String,
    grantExpiresAt: Date,
    submittedAt: Date,
    status: String,
    error: String,
  },
  deposit: { address: String, memo: String, minAmount: String, expiresAt: Date, correlationId: String },
  ownerWithdraw: { idem: String, correlationId: String, amountRaw: String, status: String, txHash: String, error: String, at: Date, publicSource: Boolean },
}, { minimize: false });
const State = mongoose.models.WeeklyAgentState || mongoose.model("WeeklyAgentState", stateSchema);

const winnerSchema = new mongoose.Schema({
  rank: Number,
  playerId: mongoose.Schema.Types.ObjectId,
  name: String,
  username: String,
  points: Number,
  wallet: String,
  usd: Number,
  amountRaw: String,
  amountNear: Number,
  // queued (waiting for the timer) | held (no wallet yet) | sending | paid | failed | expired | cancelled
  status: { type: String, default: "queued" },
  idem: String,
  publicSource: { type: Boolean, default: null }, // pay from the legacy public balance
  correlationId: String,
  txHash: String,
  error: String,
  heldUntil: Date,
  paidAt: Date,
}, { _id: false });
const batchSchema = new mongoose.Schema({
  weekStart: { type: Date, required: true, unique: true },
  weekEnd: Date,
  label: String,
  // countdown | sending | done | cancelled
  status: { type: String, default: "countdown", index: true },
  sendAt: Date,
  prizeUsd: Number,
  nearPrice: Number,
  winners: [winnerSchema],
  announced: { type: Boolean, default: false },
  cancelledAt: Date,
  sentAt: Date,
  createdAt: { type: Date, default: Date.now, index: true },
});
const Batch = mongoose.models.WeeklyRewardBatch || mongoose.model("WeeklyRewardBatch", batchSchema);

// ---------------- deps from index.js ----------------
let D = null; // { Player, MatchRecord, Announcement, sendInboxMessage, cleanPayoutWallet, getCurrentWeekStartUTC, leaderboardResetAt, logAdminAction }

// ---------------- secrets ----------------
function encKey() {
  const base = process.env.WEEKLY_AGENT_SECRET || process.env.MONGODB_URI || "";
  if (!base) throw new Error("no_secret");
  return crypto.createHash("sha256").update("weekly-agent-grant:" + base).digest();
}
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join(".");
}
function decrypt(blob) {
  const [iv, tag, ct] = String(blob || "").split(".").map((s) => Buffer.from(s, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", encKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}
function newGrantCredential() {
  const token = "ngt_" + crypto.randomBytes(32).toString("base64url");
  const commitment = crypto.createHash("sha256").update(token, "utf8").digest("hex");
  return { token, commitment };
}

// ---------------- Agent API client ----------------
class AgentApiError extends Error {
  constructor(status, body, idem) {
    const e = (body && body.errors && body.errors[0]) || {};
    super(e.detail || e.title || `Agent API error ${status}`);
    this.status = status;
    this.code = e.code || (status ? `http_${status}` : "network_error");
    this.layer = e.layer || null;
    this.retryable = !!(e.meta && e.meta.retryable);
    this.meta = e.meta || {};
    this.idem = idem || null;
  }
}
async function api(method, path, { body, grant, idem, query, timeoutMs } = {}) {
  const key = apiKey();
  if (!key) throw new AgentApiError(0, { errors: [{ code: "no_api_key", detail: "NEAR_INTENTS_AGENT_API_KEY is not set on this server." }] });
  const url = new URL(BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const headers = { "X-API-Key": key, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (grant) headers["X-Grant-Token"] = grant;
  if (idem) headers["Idempotency-Key"] = idem;
  let res;
  try {
    res = await fetch(url, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error",
      signal: AbortSignal.timeout(timeoutMs || (method === "GET" ? 65000 : 150000)),
    });
  } catch (e) {
    const err = new AgentApiError(0, { errors: [{ code: "network_error", detail: e.message }] }, idem);
    err.retryable = true; // a lost response: replay the SAME key, never a new one
    throw err;
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const err = new AgentApiError(res.status, json, idem);
    if (res.status >= 500) err.retryable = true;
    throw err;
  }
  return json;
}

// Tiny read cache so the admin page stays fast.
const cache = new Map();
async function cached(key, ms, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}
const bust = () => cache.clear();

async function nearPrice() {
  return cached("price", 60000, async () => {
    const r = await fetch(BASE + "/v1/tokens", { signal: AbortSignal.timeout(20000) }).then((x) => x.json());
    const list = Array.isArray(r) ? r : (r.data || r.tokens || []);
    const t = list.find((x) => x.asset_id === WNEAR);
    const p = t && Number(t.price);
    if (!p || !Number.isFinite(p) || p <= 0) throw new Error("price_unavailable");
    return p;
  });
}

// ---------------- helpers ----------------
async function getState() {
  let s = await State.findOne({ key: "main" });
  if (!s) s = await State.create({ key: "main" });
  return s;
}
// The grant is unreadable if the secret it was encrypted with changed (e.g. a
// new MONGODB_URI password): then step 2 ("Allow the game") must be signed again.
function grantReadable(s) {
  if (!s || !s.grantEnc) return false;
  try { decrypt(s.grantEnc); return true; } catch { return false; }
}
const ready = (s) => !!(s && s.agentId && grantReadable(s) && s.mode === "payout");
const splitOf = (s) => (Array.isArray(s.split) && s.split.length === 3 ? s.split : DEFAULT_SPLIT);
const nearToRaw = (near) => (BigInt(Math.round(near * 1e6)) * 10n ** 18n).toString(); // 6 decimals is plenty
const rawToNear = (raw) => Number(BigInt(raw || "0") / 10n ** 18n) / 1e6;
const round4 = (n) => Math.round(n * 1e4) / 1e4;
function walletOf(p) {
  return (p && (D.cleanPayoutWallet(p.payoutWallet) || D.cleanPayoutWallet(p.verifiedWalletAddress))) || null;
}
function txOf(st) {
  const d = (st && st.details) || {};
  return d.destination_tx_hash || d.tx_hash || null;
}
function istParts(d) {
  const x = new Date(d.getTime() + 5.5 * 3600 * 1000);
  return { m: x.toLocaleString("en-US", { month: "short", timeZone: "UTC" }), d: x.getUTCDate() };
}
function weekLabel(start, end) {
  const a = istParts(start), b = istParts(new Date(end.getTime() - 1));
  return a.m === b.m ? `${a.m} ${a.d}–${b.d}` : `${a.m} ${a.d}–${b.m} ${b.d}`;
}
function errText(e) {
  const map = {
    insufficient_balance: "The agent wallet doesn't have enough NEAR. Add funds.",
    spend_budget_exceeded: "Over the agent's weekly $ cap. Raise it with 'Change rules (sign)'.",
    policy_limit_exceeded: "Over the agent's per-payment cap. Raise it with 'Change rules (sign)'.",
    policy_transaction_limit_exceeded: "Over the agent's per-payment cap. Raise it with 'Change rules (sign)'.",
    policy_destination_denied: "The agent's rules don't allow this wallet (it's in withdraw-to-owner mode).",
    policy_action_denied: "The agent's rules don't allow withdrawals.",
    wallet_frozen: "The agent is frozen. Unfreeze it first.",
    invalid_address: "That wallet doesn't exist on NEAR mainnet.",
    policy_not_ready: "The agent's rules are still being applied. It will retry.",
    custody_native_balance_required: "The agent's own NEAR account needs a little NEAR for gas.",
  };
  return map[e && e.code] || (e && e.message) || "Unknown error";
}

// ---------------- leaders ----------------
// Accounts that can never win the weekly prize: the game's own founder /
// test accounts. Set WEEKLY_EXCLUDE="name1,name2" to change (usernames).
const EXCLUDED = new Set(String(process.env.WEEKLY_EXCLUDE ?? "om7eth").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));
function isExcluded(p) {
  return EXCLUDED.has(String(p.username || "").toLowerCase()) || EXCLUDED.has(String(p.name || "").toLowerCase());
}
async function leaders(start, end, n = 3) {
  const match = { earnedAt: { $gte: start } };
  if (end) match.earnedAt.$lt = end;
  const rows = await D.MatchRecord.aggregate([
    { $match: match },
    { $group: { _id: "$playerId", points: { $sum: "$points" }, lastAt: { $max: "$earnedAt" } } },
    { $match: { points: { $gt: 0 } } },
    { $sort: { points: -1, lastAt: 1 } }, // tie: whoever got there first
    { $limit: n + 15 },
  ]);
  const people = await D.Player.find({ _id: { $in: rows.map((r) => r._id) } }, "name username payoutWallet verifiedWalletAddress accountHeld").lean();
  const byId = new Map(people.map((p) => [String(p._id), p]));
  const out = [];
  for (const r of rows) {
    const p = byId.get(String(r._id));
    if (!p || p.accountHeld) continue; // deleted or held/banned accounts can't win
    if (isExcluded(p)) continue; // the game's own (founder / test) accounts never win the prize
    out.push({ playerId: p._id, name: p.name, username: p.username, points: r.points, wallet: walletOf(p) });
    if (out.length >= n) break;
  }
  return out;
}
// The weekly window the Ranks page shows (honours an admin leaderboard reset).
async function weekWindow(weekStartNatural) {
  const end = new Date(weekStartNatural.getTime() + WEEK_MS);
  const resetAt = await D.leaderboardResetAt().catch(() => null);
  const start = resetAt && resetAt > weekStartNatural && resetAt < end ? resetAt : weekStartNatural;
  return { start, end };
}
function prizesFor(prizeUsd, split) {
  return split.map((pct) => Math.round(prizeUsd * pct) / 100);
}

// ---------------- owner intents ----------------
function buildPolicy(mode, prizeUsd, price) {
  if (mode === "withdraw_to_owner") {
    return {
      frozen: false, actions: ["withdraw"], confidential: true, owner_approval: false,
      assets: [WNEAR], limits: {}, max_actions_per_hour: null,
      destinations: { mode: "only", list: [{ action: "withdraw", chain: "near", address: OWNER, memo: null }] },
      budget: { daily_usd: null, weekly_usd: null, monthly_usd: null }, timelock_ms: 0,
    };
  }
  const weeklyCap = Math.max(15, Math.ceil(prizeUsd * 1.5));
  const perTxNear = Math.max(3, Math.ceil((prizeUsd * 0.5 * 2) / price)); // 2x the 1st prize, for price moves
  return {
    frozen: false, actions: ["withdraw"], confidential: true, owner_approval: false,
    assets: [WNEAR], limits: { per_transaction: { [WNEAR]: nearToRaw(perTxNear) } }, max_actions_per_hour: 12,
    destinations: { mode: "any", list: [] },
    budget: { daily_usd: null, weekly_usd: String(weeklyCap), monthly_usd: null }, timelock_ms: 0,
  };
}

async function ownerPublicKey(given) {
  if (given && /^ed25519:/.test(given)) return given;
  const r = await fetch("https://rpc.mainnet.fastnear.com", {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_access_key_list", finality: "final", account_id: OWNER } }),
  }).then((x) => x.json());
  const full = ((r.result && r.result.keys) || []).filter((k) => k.access_key && k.access_key.permission === "FullAccess");
  if (full.length !== 1) throw new Error("Couldn't tell which key saboteur.near signs with. Connect the wallet again.");
  return full[0].public_key;
}

// kind: create | grant | rules | withdraw_mode | freeze | unfreeze
async function generateOwnerIntent(kind, { publicKey, termsAccepted, adminName } = {}) {
  const s = await getState();
  const price = await nearPrice();
  let body;
  const extra = {};
  if (kind === "create") {
    if (s.agentId) throw new Error("The agent already exists.");
    if (!termsAccepted) throw new Error("Accept the terms first.");
    s.termsAcceptedAt = new Date();
    s.termsAcceptedBy = adminName || "admin";
    body = {
      type: "agent_create", name: AGENT_NAME, external_user_id: "near-saboteur-weekly",
      owner: { type: "near", account_id: OWNER, public_key: await ownerPublicKey(publicKey) },
      policy: buildPolicy("payout", s.prizeUsd, price),
    };
  } else {
    if (!s.agentId) throw new Error("Create the agent first.");
    if (kind === "grant") {
      const { token, commitment } = newGrantCredential();
      const exp = new Date(Date.now() + 364 * 24 * 3600 * 1000);
      extra.grantEnc = encrypt(token);
      extra.grantExpiresAt = exp;
      body = { type: "grant_issue", agent_id: s.agentId, label: "NEAR Saboteur game server", credential: commitment, expires_at: exp.toISOString() };
    } else if (kind === "rules" || kind === "withdraw_mode") {
      const pol = await api("GET", `/v1/agents/${s.agentId}/policy`);
      if (pol.revision === null || pol.revision === undefined) throw new Error("The agent's rules aren't ready yet. Try again in a minute.");
      body = { type: "policy_update", agent_id: s.agentId, expected_revision: pol.revision, policy: buildPolicy(kind === "rules" ? "payout" : "withdraw_to_owner", s.prizeUsd, price) };
    } else if (kind === "freeze" || kind === "unfreeze") {
      body = { type: kind === "freeze" ? "agent_freeze" : "agent_unfreeze", agent_id: s.agentId };
    } else throw new Error("Unknown action.");
  }
  const g = await api("POST", "/v1/generate-intent", { body, idem: crypto.randomUUID() });
  s.pending = {
    correlationId: g.correlation_id, kind, createdAt: new Date(), expiresAt: g.expires_at ? new Date(g.expires_at) : null,
    agentId: kind === "create" ? g.agent_id : s.agentId, grantEnc: extra.grantEnc || null, grantExpiresAt: extra.grantExpiresAt || null,
    status: "PENDING_SIGNATURE", error: null,
  };
  s.markModified("pending");
  await s.save();
  return {
    correlationId: g.correlation_id, kind, signer: g.signer, intent: g.intent,
    summary: (g.preview && g.preview.summary) || "", policy: (g.preview && g.preview.policy) || null, expiresAt: g.expires_at,
  };
}

async function finishOwnerIntent(s, st) {
  const p = s.pending;
  p.status = st.status;
  if (st.status === "SUCCESS") {
    if (p.kind === "create") { s.agentId = p.agentId; s.mode = "payout"; s.grantEnc = null; }
    if (p.kind === "grant") { s.grantEnc = p.grantEnc; s.grantExpiresAt = p.grantExpiresAt; }
    if (p.kind === "rules") s.mode = "payout";
    if (p.kind === "withdraw_mode") s.mode = "withdraw_to_owner";
    D.logAdminAction("weekly-agent-owner-action", { kind: p.kind, correlationId: p.correlationId });
  } else if (TERMINAL.has(st.status)) {
    p.error = st.failure_code || st.status;
  }
  if (TERMINAL.has(st.status)) p.grantEnc = null; // the live copy (if any) is in s.grantEnc now
  s.markModified("pending");
  await s.save();
  bust();
}

async function submitOwnerIntent(correlationId, signedData) {
  const s = await getState();
  if (!s.pending || s.pending.correlationId !== correlationId) throw new Error("This signing request is old. Start again.");
  if (!signedData || typeof signedData !== "object" || !signedData.standard) throw new Error("Missing signature.");
  await api("POST", "/v1/submit-intent", { body: { type: typeKindMap[s.pending.kind], correlation_id: correlationId, signed_data: signedData } });
  s.pending.submittedAt = new Date();
  s.pending.status = "PROCESSING";
  s.markModified("pending");
  await s.save();
  let st = null;
  for (let i = 0; i < 3; i++) {
    st = await api("GET", "/v1/status", { query: { correlation_id: correlationId, wait_ms: 25000 } }).catch(() => null);
    if (st && TERMINAL.has(st.status)) break;
  }
  if (st) await finishOwnerIntent(s, st);
  return { status: st ? st.status : "PROCESSING", failure: st && st.failure_code };
}
const typeKindMap = { create: "agent_create", grant: "grant_issue", rules: "policy_update", withdraw_mode: "policy_update", freeze: "agent_freeze", unfreeze: "agent_unfreeze" };

// ---------------- funding ----------------
async function depositAddress() {
  const s = await getState();
  if (!s.agentId) throw new Error("Create the agent first.");
  if (s.deposit && s.deposit.address && s.deposit.expiresAt && s.deposit.expiresAt.getTime() > Date.now() + 3600 * 1000) return s.deposit;
  const r = await api("POST", `/v1/agents/${s.agentId}/deposit`, { body: { origin_asset: WNEAR, confidential: false }, idem: crypto.randomUUID() });
  const d = r.details || {};
  if (!d.deposit_address) throw new Error("No deposit address came back. Try again.");
  s.deposit = { address: d.deposit_address, memo: d.memo || null, minAmount: d.min_amount || null, expiresAt: d.expires_at ? new Date(d.expires_at) : null, correlationId: r.correlation_id };
  s.markModified("deposit");
  await s.save();
  return s.deposit;
}

// The Intents API now keeps an agent's funds in two places: the new
// confidential balance (default) and the legacy public balance, where our
// agent's wNEAR sits. An agent whose stored policy has confidential off can
// only pay from the public one (withdraw with confidential:false), so read
// both and pay from whichever holds enough.
async function wnearBalances(agentId) {
  const one = (src) => api("GET", `/v1/agents/${agentId}/balances${src === "public" ? "?source=public" : ""}`)
    .then((b) => (b.balances || []).find((x) => x.asset_id === WNEAR) || null).catch(() => null);
  const [pub, conf] = await Promise.all([one("public"), one("confidential")]);
  return { pub, conf };
}
const rawOf = (b) => BigInt((b && b.available_raw) || "0");
async function sourceFor(agentId, amountRaw) {
  const { pub, conf } = await wnearBalances(agentId);
  const need = BigInt(amountRaw);
  if (rawOf(pub) >= need) return { confidential: false };
  if (rawOf(conf) >= need) return {};
  return { confidential: rawOf(pub) >= rawOf(conf) ? false : undefined };
}

// Withdraw everything to saboteur.near (needs the withdraw-to-owner rules).
async function withdrawAllToOwner() {
  const s = await getState();
  if (!s.agentId || !grantReadable(s)) throw new Error("The game's permission is missing. Sign 'Allow the game' again.");
  if (s.mode !== "withdraw_to_owner") throw new Error("Sign 'Withdraw to saboteur.near' first.");
  const ow = s.ownerWithdraw || {};
  if (ow.idem && ow.status && !TERMINAL.has(ow.status)) return ow; // one already in flight: never start a second
  const { pub, conf } = await wnearBalances(s.agentId);
  const usePub = rawOf(pub) >= rawOf(conf);
  const raw = usePub ? pub && pub.available_raw : conf && conf.available_raw;
  if (!raw || BigInt(raw) <= 0n) throw new Error("Nothing to withdraw.");
  s.ownerWithdraw = { idem: crypto.randomUUID(), amountRaw: raw, status: "SENDING", at: new Date(), publicSource: usePub };
  s.markModified("ownerWithdraw");
  await s.save(); // key saved BEFORE sending
  await sendOwnerWithdraw(s);
  return s.ownerWithdraw;
}
async function sendOwnerWithdraw(s) {
  const ow = s.ownerWithdraw;
  try {
    const r = await api("POST", `/v1/agents/${s.agentId}/withdraw`, {
      grant: decrypt(s.grantEnc), idem: ow.idem,
      body: { asset: WNEAR, amount: ow.amountRaw, chain: "near", recipient: OWNER, ...(ow.publicSource ? { confidential: false } : {}) },
    });
    ow.correlationId = r.correlation_id;
    ow.status = r.status || "PROCESSING";
  } catch (e) {
    if (!e.retryable) { ow.status = "FAILED"; ow.error = errText(e); }
  }
  s.markModified("ownerWithdraw");
  await s.save();
  bust();
}

// ---------------- weekly batches ----------------
async function createBatchIfDue(s) {
  const curStart = D.getCurrentWeekStartUTC();
  const prevNatural = new Date(curStart.getTime() - WEEK_MS);
  const { start, end } = await weekWindow(prevNatural);
  if (Date.now() - end.getTime() > LATE_WINDOW_MS) return;
  if (!s.enabledAt || s.enabledAt.getTime() > end.getTime()) return; // only weeks that ended while ON
  if (s.stopAfterWeekEnd && end.getTime() > s.stopAfterWeekEnd.getTime()) return;
  if (await Batch.exists({ weekStart: prevNatural })) return;

  const top = await leaders(start, end, 3);
  const price = await nearPrice();
  const split = splitOf(s);
  const usd = prizesFor(s.prizeUsd, split);
  const winners = top.map((w, i) => {
    const near = round4(usd[i] / price);
    return {
      rank: i + 1, playerId: w.playerId, name: w.name, username: w.username, points: w.points, wallet: w.wallet,
      usd: usd[i], amountNear: near, amountRaw: nearToRaw(near),
      status: w.wallet ? "queued" : "held", heldUntil: w.wallet ? null : new Date(Date.now() + HOLD_MS),
    };
  });
  let batch;
  try {
    batch = await Batch.create({
      weekStart: prevNatural, weekEnd: end, label: weekLabel(start, end), status: winners.some((w) => w.status === "queued") ? "countdown" : "done",
      sendAt: new Date(Date.now() + COUNTDOWN_MS), prizeUsd: s.prizeUsd, nearPrice: price, winners,
    });
  } catch (e) {
    if (e && e.code === 11000) return; // another tick made it first
    throw e;
  }
  if (s.stopAfterWeekEnd && end.getTime() >= s.stopAfterWeekEnd.getTime()) {
    await State.updateOne({ key: "main" }, { $set: { enabled: false, stopAfterWeekEnd: null } });
  }
  for (const w of batch.winners) {
    const who = w.wallet;
    if (who) {
      D.sendInboxMessage(w.playerId, {
        title: "🏆 You won this week's prize!",
        body: `You finished #${w.rank} on the weekly Ranks. ${w.amountNear} NEAR will be sent to ${who} by the Saboteur Agent in 30 minutes (all three winners are paid together).`,
      });
    } else {
      D.sendInboxMessage(w.playerId, {
        title: `🏆 You won $${fmtUsd(w.usd)} in NEAR — link a wallet to get it`,
        body: `You finished #${w.rank} on the weekly Ranks. Add a mainnet NEAR wallet (Ranks → Prize wallet) within 30 days and we'll send ${w.amountNear} NEAR automatically.`,
      });
    }
  }
  console.log(`[WEEKLY AGENT] queued ${batch.label}: ${batch.winners.map((w) => `#${w.rank} ${w.name} ${w.amountNear}N ${w.status}`).join(", ")}`);
}
const fmtUsd = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

async function sendWinner(s, batch, w) {
  // Re-read the wallet: a winner may have added/changed it during the countdown.
  const p = await D.Player.findById(w.playerId, "payoutWallet verifiedWalletAddress").lean();
  const wallet = walletOf(p) || w.wallet;
  if (!wallet) { w.status = "held"; w.heldUntil = w.heldUntil || new Date(Date.now() + HOLD_MS); return; }
  w.wallet = wallet;
  if (!w.idem) {
    w.idem = crypto.randomUUID();
    w.status = "sending";
    await batch.save(); // key saved BEFORE sending
  }
  try {
    if (w.publicSource == null) {
      const src = await sourceFor(s.agentId, w.amountRaw);
      w.publicSource = src.confidential === false;
      await batch.save(); // same key must replay the same request
    }
    const r = await api("POST", `/v1/agents/${s.agentId}/withdraw`, {
      grant: decrypt(s.grantEnc), idem: w.idem,
      body: { asset: WNEAR, amount: w.amountRaw, chain: "near", recipient: wallet, ...(w.publicSource ? { confidential: false } : {}) },
    });
    w.correlationId = r.correlation_id;
    w.status = "sending";
    w.error = null;
  } catch (e) {
    if (e.retryable || e.code === "policy_not_ready") {
      w.error = errText(e); // same key next tick
    } else {
      w.status = "failed";
      w.error = errText(e);
      w.idem = null; // proven refusal: nothing was sent, a retry needs a new key
      w.publicSource = null;
    }
  }
}

async function pollWinner(batch, w) {
  const st = await api("GET", "/v1/status", { query: { correlation_id: w.correlationId, wait_ms: 1000 } }).catch(() => null);
  if (!st) return;
  if (st.status === "SUCCESS") {
    w.status = "paid";
    w.paidAt = new Date();
    w.txHash = txOf(st);
    w.error = null;
    D.sendInboxMessage(w.playerId, {
      title: `Your prize arrived · ${w.amountNear} NEAR`,
      body: `The Saboteur Agent sent ${w.amountNear} NEAR to ${w.wallet} for finishing #${w.rank} on the weekly Ranks (${batch.label}).${w.txHash ? ` Transaction: https://nearblocks.io/txns/${w.txHash}` : ""}`,
    });
  } else if (st.status === "FAILED" || st.status === "REFUNDED") {
    const d = st.details || {};
    w.status = "failed";
    w.error = st.failure_code || st.status;
    if (d.never_executed || d.never_submitted) w.idem = null; // safe to retry with a new key
  } else if (st.status === "NEEDS_REVIEW") {
    w.status = "failed";
    w.error = "Needs review at NEAR Intents: " + (st.failure_code || "");
  }
}

async function announceIfDone(batch) {
  if (batch.announced) return;
  const open = batch.winners.some((w) => w.status === "queued" || w.status === "sending");
  const paid = batch.winners.filter((w) => w.status === "paid");
  if (open || !paid.length) return;
  const medals = ["🥇", "🥈", "🥉"];
  const line = batch.winners
    .map((w) => `${medals[w.rank - 1] || "#" + w.rank} ${w.username || w.name} · ${w.amountNear} NEAR${w.status === "paid" ? "" : w.status === "held" ? " (waiting for a wallet)" : ""}`)
    .join("   ");
  await D.Announcement.create({
    title: `Weekly prizes paid · ${batch.label}`,
    body: `${line}\nPaid automatically by the Saboteur Agent on NEAR Intents.${paid[0].txHash ? ` See proofs: https://nearblocks.io/txns/${paid[0].txHash}` : ""}`,
    nameTag: "NEAR Saboteur",
  }).catch((e) => console.error("[WEEKLY AGENT] announcement failed:", e.message));
  // [TELEGRAM] same news in the official group's Announcements topic
  if (D.tgAnnounce) D.tgAnnounce({ kind: "paid", photo: "weekly", winners: batch.winners.map((w) => ({ rank: w.rank, name: w.username || w.name, amountNear: w.amountNear, status: w.status })), label: batch.label, txHash: paid[0].txHash || null }).catch(() => {});
  batch.announced = true;
}

let ticking = false;
async function tick() {
  if (ticking || !D || mongoose.connection.readyState !== 1) return;
  ticking = true;
  try {
    const s = await getState();
    // finish an owner action whose status we didn't see yet
    if (s.pending && s.pending.submittedAt && s.pending.status && !TERMINAL.has(s.pending.status)) {
      const st = await api("GET", "/v1/status", { query: { correlation_id: s.pending.correlationId, wait_ms: 1000 } }).catch(() => null);
      if (st && TERMINAL.has(st.status)) await finishOwnerIntent(s, st);
    }
    // owner withdraw in flight
    const ow = s.ownerWithdraw;
    if (ow && ow.idem && !TERMINAL.has(ow.status || "")) {
      if (!ow.correlationId) await sendOwnerWithdraw(s);
      else {
        const st = await api("GET", "/v1/status", { query: { correlation_id: ow.correlationId, wait_ms: 1000 } }).catch(() => null);
        if (st && TERMINAL.has(st.status)) { ow.status = st.status; ow.txHash = txOf(st); ow.error = st.failure_code || null; s.markModified("ownerWithdraw"); await s.save(); bust(); }
      }
    }
    if (!ready(s)) return;
    if (s.enabled) await createBatchIfDue(s);

    const live = await Batch.find({ $or: [{ status: { $in: ["countdown", "sending"] } }, { "winners.status": { $in: ["held", "sending"] } }] }).sort({ weekStart: 1 }).limit(10);
    for (const batch of live) {
      if (batch.status === "cancelled") continue;
      if (batch.status === "countdown" && batch.sendAt.getTime() <= Date.now()) {
        const claimed = await Batch.updateOne({ _id: batch._id, status: "countdown" }, { $set: { status: "sending", sentAt: new Date() } });
        if (!claimed.modifiedCount) continue;
        batch.status = "sending";
        batch.sentAt = new Date();
      }
      if (batch.status === "countdown") continue;
      for (const w of batch.winners) {
        if (w.status === "queued") await sendWinner(s, batch, w);
        else if (w.status === "sending" && !w.correlationId) await sendWinner(s, batch, w); // lost response: replay same key
        else if (w.status === "sending") await pollWinner(batch, w);
        else if (w.status === "held") {
          if (w.heldUntil && w.heldUntil.getTime() < Date.now()) { w.status = "expired"; continue; }
          const p = await D.Player.findById(w.playerId, "payoutWallet verifiedWalletAddress").lean();
          if (walletOf(p)) { w.status = "queued"; await sendWinner(s, batch, w); }
        }
      }
      if (batch.status === "sending" && !batch.winners.some((w) => w.status === "queued" || w.status === "sending")) batch.status = "done";
      await announceIfDone(batch);
      batch.markModified("winners");
      await batch.save();
    }
  } catch (e) {
    console.error("[WEEKLY AGENT] tick error:", e.message);
  } finally {
    ticking = false;
  }
}

// ---------------- admin + public views ----------------
async function adminView() {
  const s = await getState();
  const price = await nearPrice().catch(() => null);
  const curStart = D.getCurrentWeekStartUTC();
  const { start, end } = await weekWindow(curStart);
  const split = splitOf(s);
  const usd = prizesFor(s.prizeUsd, split);
  const now = await leaders(start, end, 3);
  let agent = null, policy = null, balance = null, agentError = null;
  if (s.agentId) {
    try {
      [agent, policy, balance] = await cached("agent:" + s.agentId, 20000, () => Promise.all([
        api("GET", `/v1/agents/${s.agentId}`),
        api("GET", `/v1/agents/${s.agentId}/policy`).catch(() => null),
        wnearBalances(s.agentId).then(({ pub, conf }) => (rawOf(pub) >= rawOf(conf) ? pub : conf)),
      ]));
    } catch (e) { agentError = errText(e); }
    const nearId = agent && agent.wallet && agent.wallet.near_account_id;
    if (nearId && s.walletNearId !== nearId) { s.walletNearId = nearId; await s.save(); }
  }
  const batches = await Batch.find().sort({ weekStart: -1 }).limit(12).lean();
  const current = batches.find((b) => b.status === "countdown" || b.status === "sending") || null;
  const balNear = balance ? Number(balance.available || 0) || rawToNear(balance.available_raw) : null;
  const pol = policy && policy.policy;
  const capUsd = pol && pol.budget && pol.budget.weekly_usd ? Number(pol.budget.weekly_usd) : null;
  const perTxNear = pol && pol.limits && pol.limits.per_transaction && pol.limits.per_transaction[WNEAR] ? rawToNear(pol.limits.per_transaction[WNEAR]) : null;
  return {
    apiKeySet: !!apiKey(), owner: OWNER, ownerTermsUrl: OWNER_TERMS_URL, outlayerTermsUrl: OUTLAYER_TERMS_URL, riskNotice: RISK_NOTICE,
    enabled: s.enabled, stopAfterWeekEnd: s.stopAfterWeekEnd, prizeUsd: s.prizeUsd, split, prizesUsd: usd, nearPrice: price,
    agentId: s.agentId, hasGrant: grantReadable(s), grantUnreadable: !!s.grantEnc && !grantReadable(s), grantExpiresAt: s.grantExpiresAt, mode: s.mode, ready: ready(s),
    agent: agent && { status: agent.status, nearAccountId: agent.wallet && agent.wallet.near_account_id, cooldowns: agent.cooldowns },
    agentError,
    policy: pol && { frozen: !!pol.frozen, actions: pol.actions, capUsd, perTxNear, destinations: pol.destinations && pol.destinations.mode, status: policy.status, synced: policy.provider_policy_synced, revision: policy.revision, weekly: policy.usage && policy.usage.budget && policy.usage.budget.weekly },
    balanceNear: balNear,
    needsRulesUpdate: !!(pol && price && (capUsd !== null && capUsd < s.prizeUsd || perTxNear !== null && perTxNear < (usd[0] / price) * 1.1)),
    pending: s.pending && s.pending.correlationId ? { kind: s.pending.kind, status: s.pending.status, error: s.pending.error, createdAt: s.pending.createdAt } : null,
    deposit: s.deposit && s.deposit.address ? s.deposit : null,
    ownerWithdraw: s.ownerWithdraw && s.ownerWithdraw.idem ? { status: s.ownerWithdraw.status, amountNear: rawToNear(s.ownerWithdraw.amountRaw), txHash: s.ownerWithdraw.txHash, error: s.ownerWithdraw.error, at: s.ownerWithdraw.at } : null,
    nextResetAt: end, weekStart: start,
    leadersNow: now.map((w, i) => ({ rank: i + 1, name: w.name, username: w.username, points: w.points, wallet: w.wallet, usd: usd[i], near: price ? round4(usd[i] / price) : null })),
    current: current && batchView(current, true),
    history: batches.map((b) => batchView(b, true)),
  };
}
function batchView(b, admin) {
  return {
    id: String(b._id), label: b.label, status: b.status, sendAt: b.sendAt, weekStart: b.weekStart,
    winners: (b.winners || []).map((w) => ({
      rank: w.rank, name: w.name, username: w.username, points: w.points, usd: w.usd, amountNear: w.amountNear, status: w.status,
      txHash: w.txHash || null, hasWallet: !!w.wallet, heldUntil: w.heldUntil || null,
      ...(admin ? { wallet: w.wallet || null, error: w.error || null, correlationId: w.correlationId || null } : {}),
    })),
  };
}

async function publicView(me) {
  const s = await getState();
  const active = !!(s.enabled && !s.stopAfterWeekEnd && ready(s));
  const curStart = D.getCurrentWeekStartUTC();
  const { start, end } = await weekWindow(curStart);
  const split = splitOf(s);
  const usd = prizesFor(s.prizeUsd, split);
  const recent = await Batch.find({ status: { $ne: "cancelled" } }).sort({ weekStart: -1 }).limit(2).lean();
  let top = [];
  if (active) top = (await leaders(start, end, 3)).map((w, i) => ({ rank: i + 1, name: w.name, username: w.username, hasWallet: !!w.wallet }));
  const myWallet = me ? walletOf(me) : null;
  return {
    active, prizeUsd: s.prizeUsd, split, prizesUsd: usd, nearPrice: await nearPrice().catch(() => null), resetAt: end,
    top, myWallet, myWalletSaved: me ? D.cleanPayoutWallet(me.payoutWallet) : null,
    lastWeek: recent[0] ? batchView(recent[0], false) : null,
    weekBefore: recent[1] ? batchView(recent[1], false) : null,
    agentAccount: s.walletNearId || null,
    staff: [...EXCLUDED], // shown with a DEV tag on Ranks; never win the prize
  };
}

// ---------------- admin actions ----------------
async function announceOn(s) {
  const usd = prizesFor(s.prizeUsd, splitOf(s));
  const price = await nearPrice().catch(() => null);
  const n = (u) => (price ? ` (≈ ${(u / price).toFixed(2)} NEAR)` : "");
  const reset = new Date(D.getCurrentWeekStartUTC().getTime() + WEEK_MS);
  const when = reset.toLocaleString("en-US", { weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
  await D.Announcement.create({
    title: `Weekly prizes are ON · $${fmtUsd(s.prizeUsd)} in NEAR every week`,
    body: `The top 3 on the weekly Ranks win real NEAR: 🥇 #1 $${fmtUsd(usd[0])}${n(usd[0])} · 🥈 #2 $${fmtUsd(usd[1])}${n(usd[1])} · 🥉 #3 $${fmtUsd(usd[2])}${n(usd[2])}.\nThis week's winners are decided at the weekly reset (${when} IST) and paid automatically 30 minutes later by the Saboteur Agent on NEAR Intents.\nAdd your mainnet NEAR wallet on Ranks so your prize can reach you. Optional and may change or stop at any time.`,
    nameTag: "NEAR Saboteur",
  });
  if (D.tgAnnounce) D.tgAnnounce({ kind: "on", photo: "weekly", prizeUsd: s.prizeUsd, usd, price, when }).catch(() => {});
  s.onAnnouncedAt = new Date();
}
async function saveSettings({ enabled, prizeUsd, offMode }) {
  const s = await getState();
  if (prizeUsd !== undefined) {
    const v = Math.round(Number(prizeUsd) * 100) / 100;
    if (!Number.isFinite(v) || v < 1 || v > 10000) throw new Error("Prize must be between $1 and $10,000.");
    s.prizeUsd = v;
  }
  if (enabled === true) {
    if (!s.enabled || s.stopAfterWeekEnd) {
      const wasFullyOff = !s.enabled;
      s.enabled = true;
      s.stopAfterWeekEnd = null;
      if (!s.enabledAt) s.enabledAt = new Date();
      // Switching ON tells every player in News (at most once per 12h, so
      // flipping the switch back and forth never spams the News tab).
      if (wasFullyOff && ready(s) && !(s.onAnnouncedAt && Date.now() - s.onAnnouncedAt.getTime() < 12 * 3600 * 1000)) {
        await announceOn(s).catch((e) => console.error("[WEEKLY AGENT] ON announcement failed:", e.message));
      }
    }
  } else if (enabled === false) {
    const wasOn = s.enabled && !s.stopAfterWeekEnd;
    if (wasOn && D.tgAnnounce) D.tgAnnounce({ kind: offMode === "after_this_week" ? "off_after_week" : "off" }).catch(() => {});
    if (offMode === "after_this_week") {
      s.stopAfterWeekEnd = new Date(D.getCurrentWeekStartUTC().getTime() + WEEK_MS);
    } else {
      s.enabled = false;
      s.stopAfterWeekEnd = null;
      s.enabledAt = null;
      // "Stop now" also stops a countdown that hasn't sent yet.
      const b = await Batch.findOne({ status: "countdown" });
      if (b) await cancelBatch(String(b._id));
    }
  }
  await s.save();
  return s;
}
async function cancelBatch(id) {
  const b = await Batch.findOneAndUpdate({ _id: id, status: "countdown" }, { $set: { status: "cancelled", cancelledAt: new Date() } }, { new: true });
  if (!b) throw new Error("Too late: this week is already being sent.");
  for (const w of b.winners) {
    if (w.status === "queued" || w.status === "held") w.status = "cancelled";
    D.sendInboxMessage(w.playerId, {
      title: "This week's prize was cancelled",
      body: `The weekly prize for ${b.label} was cancelled, so no prizes are sent this week. Sorry! Keep playing for next week's.`,
    });
  }
  b.markModified("winners");
  await b.save();
  return b;
}
async function sendNow(id) {
  const r = await Batch.updateOne({ _id: id, status: "countdown" }, { $set: { sendAt: new Date() } });
  if (!r.modifiedCount) throw new Error("This batch isn't waiting anymore.");
  setImmediate(tick);
}
async function retryWinner(id, rank) {
  const b = await Batch.findById(id);
  if (!b) throw new Error("Batch not found.");
  const w = b.winners.find((x) => x.rank === Number(rank));
  if (!w || w.status !== "failed") throw new Error("Only a failed payment can be retried.");
  if (w.idem) throw new Error("This payment may still go through. Check its status first.");
  w.status = "queued";
  w.error = null;
  if (b.status === "done") b.status = "sending";
  b.markModified("winners");
  await b.save();
  setImmediate(tick);
}

function init(deps) {
  D = deps;
  setInterval(tick, 30 * 1000);
  setTimeout(tick, 15 * 1000);
}

module.exports = {
  init, tick, adminView, publicView, saveSettings, cancelBatch, sendNow, retryWinner,
  generateOwnerIntent, submitOwnerIntent, depositAddress, withdrawAllToOwner,
  _internals: { buildPolicy, weekLabel, nearToRaw, rawToNear, newGrantCredential, encrypt, decrypt },
};
