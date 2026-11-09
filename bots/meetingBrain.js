// ============================================================
// [AI BOTS - NEAR HACKATHON] What bots say and vote in meetings.
//
// Each bot talks from its OWN memory (see brain.js - only what it could
// really have seen). The words come from an LLM on NEAR AI Cloud
// (OpenAI-compatible API, private inference inside TEEs); if no key is
// configured or a call fails/times out, simple rule-based lines are used
// instead, so a meeting never stalls.
//
// Natural pacing: bots don't answer every message, they take "typing"
// time, reply when someone names or questions them, say at most a few
// things per meeting, and mirror the language the humans are using.
//
// Env (all optional):
//   NEAR_AI_API_KEY   - enables the LLM (otherwise rule-based fallback)
//   NEAR_AI_MODEL     - default "Qwen/Qwen3.6-35B-A3B-FP8" (verifiable/TEE
//                       model; picked after testing real meeting prompts:
//                       ~0.7s replies, natural Hinglish/Hindi, uses memory well)
//   NEAR_AI_THINKING  - "off" (default) sends enable_thinking:false so the
//                       model answers right away instead of reasoning first
//   NEAR_AI_BASE_URL  - default "https://cloud-api.near.ai/v1"
//   NEAR_AI_DAILY_BUDGET_USD    - default 1 (UTC day); then rule-based lines
//   NEAR_AI_MAX_CALLS_PER_MEETING - default 8 per meeting (whole room)
//
// Cost control: AI is used where it matters most (a bot with news
// opening the discussion, and replies when someone names or questions a
// bot). Quiet bots' votes and small talk use the rule-based lines. Spend
// is measured from each response's token usage and the model's public
// price; when the daily budget is used up, bots fall back for the rest
// of the day. Credits can be topped up on cloud.near.ai, including via
// NEAR AI's stake-to-compute (staking yield turned into credits).
// ============================================================
const { stickerLabel } = require("../stickers"); // [PLAY PASS - STICKERS] bots read stickers as text
const B = require("./brain");
const FC = require("./fallbackChat");
const { RULES: ECON_RULES } = require("../economy/rules");
const LESSONS = require("./lessons");

const API_KEY = process.env.NEAR_AI_API_KEY || "";
const MODEL = process.env.NEAR_AI_MODEL || "Qwen/Qwen3.6-35B-A3B-FP8";
const THINKING_OFF = (process.env.NEAR_AI_THINKING || "off") !== "on";
const BASE_URL = (process.env.NEAR_AI_BASE_URL || "https://cloud-api.near.ai/v1").replace(/\/$/, "");
const AI_TIMEOUT_MS = 9000;
const SLOW_REPLY_FILLER_MS = 5000;
const DAILY_BUDGET_USD = Number(process.env.NEAR_AI_DAILY_BUDGET_USD || 1);
const MAX_AI_CALLS_PER_MEETING = Number(process.env.NEAR_AI_MAX_CALLS_PER_MEETING || 8);
// $ per 1M tokens; refreshed from NEAR AI's public model list at startup.
let price = { input: 0.17, output: 1.1 };
const stats = { day: "", spendUsd: 0, calls: 0, failures: 0, fallbacks: 0, budgetHitLogged: false };
// Out of NEAR AI credits (HTTP 402): pause AI calls for a while instead of
// hitting the API on every meeting. Staking credits accrue per second, so
// it comes back on its own.
const NO_CREDIT_PAUSE_MS = 15 * 60 * 1000;
let aiPausedUntil = 0;
const today = () => new Date().toISOString().slice(0, 10);
function rollDay() {
  if (stats.day !== today()) { stats.day = today(); stats.spendUsd = 0; stats.budgetHitLogged = false; }
}
if (API_KEY) {
  fetch(`${BASE_URL}/model/list`).then((r) => r.json()).then((d) => {
    const m = (d.models || []).find((x) => x.modelId === MODEL);
    if (m) {
      const per = (c) => (c.amount / 10 ** c.scale) * 1e6;
      price = { input: per(m.inputCostPerToken), output: per(m.outputCostPerToken) };
      console.log(`[BOTS-AI] ${MODEL} price: $${+price.input.toFixed(3)}/M in, $${+price.output.toFixed(3)}/M out; daily budget $${DAILY_BUDGET_USD}`);
    }
  }).catch(() => { /* keep defaults */ });
}
const MAX_MSGS_PER_BOT = 4;
const MIN_GAP_BETWEEN_BOT_MSGS_MS = 4000; // [HUMAN PACE] bots don't fire back-to-back
// [HUMAN PACE] a person reads (~2-4s), thinks, then types ~5 chars/sec on a phone
const humanTypingMs = (text) => Math.max(3500, Math.min(16000, 1800 + String(text || '').length * 170));
const MAX_AI_CALLS_PER_MINUTE = 60; // global safety cap on spend

const rooms = new Map(); // roomCode -> meeting state
let aiCallTimes = [];

const rand = B.rand;
const chance = B.chance;

// ---- Language ---------------------------------------------------------
const HINGLISH_WORDS = new Set(["kahan", "rahe", "rahi", "ho", "lag", "gaya", "gayi", "kiya", "kyon", "matlab", "sach", "jhooth", "dekh", "chal", "mat", "karo", "bolo", "kuch", "nahin", "accha", "acha", "bas", "hum", "humne", "maine", "usne", "hai", "hain", "nahi", "nhi", "kya", "kyu", "kyun", "bhai", "mai", "main", "mein", "tha", "thi", "dekha", "kaha", "kaun", "kon", "tum", "tu", "mera", "tera", "aur", "koi", "abhi", "yaar", "haan", "ha", "kar", "raha", "rha", "wala", "isko", "usko", "pe", "se", "ko", "toh", "to", "bol", "bata", "sab", "kidhar", "idhar", "udhar", "sus"]);
function detectLanguage(texts) {
  if (texts.length > 1) {
    const last = detectLanguage([texts[texts.length - 1]]);
    if (last !== "english") return last;
  }
  const joined = texts.join(" ");
  if (/[ऀ-ॿ]/.test(joined)) return "hindi";
  const words = joined.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const hits = words.filter((w) => HINGLISH_WORDS.has(w) && w !== "sus" && w !== "to").length;
  return hits >= 2 ? "hinglish" : "english";
}

