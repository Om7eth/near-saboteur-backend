// ============================================================
// [AI BOTS - NEAR HACKATHON] Server-side bot players.
//
// Bots are "virtual players": they live in room.players like everyone
// else (id "bot_xxxx", isBot: true) but have no socket. The server moves
// them on a fixed tick and broadcasts the same `playerMoved` event a
// human client would cause, so every client renders them with the
// exact same code path as a human.
//
// HARD RULES (enforced here AND in index.js):
//   - Free Play only. Never in Pool / Paid rooms (no money ever involved).
//   - Only the host can add/remove bots, and only in the Lobby.
//   - A bot can never become host, and a room with only bots left is
//     treated as empty.
//   - Bots have no accountId, so they never earn points, never appear
//     on leaderboards, and never touch any wallet or contract.
//
// Day 2 scope: add/remove, spawn, wander between rooms with A*.
// Day 3 adds missions (crew) and kills/sabotage (saboteur).
// ============================================================
const crypto = require("crypto");
const M = require("./mapData");
const P = require("./pathfinding");
const B = require("./brain");
const MB = require("./meetingBrain");

const BOT_ID_PREFIX = "bot_";
// Short fingerprint of the map the server is using (same FNV-1a hash the
// frontend computes from its own GRID). Sent to clients at game start so a
// stale backend (old map in memory) is easy to spot.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
const MAP_VERSION = fnv1a(M.GRID);
const TICK_MS = 100; // 10 Hz - clients already interpolate other players
const MAX_PLAYERS = 10;
// Bots can be drawn as Saboteur (they hunt, kill and sabotage - see
// considerHunt / stepHunt below).
const BOTS_CAN_BE_SABOTEUR = true;
const PERCEIVE_MS = 400;
const KILL_PAUSE_MS = 2500; // matches KILL_CUTSCENE_MS in game.jsx
// Clients teleport everyone back to their spawn point 4s after a vote
// result (see votingResult in game.jsx). Bots copy that.
const POST_MEETING_RESPAWN_MS = 4000;

const BOT_NAMES = ["Nova", "Atlas", "Orbit", "Pixel", "Echo", "Comet", "Byte", "Zephyr", "Quark", "Rune", "Vega", "Flux"];
const ALL_AVATAR_IDS = ["purple", "green", "red", "black", "darkgreen", "magenta", "yellow", "brown", "orange", "cyan"];

let ctx = null; // { io, rooms }
// Game actions provided by index.js (same code paths humans use).
let hooks = { performKill: null, performSabotage: null, startMeeting: null, completeMission: null, killRangePx: 84 };
function setHooks(h) { hooks = { ...hooks, ...h }; }
// Per-bot brain state, keyed by bot id (ids are globally unique).
const brains = new Map();
// Per-room bookkeeping, keyed by room code.
const roomStates = new Map();

function isBotId(id) {
  return typeof id === "string" && id.startsWith(BOT_ID_PREFIX);
}
function isBot(p) {
  return !!(p && p.isBot);
}
function botIds(room) {
  return Object.keys(room.players).filter((id) => room.players[id].isBot);
}
function humanIds(room) {
  return Object.keys(room.players).filter((id) => !room.players[id].isBot);
}

function rand(min, max) {
  return min + (crypto.randomInt(0, 1_000_000) / 1_000_000) * (max - min);
}
function pick(arr) {
  return arr[crypto.randomInt(0, arr.length)];
}

// Same formula as the client's in-game movement (game.jsx main loop):
// px/frame = MOVE_SPEED * (oldLevel / 2), at 60 frames per second.
function speedPxPerSec(room) {
  const lvl = typeof room.speedLevel === "number" ? room.speedLevel : 1;
  const oldLevel = 4 * lvl + 1; // speedSliderToOldLevel()
  return M.MOVE_SPEED * (oldLevel / 2) * 60;
}

function spawnPointPx(index) {
  const p = M.CAFETERIA_SPAWN_POINTS[index % M.CAFETERIA_SPAWN_POINTS.length];
  return { x: p.x * M.TILE, y: p.y * M.TILE };
}

