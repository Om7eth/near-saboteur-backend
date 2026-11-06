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
// Day 2: bots are always crew. Flip on once saboteur bots can actually
// kill (Day 3) - until then a bot saboteur would just wander and get
// auto-eliminated by the 7-minute no-kill rule.
const BOTS_CAN_BE_SABOTEUR = false;
// Clients teleport everyone back to their spawn point 4s after a vote
// result (see votingResult in game.jsx). Bots copy that.
const POST_MEETING_RESPAWN_MS = 4000;

const BOT_NAMES = ["Nova", "Atlas", "Orbit", "Pixel", "Echo", "Comet", "Byte", "Zephyr", "Quark", "Rune", "Vega", "Flux"];
const ALL_AVATAR_IDS = ["purple", "green", "red", "black", "darkgreen", "magenta", "yellow", "brown", "orange", "cyan"];

let ctx = null; // { io, rooms }
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

function stepBot(roomCode, room, id, p, brain, dtSec, now) {
  // Re-plan if the gate-lock situation changed under us.
  const locked = lockedGatesFor(room);
  const lockKey = locked ? [...locked][0] : "";
  if (lockKey !== brain.lockKey) {
    brain.lockKey = lockKey;
    if (brain.path) brain.path = null;
  }

  if (brain.waitUntil > now) return;

  if (!brain.path || brain.path.length === 0) {
    if (!chooseDestination(room, p, brain)) {
      brain.waitUntil = now + 1500; // nowhere reachable right now (e.g. gates locked) - try again soon
      return;
    }
    startLeg(brain, now);
  }

  // Occasional short hesitation mid-walk, like a player glancing around
  // or checking the map (~once every 25s of walking).
  if (rand(0, 1) < 0.004 * (dtSec / 0.1)) {
    brain.waitUntil = now + rand(400, 1400);
    brain.legStartedAt = brain.waitUntil; // ease back in afterwards
    return;
  }

  // Ease in at the start of a leg and ease out at the very end, instead
  // of snapping between full speed and a dead stop.
  const remaining = brain.path.reduce((acc, wp, i) => {
    const prev = i === 0 ? p : brain.path[i - 1];
    return acc + Math.hypot(wp.x - prev.x, wp.y - prev.y);
  }, 0);
  const easeIn = Math.min(1, Math.max(0.3, (now - (brain.legStartedAt || now)) / 350));
  const easeOut = Math.min(1, Math.max(0.35, remaining / 28));
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
  if (!brain.path.length) {
    brain.path = null;
    // Linger: short after a small in-room shuffle, longer after arriving
    // somewhere new (looking around / "doing something").
    brain.waitUntil = now + (brain.localMove ? rand(1000, 3500) : rand(2500, 8000));
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
      continue; // everyone is frozen during a meeting
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
        brains.set(id, b);
        broadcastIfMoved(roomCode, id, p, b);
      }
      continue;
    }

    for (const id of ids) {
      const p = room.players[id];
      if (!p || p.alive === false) continue; // dead bots stay put (ghost bots: later)
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

let tickTimer = null;
function init({ io, rooms }) {
  ctx = { io, rooms };
  console.log(`[BOTS] map version ${MAP_VERSION}`);
  if (!tickTimer) tickTimer = setInterval(tick, TICK_MS);
}

module.exports = {
  MAP_VERSION,
  init,
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
