// NEAR Saboteur - Backend Server
// STEP 2: Basic server + connection test
// STEP 3: Lobby/Room system - players join via room code with name+avatar
//
// [MULTIPLAYER ARCHITECTURE NOTE]
// This server keeps each game-room's data in memory in the "rooms" object.
// rooms = {
//   "ABCD": {
//     code: "ABCD",
//     players: {
//        "<socket.id>": { name, avatarId, isHost }
//     }
//   }
// }
// Memory-only for now - all room data is lost on server restart.
// That's fine for now (this is just session data, nothing needs to persist).

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.get("/", (req, res) => {
  res.send("NEAR Saboteur backend is running! ✅");
});

// This line is required so files like test-room.html can be opened
// directly in a browser (static file serving).
app.use(express.static(__dirname));

// All rooms are stored here (in-memory)
const rooms = {};

// Helper to generate a 4-letter random room code
function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // removed confusing letters (I, O, 0, 1)
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// [RECONNECTION] A random per-player token, given to the client once on
// join/create and saved in their own localStorage. When a player's socket
// drops (refresh, backgrounding the tab, brief network loss) and a new
// socket connects later, this token is what lets the server recognize
// "this is the same person coming back" rather than treating them as a
// brand new player — since a fresh socket.id alone has no relation to
// the one that disconnected.
function generatePlayerToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Player list for a room, in a clean format for broadcasting
function getPlayerList(roomCode) {
  const room = rooms[roomCode];
  if (!room) return [];
  return Object.entries(room.players).map(([id, p]) => ({
    id,
    name: p.name,
    avatarId: p.avatarId,
    isHost: p.isHost,
    // [SPAWN/RENDER FIX] Including last-known x/y/alive here means a
    // newly-joined client immediately knows where every existing player
    // currently is, instead of waiting for that player's next movement
    // broadcast (which might be many seconds away if they're standing
    // still) before they appear on screen at all.
    x: p.x,
    y: p.y,
    alive: p.alive,
  }));
}

// Calculates the voting result and broadcasts it to everyone, then
// clears the meeting state (so a new meeting can be called).
// [WIN CONDITION] Checks both win conditions after every kill or
// elimination and announces a winner the moment either is met:
//   - Saboteur(s) win once alive crewmates drop to 2 or fewer (the
//     standard Among Us threshold — at that point there's no way for
//     crewmates to meaningfully investigate anymore).
//   - Crewmates win once either the Saboteur is voted out, OR every
//     alive crewmate has completed all of their assigned missions.
// Returns true if a winner was found and announced (caller can use this
// to skip any further game-state changes, like opening a new meeting).
function checkWinCondition(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.winner) return false; // already decided, don't re-announce

  const players = Object.values(room.players);
  const aliveCrewmates = players.filter((p) => p.role === "crewmate" && p.alive);
  const aliveSaboteurs = players.filter((p) => p.role === "saboteur" && p.alive);

  // Saboteur win: too few crewmates left alive relative to Saboteurs.
  if (aliveCrewmates.length <= 2 && aliveCrewmates.length <= aliveSaboteurs.length) {
    room.winner = "saboteur";
    io.to(roomCode).emit("gameOver", { winner: "saboteur", reason: "elimination" });
    console.log(`Room ${roomCode}: Saboteur(s) win by elimination`);
    return true;
  }

  // Crewmate win #1: no Saboteurs left alive (all voted out / impossible
  // here since Saboteurs can't be killed by each other, but a Saboteur
  // CAN be voted out, which is the actual trigger for this branch).
  if (aliveSaboteurs.length === 0 && players.some((p) => p.role === "saboteur")) {
    room.winner = "crewmate";
    io.to(roomCode).emit("gameOver", { winner: "crewmate", reason: "saboteurEjected" });
    console.log(`Room ${roomCode}: Crewmates win - Saboteur ejected`);
    return true;
  }

  // Crewmate win #2: every alive crewmate has finished every assigned
  // mission. missionsTotal/missionsDone are tracked per-player via the
  // reportMissionProgress event below, sent by each client as their own
  // missions complete.
  if (aliveCrewmates.length > 0 && aliveCrewmates.every((p) => p.missionsDone >= (p.missionsTotal || Infinity))) {
    room.winner = "crewmate";
    io.to(roomCode).emit("gameOver", { winner: "crewmate", reason: "missionsComplete" });
    console.log(`Room ${roomCode}: Crewmates win - all missions complete`);
    return true;
  }

  return false;
}