// ---- Lobby (percentage coordinates of the lobby art box) ----------
// Mirrors lobbySolidAt / lobbyCanStand in game.jsx.
function lobbySolidAt(x, y) {
  const F = M.LOBBY_FLOOR;
  if (x < F.x1 || x > F.x2 || y < F.y1 || y > F.y2) return true;
  for (const s of M.LOBBY_SOLIDS) if (x >= s.x1 && x <= s.x2 && y >= s.y1 && y <= s.y2) return true;
  return false;
}
function lobbyCanStand(x, y) {
  const hx = M.LOBBY_PLAYER_HALF_X, hy = M.LOBBY_PLAYER_HALF_Y;
  return !lobbySolidAt(x - hx, y - hy) && !lobbySolidAt(x + hx, y - hy) && !lobbySolidAt(x - hx, y + hy) && !lobbySolidAt(x + hx, y + hy);
}
function lobbyLineClear(a, b) {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.4));
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    if (!lobbyCanStand(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) return false;
  }
  return true;
}
function randomLobbySpot() {
  for (let tries = 0; tries < 80; tries++) {
    const x = rand(M.LOBBY_FLOOR.x1 + 4, M.LOBBY_FLOOR.x2 - 4);
    const y = rand(M.LOBBY_FLOOR.y1 + 6, M.LOBBY_FLOOR.y2 - 4);
    if (lobbyCanStand(x, y)) return { x, y };
  }
  return { x: 50, y: 60 };
}
// Lobby speed in %/sec, same formula as the client's lobby loop
// (MOVE_SPEED * 0.62 * speed / 480px wide, /320px tall, at 60fps),
// slowed a bit - bots stroll in the lobby, they aren't going anywhere.
const LOBBY_SPEED_FACTOR = 0.62;
const LOBBY_STROLL = 0.6;
function lobbySpeedPctPerSec(room) {
  const lvl = typeof room.speedLevel === "number" ? room.speedLevel : 1;
  const base = M.MOVE_SPEED * LOBBY_SPEED_FACTOR * ((4 * lvl + 1) / 2) * 60 * LOBBY_STROLL;
  return { x: (base / 480) * 100, y: (base / 320) * 100 };
}

function lockedGatesFor(room) {
  const lock = room.activeGateLock;
  if (!lock || (lock.expiresAt && lock.expiresAt <= Date.now())) return null;
  return new Set(lock.group === "A" ? M.GATE_GROUP_A : M.GATE_GROUP_B);
}

// ---------------------------------------------------------------------
// Add / remove
// ---------------------------------------------------------------------
function addBot(room) {
  if (!room) return { ok: false, error: "Room not found." };
  if (room.pool) return { ok: false, error: "Bots are only allowed in Free Play rooms." };
  if (room.gameStarted) return { ok: false, error: "Bots can only be added in the Lobby." };
  if (Object.keys(room.players).length >= MAX_PLAYERS) return { ok: false, error: "Room is full." };

  const takenNames = new Set(Object.values(room.players).map((p) => p.name));
  const freeNames = BOT_NAMES.filter((n) => !takenNames.has(n));
  const name = freeNames.length ? pick(freeNames) : `Bot${crypto.randomInt(10, 100)}`;

  const takenAvatars = new Set(Object.values(room.players).map((p) => p.avatarId));
  const freeAvatars = ALL_AVATAR_IDS.filter((a) => !takenAvatars.has(a));
  const avatarId = freeAvatars.length ? pick(freeAvatars) : pick(ALL_AVATAR_IDS);

  let id;
  do { id = BOT_ID_PREFIX + crypto.randomBytes(4).toString("hex"); } while (room.players[id]);

  room.players[id] = {
    name,
    avatarId,
    avatarVariantId: null,
    isHost: false,
    isBot: true,
    // Unguessable, never sent to any client - so no token lookup (e.g.
    // reconnectToRoom with a missing/null token) can ever match a bot.
    playerToken: `bot:${crypto.randomBytes(16).toString("hex")}`,
    accountId: null,
    accountEmail: null,
    accountUsername: null,
    hasLegionBadge: false,
    hasPlayPass: false,
    premiumVariantId: null,
  };
  // Lobby uses percentage coordinates (0-100) of the lobby art box.
  const spot = randomLobbySpot();
  room.players[id].lobbyX = Math.round(spot.x * 10) / 10;
  room.players[id].lobbyY = Math.round(spot.y * 10) / 10;
  brains.set(id, newBrain());
  return { ok: true, botId: id, name };
}

function removeBot(room, botId) {
  if (!room || !room.players[botId] || !room.players[botId].isBot) {
    return { ok: false, error: "That bot isn't in this room." };
  }
  if (room.gameStarted) return { ok: false, error: "Bots can only be removed in the Lobby." };
  delete room.players[botId];
  brains.delete(botId);
  return { ok: true };
}

// Used when the last human leaves: drop every bot so the room's normal
// "empty room" handling (delete / auto-close) kicks in unchanged.
function removeAllBots(room) {
  for (const id of botIds(room)) {
    delete room.players[id];
    brains.delete(id);
  }
}

// Call after a human leaves/disconnects for good. Returns the ids of the
// HUMANS still in the room - use it anywhere index.js previously used
// Object.keys(room.players) to decide "is the room empty?" / "who's the
// next host?". If no humans remain, all bots are removed first.
function humansRemainingAfterLeave(room) {
  const humans = humanIds(room);
  if (humans.length === 0) removeAllBots(room);
  return humans;
}

