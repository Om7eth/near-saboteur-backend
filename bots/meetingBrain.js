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
//   NEAR_AI_MODEL     - default "z-ai/glm-5.3-flash" (verifiable/TEE model)
//   NEAR_AI_BASE_URL  - default "https://cloud-api.near.ai/v1"
// ============================================================
const B = require("./brain");

const API_KEY = process.env.NEAR_AI_API_KEY || "";
const MODEL = process.env.NEAR_AI_MODEL || "z-ai/glm-5.3-flash";
const BASE_URL = (process.env.NEAR_AI_BASE_URL || "https://cloud-api.near.ai/v1").replace(/\/$/, "");
const AI_TIMEOUT_MS = 12000;
const MAX_MSGS_PER_BOT = 4;
const MIN_GAP_BETWEEN_BOT_MSGS_MS = 2500;
const MAX_AI_CALLS_PER_MINUTE = 60; // global safety cap on spend

const rooms = new Map(); // roomCode -> meeting state
let aiCallTimes = [];

const rand = B.rand;
const chance = B.chance;

// ---- Language ---------------------------------------------------------
const HINGLISH_WORDS = new Set(["hai", "hain", "nahi", "nhi", "kya", "kyu", "kyun", "bhai", "mai", "main", "mein", "tha", "thi", "dekha", "kaha", "kaun", "kon", "tum", "tu", "mera", "tera", "aur", "koi", "abhi", "yaar", "haan", "ha", "kar", "raha", "rha", "wala", "isko", "usko", "pe", "se", "ko", "toh", "to", "bol", "bata", "sab", "kidhar", "idhar", "udhar", "sus"]);
function detectLanguage(texts) {
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
function aiAllowed() {
  if (!API_KEY) return false;
  const now = Date.now();
  aiCallTimes = aiCallTimes.filter((t) => now - t < 60000);
  if (aiCallTimes.length >= MAX_AI_CALLS_PER_MINUTE) return false;
  aiCallTimes.push(now);
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
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error("empty completion");
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
  const alive = Object.entries(room.players).filter(([, p]) => p.alive !== false);
  const dead = Object.entries(room.players).filter(([, p]) => p.alive === false);
  const caller = room.players[meeting.calledBy];
  const body = meeting.reportedBodyId && room.players[meeting.reportedBodyId];
  const chat = (meeting.messages || []).slice(-15).map((m) => `${m.senderName}${room.players[m.senderId] && room.players[m.senderId].isBot ? " (bot)" : ""}: ${m.text}`);
  const humanTexts = (meeting.messages || []).filter((m) => room.players[m.senderId] && !room.players[m.senderId].isBot).map((m) => m.text);
  const teammates = isSab ? alive.filter(([id, p]) => id !== botId && p.role === "saboteur").map(([, p]) => p.name) : [];
  return {
    me, isSab, alive, dead, caller, body, chat, humanTexts, teammates,
    language: detectLanguage(humanTexts),
    memory: memoryLines(memory, now, isSab),
    reason: meeting.reason === "report" ? `${caller ? caller.name : "Someone"} reported ${body ? body.name + "'s" : "a"} dead body${body && typeof body.bodyX === "number" ? " in " + B.roomNameAt(body.bodyX, body.bodyY) : ""}` : `${caller ? caller.name : "Someone"} called an emergency meeting`,
  };
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
    : "You are CREW. Tell the truth about what you remember. You may be unsure - say so. If you saw a kill, say it clearly. If you have nothing solid, ask questions or vote skip.";
  return [
    `You are "${ctx.me.name}", a player in NEAR Saboteur, a social deduction game: crew do missions on a space station, one or two hidden saboteurs kill people. Everyone is now in a meeting to discuss and vote someone out.`,
    "Your name is shown with a BOT tag, so everyone knows you are an AI bot. If asked, admit you're a bot - but you still play to win like anyone else.",
    role,
    `Personality: ${personaFor(ctx.me.name)}.`,
    "Write like a real player in a fast game chat: ONE short message (max ~18 words), no lists, no narration, no quotes, react to what others just said, use player names. It's fine to stay silent if you have nothing useful.",
    lang,
    'Answer ONLY with JSON: {"say": "<your chat message, or empty string to stay silent>", "vote": "<exact name of a living player, or skip>", "suspect": "<name or none>"}',
  ].join("\n");
}
function userPrompt(ctx, alreadySaid) {
  return [
    `Meeting: ${ctx.reason}.`,
    `Alive: ${ctx.alive.map(([, p]) => p.name + (p === ctx.me ? " (you)" : "")).join(", ")}.`,
    ctx.dead.length ? `Dead: ${ctx.dead.map(([, p]) => p.name).join(", ")}.` : "Nobody else is dead.",
    "",
    "What you remember (only you know this):",
    ...(ctx.memory.length ? ctx.memory : ["(nothing notable - you were doing your own thing)"]),
    "",
    "Chat so far:",
    ...(ctx.chat.length ? ctx.chat : ["(no messages yet)"]),
    alreadySaid.length ? `\nYou already said: ${alreadySaid.map((t) => `"${t}"`).join(" ")} - don't repeat yourself.` : "",
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
    st = { meetingRef: room.meeting, bots: {}, lastBotMsgAt: 0, chatStartedAt: 0 };
    rooms.set(roomCode, st);
  }
  return st;
}
function botState(st, id) {
  if (!st.bots[id]) st.bots[id] = { said: [], nextActAt: 0, busy: false, vote: null, voted: false, pendingSay: null, mentioned: false, skipped: false };
  return st.bots[id];
}

async function think(room, roomCode, botId, memory, bs, now) {
  const ctx = buildContext(room, botId, memory, now);
  const mentioned = bs.mentioned;
  bs.mentioned = false;
  let out = null, source = "fallback";
  if (aiAllowed()) {
    try {
      out = await callNearAI(systemPrompt(ctx), userPrompt(ctx, bs.said));
      source = "near-ai";
    } catch (e) {
      console.warn(`[BOTS-AI] ${ctx.me.name}: NEAR AI call failed (${e.message}) - using fallback`);
    }
  }
  if (!out || typeof out !== "object") out = fallbackThink(ctx, memory, bs.said, mentioned);
  let say = typeof out.say === "string" ? out.say.trim() : "";
  // Models sometimes prefix their own name ("Nova: ...") or wrap in quotes.
  const esc = ctx.me.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  say = say.replace(new RegExp(`^\\s*${esc}\\s*(\\(bot\\))?\\s*[:\\-]\\s*`, "i"), "").replace(/^["']+|["']+$/g, "").trim().slice(0, 200);
  // Vote: map the name back to a living player id (or skip).
  let vote = "skip";
  if (typeof out.vote === "string" && out.vote.toLowerCase() !== "skip") {
    const hit = Object.entries(room.players).find(([id, p]) => p.alive !== false && id !== botId && p.name.toLowerCase() === out.vote.trim().toLowerCase());
    if (hit && !(ctx.isSab && hit[1].role === "saboteur")) vote = hit[0];
  }
  return { say, vote, source };
}

// Called every bot tick while room.meeting exists.
function tick(roomCode, room, now, api) {
  const meeting = room.meeting;
  if (!meeting) return;
  const st = stateFor(roomCode, room);
  const botIds = Object.keys(room.players).filter((id) => room.players[id].isBot && room.players[id].alive !== false);
  if (meeting.stage === "chat") {
    if (!st.chatStartedAt) {
      st.chatStartedAt = now;
      for (const id of botIds) {
        const bs = botState(st, id);
        const mem = api.memoryOf(id);
        const hasNews = id === meeting.calledBy || mem.some((m) => m.kind === "kill" || m.kind === "body");
        // People with news speak first; others chime in later (or not at all).
        bs.nextActAt = now + (hasNews ? rand(3000, 7000) : (chance(0.75) ? rand(9000, 30000) : rand(40000, 70000)));
      }
    }
    for (const id of botIds) {
      const bs = botState(st, id);
      // Deliver a message whose "typing" time is over.
      if (bs.pendingSay && now >= bs.pendingSay.at) {
        if (now - st.lastBotMsgAt >= MIN_GAP_BETWEEN_BOT_MSGS_MS) {
          const text = bs.pendingSay.text;
          bs.pendingSay = null;
          const res = api.postMeetingChat(roomCode, id, text, null, null);
          if (res && res.senderId) {
            bs.said.push(text);
            st.lastBotMsgAt = now;
          }
        } else {
          bs.pendingSay.at = now + rand(800, 2000);
        }
        continue;
      }
      if (bs.busy || bs.pendingSay || !bs.nextActAt || now < bs.nextActAt) continue;
      if (bs.said.length >= MAX_MSGS_PER_BOT) { bs.nextActAt = 0; continue; }
      bs.busy = true;
      bs.nextActAt = 0;
      const mem = api.memoryOf(id);
      think(room, roomCode, id, mem, bs, now).then(({ say, vote, source }) => {
        bs.busy = false;
        if (room.meeting !== st.meetingRef) return; // meeting over
        bs.vote = vote;
        if (say) {
          const typingMs = Math.min(7000, 1200 + say.length * 45);
          bs.pendingSay = { text: say, at: Date.now() + typingMs };
          console.log(`[BOTS-AI] ${room.players[id] && room.players[id].name} (${source}): "${say}" -> vote ${vote === "skip" ? "skip" : (room.players[vote] || {}).name}`);
        }
      }).catch((e) => { bs.busy = false; console.warn("[BOTS-AI] think error:", e.message); });
    }
    // Skip discussion only if a human already wants to (bots never cut a
    // human's discussion short on their own).
    const humanSkip = Object.keys(meeting.skipDiscussionVotes || {}).some((id) => room.players[id] && !room.players[id].isBot);
    if (humanSkip) {
      for (const id of botIds) {
        const bs = botState(st, id);
        if (!bs.skipped && !bs.busy && !bs.pendingSay && chance(0.08)) { bs.skipped = true; api.voteSkipDiscussion(roomCode, id); }
      }
    }
    return;
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
        think(room, roomCode, id, api.memoryOf(id), bs, now).then(({ vote }) => { bs.busy = false; bs.vote = vote || "skip"; }).catch(() => { bs.busy = false; bs.vote = "skip"; });
        continue;
      }
      bs.voted = true;
      const target = bs.vote !== "skip" && room.players[bs.vote] && room.players[bs.vote].alive !== false ? bs.vote : "skip";
      api.castMeetingVote(roomCode, id, target);
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
  for (const [id, p] of Object.entries(room.players)) {
    if (!p.isBot || p.alive === false || id === message.senderId) continue;
    const bs = botState(st, id);
    if (bs.said.length >= MAX_MSGS_PER_BOT || bs.busy || bs.pendingSay) continue;
    const named = text.includes(p.name.toLowerCase());
    if (named) {
      bs.mentioned = true;
      bs.nextActAt = now + rand(1500, 4000);
    } else if (!fromBot && (isQuestion ? chance(0.45) : chance(0.25))) {
      if (!bs.nextActAt || bs.nextActAt > now + 12000) bs.nextActAt = now + rand(4000, 11000);
    } else if (fromBot && chance(0.12)) {
      if (!bs.nextActAt) bs.nextActAt = now + rand(6000, 14000);
    }
  }
}

function aiStatus() {
  return API_KEY ? `NEAR AI Cloud (${MODEL})` : "rule-based fallback (set NEAR_AI_API_KEY to use NEAR AI Cloud)";
}

module.exports = { tick, onChat, aiStatus, detectLanguage, _internal: { fallbackThink, buildContext, systemPrompt, userPrompt, memoryLines } };
