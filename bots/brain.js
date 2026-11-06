// ============================================================
// [AI BOTS - NEAR HACKATHON] Bot perception, memory and decisions.
//
// FAIRNESS RULE: a bot only ever knows what a human standing in the same
// spot could know. It sees other players only within the normal vision
// radius (smaller when the lights are cut), never through walls, and only
// sees far-away rooms by standing at the Security Hub and watching the
// same 4 camera feeds humans get. Nothing here reads hidden server state
// such as roles - a crew bot does not know who the Saboteur is unless it
// actually saw something.
//
// botManager.js owns movement; this file decides WHERE to go and WHAT to
// do there, and keeps the memory that meeting chat (Day 4) will use.
// ============================================================
const crypto = require("crypto");
const M = require("./mapData");
const P = require("./pathfinding");

const T = M.TILE;
const HALF = M.PLAYER_SIZE / 2;
const rand = (a, b) => a + (crypto.randomInt(0, 1_000_000) / 1_000_000) * (b - a);
const chance = (p) => rand(0, 1) < p;
const pick = (arr) => arr[crypto.randomInt(0, arr.length)];

// ---- Mission stations (same trigger zones as nearbyTaskPoint in game.jsx)
const STATION_KEYS = {
  cafeteria: ["ASSEMBLY_BTN", "ASSEMBLY_RANGE"], medbay: ["VERIFY_POD", "VERIFY_RANGE"],
  security: ["SECURITY_HUB", "SECURITY_RANGE"], reactor: ["VAULT_POD", "VAULT_RANGE"],
  upper_eng: ["STAKING_POD", "STAKING_RANGE"], lower_eng: ["CLAIM_POD", "CLAIM_RANGE"],
  electrical: ["ELEC_POD", "ELEC_RANGE"], storage: ["NEARAI_POD", "NEARAI_RANGE"],
  comms: ["NEARMERCH_POD", "NEARMERCH_RANGE"], o2: ["IRONCLAW_POD", "IRONCLAW_RANGE"],
  admin: ["LEGION_POD", "LEGION_RANGE"], shields: ["EXCHANGE_POD", "EXCHANGE_RANGE"],
  weapons: ["MEME_POD", "MEME_RANGE"], navigation: ["CYBER_POD", "CYBER_RANGE"],
};
// Spots (player top-left px) where a bot can stand and still be inside the
// station's trigger zone - precomputed once.
const STATION_SPOTS = {};
for (const [roomId, [podKey, rangeKey]] of Object.entries(STATION_KEYS)) {
  const pod = M[podKey], range = M[rangeKey];
  const cx = (pod.x + 0.5) * T, cy = (pod.y + 0.5) * T;
  const spots = [];
  for (const f of [0.45, 0.6, 0.75, 0.88]) {
    for (let a = 0; a < 360; a += 20) {
      const px = cx + Math.cos((a * Math.PI) / 180) * range * f - HALF;
      const py = cy + Math.sin((a * Math.PI) / 180) * range * f - HALF;
      if (P.canStand(px, py, null)) spots.push({ x: px, y: py });
    }
  }
  STATION_SPOTS[roomId] = { cx, cy, range, spots };
}
// Rooms a crew bot can be assigned missions in - the same list humans
// draw from (MISSION_DEFS minus the compulsory wallet-balance mission,
// which needs a real in-game wallet).
const MISSION_ROOMS = M.MISSION_DEFS.map((m) => m.room).filter((r) => r !== "wallet_balance" && STATION_SPOTS[r]);
const MISSION_LABEL = Object.fromEntries(M.MISSION_DEFS.map((m) => [m.room, m.label]));
const ROOM_NAME = { cafeteria: "Assembly Hall", medbay: "Verification Center", security: "Security", reactor: "Confidential Vault", upper_eng: "Staking Vault", lower_eng: "Claim Vault", storage: "Near AI", comms: "Near Merch Store", o2: "Ironclaw Hub", admin: "Legion Hub", shields: "Exchange Hub", weapons: "Meme Market", navigation: "Cyber Defense Center", electrical: "Electrical" };
const roomNameAt = (x, y) => { const r = P.roomAtPixel(x, y); return r ? (ROOM_NAME[r.id] || r.name) : "a corridor"; };

// ---- Vision -----------------------------------------------------------
const center = (p) => ({ x: p.x + HALF, y: p.y + HALF });
const blocksSight = (ch) => ch === "#" || ch === " ";
function lineOfSight(a, b) {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(d / 6));
  for (let k = 1; k < n; k++) {
    const t = k / n;
    if (blocksSight(P.tileAt(Math.floor((a.x + (b.x - a.x) * t) / T), Math.floor((a.y + (b.y - a.y) * t) / T)))) return false;
  }
  return true;
}
function visionPx(room, observer) {
  const cut = room.activeSabotageType === "electricity" && observer.role !== "saboteur";
  return (cut ? M.VISION_RADIUS_SABOTAGED : M.VISION_RADIUS_TILES) * T;
}
function canSeePoint(room, observer, pt) {
  const o = center(observer);
  return Math.hypot(pt.x - o.x, pt.y - o.y) <= visionPx(room, observer) && lineOfSight(o, pt);
}
function canSee(room, observer, target) {
  if (typeof target.x !== "number") return false;
  return canSeePoint(room, observer, center(target));
}
// Is a world point inside one of the Security Hub camera feeds?
function cameraFor(pt) {
  for (const c of M.CAMERAS) {
    if (Math.abs(pt.x / T - c.cx) <= c.radius && Math.abs(pt.y / T - c.cy) <= c.radius) return c;
  }
  return null;
}

