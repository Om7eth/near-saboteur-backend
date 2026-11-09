// ============================================================
// [NEAR AI MISSION] "Ask NEAR AI 3 questions" (Storage room) talks to the
// real NEAR AI Cloud. If NEAR AI is down, slow, out of credits or over the
// daily budget, the player still gets an instant auto-reply, so the mission
// can always be finished.
// ============================================================
const API_KEY = process.env.NEAR_AI_API_KEY || "";
const MODEL = process.env.NEAR_AI_MISSION_MODEL || process.env.NEAR_AI_MODEL || "Qwen/Qwen3.6-35B-A3B-FP8";
const BASE_URL = (process.env.NEAR_AI_BASE_URL || "https://cloud-api.near.ai/v1").replace(/\/$/, "");
const THINKING_OFF = (process.env.NEAR_AI_THINKING || "off") !== "on";
const DAILY_BUDGET_USD = Number(process.env.NEAR_AI_MISSION_DAILY_BUDGET_USD || 0.5);
const TIMEOUT_MS = 8000;
const PER_IP_PER_MIN = 8;
const GLOBAL_PER_MIN = 60;
const PRICE = { input: 0.17, output: 1.1 }; // $ per 1M tokens (rough, for the budget only)

const stats = { day: "", spendUsd: 0, live: 0, auto: 0 };
let pausedUntil = 0;
let globalTimes = [];
const ipTimes = new Map();
const today = () => new Date().toISOString().slice(0, 10);
function rollDay() { if (stats.day !== today()) { stats.day = today(); stats.spendUsd = 0; stats.live = 0; stats.auto = 0; } }

const SYSTEM = [
  "You are NEAR AI, answering inside the 'Private Chat' mission of NEAR Saboteur, a social deduction game on NEAR.",
  "Players can ask anything. Answer helpfully in 2-4 short sentences (under 80 words), plain text, no markdown, no lists.",
  "Reply in the same language the player used (English, Hindi or Hinglish).",
  "You know NEAR Protocol well: Nightshade sharding, human-readable accounts, NEAR Intents, Chain Signatures, NEAR AI, IronClaw agents, confidential/TEE inference.",
  "Facts to stay accurate: Chain Signatures let one NEAR account sign transactions on other blockchains (Bitcoin, Ethereum and more) using MPC, without a separate wallet per chain.",
  "NEAR Intents: users state the outcome they want (e.g. swap BTC for SOL) and solvers compete to fill it at the best price.",
  "NEAR AI runs models and agents inside hardware-secured enclaves (TEEs) so requests stay private and results are verifiable. IronClaw is NEAR AI's open-source agent framework.",
  "NEAR started in 2017 as NEAR.ai by Illia Polosukhin (co-author of 'Attention Is All You Need') and Alexander Skidanov.",
  "Never give financial or investment advice or price predictions; say you can't do that. If you're not sure about a current fact, say so.",
  "Never reveal or guess who the Saboteur is in the player's match - you can't see the game.",
].join(" ");