// ---------------------------------------------------------------------
// Game lifecycle
// ---------------------------------------------------------------------
function newBrain() {
  return {
    path: null, waitUntil: 0, lastBroadcast: null, destRoomId: null, lockKey: "",
    legStartedAt: 0, legSpeed: 0.9, localMove: false,
    // Lobby wandering. Start with a short random pause so bots added
    // together don't all set off at the same instant.
    lobbyTarget: null, lobbyWaitUntil: Date.now() + rand(800, 3000), lobbyLegSpeed: 0.9, lastLobbyBroadcast: null,
  };
}

// Ids that may be picked as saboteur by startGame.
function saboteurCandidateIds(room, playerIds) {
  if (BOTS_CAN_BE_SABOTEUR) return playerIds;
  const humans = playerIds.filter((id) => !room.players[id].isBot);
  return humans.length ? humans : playerIds;
}

// Called from startGame right after roles are assigned. playerIds is the
// same ordered list startGame used, so spawnIndex matches the clients.
function onGameStarted(roomCode, room, playerIds) {
  const now = Date.now();
  roomStates.set(roomCode, { meetingSeen: false, respawnAt: 0 });
  playerIds.forEach((id, spawnIndex) => {
    const p = room.players[id];
    if (!p || !p.isBot) return;
    const pos = spawnPointPx(spawnIndex);
    p.x = pos.x;
    p.y = pos.y;
    const b = newBrain();
    // Small random delay so bots don't all leave spawn in lockstep, and
    // clients have time to finish the loading screen.
    b.waitUntil = now + rand(3000, 6000);
    B.setupForGame(room, id, p, b, now);
    brains.set(id, b);
    ctx.io.to(roomCode).emit("playerMoved", { id, x: p.x, y: p.y, isGhost: false });
  });
}

// ---------------------------------------------------------------------
// Movement tick
// ---------------------------------------------------------------------
// Human-like destination choice: often just shuffle around the current
// room ("looking around"), otherwise head somewhere, preferring rooms
// that are closer (players rarely cross the whole map every time).
function chooseDestination(room, p, brain) {
  const here = P.roomAtPixel(p.x, p.y);
  const locked = lockedGatesFor(room);
  const from = { x: p.x, y: p.y };
  const tryPath = (pt, roomId) => {
    if (!pt) return false;
    // Don't plan to stop right on top of someone else.
    if (Object.values(room.players).some((o) => o !== p && o.alive !== false && typeof o.x === "number" && Math.hypot(o.x - pt.x, o.y - pt.y) < 22)) return false;
    const path = P.findPath(from, pt, locked);
    if (!path || !path.length) return false;
    brain.path = path;
    brain.destRoomId = roomId;
    brain.localMove = roomId === (here && here.id);
    return true;
  };
  if (here && rand(0, 1) < 0.35) {
    if (tryPath(P.randomPointInRoom(here.id), here.id)) return true;
  }
  const options = M.ROOMS.filter((r) => !here || r.id !== here.id).map((r) => {
    const cx = (r.x + r.w / 2) * M.TILE, cy = (r.y + r.h / 2) * M.TILE;
    return { r, w: 1 / (1 + Math.hypot(cx - p.x, cy - p.y) / 700) };
  });
  for (let tries = 0; tries < 5; tries++) {
    const total = options.reduce((a, o) => a + o.w, 0);
    let x = rand(0, total), choice = options[options.length - 1].r;
    for (const o of options) { x -= o.w; if (x <= 0) { choice = o.r; break; } }
    if (tryPath(P.randomPointInRoom(choice.id), choice.id)) return true;
  }
  return false;
}

function startLeg(brain, now) {
  brain.legStartedAt = now;
  brain.legSpeed = rand(0.84, 0.97); // nobody walks at exactly max speed all the time
}

// ---- Decisions ---------------------------------------------------------
// Pick a free spot from a list (not right on top of another player).
function freeSpot(room, id, spots) {
  const others = Object.entries(room.players).filter(([oid, o]) => oid !== id && o.alive !== false && typeof o.x === "number");
  const shuffled = [...spots].sort(() => rand(-1, 1));
  for (const s of shuffled) {
    if (others.every(([, o]) => Math.hypot(o.x - s.x, o.y - s.y) > 22)) return s;
  }
  return shuffled[0] || null;
}
function pathTo(room, p, brain, pt) {
  if (!pt) return false;
  const path = P.findPath({ x: p.x, y: p.y }, pt, lockedGatesFor(room));
  if (!path || !path.length) return false;
  brain.path = path;
  return true;
}
function goToStation(room, id, p, brain, stationRoom, mode) {
  const st = B.STATION_SPOTS[stationRoom];
  if (!st || !pathTo(room, p, brain, freeSpot(room, id, st.spots))) return false;
  brain.mode = mode;
  brain.taskRoom = stationRoom;
  return true;
}