// ---- Memory -> text -----------------------------------------------------
function ago(t, now) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s ago`;
}
function memoryLines(memory, now, isSab) {
  const lines = [];
  for (const m of memory.slice(-40)) {
    const when = ago(m.t, now);
    if (m.kind === "saw") lines.push(`${when}: saw ${m.name} in ${m.where}${m.with && m.with.length ? ` (with ${m.with.join(", ")})` : ""}${m.via === "camera" ? " [on the security cameras]" : ""}`);
    else if (m.kind === "kill") lines.push(`${when}: SAW ${m.name} KILL ${m.victim} in ${m.where}${m.via === "camera" ? " [on the security cameras]" : ""}`);
    else if (m.kind === "body") lines.push(`${when}: found ${m.name}'s dead body in ${m.where}${m.via === "camera" ? " [on the security cameras]" : ""}`);
    else if (m.kind === "reported") lines.push(`${when}: you reported ${m.name}'s body in ${m.where}`);
    else if (m.kind === "did") lines.push(`${when}: you ${m.fake ? "pretended to do" : "did"} "${m.what}" in ${m.where}`);
    else if (m.kind === "i-killed" && isSab) lines.push(`${when}: YOU (secretly) killed ${m.name} in ${m.where} - nobody must find out`);
    else if (m.kind === "i-sabotaged" && isSab) lines.push(`${when}: you secretly triggered sabotage "${m.what}"`);
  }
  return lines.slice(-25);
}

// ---- NEAR AI Cloud ------------------------------------------------------
function aiAllowed(st) {
  if (!API_KEY) return false;
  if (Date.now() < aiPausedUntil) return false;
  rollDay();
  if (stats.spendUsd >= DAILY_BUDGET_USD) {
    if (!stats.budgetHitLogged) { stats.budgetHitLogged = true; console.warn(`[BOTS-AI] daily NEAR AI budget ($${DAILY_BUDGET_USD}) used up - rule-based lines until tomorrow (UTC)`); }
    return false;
  }
  if (st && st.aiCalls >= MAX_AI_CALLS_PER_MEETING) return false;
  const now = Date.now();
  aiCallTimes = aiCallTimes.filter((t) => now - t < 60000);
  if (aiCallTimes.length >= MAX_AI_CALLS_PER_MINUTE) return false;
  aiCallTimes.push(now);
  if (st) st.aiCalls = (st.aiCalls || 0) + 1;
  return true;
}
async function callNearAI(system, user) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        max_tokens: 400,
        temperature: 0.85,
        response_format: { type: "json_object" },
        // Reasoning models otherwise spend the whole token budget "thinking"
        // and reply late or empty; a quick chat line doesn't need it.
        ...(THINKING_OFF ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      }),
      signal: ctrl.signal,
    });
    if (res.status === 402) {
      aiPausedUntil = Date.now() + NO_CREDIT_PAUSE_MS;
      console.warn(`[BOTS-AI] NEAR AI credits used up (402) - rule-based chat for the next 15 min. Top up or wait for staking credits on cloud.near.ai.`);
      throw new Error("insufficient credits");
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    stats.calls++;
    const u = data.usage || {};
    rollDay();
    stats.spendUsd += ((u.prompt_tokens || 0) * price.input + (u.completion_tokens || 0) * price.output) / 1e6;
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) {
      const rt = (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || u.reasoning_tokens || 0;
      throw new Error(rt ? `empty reply - model spent ${rt} tokens reasoning (try a non-reasoning NEAR_AI_MODEL)` : "empty completion");
    }
    const m = String(content).match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no JSON in completion");
    return JSON.parse(m[0]);
  } finally {
    clearTimeout(timer);
  }
}

