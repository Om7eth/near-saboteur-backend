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

// Needed so the Telegram webhook route below (POST /telegram-webhook)
// can read the JSON body Telegram sends. This ONLY applies to routes
// that opt into it - it does not touch Socket.io at all, so it cannot
// affect any real-time game traffic.
app.use(express.json());

// All rooms are stored here (in-memory)
const rooms = {};

// ============================================================
// [NEW FEATURE] TELEGRAM GROUP INTEGRATION
// Fully self-contained and isolated from all game logic below.
// Every function here is wrapped in try/catch and NEVER throws or
// blocks - if Telegram is slow, down, or misconfigured, gameplay
// (kills/votes/missions/movement) is completely unaffected. All
// calls into this section from game handlers are "fire and forget"
// (never awaited on the critical path), so a slow Telegram API
// response can never delay a socket event response to a player.
// ============================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "@nearsaboteur";
const TELEGRAM_TOPIC_ID = process.env.TELEGRAM_TOPIC_ID
  ? Number(process.env.TELEGRAM_TOPIC_ID)
  : 349;
// The bot's own deep-link, used for the "Join"/"Play Now" buttons.
// ?startapp=<code> opens the Mini App directly (if the bot has a
// direct-link Mini App configured in BotFather) with the room code
// available to the frontend as the Telegram start_param.
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || "Nearsaboteurbot";
const TELEGRAM_API = TELEGRAM_BOT_TOKEN ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}` : null;

// Low-level helper - every Telegram Bot API call goes through this.
// Never throws; returns null on any failure (missing token, network
// error, or Telegram-side error) and just logs a warning.
async function tgCall(method, payload) {
  if (!TELEGRAM_API) return null;
  try {
    const res = await fetch(`${TELEGRAM_API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) {
      console.warn(`[Telegram] ${method} failed: ${data.description}`);
      return null;
    }
    return data.result;
  } catch (err) {
    console.warn(`[Telegram] ${method} error: ${err.message}`);
    return null;
  }
}

function telegramRoomJoinUrl(code) {
  return `https://t.me/${TELEGRAM_BOT_USERNAME}?startapp=${code}`;
}

function telegramRoomStatusMessage(room) {
  const count = Object.keys(room.players).length;
  if (room.gameStarted) {
    return {
      text: `🔴 *Room ${room.code}* — game in progress. Not joinable right now.`,
      keyboard: { inline_keyboard: [] },
    };
  }
  return {
    text: `🟢 *Room ${room.code}* is open!\n👥 ${count} player(s) waiting\n\nTap below to join 👇`,
    keyboard: {
      inline_keyboard: [[{ text: "▶️ Join Room", url: telegramRoomJoinUrl(room.code) }]],
    },
  };
}