// Next thing to do when the bot has nowhere to go.
function decide(roomCode, room, id, p, brain, now) {
  const isSab = p.role === "saboteur";
  if (p.alive === false) {
    // Ghost: just finish the missions.
    const left = (brain.tasks || []).filter((t) => !t.done);
    return left.length ? goToStation(room, id, p, brain, left[0].room, "toTask") : false;
  }
  if (!isSab && brain.pendingBody) {
    const body = room.players[brain.pendingBody];
    if (body && typeof body.bodyX === "number" && pathTo(room, p, brain, { x: body.bodyX, y: body.bodyY })) {
      brain.mode = "toBody";
      return true;
    }
    brain.pendingBody = null;
  }
  const todo = (brain.tasks || []).filter((t) => !t.done);
  // Crew: mostly work through missions; Saboteur: pretend to.
  if (todo.length && B.chance(isSab ? 0.5 : 0.8)) {
    if (goToStation(room, id, p, brain, B.pick(todo).room, "toTask")) return true;
  }
  // Now and then go check the Security Hub cameras.
  if (now - (brain.lastCamsAt || 0) > 60000 && B.chance(isSab ? 0.1 : 0.2)) {
    if (goToStation(room, id, p, brain, "security", "toCams")) return true;
  }
  brain.mode = "wander";
  return chooseDestination(room, p, brain);
}

// The bot just reached the end of its path.
function arrive(roomCode, room, id, p, brain, now) {
  switch (brain.mode) {
    case "toTask":
      brain.mode = "working";
      brain.waitUntil = now + rand(5000, 10000); // missions take a few seconds
      return;
    case "working": {
      const t = (brain.tasks || []).find((x) => x.room === brain.taskRoom && !x.done);
      if (t) {
        t.done = true;
        if (p.role === "crewmate") {
          (p.missionsList || []).forEach((m) => { if (m.room === t.room) m.done = true; });
          if (hooks.completeMission) hooks.completeMission(roomCode, id);
        }
        B.remember(brain, { kind: "did", what: B.MISSION_LABEL[t.room] || "a mission", where: B.ROOM_NAME[t.room] || t.room, fake: p.role !== "crewmate" });
      }
      brain.mode = "idle";
      brain.waitUntil = now + rand(400, 1800);
      return;
    }
    case "toCams":
      brain.mode = "cameras";
      brain.watchUntil = now + rand(8000, 15000);
      brain.waitUntil = brain.watchUntil;
      brain.lastCamsAt = now;
      B.remember(brain, { kind: "did", what: "watched the cameras", where: "Security" });
      return;
    case "cameras":
      brain.mode = "idle";
      return;
    case "toBody": {
      const bodyId = brain.pendingBody;
      const body = bodyId && room.players[bodyId];
      if (!body || typeof body.bodyX !== "number") { brain.pendingBody = null; brain.mode = "idle"; return; }
      if (Math.hypot(body.bodyX - p.x, body.bodyY - p.y) > 50) { brain.mode = "idle"; return; } // body not where we went; decide again
      const err = hooks.startMeeting ? hooks.startMeeting(roomCode, id, "report", bodyId) : { message: "no hook" };
      if (!err) {
        brain.reported.add(bodyId);
        brain.pendingBody = null;
        B.remember(brain, { kind: "reported", who: bodyId, name: body.name, where: B.roomNameAt(body.bodyX, body.bodyY) });
        brain.mode = "idle";
      } else if (err.cooldownRemainingMs) {
        brain.waitUntil = now + err.cooldownRemainingMs + 300; // try again when allowed
      } else {
        brain.pendingBody = null;
        brain.mode = "idle";
      }
      return;
    }
    default:
      brain.mode = "idle";
      // Linger: short after a small in-room shuffle, longer after arriving
      // somewhere new (looking around).
      brain.waitUntil = now + (brain.localMove ? rand(1000, 3500) : rand(2500, 8000));
  }
}

// ---- Saboteur: hunting --------------------------------------------------
function isFellowSaboteur(room, oid) {
  // Saboteurs are told who their teammates are (fellowSaboteurs), so this
  // is information a human Saboteur has too.
  return room.players[oid] && room.players[oid].role === "saboteur";
}
// Who (of the crew this bot can see) could see a kill on `target`? Uses
// each crew member's OWN vision - so with the lights cut (crew vision 5
// tiles instead of 9) fewer people count as witnesses. Only players the
// bot can actually see are considered (no wallhacks).
function witnessesOf(room, seen, targetId) {
  const t = room.players[targetId];
  return seen.filter((oid) => oid !== targetId && !isFellowSaboteur(room, oid) && B.canSee(room, room.players[oid], t)).length;
}
const isDesperate = (room, brain, now) => !room.saboteurTeamHasKilled && now - (brain.gameStartedAt || now) > 4.5 * 60 * 1000;

