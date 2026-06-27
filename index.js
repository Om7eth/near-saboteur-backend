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

// Voting result calculate karta hai aur sabko broadcast karta hai, fir
// meeting state ko clear kar deta hai (taaki naya meeting call ho sake).
function finalizeVoting(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.meeting) return;

  const votes = room.meeting.votes;
  const counts = {}; // targetId (ya "skip") -> count

  Object.values(votes).forEach((targetId) => {
    counts[targetId] = (counts[targetId] || 0) + 1;
  });

  // Sabse zyada votes wala dhoondo; tie ho to koi eliminate nahi hota
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
    }
  }

  io.to(roomCode).emit("votingResult", {
    eliminatedId,
    eliminatedName: eliminatedId ? room.players[eliminatedId]?.name : null,
    voteCounts: counts,
    tie: topChoices.length > 1,
  });

  console.log(`Voting result in room ${roomCode}: eliminated=${eliminatedId || "none"}`);

  // Meeting khatam - state clear, taaki naya meeting ho sake
  delete room.meeting;
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
      room.players[id].alive = true;
      io.to(id).emit("roleAssigned", { role });
    });

    console.log(`Game started in room ${roomCode}. ${saboteurCount} saboteur(s) assigned.`);
  });

  // ---- PLAYER MOVE (position sync) ----
  // Client bhejta hai: { x, y } - har thodi der mein (e.g. 10x per second)
  // [MULTIPLAYER: PER-PLAYER] - apni position bhejta hai, server room ke
  // baaki sab players ko (khud ko chhodke) forward karta hai broadcast se.
  // [GHOST RULE] - agar bheजने wala player dead hai (ghost), uska movement
  // SIRF doosre dead players (ghosts) ko dikhta hai. Alive players ke liye
  // ghost ka movement bilkul broadcast nahi hota - woh unhe invisible hai.
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
      // Sirf doosre dead players (ghosts) ko bhejna
      Object.entries(room.players).forEach(([id, p]) => {
        if (id !== socket.id && p.alive === false) {
          io.to(id).emit("playerMoved", { id: socket.id, x, y, isGhost: true });
        }
      });
    } else {
      // Normal alive player - sabko bhejna (jaisa pehle se tha)
      socket.to(roomCode).emit("playerMoved", { id: socket.id, x, y, isGhost: false });
    }
  });

  // ---- KILL PLAYER (sirf Saboteur kar sakta hai) ----
  // Client bhejta hai: { targetId } - jis player ko maara
  // [MULTIPLAYER: SHARED] - SERVER VALIDATES ki killer sach mein Saboteur hai
  // aur dono (killer + target) alive hain. Client ke "main Saboteur hoon" claim
  // pe kabhi trust nahi karte - room.players[socket.id].role server pe stored hai.
  socket.on("killPlayer", ({ targetId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;

    const killer = room.players[socket.id];
    const target = room.players[targetId];

    // Security checks - server khud verify karta hai, client ko trust nahi karta
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

    // Sab players ko (Saboteur sahit) batana ki kaun mara - taaki sabki
    // screen pe body/cutscene dikh sake. killerId bhi bhejte hain animation ke liye.
    io.to(roomCode).emit("playerKilled", {
      targetId,
      killerId: socket.id,
    });

    console.log(`${target.name} was killed by ${killer.name} in room ${roomCode}`);
  });

  // ---- SABOTAGE ACTION (sirf Saboteur kar sakta hai) ----
  // Client bhejta hai: { type } - "electricity" | "hacker" | "lockLeft" | "lockRight"
  // [MULTIPLAYER: SHARED] - server validate karta hai role, phir sab players ko
  // batata hai. Cooldown/timing logic abhi client-side hi rahegi (frontend
  // mein already bana hua hai) - server sirf "yeh action hua" broadcast karta hai.
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

    // Sab players ko batana (Saboteur sahit) ki sabotage trigger hua
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

    // [GHOST RULE] - dead players (ghosts) chat mein message nahi bhej sakte,
    // sirf dekh sakte hain (read-only) - jo unhe already mil rahi hai kyuki
    // chatMessageReceived sabko broadcast hota hai (io.to roomCode).
    if (!sender.alive) {
      socket.emit("chatError", { message: "Tum ghost ho, chat mein message nahi bhej sakte." });
      return;
    }

    const trimmed = (text || "").trim().slice(0, 200); // 200 char limit, spam-protection
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

  // ---- CAST VOTE ----
  // Client bhejta hai: { targetId } - targetId null/undefined ho to "skip" vote hai
  // [MULTIPLAYER: SHARED] - server hi vote count rakhta hai aur result decide
  // karta hai, taaki koi client fake result na bhej sake.
  socket.on("castVote", ({ targetId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.meeting) return;

    const voter = room.players[socket.id];
    if (!voter || !voter.alive) {
      socket.emit("voteError", { message: "Tum vote nahi de sakte." });
      return;
    }

    // Vote store karna (targetId null ho to skip-vote hai)
    room.meeting.votes[socket.id] = targetId || "skip";

    // Sabko batana kitne vote ho gaye (kisne kise vote diya, yeh nahi batate -
    // sirf count batate hain, taaki suspense bana rahe jaisa Among Us mein hota hai)
    const totalAlive = Object.values(room.players).filter((p) => p.alive).length;
    const totalVotes = Object.keys(room.meeting.votes).length;

    io.to(roomCode).emit("voteUpdate", { totalVotes, totalAlive });

    console.log(`${voter.name} voted in room ${roomCode} (${totalVotes}/${totalAlive})`);

    // Agar sab alive players vote kar chuke, result nikal do turant
    if (totalVotes >= totalAlive) {
      finalizeVoting(roomCode);
    }
  });

  // ---- END MEETING MANUALLY (host, ya timeout ke liye client trigger kar sakta hai) ----
  // Agar sab vote nahi karte (kuch log busy/AFK), host ya koi bhi yeh call
  // karke voting ko force-close kar sakta hai jo bhi votes aaye hain unke saath.
  socket.on("forceFinalizeVoting", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode || !rooms[roomCode] || !rooms[roomCode].meeting) return;
    finalizeVoting(roomCode);
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
