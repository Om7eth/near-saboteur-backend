// NEAR Saboteur - Backend Server
// STEP 2: Basic server + connection test
// Yeh sirf check karta hai ki server chal raha hai aur players connect ho sakte hain.

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// CORS open rakha hai abhi testing ke liye (baad mein Telegram domain tak restrict karenge)
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Simple health-check route - browser mein khol ke dekho ki server zinda hai
app.get("/", (req, res) => {
  res.send("NEAR Saboteur backend is running! ✅");
});

// Jab koi player connect hota hai
io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  // Test event: connected player ko ek welcome message bhejna
  socket.emit("welcome", { message: "Connected to NEAR Saboteur server!" });

  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