function considerHunt(roomCode, room, id, p, brain, seen, now) {
  if (brain.mode === "hunt" || brain.mode === "flee" || room.meeting) return;
  if (now < Math.max(p.killCooldownUntil || 0, brain.killPatienceUntil || 0)) { brain.opportunitySince = 0; return; }
  const crewSeen = seen.filter((oid) => !isFellowSaboteur(room, oid));
  if (!crewSeen.length) { brain.opportunitySince = 0; return; }
  const allowed = isDesperate(room, brain, now) ? 1 : 0; // near the 7-minute deadline: accept one witness
  const options = crewSeen
    .map((oid) => ({ oid, d: Math.hypot(room.players[oid].x - p.x, room.players[oid].y - p.y), w: witnessesOf(room, crewSeen, oid) }))
    .filter((o) => o.w <= allowed)
    .sort((a, b) => a.d - b.d);
  if (!options.length) { brain.opportunitySince = 0; return; }
  // Medium skill: a human takes a moment to notice the chance, and
  // sometimes gets cold feet.
  if (!brain.opportunitySince) { brain.opportunitySince = now; brain.reactAfter = rand(600, 1500); return; }
  if (now - brain.opportunitySince < brain.reactAfter) return;
  brain.opportunitySince = 0;
  if (B.chance(0.12)) { brain.killPatienceUntil = now + rand(5000, 10000); return; }
  brain.mode = "hunt";
  brain.target = options[0].oid;
  brain.huntSince = now;
  brain.path = null;
  brain.waitUntil = 0;
}
function stepHunt(roomCode, room, id, p, brain, seen, now) {
  const t = room.players[brain.target];
  const give = (ms) => { brain.mode = "idle"; brain.target = null; brain.path = null; brain.killPatienceUntil = now + ms; };
  if (!t || t.alive === false || room.meeting) return give(rand(5000, 12000));
  const visible = seen.includes(brain.target);
  if (visible) brain.targetLastSeen = now;
  if (now - (brain.targetLastSeen || brain.huntSince) > 2500) return give(rand(6000, 14000)); // lost them
  const witnesses = witnessesOf(room, seen, brain.target);
  if (witnesses > (isDesperate(room, brain, now) ? 1 : 0)) return give(rand(8000, 16000)); // someone else could see
  if (now - brain.huntSince > 15000) return give(rand(10000, 20000)); // don't chase forever
  const d = Math.hypot(t.x - p.x, t.y - p.y);
  if (d <= hooks.killRangePx * 0.7 && visible) {
    const err = hooks.performKill ? hooks.performKill(roomCode, id, brain.target) : { message: "no hook" };
    if (!err) {
      B.remember(brain, { kind: "i-killed", who: brain.target, name: t.name, where: B.roomNameAt(t.x, t.y) });
      brain.lastActionAt = now;
      brain.reported.add(brain.target); // never "find" your own kill by accident
      brain.mode = "flee";
      brain.target = null;
      brain.killPatienceUntil = now + rand(25000, 50000);
      brain.path = null;
      // Stay at the kill spot for the same ~2.5s a human killer is frozen
      // by their kill cutscene, then walk away like nothing happened.
      brain.waitUntil = now + KILL_PAUSE_MS + rand(0, 500);
      chooseDestination(room, p, brain);
      startLeg(brain, brain.waitUntil);
      brain.legSpeed = rand(0.95, 1.0);
      return;
    }
    return give(rand(4000, 9000));
  }
  // Chase: re-plan toward the target's current position.
  if (!brain.path || now - (brain.huntPathAt || 0) > 400) {
    brain.huntPathAt = now;
    if (!pathTo(room, p, brain, { x: t.x, y: t.y })) return give(rand(5000, 10000));
    startLeg(brain, now);
    brain.legStartedAt = now - 1000; // already moving, no ease-in
    brain.legSpeed = rand(0.93, 1.0);
  }
}
// Sabotage like a decent (not perfect) human Saboteur: only with a reason,
// and not too often.
//  - Lights: kill is ready but the crew in view are grouped up (too many
//    witnesses) -> cut the lights so they see less.
//  - Gates: chasing a target inside a room -> lock that side's gates so
//    nobody else walks in.
//  - Split: nothing happening for a long while -> lock one side to break
//    groups up.
function maybeSabotage(roomCode, room, id, p, brain, seen, now) {
  if (room.meeting || !hooks.performSabotage) return;
  if (now < (brain.nextSabotageAt || 0)) return;
  if (now < (p.postKillSabotageLockUntil || 0) || now < (p.sabotageCooldownUntil || 0)) return;
  const killReady = now >= (p.killCooldownUntil || 0);
  const crewSeen = seen.filter((oid) => !isFellowSaboteur(room, oid));
  let type = null, why = "";
  if (killReady && !room.activeSabotageType && crewSeen.length >= 2 && crewSeen.every((oid) => witnessesOf(room, crewSeen, oid) > 0)) {
    type = "electricity"; why = "crew grouped up";
  } else if (brain.mode === "hunt" && !room.activeGateLock && brain.target) {
    const t = room.players[brain.target];
    if (t && P.roomAtPixel(t.x, t.y) && Math.hypot(t.x - p.x, t.y - p.y) < 6 * M.TILE && B.chance(0.35)) {
      type = t.x / M.TILE < 70 ? "gateLeft" : "gateRight"; why = "trap target";
    }
  } else if (!crewSeen.length && killReady && now - (brain.lastActionAt || brain.gameStartedAt || now) > 70000 && !room.activeGateLock && B.chance(0.25)) {
    type = p.x / M.TILE < 70 ? "gateRight" : "gateLeft"; why = "split the crew";
  }
  if (!type) return;
  if (!hooks.performSabotage(roomCode, id, type)) {
    brain.lastActionAt = now;
    brain.nextSabotageAt = now + rand(50000, 90000);
    B.remember(brain, { kind: "i-sabotaged", what: type });
    console.log(`[BOTS] ${p.name} sabotage ${type} (${why})`);
  } else {
    brain.nextSabotageAt = now + 5000;
  }
}