// ---- Context for one bot -----------------------------------------------
function buildContext(room, botId, memory, now) {
  const me = room.players[botId];
  const meeting = room.meeting;
  const isSab = me.role === "saboteur";
  const alive = Object.entries(room.players).filter(([, p]) => p.alive !== false && !p.spectator);
  const dead = Object.entries(room.players).filter(([, p]) => p.alive === false && !p.spectator); // [WATCH MODE] a watching host never died
  const caller = room.players[meeting.calledBy];
  const body = meeting.reportedBodyId && room.players[meeting.reportedBodyId];
  const chat = (meeting.messages || []).slice(-15).map((m) => `${m.senderName}${room.players[m.senderId] && room.players[m.senderId].isBot ? " (bot)" : ""}: ${m.text || stickerLabel(m.sticker)}`);
  // [MEMORY] what people said in EARLIER meetings of THIS match (never other matches)
  const earlier = [];
  let mNo = 0;
  for (const e of room.matchChat || []) {
    if (e.kind === "sep") { mNo = e.meetingNo || mNo + 1; if (mNo >= (room.meetingNo || 0)) break; earlier.push(`-- meeting ${mNo}: ${e.bodyName ? `${e.callerName} reported ${e.bodyName}'s body` : `${e.callerName} called it`} --`); }
    else if (e.kind === "msg" && e.text && mNo && mNo < (room.meetingNo || 0)) earlier.push(`${e.senderName}${room.players[e.senderId] && room.players[e.senderId].isBot ? " (bot)" : ""}: ${String(e.text).slice(0, 140)}`);
  }
  const humanTexts = (meeting.messages || []).filter((m) => room.players[m.senderId] && !room.players[m.senderId].isBot).map((m) => m.text);
  const teammates = isSab ? alive.filter(([id, p]) => id !== botId && p.role === "saboteur").map(([, p]) => p.name) : [];
  // [REALISM] A meeting with no deaths at all has nothing to solve: real
  // players ask the caller why, say what they were doing, and skip.
  const noDeaths = dead.length === 0;
  const callerIsHuman = !!(caller && !caller.isBot);
  return {
    me, isSab, alive, dead, caller, body, chat, humanTexts, teammates, noDeaths, callerIsHuman,
    earlier: earlier.slice(-16),
    evidence: isSab ? [] : evidenceLines(room, botId, memory, now),
    read: isSab ? null : evidenceLines.last,
    lessons: LESSONS.cached(isSab ? "saboteur" : "crew"),
    language: detectLanguage(humanTexts),
    memory: memoryLines(memory, now, isSab),
    reason: meeting.reason === "report" ? `${caller ? caller.name : "Someone"} reported ${body ? body.name + "'s" : "a"} dead body${body && typeof body.bodyX === "number" ? " in " + B.roomNameAt(body.bodyX, body.bodyY) : ""}` : `${caller ? caller.name : "Someone"} called an emergency meeting`,
  };
}

// [THINK LIKE A PLAYER] Facts worked out in code from this bot's own memory
// and public game events - the model reasons over them like a detective.
// Claims in chat are NOT facts; they get checked against these.
const ACCUSE_WORDS = /\b(sus|saw|seen|dekha|dekhi|bhaga|bhagte|bhaag|nikla|nikal|niklte|ran|running|came out|vent|kill|killed|maara|mara|maarte|pakka|vote|lying|jhooth|body ke paas|near the body)\b/i;
const DETAIL_RX = /\b(body|laash|lash|maara|maarte|mara|kill|killed|vent|bhaga|bhagte|nikla|ran|came out)\b/i;
const nameRx = (n) => new RegExp(`\\b${String(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
function evidenceLines(room, botId, memory, now) {
  const out = [];
  const me = room.players[botId];
  const meeting = room.meeting || {};
  const rel = (t) => (now - t < 15000 ? "just before the meeting" : now - t < 60000 ? "a little before" : "earlier");
  // 1) Kill window for each body: from the last time I saw the victim alive to when the body was found.
  const bodies = [];
  for (const b of memory.filter((m) => m.kind === "body")) bodies.push({ victim: b.name, where: b.where, foundAt: b.t });
  const rep = meeting.reportedBodyId && room.players[meeting.reportedBodyId];
  if (rep && !bodies.some((b) => b.victim === rep.name)) bodies.push({ victim: rep.name, where: typeof rep.bodyX === "number" ? B.roomNameAt(rep.bodyX, rep.bodyY) : null, foundAt: meeting.startedAt || now });
  for (const b of bodies.slice(-2)) {
    const lastAlive = [...memory].reverse().find((m) => m.kind === "saw" && m.name === b.victim && m.t <= b.foundAt);
    const from = lastAlive ? lastAlive.t : b.foundAt - 90000;
    const seen = memory.filter((m) => m.kind === "saw" && m.t >= from && m.t <= b.foundAt && m.name !== b.victim);
    const byName = {};
    for (const m of seen) (byName[m.name] = byName[m.name] || []).push(m);
    const parts = Object.entries(byName).map(([n, list]) => {
      const atBody = b.where && list.some((m) => m.where === b.where);
      const last = list[list.length - 1];
      return `${n} in ${last.where}${atBody ? ` (THE BODY'S ROOM)` : ""}${last.with && last.with.length ? ` with ${last.with.join(", ")}` : ""}`;
    });
    out.push(`${b.victim} died${b.where ? ` in ${b.where}` : ""}${lastAlive ? ` some time after you last saw them alive in ${lastAlive.where} (${rel(lastAlive.t)})` : ""}. While that could have happened you saw: ${parts.length ? parts.join("; ") : "nobody (you can't confirm or rule out anyone)"}.`);
  }
  for (const k of memory.filter((m) => m.kind === "kill")) out.push(`YOU SAW ${k.name} kill ${k.victim}${k.via === "camera" ? " on the cameras" : ""}. That is certain.`);
  // 2) Track record: earlier accusations vs what the vote-outs revealed (public).
  for (const e of room.ejections || []) {
    const accusers = new Set();
    for (const m of (room.matchChat || []).filter((x) => x.kind === "msg" && x.text && ACCUSE_WORDS.test(x.text))) {
      const sp = room.players[m.senderId];
      if (sp && sp.name !== e.name && nameRx(e.name).test(m.text)) accusers.add(sp.name + (sp.isBot ? " (bot)" : ""));
    }
    out.push(`${e.name} was voted out in meeting ${e.meetingNo} and was ${e.role === "saboteur" ? "a SABOTEUR" : "CREW (innocent)"}.${accusers.size ? ` Pushed by: ${[...accusers].join(", ")} - ${e.role === "saboteur" ? "they were right, more trustworthy" : "they were wrong; a saboteur could have been framing"}.` : ""}`);
  }
  // 3) Who keeps accusing whom this match.
  const counts = {};
  for (const e of [...(room.matchChat || []).filter((x) => x.kind === "msg"), ...(meeting.messages || [])]) {
    const sender = room.players[e.senderId];
    if (!sender || sender === me || !e.text || !ACCUSE_WORDS.test(e.text)) continue;
    for (const [, p] of Object.entries(room.players)) if (p !== sender && p.alive !== false && nameRx(p.name).test(e.text)) { const k = `${sender.name}->${p.name}`; counts[k] = (counts[k] || 0) + 1; }
  }
  for (const [k, n] of Object.entries(counts)) { const [a, t] = k.split("->"); out.push(`${a} has accused ${t}${n > 1 ? ` ${n} times this match` : " once"} (a claim - check it against the facts above).`); }

  // 4) Detective notebook: score each living suspect from the facts + claims.
  const roomNames = Object.values(B.ROOM_NAME || {});
  const score = {}, why = {}, liars = [];
  const add = (n, v, r) => { score[n] = (score[n] || 0) + v; (why[n] = why[n] || []).push(r); };
  const latest = bodies[bodies.length - 1];
  if (latest) {
    const lastAlive = [...memory].reverse().find((m) => m.kind === "saw" && m.name === latest.victim && m.t <= latest.foundAt);
    const from = lastAlive ? lastAlive.t : latest.foundAt - 90000;
    const inWindow = memory.filter((m) => m.kind === "saw" && m.t >= from && m.t <= latest.foundAt);
    for (const m of inWindow) if (latest.where && m.where === latest.where && m.name !== latest.victim) add(m.name, 2, `you saw them in the body's room (${latest.where})`);
    // claims about the latest death
    const ejectRole = {}; for (const e of room.ejections || []) ejectRole[e.name] = e.role;
    for (const e of meeting.messages || []) {
      const sp = room.players[e.senderId];
      if (!sp || sp === me || !e.text || !ACCUSE_WORDS.test(e.text)) continue;
      for (const [, p] of Object.entries(room.players)) {
        if (p === sp || p.alive === false || !nameRx(p.name).test(e.text)) continue;
        const specific = DETAIL_RX.test(e.text) || roomNames.some((r) => e.text.toLowerCase().includes(r.toLowerCase()));
        // does my own memory put the accused somewhere else during the window?
        const elsewhere = inWindow.filter((m) => m.name === p.name && latest.where && m.where !== latest.where);
        if (elsewhere.length && !inWindow.some((m) => m.name === p.name && m.where === latest.where)) {
          add(p.name, -3, `you saw them in ${elsewhere[elsewhere.length - 1].where}, not the body's room`);
          add(sp.name, 2, `their claim about ${p.name} contradicts what you saw`);
          liars.push(`${sp.name}'s claim about ${p.name} CONTRADICTS what you saw (${p.name} was in ${elsewhere[elsewhere.length - 1].where}).`);
          continue;
        }
        add(p.name, specific ? 1 : 0.5, `${sp.name} ${specific ? "gave a specific claim" : "made a vague claim"}`);
        const record = Object.entries(ejectRole).find(([n]) => (room.matchChat || []).some((x) => x.kind === "msg" && x.senderId === e.senderId && nameRx(n).test(x.text || "")));
        if (record) add(p.name, record[1] === "saboteur" ? 1 : -1, `${sp.name}'s last accusation was ${record[1] === "saboteur" ? "right" : "wrong"}`);
      }
    }
  }
  for (const l of liars) out.push(l);
  const ranked = Object.entries(score).filter(([n]) => n !== me.name && Object.values(room.players).some((p) => p.name === n && p.alive !== false)).sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  if (top && top[1] >= 3) out.push(`YOUR READ: ${top[0]} is very likely a saboteur (${why[top[0]].join("; ")}). Say why and vote ${top[0]}.`);
  else if (top && top[1] > 0) out.push(`YOUR READ: leaning ${top[0]} (${why[top[0]].join("; ")}) but not enough yet - ask ${top[0]} or the accuser ONE specific question; vote skip unless more comes out.`);
  else out.push("YOUR READ: nothing points to anyone yet - ask a specific question or share what you saw; vote skip.");
  evidenceLines.last = { voteFor: top && top[1] >= 3 ? top[0] : null, liars: liars.length ? Object.keys(score).filter((n) => score[n] >= 2 && why[n].some((r) => r.includes("contradicts"))) : [] };
  return out.slice(-10);
}

const PERSONAS = [
  "chill and brief, types in lowercase",
  "a bit dramatic, uses the occasional emoji",
  "analytical, asks pointed questions",
  "friendly, agrees easily but defends itself hard",
  "suspicious of everyone, short sentences",
];
function personaFor(botId) {
  let h = 0; for (const c of botId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PERSONAS[h % PERSONAS.length];
}

function systemPrompt(ctx) {
  const lang = ctx.language === "hindi"
    ? "The players are writing in Hindi (Devanagari). Reply in natural, casual Hindi."
    : ctx.language === "hinglish"
      ? "The players are writing in Hinglish (Hindi in Latin letters, mixed with English). Reply in natural, casual Hinglish the same way."
      : "Reply in the same language and style the human players use in the chat (if nobody has written yet, use simple casual English).";
  const role = ctx.isSab
    ? `You are secretly the SABOTEUR${ctx.teammates.length ? ` (your fellow saboteur: ${ctx.teammates.join(", ")})` : ""}. Never admit it. Stay calm, give a believable alibi from what you "did", and if useful cast doubt on someone else - but don't overdo it, and never contradict facts everyone saw. Don't vote for your teammate.`
    : [
      "You are CREW. Tell the truth about what you remember. You may be unsure - say so. If you saw a kill, say it clearly.",
      "THINK LIKE A REAL DETECTIVE. Things players say are CLAIMS, not proof - saboteurs lie, report their own kills, and frame innocent people. Treat a claim as a lead and test it:",
      "1) Check it against the FACTS (who you saw where while the victim could have died). If the facts contradict a claim, say so plainly - and become suspicious of whoever made the false claim.",
      "2) If a claim is vague (\"pakka X hai\", \"trust me\"), ask that person ONE specific question: which room, when, what were they doing there. Real witnesses give details and stay consistent; liars stay vague or change their story.",
      "3) Use the track record: people whose earlier accusation turned out right are more believable; people who pushed out an innocent are less.",
      "4) Vote someone out only if you saw it yourself, or at least two separate things point to them (e.g. a specific claim no fact contradicts + they were in the body's room / have no alibi / only deflect instead of giving their own whereabouts). Otherwise say who you lean towards and why, and vote skip.",
      "Never treat reporting a body, or demanding proof, as evidence by itself. Change your mind when new facts come in.",
    ].join(" ");
  return [
    `You are "${ctx.me.name}", a player in NEAR Saboteur, a social deduction game: crew do missions on a space station, one or two hidden saboteurs kill people. Everyone is now in a meeting to discuss and vote someone out.`,
    "Your name is shown with a BOT tag, so everyone knows you are an AI bot. If asked, admit you're a bot - but you still play to win like anyone else.",
    role,
    `Personality: ${personaFor(ctx.me.name)}.`,
    "HONESTY RULES (most important): only mention things that are in \"What you remember\" or in the chat. Never invent sightings, camera footage, movements, lies or events. If you don't know, say you don't know. Being in a room with others, walking around, being seen on cameras or doing missions is NORMAL - it is never evidence on its own.",
    "Don't start long back-and-forth arguments with other bots; talk to the humans, and keep it short.",
    ctx.lessons && ctx.lessons.length ? `General tips learned from many past games (use them to play better; NEVER mention past games, other players, or that you learned anything): ${ctx.lessons.map((l) => `- ${l}`).join(" ")}` : "",
    "Write like a real player in a fast game chat: ONE short message (max ~18 words), no lists, no narration, no quotes, react to what others just said, use player names. It's fine to stay silent if you have nothing useful.",
    "Never quote exact times or seconds from your memory (no \"44s\"); say it like a person would: \"just now\", \"a bit before\", \"earlier\" (or the same in the chat's language).",
    lang,
    'Answer ONLY with JSON: {"say": "<your chat message, or empty string to stay silent>", "vote": "<exact name of a living player, or skip>", "suspect": "<name or none>"}',
  ].join("\n");
}
// Quiet meetings: each bot takes a different angle so they don't all say
// the same thing at once.
const CALM_ANGLE = {
  askCaller: "You speak first: ask the caller, in your own words, why they called it.",
  whatIDid: "Say briefly what you were doing (from your memory) - nothing else.",
  agreeSkip: "React to the chat: agree it's probably nothing and that skipping is fine.",
  react: "Only react to what someone just said, briefly - or stay silent (empty say) if there's nothing to add.",
};
function userPrompt(ctx, alreadySaid, trigger, othersSaid) {
  const situation = ctx.noDeaths
    ? `SITUATION: nobody has died yet this game - no body, no kill, no evidence against anyone. ${ctx.caller ? ctx.caller.name : "Someone"} called this emergency meeting without a body. Talk like a real player would. ${CALM_ANGLE[ctx.angle] || CALM_ANGLE.react} Do NOT accuse anyone or call anyone sus, and vote skip unless a human gives a real reason. If someone already asked the caller why, don't ask again. Don't end your message with "vote skip" every time.`
    : "";
  return [
    `Meeting: ${ctx.reason}.`,
    situation,
    `Alive: ${ctx.alive.map(([, p]) => p.name + (p === ctx.me ? " (you)" : "")).join(", ")}.`,
    ctx.dead.length ? `Dead: ${ctx.dead.map(([, p]) => p.name).join(", ")}.` : "Nobody else is dead.",
    "",
    ctx.earlier && ctx.earlier.length ? "Earlier meetings in THIS match (what people said):" : "",
    ...(ctx.earlier && ctx.earlier.length ? ctx.earlier : []),
    ctx.earlier && ctx.earlier.length ? "" : "",
    ctx.evidence && ctx.evidence.length ? "FACTS (from your own eyes and public game events - reliable; chat messages are only claims):" : "",
    ...(ctx.evidence && ctx.evidence.length ? ctx.evidence.map((l) => `- ${l}`) : []),
    ctx.evidence && ctx.evidence.length ? "" : "",
    "What you remember (only you know this):",
    ...(ctx.memory.length ? ctx.memory : ["(nothing notable - you were doing your own thing)"]),
    "",
    "Chat so far:",
    ...(ctx.chat.length ? ctx.chat : ["(no messages yet)"]),
    alreadySaid.length ? `\nYou already said: ${alreadySaid.map((t) => `"${t}"`).join(" ")} - don't repeat yourself.` : "",
    othersSaid && othersSaid.length ? `Other bots already said: ${othersSaid.map((t) => `"${t}"`).join(" ")} - don't repeat or paraphrase them.` : "",
    trigger ? `\nReply to this message: ${trigger.fromName}: "${trigger.text}" (answer what they actually asked - a question is not an accusation).` : "",
  ].join("\n");
}

// ---- Rule-based fallback ------------------------------------------------
const LINES = {
  english: {
    sawKill: (k, v, w, cam) => `${cam ? "on cams i" : "i"} saw ${k} kill ${v} in ${w}!! vote ${k}`,
    body: (v, w) => `found ${v} dead in ${w}`,
    near: (who, w) => `${who} was around ${w} not long before`,
    alibi: (w, what) => `wasn't me, i was in ${w} doing ${what}`,
    nothing: () => pick(["no idea tbh, i was doing tasks", "didn't see anything, anyone?", "where was everyone?"]),
    suspectSay: (who) => `${who} is acting kinda sus ngl`,
    skip: () => "not enough info, skip",
  },
  hinglish: {
    sawKill: (k, v, w, cam) => `${cam ? "camera pe" : "maine"} dekha ${k} ne ${v} ko ${w} mein maara!! ${k} ko vote karo`,
    body: (v, w) => `${v} ki body ${w} mein mili`,
    near: (who, w) => `${who} thodi der pehle ${w} ke paas tha`,
    alibi: (w, what) => `main nahi tha bhai, main ${w} mein ${what} kar raha tha`,
    nothing: () => pick(["pata nahi yaar, main tasks kar raha tha", "maine kuch nahi dekha, kisi ne dekha?", "sab log kahan the?"]),
    suspectSay: (who) => `${who} thoda sus lag raha hai`,
    skip: () => "info kam hai, skip karo",
  },
  hindi: {
    sawKill: (k, v, w, cam) => `${cam ? "कैमरे पर" : "मैंने"} देखा ${k} ने ${v} को ${w} में मारा! ${k} को वोट करो`,
    body: (v, w) => `${v} की बॉडी ${w} में मिली`,
    near: (who, w) => `${who} थोड़ी देर पहले ${w} के पास था`,
    alibi: (w, what) => `मैं नहीं था, मैं ${w} में ${what} कर रहा था`,
    nothing: () => pick(["पता नहीं, मैं टास्क कर रहा था", "मैंने कुछ नहीं देखा", "सब कहाँ थे?"]),
    suspectSay: (who) => `${who} थोड़ा संदिग्ध लग रहा है`,
    skip: () => "जानकारी कम है, स्किप करो",
  },
};
const pick = (a) => a[Math.floor(Math.random() * a.length)];
function fallbackThink(ctx, memory, alreadySaid, mentioned) {
  const L = LINES[ctx.language] || LINES.english;
  const aliveNames = new Set(ctx.alive.map(([, p]) => p.name));
  const lastDid = [...memory].reverse().find((m) => m.kind === "did");
  if (ctx.isSab) {
    const crew = ctx.alive.filter(([, p]) => p !== ctx.me && p.role !== "saboteur").map(([, p]) => p.name);
    // Pile on whoever the humans are already accusing, otherwise someone random.
    const accused = crew.find((n) => ctx.humanTexts.some((t) => t.toLowerCase().includes(n.toLowerCase())));
    const scapegoat = accused || (chance(0.5) ? pick(crew) : null);
    let say = "";
    if (mentioned || !alreadySaid.length) say = lastDid ? L.alibi(lastDid.where, lastDid.what) : L.nothing();
    else if (scapegoat && chance(0.5)) say = L.suspectSay(scapegoat);
    return { say, vote: scapegoat && chance(0.7) ? scapegoat : "skip" };
  }
  const kill = [...memory].reverse().find((m) => m.kind === "kill" && aliveNames.has(m.name));
  if (kill) return { say: alreadySaid.length && !mentioned ? "" : L.sawKill(kill.name, kill.victim, kill.where, kill.via === "camera"), vote: kill.name };
  const body = [...memory].reverse().find((m) => m.kind === "body");
  if (body && !alreadySaid.length) {
    // Who did we see near that spot shortly before finding the body?
    const near = memory.filter((m) => m.kind === "saw" && m.where === body.where && body.t - m.t < 45000 && m.t <= body.t && aliveNames.has(m.name) && m.name !== ctx.me.name);
    const who = near.length ? near[near.length - 1].name : null;
    return { say: who ? `${L.body(body.name, body.where)}, ${L.near(who, body.where)}` : L.body(body.name, body.where), vote: who || "skip" };
  }
  if (mentioned) return { say: lastDid ? L.alibi(lastDid.where, lastDid.what) : L.nothing(), vote: "skip" };
  return { say: alreadySaid.length ? "" : (chance(0.6) ? L.nothing() : ""), vote: "skip" };
}

// ---- Per-meeting state ---------------------------------------------------
function stateFor(roomCode, room) {
  let st = rooms.get(roomCode);
  if (!st || st.meetingRef !== room.meeting) {
    st = { meetingRef: room.meeting, bots: {}, lastBotMsgAt: 0, chatStartedAt: 0, aiCalls: 0, used: new Set(), botLines: [] };
    rooms.set(roomCode, st);
  }
  return st;
}
function botState(st, id) {
  if (!st.bots[id]) st.bots[id] = { said: [], nextActAt: 0, busy: false, vote: null, voted: false, pendingSay: null, mentioned: false, skipped: false, notBefore: 0, usedFiller: false, hasNews: false };
  return st.bots[id];
}

async function think(room, roomCode, botId, memory, bs, now, st, purpose) {
  const ctx = buildContext(room, botId, memory, now);
  ctx.angle = bs.calmAngle || null;
  const mentioned = bs.mentioned;
  bs.mentioned = false;
  const trigger = bs.trigger || null;
  bs.trigger = null;
  let out = null, source = "fallback";
  // Spend AI calls where they matter: openings by bots with news, and
  // replies when someone talks to the bot. Quiet votes/small talk: rules.
  const worthIt = purpose === "reply" || (purpose === "open" && bs.hasNews) || (purpose === "chime" && bs.said.length === 0);
  if (worthIt && aiAllowed(st)) {
    try {
      out = await callNearAI(systemPrompt(ctx), userPrompt(ctx, bs.said, trigger, st ? st.botLines : []));
      source = "near-ai";
    } catch (e) {
      stats.failures++;
      console.warn(`[BOTS-AI] ${ctx.me.name}: NEAR AI call failed (${e.name === "AbortError" ? "timeout" : e.message}) - using fallback`);
    }
  }
  if (!out || typeof out !== "object") { stats.fallbacks++; out = FC.respond(ctx, memory, bs.said, trigger, st ? st.used : new Set()); }
  // Someone tagged this bot: never leave them hanging.
  if (mentioned && (!out.say || !String(out.say).trim())) {
    const again = FC.respond(ctx, memory, bs.said, { text: "where were you?", fromName: trigger ? trigger.fromName : "" }, st ? st.used : new Set());
    out = { ...out, say: again.say || (ctx.language === "english" ? "here, nothing new from me" : "haan bolo, mere paas kuch naya nahi") };
  }
  let say = typeof out.say === "string" ? out.say.trim() : "";
  // Models sometimes prefix their own name ("Nova: ...") or wrap in quotes.
  const esc = ctx.me.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  say = say.replace(new RegExp(`^\\s*${esc}\\s*(\\(bot\\))?\\s*[:\\-]\\s*`, "i"), "").replace(/^["']+|["']+$/g, "").trim().slice(0, 200);
  // [REALISM] Safety net: with nobody dead there is nothing to accuse
  // anyone of - if the model still made something up, use a calm line.
  if (ctx.noDeaths && say && ACCUSE_RX.test(say) && !/\bany ?sus\b|\bkoi sus\b/i.test(say) && !NEGATED_SUS_RX.test(say)) {
    console.log(`[BOTS-AI] ${ctx.me.name}: dropped made-up accusation "${say}"`);
    const calm = FC.respond(ctx, memory, bs.said, trigger, st ? st.used : new Set());
    say = (calm.say || "").trim();
  }
  // People don't quote seconds ("30s ago") - the prompt says so, enforce it.
  say = say.replace(/\b\d+\s?m\s?\d+\s?s\s+ago\b/gi, ctx.language === "english" ? "a bit ago" : "thodi der pehle")
    .replace(/\b\d+\s?(s|sec|secs|seconds?|min|mins|minute)\s+(pehle|pahle|before)\b/gi, ctx.language === "english" ? "a bit before" : "thodi der pehle")
    .replace(/\b\d+\s?(s|sec|secs|seconds?)\s+ago\b/gi, ctx.language === "english" ? "a bit ago" : "thodi der pehle")
    .replace(/\b\d+\s?(m|min|mins|minutes?)\s+ago\b/gi, ctx.language === "english" ? "earlier" : "pehle");
  // [REALISM] "I'll stay silent" is not a chat message - just stay silent.
  if (/\b(stay(ing)? (silent|quiet)|nothing to add|chup rahunga)\b/i.test(say)) say = "";
  // Only one person needs to ask the caller why - don't echo it.
  if (ctx.noDeaths && say && ASK_WHY_RX.test(say) && (ctx.chat || []).some((l) => ASK_WHY_RX.test(l))) {
    const alt = FC.respond({ ...ctx, angle: chance(0.5) ? "whatIDid" : "agreeSkip" }, memory, bs.said, null, st ? st.used : new Set());
    say = mentioned ? (alt.say || "").trim() : (chance(0.5) ? (alt.say || "").trim() : "");
  }
  // Vote: map the name back to a living player id (or skip).
  let vote = "skip";
  if (typeof out.vote === "string" && out.vote.toLowerCase() !== "skip") {
    const hit = Object.entries(room.players).find(([id, p]) => p.alive !== false && id !== botId && p.name.toLowerCase() === out.vote.trim().toLowerCase());
    if (hit && !(ctx.isSab && hit[1].role === "saboteur")) vote = hit[0];
  }
  // [DETECTIVE] the code's read wins on the vote: strong case -> vote it; never vote out someone the facts clear
  if (ctx.read && !ctx.isSab) {
    const idOf = (n) => { const h = Object.entries(room.players).find(([id, p]) => p.alive !== false && id !== botId && p.name === n); return h ? h[0] : null; };
    if (ctx.read.voteFor && vote === "skip") vote = idOf(ctx.read.voteFor) || vote;
    if (vote !== "skip" && room.players[vote] && !ctx.read.voteFor && !(ctx.read.liars || []).includes(room.players[vote].name)) {
      const kill = memory.some((m) => m.kind === "kill" && m.name === room.players[vote].name);
      if (!kill) vote = "skip"; // not enough evidence yet
    }
  }
  if (ctx.noDeaths) vote = "skip"; // nobody died: nothing to vote anyone out for
  return { say, vote, source };
}
const ASK_WHY_RX = /(\bwhy\b|\bkyu|\bkyun|क्यों).*(\bcall|\bmeet|\bem\b|\bemergency|\bbula|मीटिंग)|(\bcall|\bmeet|\bem\b|\bemergency|\bbula).*(\bwhy\b|\bkyu)/i;
const NEGATED_SUS_RX = /\b(no|not|nobody|no one|noone|nothing|koi nahi|kisi pe nahi)\b[^.?!]{0,14}\b(sus|suspect|suspicious|kill|kills|killed|shak)/i;
const ACCUSE_RX = /\b(sus|suspect|suspicious|kill|killed|killer|killing|vanish(ed)?|lying|liar|lied|fake|faking|faked|impostor|saboteur|sabo|vote (?!skip)\w+)\b|shak|jhooth|jhoota|maara|संदिग्ध|झूठ/i;

// [$SABOTEUR] Back the vote only with real evidence from memory: saw the
// target kill, or saw them right where a body was found shortly before.
// A saboteur bot sometimes backs its scapegoat to look sure of itself.
function shouldBack(room, botId, targetId, memory) {
  const me = room.players[botId], t = room.players[targetId];
  if (!me || !t) return false;
  if (me.role === "saboteur") return chance(ECON_RULES.saboteurBotBluffChance);
  const mem = memory || [];
  if (mem.some((m) => m.kind === "kill" && m.name === t.name)) return true;
  return mem.some((b) => b.kind === "body" && mem.some((m) => m.kind === "saw" && m.name === t.name && m.where === b.where && m.t <= b.t && b.t - m.t < 45000));
}

// Called every bot tick while room.meeting exists.
function tick(roomCode, room, now, api) {
  const meeting = room.meeting;
  if (!meeting) return;
  const st = stateFor(roomCode, room);
  const botIds = Object.keys(room.players).filter((id) => room.players[id].isBot && room.players[id].alive !== false);
  const mentionOnly = (room.botChatMode || "auto") === "mention";
  if (meeting.stage === "chat" || meeting.stage === "voting") {
    if (!st.chatStartedAt) {
      st.chatStartedAt = now;
      for (const id of botIds) {
        const bs = botState(st, id);
        const mem = api.memoryOf(id);
        const hasNews = id === meeting.calledBy || mem.some((m) => m.kind === "kill" || m.kind === "body");
        bs.hasNews = hasNews;
        const calm = !Object.values(room.players).some((p) => p.alive === false && !p.spectator);
        // People with news speak first (they start "thinking" right away so
        // a slow AI reply still lands early); others chime in later or not at all.
        if ((room.botChatMode || "auto") === "mention") { bs.nextActAt = 0; bs.purpose = "chime"; } // @ only: wait to be tagged
        else if (hasNews) { bs.nextActAt = now; bs.notBefore = now + rand(3000, 7000); bs.purpose = "open"; }
        else if (calm) {
          // Nothing happened: one bot asks the caller, a couple of others add
          // something different, the rest stay quiet unless asked.
          const order = st.calmOrder = (st.calmOrder || 0) + 1;
          bs.calmAngle = order === 1 ? "askCaller" : order === 2 ? pick(["whatIDid", "agreeSkip"]) : (chance(0.4) ? pick(["whatIDid", "agreeSkip", "react"]) : null);
          bs.nextActAt = bs.calmAngle ? now + (order === 1 ? rand(4000, 8000) : rand(14000, 35000)) : 0;
          bs.purpose = "chime";
        }
        else { bs.nextActAt = now + (chance(0.75) ? rand(9000, 30000) : rand(40000, 70000)); bs.purpose = "chime"; }
      }
    }
    const calmMeeting = !Object.values(room.players).some((p) => p.alive === false && !p.spectator);
    for (const id of botIds) {
      const bs = botState(st, id);
      // Deliver a message whose "typing" time is over.
      if (bs.pendingSay && now >= bs.pendingSay.at) {
        if (now - st.lastBotMsgAt >= MIN_GAP_BETWEEN_BOT_MSGS_MS) {
          const text = bs.pendingSay.text;
          bs.pendingSay = null;
          if (st.used.has(FC.norm(text))) continue; // never repeat a line in the same meeting
          const res = api.postMeetingChat(roomCode, id, text, null, null);
          if (res && res.senderId) {
            bs.said.push(text);
            st.used.add(FC.norm(text));
            st.botLines.push(text);
            st.lastBotMsgAt = now;
          }
        } else {
          bs.pendingSay.at = now + rand(800, 2000);
        }
        continue;
      }
      if (bs.busy || bs.pendingSay || !bs.nextActAt || now < bs.nextActAt) continue;
      // @ only mode (or the voting window): only answer when tagged.
      if ((mentionOnly || meeting.stage === "voting") && bs.purpose !== "reply") { bs.nextActAt = 0; continue; }
      if (bs.said.length >= MAX_MSGS_PER_BOT || (bs.said.length >= (calmMeeting ? 1 : 2) && bs.purpose !== "reply")) { bs.nextActAt = 0; continue; }
      bs.busy = true;
      bs.nextActAt = 0;
      const purpose = bs.purpose || "chime";
      bs.purpose = "chime";
      const mem = api.memoryOf(id);
      const startedAt = Date.now();
      // Slow AI while someone is waiting on us: say a quick filler first.
      const filler = purpose === "reply" && !bs.usedFiller && chance(0.5) ? setTimeout(() => {
        if (!bs.busy || room.meeting !== st.meetingRef || meeting.stage !== "chat") return;
        bs.usedFiller = true;
        const lang = detectLanguage((meeting.messages || []).filter((m) => room.players[m.senderId] && !room.players[m.senderId].isBot).map((m) => m.text));
        const text = lang === "hinglish" ? pick(["ek sec", "ruko yaad kar raha", "hmm wait"]) : lang === "hindi" ? pick(["एक सेकंड", "रुको"]) : pick(["hmm 1 sec", "wait let me think", "uhh"]);
        const res = api.postMeetingChat(roomCode, id, text, null, null);
        if (res && res.senderId) { bs.said.push(text); st.lastBotMsgAt = Date.now(); }
      }, SLOW_REPLY_FILLER_MS) : null;
      think(room, roomCode, id, mem, bs, now, st, purpose).then(({ say, vote, source }) => {
        if (filler) clearTimeout(filler);
        bs.busy = false;
        if (room.meeting !== st.meetingRef) return; // meeting over
        bs.vote = vote;
        if (say && (room.meeting.stage === "chat" || room.meeting.stage === "voting")) {
          // If the AI was slow, "type" faster - the thinking time already passed.
          // [HUMAN PACE] the clock started when the bot "read" the chat; AI think-time counts toward it
          const typingMs = humanTypingMs(say);
          bs.pendingSay = { text: say, at: Math.max(startedAt + typingMs, Date.now() + 1200, bs.notBefore || 0) };
          if (api.emitTyping) api.emitTyping(roomCode, id, Math.max(800, bs.pendingSay.at - Date.now()));
          console.log(`[BOTS-AI] ${room.players[id] && room.players[id].name} (${source}): "${say}" -> vote ${vote === "skip" ? "skip" : (room.players[vote] || {}).name}`);
        }
      }).catch((e) => { bs.busy = false; console.warn("[BOTS-AI] think error:", e.message); });
    }
    // Skip discussion only if a human already wants to (bots never cut a
    // human's discussion short on their own).
    const humanSkip = meeting.stage === "chat" && Object.keys(meeting.skipDiscussionVotes || {}).some((id) => room.players[id] && !room.players[id].isBot);
    if (humanSkip) {
      for (const id of botIds) {
        const bs = botState(st, id);
        if (!bs.skipped && !bs.busy && !bs.pendingSay && chance(0.08)) { bs.skipped = true; api.voteSkipDiscussion(roomCode, id); }
      }
    }
  }
  if (meeting.stage === "voting") {
    if (!st.votingStartedAt) {
      st.votingStartedAt = now;
      for (const id of botIds) botState(st, id).voteAt = now + rand(3000, 15000);
    }
    const humansAlive = Object.entries(room.players).filter(([, p]) => !p.isBot && p.alive !== false).map(([id]) => id);
    const humansDone = humansAlive.every((id) => meeting.votes[id]);
    for (const id of botIds) {
      const bs = botState(st, id);
      if (bs.voted || bs.busy || meeting.votes[id]) continue;
      if (now < bs.voteAt && !(humansDone && now > bs.voteAt - 10000)) continue;
      // Never spoke? Decide quietly now.
      if (!bs.vote) {
        bs.busy = true;
        think(room, roomCode, id, api.memoryOf(id), bs, now, st, "vote").then(({ vote }) => { bs.busy = false; bs.vote = vote || "skip"; }).catch(() => { bs.busy = false; bs.vote = "skip"; });
        continue;
      }
      bs.voted = true;
      const target = bs.vote !== "skip" && room.players[bs.vote] && room.players[bs.vote].alive !== false ? bs.vote : "skip";
      api.castMeetingVote(roomCode, id, target, target !== "skip" && shouldBack(room, id, target, api.memoryOf(id)));
    }
  }
}

// A chat message was posted (by anyone). Bots that were named or asked
// something get a turn soon; others may chime in.
function onChat(roomCode, room, message) {
  if (!room.meeting) return;
  const st = stateFor(roomCode, room);
  const fromBot = room.players[message.senderId] && room.players[message.senderId].isBot;
  const text = (message.text || "").toLowerCase();
  const isQuestion = /\?|\bkya\b|\bkaun\b|\bkon\b|\bwhere\b|\bwho\b|\bkahan\b|\bkidhar\b|कौन|कहाँ|क्या/.test(text);
  const now = Date.now();
  const mentionOnly = (room.botChatMode || "auto") === "mention";
  const calm = !Object.values(room.players).some((p) => p.alive === false && !p.spectator);
  for (const [id, p] of Object.entries(room.players)) {
    if (!p.isBot || p.alive === false || id === message.senderId) continue;
    const bs = botState(st, id);
    if (bs.said.length >= MAX_MSGS_PER_BOT || bs.busy || bs.pendingSay) continue;
    // [REALISM] Bot-to-bot: no reply chains in a quiet meeting, and at most
    // one answer to another bot otherwise.
    if (fromBot && (calm || bs.answeredBot)) continue;
    const tagged = new RegExp(`@${p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(message.text || "");
    const named = tagged || (!mentionOnly && text.includes(p.name.toLowerCase()));
    if (mentionOnly && !tagged) continue;
    if (named) {
      if (fromBot) { if (!chance(0.6)) continue; bs.answeredBot = true; }
      bs.mentioned = true;
      bs.purpose = "reply";
      bs.trigger = { text: message.text || "", fromName: message.senderName };
      bs.nextActAt = now + rand(2500, 5500); // [HUMAN PACE] read + think before typing
    } else if (!fromBot && (isQuestion ? chance(0.45) : chance(0.25))) {
      bs.trigger = { text: message.text || "", fromName: message.senderName };
      if (!bs.nextActAt || bs.nextActAt > now + 14000) bs.nextActAt = now + rand(5000, 13000);
    } else if (fromBot && chance(0.12)) {
      if (!bs.nextActAt) bs.nextActAt = now + rand(6000, 14000);
    }
  }
}

// [SELF-IMPROVEMENT] After a match: turn the meeting chat + the truth into a
// couple of general tips (see lessons.js). One AI call per match, only when
// humans actually talked.
async function learnFromMatch(room) {
  try {
    const msgs = (room.matchChat || []).filter((e) => e.kind === "msg" && e.text);
    const humanMsgs = msgs.filter((e) => room.players[e.senderId] && !room.players[e.senderId].isBot);
    const hasBots = Object.values(room.players).some((p) => p.isBot);
    if (!hasBots || humanMsgs.length < 3 || !room.winner || room.winner === "devEnded") return;
    if (!aiAllowed(null)) return;
    const sabs = Object.values(room.players).filter((p) => p.role === "saboteur").map((p) => p.name);
    const transcript = (room.matchChat || []).filter((e) => e.kind === "msg" || e.kind === "sep").slice(-80)
      .map((e) => e.kind === "sep" ? `-- meeting ${e.meetingNo}: ${e.bodyName ? `${e.callerName} reported ${e.bodyName}` : `${e.callerName} called it`} --` : `${e.senderName}${room.players[e.senderId] && room.players[e.senderId].isBot ? " (bot)" : ""}: ${String(e.text).slice(0, 160)}`).join("\n");
    const system = "You coach AI players of a social deduction game (crew vs hidden saboteurs; meetings to discuss and vote). Read one finished game and write short GENERAL lessons that would make the AI players think and talk more like good human players next time. Rules: no player names, no room names, no numbers, no specific events - only reusable advice, max 22 words each. Answer only JSON: {\"crew\": [\"...\"], \"saboteur\": [\"...\"]} with 0-2 items each. Skip anything obvious or already standard.";
    // Ground truth the coach must learn from: who accused whom, and were they right?
    const sabSet = new Set(sabs.map((n) => n.toLowerCase()));
    const verdicts = [];
    for (const e of msgs) {
      const sender = room.players[e.senderId];
      if (!sender || !ACCUSE_WORDS.test(e.text)) continue;
      for (const p of Object.values(room.players)) {
        if (p === sender || !new RegExp(`\\b${p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(e.text)) continue;
        const v = `${sender.name}${sender.isBot ? " (bot)" : ""} accused ${p.name} -> ${sabSet.has(p.name.toLowerCase()) ? "RIGHT, " + p.name + " WAS a saboteur" : "WRONG, " + p.name + " was crew"}`;
        if (!verdicts.includes(v)) verdicts.push(v);
      }
    }
    const lost = room.winner === "saboteur" ? "crew" : "saboteur";
    const user = `TRUTH: the saboteur${sabs.length > 1 ? "s were" : " was"} ${sabs.join(", ")}. ${room.winner === "saboteur" ? "SABOTEURS WON - the crew lost." : "CREW WON - the saboteurs lost."}\n${verdicts.length ? `Accusations and whether they were right:\n${verdicts.join("\n")}\n` : ""}\nMeeting chat:\n${transcript}\n\nUsing the truth above (not how convincing people sounded): what mistakes did the ${lost} side's AI bots make, and what did the winners do well? Write lessons that would make the AI crew catch saboteurs more often and the AI saboteurs blend in better. Judge testimony by the truth: if a correct, specific accusation was ignored, the lesson is how to recognise believable testimony; if a false accusation was followed, the lesson is how to spot a liar. Never conclude that testimony should simply be ignored or simply be trusted.`;
    const out = await callNearAI(system, user);
    const banned = [...Object.values(room.players).map((p) => p.name), ...Object.values(B.ROOM_NAME || {}), "near", "ironclaw", "legion"];
    const a = await LESSONS.save("crew", Array.isArray(out.crew) ? out.crew : [], banned);
    const b = await LESSONS.save("saboteur", Array.isArray(out.saboteur) ? out.saboteur : [], banned);
    if (a || b) console.log(`[BOTS-LEARN] saved ${a} crew + ${b} saboteur tip(s) from a finished match`);
  } catch (e) { console.warn("[BOTS-LEARN] skipped:", e.message); }
}

function aiStats() { rollDay(); return { ...stats, spendUsd: Math.round(stats.spendUsd * 10000) / 10000, budgetUsd: DAILY_BUDGET_USD, model: API_KEY ? MODEL : null }; }
function aiStatus() {
  return API_KEY ? `NEAR AI Cloud (${MODEL})` : "rule-based fallback (set NEAR_AI_API_KEY to use NEAR AI Cloud)";
}

module.exports = { tick, onChat, aiStatus, aiStats, detectLanguage, learnFromMatch, _internal: { fallbackThink, buildContext, systemPrompt, userPrompt, memoryLines } };
