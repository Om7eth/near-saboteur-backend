// ============================================================
// $SABOTEUR on NEAR testnet - the only file that talks to the chain.
//
// Accounts (all sub-accounts of SABOTEUR_PARENT_ACCOUNT_ID, all controlled
// by the one server key, so players never sign anything):
//   token.<parent>         NEP-141 contract (scripts/setup-saboteur-token.mjs)
//   treasury.<parent>      holds the supply - COLD key, offline, the server can't touch it
//   rewards.<parent>       small hot wallet the server pays every reward from
//   bots.<parent>          Bot Treasury - bot earnings above the per-bot cap (cold key)
//   bot-<name>.<parent>    one per AI bot persona
//   p-<accountId>.<parent> made automatically the first time a player earns
//
// Everything goes through ONE queue: several rooms can finish at the same
// time and the server key's nonce never collides. Payouts never block the
// game - if the chain is slow or the treasury is empty, the game carries
// on and the ledger keeps the row as "failed" to retry later.
// ============================================================

const PARENT = process.env.SABOTEUR_PARENT_ACCOUNT_ID || "";
const KEY = process.env.SABOTEUR_PARENT_PRIVATE_KEY || "";
const RPC_URL = process.env.SABOTEUR_RPC_URL || "https://test.rpc.fastnear.com";
const DECIMALS = 18n;
// [$SABOTEUR v2] The game now uses the v2 contract (token-v2/), where the
// reward / burn rules live in the contract. v1 (token.<parent>) is retired;
// every v1 balance was copied into v2 once (scripts/deploy-saboteur-v2.mjs).
const TOKEN = process.env.SABOTEUR_TOKEN_ID || (PARENT ? `sabo.${PARENT}` : "");
const V2 = /^sabo\./.test(TOKEN);
const TREASURY = PARENT ? `treasury.${PARENT}` : "";
const REWARDS = PARENT ? `rewards.${PARENT}` : "";
const BOT_TREASURY = PARENT ? `bots.${PARENT}` : "";
const EXPLORER = "https://testnet.nearblocks.io";

let nearPromise = null;
const loadNear = () => (nearPromise ||= import("near-api-js"));
let ctx = null; // { near, provider, parent, treasury, publicKey }
async function chain() {
  if (ctx) return ctx;
  const near = await loadNear();
  const provider = new near.JsonRpcProvider({ url: RPC_URL });
  ctx = {
    near, provider,
    parent: new near.Account(PARENT, provider, KEY),
    rewards: new near.Account(REWARDS, provider, KEY), // the only wallet the server pays from
    publicKey: near.KeyPair.fromString(KEY).getPublicKey().toString(),
  };
  return ctx;
}

function configured() { return !!(PARENT && KEY); }
const walletForBot = (name) => `bot-${String(name).toLowerCase().replace(/[^a-z0-9]/g, "")}.${PARENT}`;
const walletForPlayer = (accountId) => `p-${String(accountId).toLowerCase().replace(/[^a-z0-9]/g, "")}.${PARENT}`;
const explorerAccount = (id) => `${EXPLORER}/address/${id}`;
const explorerTx = (hash) => `${EXPLORER}/txns/${hash}`;

// whole tokens (2 decimals of precision) <-> on-chain units
function toUnits(amount) {
  const cents = BigInt(Math.round(Number(amount) * 100));
  return (cents * 10n ** (DECIMALS - 2n)).toString();
}
function fromUnits(units) {
  const v = BigInt(units || "0");
  return Number(v / 10n ** (DECIMALS - 2n)) / 100;
}

// ---- one queue for every write ----
let tail = Promise.resolve();
function enqueue(job) {
  const run = tail.then(job, job);
  tail = run.catch(() => {});
  return run;
}

const known = new Set(); // wallets we know exist AND are registered on the token
async function accountExists(id) {
  const { provider } = await chain();
  try { await provider.viewAccount({ accountId: id }); return true; } catch { return false; }
}
async function view(method, args) {
  const { provider } = await chain();
  return provider.callFunction({ contractId: TOKEN, method, args });
}