function stepBot(roomCode, room, id, p, brain, dtSec, now) {
  // Re-plan if the gate-lock situation changed under us.
  const locked = lockedGatesFor(room);
  const lockKey = locked ? [...locked][0] : "";
  if (lockKey !== brain.lockKey) {
    brain.lockKey = lockKey;
    if (brain.path) brain.path = null;
    if (brain.mode === "toTask" || brain.mode === "toCams" || brain.mode === "toBody") brain.mode = "idle";
  }

  // Eyes: look around a few times per second.
  if (brain.memory && p.alive !== false && now - (brain.lastPerceiveAt || 0) >= PERCEIVE_MS) {
    brain.lastPerceiveAt = now;
    brain.seen = B.perceive(room, id, p, brain, now);
    if (p.role === "saboteur") {
      considerHunt(roomCode, room, id, p, brain, brain.seen, now);
      maybeSabotage(roomCode, room, id, p, brain, brain.seen, now);
    } else if (brain.pendingBody && brain.mode !== "toBody") {
      // Spotted a body: drop everything and go report it.
      brain.path = null;
      brain.waitUntil = 0;
      brain.mode = "idle";
    }
  }

  if (brain.mode === "hunt") {
    stepHunt(roomCode, room, id, p, brain, brain.seen || [], now);
    if (brain.mode !== "hunt" && brain.mode !== "flee") return;
    if (brain.waitUntil > now) return; // e.g. the pause right after a kill
  } else {
    if (brain.waitUntil > now) return;
    if (!brain.path || brain.path.length === 0) {
      brain.path = null;
      // A timed activity (doing a mission / watching cameras) just ended.
      if (brain.mode === "working" || brain.mode === "cameras") {
        arrive(roomCode, room, id, p, brain, now);
        return;
      }
      // Travel was interrupted (re-plan, gate lock): think again.
      if (brain.mode === "toTask" || brain.mode === "toCams" || brain.mode === "toBody") brain.mode = "idle";
      if (!(brain.memory ? decide(roomCode, room, id, p, brain, now) : chooseDestination(room, p, brain))) {
        brain.waitUntil = now + 1500; // nowhere reachable right now (e.g. gates locked) - try again soon
        return;
      }
      startLeg(brain, now);
    }
    // Occasional short hesitation mid-walk, like a player glancing around
    // or checking the map (~once every 25s of walking).
    if (brain.mode !== "toBody" && rand(0, 1) < 0.004 * (dtSec / 0.1)) {
      brain.waitUntil = now + rand(400, 1400);
      brain.legStartedAt = brain.waitUntil; // ease back in afterwards
      return;
    }
  }
  if (!brain.path || !brain.path.length) return;

  // Ease in at the start of a leg and ease out at the very end, instead
  // of snapping between full speed and a dead stop.
  const remaining = brain.path.reduce((acc, wp, i) => {
    const prev = i === 0 ? p : brain.path[i - 1];
    return acc + Math.hypot(wp.x - prev.x, wp.y - prev.y);
  }, 0);
  const easeIn = Math.min(1, Math.max(0.3, (now - (brain.legStartedAt || now)) / 350));
  const easeOut = brain.mode === "hunt" ? 1 : Math.min(1, Math.max(0.35, remaining / 28));
  let budget = speedPxPerSec(room) * (brain.legSpeed || 0.9) * Math.min(easeIn, easeOut) * dtSec;

  while (budget > 0 && brain.path.length) {
    const wp = brain.path[0];
    const dx = wp.x - p.x, dy = wp.y - p.y;
    const d = Math.hypot(dx, dy);
    if (d <= budget) {
      p.x = wp.x; p.y = wp.y;
      budget -= d;
      brain.path.shift();
    } else {
      p.x += (dx / d) * budget;
      p.y += (dy / d) * budget;
      budget = 0;
    }
  }
  if (!brain.path.length && brain.mode !== "hunt") {
    brain.path = null;
    if (brain.mode === "toTask" || brain.mode === "toCams" || brain.mode === "toBody") {
      arrive(roomCode, room, id, p, brain, now);
    } else {
      // wander / flee / idle: linger a bit, then decide again
      brain.mode = "idle";
      brain.waitUntil = now + (brain.localMove ? rand(1000, 3500) : rand(2500, 8000));
    }
  }
}