// Called whenever a PUBLIC room's state changes in a way that should
// be reflected in the group (created, game started, back to Lobby).
// Reuses the SAME Telegram message via editMessageText for the room's
// entire lifetime instead of posting a new one each time - this is
// what prevents the group from being spammed with duplicate messages
// every time a room cycles through games.
async function postOrUpdateRoomMessage(room) {
  if (!room || !room.isPublic) return;
  const { text, keyboard } = telegramRoomStatusMessage(room);

  if (room.telegramMessageId) {
    await tgCall("editMessageText", {
      chat_id: TELEGRAM_CHAT_ID,
      message_id: room.telegramMessageId,
      text,
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
    return;
  }

  const result = await tgCall("sendMessage", {
    chat_id: TELEGRAM_CHAT_ID,
    message_thread_id: TELEGRAM_TOPIC_ID,
    text,
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
  if (result && result.message_id) {
    room.telegramMessageId = result.message_id;
  }
}

// Called right before a public room is permanently deleted (everyone
// left / grace period expired) - edits the message one last time so
// it doesn't sit there forever looking joinable, then the room object
// itself is discarded by the caller.
async function markRoomMessageClosedForever(room) {
  if (!room || !room.isPublic || !room.telegramMessageId) return;
  await tgCall("editMessageText", {
    chat_id: TELEGRAM_CHAT_ID,
    message_id: room.telegramMessageId,
    text: `⚫ Room ${room.code} — closed (everyone left).`,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [] },
  });
}

async function handleRoomCommand(chatId, threadId) {
  const openRooms = Object.values(rooms).filter((r) => r.isPublic && !r.gameStarted);
  let text;
  if (openRooms.length === 0) {
    text = "😴 Abhi koi public room open nahi hai.\n\nNaya room banane ke liye /play bhejo!";
  } else {
    text =
      "🎮 *Open Rooms:*\n\n" +
      openRooms
        .map((r) => `🟢 *${r.code}* — ${Object.keys(r.players).length} player(s) waiting`)
        .join("\n");
  }
  const payload = { chat_id: chatId, text, parse_mode: "Markdown" };
  if (threadId) payload.message_thread_id = threadId;
  await tgCall("sendMessage", payload);
}

async function handlePlayCommand(chatId, threadId) {
  const payload = {
    chat_id: chatId,
    text: "🚀 Ready to play NEAR Saboteur?",
    reply_markup: {
      inline_keyboard: [[{ text: "▶️ Play Now", url: `https://t.me/${TELEGRAM_BOT_USERNAME}` }]],
    },
  };
  if (threadId) payload.message_thread_id = threadId;
  await tgCall("sendMessage", payload);
}

// Telegram delivers /room and /play commands here via webhook (set up
// automatically on server startup - see registerTelegramWebhook below).
// This is a completely separate Express route from Socket.io - it runs
// on its own request/response cycle and can never block, delay, or
// interfere with any game socket event.
app.post("/telegram-webhook", (req, res) => {
  // Acknowledge Telegram immediately - do this BEFORE any async work so
  // Telegram never sees a timeout/retry regardless of how long our own
  // processing or the outgoing sendMessage call takes.
  res.sendStatus(200);
  try {
    const update = req.body || {};
    const msg = update.message;
    if (!msg || typeof msg.text !== "string") return;
    const text = msg.text.trim().split("@")[0]; // strip "@BotName" suffix if present
    const chatId = msg.chat && msg.chat.id;
    const threadId = msg.message_thread_id;
    if (!chatId) return;

    if (text === "/room") {
      handleRoomCommand(chatId, threadId);
    } else if (text === "/play") {
      handlePlayCommand(chatId, threadId);
    }
  } catch (err) {
    console.warn("[Telegram webhook] error:", err.message);
  }
});

// Registers our webhook URL with Telegram on startup, so /room and
// /play commands actually reach the server. Uses Render's own
// auto-injected RENDER_EXTERNAL_URL env var when available, so this
// normally needs zero manual configuration beyond the bot token.
async function registerTelegramWebhook() {
  if (!TELEGRAM_API) {
    console.log("[Telegram] TELEGRAM_BOT_TOKEN not set - skipping webhook registration (group features disabled).");
    return;
  }
  const publicUrl = process.env.RENDER_EXTERNAL_URL || process.env.BACKEND_PUBLIC_URL;
  if (!publicUrl) {
    console.warn("[Telegram] No public URL available (RENDER_EXTERNAL_URL/BACKEND_PUBLIC_URL) - skipping webhook registration.");
    return;
  }
  const webhookUrl = `${publicUrl.replace(/\/$/, "")}/telegram-webhook`;
  const result = await tgCall("setWebhook", { url: webhookUrl });
  if (result !== null) {
    console.log(`[Telegram] Webhook registered at ${webhookUrl}`);
  }
}
// ============================================================
// END TELEGRAM GROUP INTEGRATION
// ============================================================

// [BUG FIX] Moved these to module level (previously declared inside the
// connection handler, duplicated per-socket) so the server can run its
// own authoritative meeting-stage timers (see callMeeting below) instead
// of relying entirely on every client's own local setTimeout to drive
// alarm->chat->voting->results. Client-side JS timers can be throttled
// or paused outright when a phone's screen locks or the Telegram app is
// backgrounded (e.g. switching to another chat) - if that happened to
// every connected client at once (or just the one whose timer firing
// happened to matter), the meeting could get stuck on "chat" forever,
// with no one ever transitioning to voting and no results ever showing.
// The server now drives this independently of any client's foreground
// state, guaranteeing the meeting always actually progresses.
const MEETING_ALARM_DURATION_MS = 3000;
const MEETING_CHAT_DURATION_MS = 150000;
const VOTING_DURATION_MS = 30000;
const MIN_MEETING_RESOLVE_MS = MEETING_ALARM_DURATION_MS + MEETING_CHAT_DURATION_MS + VOTING_DURATION_MS - 2000;

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
    // [LOBBY VISIBILITY FIX] Last-known Lobby percentage-position, kept
    // entirely separate from the in-game x/y above (different coordinate
    // space — see the lobbyMove handler's comment) so a newly-joined
    // player immediately sees everyone already wandering the Lobby room,
    // instead of waiting for each of them to move at least once first.
    lobbyX: p.lobbyX,
    lobbyY: p.lobbyY,
    // [BUG FIX] If this player currently has an active disguise, include
    // it here too - lets a newly-joined/reconnected client immediately
    // show the disguised avatar instead of waiting for a
    // playerDisguised event they may have missed entirely.
    disguiseAvatarId: p.disguiseAvatarId || null,
    // [NEW FEATURE] Whether this player has personally pressed "Return
    // to Lobby" after the last game ended - lets the Lobby's
    // player-list show who's actually back and ready, vs who's still on
    // their old win-screen.
    inLobbyView: p.inLobbyView || false,
    // [BUG FIX] If this player is dead and has a recorded body position,
    // include it here too - this is what lets a LATE-JOINING or
    // reconnecting player learn about bodies that were already on the
    // ground before they connected. Without this, they'd never see the
    // body at all (no cross/dim rendering, no Report option ever
    // appearing for them), since the original kill/vote-out event that
    // dropped the body would have happened before they were listening.
    bodyX: p.alive === false ? p.bodyX : undefined,
    bodyY: p.alive === false ? p.bodyY : undefined,
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
// [BUG FIX] If this socket is already attached to a DIFFERENT room
// (socket.data.roomCode set from a previous createRoom/joinRoom/
// reconnectToRoom in this same connection - e.g. a player who pressed
// "Rejoin Lobby" after a game without going through the explicit
// LEAVE button, then immediately created/joined a different room),
// this removes them from that old room properly first: leaving the
// underlying Socket.io room (so they stop receiving its broadcasts
// entirely), deleting their player-slot, and migrating host status if
// needed. Without this, Socket.io happily lets one socket belong to
// MULTIPLE rooms at once, which meant a player could end up receiving
// events from a room they'd supposedly left behind, and that room's
// player-list would never reflect them actually being gone.
function leaveCurrentRoomIfAny(io, socket) {
  const oldRoomCode = socket.data.roomCode;
  if (!oldRoomCode || !rooms[oldRoomCode]) return;
  const oldRoom = rooms[oldRoomCode];
  if (!oldRoom.players[socket.id]) return;

  const wasHost = oldRoom.players[socket.id].isHost;
  const wasGameStarted = oldRoom.gameStarted;
  // [BUG FIX] Same mission-progress preservation as leaveRoom/the
  // disconnect-grace-expiry handler - this is a THIRD path a player's
  // data can be deleted from a room mid-game through (switching to a
  // different room while still attached to this one), and without this
  // it reopened the exact same "leave with unfinished missions to dodge
  // the all-crewmates-done requirement" exploit those two fixes closed.
  if (wasGameStarted && oldRoom.players[socket.id].role === "crewmate" && oldRoom.players[socket.id].alive) {
    oldRoom.departedCrewmateMissions = oldRoom.departedCrewmateMissions || [];
    oldRoom.departedCrewmateMissions.push({
      missionsDone: oldRoom.players[socket.id].missionsDone || 0,
      missionsTotal: oldRoom.players[socket.id].missionsTotal || 0,
    });
  }
  delete oldRoom.players[socket.id];
  socket.leave(oldRoomCode);

  const remaining = Object.keys(oldRoom.players);
  if (remaining.length === 0) {
    markRoomMessageClosedForever(oldRoom); // [NEW FEATURE] fire-and-forget
    delete rooms[oldRoomCode];
    console.log(`Room ${oldRoomCode} deleted (empty after player moved to a different room)`);
  } else {
    if (wasHost) {
      oldRoom.players[remaining[0]].isHost = true;
      console.log(`Host migrated to ${remaining[0]} in room ${oldRoomCode} (previous host moved to a different room)`);
    }
    io.to(oldRoomCode).emit("playerListUpdated", { players: getPlayerList(oldRoomCode) });
    // [BUG FIX] Also re-check the win condition and refresh the shared
    // crew-progress meter for the room being left, same as the other two
    // departure paths - without this, this room's win-check would never
    // re-run just because someone vanished from it this way.
    if (wasGameStarted) {
      broadcastCrewProgress(oldRoomCode);
      checkWinCondition(oldRoomCode);
    }
  }
}

// [NEW FEATURE] Aggregate mission-progress meter, visible to EVERYONE in
// the room (crewmates, the Saboteur, and ghosts alike) - shows overall %
// of the crew's combined missions completed so far. Computed across ALL
// crewmates (alive AND dead/ghost - see the mission-win-condition fix
// above for why dead crewmates still count), summing raw done/total
// counts rather than averaging each player's individual % (so a 5-mission
// player and a 5-mission player both pull equal weight - there's currently
// only one mission-count per game anyway, but this stays correct even if
// that ever changes). The Saboteur never has missions, so they're
// naturally excluded just by filtering on role.
function computeCrewProgress(roomCode) {
  const room = rooms[roomCode];
  if (!room) return { percent: 0, done: 0, total: 0, minDone: 0 };
  const crewmates = Object.values(room.players).filter((p) => p.role === "crewmate");
  const departed = room.departedCrewmateMissions || [];
  let done = 0, total = 0;
  // [BUG FIX] Was only initialized to Infinity when crewmates.length > 0
  // - if every active crewmate had since left (only departed records
  // remain), minDone started at 0 instead, and Math.min(0, anything)
  // stays stuck at 0 forever regardless of the departed players' real
  // progress. Now correctly starts at Infinity whenever there's ANY
  // contributor at all (active or departed).
  let minDone = (crewmates.length + departed.length) > 0 ? Infinity : 0;
  crewmates.forEach((p) => {
    done += p.missionsDone || 0;
    total += p.missionsTotal || 0;
    minDone = Math.min(minDone, p.missionsDone || 0);
  });
  // [BUG FIX] Also include departed crewmates' progress as a floor on
  // minDone - if someone left with very few missions done, the vault
  // shouldn't unlock around them either (consistent with the missions-
  // complete win-condition fix using the same departed-crewmate data).
  departed.forEach((d) => {
    done += d.missionsDone || 0;
    total += d.missionsTotal || 0;
    minDone = Math.min(minDone, d.missionsDone || 0);
  });
  if (!Number.isFinite(minDone)) minDone = 0;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  return { percent, done, total, minDone };
}

function broadcastCrewProgress(roomCode) {
  io.to(roomCode).emit("crewProgressUpdated", computeCrewProgress(roomCode));
}

// [BUG FIX] Server-side kill-range enforcement. Mirrors the frontend's own
// KILL_RANGE_PX (TILE=22 * 2.4 = 52.8) - that frontend value only ever
// controlled whether the kill BUTTON appeared/worked locally; the server
// itself never actually checked it, so a modified client could send
// killPlayer for ANY targetId regardless of real distance and instakill
// someone clear across the map. A generous buffer (x1.6) is added on top
// of the frontend's own range purely to absorb normal network/position
// latency (a legitimate close-range kill shouldn't ever get rejected just
// because the server's last-known x/y is a tick or two stale) - this is
// NOT meant to allow longer-range kills, just to never falsely block a
// real one.
const SERVER_KILL_RANGE_PX = 22 * 2.4 * 1.6;

function checkWinCondition(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.winner) return false; // already decided, don't re-announce
  // [BUG FIX] Defensive guard - every current call site only ever calls
  // this once a game is actually running, but without this explicit
  // check, a future/accidental call before roles are assigned would see
  // every player's `role`/`alive` as undefined - aliveCrewmates would
  // compute as an empty array, and `0 < 2` would incorrectly declare an
  // instant "Saboteur wins by elimination" in an empty Lobby.
  if (!room.gameStarted) return false;

  const players = Object.values(room.players);
  const aliveCrewmates = players.filter((p) => p.role === "crewmate" && p.alive);
  const aliveSaboteurs = players.filter((p) => p.role === "saboteur" && p.alive);

  // Saboteur win: crewmates have dropped BELOW 2 (i.e. 0 or 1 remain).
  // [BUG FIX] Was previously "<= 2", which incorrectly ended the game
  // the moment exactly 2 crewmates remained (the explicit requirement
  // was that the game keeps going as long as AT LEAST 2 crewmates are
  // alive - only dropping to 1 or 0 should trigger this).
  // [BUG FIX #2] Also now requires at least one Saboteur to actually
  // still be alive - without this, a rare edge case (the Saboteur
  // leaving/disconnecting at nearly the same moment a crewmate also
  // drops out, leaving 0 Saboteurs AND <2 crewmates simultaneously)
  // could declare "Saboteur wins by elimination" even though there was
  // no Saboteur left in the game at all to claim that win.
  if (aliveCrewmates.length < 2 && aliveSaboteurs.length > 0) {
    room.winner = "saboteur";
    io.to(roomCode).emit("gameOver", { winner: "saboteur", reason: "elimination" });
    console.log(`Room ${roomCode}: Saboteur(s) win by elimination`);
    return true;
  }

  // Crewmate win #1: no Saboteurs left alive. [BUG FIX] Previously also
  // required `players.some(p => p.role === "saboteur")` to be true -
  // meant as a guard against an early-game false-positive (before any
  // roles were even assigned, when nobody has a role yet and
  // aliveSaboteurs being empty would otherwise incorrectly look like a
  // win). But that same check breaks if the Saboteur ever fully LEAVES
  // the room (their player object - role included - is deleted
  // entirely, so `.some(saboteur)` becomes false even though they
  // definitely existed and were just removed). room.gameStarted is a
  // more reliable guard for the same original purpose: it's only ever
  // true after roles have actually been assigned.
  if (room.gameStarted && aliveSaboteurs.length === 0) {
    room.winner = "crewmate";
    io.to(roomCode).emit("gameOver", { winner: "crewmate", reason: "saboteurEjected" });
    console.log(`Room ${roomCode}: Crewmates win - Saboteur ejected`);
    return true;
  }

  // Crewmate win #2: every CREWMATE (alive OR dead/ghost, AND any who've
  // since left the room) has finished every assigned mission.
  // [BUG FIX] Previously checked only aliveCrewmates - which meant if
  // every crewmate but one finished their missions, and the Saboteur
  // killed that exact one remaining (unfinished) crewmate, they'd vanish
  // from aliveCrewmates and the game would incorrectly declare an instant
  // Crewmate win, even though their missions were never actually
  // completed. Ghosts can still walk around and finish their own
  // missions after dying (see the frontend - mission rooms were never
  // actually alive-gated to begin with), so requiring ALL crewmates (not
  // just the living ones) to be done is both fair and achievable.
  // [BUG FIX #2] The SAME exploit existed via leaveRoom/disconnect-grace-
  // expiry too, in an even simpler form: a player object that LEAVES the
  // room (intentionally, or by letting their grace period expire) is
  // deleted from room.players entirely - so without this, a crewmate
  // could just deliberately quit with unfinished missions and the
  // remaining crewmates would win the instant THEIR OWN missions were
  // done, the departed one's incomplete missions never factored in at
  // all. room.departedCrewmateMissions (populated by leaveRoom and the
  // disconnect grace-expiry handler, right before they delete the player)
  // preserves just enough of a departed crewmate's mission state
  // (missionsDone/missionsTotal) to keep requiring it here too.
  const allCrewmates = players.filter((p) => p.role === "crewmate");
  const departedCrewmates = room.departedCrewmateMissions || [];
  const everyoneDone =
    allCrewmates.every((p) => p.missionsDone >= (p.missionsTotal || Infinity)) &&
    departedCrewmates.every((d) => d.missionsDone >= (d.missionsTotal || Infinity));
  if ((allCrewmates.length > 0 || departedCrewmates.length > 0) && everyoneDone) {
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
      // [BUG FIX] If the ejected player was mid-disguise, end it right
      // now - without this, a freshly-voted-out (now-ghost) Saboteur
      // would keep appearing disguised as someone else on everyone's
      // screen, even though they're dead and revealed.
      if (room.players[eliminatedId].disguiseAvatarId) {
        delete room.players[eliminatedId].disguiseAvatarId;
        delete room.players[eliminatedId].disguiseActiveUntil;
        io.to(roomCode).emit("playerDisguiseEnded", { id: eliminatedId });
      }
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

  // [BUG FIX] Same backlog delivery as the kill path - a player who was
  // just voted out had no way to see ghost chat history from before
  // their elimination.
  if (eliminatedId) {
    io.to(eliminatedId).emit("ghostChatBacklog", { messages: room.ghostChat || [] });
  }

  io.to(roomCode).emit("votingResult", {
    eliminatedId,
    eliminatedName: eliminatedId ? room.players[eliminatedId]?.name : null,
    // [NEW FEATURE] Reveal the eliminated player's role and avatar -
    // standard Among Us behavior: a player's true role is only ever
    // revealed once they're actually voted out, never before. Still
    // null for everyone else who's alive - this never leaks anything
    // about anyone who WASN'T just eliminated.
    eliminatedRole: eliminatedId ? room.players[eliminatedId]?.role : null,
    eliminatedAvatarId: eliminatedId ? room.players[eliminatedId]?.avatarId : null,
    voteCounts: counts,
    tie: topChoices.length > 1,
    clearedBodyIds,
    // [NEW FEATURE] Who-voted-for-whom, revealed ONLY now that voting is
    // fully over (never during voting itself, which stays suspenseful —
    // only the running totalVotes count is shown live via voteUpdate).
    // This is the same "everyone sees the breakdown after the fact"
    // behavior Among Us itself has on its results screen.
    votes,
  });

  console.log(`Voting result in room ${roomCode}: eliminated=${eliminatedId || "none"}`);

  // [BUG FIX] Same defensive resync as on meeting start - re-send every
  // still-alive Saboteur their own real sabotage-use counts now that the
  // meeting has ended, self-correcting any display drift regardless of
  // cause.
  Object.entries(room.players).forEach(([id, p]) => {
    if (p.role === "saboteur" && p.alive) {
      io.to(id).emit("sabotageStateSync", {
        sabotageUses: p.sabotageUses || { electricity: 3, hacker: 3, gateLeft: 5, gateRight: 5 },
        sabotageCooldownUntil: p.sabotageCooldownUntil || 0,
        disguiseCooldownUntil: p.disguiseCooldownUntil || 0,
        postKillSabotageLockUntil: p.postKillSabotageLockUntil || 0,
      });
    }
  });

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
  socket.on("createRoom", ({ name, avatarId, isPublic }) => {
    // [BUG FIX] Make sure we're not still attached to a previous room
    // before creating a brand new one - see leaveCurrentRoomIfAny.
    leaveCurrentRoomIfAny(io, socket);

    let code = generateRoomCode();
    // Extremely unlikely to collide, but check anyway for safety
    while (rooms[code]) {
      code = generateRoomCode();
    }

    const playerToken = generatePlayerToken();

    rooms[code] = {
      code,
      gameStarted: false,
      speedLevel: 3, // [UPDATED] Default 75% (was 50%) - the room creator can change this in the Lobby
      // [NEW FEATURE] Public rooms get auto-posted to the Telegram
      // group; private ones (the default) are never mentioned there.
      // Defensively coerced to a plain boolean so a tampered/odd client
      // payload can never end up as anything but true/false.
      isPublic: !!isPublic,
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
      speedLevel: rooms[code].speedLevel,
      isPublic: rooms[code].isPublic,
    });

    // [NEW FEATURE] Fire-and-forget - never awaited, so a slow/failed
    // Telegram call can never delay this player's own roomCreated
    // response or block the server in any way.
    postOrUpdateRoomMessage(rooms[code]);

    console.log(`Room ${code} created by ${name}${rooms[code].isPublic ? " (public)" : " (private)"}`);
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

    // [BUG FIX] If the game has already started, reject the join
    // outright - previously a brand-new player could still send
    // joinRoom mid-game and get silently added to room.players with no
    // role, no missions, and no spawn position, which produced a
    // confusing half-broken state (they'd show up in win-condition
    // calculations as neither a crewmate nor a Saboteur, etc.). A
    // reconnecting player who was already part of this game uses
    // reconnectToRoom instead, which is unaffected by this check.
    if (room.gameStarted) {
      socket.emit("joinError", { message: "This game has already started. Wait for it to end, or ask the host to start a new one." });
      return;
    }

    // [BUG FIX] Cap the room at 10 players - the game only has 10
    // predefined cafeteria spawn points (CAFETERIA_SPAWN_POINTS in the
    // frontend), and spawnIndex wraps around with a modulo once
    // playerIds exceeds that, meaning an 11th player would land on the
    // exact same spawn tile as the 1st - reintroducing the same
    // "overlapping/duplicate avatar" problem that was already fixed for
    // other causes. Rejecting the join outright here is what actually
    // prevents that from ever becoming possible again.
    const MAX_PLAYERS = 10;
    if (Object.keys(room.players).length >= MAX_PLAYERS) {
      socket.emit("joinError", { message: "This room is full (max 10 players)." });
      return;
    }

    // [BUG FIX] Make sure we're not still attached to a previous room
    // before joining this one - see leaveCurrentRoomIfAny. Done AFTER
    // confirming the target room exists, so a failed join attempt never
    // costs the player their current room membership.
    leaveCurrentRoomIfAny(io, socket);

    const playerToken = generatePlayerToken();
    // [AVATAR UNIQUENESS] Server-side enforcement — the client already
    // tries to prevent picking a taken avatar in its UI, but that's only
    // a courtesy check against whatever player-list the client last saw;
    // two players joining at nearly the same moment can both think an
    // avatar is free. The server is the actual authority: if the
    // requested avatarId is already in use by someone else in this room,
    // silently reassign whichever avatarId nobody else currently has,
    // rather than rejecting the join outright.
    const takenAvatarIds = new Set(Object.values(room.players).map((p) => p.avatarId));
    let finalAvatarId = avatarId;
    if (takenAvatarIds.has(avatarId)) {
      const allAvatarIds = ["purple", "green", "red", "black", "darkgreen", "magenta", "yellow", "brown", "orange", "cyan"];
      finalAvatarId = allAvatarIds.find((id) => !takenAvatarIds.has(id)) || avatarId;
    }
    room.players[socket.id] = { name, avatarId: finalAvatarId, isHost: false, playerToken };
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerToken = playerToken;

    const playerList = getPlayerList(roomCode);

    // Confirmation to the new player themself - includes the FINAL
    // avatarId (may differ from what was requested, if it had to be
    // reassigned above due to a conflict).
    socket.emit("roomJoined", {
      code: roomCode,
      players: playerList,
      playerToken,
      avatarId: finalAvatarId,
      // [NEW FEATURE] So a newly-joined player immediately sees whatever
      // speed the host has already set, not just the default.
      speedLevel: room.speedLevel || 3,
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
    // disconnected-grace-period state, and clean up the old key FIRST -
    // before force-disconnecting the old socket below, so that if the
    // old socket's own disconnect handler fires (synchronously or not),
    // it finds room.players[oldId] already gone and does nothing, rather
    // than re-triggering its own grace-period/host-migration logic for a
    // player slot that's already been moved to the new socket.id.
    delete playerData.disconnectedAt;
    delete room.players[oldId];
    room.players[socket.id] = playerData;

    // [BUG FIX] room.meeting.votes and room.meeting.skipDiscussionVotes
    // are both keyed by socket.id - without this, refreshing mid-meeting
    // left a player's already-cast vote/skip-vote stranded forever under
    // their OLD (now-disconnected) socket.id, where it kept being counted
    // in totals/percentages even though that id no longer matches anyone
    // in the room, WHILE their brand-new socket.id had no record of
    // having voted at all - letting them vote (or skip-vote) a second
    // time after a simple page refresh, and permanently inflating the
    // vote/skip counts with a phantom stale entry for the rest of that
    // meeting.
    if (room.meeting) {
      if (room.meeting.calledBy === oldId) {
        room.meeting.calledBy = socket.id;
      }
      // [BUG FIX] Chat messages store senderId too (used by the frontend
      // to decide isSelf / message alignment) - without migrating this
      // the same way votes/calledBy are migrated, a reconnecting player's
      // OWN earlier messages (sent under their old socket.id, before the
      // refresh) would stop matching their new socket.id and render as
      // if someone else had sent them.
      if (Array.isArray(room.meeting.messages)) {
        room.meeting.messages.forEach((m) => {
          if (m.senderId === oldId) m.senderId = socket.id;
        });
      }
      if (room.meeting.votes && Object.prototype.hasOwnProperty.call(room.meeting.votes, oldId)) {
        room.meeting.votes[socket.id] = room.meeting.votes[oldId];
        delete room.meeting.votes[oldId];
      }
      if (room.meeting.skipDiscussionVotes && Object.prototype.hasOwnProperty.call(room.meeting.skipDiscussionVotes, oldId)) {
        room.meeting.skipDiscussionVotes[socket.id] = room.meeting.skipDiscussionVotes[oldId];
        delete room.meeting.skipDiscussionVotes[oldId];
      }
    }

    // [BUG FIX] If the OLD socket is somehow still technically connected
    // server-side (the disconnect event hasn't been processed yet - this
    // can happen on a fast refresh, where the new connection establishes
    // before the old one's disconnect is detected), force it closed now
    // that its data has already been safely moved. Without this, there's
    // a brief window where BOTH the old and new socket.id exist as
    // "connected" from the server's point of view, and any late-arriving
    // event from the old socket (a queued playerMove, etc.) could still
    // go out under the old id - which is exactly what caused another
    // player's screen to briefly show TWO avatars for the same person
    // (one frozen under the stale id, one moving under the new one)
    // after a refresh.
    const oldSocket = io.sockets.sockets.get(oldId);
    if (oldSocket && oldSocket.connected) {
      oldSocket.disconnect(true);
    }

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerToken = playerToken;

    socket.emit("reconnected", {
      code: roomCode,
      players: getPlayerList(roomCode),
      role: playerData.role || null,
      alive: playerData.alive !== false,
      // [BUG FIX] Restore fellow-Saboteur info on reconnect - a
      // reconnecting Saboteur in a multi-Saboteur game previously lost
      // their partner list entirely on refresh.
      fellowSaboteurs: (playerData.role === "saboteur")
        ? Object.entries(room.players)
            .filter(([id, p]) => id !== socket.id && p.role === "saboteur")
            .map(([, p]) => ({ name: p.name, avatarId: p.avatarId }))
        : [],
      gameStarted: room.gameStarted || false,
      // [BUG FIX] Send back the player's own saved mission list (if any)
      // so a reconnecting client can restore its exact progress instead
      // of generating a fresh random set via pickRandomMissions() and
      // losing everything. Only ever relevant for crewmates (Saboteurs
      // never have a mission list to begin with) - undefined/missing
      // here just means "nothing saved yet" and the client falls back to
      // its normal first-assignment behavior.
      missionsList: playerData.missionsList || null,
      // [BUG FIX] Restore the server's authoritative sabotage/disguise
      // uses-left and cooldown state too - only meaningful for a
      // reconnecting Saboteur (a crewmate's client just ignores these
      // fields), but without this a refreshed Saboteur's client would
      // fall back to its own fresh defaults (3/3/5/5 uses, no cooldown)
      // even though the server's real counters had already been
      // decremented.
      sabotageUses: playerData.sabotageUses || null,
      sabotageCooldownUntil: playerData.sabotageCooldownUntil || 0,
      // [BUG FIX] Restore the Saboteur's kill-cooldown too - was never
      // sent before, so a Saboteur who refreshed shortly after a kill saw
      // their kill button looking ready again immediately (even though
      // the server's own killer.killCooldownUntil check would still
      // correctly reject an actual attempt) - purely a UI-truthfulness
      // gap, not an exploit, but worth matching reality.
      killCooldownUntil: playerData.killCooldownUntil || 0,
      // [BUG FIX] Same UI-truthfulness fix as killCooldownUntil above -
      // these two were never sent back on reconnect either, so a
      // refreshed client's UI could show "Call Meeting" or sabotage
      // actions as available when the server would actually still
      // reject them.
      meetingCooldownUntil: room.meetingCooldownUntil || 0,
      postKillSabotageLockUntil: playerData.postKillSabotageLockUntil || 0,
      disguiseUsesLeft: typeof playerData.disguiseUsesLeft === 'number' ? playerData.disguiseUsesLeft : null,
      disguiseCooldownUntil: playerData.disguiseCooldownUntil || 0,
      // [BUG FIX] Restore the reconnecting player's OWN active disguise
      // too (if they refreshed mid-disguise) - their own client's local
      // disguiseActive state previously had no way to know this was still
      // running server-side, so their own screen incorrectly reverted to
      // "not disguised" (wrong displayedAvatarId, missing countdown
      // badge) even though everyone else still correctly saw them
      // disguised the whole time.
      activeDisguise: (playerData.disguiseAvatarId && playerData.disguiseActiveUntil > Date.now())
        ? { avatarId: playerData.disguiseAvatarId, endsAt: playerData.disguiseActiveUntil }
        : null,
      // [BUG FIX] Sync the CURRENT sabotage state on reconnect too - a
      // player who reconnects mid-sabotage previously had no way to
      // learn about it except the original broadcast they may have
      // missed entirely.
      activeGateLock: room.activeGateLock || null,
      activeSabotageType: room.activeSabotageType || null,
      // [BUG FIX] If a meeting is currently active, send its full
      // current state too - this is THE fix for a late-joining or
      // reconnecting player staying stuck on the regular game screen
      // (Assembly Hall etc.) while everyone else is in a chat/voting
      // screen they have no idea exists. Mirrors exactly what
      // meetingStarted/meetingStageChanged/chatMessageReceived would
      // have sent if they'd been online for all of it - same shape, so
      // the client can build its local meeting object from this exactly
      // like it would from those individual events combined.
      activeMeeting: room.meeting ? {
        stage: room.meeting.stage,
        startedAt: room.meeting.startedAt,
        reason: room.meeting.reason,
        messages: room.meeting.messages || [],
        deadPlayerNames: Object.values(room.players).filter((p) => !p.alive).map((p) => p.name),
        calledBy: room.meeting.calledBy,
        // Live vote state too, so a reconnecting player sees who's
        // already voted/skipped instead of an empty board.
        liveVotes: room.meeting.votes || {},
      } : null,
      // [NEW FEATURE] If this reconnecting player is a ghost, give them
      // the ghost chat history too - never sent at all if they're alive,
      // same structural privacy guarantee as the live channel itself.
      ghostChat: (playerData.alive === false) ? (room.ghostChat || []) : null,
      // [NEW FEATURE] So a reconnecting player's crew-progress meter
      // shows the correct live value immediately instead of sitting at
      // 0% until the next mission update happens to come in from
      // someone else.
      crewProgress: room.gameStarted ? computeCrewProgress(roomCode) : null,
    });

    io.to(roomCode).emit("playerListUpdated", { players: getPlayerList(roomCode) });
    // [BUG FIX] If a meeting/voting is active, broadcast the server's
    // authoritative (already-migrated) vote map to the WHOLE room, not
    // just back to the reconnecting player - otherwise every OTHER
    // client's local liveVotes still has the stale OLD socket.id as a
    // key, and the playerListUpdated broadcast just above prunes that
    // old id from their otherPlayers state, making the reconnecting
    // player's already-cast vote silently vanish from view on everyone
    // else's screen (it was never actually lost server-side, only
    // displayed wrong).
    if (room.meeting) {
      io.to(roomCode).emit("meetingVotesSync", {
        votes: room.meeting.votes || {},
        skipDiscussionVotes: room.meeting.skipDiscussionVotes || {},
      });
    }

    console.log(`${playerData.name} reconnected to room ${roomCode}`);
  });

  // ---- LEAVE ROOM (explicit, e.g. pressing the Lobby's LEAVE button) ----
  // Client sends nothing. [BUG FIX] Without this, pressing LEAVE only
  // ever changed the LOCAL screen (back to a "you left" message) and
  // cleared localStorage, but never told the server anything - the
  // underlying socket connection stayed fully alive and the player
  // stayed in room.players exactly as before, until the tab/browser was
  // eventually closed (triggering the normal disconnect handler) or the
  // grace period ran out. If the player then created/joined a DIFFERENT
  // room in the same tab without a page reload, the same socket.id would
  // now belong to two rooms' worth of expectations at once. This
  // explicitly and immediately removes them from their current room the
  // moment they press LEAVE, the same way a real disconnect would,
  // rather than waiting on one.
  socket.on("leaveRoom", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!roomCode || !room) return;

    const wasHost = room.players[socket.id]?.isHost;
    // [BUG FIX] If the game has already started, an explicit LEAVE is
    // treated as immediately and permanently gone (unlike a disconnect,
    // which gets a grace period for a possible reconnect) - this is a
    // deliberate choice the player made, not a dropped connection. Mark
    // them dead so they're correctly excluded from alive-player counts,
    // and re-run the win-check immediately, since their leaving could be
    // exactly the moment a side wins (e.g. the second-to-last crewmate
    // leaving on purpose). Previously this whole case fell through
    // straight to deletion below with no death-marking or win-check at
    // all, silently leaving stale alive-counts behind.
    const wasGameStarted = room.gameStarted;
    const wasAliveBeforeLeave = wasGameStarted && room.players[socket.id] ? room.players[socket.id].alive : false;
    if (wasGameStarted && room.players[socket.id]) {
      room.players[socket.id].alive = false;
    }
    // [BUG FIX / FEATURE] Preserve a departing CREWMATE's mission
    // progress before their player object is deleted below, but ONLY if
    // they were still ALIVE when they left (the original anti-exploit
    // fix - see checkWinCondition's departedCrewmateMissions comment). A
    // crewmate who was ALREADY a ghost when they left can never finish
    // their mission again either way, so requiring it forever would make
    // the missions-complete win path permanently impossible for the
    // remaining crew - their mission is fully excluded instead, exactly
    // as requested.
    if (wasGameStarted && room.players[socket.id] && room.players[socket.id].role === "crewmate" && wasAliveBeforeLeave) {
      room.departedCrewmateMissions = room.departedCrewmateMissions || [];
      room.departedCrewmateMissions.push({
        missionsDone: room.players[socket.id].missionsDone || 0,
        missionsTotal: room.players[socket.id].missionsTotal || 0,
      });
    }

    delete room.players[socket.id];
    socket.leave(roomCode);
    socket.data.roomCode = null;
    socket.data.playerToken = null;

    const remaining = Object.keys(room.players);
    if (remaining.length === 0) {
      markRoomMessageClosedForever(room); // [NEW FEATURE] fire-and-forget
      delete rooms[roomCode];
      console.log(`Room ${roomCode} deleted (empty after explicit leave)`);
    } else {
      if (wasHost) {
        room.players[remaining[0]].isHost = true;
        console.log(`Host migrated to ${remaining[0]} in room ${roomCode} (after explicit leave)`);
      }
      io.to(roomCode).emit("playerListUpdated", { players: getPlayerList(roomCode) });
      // [BUG FIX] Also let everyone know this player is gone mid-game
      // (no body, no cutscene - same treatment a disconnect-then-
      // grace-expiry gets), and re-check the win condition now that the
      // alive-count has changed.
      if (wasGameStarted) {
        io.to(roomCode).emit("playerDisconnectedMidGame", { playerId: socket.id });
        broadcastCrewProgress(roomCode);
        checkWinCondition(roomCode);
      }
    }
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
    // [BUG FIX] createRoom/joinRoom both explicitly avoid handing out an
    // avatarId someone else in the room already has - this handler (used
    // whenever a player reopens the avatar/name editor LATER, after
    // already being in the Lobby) had no such check at all, so two
    // players could end up looking identical just by one of them editing
    // their profile after the fact. Silently ignore the avatarId change
    // if it collides with another player already in the room (keep
    // whatever they had before) rather than letting the collision happen.
    if (typeof avatarId === "string" && avatarId) {
      const takenByOther = Object.entries(room.players).some(
        ([id, p]) => id !== socket.id && p.avatarId === avatarId
      );
      if (!takenByOther) {
        room.players[socket.id].avatarId = avatarId;
      } else {
        socket.emit("profileUpdateError", { message: "That avatar is already taken." });
      }
    }

    io.to(roomCode).emit("playerListUpdated", { players: getPlayerList(roomCode) });
  });

  // ---- RETURN TO LOBBY (any player, individually) ----
  // Client sends nothing. [NEW FEATURE] Lets ANY player (not just the
  // host) send their own screen back to the Lobby after a game ends,
  // independently of when/whether other players do the same - each
  // player's own client decides when to navigate itself, this event
  // just tells the server "this game is over, reset shared state for
  // whoever's still here." The very FIRST player to press this resets
  // the room's shared game-state (same fields playAgainSameRoom always
  // reset) - subsequent presses from other players are harmless no-ops
  // against an already-reset room. Crucially, this does NOT force
  // anyone else's screen to change; other players' clients only react
  // to playerListUpdated for the room-member-list panel display - they
  // stay on their own win-screen until they personally also choose to
  // return.
  socket.on("returnToLobby", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    if (!room.players[socket.id]) return;

    room.players[socket.id].inLobbyView = true;

    // Already reset (someone else returned first) - nothing left to do
    // for the shared room-state, but still notify everyone so the
    // Lobby's player-list panel reflects that THIS player is now back.
    if (!room.gameStarted) {
      io.to(roomCode).emit("playerListUpdated", { players: getPlayerList(roomCode) });
      return;
    }

    room.gameStarted = false;
    delete room.winner;
    delete room.meeting;
    delete room.meetingCooldownUntil;
    delete room.speedLevel;
    delete room.activeGateLock;
    delete room.activeSabotageType;
    delete room.departedCrewmateMissions;
    delete room.ghostChat; // [BUG FIX] Clear ghost chat between games

    // [NEW FEATURE] Public room is joinable again - reuses the same
    // Telegram message (no spam). Fire-and-forget.
    postOrUpdateRoomMessage(room);

    Object.values(room.players).forEach((p) => {
      delete p.role;
      delete p.alive;
      delete p.missionsDone;
      delete p.missionsList;
      delete p.sabotageUses;
      delete p.sabotageCooldownUntil;
      delete p.disguiseUsesLeft;
      delete p.disguiseCooldownUntil;
      delete p.postKillSabotageLockUntil;
      delete p.missionsTotal;
      delete p.killCooldownUntil;
      delete p.x;
      delete p.y;
      delete p.bodyX;
      delete p.bodyY;
      delete p.disguiseAvatarId;
      delete p.inVent;
    });

    io.to(roomCode).emit("playerListUpdated", { players: getPlayerList(roomCode) });
    console.log(`Room ${roomCode} reset for Lobby return (triggered by ${room.players[socket.id]?.name || socket.id})`);

    // [NEW FEATURE] If the HOST specifically doesn't return to the Lobby
    // within 1 minute of someone else triggering this reset, promote
    // whichever OTHER player has already returned (inLobbyView) to host,
    // so the room never gets stuck waiting on a host who's still sitting
    // on their old win-screen (or has walked away entirely).
    const hostId = Object.keys(room.players).find((id) => room.players[id].isHost);
    if (hostId && hostId !== socket.id) {
      setTimeout(() => {
        const stillRoom = rooms[roomCode];
        if (!stillRoom || !stillRoom.players[hostId]) return;
        if (stillRoom.players[hostId].inLobbyView) return; // host came back in time
        if (stillRoom.gameStarted) return; // a new game already started since
        const candidateId = Object.keys(stillRoom.players).find(
          (id) => id !== hostId && stillRoom.players[id].inLobbyView
        );
        if (candidateId) {
          stillRoom.players[hostId].isHost = false;
          stillRoom.players[candidateId].isHost = true;
          io.to(roomCode).emit("playerListUpdated", { players: getPlayerList(roomCode) });
          console.log(`Host migrated to ${candidateId} in room ${roomCode} (previous host didn't return to Lobby within 1 min)`);
        }
      }, 60 * 1000);
    }
  });

  // ---- PLAY AGAIN (SAME ROOM) ----
  // Client sends nothing - only the host can trigger this. [NEW FEATURE]
  // Resets the room back to its pre-game Lobby state WITHOUT removing
  // any players, so everyone ends up back in the SAME room together
  // (same room code, same avatars/names/host) instead of each player's
  // "Back to Lobby" button independently reloading their own page and
  // scattering into separate fresh sessions. Each client still resets its
  // own local game-progress (missions, wallet, etc.) on the frontend side
  // when this arrives - this event only resets the SHARED room state the
  // server is responsible for (roles, alive-status, meeting, winner).
  socket.on("playAgainSameRoom", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;

    if (!room.players[socket.id] || !room.players[socket.id].isHost) {
      socket.emit("playAgainError", { message: "Only the host can start a new game." });
      return;
    }

    room.gameStarted = false;
    delete room.winner;
    delete room.meeting;
    delete room.meetingCooldownUntil;
    delete room.speedLevel;
    // [BUG FIX] These two were already cleared by returnToLobby but were
    // missing here - if a game ended (gameOver) while a gate-lock or
    // electricity/hacker sabotage was still active, that stale state
    // would otherwise leak straight into the next game via this same
    // room object, and a reconnecting/late-joining player in the NEW
    // game would receive it as if it were real (see reconnectToRoom's
    // activeGateLock/activeSabotageType fields).
    delete room.activeGateLock;
    delete room.activeSabotageType;
    delete room.departedCrewmateMissions;
    delete room.ghostChat; // [BUG FIX] Clear ghost chat between games

    // [NEW FEATURE] Public room is joinable again - reuses the same
    // Telegram message (no spam). Fire-and-forget.
    postOrUpdateRoomMessage(room);

    Object.values(room.players).forEach((p) => {
      delete p.role;
      delete p.alive;
      delete p.missionsDone;
      delete p.missionsList;
      delete p.sabotageUses;
      delete p.sabotageCooldownUntil;
      delete p.disguiseUsesLeft;
      delete p.disguiseCooldownUntil;
      delete p.postKillSabotageLockUntil;
      delete p.missionsTotal;
      delete p.killCooldownUntil;
      delete p.x;
      delete p.y;
      delete p.bodyX;
      delete p.bodyY;
      // [BUG FIX] Was also missing here (returnToLobby already had it) -
      // a leftover disguiseAvatarId would otherwise make a player show up
      // disguised as someone else from the very first frame of the new
      // game, before they've even pressed anything.
      delete p.disguiseAvatarId;
      delete p.inVent;
    });

    io.to(roomCode).emit("roomResetForNewGame", { players: getPlayerList(roomCode) });
    console.log(`Room ${roomCode} reset for a new game by the host`);
  });

  // ---- START GAME (host only) ----
  // Client sends: { imposterCount }
  // This secretly makes random player(s) the Saboteur.
  // [MULTIPLAYER: SHARED] - role decisions happen on the server; no client
  // ever learns another player's role, only their own.
  socket.on("startGame", ({ imposterCount, speedLevel }) => {
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

    // [BUG FIX] Raised from 2 to 4 - this matches MIN_PLAYERS=4 in the
    // frontend (where the Lobby's own Start button is already disabled
    // below that count), but the server itself only ever required 2.
    // Normal play could never actually hit this gap (the button being
    // disabled already prevents it), but the server is supposed to be
    // the authoritative check regardless of what any particular client
    // does or doesn't enforce in its own UI.
    const MIN_PLAYERS = 4;
    if (playerIds.length < MIN_PLAYERS) {
      socket.emit("startGameError", { message: `Need at least ${MIN_PLAYERS} players.` });
      return;
    }

    // [BUG FIX] Clamp imposterCount to a valid range - was "never more
    // than players-1", which let a host pick e.g. 3 Saboteurs with only
    // 4 players, leaving just 1 crewmate. Since checkWinCondition's
    // Saboteur-elimination-win rule requires aliveCrewmates to STAY at 2
    // or more the entire game, starting with only 1 crewmate already
    // violates that the instant any win-check runs - the game becomes
    // mathematically unwinnable for crewmates from the very first
    // mission report or kill. Now always leaves at least 2 crewmates.
    let saboteurCount = imposterCount || 1;
    saboteurCount = Math.max(1, Math.min(saboteurCount, playerIds.length - 2));

    // [NEW FEATURE] Speed level: 1-5, mapping to 25%/50%/75%/100%/125% of
    // the reference MOVE_SPEED (the frontend treats level 2/50% as the
    // original baseline speed the game shipped with). Clamped here too,
    // server-side, so a tampered client can't request an out-of-range
    // value - defaults to 2 (50%, the original speed) if not provided.
    let clampedSpeedLevel = Number.isInteger(speedLevel) ? speedLevel : (room.speedLevel || 3);
    clampedSpeedLevel = Math.max(1, Math.min(5, clampedSpeedLevel));
    room.speedLevel = clampedSpeedLevel;

    // Shuffle players and make the first N the Saboteur(s) (Fisher-Yates shuffle)
    const shuffled = [...playerIds];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const saboteurIds = new Set(shuffled.slice(0, saboteurCount));

    room.gameStarted = true;
    // [NEW FEATURE] Reflect "in progress / not joinable" in the group
    // message for public rooms. Fire-and-forget, never blocks the
    // actual game-start flow below.
    postOrUpdateRoomMessage(room);
    // [BUG FIX] Explicitly clear any leftover winner from a previous
    // game in this room - without this, if a stale room object somehow
    // survived (e.g. a race during room cleanup) into a fresh game, the
    // very first checkWinCondition call (from any source - a mission
    // report, a kill, etc.) would see room.winner already set and
    // either silently refuse to announce a real winner later, or in
    // combination with frontend state, contribute to an immediate
    // incorrect win announcement.
    delete room.winner;
    // [BUG FIX] Defensively clear ALL stale per-game state at game start,
    // so a fresh game can never inherit leftovers from a previous round
    // in this same room object (ghost chat, an old meeting, corpses,
    // active disguises/sabotages, old mission progress, or a stale
    // disconnect-grace flag) even if some reset path didn't run first.
    delete room.meeting;
    delete room.ghostChat;
    delete room.activeGateLock;
    delete room.activeSabotageType;
    delete room.departedCrewmateMissions;
    Object.values(room.players).forEach((p) => {
      delete p.bodyX; delete p.bodyY;
      delete p.disguiseAvatarId; delete p.disguiseActiveUntil;
      delete p.disconnectedAt;
      delete p.missionsList; delete p.missionsDone; delete p.missionsTotal;
      delete p.sabotageUses; delete p.sabotageCooldownUntil;
      delete p.disguiseCooldownUntil; delete p.postKillSabotageLockUntil;
      delete p.inVent;
    });
    // No meeting can be called within the first 30s of the game starting.
    room.meetingCooldownUntil = Date.now() + 30000;

    // [NEW FEATURE] Clear everyone's inLobbyView flag for the fresh
    // round of "did you return to the Lobby" tracking that the NEXT
    // game-over will need.
    Object.values(room.players).forEach((p) => { delete p.inLobbyView; });

    // Send each player ONLY their own role - nobody learns another player's role.
    // [SPAWN FIX] Also assign each player a unique spawnIndex (just their
    // position in playerIds, 0..N-1) so they each land on a different one
    // of the cafeteria's predefined spawn points instead of everyone
    // spawning on the exact same tile and getting stuck inside each other.
    // [NEW FEATURE] When there are 2+ Saboteurs, each one ALSO gets a
    // list of their fellow Saboteurs (name + avatarId, not socket ids -
    // they don't need ids for anything client-side here, and not
    // sending them is one less thing to accidentally leak). Built
    // per-Saboteur with their own id filtered out (using socket id for
    // the exclusion - never name/avatarId, since two players could
    // coincidentally share a display name). Sent ONLY to Saboteur
    // sockets - crewmates never receive this field at all, so there's
    // no way for the role to leak through it.
    const saboteurIdList = playerIds.filter((id) => saboteurIds.has(id));

    playerIds.forEach((id, spawnIndex) => {
      const role = saboteurIds.has(id) ? "saboteur" : "crewmate";
      room.players[id].role = role;
      room.players[id].alive = true;
      const payload = { role, spawnIndex, speedLevel: clampedSpeedLevel, alive: true, saboteurCount };
      if (role === "saboteur" && saboteurCount > 1) {
        payload.fellowSaboteurs = saboteurIdList
          .filter((sid) => sid !== id)
          .map((sid) => ({ name: room.players[sid].name, avatarId: room.players[sid].avatarId }));
      }
      io.to(id).emit("roleAssigned", payload);
    });

    console.log(`Game started in room ${roomCode}. ${saboteurCount} saboteur(s) assigned. Speed level: ${clampedSpeedLevel}.`);
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
    // [LOBBY VISIBILITY FIX] Store the position too (not just forward
    // it) - this is what lets a newly-joined player's getPlayerList
    // immediately include where everyone already is, instead of
    // everyone appearing invisible until they personally move at least
    // once.
    const player = room.players[socket.id];
    if (player) {
      player.lobbyX = x;
      player.lobbyY = y;
    }
    socket.to(roomCode).emit("lobbyMoved", { id: socket.id, x, y });
  });

  // ---- LOBBY SPEED CHANGE (host-only, live preview for everyone) ----
  // Client sends: { speedLevel } - 1-5
  // [NEW FEATURE] Lets every player in the Lobby feel/see the host's
  // chosen movement speed live, BEFORE the game even starts - not just
  // once roleAssigned arrives. Stored on the room (so a newly-joined
  // player picks up the current value via roomCreated/roomJoined too,
  // not just players already present when the host changes it) and
  // also applied as the actual default once the game starts (startGame
  // falls back to room.speedLevel if the host doesn't explicitly send a
  // different one).
  socket.on("lobbySpeedChange", ({ speedLevel }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    if (!room.players[socket.id] || !room.players[socket.id].isHost) return;

    let clamped = Number.isInteger(speedLevel) ? speedLevel : 2;
    clamped = Math.max(1, Math.min(5, clamped));
    room.speedLevel = clamped;

    io.to(roomCode).emit("lobbySpeedChanged", { speedLevel: clamped });
  });

  // ---- VENT TRAVEL (Saboteur only, but visible to everyone nearby) ----
  // Client sends: { phase, roomId } - phase is 'enter' | 'travel' | 'exit'
  // [BUG FIX] Previously vent travel was 100% client-side local state -
  // the Saboteur's own screen played the squish-in/out animation
  // correctly, but no other player ever learned about it at all. Since
  // a player's position broadcast also stops while they're "inside" a
  // vent (nothing to send - they're not moving through normal space),
  // anyone nearby just saw the Saboteur's avatar freeze in place and
  // stay fully visible the whole time, which is exactly what gave away
  // who the Saboteur was. Now the server relays vent state to everyone
  // in the room, so a Saboteur's avatar actually disappears (with the
  // same squish animation) on every other player's screen too, at the
  // same moment it does on their own.
  socket.on("ventTravel", ({ phase, roomId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player || player.role !== "saboteur" || !player.alive) return;

    // [BUG FIX] Track this server-side too (not just relay it to other
    // clients) - without it, killPlayer/sabotageAction had no way to
    // know a Saboteur was mid-vent-travel, so a stale frozen kill-button
    // (the frontend's own movement/proximity loop pauses entirely while
    // inVent, but doesn't necessarily hide an already-shown button)
    // could still successfully kill someone while the Saboteur was
    // supposedly "inside the walls" - logically inconsistent with the
    // whole point of venting.
    player.inVent = phase !== "exit";

    socket.to(roomCode).emit("playerVentTravel", { id: socket.id, phase, roomId });
  });

  // ---- ACTIVATE DISGUISE (Saboteur only, visible to everyone) ----
  // Client sends: { avatarId } - the avatar the Saboteur is disguising as
  // [BUG FIX] Disguise was previously 100% local-only - the Saboteur's
  // own screen correctly showed them as the chosen avatar, but every
  // OTHER player's otherPlayers entry for that Saboteur never changed,
  // so everyone else kept seeing the Saboteur's real avatar the whole
  // time the disguise was supposedly active, completely defeating the
  // point of disguising in the first place. The server now relays this
  // (and the matching disguiseEnded once the timer runs out) to the
  // whole room, so every player's screen shows the same disguised
  // avatar for that player, for the same duration.
  socket.on("activateDisguise", ({ avatarId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    // [BUG FIX] Same post-game-end guard as killPlayer/sabotageAction.
    if (room.winner || !room.gameStarted) return;
    const player = room.players[socket.id];
    if (!player || player.role !== "saboteur" || !player.alive) return;
    if (!avatarId) return;
    // [BUG FIX] Consistent with kill/sabotage - no disguising mid-meeting
    // either (voting cards always show everyone's real identity anyway,
    // so there'd be no point, but block it server-side too for safety).
    if (room.meeting) {
      socket.emit("sabotageError", { message: "Cannot disguise during a meeting." });
      return;
    }

    // [BUG FIX] Server-side uses-left + cooldown enforcement - same
    // exploit concern as sabotageAction above: disguiseUsesLeft/
    // disguiseCooldownUntil were purely client-side (DISGUISE_MAX_USES=3,
    // DISGUISE_COOLDOWN_MS=30000), so a page refresh silently restored a
    // Saboteur's full 3 disguise uses and cleared any cooldown.
    const now = Date.now();
    if (typeof player.disguiseUsesLeft !== 'number') {
      player.disguiseUsesLeft = 3;
    }
    if (player.disguiseUsesLeft <= 0) {
      socket.emit("sabotageError", { message: "No disguise uses left." });
      return;
    }
    if (player.disguiseCooldownUntil && now < player.disguiseCooldownUntil) {
      socket.emit("sabotageError", { message: "Disguise is on cooldown." });
      return;
    }
    player.disguiseUsesLeft -= 1;
    player.disguiseCooldownUntil = now + 30000;

    player.disguiseAvatarId = avatarId;
    // [BUG FIX] Track exactly when this disguise expires - needed so a
    // reconnecting Saboteur (their OWN client, after a refresh mid-
    // disguise) can restore their local disguiseActive countdown with the
    // correct remaining time, instead of it just resetting to "not
    // disguised" on their own screen even though the server still has it
    // active (and other players still correctly see them disguised).
    player.disguiseActiveUntil = now + 15000;
    io.to(roomCode).emit("playerDisguised", { id: socket.id, avatarId });

    // Auto-clear after the same 15s duration the frontend's own
    // DISGUISE_DURATION_MS uses, in case the disguiseEnded event from the
    // Saboteur's own client (sent when their local timer runs out) is
    // ever missed - this is a server-side safety net, not the primary
    // mechanism.
    setTimeout(() => {
      if (room.players[socket.id] && room.players[socket.id].disguiseAvatarId === avatarId) {
        delete room.players[socket.id].disguiseAvatarId;
        delete room.players[socket.id].disguiseActiveUntil;
        io.to(roomCode).emit("playerDisguiseEnded", { id: socket.id });
      }
    }, 15000);
  });

  // ---- END DISGUISE (Saboteur explicitly ending their own disguise) ----
  // Client sends nothing — just signals their local 15s timer ran out.
  // [BUG FIX] Lets every other player's screen revert the Saboteur's
  // displayed avatar back to their real one at the exact moment the
  // Saboteur's own client does, rather than relying solely on the
  // server's own delayed safety-net timer (see activateDisguise above).
  socket.on("endDisguise", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.players[socket.id]) return;
    delete room.players[socket.id].disguiseAvatarId;
    delete room.players[socket.id].disguiseActiveUntil;
    io.to(roomCode).emit("playerDisguiseEnded", { id: socket.id });
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
    // [BUG FIX] Reject any game action once the game has already ended -
    // see the comment above this handler for why.
    if (room.winner || !room.gameStarted) {
      socket.emit("killError", { message: "The game has already ended." });
      return;
    }

    const killer = room.players[socket.id];
    const target = room.players[targetId];

    // Security checks - the server verifies this itself, never trusting the client
    if (!killer || killer.role !== "saboteur") {
      socket.emit("killError", { message: "You are not the Saboteur." });
      return;
    }
    // [BUG FIX] No kill checks ever stopped this from happening DURING an
    // active meeting (alarm/chat/voting) - everyone's frozen on the
    // meeting screen at that point and shouldn't be killable at all, same
    // as Among Us. A modified client could otherwise sneak a kill in
    // mid-discussion.
    if (room.meeting) {
      socket.emit("killError", { message: "Cannot kill during a meeting." });
      return;
    }
    // [BUG FIX] Same logic as the meeting-block above - a Saboteur who's
    // currently inside a vent (between an 'enter' and matching 'exit')
    // shouldn't be able to kill, since they're supposed to be physically
    // tucked away in the walls at that moment, not standing next to
    // anyone.
    if (killer.inVent) {
      socket.emit("killError", { message: "Cannot kill while inside a vent." });
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
    // [BUG FIX] Server-side proximity check - the killer's and target's
    // last-known positions (kept up to date via every playerMove) must be
    // within SERVER_KILL_RANGE_PX of each other. Without this, the only
    // thing stopping a remote/cross-map kill was the frontend's own
    // button-visibility logic, which a modified client trivially bypasses
    // by just emitting killPlayer directly.
    if (
      typeof killer.x !== "number" || typeof killer.y !== "number" ||
      typeof target.x !== "number" || typeof target.y !== "number" ||
      Math.hypot(killer.x - target.x, killer.y - target.y) > SERVER_KILL_RANGE_PX
    ) {
      socket.emit("killError", { message: "Target is too far away." });
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
    // [BUG FIX] Server-side mirror of the frontend's postKillLockUntil
    // (20s sabotage lockdown after any kill) - set here so the
    // server-side sabotage check above can actually enforce it too,
    // not just block based on its own independent cooldown.
    killer.postKillSabotageLockUntil = now + 20000;

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
    // [BUG FIX] A player who just died had no way to see ghost chat
    // history from before their death - they'd only get messages going
    // forward via the live listener. Send them the existing backlog now.
    io.to(targetId).emit("ghostChatBacklog", { messages: room.ghostChat || [] });

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

    console.log(`${target.name} was killed by ${killer.name} in room ${roomCode}`);

    // [WIN CONDITION] A kill can immediately end the game if crewmates
    // are now too few relative to Saboteurs - check right away rather
    // than waiting for the next meeting.
    checkWinCondition(roomCode);
  });

  // ---- SABOTAGE ACTION (Saboteur only) ----
  // Client sends: { type } - "electricity" | "hacker" | "gateLeft" | "gateRight"
  // [MULTIPLAYER: SHARED] - server validates the role, then tells every
  // player. Cooldown/timing logic still lives client-side (already built
  // into the frontend) - the server just broadcasts "this action happened".
  socket.on("sabotageAction", ({ type }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    // [BUG FIX] Same post-game-end guard as killPlayer.
    if (room.winner || !room.gameStarted) {
      socket.emit("sabotageError", { message: "The game has already ended." });
      return;
    }

    const player = room.players[socket.id];

    if (!player || player.role !== "saboteur") {
      socket.emit("sabotageError", { message: "You are not the Saboteur." });
      return;
    }
    if (!player.alive) {
      socket.emit("sabotageError", { message: "You are already dead." });
      return;
    }
    // [BUG FIX] Same fix as killPlayer - sabotage shouldn't be triggerable
    // while everyone's frozen in an active meeting either.
    if (room.meeting) {
      socket.emit("sabotageError", { message: "Cannot sabotage during a meeting." });
      return;
    }
    if (player.inVent) {
      socket.emit("sabotageError", { message: "Cannot sabotage while inside a vent." });
      return;
    }

    // [BUG FIX] Was "lockLeft"/"lockRight" here, but the frontend has
    // always sent "gateLeft"/"gateRight" (see triggerSabotageAction's
    // key->serverType mapping) - meaning EVERY gate-lock sabotage attempt
    // was silently failing this validTypes check and returning a
    // sabotageError the whole time, never actually reaching the code
    // below that's supposed to set room.activeGateLock. This was a
    // contributing root cause of "gate lock doesn't work for anyone" -
    // not just the activeGateLock state-sync gap fixed earlier, but the
    // sabotage action itself never successfully registering at all.
    const validTypes = ["electricity", "hacker", "gateLeft", "gateRight"];
    if (!validTypes.includes(type)) {
      socket.emit("sabotageError", { message: "Invalid sabotage type." });
      return;
    }

    // [BUG FIX] Server-side uses-left + cooldown enforcement - previously
    // sabotageUsesLeft/sabotageCooldownUntil were purely client-side
    // (matching SABOTAGE_USES = {power:3, hacker:3, gateLeft:5,
    // gateRight:5} and SABOTAGE_COOLDOWN_MS=20000 in the frontend), which
    // meant a page refresh silently reset a Saboteur's uses back to full
    // and cleared any active cooldown - an exploitable way to bypass the
    // intended per-game limits just by refreshing. The server now tracks
    // the same counters itself and is the actual authority; the
    // client-side checks remain too (for instant UI feedback - disabling
    // buttons immediately rather than waiting on a round-trip), but this
    // is what makes them impossible to bypass.
    const now = Date.now();
    if (!player.sabotageUses) {
      player.sabotageUses = { electricity: 3, hacker: 3, gateLeft: 5, gateRight: 5 };
    }
    if ((player.sabotageUses[type] || 0) <= 0) {
      socket.emit("sabotageError", { message: "No uses left for that sabotage." });
      return;
    }
    if (player.sabotageCooldownUntil && now < player.sabotageCooldownUntil) {
      socket.emit("sabotageError", { message: "Sabotage is on cooldown." });
      return;
    }
    // Same post-kill lockdown the frontend enforces (20s after any kill,
    // tracked separately from postKillLockUntil there - mirrored here as
    // its own field so the server doesn't need to cross-reference the
    // kill-cooldown timer for an unrelated rule).
    if (player.postKillSabotageLockUntil && now < player.postKillSabotageLockUntil) {
      socket.emit("sabotageError", { message: "Sabotage actions are locked out after a recent kill." });
      return;
    }

    player.sabotageUses[type] -= 1;
    player.sabotageCooldownUntil = now + 20000;

    // [BUG FIX] Store the active sabotage on the ROOM itself (not just
    // relay-and-forget) — this is what lets a client who missed the
    // original broadcast (reconnecting, or a dropped packet) still learn
    // the CURRENT state via playerListUpdated/roomJoined, instead of
    // permanently showing gates as open (or lights as on) just because
    // they personally never received that one specific event. Gate locks
    // auto-expire after GATE_LOCK_DURATION_MS (30s, matching the
    // frontend's own constant); electricity/hacker sabotages stay active
    // until a crewmate explicitly repairs them (repairSabotage clears
    // this the same way).
    if (type === "gateLeft" || type === "gateRight") {
      room.activeGateLock = { group: type === "gateLeft" ? "A" : "B", expiresAt: Date.now() + 30000 };
      setTimeout(() => {
        if (room.activeGateLock && room.activeGateLock.expiresAt <= Date.now()) {
          delete room.activeGateLock;
        }
      }, 30000);
    } else {
      room.activeSabotageType = type; // "electricity" | "hacker"
    }

    // Tell everyone (including the Saboteur) that a sabotage was
    // triggered. [BUG FIX - IDENTITY LEAK] This used to also include
    // `triggeredBy: socket.id` - since only the Saboteur can ever
    // trigger a sabotage, broadcasting that id to the WHOLE room
    // (crewmates included) directly exposed the Saboteur's identity to
    // anyone who opened their browser's network inspector, regardless of
    // whether any current UI code happened to render it. No client logic
    // actually needs this field - removed entirely.
    io.to(roomCode).emit("sabotageTriggered", { type });

    console.log(`Sabotage "${type}" triggered by ${player.name} in room ${roomCode}`);
  });

  // ---- REPAIR SABOTAGE (any alive crewmate) ----
  // Client sends: { type } - "electricity" | "hacker" - whichever active
  // sabotage was just fixed. [BUG FIX] Repairing a sabotage previously
  // only updated the repairing player's OWN local state, so everyone
  // else's screen stayed dark/alarmed forever (or until they personally
  // also walked over and "fixed" their own local copy of it, one at a
  // time). The server is now the single source of truth for whether a
  // sabotage is currently active, and this broadcasts the fix to the
  // whole room at once - any ONE crewmate repairing it clears it for
  // everyone, including the Saboteur (who can't repair it themselves,
  // but the effect still goes away from their screen once someone else
  // does, exactly like the lights actually being back on).
  socket.on("repairSabotage", ({ type }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;

    const player = room.players[socket.id];
    if (!player || !player.alive) return;
    // [DESIGN RULE] The Saboteur cannot repair their own sabotage -
    // only a crewmate fixing it counts.
    if (player.role === "saboteur") return;
    // [BUG FIX] Consistent with kill/sabotage-trigger/meeting-call - a
    // crewmate can't be physically at a repair panel while everyone's
    // frozen in an active meeting.
    if (room.meeting) {
      socket.emit("sabotageError", { message: "Cannot repair during a meeting." });
      return;
    }

    const validTypes = ["electricity", "hacker"];
    if (!validTypes.includes(type)) return;

    if (room.activeSabotageType === type) {
      delete room.activeSabotageType;
    }

    io.to(roomCode).emit("sabotageRepaired", { type, repairedBy: socket.id });
    console.log(`Sabotage "${type}" repaired by ${player.name} in room ${roomCode}`);
  });

  // ---- REPORT MISSION PROGRESS ----
  // Client sends: { missions } - the player's full current mission list
  // (each entry just { room, done } - the room id and whether it's
  // complete), sent whenever it changes (a mission completes, or the
  // initial assignment happens). [BUG FIX] Previously this only sent a
  // done/total COUNT, with the actual mission list living purely
  // client-side - meaning a page refresh regenerated a brand new random
  // mission list from scratch, silently discarding all progress. Storing
  // the full list server-side (room.players[id].missionsList) is what
  // lets reconnectToRoom hand the exact same list + progress back,
  // instead of the client always falling back to pickRandomMissions().
  // missionsDone/missionsTotal are still derived here too, since
  // checkWinCondition reads those two numbers directly.
  socket.on("reportMissionProgress", ({ missions }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    if (!Array.isArray(missions)) return;
    // [BUG FIX] Sanity-bound the reported mission list - missionsTotal/
    // missionsDone directly feed checkWinCondition's "every crewmate
    // done" check, so a modified client could otherwise report a tiny
    // fabricated list (e.g. a single already-done entry) to trivially
    // satisfy their own portion of that check without doing any real
    // missions. MISSIONS_ASSIGNED_COUNT (frontend) is 4 random + 1
    // compulsory = 5 total per crewmate, every game - reject anything
    // outside a small reasonable window around that instead of trusting
    // whatever length the client claims.
    if (missions.length < 1 || missions.length > 10) return;
    if (missions.filter((m) => m.done).length > missions.length) return;

    player.missionsList = missions;
    player.missionsDone = missions.filter((m) => m.done).length;
    player.missionsTotal = missions.length;

    // [NEW FEATURE] Every mission update moves the shared crew-progress
    // meter too - broadcast the fresh aggregate to the WHOLE room right
    // away so everyone's bar updates live, not just whoever just acted.
    broadcastCrewProgress(roomCode);

    checkWinCondition(roomCode);
  });

  // ---- CALL MEETING (any alive player can do this) ----
  // Client sends: { reason: 'self' | 'report', reportedBodyId }
  // [MULTIPLAYER: SHARED] - meeting state is stored on the room so a
  // new/refreshed player can also learn the current stage.
  socket.on("callMeeting", ({ reason, reportedBodyId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    // [BUG FIX] Same post-game-end guard as killPlayer/sabotageAction.
    if (room.winner || !room.gameStarted) {
      socket.emit("meetingError", { message: "The game has already ended." });
      return;
    }

    const caller = room.players[socket.id];
    if (!caller || !caller.alive) {
      socket.emit("meetingError", { message: "You cannot call a meeting." });
      return;
    }
    // [BUG FIX] A Saboteur mid-vent-travel is supposed to be hidden in
    // the walls, not physically present to slam an emergency button -
    // same consistency fix as blocking kills/sabotage while inVent.
    if (caller.inVent) {
      socket.emit("meetingError", { message: "Cannot call a meeting while inside a vent." });
      return;
    }

    if (room.meeting) {
      socket.emit("meetingError", { message: "A meeting is already in progress." });
      return;
    }

    // Discussion cooldown: no meeting can be called within 30s of the
    // game starting, or within 30s of the previous meeting ending. This
    // is tracked on the room itself (meetingCooldownUntil), set both when
    // the game starts and whenever a meeting's voting resolves (see
    // finalizeVoting).
    const now = Date.now();
    if (room.meetingCooldownUntil && now < room.meetingCooldownUntil) {
      socket.emit("meetingError", {
        message: "Discussion is on cooldown.",
        cooldownRemainingMs: room.meetingCooldownUntil - now,
      });
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
      skipDiscussionVotes: {},
    };
    // Tag this specific meeting instance so the chained timers below can
    // tell if the room has since moved on (new meeting, or this one
    // already resolved early via the skip-discussion path) before acting.
    const meetingToken = room.meeting;

    // [BUG FIX] Server-driven alarm -> chat transition, instead of
    // leaving this entirely up to client-side timers.
    setTimeout(() => {
      if (rooms[roomCode]?.meeting !== meetingToken) return; // meeting moved on or ended
      if (meetingToken.stage !== "alarm") return; // already advanced (e.g. by another path)
      meetingToken.stage = "chat";
      meetingToken.startedAt = Date.now();
      io.to(roomCode).emit("meetingStageChanged", { stage: "chat" });

      // [BUG FIX] Server-driven chat -> voting transition - this is the
      // one that was previously ONLY ever triggered by client-side
      // timers, which is what could leave a meeting stuck forever if
      // every client's timer got delayed/throttled at once.
      setTimeout(() => {
        if (rooms[roomCode]?.meeting !== meetingToken) return;
        if (meetingToken.stage !== "chat") return; // already moved on (e.g. 80% skip vote)
        meetingToken.stage = "voting";
        meetingToken.startedAt = Date.now();
        io.to(roomCode).emit("meetingStageChanged", { stage: "voting" });

        // [BUG FIX] Server-driven voting -> results. This finally
        // guarantees results ALWAYS appear on time, independent of any
        // client ever calling forceFinalizeVoting at all.
        setTimeout(() => {
          if (rooms[roomCode]?.meeting !== meetingToken) return;
          if (meetingToken.stage !== "voting") return;
          finalizeVoting(roomCode);
        }, VOTING_DURATION_MS);
      }, MEETING_CHAT_DURATION_MS);
    }, MEETING_ALARM_DURATION_MS);

    // [BUG FIX] End any active disguise right now, the moment a meeting
    // starts - without this, the voting screen could keep showing the
    // Saboteur under their disguised name/avatar (the frontend's voting
    // card list uses disguiseAvatarId when present) for as long as their
    // 15s disguise window happened to still be running, making it
    // impossible for crewmates to correctly identify and vote them out.
    Object.entries(room.players).forEach(([id, p]) => {
      if (p.disguiseAvatarId) {
        delete p.disguiseAvatarId;
        delete p.disguiseActiveUntil;
        io.to(roomCode).emit("playerDisguiseEnded", { id });
      }
    });

    // [DEATH ANNOUNCEMENT] List every currently-dead player by name, so
    // the meeting's chat screen can show "X's body was found" for ALL of
    // them at once — not just whoever specifically got reported. This is
    // exactly what Among Us does: calling a meeting reveals every death
    // that's happened so far, regardless of which one body triggered it.
    const deadPlayerNames = Object.values(room.players)
      .filter((p) => !p.alive)
      .map((p) => p.name);

    io.to(roomCode).emit("meetingStarted", {
      calledBy: socket.id,
      callerName: caller.name,
      reason: room.meeting.reason,
      deadPlayerNames,
    });

    // [BUG FIX] Re-sync each Saboteur's own real sabotage-use counts and
    // cooldowns directly to their own client. The server itself never
    // resets these mid-game, but this guarantees the client's displayed
    // numbers always self-correct to match server truth at this point,
    // regardless of whatever caused them to look reset on screen.
    Object.entries(room.players).forEach(([id, p]) => {
      if (p.role === "saboteur" && p.alive) {
        io.to(id).emit("sabotageStateSync", {
          sabotageUses: p.sabotageUses || { electricity: 3, hacker: 3, gateLeft: 5, gateRight: 5 },
          sabotageCooldownUntil: p.sabotageCooldownUntil || 0,
          disguiseCooldownUntil: p.disguiseCooldownUntil || 0,
          postKillSabotageLockUntil: p.postKillSabotageLockUntil || 0,
        });
      }
    });

    console.log(`Meeting called by ${caller.name} in room ${roomCode}`);
  });

  // ---- SKIP DISCUSSION VOTE (during the chat stage) ----
  // Client sends nothing — just casts a "I want to skip discussion" vote.
  // [MULTIPLAYER: SHARED] Once 80% or more of currently-alive players have
  // voted to skip, the server moves the meeting straight to the voting
  // stage early, same as players in Among Us all agreeing to stop talking.
  socket.on("voteSkipDiscussion", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.meeting || room.meeting.stage !== "chat") return;

    const voter = room.players[socket.id];
    if (!voter || !voter.alive) return;

    room.meeting.skipDiscussionVotes[socket.id] = true;

    const totalAlive = Object.values(room.players).filter((p) => p.alive).length;
    const totalSkipVotes = Object.keys(room.meeting.skipDiscussionVotes).length;

    io.to(roomCode).emit("skipDiscussionUpdate", { totalSkipVotes, totalAlive });
    console.log(`Skip vote in room ${roomCode}: ${totalSkipVotes}/${totalAlive}`);

    // Using a tiny epsilon (0.0001) to guard against floating-point
    // rounding making an exact 80% (e.g. 4/5) compute as 0.7999999999
    // instead of exactly 0.8 and missing the threshold by a hair.
    if (totalAlive > 0 && totalSkipVotes / totalAlive >= 0.8 - 0.0001) {
      // [NEW FEATURE] Tell everyone the skip threshold was reached RIGHT
      // AWAY (so clients can show a "Discussion skipped" loading
      // transition), but wait 1.5s before actually flipping the stage
      // to voting - this is what gives that transition message enough
      // time to actually be seen, instead of the chat screen vanishing
      // and the voting screen appearing in the same instant.
      io.to(roomCode).emit("discussionSkipped");
      setTimeout(() => {
        // [BUG-PROOFING] Re-fetch the room fresh from the rooms object
        // (not the closed-over `room` variable) in case the room was
        // somehow recreated in this 1.5s window, and re-check the
        // meeting is still in the chat stage before forcing the
        // transition.
        const freshRoom = rooms[roomCode];
        if (freshRoom && freshRoom.meeting && freshRoom.meeting.stage === "chat") {
          const meetingRef = freshRoom.meeting;
          meetingRef.stage = "voting";
          meetingRef.startedAt = Date.now();
          io.to(roomCode).emit("meetingStageChanged", { stage: "voting" });
          console.log(`Discussion skipped by vote in room ${roomCode}`);
          // [BUG FIX] Same server-driven finalize guarantee as the
          // natural (non-skipped) chat->voting path above.
          setTimeout(() => {
            if (rooms[roomCode]?.meeting !== meetingRef) return;
            if (meetingRef.stage !== "voting") return;
            finalizeVoting(roomCode);
          }, VOTING_DURATION_MS);
        }
      }, 1500);
    }
  });

  // ---- MEETING CHAT MESSAGE ----
  // Client sends: { text }
  // [MULTIPLAYER: SHARED] - every player's chat history should show the
  // same messages, so the server is the single source of truth here.
  socket.on("sendChatMessage", ({ text, replyTo }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.meeting) return;

    const sender = room.players[socket.id];
    if (!sender) return;

    // [GHOST RULE] - dead players (ghosts) can't send chat messages, only
    // read them (which they already get, since chatMessageReceived is
    // broadcast to the whole room via io.to(roomCode)).
    if (!sender.alive) {
      socket.emit("chatError", { message: "You are a ghost and cannot send chat messages." });
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
      // [NEW FEATURE] WhatsApp/Telegram-style reply — only the small bits
      // needed to render a reply preview are kept, never the client's
      // full message object, to avoid trusting/forwarding anything
      // unexpected.
      replyTo: (replyTo && replyTo.senderName && replyTo.text)
        ? { senderName: String(replyTo.senderName).slice(0, 40), text: String(replyTo.text).slice(0, 200) }
        : null,
    };

    room.meeting.messages.push(message);

    io.to(roomCode).emit("chatMessageReceived", message);
  });

  // ---- GHOST CHAT (dead players only, anytime during the game) ----
  // [NEW FEATURE] A completely separate channel from the normal meeting
  // chat above. Only ever sent to OTHER CURRENTLY-DEAD players'
  // individual sockets (never broadcast to the whole room) - this is
  // what makes it structurally impossible for an alive player to ever
  // see a ghost chat message, regardless of any client-side bug, since
  // their socket is simply never one of the targets in the first place.
  socket.on("sendGhostChatMessage", ({ text, replyTo }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.gameStarted) return;

    const sender = room.players[socket.id];
    if (!sender) return;
    if (sender.alive) {
      socket.emit("chatError", { message: "Only ghosts can use ghost chat." });
      return;
    }

    const trimmed = (text || "").trim().slice(0, 200);
    if (!trimmed) return;

    const message = {
      senderId: socket.id,
      senderName: sender.name,
      senderAvatar: sender.avatarId,
      text: trimmed,
      timestamp: Date.now(),
      replyTo: (replyTo && replyTo.senderName && replyTo.text)
        ? { senderName: String(replyTo.senderName).slice(0, 40), text: String(replyTo.text).slice(0, 200) }
        : null,
    };

    room.ghostChat = room.ghostChat || [];
    room.ghostChat.push(message);

    Object.entries(room.players).forEach(([id, p]) => {
      if (!p.alive) io.to(id).emit("ghostChatMessageReceived", message);
    });
  });

  // ---- CAST VOTE ----
  // Client sends: { targetId } - a null/undefined targetId means a "skip" vote
  // [MULTIPLAYER: SHARED] - the server is what keeps the vote count and
  // decides the result, so no client can fake an outcome.
  socket.on("castVote", ({ targetId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.meeting) return;

    const voter = room.players[socket.id];
    if (!voter || !voter.alive) {
      socket.emit("voteError", { message: "You cannot vote." });
      return;
    }
    // [NEW FEATURE] A player can only vote once - silently ignore a
    // repeat castVote from someone who already has a stored vote this
    // meeting (the client itself already disables its own vote buttons
    // after voting, but the server re-checks this independently rather
    // than trusting that).
    // [BUG FIX] Now actually tells the client when this happens (instead
    // of a bare silent return) - if a rare client-side edge case ever
    // let a duplicate attempt through, the client gets explicit
    // feedback instead of being left with no signal that its second
    // attempt was rejected.
    if (room.meeting.votes[socket.id]) {
      socket.emit("voteError", { message: "You've already voted." });
      return;
    }

    // Store the vote (a null targetId means a skip-vote)
    const choice = targetId || "skip";
    // [BUG FIX] Validate the target actually refers to a real, currently
    // alive player in the room - a stale/invalid id (e.g. a vote cast
    // against a card built just before that player's id changed from a
    // reconnect) would otherwise silently get stored as-is, diluting the
    // real tally into a phantom bucket that matches nobody. That could
    // plausibly shift which real candidate ends up with the most votes -
    // reject it outright instead, with explicit feedback.
    if (choice !== "skip" && (!room.players[choice] || !room.players[choice].alive)) {
      socket.emit("voteError", { message: "That target is no longer valid." });
      return;
    }
    room.meeting.votes[socket.id] = choice;

    const totalAlive = Object.values(room.players).filter((p) => p.alive).length;
    const totalVotes = Object.keys(room.meeting.votes).length;

    // [NEW FEATURE] Broadcast WHO voted for WHOM, live, the moment each
    // vote is cast - this is what lets every player's screen show a
    // small avatar of the voter next to whichever target (or "skip")
    // they picked, in real time, rather than the vote breakdown only
    // ever being revealed after the fact on the results screen. This is
    // a deliberate, explicit design change from the original
    // "vote counts only, no who-voted-for-whom until results" behavior -
    // requested specifically to match Among Us's own live voting screen,
    // which DOES show each vote landing on its target's portrait in
    // real time.
    io.to(roomCode).emit("voteUpdate", { totalVotes, totalAlive, voterId: socket.id, choice });

    console.log(`${voter.name} voted in room ${roomCode} (${totalVotes}/${totalAlive})`);

    // [BUG FIX] Deliberately NOT auto-resolving anymore even once every
    // alive player has voted - voting now ALWAYS waits for the timer to
    // actually run out (handled by the client's own countdown calling
    // forceFinalizeVoting, or whatever else triggers it), matching the
    // explicit requirement that results should only appear once the
    // voting time has actually ended, not the instant the last vote
    // comes in.
  });

  // ---- END MEETING MANUALLY (host, or any client triggering the timeout) ----
  // If not everyone votes (some players are busy/AFK), the host or anyone
  // else can call this to force-close voting with whatever votes came in.
  // [BUG FIX] forceFinalizeVoting previously had NO validation at all -
  // any connected client (including a dead ghost, the Saboteur, or just
  // a modified client) could call this the INSTANT a meeting started and
  // instantly resolve voting with zero votes cast, completely bypassing
  // the explicitly-requested rule that "voting always waits for the full
  // timer" (the alarm + 2.5min chat + 30s voting stages every legitimate
  // client always waits out before ever emitting this). Now the server
  // independently re-checks that enough real time has actually passed
  // since the meeting started before honoring this - a small grace
  // buffer (2s) is subtracted purely to absorb normal network latency
  // between a legitimate client's own timer firing and this event
  // actually arriving, not to allow any real shortcut.
  socket.on("forceFinalizeVoting", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode || !rooms[roomCode] || !rooms[roomCode].meeting) return;
    const meeting = rooms[roomCode].meeting;
    // [BUG FIX] A meeting that's already moved on from "chat" to "voting"
    // tracks `startedAt` as the moment VOTING began (see the
    // skip-discussion path and the client's own stage-transition logic,
    // both of which reset startedAt when entering the voting stage) - so
    // only the 30s voting window needs to have elapsed in that case, not
    // the full alarm+chat+voting total.
    const requiredMs = meeting.stage === "voting" ? VOTING_DURATION_MS - 2000 : MIN_MEETING_RESOLVE_MS;
    if (Date.now() - meeting.startedAt < requiredMs) return;
    finalizeVoting(roomCode);
  });

  // ---- DISCONNECT ----
  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);

    const roomCode = socket.data.roomCode;
    if (!roomCode || !rooms[roomCode]) return;
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    // instead of being removed immediately — this is what keeps a brief
    // tab-minimize, refresh, or network blip from kicking someone out of
    // an in-progress game entirely. Before the game starts, there's
    // nothing worth preserving a slot for, so Lobby disconnects get their
    // own separate (shorter) grace period below instead.
    if (room.gameStarted) {
      // [NEW FEATURE] Captured at the moment of disconnect - decides both
      // the grace-period length below and whether this player's mission
      // progress still counts toward the team requirement once they're
      // gone for good.
      const wasAliveAtDisconnect = player.alive;
      player.disconnectedAt = Date.now();
      // [WIN-CONDITION PAUSE] Deliberately NOT marking them dead yet —
      // staying alive (frozen in place, where they last were) means
      // checkWinCondition keeps counting them as a living crewmate/
      // Saboteur for the full grace period, so an accidental disconnect
      // can't hand the other side a win just by waiting it out. Only if
      // they fail to reconnect within the window (see the setTimeout
      // below) do they actually become dead and the win-check re-runs.
      // [BUG FIX] Host status is also NOT migrated immediately for the
      // same reason — only once the grace period actually expires (see
      // setTimeout below), so a quick reconnect comes back with host
      // status intact instead of permanently losing it.

      io.to(roomCode).emit("playerListUpdated", { players: getPlayerList(roomCode) });
      // [WIN-CONDITION PAUSE] Other players are told this player has
      // temporarily stepped away (frozen, not dead) — their avatar simply
      // stops moving where it last was. No body/blood, no cutscene, and
      // critically: otherPlayers.alive is NOT set to false here, since
      // they aren't actually dead yet.
      io.to(roomCode).emit("playerFrozenMidGame", { playerId: socket.id });

      // [NEW FEATURE] A GHOST who disconnects only gets a 2-minute grace
      // period (Om7eth's explicit request) - once it expires, they're
      // considered fully out of the room. A still-ALIVE player keeps the
      // longer 3-minute window, since they still have an active role to
      // play (and the win-condition is being held open for them).
      const graceDurationMs = wasAliveAtDisconnect ? 3 * 60 * 1000 : 2 * 60 * 1000;

      // After the grace period with no reconnect, they're now actually
      // gone — re-run the win-check, since this might be the moment a
      // side wins.
      setTimeout(() => {
        const stillRoom = rooms[roomCode];
        if (!stillRoom) return;
        const stillPlayer = stillRoom.players[socket.id];
        // Only remove if it's still the SAME disconnected session (a
        // reconnect would have deleted this socket.id's entry already).
        if (stillPlayer && stillPlayer.disconnectedAt) {
          const wasHost = stillPlayer.isHost;
          // [FEATURE] Per Om7eth's explicit instruction: for this
          // disconnect-grace-timeout path specifically, an alive player
          // and a ghost are treated the same - if they reconnect within
          // their grace window (3min alive / 2min ghost, set above) they
          // simply continue normally; if they DON'T, their mission is
          // fully excluded from the missions-complete win requirement
          // and the shared progress meter either way, regardless of
          // whether they were alive or already a ghost when they
          // disconnected. (The explicit immediate "Leave" button is a
          // different, deliberate action with no grace/reconnect chance
          // at all - that path still requires an alive-departure's
          // mission progress, as an anti-exploit measure - see
          // leaveRoom.)
          delete stillRoom.players[socket.id];
          const remaining = Object.keys(stillRoom.players);
          if (remaining.length === 0) {
            markRoomMessageClosedForever(stillRoom); // [NEW FEATURE] fire-and-forget
            delete rooms[roomCode];
            console.log(`Room ${roomCode} deleted (empty after grace period)`);
          } else {
            if (wasHost) {
              stillRoom.players[remaining[0]].isHost = true;
              console.log(`Host migrated to ${remaining[0]} in room ${roomCode} (grace expired)`);
            }
            io.to(roomCode).emit("playerListUpdated", { players: getPlayerList(roomCode) });
            io.to(roomCode).emit("playerDisconnectedMidGame", { playerId: socket.id });
            console.log(`${stillPlayer.name} removed from room ${roomCode} (grace period expired)`);
            broadcastCrewProgress(roomCode);
            checkWinCondition(roomCode);
          }
        }
      }, graceDurationMs);

      return;
    }

    // Lobby (game not started yet) - give a 2-minute grace period too
    // (shorter than the 4-minute mid-game one, since less is at stake —
    // but still enough to survive a brief tab-switch/background without
    // losing your spot, avatar choice, and host status entirely).
    // [BUG FIX] Host status is NOT migrated immediately anymore — only if
    // the grace period actually expires without a reconnect (see the
    // setTimeout below). Migrating right away meant a player who
    // reconnected a second later would come back with isHost already
    // stripped from their restored player-data, which is exactly the
    // "host power doesn't come back" bug reported during testing.
    player.disconnectedAt = Date.now();
    io.to(roomCode).emit("playerListUpdated", { players: getPlayerList(roomCode) });

    setTimeout(() => {
      const stillRoom = rooms[roomCode];
      if (!stillRoom) return;
      const stillPlayer = stillRoom.players[socket.id];
      if (stillPlayer && stillPlayer.disconnectedAt) {
        const wasHost = stillPlayer.isHost;
        delete stillRoom.players[socket.id];
        const stillRemaining = Object.keys(stillRoom.players);
        if (stillRemaining.length === 0) {
          markRoomMessageClosedForever(stillRoom); // [NEW FEATURE] fire-and-forget
          delete rooms[roomCode];
          console.log(`Room ${roomCode} deleted (empty after Lobby grace period)`);
        } else {
          if (wasHost) {
            stillRoom.players[stillRemaining[0]].isHost = true;
            console.log(`Host migrated to ${stillRemaining[0]} in room ${roomCode} (Lobby grace expired)`);
          }
          io.to(roomCode).emit("playerListUpdated", { players: getPlayerList(roomCode) });
          console.log(`${stillPlayer.name} removed from room ${roomCode} (Lobby grace period expired)`);
        }
      }
    }, 2 * 60 * 1000);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // [NEW FEATURE] Registers the /telegram-webhook route with Telegram so
  // /room and /play commands work. Runs AFTER the server is already
  // listening, is fully async/non-blocking, and can never prevent or
  // delay the server from starting up and accepting game connections
  // even if it fails or Telegram is unreachable.
  registerTelegramWebhook();
});
