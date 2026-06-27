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
  // Client bhejta hai: { name, avatarId }
  socket.on("createRoom", ({ name, avatarId }) => {
    let code = generateRoomCode();
    // Bahut hi kam chance hai collision ka, lekin safety ke liye check
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
  // Client bhejta hai: { code, name, avatarId }
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

    // Naye player ko khud confirmation
    socket.emit("roomJoined", {
      code: roomCode,
      players: playerList,
    });

    // Room ke sabko updated player-list bhejna (naya player bhi dikhega sabko)
    io.to(roomCode).emit("playerListUpdated", { players: playerList });

    console.log(`${name} joined room ${roomCode}`);
  });

  // ---- START GAME (sirf host kar sakta hai) ----
  // Client bhejta hai: { imposterCount }
  // Yeh secretly random player(s) ko Saboteur banata hai.
  // [MULTIPLAYER: SHARED] - role decide server pe hota hai, kisi client ko
  // doosre player ka role pata nahi chalta, sirf apna khud ka.
  socket.on("startGame", ({ imposterCount }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];

    if (!room) {
      socket.emit("startGameError", { message: "Room not found." });
      return;
    }

    // Sirf host start kar sakta hai
    if (!room.players[socket.id] || !room.players[socket.id].isHost) {
      socket.emit("startGameError", { message: "Sirf host hi game start kar sakta hai." });
      return;
    }

    const playerIds = Object.keys(room.players);

    if (playerIds.length < 2) {
      socket.emit("startGameError", { message: "Kam se kam 2 players chahiye." });
      return;
    }

    // imposterCount ko valid range mein clamp karna (kam se kam 1, players se zyada nahi)
    let saboteurCount = imposterCount || 1;
    saboteurCount = Math.max(1, Math.min(saboteurCount, playerIds.length - 1));

    // Players ko shuffle karke pehle N ko Saboteur banana (Fisher-Yates shuffle)
    const shuffled = [...playerIds];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const saboteurIds = new Set(shuffled.slice(0, saboteurCount));

    room.gameStarted = true;

    // Har player ko SIRF apna role bhejna - kisi ko doosre ka role nahi pata chalega
    playerIds.forEach((id) => {
      const role = saboteurIds.has(id) ? "saboteur" : "crewmate";
      room.players[id].role = role;
      io.to(id).emit("roleAssigned", { role });
    });

    console.log(`Game started in room ${roomCode}. ${saboteurCount} saboteur(s) assigned.`);
  });

  // ---- DISCONNECT ----
  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);

    const roomCode = socket.data.roomCode;
    if (roomCode && rooms[roomCode]) {
      delete rooms[roomCode].players[socket.id];

      const remaining = Object.keys(rooms[roomCode].players);
      if (remaining.length === 0) {
        // Room khaali ho gaya - hata do memory se
        delete rooms[roomCode];
        console.log(`Room ${roomCode} deleted (empty)`);
      } else {
        // Baaki players ko update bhejna
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
