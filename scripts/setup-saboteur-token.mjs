// [$SABOTEUR - TESTNET] One-time setup, safe to re-run (skips what exists).
//
// Creates under SABOTEUR_PARENT_ACCOUNT_ID (e.g. saboteur.testnet):
//   token.<parent>      - the $SABOTEUR NEP-141 token (contracts/fungible_token.wasm)
//   treasury.<parent>   - holds the whole 1,000,000,000 supply; rewards are paid from here
//   bot-<name>.<parent> - one fixed wallet per AI bot (13), registered on the token
// Every sub-account gets the parent's public key, so the server signs for
// all of them with the one key in .env. Testnet only - no real value.
//
// Run:  node --env-file=.env scripts/setup-saboteur-token.mjs
import { readFileSync } from "node:fs";
import { Account, JsonRpcProvider, KeyPair, nearToYocto, teraToGas } from "near-api-js";

const PARENT = process.env.SABOTEUR_PARENT_ACCOUNT_ID;
const KEY = process.env.SABOTEUR_PARENT_PRIVATE_KEY;
const NETWORK = process.env.SABOTEUR_NETWORK || "testnet";
if (!PARENT || !KEY) { console.error("Set SABOTEUR_PARENT_ACCOUNT_ID and SABOTEUR_PARENT_PRIVATE_KEY in .env"); process.exit(1); }
if (NETWORK !== "testnet") { console.error("This setup is testnet-only."); process.exit(1); }

import { createRequire } from "node:module";
const { BOT_NAMES } = createRequire(import.meta.url)("../bots/botManager.js"); // single source of truth
const DECIMALS = 18;
const TOTAL_SUPPLY = (10n ** 9n * 10n ** BigInt(DECIMALS)).toString(); // 1B
const ICON = "data:image/svg+xml;base64," + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0b0d12"/><circle cx="32" cy="32" r="22" fill="none" stroke="#ffd75e" stroke-width="5"/><text x="32" y="41" font-family="Arial Black,Arial" font-size="24" text-anchor="middle" fill="#6effc0">S</text></svg>',
).toString("base64");

// rpc.testnet.near.org is deprecated and rate-limits; FastNear is what the backend uses too.
const RPC_URL = process.env.SABOTEUR_RPC_URL || "https://test.rpc.fastnear.com";
const provider = new JsonRpcProvider({ url: RPC_URL });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const parent = new Account(PARENT, provider, KEY);
const publicKey = KeyPair.fromString(KEY).getPublicKey().toString();
const TOKEN = `token.${PARENT}`;
const TREASURY = `treasury.${PARENT}`;

async function exists(id) {
  try { await provider.viewAccount({ accountId: id }); return true; } catch { return false; }
}
async function ensureSub(prefix, near) {
  const id = `${prefix}.${PARENT}`;
  if (await exists(id)) { console.log(`  = ${id} (exists)`); return id; }
  await parent.createSubAccount({ accountOrPrefix: prefix, publicKey, nearToTransfer: nearToYocto(near) });
  console.log(`  + ${id} (${near} NEAR)`);
  await pause(700);
  return id;
}
async function view(method, args) {
  return provider.callFunction({ contractId: TOKEN, method, args });
}

console.log(`Parent: ${PARENT}`);
console.log("Accounts:");
await ensureSub("token", 4);
await ensureSub("treasury", 0.5);
const bots = [];
for (const n of BOT_NAMES) bots.push(await ensureSub(`bot-${n.toLowerCase()}`, 0.05));

// Deploy + init the token once.
let meta = null;
try { meta = await view("ft_metadata", {}); } catch { meta = null; }
if (!meta) {
  console.log("Deploying $SABOTEUR token...");
  const token = new Account(TOKEN, provider, KEY);
  await token.deployContract(new Uint8Array(readFileSync(new URL("../contracts/fungible_token.wasm", import.meta.url))));
  await token.callFunction({
    contractId: TOKEN, methodName: "new",
    args: {
      owner_id: TREASURY, total_supply: TOTAL_SUPPLY,
      metadata: { spec: "ft-1.0.0", name: "Saboteur (testnet)", symbol: "SABOTEUR", icon: ICON, reference: null, reference_hash: null, decimals: DECIMALS },
    },
    gas: teraToGas("50"),
  });
  meta = await view("ft_metadata", {});
}
console.log(`Token: ${meta.name} (${meta.symbol}), decimals ${meta.decimals}`);

// Every bot wallet must be registered (storage) on the token to receive it.
const bounds = await view("storage_balance_bounds", {});
for (const id of bots) {
  const bal = await view("storage_balance_of", { account_id: id });
  if (bal) continue;
  await parent.callFunction({ contractId: TOKEN, methodName: "storage_deposit", args: { account_id: id, registration_only: true }, deposit: BigInt(bounds.min), gas: teraToGas("10") });
  console.log(`  registered ${id} on token`);
}

const tre = await view("ft_balance_of", { account_id: TREASURY });
console.log(`Treasury ${TREASURY}: ${(BigInt(tre) / 10n ** BigInt(DECIMALS)).toLocaleString()} SABOTEUR`);
console.log(`Explorer: https://testnet.nearblocks.io/token/${TOKEN}`);