// Make sure a wallet exists and can hold $SABOTEUR. Parent pays (testnet).
async function ensureWallet(id) {
  if (known.has(id) || id === BOT_TREASURY) return; // Bot Treasury is set up once by the secure script
  const { near, parent, publicKey } = await chain();
  if (!(await accountExists(id))) {
    const prefix = id.slice(0, -(PARENT.length + 1));
    await parent.createSubAccount({ accountOrPrefix: prefix, publicKey, nearToTransfer: near.nearToYocto("0.01") });
  }
  const reg = V2 ? true : await view("storage_balance_of", { account_id: id }); // v2 registers holders itself
  if (!reg) {
    const bounds = await view("storage_balance_bounds", {});
    await parent.callFunction({
      contractId: TOKEN, methodName: "storage_deposit",
      args: { account_id: id, registration_only: true }, deposit: BigInt(bounds.min), gas: near.teraToGas("10"),
    });
  }
  known.add(id);
}

// payouts: [{ wallet, amount }] (whole tokens). One transaction from the
// rewards wallet with one ft_transfer per receiver (all-or-nothing: if one
// transfer fails, none happen). Resolves { ok, txHash, error }.
//
// [NO DOUBLE PAY] A timeout does NOT mean the transaction failed - it may
// still land. So the transaction is signed first and handed to onSigned()
// to be saved, then sent. On a retry (opts.prior) we first ask the chain
// what happened to that exact transaction:
//   succeeded        -> done, never send again
//   failed on-chain  -> nothing moved (atomic) -> safe to build a new one
//   not found        -> re-send the SAME signed bytes (same nonce, so it can
//                       land at most once); only if it can no longer land
//                       (expired / nonce already used by something else)
//                       is a new transaction built.
async function txOutcome(txHash) {
  const { provider } = await chain();
  try {
    const r = await provider.viewTransactionStatus({ txHash, accountId: REWARDS, waitUntil: "EXECUTED_OPTIMISTIC" });
    if (r && r.status && r.status.Failure) return "failed";
    if (r && r.status && ("SuccessValue" in r.status || "SuccessReceiptId" in r.status)) return "success";
    return "unknown";
  } catch (e) {
    return "unknown";
  }
}
function failureText(f) {
  try { return JSON.stringify(f).slice(0, 300); } catch { return "transaction failed"; }
}
function payMatch(payouts, memo, opts = {}) {
  const list = (payouts || []).filter((p) => p.wallet && Number(p.amount) > 0);
  if (!configured() || !list.length) return Promise.resolve({ ok: false, error: configured() ? "nothing to pay" : "not configured" });
  return enqueue(async () => {
    const { near, rewards, provider } = await chain();
    try {
      const prior = opts.prior;
      if (prior && prior.txHash) {
        const st = await txOutcome(prior.txHash);
        if (st === "success") return { ok: true, txHash: prior.txHash };
        if (st === "unknown" && prior.signedTx) {
          try {
            const signed = near.SignedTransaction.decode(Buffer.from(prior.signedTx, "base64"));
            const res = await provider.sendTransactionUntil(signed, "EXECUTED_OPTIMISTIC");
            if (res && res.status && res.status.Failure) return { ok: false, error: failureText(res.status.Failure) };
            return { ok: true, txHash: prior.txHash };
          } catch (e) {
            const msg = String(e.message || e);
            if (!/expired|nonce/i.test(msg)) return { ok: false, error: msg.slice(0, 300) }; // still might land - keep waiting
            // can it have landed after all? (nonce used by this very tx)
            if ((await txOutcome(prior.txHash)) === "success") return { ok: true, txHash: prior.txHash };
            // expired or nonce taken by another tx -> this one can never land: build a new one below
          }
        }
        // "failed" -> nothing moved; build a new one below
      }
      for (const p of list) await ensureWallet(p.wallet);
      const actions = list.map((p) => near.actions.functionCall(
        "ft_transfer", { receiver_id: p.wallet, amount: toUnits(p.amount), memo: memo || null }, near.teraToGas("12"), 1n,
      ));
      const publicKey = await rewards.signer.getPublicKey();
      const tx = await rewards.createTransaction({ receiverId: TOKEN, actions, publicKey });
      const { txHash: hashBytes, signedTransaction } = await rewards.signer.signTransaction(tx);
      const txHash = near.baseEncode(hashBytes);
      if (opts.onSigned) await opts.onSigned(txHash, Buffer.from(signedTransaction.encode()).toString("base64"));
      const res = await provider.sendTransactionUntil(signedTransaction, "EXECUTED_OPTIMISTIC");
      if (res && res.status && res.status.Failure) return { ok: false, error: failureText(res.status.Failure) };
      return { ok: true, txHash };
    } catch (e) {
      console.warn("[SABOTEUR] payout failed:", e.message);
      return { ok: false, error: String(e.message || e).slice(0, 300) };
    }
  });
}

