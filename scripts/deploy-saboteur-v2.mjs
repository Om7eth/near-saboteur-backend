// [$SABOTEUR v2 - TESTNET] Deploys the v2 token (token-v2/) and copies every
// v1 balance into it. Safe to re-run: each step checks what already exists.
//
//   sabo.<parent>   - the v2 contract. Its key is a NEW cold key saved only in
//                     ~/.near-credentials/testnet (never in .env / Render).
//   owner           - treasury.<parent> (cold key, this Mac only): can only
//                     propose rules (7-day timelock) and run the one-time migration
//   game            - rewards.<parent> (the server's key): can only REPORT
//                     matches / catches / referrals; the contract sets amounts
//
// Uses the parent + treasury keys from ~/.near-credentials. Nothing secret is printed.
// Run:  node scripts/deploy-saboteur-v2.mjs            (build token-v2 first)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { Account, JsonRpcProvider, KeyPair, nearToYocto, teraToGas } from "near-api-js";

const PARENT = "saboteur.testnet";
const V2 = `sabo.${PARENT}`, V1 = `token.${PARENT}`, OWNER = `treasury.${PARENT}`, GAME = `rewards.${PARENT}`;
const SKIP = new Set([V1, OWNER, GAME, V2]); // v1 supply holders that are not players
const DIR = `${homedir()}/.near-credentials/testnet`;
const keyOf = (id) => JSON.parse(readFileSync(`${DIR}/${id}.json`, "utf8")).private_key;
const provider = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = async (id) => { try { await provider.viewAccount({ accountId: id }); return true; } catch { return false; } };
const view = (contractId, method, args = {}) => provider.callFunction({ contractId, method, args });

// 1. account with its own cold key
if (!(await exists(V2))) {
  const file = `${DIR}/${V2}.json`;
  if (!existsSync(file)) {
    const kp = KeyPair.fromRandom("ed25519");
    writeFileSync(file, JSON.stringify({ account_id: V2, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }, null, 2), { mode: 0o600 });
  }
  const pub = JSON.parse(readFileSync(file, "utf8")).public_key;
  const parent = new Account(PARENT, provider, keyOf(PARENT));
  await parent.createSubAccount({ accountOrPrefix: "sabo", publicKey: pub, nearToTransfer: nearToYocto("3.35") });
  console.log(`+ created ${V2} (3.35 NEAR for code + holder storage)`);
  await pause(1500);
} else console.log(`= ${V2} exists`);

// 2. code + init
const v2 = new Account(V2, provider, keyOf(V2));
let ready = false;
try { await view(V2, "get_config"); ready = true; } catch { /* not deployed yet */ }
if (!ready) {
  const wasm = new URL("../token-v2/target/wasm32-unknown-unknown/release/saboteur_token_v2.wasm", import.meta.url);
  await v2.deployContract(new Uint8Array(readFileSync(wasm)));
  await pause(1500);
  await v2.callFunction({ contractId: V2, methodName: "new", args: { owner_id: OWNER, game_id: GAME }, gas: teraToGas("100") });
  console.log("+ deployed and initialised");
  await pause(1500);
} else console.log("= already deployed");

// 3. copy v1 balances (owner signs), then close migration forever
const [, , open] = await view(V2, "get_config");
if (open) {
  const res = await fetch(`https://test.api.fastnear.com/v1/ft/${V1}/top`);
  const holders = (await res.json()).accounts.filter((a) => !SKIP.has(a.account_id) && BigInt(a.balance) > 0n);
  const owner = new Account(OWNER, provider, keyOf(OWNER));
  for (let i = 0; i < holders.length; i += 10) {
    const chunk = holders.slice(i, i + 10).map((a) => [a.account_id, a.balance]);
    try {
      await owner.callFunction({ contractId: V2, methodName: "migrate", args: { entries: chunk }, gas: teraToGas("250") });
      console.log(`+ migrated ${i + chunk.length}/${holders.length}`);
    } catch (e) { console.log(`! chunk ${i}: ${String(e.message || e).slice(0, 160)}`); }
    await pause(800);
  }
  let ok = 0;
  for (const a of holders) if ((await view(V2, "ft_balance_of", { account_id: a.account_id })) === a.balance) ok++;
  console.log(`check: ${ok}/${holders.length} balances match v1`);
  if (ok === holders.length) {
    await owner.callFunction({ contractId: V2, methodName: "finish_migration", args: {}, gas: teraToGas("10") });
    console.log("+ migration closed");
  } else console.log("migration left OPEN - re-run to finish the missing ones");
} else console.log("= migration already closed");

const s = await view(V2, "get_stats");
console.log("stats:", JSON.stringify({ supply: s.total_supply, migrated: s.migrated, ritual: s.ritual_pool, budget: s.week_budget }));