// ---- Memory -------------------------------------------------------------
const MEMORY_MAX = 120;
function remember(brain, entry) {
  brain.memory.push({ t: Date.now(), ...entry });
  if (brain.memory.length > MEMORY_MAX) brain.memory.splice(0, brain.memory.length - MEMORY_MAX);
}

// ---- Setup on game start ------------------------------------------------
function setupForGame(room, id, p, brain, now) {
  brain.memory = [];
  brain.lastSeen = {};
  brain.reported = new Set();
  brain.pendingBody = null;
  brain.mode = "idle";
  brain.target = null;
  brain.watchUntil = 0;
  brain.workUntil = 0;
  brain.gameStartedAt = now;
  const shuffled = [...MISSION_ROOMS].sort(() => rand(-1, 1));
  brain.tasks = shuffled.slice(0, Math.min(M.MISSIONS_ASSIGNED_COUNT, shuffled.length)).map((r) => ({ room: r, done: false }));
  if (p.role === "crewmate") {
    p.missionsTotal = brain.tasks.length;
    p.missionsDone = 0;
    p.missionsList = brain.tasks.map((t) => ({ room: t.room, label: MISSION_LABEL[t.room], done: false }));
  }
  // Saboteur pacing: don't strike the instant the cooldown ends.
  brain.killPatienceUntil = now + rand(25000, 45000);
  brain.nextSabotageAt = now + rand(40000, 80000);
}

// Ids of other living players this bot can currently see.
function visiblePlayers(room, id, p) {
  const out = [];
  for (const [oid, o] of Object.entries(room.players)) {
    if (oid === id || o.alive === false || o.inVent) continue;
    if (canSee(room, p, o)) out.push(oid);
  }
  return out;
}

// Called every few ticks: update memory with what this bot can see.
function perceive(room, id, p, brain, now) {
  const seen = visiblePlayers(room, id, p);
  const here = roomNameAt(p.x, p.y);
  for (const oid of seen) {
    const last = brain.lastSeen[oid] || 0;
    if (now - last > 6000) {
      const o = room.players[oid];
      remember(brain, { kind: "saw", who: oid, name: o.name, where: roomNameAt(o.x, o.y), with: seen.filter((x) => x !== oid).map((x) => room.players[x].name), via: "eyes" });
    }
    brain.lastSeen[oid] = now;
  }
  // Watching cameras at the Security Hub: same feeds a human gets.
  if (brain.mode === "cameras" && brain.watchUntil > now) {
    for (const [oid, o] of Object.entries(room.players)) {
      if (oid === id || o.alive === false || typeof o.x !== "number") continue;
      const cam = cameraFor(center(o));
      if (!cam) continue;
      const key = "cam:" + oid;
      if (now - (brain.lastSeen[key] || 0) > 8000) remember(brain, { kind: "saw", who: oid, name: o.name, where: cam.label, via: "camera" });
      brain.lastSeen[key] = now;
    }
  }
  // Bodies: a dead player whose body is still lying there.
  for (const [oid, o] of Object.entries(room.players)) {
    if (o.alive !== false || typeof o.bodyX !== "number" || brain.reported.has(oid)) continue;
    const pt = { x: o.bodyX + HALF, y: o.bodyY + HALF };
    const onCam = brain.mode === "cameras" && brain.watchUntil > now && cameraFor(pt);
    if (canSeePoint(room, p, pt) || onCam) {
      if (!brain.memory.some((m) => m.kind === "body" && m.who === oid)) {
        remember(brain, { kind: "body", who: oid, name: o.name, where: onCam ? onCam.label : roomNameAt(o.bodyX, o.bodyY), via: onCam ? "camera" : "eyes" });
      }
      if (p.role === "crewmate" && !brain.pendingBody) brain.pendingBody = oid;
    }
  }
  return seen;
}

// A kill just happened: every bot that could plausibly have seen it
// remembers it (and crew bots run to report).
function witnessKill(room, botId, p, brain, killer, victimId, killerId) {
  const victim = room.players[victimId];
  const pt = { x: victim.x + HALF, y: victim.y + HALF };
  const watchingCam = brain.mode === "cameras" && brain.watchUntil > Date.now() && cameraFor(pt);
  const eyes = canSee(room, p, killer) && canSeePoint(room, p, pt);
  if (!eyes && !watchingCam) return;
  if (!chance(eyes ? 0.85 : 0.7)) return; // people miss things
  remember(brain, { kind: "kill", who: killerId, name: killer.name, victim: victim.name, where: watchingCam && !eyes ? watchingCam.label : roomNameAt(victim.x, victim.y), via: eyes ? "eyes" : "camera" });
  if (p.role === "crewmate") brain.pendingBody = victimId;
}

module.exports = {
  STATION_SPOTS, MISSION_LABEL, ROOM_NAME, roomNameAt,
  canSee, canSeePoint, visiblePlayers, perceive, witnessKill, setupForGame, remember,
  rand, chance, pick, center,
};