// Lobby: stroll to a nearby free spot, pause, repeat.
function stepLobbyBot(roomCode, room, id, p, brain, dtSec, now) {
  if (typeof p.lobbyX !== "number" || typeof p.lobbyY !== "number") {
    const spot = randomLobbySpot();
    p.lobbyX = spot.x; p.lobbyY = spot.y;
  }
  if (brain.lobbyWaitUntil > now) return;
  if (!brain.lobbyTarget) {
    const from = { x: p.lobbyX, y: p.lobbyY };
    for (let tries = 0; tries < 12; tries++) {
      const ang = rand(0, Math.PI * 2), dist = rand(6, 22);
      const to = { x: from.x + Math.cos(ang) * dist, y: from.y + Math.sin(ang) * dist * 0.8 };
      if (lobbyCanStand(to.x, to.y) && lobbyLineClear(from, to)) { brain.lobbyTarget = to; break; }
    }
    if (!brain.lobbyTarget) { brain.lobbyWaitUntil = now + rand(1500, 3000); return; }
    brain.lobbyLegSpeed = rand(0.8, 1.0);
  }
  const sp = lobbySpeedPctPerSec(room);
  const t = brain.lobbyTarget;
  const dx = t.x - p.lobbyX, dy = t.y - p.lobbyY;
  // Move in "screen-like" units so diagonal speed matches the client.
  const nx = dx / sp.x, ny = dy / sp.y; // seconds needed per axis at full speed
  const secs = Math.hypot(nx, ny);
  const step = dtSec * (brain.lobbyLegSpeed || 0.9);
  if (secs <= step) {
    p.lobbyX = t.x; p.lobbyY = t.y;
    brain.lobbyTarget = null;
    brain.lobbyWaitUntil = now + rand(2500, 9000);
  } else {
    p.lobbyX += dx * (step / secs);
    p.lobbyY += dy * (step / secs);
  }
  const x = Math.round(p.lobbyX * 100) / 100, y = Math.round(p.lobbyY * 100) / 100;
  const last = brain.lastLobbyBroadcast;
  if (!last || last.x !== x || last.y !== y) {
    brain.lastLobbyBroadcast = { x, y };
    ctx.io.to(roomCode).emit("lobbyMoved", { id, x, y });
  }
}

function broadcastIfMoved(roomCode, id, p, brain) {
  const x = Math.round(p.x * 10) / 10, y = Math.round(p.y * 10) / 10;
  const last = brain.lastBroadcast;
  if (last && last.x === x && last.y === y) return;
  brain.lastBroadcast = { x, y };
  if (p.alive === false) {
    // Ghost: only other ghosts may see it move (same rule as playerMove).
    const room = ctx.rooms[roomCode];
    if (!room) return;
    for (const [oid, o] of Object.entries(room.players)) {
      if (oid !== id && o.alive === false && !o.isBot) ctx.io.to(oid).emit("playerMoved", { id, x, y, isGhost: true });
    }
    return;
  }
  ctx.io.to(roomCode).emit("playerMoved", { id, x, y, isGhost: false });
}

