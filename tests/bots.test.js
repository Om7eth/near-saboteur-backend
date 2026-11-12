// AI bot detective rules: who do crew bots suspect and vote for?
// Run: npm test   (no database, no keys, no network needed)
const test = require("node:test");
const assert = require("node:assert");
delete process.env.NEAR_AI_API_KEY; // rule-based path only
const MB = require("../bots/meetingBrain.js");

const now = Date.now();
const room = (extra = {}) => ({
  code: "T", saboteurCountStart: 1, ejections: [], matchChat: [],
  players: {
    b1: { name: "Nonce", isBot: true, role: "crewmate", alive: true },
    b2: { name: "Beacon", isBot: true, role: "saboteur", alive: true },
    b3: { name: "Glitch", isBot: true, role: "crewmate", alive: true },
    h1: { name: "Mf", role: "crewmate", alive: false },
    ...extra,
  },
  meeting: { messages: [], startedAt: now, reportedBodyId: "h1", calledBy: "b1" },
});
const twoMore = { h2: { name: "Ria", role: "crewmate", alive: true }, h3: { name: "Sam", role: "crewmate", alive: true } };
const body = { kind: "body", name: "Mf", where: "Security", t: now - 2000 };
const read = (mem, r = room(twoMore)) => MB._internal.buildContext(r, "b1", mem, now).read;

test("the player standing right next to the body is the suspect, not everyone nearby", () => {
  const r = read([body,
    { kind: "at-body", name: "Beacon", victim: "Mf", where: "Security", dist: 1.2, away: true, t: now - 2000 },
    { kind: "at-body", name: "Glitch", victim: "Mf", where: "Security", dist: 4.5, away: false, t: now - 2000 }]);
  assert.strictEqual(r.voteFor, "Beacon");
});

test("just being in the same room is not enough to vote anyone", () => {
  const r = read([{ kind: "saw", name: "Beacon", where: "Security", t: now - 9000 }, { kind: "saw", name: "Glitch", where: "Security", t: now - 9000 }, body]);
  assert.strictEqual(r.voteFor, null);
});

test("two people equally close to the body: no guess", () => {
  const r = read([body,
    { kind: "at-body", name: "Beacon", victim: "Mf", where: "Security", dist: 1.0, t: now - 2000 },
    { kind: "at-body", name: "Glitch", victim: "Mf", where: "Security", dist: 1.5, t: now - 2000 }]);
  assert.strictEqual(r.voteFor, null);
});

test("someone who walked away from the body without reporting is suspected", () => {
  const r = read([{ kind: "saw", name: "Beacon", where: "Security", t: now - 9000 },
    { kind: "at-body", name: "Beacon", victim: "Mf", where: "Security", dist: 3.8, t: now - 8000 },
    { kind: "fled", name: "Beacon", victim: "Mf", from: "Security", to: "Cafe", t: now - 5000 }, body]);
  assert.strictEqual(r.voteFor, "Beacon");
});

test("the last person seen alone with the victim is suspected", () => {
  const r = read([{ kind: "saw", name: "Mf", where: "Vault", with: ["Beacon"], t: now - 40000 }, body]);
  assert.strictEqual(r.voteFor, "Beacon");
});

test("an alibi clears a player", () => {
  const r = read([{ kind: "saw", name: "Glitch", where: "Cafe", t: now - 6000 }, body]);
  assert.notStrictEqual(r.voteFor, "Glitch");
});

test("endgame: with 3 alive, a crew bot never skips (skipping would hand the saboteur the win)", async () => {
  const r = room();
  const mem = [{ kind: "body", name: "Mf", where: "Security", t: now - 1000 }, { kind: "saw", name: "Beacon", where: "Security", t: now - 60000 }];
  const out = await MB._internal.think(r, "T", "b1", mem, { said: ["x"] }, now, { aiCalls: 0, used: new Set(), botLines: [] }, "vote");
  assert.notStrictEqual(out.vote, "skip");
});

test("no deaths yet: bots never vote anyone out", async () => {
  const r = room(); r.players.h1.alive = true; r.meeting = { messages: [], startedAt: now, calledBy: "b3" };
  const out = await MB._internal.think(r, "T", "b1", [], { said: ["x"] }, now, { aiCalls: 0, used: new Set(), botLines: [] }, "vote");
  assert.strictEqual(out.vote, "skip");
});
