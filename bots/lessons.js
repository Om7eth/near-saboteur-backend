// ============================================================
// [AI BOTS - SELF-IMPROVEMENT] Bots learn from finished matches, with no
// manual work.
//
// After a match with real human chat, the model reads the meeting chat plus
// the truth (who the saboteurs were, who won) and writes a couple of short,
// GENERAL play tips - e.g. "When a player says they saw someone run from a
// body and nobody contradicts it, crewmates should back them."
//
// Rules that keep old matches out of new ones:
//  - A tip may never contain a player name, a room name or any number; tips
//    that do are thrown away (checked in code, not just asked for).
//  - Tips are stored without any match id / player id.
//  - The meeting prompt says these are general tips and must never be
//    mentioned or referred to as past events.
//
// Tips that keep coming back gain weight; the strongest few are used.
// ============================================================
const mongoose = require("mongoose");

const lessonSchema = new mongoose.Schema({
  role: { type: String, enum: ["crew", "saboteur"], index: true },
  text: String,
  key: { type: String, unique: true },   // normalized text, to merge repeats
  weight: { type: Number, default: 1 },
  createdAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
});
const BotLesson = mongoose.models.BotLesson || mongoose.model("BotLesson", lessonSchema);

const MAX_PER_ROLE = 30;  // stored
const USE_PER_ROLE = 6;   // put in the prompt
let cache = { at: 0, crew: [], saboteur: [] };

const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

// Throw away anything tied to a specific match.
function isGeneric(text, banned) {
  const t = String(text || "");
  if (!t || t.length < 12 || t.length > 160) return false;
  if (/\d/.test(t)) return false;
  const low = t.toLowerCase();
  return !banned.some((w) => w && w.length >= 3 && low.includes(w.toLowerCase()));
}

async function save(role, texts, banned) {
  let added = 0;
  for (const raw of texts || []) {
    const text = String(raw || "").trim().replace(/^[-*\d.\s]+/, "");
    if (!isGeneric(text, banned)) continue;
    const key = `${role}:${norm(text)}`;
    try {
      await BotLesson.updateOne({ key }, { $setOnInsert: { role, text, key, createdAt: new Date() }, $inc: { weight: 1 }, $set: { lastSeenAt: new Date() } }, { upsert: true });
      added++;
    } catch (e) { /* duplicate race - fine */ }
  }
  // Keep the list small: drop the weakest, oldest tips.
  const n = await BotLesson.countDocuments({ role });
  if (n > MAX_PER_ROLE) {
    const extra = await BotLesson.find({ role }).sort({ weight: 1, lastSeenAt: 1 }).limit(n - MAX_PER_ROLE).select("_id").lean();
    await BotLesson.deleteMany({ _id: { $in: extra.map((x) => x._id) } });
  }
  cache.at = 0;
  return added;
}

async function forPrompt(role) {
  if (Date.now() - cache.at > 10 * 60 * 1000) {
    try {
      const [crew, saboteur] = await Promise.all([
        BotLesson.find({ role: "crew" }).sort({ weight: -1, lastSeenAt: -1 }).limit(USE_PER_ROLE).lean(),
        BotLesson.find({ role: "saboteur" }).sort({ weight: -1, lastSeenAt: -1 }).limit(USE_PER_ROLE).lean(),
      ]);
      cache = { at: Date.now(), crew: crew.map((l) => l.text), saboteur: saboteur.map((l) => l.text) };
    } catch (e) { cache.at = Date.now(); }
  }
  return role === "saboteur" ? cache.saboteur : cache.crew;
}
// Sync read for prompt building (warm cache in the background).
function cached(role) {
  if (Date.now() - cache.at > 10 * 60 * 1000) forPrompt(role).catch(() => {});
  return role === "saboteur" ? cache.saboteur : cache.crew;
}

module.exports = { save, forPrompt, cached, isGeneric, BotLesson };