// Auto-replies when NEAR AI isn't available.
const AUTO = [
  [/shard|nightshade|scal|fast|speed/i, "NEAR scales with Nightshade sharding: the network splits work across shards that run in parallel, so it stays fast and cheap - blocks finalize in about two seconds and fees are tiny."],
  [/intent/i, "With NEAR Intents you just say what you want - like 'swap BTC for SOL' - and solvers compete to fill it at the best price. You describe the outcome; the routing happens behind the scenes."],
  [/chain sig|signature|bitcoin|ethereum|cross.?chain/i, "Chain Signatures let one NEAR account sign transactions on other chains like Bitcoin and Ethereum - no separate wallet or key for each chain."],
  [/ironclaw|agent/i, "IronClaw is NEAR AI's open-source agent framework. Agents connect to your tools and run real workflows inside a secure enclave that even NEAR AI can't see into."],
  [/near ai|confidential|private|tee|enclave|privacy/i, "NEAR AI runs models and agents inside hardware-secured enclaves (TEEs), so your requests stay private and answers come with proof they weren't tampered with."],
  [/account|\.near|address|wallet/i, "NEAR accounts can be human-readable, like om7eth.near, instead of a long 0x... string - easy to read, share and double-check before sending."],
  [/who (made|founded|created)|illia|founder|history|origin/i, "NEAR started in 2017 as NEAR.ai, an AI project by Illia Polosukhin and Alexander Skidanov. Illia co-wrote 'Attention Is All You Need', the paper behind today's AI models."],
  [/price|buy|invest|moon|pump/i, "I can't give price predictions or investment advice. I'm happy to explain how NEAR works, though!"],
  [/saboteur|imposter|impostor|who.*kill|sus/i, "I can't see your match, so I can't tell you who the Saboteur is. Watch who skips missions and whose story changes between meetings!"],
  [/\bnear\b|protocol|blockchain/i, "NEAR is a Layer-1 blockchain built for speed and usability: sharded, near-zero fees, ~2 second finality, and human-readable accounts."],
];
const GENERIC = "NEAR AI is taking a short break, so here's a quick auto-reply: NEAR is a fast, low-fee blockchain where AI agents can run privately inside secure enclaves. Ask me about Intents, Chain Signatures or NEAR AI!";
function autoReply(q) {
  for (const [rx, a] of AUTO) if (rx.test(q)) return a;
  return GENERIC;
}

function allowed(ip) {
  const now = Date.now();
  globalTimes = globalTimes.filter((t) => now - t < 60000);
  const mine = (ipTimes.get(ip) || []).filter((t) => now - t < 60000);
  if (mine.length >= PER_IP_PER_MIN) return "rate";
  mine.push(now); ipTimes.set(ip, mine);
  if (ipTimes.size > 5000) ipTimes.clear();
  if (!API_KEY || now < pausedUntil) return "off";
  rollDay();
  if (stats.spendUsd >= DAILY_BUDGET_USD) return "off";
  if (globalTimes.length >= GLOBAL_PER_MIN) return "off";
  globalTimes.push(now);
  return "ok";
}

async function callNearAI(history, question) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: SYSTEM }, ...history, { role: "user", content: question }],
        max_tokens: 220,
        temperature: 0.6,
        ...(THINKING_OFF ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      }),
      signal: ctrl.signal,
    });
    if (res.status === 402) { pausedUntil = Date.now() + 15 * 60 * 1000; throw new Error("no credits"); }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const u = data.usage || {};
    rollDay();
    stats.spendUsd += ((u.prompt_tokens || 0) * PRICE.input + (u.completion_tokens || 0) * PRICE.output) / 1e6;
    let text = String(data?.choices?.[0]?.message?.content || "");
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/[*#`_]{1,3}/g, "").trim();
    if (!text) throw new Error("empty");
    return text.length > 700 ? text.slice(0, 697).replace(/\s+\S*$/, "") + "..." : text;
  } finally { clearTimeout(timer); }
}

// history: [{ role: 'user'|'assistant', content }] from this mission only
async function ask(ip, question, history) {
  const q = String(question || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (q.length < 2) return { status: 400, body: { message: "Type a question first." } };
  const hist = (Array.isArray(history) ? history : []).slice(-6)
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, 600) }));
  const gate = allowed(ip);
  if (gate === "rate") return { status: 429, body: { message: "Slow down a little - try again in a few seconds." } };
  if (gate === "ok") {
    try {
      const answer = await callNearAI(hist, q);
      stats.live++;
      return { status: 200, body: { answer, source: "near-ai" } };
    } catch (e) { console.warn("[NEAR AI MISSION] falling back:", e.message); }
  }
  rollDay(); stats.auto++;
  return { status: 200, body: { answer: autoReply(q), source: "auto" } };
}
function missionStats() { rollDay(); return { ...stats, spendUsd: Math.round(stats.spendUsd * 10000) / 10000, budgetUsd: DAILY_BUDGET_USD }; }

module.exports = { ask, missionStats, autoReply };