let lastTickAt = Date.now();
function tick() {
  const now = Date.now();
  const dtSec = Math.min(0.5, (now - lastTickAt) / 1000);
  lastTickAt = now;
  const rooms = ctx.rooms;
  for (const roomCode of Object.keys(rooms)) {
    const room = rooms[roomCode];
    if (!room || !room.players) continue;
    const ids = botIds(room);
    if (!ids.length) { roomStates.delete(roomCode); continue; }
    if (!room.gameStarted) {
      for (const id of ids) {
        const p = room.players[id];
        let brain = brains.get(id);
        if (!brain) { brain = newBrain(); brains.set(id, brain); }
        try { stepLobbyBot(roomCode, room, id, p, brain, dtSec, now); } catch (e) {
          console.error(`[BOTS] lobby tick error for ${id} in room ${roomCode}:`, e.message);
          brain.lobbyTarget = null; brain.lobbyWaitUntil = now + 3000;
        }
      }
      continue;
    }
    if (room.winner) continue;

    const rs = roomStates.get(roomCode) || { meetingSeen: false, respawnAt: 0 };
    roomStates.set(roomCode, rs);

    if (room.meeting) {
      rs.meetingSeen = true;
      // Everyone is frozen during a meeting - bots talk and vote instead.
      try {
        MB.tick(roomCode, room, now, {
          memoryOf,
          postMeetingChat: (...a) => hooks.postMeetingChat ? hooks.postMeetingChat(...a) : null,
          castMeetingVote: (...a) => hooks.castMeetingVote ? hooks.castMeetingVote(...a) : null,
          voteSkipDiscussion: (...a) => hooks.voteSkipDiscussion ? hooks.voteSkipDiscussion(...a) : null,
        });
      } catch (e) {
        console.error(`[BOTS] meeting tick error in room ${roomCode}:`, e.message);
      }
      continue;
    }
    if (rs.meetingSeen) {
      // Meeting just ended - wait for the same 4s the clients wait, then
      // send every bot back to its spawn point (index in player order,
      // exactly like the clients compute it).
      rs.meetingSeen = false;
      rs.respawnAt = now + POST_MEETING_RESPAWN_MS;
    }
    if (rs.respawnAt) {
      if (now < rs.respawnAt) continue;
      rs.respawnAt = 0;
      const order = Object.keys(room.players);
      for (const id of ids) {
        const p = room.players[id];
        const pos = spawnPointPx(Math.max(0, order.indexOf(id)));
        p.x = pos.x; p.y = pos.y;
        const b = brains.get(id) || newBrain();
        b.path = null;
        b.waitUntil = now + rand(1500, 4000);
        // A meeting clears every body and interrupts whatever we were doing.
        b.mode = "idle"; b.target = null; b.pendingBody = null; b.watchUntil = 0;
        if (b.reported) Object.entries(room.players).forEach(([oid, o]) => { if (o.alive === false) b.reported.add(oid); });
        if (p.role === "saboteur") b.killPatienceUntil = Math.max(b.killPatienceUntil || 0, now + rand(10000, 25000));
        brains.set(id, b);
        broadcastIfMoved(roomCode, id, p, b);
      }
      continue;
    }

    for (const id of ids) {
      const p = room.players[id];
      if (!p) continue;
      // Dead crew bots keep doing their missions as ghosts (humans' ghosts
      // can too, and crew can't win on missions otherwise). Other dead
      // bots just stay put.
      if (p.alive === false) {
        const b = brains.get(id);
        if (p.role !== "crewmate" || !b || !b.tasks || b.tasks.every((t) => t.done)) continue;
      }
      if (typeof p.x !== "number" || typeof p.y !== "number") continue;
      let brain = brains.get(id);
      if (!brain) { brain = newBrain(); brains.set(id, brain); }
      try {
        stepBot(roomCode, room, id, p, brain, dtSec, now);
        broadcastIfMoved(roomCode, id, p, brain);
      } catch (e) {
        // A bot bug must never take the game loop down.
        console.error(`[BOTS] tick error for ${id} in room ${roomCode}:`, e.message);
        brain.path = null;
        brain.waitUntil = now + 2000;
      }
    }
  }
}

// A kill just happened (called from index.js performKill): bots that
// could see it remember it, crew bots go report the body.
function onKill(roomCode, killerId, victimId) {
  const room = ctx && ctx.rooms[roomCode];
  if (!room) return;
  const killer = room.players[killerId];
  if (!killer || !room.players[victimId]) return;
  for (const id of botIds(room)) {
    if (id === killerId) continue;
    const p = room.players[id];
    const brain = brains.get(id);
    if (!p || p.alive === false || !brain || !brain.memory) continue;
    B.witnessKill(room, id, p, brain, killer, victimId, killerId);
  }
}
function onMeetingChat(roomCode, message) {
  const room = ctx && ctx.rooms[roomCode];
  if (room) { try { MB.onChat(roomCode, room, message); } catch (e) { console.error("[BOTS] onChat error:", e.message); } }
}
function memoryOf(botId) {
  const b = brains.get(botId);
  return b && b.memory ? b.memory.slice() : [];
}

let tickTimer = null;
function init({ io, rooms }) {
  ctx = { io, rooms };
  console.log(`[BOTS] map version ${MAP_VERSION}`);
  console.log(`[BOTS] meeting chat: ${MB.aiStatus()}`);
  if (!tickTimer) tickTimer = setInterval(tick, TICK_MS);
}

module.exports = {
  MAP_VERSION,
  init,
  setHooks,
  onKill,
  onMeetingChat,
  memoryOf,
  isBotId,
  isBot,
  botIds,
  humanIds,
  addBot,
  removeBot,
  removeAllBots,
  humansRemainingAfterLeave,
  saboteurCandidateIds,
  onGameStarted,
  // exported for tests
  _internal: { speedPxPerSec, spawnPointPx, brains, lobbyCanStand },
};