// ---------------- v2: the contract decides every amount ----------------
const B64 = (v) => { try { return JSON.parse(Buffer.from(v, "base64").toString()); } catch { return null; } };
const ALREADY = /Already recorded/;
// One function call from `signer` (an Account) on the v2 contract. Returns
// { ok, txHash, value, already } - `already` = the contract had recorded this
// id before (a retry of something that already landed: never paid twice).
async function callV2(signer, method, args, { gas = "60", deposit = 0n } = {}) {
  const { near, provider } = await chain();
  try {
    const publicKey = await signer.signer.getPublicKey();
    const tx = await signer.createTransaction({ receiverId: TOKEN, actions: [near.actions.functionCall(method, args, near.teraToGas(gas), deposit)], publicKey });
    const { txHash: h, signedTransaction } = await signer.signer.signTransaction(tx);
    const txHash = near.baseEncode(h);
    const res = await provider.sendTransactionUntil(signedTransaction, "EXECUTED_OPTIMISTIC");
    const st = res && res.status;
    if (st && st.Failure) {
      let full = ""; try { full = JSON.stringify(st.Failure); } catch { /* keep empty */ }
      return ALREADY.test(full) ? { ok: true, already: true, txHash } : { ok: false, error: failureText(st.Failure), txHash };
    }
    return { ok: true, txHash, value: st && typeof st.SuccessValue === "string" ? B64(st.SuccessValue) : null };
  } catch (e) {
    const msg = String(e.message || e);
    return ALREADY.test(msg) ? { ok: true, already: true } : { ok: false, error: msg.slice(0, 300) };
  }
}
const units = (n) => toUnits(n);
// results: [{ wallet, rank (1-3, 0 = finished), playPass }]. Amounts come back from the contract.
function reportMatch(matchId, humans, results) {
  if (!configured() || !V2) return Promise.resolve({ ok: false, error: "v2 not configured" });
  return enqueue(async () => {
    const { rewards } = await chain();
    for (const r of results) await ensureWallet(r.wallet);
    const res = await callV2(rewards, "reward_match", {
      match_id: String(matchId).slice(0, 70), humans: Math.min(16, humans),
      results: results.map((r) => ({ account_id: r.wallet, rank: r.rank, play_pass: !!r.playPass })),
    }, { gas: "120" });
    if (res.ok && Array.isArray(res.value)) res.amounts = res.value.map(fromUnits);
    return res;
  });
}
function catchRitual(matchId, humans) {
  if (!configured() || !V2) return Promise.resolve({ ok: false, error: "v2 not configured" });
  return enqueue(async () => {
    const { rewards } = await chain();
    const res = await callV2(rewards, "catch_ritual", { match_id: String(matchId).slice(0, 70), humans: Math.min(16, humans) }, { gas: "30" });
    if (res.ok && res.value != null) res.burned = fromUnits(res.value);
    return res;
  });
}
function rewardReferral(referralId, wallet) {
  if (!configured() || !V2) return Promise.resolve({ ok: false, error: "v2 not configured" });
  return enqueue(async () => {
    const { rewards } = await chain();
    await ensureWallet(wallet);
    const res = await callV2(rewards, "reward_referral", { referral_id: String(referralId).slice(0, 70), account_id: wallet }, { gas: "30" });
    if (res.ok && res.value != null) res.amount = fromUnits(res.value);
    return res;
  });
}
// The player's own game wallet (p-<id>.<parent>, held by the server) burns the price.
function buyPlayPass(wallet) {
  if (!configured() || !V2) return Promise.resolve({ ok: false, error: "v2 not configured" });
  return enqueue(async () => {
    const { near, provider, parent } = await chain();
    // Game wallets are created with only 0.01 NEAR - not enough to attach gas.
    // Top it up from the parent first (testnet NEAR), then burn with a small gas limit.
    try {
      const st = await provider.viewAccount({ accountId: wallet });
      if (BigInt(st.amount) < BigInt(near.nearToYocto("0.03"))) {
        await parent.transfer({ receiverId: wallet, amount: BigInt(near.nearToYocto("0.05")) });
      }
    } catch (e) { console.warn("[SABOTEUR] gas top-up failed:", e.message); }
    const acct = new near.Account(wallet, provider, KEY);
    return callV2(acct, "buy_play_pass", {}, { gas: "15", deposit: 1n });
  });
}
let statsCache = { at: 0, data: null };
async function v2Stats() {
  if (!configured() || !V2) return null;
  if (statsCache.data && Date.now() - statsCache.at < 15000) return statsCache.data;
  const [stats, rules] = await Promise.all([view("get_stats", {}), view("get_rules", {})]);
  const n = (x) => fromUnits(x);
  const r = rules.rules;
  const data = {
    contract: TOKEN, contractUrl: explorerAccount(TOKEN),
    supply: n(stats.total_supply), reserve: n(stats.reward_reserve), ritualPool: n(stats.ritual_pool),
    mintedByPlay: n(stats.minted_by_play), migrated: n(stats.migrated),
    burned: n(stats.burned_total), burnedByCatches: n(stats.burned_by_catches), burnedByPasses: n(stats.burned_by_passes),
    caught: stats.saboteurs_caught, passes: stats.play_passes, matches: stats.matches_rewarded,
    weekMinted: n(stats.week_minted), weekBudget: n(stats.week_budget), weekBurned: n(stats.week_burned),
    rules: {
      rankRewards: r.rank_rewards.map(n), finished: n(r.finished_reward),
      tiers: [r.tier_4plus_bps / 100, r.tier_2to3_bps / 100, r.tier_1_bps / 100],
      dailyFull: r.daily_full_matches, afterDaily: r.after_daily_bps / 100, passMultiplier: r.play_pass_multiplier,
      catchBurn: n(r.catch_burn), playPassPrice: n(r.play_pass_price),
      weeklyBase: n(r.weekly_base_budget), burnToBudget: r.burn_to_budget_bps / 100, referral: n(r.referral_reward),
    },
    pendingRules: !!rules.pending, timelockDays: rules.timelock_days,
  };
  statsCache = { at: Date.now(), data };
  return data;
}
async function hasPlayPassOnChain(wallet) {
  try { return !!(await view("has_play_pass", { account_id: wallet })); } catch { return false; }
}

async function balanceOf(wallet) {
  if (!configured()) return null;
  try { return fromUnits(await view("ft_balance_of", { account_id: wallet })); } catch { return null; }
}

module.exports = {
  configured, walletForBot, walletForPlayer, payMatch, balanceOf, ensureWallet, V2,
  reportMatch, catchRitual, rewardReferral, buyPlayPass, v2Stats, hasPlayPassOnChain,
  explorerAccount, explorerTx, TOKEN, TREASURY, REWARDS, BOT_TREASURY, PARENT,
};
