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
