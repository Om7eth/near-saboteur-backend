// [$SABOTEUR - TESTNET] One-time hardening, safe to re-run.
//
// After setup-saboteur-token.mjs every account shared the server key. This:
//   1. creates rewards.<parent> - a SMALL hot wallet the server pays from
//      (REWARDS_FLOAT tokens), so a leaked server key can only lose that
//   2. creates bots.<parent> - the Bot Treasury that receives bot earnings
//      above the per-bot cap (receive-only for the server)
//   3. moves the big treasury.<parent> and the token.<parent> contract
//      account to a NEW "cold" key that is saved ONLY on this Mac
//      (~/.near-credentials/testnet/<account>.json) - never in .env/Render
//   4. removes the server key from treasury, token and bots accounts
//
// Order is lockout-safe: cold key file is written and re-read BEFORE it is
// added on chain, and the old key is removed only after the new one is
// confirmed on chain. Nothing secret is printed.
//
// Run:  node --env-file=.env scripts/secure-saboteur-wallets.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { Account, JsonRpcProvider, KeyPair, nearToYocto, teraToGas } from "near-api-js";

const PARENT = process.env.SABOTEUR_PARENT_ACCOUNT_ID;
const KEY = process.env.SABOTEUR_PARENT_PRIVATE_KEY;
if (!PARENT || !KEY) { console.error("Set SABOTEUR_PARENT_* in .env"); process.exit(1); }
const REWARDS_FLOAT = 1_000_000n; // whole tokens moved treasury -> rewards
const DEC = 10n ** 18n;
const provider = new JsonRpcProvider({ url: process.env.SABOTEUR_RPC_URL || "https://test.rpc.fastnear.com" });
const serverPub = KeyPair.fromString(KEY).getPublicKey().toString();
const TOKEN = `token.${PARENT}`, TREASURY = `treasury.${PARENT}`, REWARDS = `rewards.${PARENT}`, BOTS = `bots.${PARENT}`;
const parent = new Account(PARENT, provider, KEY);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const view = (method, args) => provider.callFunction({ contractId: TOKEN, method, args });

// ---- cold key: one per run, stored only in ~/.near-credentials ----
const credDir = `${homedir()}/.near-credentials/testnet`;
mkdirSync(credDir, { recursive: true });
const credFile = (id) => `${credDir}/${id}.json`;
function coldKeyFor(id) {
  if (existsSync(credFile(id))) {
    const j = JSON.parse(readFileSync(credFile(id), "utf8"));
    if (j.private_key && j.public_key) return j;
  }
  return null;
}
let cold = coldKeyFor(TREASURY) || coldKeyFor(TOKEN) || coldKeyFor(BOTS);
if (!cold) {
  const kp = KeyPair.fromRandom("ed25519");
  cold = { public_key: kp.getPublicKey().toString(), private_key: kp.toString() };
}
for (const id of [TREASURY, TOKEN, BOTS]) {
  if (!coldKeyFor(id)) writeFileSync(credFile(id), JSON.stringify({ account_id: id, ...cold }, null, 2), { mode: 0o600 });
  const back = coldKeyFor(id);
  if (!back || back.public_key !== cold.public_key) { console.error(`Could not save cold key for ${id} - stopping, nothing changed on chain.`); process.exit(1); }
}
console.log(`Cold key saved on this Mac only: ${credDir}/{treasury,token,bots}.${PARENT}.json`);

async function exists(id) { try { await provider.viewAccount({ accountId: id }); return true; } catch { return false; } }
async function keys(id) { return ((await provider.viewAccessKeyList({ accountId: id })).keys || []).map((k) => k.public_key); }
async function register(id) {
  if (await view("storage_balance_of", { account_id: id })) return;
  const b = await view("storage_balance_bounds", {});
  await parent.callFunction({ contractId: TOKEN, methodName: "storage_deposit", args: { account_id: id, registration_only: true }, deposit: BigInt(b.min), gas: teraToGas("10") });
}

// 1. rewards (server key) and 2. Bot Treasury (cold key only)
if (!(await exists(REWARDS))) { await parent.createSubAccount({ accountOrPrefix: "rewards", publicKey: serverPub, nearToTransfer: nearToYocto("0.2") }); console.log(`  + ${REWARDS}`); await pause(700); }
if (!(await exists(BOTS))) { await parent.createSubAccount({ accountOrPrefix: "bots", publicKey: cold.public_key, nearToTransfer: nearToYocto("0.05") }); console.log(`  + ${BOTS} (cold key only)`); await pause(700); }
await register(REWARDS); await register(BOTS);

// fund rewards float from the treasury (still signable with the server key on first run)
const rewardsBal = BigInt(await view("ft_balance_of", { account_id: REWARDS }));
if (rewardsBal === 0n) {
  const tKeys = await keys(TREASURY);
  const signer = tKeys.includes(serverPub) ? KEY : cold.private_key;
  await new Account(TREASURY, provider, signer).callFunction({
    contractId: TOKEN, methodName: "ft_transfer", args: { receiver_id: REWARDS, amount: (REWARDS_FLOAT * DEC).toString(), memo: "rewards float" }, deposit: 1n, gas: teraToGas("15"),
  });
  console.log(`  moved ${REWARDS_FLOAT.toLocaleString()} SABOTEUR treasury -> rewards`);
}

// 3 + 4. treasury & token: add cold key, confirm, remove server key
for (const id of [TREASURY, TOKEN]) {
  let k = await keys(id);
  if (!k.includes(cold.public_key)) {
    await new Account(id, provider, KEY).addFullAccessKey(cold.public_key);
    await pause(1500);
    k = await keys(id);
    if (!k.includes(cold.public_key)) { console.error(`Cold key not visible on ${id} yet - stopping before removing the server key. Re-run in a minute.`); process.exit(1); }
  }
  if (k.includes(serverPub)) {
    await new Account(id, provider, cold.private_key).deleteKey(serverPub);
    console.log(`  ${id}: server key removed (cold key only now)`);
  } else console.log(`  = ${id}: already cold-only`);
}

for (const id of [REWARDS, TREASURY, BOTS]) {
  console.log(`${id}: ${(BigInt(await view("ft_balance_of", { account_id: id })) / DEC).toLocaleString()} SABOTEUR · keys ${(await keys(id)).includes(serverPub) ? "server" : "cold only"}`);
}