function finalizeVoting(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.meeting) return;

  const votes = room.meeting.votes;
  const counts = {}; // targetId (or "skip") -> count

  Object.values(votes).forEach((targetId) => {
    counts[targetId] = (counts[targetId] || 0) + 1;
  });

  // Find whoever got the most votes; if there's a tie, nobody gets eliminated
  let maxVotes = 0;
  let topChoices = [];
  Object.entries(counts).forEach(([choice, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      topChoices = [choice];
    } else if (count === maxVotes) {
      topChoices.push(choice);
    }
  });

  let eliminatedId = null;
  if (maxVotes > 0 && topChoices.length === 1 && topChoices[0] !== "skip") {
    eliminatedId = topChoices[0];
    if (room.players[eliminatedId]) {
      room.players[eliminatedId].alive = false;
      // Voted-out players don't have a "killer" cutscene, but they do
      // still leave a body for the corpse-cleanup logic to track and
      // later clear (see CLEAR_BODY below).
      room.players[eliminatedId].bodyX = room.players[eliminatedId].x;
      room.players[eliminatedId].bodyY = room.players[eliminatedId].y;
    }
  }

  // [BODY CLEANUP] Every player who was already dead BEFORE this voting
  // round (i.e. everyone announced when the meeting started) has now
  // been discussed and voted on — Among Us clears all known bodies once
  // a meeting concludes, not just the one that got specifically reported.
  // The newly-eliminated player (if any) is also included, since their
  // body never needs to be found/reported again either.
  const clearedBodyIds = Object.entries(room.players)
    .filter(([, p]) => !p.alive)
    .map(([id]) => id);

  io.to(roomCode).emit("votingResult", {
    eliminatedId,
    eliminatedName: eliminatedId ? room.players[eliminatedId]?.name : null,
    voteCounts: counts,
    tie: topChoices.length > 1,
    clearedBodyIds,
  });

  console.log(`Voting result in room ${roomCode}: eliminated=${eliminatedId || "none"}`);

  // No new meeting can be called within 30s of this one ending.
  room.meetingCooldownUntil = Date.now() + 30000;

  // Meeting's over - clear the state so a new one can start
  delete room.meeting;

  // [WIN CONDITION] A vote-out can end the game immediately, either by
  // ejecting the last Saboteur (crewmates win) or by reducing crewmates
  // below the threshold if a crewmate got voted out by mistake.
  checkWinCondition(roomCode);
}

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  // ---- CREATE ROOM ----
  // Client sends: { name, avatarId }
  socket.on("createRoom", ({ name, avatarId }) => {
    let code = generateRoomCode();
    // Extremely unlikely to collide, but check anyway for safety
    while (rooms[code]) {
      code = generateRoomCode();
    }

    const playerToken = generatePlayerToken();

    rooms[code] = {
      code,
      gameStarted: false,
      players: {
        [socket.id]: { name, avatarId, isHost: true, playerToken },
      },
    };

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerToken = playerToken;

    socket.emit("roomCreated", {
      code,
      players: getPlayerList(code),
      playerToken,
    });

    console.log(`Room ${code} created by ${name}`);
  });

  // ---- JOIN ROOM ----
  // Client sends: { code, name, avatarId }
  socket.on("joinRoom", ({ code, name, avatarId }) => {
    const roomCode = (code || "").toUpperCase().trim();
    const room = rooms[roomCode];

    if (!room) {
      socket.emit("joinError", { message: "Room not found. Check the code." });
      return;
    }

    const playerToken = generatePlayerToken();
    room.players[socket.id] = { name, avatarId, isHost: false, playerToken };
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerToken = playerToken;

    const playerList = getPlayerList(roomCode);

    // Confirmation to the new player themself
    socket.emit("roomJoined", {
      code: roomCode,
      players: playerList,
      playerToken,
    });

    // Updated player-list to everyone in the room (new player shows up for everyone)
    io.to(roomCode).emit("playerListUpdated", { players: playerList });

    console.log(`${name} joined room ${roomCode}`);
  });

  // ---- RECONNECT TO ROOM ----
  // Client sends: { code, playerToken } - sent automatically by a client
  // that finds a saved roomCode+playerToken in its own localStorage on
  // load, instead of going through createRoom/joinRoom again.
  // [RECONNECTION] Re-attaches this NEW socket.id to the EXISTING player
  // slot that was reserved when they disconnected (see the disconnect
  // handler below) — same role, same alive-state, same everything, just a
  // different underlying connection.
  socket.on("reconnectToRoom", ({ code, playerToken }) => {
    const roomCode = (code || "").toUpperCase().trim();
    const room = rooms[roomCode];

    if (!room) {
      socket.emit("reconnectError", { message: "Room no longer exists." });
      return;
    }

    // Find the player slot (under their OLD socket.id) matching this token
    const oldId = Object.keys(room.players).find(
      (id) => room.players[id].playerToken === playerToken
    );

    if (!oldId) {
      socket.emit("reconnectError", { message: "Could not find your previous session." });
      return;
    }

    const playerData = room.players[oldId];

    // Move the player's data to the new socket.id, clear their
    // disconnected-grace-period state, and clean up the old key.
    delete playerData.disconnectedAt;
    delete room.players[oldId];
    room.players[socket.id] = playerData;

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerToken = playerToken;

    socket.emit("reconnected", {
      code: roomCode,
      players: getPlayerList(roomCode),
      role: playerData.role || null,
      alive: playerData.alive !== false,
      gameStarted: room.gameStarted || false,
    });

    io.to(roomCode).emit("playerListUpdated", { players: getPlayerList(roomCode) });

    console.log(`${playerData.name} reconnected to room ${roomCode}`);
  });

  // ---- UPDATE PROFILE (name/avatar changed after already in a room) ----
  // Client sends: { name, avatarId } - either field can be omitted to
  // leave it unchanged. Needed because a player can open the avatar/name
  // editor again AFTER createRoom/joinRoom already ran (e.g. while still
  // standing around in the Lobby waiting for others), and without this
  // event the server would keep showing everyone else the player's OLD
  // name/avatar from whenever they first joined.
  socket.on("updateProfile", ({ name, avatarId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.players[socket.id]) return;

    if (typeof name === "string" && name.trim()) {
      room.players[socket.id].name = name.trim();
    }
    if (typeof avatarId === "string" && avatarId) {
      room.players[socket.id].avatarId = avatarId;
    }

    io.to(roomCode).emit("playerListUpdated", { players: getPlayerList(roomCode) });
  });

  // ---- START GAME (host only) ----
  // Client sends: { imposterCount }
  // This secretly makes random player(s) the Saboteur.
  // [MULTIPLAYER: SHARED] - role decisions happen on the server; no client
  // ever learns another player's role, only their own.
  socket.on("startGame", ({ imposterCount }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];

    if (!room) {
      socket.emit("startGameError", { message: "Room not found." });
      return;
    }

    // Only the host can start the game
    if (!room.players[socket.id] || !room.players[socket.id].isHost) {
      socket.emit("startGameError", { message: "Only the host can start the game." });
      return;
    }

    const playerIds = Object.keys(room.players);

    if (playerIds.length < 2) {
      socket.emit("startGameError", { message: "Need at least 2 players." });
      return;
    }

    // Clamp imposterCount to a valid range (at least 1, never more than players-1)
    let saboteurCount = imposterCount || 1;
    saboteurCount = Math.max(1, Math.min(saboteurCount, playerIds.length - 1));

    // Shuffle players and make the first N the Saboteur(s) (Fisher-Yates shuffle)
    const shuffled = [...playerIds];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const saboteurIds = new Set(shuffled.slice(0, saboteurCount));

    room.gameStarted = true;
    // No meeting can be called within the first 30s of the game starting.
    room.meetingCooldownUntil = Date.now() + 30000;

    // Send each player ONLY their own role - nobody learns another player's role.
    // [SPAWN FIX] Also assign each player a unique spawnIndex (just their
    // position in playerIds, 0..N-1) so they each land on a different one
    // of the cafeteria's predefined spawn points instead of everyone
    // spawning on the exact same tile and getting stuck inside each other.
    playerIds.forEach((id, spawnIndex) => {
      const role = saboteurIds.has(id) ? "saboteur" : "crewmate";
      room.players[id].role = role;
      room.players[id].alive = true;
      io.to(id).emit("roleAssigned", { role, spawnIndex });
    });

    console.log(`Game started in room ${roomCode}. ${saboteurCount} saboteur(s) assigned.`);
  });

  // ---- PLAYER MOVE (position sync) ----
  // Client sends: { x, y } - every so often (e.g. 10x per second)
  // [MULTIPLAYER: PER-PLAYER] - sends its own position, server forwards it
  // to the rest of the room's players (excluding the sender) via broadcast.
  // [GHOST RULE] - if the sending player is dead (a ghost), their movement
  // is only ever broadcast to other dead players (ghosts). Alive players
  // never receive a ghost's movement at all - ghosts are invisible to them.
  socket.on("playerMove", ({ x, y }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!roomCode || !room) return;

    const sender = room.players[socket.id];
    if (sender) {
      sender.x = x;
      sender.y = y;
    }

    const isGhost = sender && sender.alive === false;

    if (isGhost) {
      // Only send to other dead players (ghosts)
      Object.entries(room.players).forEach(([id, p]) => {
        if (id !== socket.id && p.alive === false) {
          io.to(id).emit("playerMoved", { id: socket.id, x, y, isGhost: true });
        }
      });
    } else {
      // Normal alive player - broadcast to everyone (as before)
      socket.to(roomCode).emit("playerMoved", { id: socket.id, x, y, isGhost: false });
    }
  });

  // ---- LOBBY MOVE (position sync while still in the Lobby) ----
  // Client sends: { x, y } - same idea as playerMove, but kept as a
  // completely separate event/state on both ends. The Lobby uses
  // PERCENTAGE coordinates (0-100, relative to the room art's own box),
  // while in-game movement uses world-pixel coordinates (TILE-based) —
  // mixing the two into one event would let a leftover Lobby position
  // briefly appear in the wrong coordinate space once a player transitions
  // into the actual game screen, so they're kept on entirely separate
  // event names and never touch the same stored x/y field.
  socket.on("lobbyMove", ({ x, y }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!roomCode || !room) return;
    socket.to(roomCode).emit("lobbyMoved", { id: socket.id, x, y });
  });

  // ---- KILL PLAYER (Saboteur only) ----
  // Client sends: { targetId } - the player who was killed
  // [MULTIPLAYER: SHARED] - SERVER VALIDATES that the killer really is the
  // Saboteur, and that both killer and target are alive. We never trust a
  // client's own claim of "I'm the Saboteur" - room.players[socket.id].role
  // is what's stored server-side and authoritative.
  socket.on("killPlayer", ({ targetId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;

    const killer = room.players[socket.id];
    const target = room.players[targetId];

    // Security checks - the server verifies this itself, never trusting the client
    if (!killer || killer.role !== "saboteur") {
      socket.emit("killError", { message: "You are not the Saboteur." });
      return;
    }
    if (!killer.alive) {
      socket.emit("killError", { message: "You are already dead." });
      return;
    }
    if (!target || !target.alive) {
      socket.emit("killError", { message: "Target is not valid." });
      return;
    }
    if (target.role === "saboteur") {
      socket.emit("killError", { message: "The Saboteur cannot kill another Saboteur." });
      return;
    }
    // Server-side cooldown enforcement (25s) - mirrors the client's own
    // KILL_COOLDOWN_MS, but checked here too so a modified client can't
    // bypass the cooldown by just not enforcing it locally.
    const now = Date.now();
    if (killer.killCooldownUntil && now < killer.killCooldownUntil) {
      socket.emit("killError", { message: "Kill is still on cooldown." });
      return;
    }
    killer.killCooldownUntil = now + 25000;

    target.alive = false;
    // Store where the body fell — sent to everyone below (bodyDropped),
    // but that event ONLY carries position/avatar data, never a
    // notification or popup. Each client decides entirely on its own,
    // locally, whether to show a Report button/popup based on whether
    // THEIR OWN player is currently standing close to it — exactly the
    // same proximity check (canReportBody/nearestReportableBody) already
    // used elsewhere in the game. No other player's screen is ever told
    // "someone found a body" by the server.
    target.bodyX = target.x;
    target.bodyY = target.y;

    // [FAIRNESS FIX] Only the killer and the victim see the kill cutscene
    // and learn about it right away — exactly like Among Us, nobody else
    // in the room is told anything here.
    io.to(socket.id).emit("playerKilled", { targetId, killerId: socket.id });
    io.to(targetId).emit("playerKilled", { targetId, killerId: socket.id });

    // Everyone else (and the killer/victim too) gets the body's raw
    // position/avatar data so it can render on their map once they're
    // close enough to see it for themselves — same as how any other
    // player's position is just data, not an announcement.
    socket.to(roomCode).emit("bodyDropped", {
      bodyOwnerId: targetId,
      x: target.bodyX,
      y: target.bodyY,
      avatarId: target.avatarId,
    });

    console
