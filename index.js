// NEAR Saboteur - Backend Server
// STEP 2: Basic server + connection test
// STEP 3: Lobby/Room system - players room-code se join karte hain naam+avatar ke saath
//
// [MULTIPLAYER ARCHITECTURE NOTE]
// Yeh server "rooms" object mein har game-room ka data memory mein rakhta hai.
// rooms = {
//   "ABCD": {
//     code: "ABCD",
//     players: {
//        "<socket.id>": { name, avatarId, isHost }
//     }
//   }
// }
// Memory-only hai abhi - server restart hone par sab room data khatam ho jata hai.
// Yeh abhi ke liye theek hai (game-session data hai, permanent save nahi karna).

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

// Yeh line zaroori hai - isse test-room.html jaisi files
// browser mein directly khul sakti hain (static file serving).
app.use(express.static(__dirname));

// Sab rooms yahan store hote hain (in-memory)
const rooms = {};

// 4-letter random room code banane ka helper
function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // confusing letters (I, O, 0, 1) hata diye
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Room ke players ki list, broadcast karne ke liye saaf format mein
function getPlayerList(roomCode) {
  const room = rooms[roomCode];
  if (!room) return [];
  return Object.entries(room.players).map(([id, p]) => ({
    id,
    name: p.name,
    avatarId: p.avatarId,
    isHost: p.isHost,
  }));
}

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  // ---- CREATE ROOM ----
  socket.on("createRoom", ({ name, avatarId }) => {
    let code = generateRoomCode();
    while (rooms[code]) {
      code = generateRoomCode();
    }

    rooms[code] = {
      code,
      gameStarted: false,
      players: {
        [socket.id]: { name, avatarId, isHost: true },
      },
    };

    socket.join(code);
    socket.data.roomCode = code;

    socket.emit("roomCreated", {
      code,
      players: getPlayerList(code),
    });

    console.log(`Room ${code} created by ${name}`);
  });

  // ---- JOIN ROOM ----
  socket.on("joinRoom", ({ code, name, avatarId }) => {
    const roomCode = (code || "").toUpperCase().trim();
    const room = rooms[roomCode];

    if (!room) {
      socket.emit("joinError", { message: "Room not found. Code check karo." });
      return;
    }

    room.players[socket.id] = { name, avatarId, isHost: false };
    socket.join(roomCode);
    socket.data.roomCode = roomCode;

    const playerList = getPlayerList(roomCode);

    socket.emit("roomJoined", {
      code: roomCode,
      players: playerList,
    });

    io.to(roomCode).emit("playerListUpdated", { players: playerList });

    console.log(`${name} joined room ${roomCode}`);
  });

  // ---- START GAME ----
  socket.on("startGame", ({ imposterCount }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];

    if (!room) {
      socket.emit("startGameError", { message: "Room not found." });
      return;
    }

    if (!room.players[socket.id] || !room.players[socket.id].isHost) {
      socket.emit("startGameError", { message: "Sirf host hi game start kar sakta hai." });
      return;
    }

    const playerIds = Object.keys(room.players);

    if (playerIds.length < 2) {
      socket.emit("startGameError", { message: "Kam se kam 2 players chahiye." });
      return;
    }

    let saboteurCount = imposterCount || 1;
    saboteurCount = Math.max(1, Math.min(saboteurCount, playerIds.length - 1));

    const shuffled = [...playerIds];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const saboteurIds = new Set(shuffled.slice(0, saboteurCount));

    room.gameStarted = true;

    playerIds.forEach((id) => {
      const role = saboteurIds.has(id) ? "saboteur" : "crewmate";
      room.players[id].role = role;
      room.players[id].alive = true;
      io.to(id).emit("roleAssigned", { role });
    });

    console.log(`Game started in room ${roomCode}. ${saboteurCount} saboteur(s) assigned.`);
  });

  // ---- PLAYER MOVE ----
  socket.on("playerMove", ({ x, y }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode || !rooms[roomCode]) return;

    if (rooms[roomCode].players[socket.id]) {
      rooms[roomCode].players[socket.id].x = x;
      rooms[roomCode].players[socket.id].y = y;
    }

    socket.to(roomCode).emit("playerMoved", { id: socket.id, x, y });
  });

  // ---- KILL PLAYER ----
  socket.on("killPlayer", ({ targetId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;

    const killer = room.players[socket.id];
    const target = room.players[targetId];

    if (!killer || killer.role !== "saboteur") {
      socket.emit("killError", { message: "Tum Saboteur nahi ho." });
      return;
    }
    if (!killer.alive) {
      socket.emit("killError", { message: "Tum khud mar chuke ho." });
      return;
    }
    if (!target || !target.alive) {
      socket.emit("killError", { message: "Target valid nahi hai." });
      return;
    }
    if (target.role === "saboteur") {
      socket.emit("killError", { message: "Saboteur doosre Saboteur ko nahi maar sakta." });
      return;
    }

    target.alive = false;

    io.to(roomCode).emit("playerKilled", {
      targetId,
      killerId: socket.id,
    });

    console.log(`${target.name} was killed by ${killer.name} in room ${roomCode}`);
  });

  // ---- SABOTAGE ACTION ----
  socket.on("sabotageAction", ({ type }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;

    const player = room.players[socket.id];

    if (!player || player.role !== "saboteur") {
      socket.emit("sabotageError", { message: "Tum Saboteur nahi ho." });
      return;
    }
    if (!player.alive) {
      socket.emit("sabotageError", { message: "Tum khud mar chuke ho." });
      return;
    }

    const validTypes = ["electricity", "hacker", "lockLeft", "lockRight"];
    if (!validTypes.includes(type)) {
      socket.emit("sabotageError", { message: "Invalid sabotage type." });
      return;
    }

    io.to(roomCode).emit("sabotageTriggered", {
      type,
      triggeredBy: socket.id,
    });

    console.log(`Sabotage "${type}" triggered by ${player.name} in room ${roomCode}`);
  });

  // ---- CALL MEETING (koi bhi alive player kar sakta hai) ----
  // Client bhejta hai: { reason: 'self' | 'report', reportedBodyId }
  // [MULTIPLAYER: SHARED] - meeting state room mein store hoti hai taaki
  // naya/refresh hua player bhi current stage jaan sake.
  socket.on("callMeeting", ({ reason, reportedBodyId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;

    const caller = room.players[socket.id];
    if (!caller || !caller.alive) {
      socket.emit("meetingError", { message: "Tum meeting call nahi kar sakte." });
      return;
    }

    if (room.meeting) {
      socket.emit("meetingError", { message: "Meeting already chal rahi hai." });
      return;
    }

    room.meeting = {
      stage: "alarm",
      startedAt: Date.now(),
      calledBy: socket.id,
      reason: reason || "self",
      reportedBodyId: reportedBodyId || null,
      messages: [],
      votes: {},
    };

    io.to(roomCode).emit("meetingStarted", {
      calledBy: socket.id,
      callerName: caller.name,
      reason: room.meeting.reason,
    });

    console.log(`Meeting called by ${caller.name} in room ${roomCode}`);
  });

  // ---- MEETING CHAT MESSAGE ----
  // Client bhejta hai: { text }
  // [MULTIPLAYER: SHARED] - sab players ke chat-history mein same messages
  // dikhne chahiye, isliye server hi single-source-of-truth rakhta hai.
  socket.on("sendChatMessage", ({ text }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.meeting) return;

    const sender = room.players[socket.id];
    if (!sender) return;

    const trimmed = (text || "").trim().slice(0, 200);
    if (!trimmed) return;

    const message = {
      senderId: socket.id,
      senderName: sender.name,
      senderAvatar: sender.avatarId,
      text: trimmed,
      timestamp: Date.now(),
    };

    room.meeting.messages.push(message);

    io.to(roomCode).emit("chatMessageReceived", message);
  });

  // ---- DISCONNECT ----
  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);

    const roomCode = socket.data.roomCode;
    if (roomCode && rooms[roomCode]) {
      delete rooms[roomCode].players[socket.id];

      const remaining = Object.keys(rooms[roomCode].players);
      if (remaining.length === 0) {
        delete rooms[roomCode];
        console.log(`Room ${roomCode} deleted (empty)`);
      } else {
        io.to(roomCode).emit("playerListUpdated", {
          players: getPlayerList(roomCode),
        });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
