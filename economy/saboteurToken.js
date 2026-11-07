// ============================================================
// $SABOTEUR on NEAR testnet - the only file that talks to the chain.
//
// Accounts (all sub-accounts of SABOTEUR_PARENT_ACCOUNT_ID, all controlled
// by the one server key, so players never sign anything):
//   token.<parent>         NEP-141 contract (scripts/setup-saboteur-token.mjs)
//   treasury.<parent>      holds the supply, pays every reward
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
const TOKEN = PARENT ? `token.${PARENT}` : "";
const TREASURY = PARENT ? `treasury.${PARENT}` : "";
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
    treasury: new near.Account(TREASURY, provider, KEY),
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
  if (known.has(id)) return;
  const { near, parent, publicKey } = await chain();
  if (!(await accountExists(id))) {
    const prefix = id.slice(0, -(PARENT.length + 1));
    await parent.createSubAccount({ accountOrPrefix: prefix, publicKey, nearToTransfer: near.nearToYocto("0.01") });
  }
  const reg = await view("storage_balance_of", { account_id: id });
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
// treasury with one ft_transfer per receiver. Resolves { ok, txHash, error }.
function payMatch(payouts, memo) {
  const list = (payouts || []).filter((p) => p.wallet && Number(p.amount) > 0);
  if (!configured() || !list.length) return Promise.resolve({ ok: false, error: configured() ? "nothing to pay" : "not configured" });
  return enqueue(async () => {
    try {
      const { near, treasury } = await chain();
      for (const p of list) await ensureWallet(p.wallet);
      const res = await treasury.signAndSendTransaction({
        receiverId: TOKEN,
        actions: list.map((p) => near.actions.functionCall(
          "ft_transfer", { receiver_id: p.wallet, amount: toUnits(p.amount), memo: memo || null }, near.teraToGas("12"), 1n,
        )),
      });
      const txHash = res?.transaction?.hash || res?.transaction_outcome?.id || null;
      return { ok: true, txHash };
    } catch (e) {
      console.warn("[SABOTEUR] payout failed:", e.message);
      return { ok: false, error: String(e.message || e).slice(0, 300) };
    }
  });
}

async function balanceOf(wallet) {
  if (!configured()) return null;
  try { return fromUnits(await view("ft_balance_of", { account_id: wallet })); } catch { return null; }
}

module.exports = {
  configured, walletForBot, walletForPlayer, payMatch, balanceOf, ensureWallet,
  explorerAccount, explorerTx, TOKEN, TREASURY, PARENT,
};
