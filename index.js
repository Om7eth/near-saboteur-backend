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

// [BUG FIX] The Socket.io server above already allows cross-origin
// requests (cors: { origin: "*" }), but that setting ONLY applies to
// Socket.io's own connections - it does nothing for plain HTTP routes
// on the Express app itself (like /auth/signup below). Without this,
// the browser blocks every fetch() call to these routes with a CORS
// error ("Failed to fetch") before the request even reaches the
// server. This applies the same "*" policy to every Express route, and
// explicitly answers the browser's CORS preflight (OPTIONS) request,
// which a JSON POST body always triggers.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
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
// [DEV-BRANCH ONLY - PHASE 2 STEP 1] PLAYER ACCOUNT SYSTEM
// Email + password signup with OTP email verification, backed by
// MongoDB Atlas. Fully self-contained (its own schema, its own Express
// routes) - doesn't touch any Socket.io game logic below. Wallet
// connect/creation and profile setup (name/avatar) are NOT part of this
// step - those come once this base account layer is confirmed working.
// THIS ENTIRE BLOCK MUST NEVER BE MERGED TO THE LIVE/MAIN BRANCH UNTIL
// IT HAS BEEN FULLY TESTED ON THE DEV/TEST ENVIRONMENT FIRST.
// ============================================================
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { Resend } = require("resend");

const MONGODB_URI = process.env.MONGODB_URI || "";
if (MONGODB_URI) {
  mongoose
    .connect(MONGODB_URI)
    .then(() => console.log("[DB] Connected to MongoDB"))
    .catch((err) => console.error("[DB] MongoDB connection error:", err.message));
} else {
  console.warn("[DB] MONGODB_URI not set - player account system is disabled.");
}

// [SCHEMA] One document per player. Only email/password/verification
// fields are actually USED yet (signup/login/OTP below) - name,
// avatarId, walletType/walletAddress, and the points/stats fields exist
// now so the schema doesn't need another migration-style change for the
// next steps (profile setup, wallet connect, points system), but
// nothing in THIS step reads or writes them beyond their defaults.
const playerSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  verified: { type: Boolean, default: false },
  // OTP state - reused for both signup verification and password reset
  // (otpPurpose distinguishes which). Cleared after successful use.
  otpCode: { type: String, default: null },
  otpExpiresAt: { type: Date, default: null },
  otpPurpose: { type: String, default: null }, // 'signup' | 'reset'
  // [DEV-BRANCH ONLY - PHASE 2] Session persistence - an opaque token
  // issued at login/verify, stored client-side in localStorage instead
  // of the password, so reopening the app (a reload, backgrounding the
  // browser, coming back later) restores the logged-in session without
  // asking for the password again. Not a full JWT-based auth system
  // yet (known gap - fine for this early testing stage), but meaningfully
  // safer than storing the raw password client-side.
  sessionToken: { type: String, default: null },
  sessionTokenExpiresAt: { type: Date, default: null },
  // Filled in during profile setup (a later step) - not used yet.
  name: { type: String, default: "" },
  // [DEV-BRANCH ONLY - PHASE 2] Unique per-player handle, separate from
  // the freely-editable display name above - e.g. how a leaderboard or
  // future @-mentions would reference a player unambiguously even if
  // two players pick the same display name. sparse:true lets many
  // players simultaneously have username=null (before they've set one)
  // without tripping the unique index.
  // [BUG FIX] "sparse: true" here was NOT enough - MongoDB's sparse
  // indexes only skip documents where the field is truly MISSING, but
  // this schema's own "default: null" means every player document gets
  // an EXPLICIT null value at creation (before profile setup ever
  // runs). Sparse indexes still enforce uniqueness on explicit nulls,
  // so the second-ever player account (or any account that never
  // finished profile setup) would collide on username=null and every
  // later signup would fail with a generic error. Fixed below via an
  // explicit partial index that only enforces uniqueness among actual
  // string usernames - see playerSchema.index() call after the schema.
  username: { type: String, default: null, lowercase: true, trim: true },
  avatarId: { type: String, default: "" },
  // Filled in during wallet choice.
  walletType: { type: String, default: "none" }, // 'none' | 'connected' | 'ingame'
  walletAddress: { type: String, default: "" },
  // [DEV-BRANCH ONLY - PHASE 2] "Encrypted keystore" for IN-GAME
  // (self-custody) wallets ONLY - never used for 'connected' wallets,
  // since those never share a private key with us in the first place.
  // The private key is encrypted CLIENT-SIDE (AES-GCM, key derived from
  // the player's account password via PBKDF2) before it's ever sent
  // here - this server only ever stores/returns the ciphertext, salt,
  // and IV. It is cryptographically useless without the player's
  // password, which never leaves their device for this purpose. This
  // is what lets the same in-game wallet be unlocked again later from
  // any device, without us ever being able to read the actual key.
  walletKeystoreCiphertext: { type: String, default: "" },
  walletKeystoreSalt: { type: String, default: "" },
  walletKeystoreIv: { type: String, default: "" },
  // [NEW FEATURE] In-game wallets can't be silently replaced by the
  // player themselves - only Om7eth (via the admin dashboard) can
  // approve swapping to a new one, since the old one might still hold
  // funds a careless reset would orphan. A CONNECTED wallet has no such
  // restriction - it was never custodial in the first place, so the
  // player can disconnect/reconnect a different one freely (see
  // /wallet/disconnect below).
  walletResetRequestedAt: { type: Date, default: null },
  walletResetApproved: { type: Boolean, default: false },
  // [NEW FEATURE] Admin moderation - a held/banned account can't log in
  // at all (see /auth/login and /auth/session). "held" and "banned" are
  // deliberately the same underlying flag/mechanism - the distinction
  // (temporary review vs. permanent ban) is just in the reason text Om7eth
  // chooses to record, not in how it's enforced.
  accountHeld: { type: Boolean, default: false },
  accountHeldReason: { type: String, default: "" },
  // Filled in during the points system (a later step) - not used yet.
  totalPoints: { type: Number, default: 0 },
  currentSeasonPoints: { type: Number, default: 0 },
  season: { type: Number, default: 1 },
  // [POINTS SYSTEM - WEEKLY RESET FIX] Tracks which weekly period
  // currentSeasonPoints currently reflects - see getCurrentWeekStartUTC
  // and its use in commitPendingPoints. null means "never played yet",
  // treated as an immediate reset the first time it matters.
  seasonWeekStart: { type: Date, default: null },
  gamesPlayed: { type: Number, default: 0 },
  gamesWon: { type: Number, default: 0 },
  // [POINTS SYSTEM STEP 1] Daily diminishing-returns tracking - the
  // Nth+ match a player finishes on a given UTC calendar day earns
  // reduced points (see DAILY_FULL_POINTS_MATCHES /
  // DAILY_REDUCED_POINTS_MULTIPLIER below), so grinding many matches
  // back-to-back can't be used to farm the free weekly leaderboard.
  // pointsMatchesTodayDate is a plain "YYYY-MM-DD" string (not a Date) -
  // simplest possible same-day comparison, no timezone-math bugs.
  pointsMatchesToday: { type: Number, default: 0 },
  pointsMatchesTodayDate: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
});
// [BUG FIX] Partial index - only enforces uniqueness where username is
// an actual string, so any number of players with username still null
// (haven't finished profile setup yet) can coexist without colliding.
// This replaces the broken "unique + sparse" field option above. Named
// explicitly (different from the old auto-generated "username_1" name)
// so this new index can be created cleanly alongside/after the old
// broken one is manually removed - see the deploy note for the manual
// MongoDB Atlas step this requires.
playerSchema.index(
  { username: 1 },
  { unique: true, partialFilterExpression: { username: { $type: "string" } }, name: "username_partial_unique" }
);

const Player = mongoose.model("Player", playerSchema);

// ============================================================
// [DEV-BRANCH ONLY - PHASE 2 STEP 2] MATCH RECORDS
// One document per PLAYER per COMPLETED-AND-RETURNED-TO-LOBBY match -
// deliberately NOT just a running counter, per the planning notes
// ("har 1 point important hai... har match ka data rakhna hoga"). This
// is what every leaderboard (weekly, and later per-pool) actually reads
// from: a weekly leaderboard is "sum points where earnedAt is in this
// week", a pool leaderboard will be "sum points where poolId matches" -
// both trivial queries against this same collection, no separate
// aggregation table needed. Also doubles as the full history the
// planned admin dashboard will browse (per match, per player, per
// room). poolId/poolName are null for every ordinary Free Play match
// today - they exist now so the multi-match pool feature (a later
// step) doesn't need another schema migration.
// ============================================================
const matchRecordSchema = new mongoose.Schema({
  playerId: { type: mongoose.Schema.Types.ObjectId, ref: "Player", required: true, index: true },
  playerName: { type: String, default: "" }, // denormalized snapshot - so a record still reads sensibly even if the player later renames themselves
  roomCode: { type: String, default: "" },
  matchId: { type: String, required: true, index: true }, // unique per actual match - a room can host several matches over its lifetime, this is NOT the room code
  role: { type: String, default: "" }, // "crewmate" | "saboteur"
  won: { type: Boolean, default: false },
  points: { type: Number, default: 0 }, // the actual awarded amount (post daily-diminishing-returns, if that applied)
  reduced: { type: Boolean, default: false }, // true if this match landed on/after the daily diminishing-returns threshold
  // Raw per-match stats, for admin-dashboard transparency into exactly
  // how the point total was made up (not just the final number).
  missionsDone: { type: Number, default: 0 },
  killsCount: { type: Number, default: 0 },
  meetingsSurvivedCount: { type: Number, default: 0 },
  sabotageActionsCount: { type: Number, default: 0 },
  ventUsesCount: { type: Number, default: 0 },
  survived: { type: Boolean, default: false }, // alive at the moment the match ended
  // [FUTURE - POOL GAMES] Both null for every ordinary match today.
  poolId: { type: String, default: null, index: true },
  poolName: { type: String, default: null },
  earnedAt: { type: Date, default: Date.now, index: true },
});
const MatchRecord = mongoose.model("MatchRecord", matchRecordSchema);

// ============================================================
// [DEV-BRANCH ONLY - PHASE 2 STEP 4] POOL GAMES
// A pool is a private room where the host picks how many matches (1-3)
// make up the pool; points from every match in that room accumulate
// into a pool-specific leaderboard (kept live on the room object itself
// - see room.pool below), separate from each player's normal
// totalPoints. Once the last match ends, the host has a 10-minute
// window to review and confirm the final leaderboard before payout is
// triggered - if they don't act, it auto-submits so a pool can never
// get stuck waiting on an absent host. PoolResult is the permanent
// record of that outcome and the actual NEAR payout attempt per
// winner - this is what the 24-hour stuck-funds safety net (further
// below) scans for unresolved transfers.
// ============================================================
const poolResultSchema = new mongoose.Schema({
  poolId: { type: String, required: true, index: true },
  poolName: { type: String, default: "" },
  roomCode: { type: String, default: "" },
  hostAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "Player", default: null },
  totalFundNear: { type: Number, default: 0 },
  entryFeeNear: { type: Number, default: 0 },
  matchesPlayed: { type: Number, default: 0 },
  // Snapshot of every participant's final pool points + payout outcome.
  finalLeaderboard: [{
    playerId: { type: mongoose.Schema.Types.ObjectId, ref: "Player" },
    playerName: String,
    points: Number,
    payoutNear: Number,
    walletAddress: String,
    transferStatus: { type: String, default: "skipped" }, // 'sent' | 'failed' | 'skipped' (no wallet / zero payout)
    transferTxHash: { type: String, default: null },
  }],
  finalizedAt: { type: Date, default: null },
  finalizedBy: { type: String, default: null }, // 'host' | 'auto'
  fundsStuckSince: { type: Date, default: null },
  fundsRecoveredAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});
const PoolResult = mongoose.model("PoolResult", poolResultSchema);

// [REBUILT FOR SMART CONTRACT] The backend no longer holds or moves any
// pool money itself - the deployed contract does that entirely on its
// own. What's left for the backend:
//   - Reading the contract's public state (view calls - free, no
//     signing key needed at all) so the Lobby/admin dashboard can show
//     live on-chain pool status.
//   - Acting as the ORACLE (the one account the contract trusts to call
//     report_match_points/confirm_end_early) - this still needs a
//     signing key, but that key can now only ever report points or
//     confirm an early-end vote, never move a single yoctoNEAR. See the
//     contract's own report_match_points for why a compromised oracle
//     key still can't steal funds (points-cap + required player
//     signature).
// Every other pool action (create_pool, join_pool, finalize_pool,
// cancel/reactivate, host transfer) now happens directly from a
// player's OWN wallet on the frontend - the backend was never able to
// sign as them anyway, so those calls were always going to have to move
// there once real money was involved.
const nearAPI = require("near-api-js");
const NEAR_NETWORK = process.env.NEAR_NETWORK || "testnet";
// The deployed contract's own account - e.g. nearsaboteurcontract.testnet.
const POOL_CONTRACT_ACCOUNT_ID = process.env.POOL_CONTRACT_ACCOUNT_ID || "";
// Reusing the same env vars already set up for the old escrow wallet -
// this account is now specifically the CONTRACT's authorized oracle
// (see the `oracle_account_id` the contract was initialized with).
const ORACLE_ACCOUNT_ID = process.env.POOL_WALLET_ACCOUNT_ID || "";
const ORACLE_PRIVATE_KEY = process.env.POOL_WALLET_PRIVATE_KEY || "";
if (!POOL_CONTRACT_ACCOUNT_ID) {
  console.warn("[POOL CONTRACT] POOL_CONTRACT_ACCOUNT_ID not set - on-chain pool features are disabled.");
}
if (!ORACLE_ACCOUNT_ID || !ORACLE_PRIVATE_KEY) {
  console.warn("[POOL CONTRACT] Oracle credentials not set - match points can't be reported on-chain.");
}

let oracleAccountPromise = null;
function getOracleAccount() {
  if (!ORACLE_ACCOUNT_ID || !ORACLE_PRIVATE_KEY) return Promise.resolve(null);
  if (!oracleAccountPromise) {
    oracleAccountPromise = (async () => {
      const keyStore = new nearAPI.keyStores.InMemoryKeyStore();
      const keyPair = nearAPI.KeyPair.fromString(ORACLE_PRIVATE_KEY);
      await keyStore.setKey(NEAR_NETWORK, ORACLE_ACCOUNT_ID, keyPair);
      const near = await nearAPI.connect({
        networkId: NEAR_NETWORK, keyStore, nodeUrl: `https://rpc.${NEAR_NETWORK}.near.org`,
      });
      return near.account(ORACLE_ACCOUNT_ID);
    })().catch((e) => {
      console.error("[POOL CONTRACT] Failed to connect oracle account:", e.message);
      oracleAccountPromise = null; // allow retry on the next call
      return null;
    });
  }
  return oracleAccountPromise;
}

// Free, read-only - anyone can query contract view methods, no signing
// key needed at all. Used to show live on-chain pool/leaderboard state
// in the Lobby and admin dashboard.
let viewProvider = null;
async function viewContract(methodName, args = {}) {
  if (!POOL_CONTRACT_ACCOUNT_ID) return null;
  try {
    if (!viewProvider) {
      viewProvider = new nearAPI.providers.JsonRpcProvider({ url: `https://rpc.${NEAR_NETWORK}.near.org` });
    }
    const result = await viewProvider.query({
      request_type: "call_function",
      account_id: POOL_CONTRACT_ACCOUNT_ID,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      finality: "optimistic",
    });
    return JSON.parse(Buffer.from(result.result).toString());
  } catch (e) {
    console.error(`[POOL CONTRACT] viewContract(${methodName}) failed:`, e.message);
    return null;
  }
}

// The oracle's only two allowed actions on the contract - reporting one
// player's points for one match, and confirming a host's end-early
// request. Never throws - always resolves to { success, txHash?,
// error? }, since a failed call here is an expected, handled outcome
// (the match simply doesn't get its points reported this attempt),
// never a reason to crash the whole returnToLobby flow it's called
// from.
async function callContractAsOracle(methodName, args = {}) {
  if (!POOL_CONTRACT_ACCOUNT_ID) return { success: false, error: "Contract not configured" };
  try {
    const account = await getOracleAccount();
    if (!account) return { success: false, error: "Oracle account not configured" };
    const result = await account.functionCall({
      contractId: POOL_CONTRACT_ACCOUNT_ID,
      methodName,
      args,
      gas: "100000000000000", // 100 Tgas
    });
    return { success: true, txHash: result?.transaction?.hash || null };
  } catch (e) {
    console.error(`[POOL CONTRACT] callContractAsOracle(${methodName}) failed:`, e.message);
    return { success: false, error: e.message };
  }
}

// [DEV-BRANCH ONLY - PHASE 2] Announcements shown on the Home screen.
// Deliberately just a plain MongoDB collection with no admin UI of its
// own - Om7eth can add/edit/delete announcements directly from the
// MongoDB Atlas web dashboard (Collections → announcements), no code
// change or redeploy needed to post one.
const announcementSchema = new mongoose.Schema({
  title: { type: String, required: true },
  body: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
});
const Announcement = mongoose.model("Announcement", announcementSchema);

// [EMAIL] Resend client for OTP delivery. FROM_EMAIL defaults to
// Resend's shared sandbox address, which - until a custom domain is
// verified in the Resend dashboard - can ONLY deliver to the email
// address the Resend account itself was signed up with. Once a domain
// is verified, set RESEND_FROM_EMAIL to an address on that domain (e.g.
// otp@yourdomain.com) and every real player's email will start working
// with zero code changes.
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
}

// Never throws - a failed email send shouldn't crash the request. Logs
// the OTP to the server console as a fallback so signup/testing is
// never fully blocked even if email delivery itself is down/misconfigured.
async function sendOtpEmail(toEmail, code, purpose) {
  console.log(`[Auth] OTP for ${toEmail} (${purpose}): ${code}`);
  if (!resend) {
    console.warn("[Auth] RESEND_API_KEY not set - OTP not emailed, see code above.");
    return false;
  }
  try {
    const subject = purpose === "reset" ? "Reset your NEAR Saboteur password" : "Verify your NEAR Saboteur account";
    await resend.emails.send({
      from: `NEAR Saboteur <${FROM_EMAIL}>`,
      to: toEmail,
      subject,
      html: `<p>Your NEAR Saboteur verification code is:</p><h1 style="letter-spacing:4px;">${code}</h1><p>This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>`,
    });
    return true;
  } catch (err) {
    console.warn(`[Auth] Failed to send OTP email to ${toEmail}:`, err.message);
    return false;
  }
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const crypto = require("crypto");
function generateSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function publicPlayer(p) {
  // Never send passwordHash/otpCode back to the client.
  return {
    email: p.email,
    verified: p.verified,
    name: p.name,
    username: p.username,
    avatarId: p.avatarId,
    walletType: p.walletType,
    walletAddress: p.walletAddress,
    walletResetRequestedAt: p.walletResetRequestedAt,
    walletResetApproved: p.walletResetApproved,
    totalPoints: p.totalPoints,
    currentSeasonPoints: p.currentSeasonPoints,
    season: p.season,
    gamesPlayed: p.gamesPlayed,
    gamesWon: p.gamesWon,
  };
}

// ---- SIGNUP ---- Client sends: { email, password }
app.post("/auth/signup", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ message: "Please enter a valid email address." });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters." });
    }

    let player = await Player.findOne({ email });
    if (player && player.verified) {
      return res.status(409).json({ message: "This email is already registered. Try logging in instead." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const otpCode = generateOtp();
    const otpExpiresAt = new Date(Date.now() + OTP_TTL_MS);

    if (player) {
      // Existing but never-verified signup attempt - overwrite with the
      // new password/OTP rather than creating a duplicate.
      player.passwordHash = passwordHash;
      player.otpCode = otpCode;
      player.otpExpiresAt = otpExpiresAt;
      player.otpPurpose = "signup";
      await player.save();
    } else {
      player = await Player.create({
        email,
        passwordHash,
        verified: false,
        otpCode,
        otpExpiresAt,
        otpPurpose: "signup",
      });
    }

    await sendOtpEmail(email, otpCode, "signup");
    res.json({ message: "OTP sent to your email. Enter it to verify your account." });
  } catch (err) {
    console.error("[Auth] /auth/signup error:", err.message);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

// ---- VERIFY OTP (signup) ---- Client sends: { email, otp }
app.post("/auth/verify-otp", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const otp = String(req.body.otp || "").trim();

    const player = await Player.findOne({ email });
    if (!player) {
      return res.status(404).json({ message: "No signup found for this email." });
    }
    if (player.verified) {
      return res.status(400).json({ message: "This account is already verified." });
    }
    if (player.otpPurpose !== "signup" || !player.otpCode || player.otpCode !== otp) {
      return res.status(400).json({ message: "Incorrect code." });
    }
    if (!player.otpExpiresAt || player.otpExpiresAt.getTime() < Date.now()) {
      return res.status(400).json({ message: "This code has expired. Please sign up again to get a new one." });
    }

    player.verified = true;
    player.otpCode = null;
    player.otpExpiresAt = null;
    player.otpPurpose = null;
    player.sessionToken = generateSessionToken();
    player.sessionTokenExpiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await player.save();

    res.json({ success: true, player: publicPlayer(player), sessionToken: player.sessionToken });
  } catch (err) {
    console.error("[Auth] /auth/verify-otp error:", err.message);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

// ---- LOGIN ---- Client sends: { email, password }
app.post("/auth/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const player = await Player.findOne({ email });
    if (!player || !player.verified) {
      return res.status(401).json({ message: "Incorrect email or password." });
    }
    const match = await bcrypt.compare(password, player.passwordHash);
    if (!match) {
      return res.status(401).json({ message: "Incorrect email or password." });
    }
    // [NEW FEATURE] Admin-moderation hold - checked AFTER password
    // verification (never leaks "this account is held" to someone who
    // doesn't already know the password).
    if (player.accountHeld) {
      return res.status(403).json({ message: player.accountHeldReason || "This account is currently on hold. Contact support." });
    }

    player.sessionToken = generateSessionToken();
    player.sessionTokenExpiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await player.save();

    res.json({ success: true, player: publicPlayer(player), sessionToken: player.sessionToken });
  } catch (err) {
    console.error("[Auth] /auth/login error:", err.message);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

// ---- RESTORE SESSION ---- Client sends: { sessionToken }
// [DEV-BRANCH ONLY - PHASE 2] Called once on app load if a sessionToken
// was saved in localStorage from a previous login/verify - lets a
// returning player skip straight back to where they left off instead
// of logging in again every time the browser reloads/backgrounds.
app.post("/auth/session", async (req, res) => {
  try {
    const sessionToken = String(req.body.sessionToken || "").trim();
    if (!sessionToken) {
      return res.status(400).json({ message: "No session token provided." });
    }
    const player = await Player.findOne({ sessionToken, verified: true });
    if (!player || !player.sessionTokenExpiresAt || player.sessionTokenExpiresAt.getTime() < Date.now()) {
      return res.status(401).json({ message: "Session expired. Please log in again." });
    }
    if (player.accountHeld) {
      return res.status(401).json({ message: player.accountHeldReason || "This account is currently on hold." });
    }
    res.json({ success: true, player: publicPlayer(player) });
  } catch (err) {
    console.error("[Auth] /auth/session error:", err.message);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

// ---- LOGOUT ---- Client sends: { email }
// Invalidates the session token server-side, so a stale copy left in
// an old browser tab's localStorage can't restore the session anymore.
app.post("/auth/logout", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const player = await Player.findOne({ email });
    if (player) {
      player.sessionToken = null;
      player.sessionTokenExpiresAt = null;
      await player.save();
    }
    res.json({ success: true });
  } catch (err) {
    console.error("[Auth] /auth/logout error:", err.message);
    res.status(500).json({ message: "Something went wrong." });
  }
});

// ---- FORGOT PASSWORD ---- Client sends: { email }
// [SECURITY] Always responds with the same generic message whether or
// not the email is actually registered - otherwise this endpoint could
// be used to check which emails have accounts.
app.post("/auth/forgot-password", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const genericMsg = { message: "If that email is registered, a reset code has been sent." };

    const player = await Player.findOne({ email, verified: true });
    if (player) {
      const otpCode = generateOtp();
      player.otpCode = otpCode;
      player.otpExpiresAt = new Date(Date.now() + OTP_TTL_MS);
      player.otpPurpose = "reset";
      await player.save();
      await sendOtpEmail(email, otpCode, "reset");
    }

    res.json(genericMsg);
  } catch (err) {
    console.error("[Auth] /auth/forgot-password error:", err.message);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

// ---- RESET PASSWORD ---- Client sends: { email, otp, newPassword }
app.post("/auth/reset-password", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const otp = String(req.body.otp || "").trim();
    const newPassword = String(req.body.newPassword || "");

    if (newPassword.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters." });
    }

    const player = await Player.findOne({ email });
    if (!player || player.otpPurpose !== "reset" || !player.otpCode || player.otpCode !== otp) {
      return res.status(400).json({ message: "Incorrect code." });
    }
    if (!player.otpExpiresAt || player.otpExpiresAt.getTime() < Date.now()) {
      return res.status(400).json({ message: "This code has expired. Please request a new one." });
    }

    player.passwordHash = await bcrypt.hash(newPassword, 10);
    player.otpCode = null;
    player.otpExpiresAt = null;
    player.otpPurpose = null;
    await player.save();

    res.json({ success: true, message: "Password updated. You can now log in." });
  } catch (err) {
    console.error("[Auth] /auth/reset-password error:", err.message);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

// ---- WALLET CONNECT / CREATE ----
// [DEV-BRANCH ONLY - PHASE 2] Saves which wallet (connected or in-game
// generated) belongs to this player. NOTE: identifies the player by
// email in the request body, same as the rest of this early auth
// system - there's no session/auth token yet (that's a known gap to
// close before this goes anywhere near production; logged-in state is
// currently only tracked client-side). walletAddress here is always a
// PUBLIC address only - the frontend must never send a private key to
// this or any other endpoint.
app.post("/wallet/connect", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const walletAddress = String(req.body.walletAddress || "").trim();
    if (!walletAddress) {
      return res.status(400).json({ message: "Missing wallet address." });
    }
    const player = await Player.findOne({ email, verified: true });
    if (!player) {
      return res.status(404).json({ message: "Account not found." });
    }
    player.walletType = "connected";
    player.walletAddress = walletAddress;
    await player.save();
    res.json({ success: true, player: publicPlayer(player) });
  } catch (err) {
    console.error("[Auth] /wallet/connect error:", err.message);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

// ---- CREATE A NAMED IN-GAME WALLET ACCOUNT ----
// Client sends: { sessionToken, publicKey }
// [NEW FEATURE] In-game wallets previously got a raw 64-character
// implicit account (just the hex of the public key) - technically a
// valid NEAR account, but not human-readable at all (looked nothing
// like the "yourname.testnet" style every real NEAR wallet uses). This
// creates a genuine NAMED sub-account instead - username.<oracle
// account>.testnet - funded by the oracle account (which the backend
// already holds a key for, for reporting match points) acting as the
// registrar. The player's own username (already unique, from signup)
// becomes their wallet name too, so there's nothing new to type or any
// possibility of a collision.
// ---- REQUEST AN IN-GAME WALLET RESET (player-facing) ----
// Client sends: { sessionToken }
// [NEW FEATURE] A player can never silently replace their in-game
// wallet themselves - only Om7eth approving it (via the admin
// dashboard) actually unlocks the "remove wallet" action on their
// device. This just records the request; it does nothing else on its
// own.
app.post("/wallet/request-reset", async (req, res) => {
  try {
    const sessionToken = String(req.body.sessionToken || "");
    const player = await Player.findOne({ sessionToken, verified: true });
    if (!player) return res.status(401).json({ message: "Not logged in." });
    if (player.walletType !== "ingame") return res.status(400).json({ message: "This is only for in-game wallets." });
    player.walletResetRequestedAt = new Date();
    player.walletResetApproved = false; // any previous approval is spent/stale - a fresh request needs a fresh approval
    await player.save();
    res.json({ success: true, player: publicPlayer(player) });
  } catch (err) {
    console.error("[WALLET] /wallet/request-reset error:", err.message);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

// ---- ACTUALLY REMOVE THE OLD IN-GAME WALLET (player-facing) ----
// Client sends: { sessionToken }
// Only works once Om7eth has approved the pending request (see
// /admin/players/:id/approve-wallet-reset) - clears the old
// wallet entirely so the normal "Create New Wallet" flow can run again
// as if the player had never had one. The approval is single-use - it's
// cleared the moment this succeeds, so doing this again later needs a
// brand new request/approval.
app.post("/wallet/reset", async (req, res) => {
  try {
    const sessionToken = String(req.body.sessionToken || "");
    const player = await Player.findOne({ sessionToken, verified: true });
    if (!player) return res.status(401).json({ message: "Not logged in." });
    if (!player.walletResetApproved) return res.status(403).json({ message: "This hasn't been approved yet." });
    player.walletType = "none";
    player.walletAddress = "";
    player.walletKeystoreCiphertext = "";
    player.walletKeystoreSalt = "";
    player.walletKeystoreIv = "";
    player.walletResetApproved = false;
    player.walletResetRequestedAt = null;
    await player.save();
    res.json({ success: true, player: publicPlayer(player) });
  } catch (err) {
    console.error("[WALLET] /wallet/reset error:", err.message);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

// ---- DISCONNECT A CONNECTED WALLET (player-facing, no approval needed) ----
// Client sends: { sessionToken }
// [NEW FEATURE] Unlike an in-game wallet, a connected wallet (HOT/
// Meteor/Intear) was never custodied by us in the first place - the
// player's funds live entirely in an app/extension we have no access
// to. There's nothing for an approval process to protect here, so this
// works immediately, no admin step involved.
app.post("/wallet/disconnect", async (req, res) => {
  try {
    const sessionToken = String(req.body.sessionToken || "");
    const player = await Player.findOne({ sessionToken, verified: true });
    if (!player) return res.status(401).json({ message: "Not logged in." });
    if (player.walletType !== "connected") return res.status(400).json({ message: "This is only for connected wallets." });
    player.walletType = "none";
    player.walletAddress = "";
    await player.save();
    res.json({ success: true, player: publicPlayer(player) });
  } catch (err) {
    console.error("[WALLET] /wallet/disconnect error:", err.message);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

app.post("/wallet/create-named-account", async (req, res) => {
  try {
    const sessionToken = String(req.body.sessionToken || "");
    const publicKey = String(req.body.publicKey || "");
    if (!sessionToken || !publicKey) return res.status(400).json({ message: "Missing session or public key." });
    if (!ORACLE_ACCOUNT_ID || !ORACLE_PRIVATE_KEY) {
      return res.status(503).json({ message: "Named wallets aren't configured on this server yet." });
    }
    const player = await Player.findOne({ sessionToken, verified: true });
    if (!player) return res.status(401).json({ message: "Not logged in." });
    if (!player.username) return res.status(400).json({ message: "Set up your username first." });

    const sanitized = player.username.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32) || "player";
    const newAccountId = `${sanitized}.${ORACLE_ACCOUNT_ID}`;

    const oracleAccount = await getOracleAccount();
    if (!oracleAccount) return res.status(503).json({ message: "Wallet creation service is temporarily unavailable." });

    try {
      await oracleAccount.createAccount(newAccountId, publicKey, nearAPI.utils.format.parseNearAmount("0.05"));
    } catch (createErr) {
      // Most likely reason: this player already has a named wallet from
      // before - that's not actually an error, just re-use it.
      if (!String(createErr.message || "").toLowerCase().includes("already exists")) throw createErr;
    }
    res.json({ accountId: newAccountId });
  } catch (err) {
    console.error("[WALLET] /wallet/create-named-account error:", err.message);
    res.status(500).json({ message: "Could not create your wallet right now. Try again in a moment." });
  }
});

app.post("/wallet/create", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const walletAddress = String(req.body.walletAddress || "").trim();
    // [DEV-BRANCH ONLY - PHASE 2] Client-side encrypted blob (see the
    // Player schema comment) - all three required together since a
    // partial keystore is useless and worse, could look valid.
    const keystoreCiphertext = String(req.body.keystoreCiphertext || "").trim();
    const keystoreSalt = String(req.body.keystoreSalt || "").trim();
    const keystoreIv = String(req.body.keystoreIv || "").trim();
    if (!walletAddress) {
      return res.status(400).json({ message: "Missing wallet address." });
    }
    const player = await Player.findOne({ email, verified: true });
    if (!player) {
      return res.status(404).json({ message: "Account not found." });
    }
    player.walletType = "ingame";
    player.walletAddress = walletAddress;
    if (keystoreCiphertext && keystoreSalt && keystoreIv) {
      player.walletKeystoreCiphertext = keystoreCiphertext;
      player.walletKeystoreSalt = keystoreSalt;
      player.walletKeystoreIv = keystoreIv;
    }
    await player.save();
    res.json({ success: true, player: publicPlayer(player) });
  } catch (err) {
    console.error("[Auth] /wallet/create error:", err.message);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

// ---- FETCH WALLET KEYSTORE (in-game wallets only) ----
// Client sends: { email, password }
// [DEV-BRANCH ONLY - PHASE 2] Requires the account password to even
// retrieve the ciphertext, as defense-in-depth (the ciphertext alone is
// already useless without the password, but this avoids handing it out
// to anyone who merely knows the account email). The actual decryption
// happens entirely in the browser - this endpoint never sees or
// computes the plaintext private key.
app.post("/wallet/keystore", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const player = await Player.findOne({ email, verified: true });
    if (!player) {
      return res.status(404).json({ message: "Account not found." });
    }
    const match = await bcrypt.compare(password, player.passwordHash);
    if (!match) {
      return res.status(401).json({ message: "Incorrect password." });
    }
    if (player.walletType !== "ingame" || !player.walletKeystoreCiphertext) {
      return res.status(404).json({ message: "No in-game wallet keystore found for this account." });
    }
    res.json({
      success: true,
      keystoreCiphertext: player.walletKeystoreCiphertext,
      keystoreSalt: player.walletKeystoreSalt,
      keystoreIv: player.walletKeystoreIv,
    });
  } catch (err) {
    console.error("[Auth] /wallet/keystore error:", err.message);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

// ---- PROFILE SETUP ---- Client sends: { email, name, avatarId }
const USERNAME_REGEX = /^[a-z0-9_]{3,20}$/;

// ---- PROFILE SETUP / EDIT ---- Client sends: { email, name, username }
// [BUG FIX/UPDATE] avatarId removed - avatar selection lives in the
// Lobby (per-match, room-scoped) only, never on the account profile.
// Also used for LATER edits (via Settings → Profile), not just the
// initial post-wallet setup - same endpoint, same validation either way.
app.post("/profile/setup", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const name = String(req.body.name || "").trim().slice(0, 16);
    const username = String(req.body.username || "").trim().toLowerCase();
    // [UPDATE] Account-level "profile avatar" - shown on the Home
    // screen's Profile button. Distinct in purpose from the per-match
    // avatar picked in the Lobby (same AVATARS list, different field
    // usage) - this one is a persistent identity choice, not per-game.
    const avatarId = String(req.body.avatarId || "").trim();

    if (!name) {
      return res.status(400).json({ message: "Please enter a name." });
    }
    if (!USERNAME_REGEX.test(username)) {
      return res.status(400).json({ message: "Username must be 3-20 characters: lowercase letters, numbers, and underscores only." });
    }

    const player = await Player.findOne({ email, verified: true });
    if (!player) {
      return res.status(404).json({ message: "Account not found." });
    }

    // [BUG FIX] Uniqueness check excludes THIS player's own current
    // username - otherwise re-saving your own unchanged username would
    // incorrectly report itself as "already taken".
    const existing = await Player.findOne({ username, email: { $ne: email } });
    if (existing) {
      return res.status(409).json({ message: "That username is already taken." });
    }

    player.name = name;
    player.username = username;
    if (avatarId) player.avatarId = avatarId;
    await player.save();
    res.json({ success: true, player: publicPlayer(player) });
  } catch (err) {
    // [BUG FIX] Mongo's own unique-index violation (a race between the
    // findOne check above and another request claiming the same
    // username first) surfaces here as error code 11000 - translate it
    // into the same friendly message instead of a raw 500.
    if (err.code === 11000) {
      return res.status(409).json({ message: "That username is already taken." });
    }
    console.error("[Auth] /profile/setup error:", err.message);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

// ---- DELETE PROFILE (permanent) ---- Client sends: { email, password }
// [DEV-BRANCH ONLY - PHASE 2] Requires the account password as
// confirmation (not just a client-side "are you sure" dialog) before
// permanently deleting the player's entire record - name, wallet link,
// points, everything. There is no undo.
app.post("/profile/delete", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const player = await Player.findOne({ email, verified: true });
    if (!player) {
      return res.status(404).json({ message: "Account not found." });
    }
    const match = await bcrypt.compare(password, player.passwordHash);
    if (!match) {
      return res.status(401).json({ message: "Incorrect password." });
    }

    await Player.deleteOne({ email });
    res.json({ success: true });
  } catch (err) {
    console.error("[Auth] /profile/delete error:", err.message);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

// ---- LIVE PUBLIC ROOMS (for the Home screen) ----
// [DEV-BRANCH ONLY - PHASE 2] Same filter as the Telegram bot's /room
// command (see handleRoomCommand) - public rooms that haven't started
// yet. Polled by the Home screen every few seconds so the list stays
// roughly live without needing a websocket subscription just for this.
app.get("/rooms/public", (req, res) => {
  const openRooms = Object.values(rooms)
    .filter((r) => r.isPublic && !r.gameStarted)
    .map((r) => ({ code: r.code, playerCount: Object.keys(r.players).length }));
  res.json({ rooms: openRooms });
});

// ---- LIVE POOL GAMES (for the Pool Games modal's new section) ----
// Polled when the Pool Games modal opens. Returns two separate lists:
//   - myPools: pool rooms this account has ever been part of (host or
//     joiner - see everJoinedAccountIds), regardless of public/private or
//     whether the match has started, as long as the pool isn't finalized
//     yet. This is what lets someone (including a former host who left
//     and had a new host auto-assigned) find their way back in.
//   - publicPools: OTHER public pool rooms this account hasn't joined,
//     where the first match hasn't started yet (so joining is still
//     allowed - matches the same fairness rule join_pool itself enforces
//     on-chain). Guests (no sessionToken/account) only ever see this list.
// Both lists include the roomCode so the frontend can auto-join with it
// directly, with no manual code entry.
app.get("/pools/live", async (req, res) => {
  try {
    const account = await resolveAccountFromToken(req.query.sessionToken);
    const accountId = account?.accountId || null;

    const summarize = (r) => ({
      code: r.code,
      poolName: r.pool.poolName || "Pool Game",
      maxMatches: r.pool.maxMatches,
      matchesPlayed: r.pool.matchesPlayed,
      entryFeeNear: r.pool.entryFeeNear,
      hostFunded: r.pool.hostFunded,
      awaitingFinalization: !!r.pool.awaitingFinalization,
      playerCount: Object.keys(r.players).length,
      gameStarted: !!r.gameStarted,
      isHost: accountId ? r.pool.hostAccountId === accountId : false,
    });

    const allPoolRooms = Object.values(rooms).filter((r) => r.pool && !r.pool.finalized);

    const myPools = accountId
      ? allPoolRooms.filter((r) => r.pool.everJoinedAccountIds.includes(accountId)).map(summarize)
      : [];

    const publicPools = allPoolRooms
      .filter((r) => r.isPublic && !r.gameStarted && r.pool.matchesPlayed === 0)
      .filter((r) => !accountId || !r.pool.everJoinedAccountIds.includes(accountId))
      .map(summarize);

    res.json({ myPools, publicPools });
  } catch (err) {
    console.error("[Pools] /pools/live error:", err.message);
    res.status(500).json({ myPools: [], publicPools: [] });
  }
});

// ---- ANNOUNCEMENTS (for the Home screen) ----
// [DEV-BRANCH ONLY - PHASE 2] Read-only from the app's side - see the
// Announcement schema comment above for how Om7eth posts these (directly
// in the MongoDB Atlas dashboard, no code change needed).
app.get("/announcements", async (req, res) => {
  try {
    const announcements = await Announcement.find().sort({ createdAt: -1 }).limit(10);
    res.json({
      announcements: announcements.map((a) => ({
        title: a.title, body: a.body, createdAt: a.createdAt,
      })),
    });
  } catch (err) {
    console.error("[Auth] /announcements error:", err.message);
    res.json({ announcements: [] }); // never blocks the Home screen from loading
  }
});
// ============================================================
// [END DEV-BRANCH ONLY - PHASE 2 STEP 1 BLOCK]
// ============================================================

// ============================================================
// [DEV-BRANCH ONLY - PHASE 2 STEP 2.5] ADMIN DASHBOARD API
// Everything Om7eth's own dashboard needs: a simple username/password
// login (NOT tied to the player account system - this is a single,
// fixed admin credential set via env vars), then read-only endpoints
// for live rooms (straight from the in-memory `rooms` object - this is
// the only place that data exists while a match is in progress) and
// match/player history (from MongoDB). Every route here is READ-ONLY -
// nothing in this block ever mutates game state, a player's points, or
// anyone's account. Entirely separate from, and never touched by, the
// player-facing game/auth systems above.
// ============================================================
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
  console.warn("[ADMIN] ADMIN_USERNAME/ADMIN_PASSWORD not set - admin dashboard is disabled.");
}
// [BUG FIX] Was an in-memory Set - Render's free tier puts this whole
// server to sleep after 15 minutes idle (see the memory notes) and a
// fresh Node process starts on the next request, wiping any in-memory
// state completely. That silently invalidated every admin token on
// every single cold start, which is the actual reason the admin
// dashboard kept randomly logging out - not a real security timeout,
// just the process restarting underneath it. Persisting to MongoDB
// (same pattern as Player.sessionToken) makes an admin login survive
// server restarts, same as a player's login already does.
const adminSessionSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true, index: true },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
});
const AdminSession = mongoose.model("AdminSession", adminSessionSchema);
const ADMIN_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, same as a player's session

function generateAdminToken() {
  return "adm_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 12);
}
async function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return res.status(401).json({ message: "Not logged in." });
  if (!MONGODB_URI) return res.status(503).json({ message: "Admin dashboard is not configured on this server." });
  try {
    const session = await AdminSession.findOne({ token });
    if (!session || session.expiresAt.getTime() < Date.now()) {
      return res.status(401).json({ message: "Not logged in." });
    }
    next();
  } catch (e) {
    console.error("[ADMIN] requireAdmin lookup failed:", e.message);
    res.status(500).json({ message: "Server error checking your session." });
  }
}

app.post("/admin/login", async (req, res) => {
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
    return res.status(503).json({ message: "Admin dashboard is not configured on this server." });
  }
  const { username, password } = req.body || {};
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ message: "Incorrect username or password." });
  }
  const token = generateAdminToken();
  try {
    await AdminSession.create({ token, expiresAt: new Date(Date.now() + ADMIN_SESSION_TTL_MS) });
    res.json({ token });
  } catch (e) {
    console.error("[ADMIN] /admin/login session save failed:", e.message);
    res.status(500).json({ message: "Could not start a session. Try again." });
  }
});

app.post("/admin/logout", requireAdmin, async (req, res) => {
  const auth = req.headers.authorization || "";
  try { await AdminSession.deleteOne({ token: auth.slice(7) }); } catch (e) { /* non-fatal - token will just expire naturally */ }
  res.json({ success: true });
});

// Quick top-line numbers for the dashboard's overview tab.
app.get("/admin/overview", requireAdmin, async (req, res) => {
  try {
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);
    const [totalPlayers, totalMatches, matchesToday] = await Promise.all([
      Player.countDocuments({ verified: true }),
      MatchRecord.countDocuments({}),
      MatchRecord.countDocuments({ earnedAt: { $gte: startOfToday } }),
    ]);
    const activeRooms = Object.keys(rooms).length;
    const activeGames = Object.values(rooms).filter((r) => r.gameStarted).length;
    res.json({ totalPlayers, totalMatches, matchesToday, activeRooms, activeGames });
  } catch (err) {
    console.error("[ADMIN] /admin/overview error:", err.message);
    res.status(500).json({ message: "Failed to load overview." });
  }
});

// [LIVE] Every currently active room, straight from server memory - this
// is the only source for "what's happening right now" (a match in
// progress has no MatchRecord yet; that only gets written once a player
// actually returns to the Lobby afterward).
app.get("/admin/live-rooms", requireAdmin, (req, res) => {
  const list = Object.values(rooms).map((r) => ({
    code: r.code,
    playerCount: Object.keys(r.players).length,
    gameStarted: !!r.gameStarted,
    winner: r.winner || null,
    isPublic: !!r.isPublic,
    inMeeting: !!r.meeting,
    startedAt: r.gameStartedAt || null,
  }));
  res.json({ rooms: list });
});

// [LIVE] Full detail for one specific room - every player, their role
// (yes, including the Saboteur - this is an admin tool, full visibility
// is the point), alive/mission/kill state, all read straight from
// memory. 404s cleanly if the room has since ended/emptied.
app.get("/admin/live-rooms/:code", requireAdmin, (req, res) => {
  const room = rooms[String(req.params.code || "").toUpperCase()];
  if (!room) return res.status(404).json({ message: "Room not found (it may have ended)." });
  const players = Object.entries(room.players).map(([id, p]) => ({
    id,
    name: p.name,
    accountEmail: p.accountEmail || null,
    isGuest: !p.accountId,
    avatarId: p.avatarId,
    isHost: !!p.isHost,
    role: p.role || null,
    alive: p.alive !== false,
    missionsDone: p.missionsDone || 0,
    missionsTotal: p.missionsTotal || 0,
    killsCount: p.killsCount || 0,
    meetingsSurvivedCount: p.meetingsSurvivedCount || 0,
    sabotageActionsCount: p.sabotageActionsCount || 0,
    ventUsesCount: p.ventUsesCount || 0,
    disconnected: !!p.disconnectedAt,
  }));
  res.json({
    code: room.code,
    gameStarted: !!room.gameStarted,
    winner: room.winner || null,
    isPublic: !!room.isPublic,
    inMeeting: !!room.meeting,
    startedAt: room.gameStartedAt || null,
    matchId: room.currentMatchId || null,
    players,
    // [LOBBY LEADERBOARD] Full detail (per-match breakdown included, not
    // just totals) - only meaningful while the room is still alive in
    // memory; see /admin/room-leaderboard/:code for a version that also
    // works after the room has ended (reconstructed from MatchRecord).
    roomLeaderboard: getRoomLeaderboardList(room),
    pool: room.pool || null,
  });
});

// [LOBBY LEADERBOARD - HISTORY] Reconstructs a room's leaderboard from
// MatchRecord instead of live memory - works for ANY room code, even
// long after that room ended and was cleaned up (room.roomLeaderboard
// only exists in memory for as long as the room itself does). Grouped
// and summed by player, matches listed newest-first per player.
app.get("/admin/room-leaderboard/:code", requireAdmin, async (req, res) => {
  try {
    const roomCode = String(req.params.code || "").toUpperCase();
    const matches = await MatchRecord.find({ roomCode }).sort({ earnedAt: 1 });
    const byPlayer = {};
    for (const m of matches) {
      const key = String(m.playerId);
      if (!byPlayer[key]) {
        byPlayer[key] = { playerId: m.playerId, playerName: m.playerName, matches: [], totalPoints: 0 };
      }
      byPlayer[key].matches.push({ matchId: m.matchId, points: m.points, role: m.role, won: m.won, earnedAt: m.earnedAt });
      byPlayer[key].totalPoints += m.points;
    }
    const leaderboard = Object.values(byPlayer).sort((a, b) => b.totalPoints - a.totalPoints);
    res.json({ roomCode, leaderboard });
  } catch (err) {
    console.error("[ADMIN] /admin/room-leaderboard error:", err.message);
    res.status(500).json({ message: "Failed to load room leaderboard." });
  }
});

// [HISTORY] Paginated matches, newest first, GROUPED BY ACTUAL MATCH
// (one entry per matchId with every player who played it listed
// together) rather than one row per player-per-match - a room with a
// handful of matches and several players each was turning into a huge,
// hard-to-read flat list otherwise. Optional ?search= matches against
// player name or room code (case-insensitive) - matches where ANY
// player/the room code matches are included, with every player still
// shown for context. This is the same MatchRecord collection every
// leaderboard reads from too.
app.get("/admin/matches", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 20; // matches (not individual rows) per page
    const search = String(req.query.search || "").trim();
    const matchFilter = search
      ? { $or: [
          { playerName: { $regex: search, $options: "i" } },
          { roomCode: { $regex: search, $options: "i" } },
        ] }
      : {};
    // Every matchId that has at least one record satisfying the search,
    // sorted newest-first, then paginated - THEN pull every player's
    // record for exactly those matchIds. Two queries instead of one
    // aggregation pipeline, but much simpler to read and reason about.
    const matchIdsSorted = await MatchRecord.aggregate([
      { $match: matchFilter },
      { $group: { _id: "$matchId", earnedAt: { $max: "$earnedAt" } } },
      { $sort: { earnedAt: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
    ]);
    const pageMatchIds = matchIdsSorted.map((m) => m._id);
    const [records, totalMatchesAgg] = await Promise.all([
      MatchRecord.find({ matchId: { $in: pageMatchIds } }).sort({ earnedAt: -1 }),
      MatchRecord.aggregate([{ $match: matchFilter }, { $group: { _id: "$matchId" } }, { $count: "total" }]),
    ]);
    const total = totalMatchesAgg[0]?.total || 0;

    const byMatch = {};
    for (const r of records) {
      if (!byMatch[r.matchId]) {
        byMatch[r.matchId] = { matchId: r.matchId, roomCode: r.roomCode, earnedAt: r.earnedAt, players: [] };
      }
      byMatch[r.matchId].players.push({ playerName: r.playerName, playerId: r.playerId, role: r.role, won: r.won, points: r.points, reduced: r.reduced });
      // Keep the group's timestamp as the LATEST of its player records
      if (r.earnedAt > byMatch[r.matchId].earnedAt) byMatch[r.matchId].earnedAt = r.earnedAt;
    }
    const matches = Object.values(byMatch).sort((a, b) => new Date(b.earnedAt) - new Date(a.earnedAt));

    res.json({ matches, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("[ADMIN] /admin/matches error:", err.message);
    res.status(500).json({ message: "Failed to load matches." });
  }
});

// [HISTORY] Paginated player search - ?search= matches name/username/
// email (case-insensitive).
app.get("/admin/players", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 30;
    const search = String(req.query.search || "").trim();
    const filter = search
      ? { $or: [
          { name: { $regex: search, $options: "i" } },
          { username: { $regex: search, $options: "i" } },
          { email: { $regex: search, $options: "i" } },
        ] }
      : {};
    const [players, total] = await Promise.all([
      Player.find(filter, "-passwordHash -otpCode -walletKeystoreCiphertext -walletKeystoreSalt -walletKeystoreIv -sessionToken")
        .sort({ totalPoints: -1 }).skip((page - 1) * limit).limit(limit),
      Player.countDocuments(filter),
    ]);
    res.json({ players, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("[ADMIN] /admin/players error:", err.message);
    res.status(500).json({ message: "Failed to load players." });
  }
});

// [HISTORY] One player's full profile plus their most recent matches -
// for drilling in from either the Players or Matches tab.
app.get("/admin/players/:id", requireAdmin, async (req, res) => {
  try {
    const player = await Player.findById(req.params.id, "-passwordHash -otpCode -walletKeystoreCiphertext -walletKeystoreSalt -walletKeystoreIv -sessionToken");
    if (!player) return res.status(404).json({ message: "Player not found." });
    const matches = await MatchRecord.find({ playerId: player._id }).sort({ earnedAt: -1 }).limit(50);
    // [NEW FEATURE] Live on-chain NEAR balance, if this player has any
    // wallet at all - a simple read-only RPC call, no signing key
    // needed. Never blocks the rest of the response if it fails (wrong
    // network, account doesn't exist yet, RPC hiccup, etc.).
    let walletBalanceNear = null;
    if (player.walletAddress) {
      try {
        const provider = new nearAPI.providers.JsonRpcProvider({ url: `https://rpc.${NEAR_NETWORK}.near.org` });
        const account = await provider.query({ request_type: "view_account", account_id: player.walletAddress, finality: "optimistic" });
        walletBalanceNear = nearAPI.utils.format.formatNearAmount(account.amount, 4);
      } catch (e) { /* leave null - account may not exist on-chain yet, or RPC hiccup */ }
    }
    res.json({ player, matches, walletBalanceNear });
  } catch (err) {
    console.error("[ADMIN] /admin/players/:id error:", err.message);
    res.status(500).json({ message: "Failed to load player." });
  }
});

// ---- APPROVE A PENDING WALLET-RESET REQUEST ----
app.post("/admin/players/:id/approve-wallet-reset", requireAdmin, async (req, res) => {
  try {
    const player = await Player.findById(req.params.id);
    if (!player) return res.status(404).json({ message: "Player not found." });
    if (!player.walletResetRequestedAt) return res.status(400).json({ message: "This player hasn't requested a wallet reset." });
    player.walletResetApproved = true;
    await player.save();
    res.json({ success: true });
  } catch (err) {
    console.error("[ADMIN] approve-wallet-reset error:", err.message);
    res.status(500).json({ message: "Failed to approve." });
  }
});

// ---- HOLD / UNHOLD AN ACCOUNT ----
// Client sends: { reason } (hold only - unhold needs nothing)
app.post("/admin/players/:id/hold", requireAdmin, async (req, res) => {
  try {
    const player = await Player.findById(req.params.id);
    if (!player) return res.status(404).json({ message: "Player not found." });
    player.accountHeld = true;
    player.accountHeldReason = String(req.body.reason || "").slice(0, 200) || "Account on hold.";
    // [NEW FEATURE] A held account is also immediately logged out
    // everywhere - not just blocked from logging in again - since the
    // periodic session re-check on the frontend (see the app's
    // single-session logic) will hit this same rejected session on its
    // next check within a minute.
    player.sessionToken = null;
    player.sessionTokenExpiresAt = null;
    await player.save();
    res.json({ success: true });
  } catch (err) {
    console.error("[ADMIN] hold error:", err.message);
    res.status(500).json({ message: "Failed to hold this account." });
  }
});
app.post("/admin/players/:id/unhold", requireAdmin, async (req, res) => {
  try {
    const player = await Player.findById(req.params.id);
    if (!player) return res.status(404).json({ message: "Player not found." });
    player.accountHeld = false;
    player.accountHeldReason = "";
    await player.save();
    res.json({ success: true });
  } catch (err) {
    console.error("[ADMIN] unhold error:", err.message);
    res.status(500).json({ message: "Failed to unhold this account." });
  }
});

// Serves the dashboard's own single-page frontend - a plain static HTML
// file (admin-dashboard.html, uploaded alongside this one), not part of
// the React app at all. Kept as a separate file (rather than an inline
// string here) so it's easy to open/edit on its own.
app.get("/admin", (req, res) => {
  res.sendFile(__dirname + "/admin-dashboard.html");
});

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

// [BUG FIX] Escapes the handful of characters that are special in
// Telegram's HTML parse_mode - defensive, since room codes/names are
// otherwise safe, but this guarantees a stray "<" or "&" can never
// break message formatting or silently drop the message.
function escapeTelegramHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Builds the text+keyboard for a room's Telegram message based on its
// CURRENT state. Priority: private > in-progress > open. This is the
// single source of truth for what the message should look like at any
// given moment, so every caller (create, toggle, start, reset, close)
// just calls postOrUpdateRoomMessage and this figures out the rest.
function telegramRoomStatusMessage(room) {
  const count = Object.keys(room.players).length;
  const code = escapeTelegramHtml(room.code);

  if (!room.isPublic) {
    return {
      text: `🔒 Room <code>${code}</code> — made private by the host. Not joinable from here anymore.`,
      keyboard: { inline_keyboard: [] },
    };
  }
  if (room.gameStarted) {
    return {
      text: `🔴 Room <code>${code}</code> — game in progress. Not joinable right now.`,
      keyboard: { inline_keyboard: [] },
    };
  }
  return {
    // [NEW FEATURE] <code> renders as tap-to-copy monospace in
    // Telegram - tapping the room code itself copies it, no need to
    // select/long-press text manually.
    text: `🟢 Room <code>${code}</code> is open!\n👥 ${count} player(s) waiting\n\nTap below to join 👇`,
    keyboard: {
      inline_keyboard: [[{ text: "▶️ Join Room", url: telegramRoomJoinUrl(room.code) }]],
    },
  };
}

// Called whenever a room's state changes in a way that should be
// reflected in the group (created public, made public/private by the
// host, game started, back to Lobby). Reuses the SAME Telegram message
// via editMessageText for the room's entire lifetime instead of
// posting a new one each time - this is what prevents the group from
// being spammed with duplicate messages every time a room toggles
// visibility or cycles through games.
//
// [BUG FIX] Previously this bailed out entirely whenever
// room.isPublic was false, which meant toggling a room from public
// back to private never touched its existing Telegram message at all
// - it just sat there forever still showing "open" and a working Join
// button. Now: if the room was NEVER public (no telegramMessageId
// yet), it correctly stays silent; but if it WAS public before (a
// message already exists), turning it private now properly edits that
// same message to show the private/closed state.
async function postOrUpdateRoomMessage(room) {
  if (!room) return;
  if (!room.isPublic && !room.telegramMessageId) return; // never posted, nothing to do

  const { text, keyboard } = telegramRoomStatusMessage(room);

  if (room.telegramMessageId) {
    await tgCall("editMessageText", {
      chat_id: TELEGRAM_CHAT_ID,
      message_id: room.telegramMessageId,
      text,
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
    return;
  }

  const result = await tgCall("sendMessage", {
    chat_id: TELEGRAM_CHAT_ID,
    message_thread_id: TELEGRAM_TOPIC_ID,
    text,
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
  if (result && result.message_id) {
    room.telegramMessageId = result.message_id;
  }
}

// Called right before a room is permanently deleted (everyone left /
// grace period expired) - edits the message one last time (only if it
// was ever actually posted) so it doesn't sit there forever looking
// joinable, then the room object itself is discarded by the caller.
async function markRoomMessageClosedForever(room) {
  if (!room || !room.telegramMessageId) return;
  await tgCall("editMessageText", {
    chat_id: TELEGRAM_CHAT_ID,
    message_id: room.telegramMessageId,
    text: `⚫ Room <code>${escapeTelegramHtml(room.code)}</code> — closed (everyone left).`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [] },
  });
}

async function handleRoomCommand(chatId, threadId) {
  const openRooms = Object.values(rooms).filter((r) => r.isPublic && !r.gameStarted);
  let text;
  if (openRooms.length === 0) {
    text = "😴 No public rooms open right now.\n\nSend /play to start a new game!";
  } else {
    text =
      "🎮 <b>Open Rooms:</b>\n\n" +
      openRooms
        .map((r) => `🟢 <code>${escapeTelegramHtml(r.code)}</code> — ${Object.keys(r.players).length} player(s) waiting`)
        .join("\n");
  }
  const payload = { chat_id: chatId, text, parse_mode: "HTML" };
  if (threadId) payload.message_thread_id = threadId;
  await tgCall("sendMessage", payload);
}

async function handlePlayCommand(chatId, threadId) {
  const payload = {
    chat_id: chatId,
    text: "🚀 Ready to play NEAR Saboteur?",
    reply_markup: {
      // [BUG FIX] Was a plain https://t.me/<bot> link with no
      // startapp param, which opened the BOT'S CHAT (with its own
      // Play button inside) instead of the Mini App directly. Now
      // uses the same startapp deep-link format as the room Join
      // button, which opens the Mini App itself in one tap - this
      // only works correctly once "Configure Mini App" / Direct Link
      // is enabled for the bot in BotFather.
      inline_keyboard: [[{ text: "▶️ Play Now", url: `https://t.me/${TELEGRAM_BOT_USERNAME}?startapp=play` }]],
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

// [POINTS SYSTEM STEP 2] One of these is generated fresh every time a
// match actually STARTS (see startGame) - deliberately separate from
// the room code, since one room can host several matches back-to-back
// (Free Play "play again", and later multi-match pools) and each of
// those needs its own distinct identity in MatchRecord, not all sharing
// the room's one code.
function generateMatchId() {
  return "m_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

// [DEV-BRANCH ONLY - PHASE 2 - POINTS SYSTEM STEP 0] Resolves a
// sessionToken (sent by the client alongside createRoom/joinRoom) to the
// actual MongoDB Player document, the same way /auth/session already
// does for the REST side. This is the missing link between "who's
// logged in" and "who's actually playing" - without it, the server has
// no way to know which account to credit points to, since room.players
// previously only ever stored a free-typed name + avatarId with no
// account identity attached at all.
// Returns null (never throws) for: no token sent (guest), invalid/
// expired token, or the DB being unreachable - in every one of those
// cases the caller should just fall back to treating the player as a
// guest rather than blocking them from playing. This must never be the
// thing that breaks joining a room.
async function resolveAccountFromToken(sessionToken) {
  if (!sessionToken || !MONGODB_URI) return null;
  try {
    const player = await Player.findOne({ sessionToken, verified: true });
    if (!player) return null;
    if (!player.sessionTokenExpiresAt || player.sessionTokenExpiresAt.getTime() < Date.now()) return null;
    return { accountId: player._id.toString(), accountEmail: player.email, accountUsername: player.username || "" };
  } catch (e) {
    console.error("[POINTS] resolveAccountFromToken failed:", e.message);
    return null;
  }
}

// [DEV-BRANCH ONLY - PHASE 2 - POINTS SYSTEM STEP 0] Single-session-per-
// account enforcement - scans every currently active room for a player
// slot already linked to this accountId. This is what stops the same
// logged-in account from being an active player in two rooms at once
// (previously possible, and flagged as a known gap - see the points-
// system planning notes), which matters both for fairness (an account
// can't "double-dip" points from two simultaneous matches) and for
// avoiding genuinely confusing state (which room's outcome should even
// count for that account?).
function findActiveRoomForAccount(accountId) {
  if (!accountId) return null;
  for (const code of Object.keys(rooms)) {
    const room = rooms[code];
    for (const p of Object.values(room.players)) {
      if (p.accountId === accountId) return code;
    }
  }
  return null;
}

// [POOL GAMES] Same host-migration decision every disconnect-grace-
// expiry/leaveRoom path already made (just pick remainingIds[0]) - now
// pool rooms get a say first: if the host designated a backup (see
// setPoolBackupHost), promote THEM specifically whenever they're still
// present, falling back to the old "whoever's first" behavior
// otherwise (non-pool rooms, or the backup already left too).
function pickNextHost(room, remainingIds) {
  if (room.pool && room.pool.backupHostAccountId) {
    const preferred = remainingIds.find((id) => room.players[id].accountId === room.pool.backupHostAccountId);
    if (preferred) return preferred;
  }
  return remainingIds[0];
}

// ============================================================
// [DEV-BRANCH ONLY - PHASE 2 STEP 2] POINTS SYSTEM
// See the points-system planning notes for the full design rationale.
// Short version: crewmate and Saboteur have deliberately close (not
// identical - a few points apart) per-match ceilings, every repeatable
// action (missions/kills/meetings-survived/sabotage-uses) has its own
// "counts toward points at most N times" cap so no single action can be
// spammed to inflate a score, and a daily per-account diminishing-
// returns rule discourages grinding many back-to-back matches purely to
// farm the free weekly leaderboard. Points are only ever COMMITTED to
// an account once that player actually returns to the Lobby after the
// match - see stagePendingPointsForRoom (computes and holds them on the
// room, at the moment the winner is decided) and the returnToLobby
// handler (the only place that ever writes them into the database).
// A player who disconnects/leaves mid-match, or whose game never even
// finishes, simply never collects their pending points - matching
// "abandoning a match earns nothing" from the planning notes.
// ============================================================
const POINTS = {
  crewmate: {
    perMission: 2, maxMissionsCounted: 5, // max 10
    allMissionsBonus: 6,
    surviveBonus: 7,
    teamWinBonus: 14,
    participation: 4,
  },
  saboteur: {
    perKill: 4, maxKillsCounted: 4, // max 16
    perMeetingSurvive: 2, maxMeetingsCounted: 4, // max 8
    perSabotageUse: 1, maxSabotageCounted: 3, // max 3
    perVentUse: 1, maxVentCounted: 2, // max 2 - new: venting wasn't a point source at all before
    teamWinBonus: 14,
    participation: 4,
  },
  hardCap: 50, // defensive ceiling only - the numbers above never actually reach this on their own (crewmate maxes at 41, ghost at 34, saboteur at 47)
  dailyFullPointsMatches: 5, // the 6th+ completed match on the same UTC day earns reduced points
  dailyReducedMultiplier: 0.25,
};

// Pure calculation, no DB/IO - given one player's final in-match stats
// (already tracked on room.players[id] as the match played out) plus
// the decided room.winner, returns the whole-number point total for
// that single match, already capped. Safe to call for every player in
// the room regardless of whether they have an account (the caller
// decides whether a guest's result is worth computing/storing at all).
function computeMatchPoints(player, winner) {
  const won = player.role === winner;
  let total = 0;
  if (player.role === "crewmate") {
    const c = POINTS.crewmate;
    const missionsCounted = Math.min(player.missionsDone || 0, c.maxMissionsCounted);
    total += missionsCounted * c.perMission;
    if ((player.missionsDone || 0) >= (player.missionsTotal || Infinity) && (player.missionsTotal || 0) > 0) {
      total += c.allMissionsBonus;
    }
    if (player.alive) total += c.surviveBonus; // ghosts (alive === false) skip this - the one deliberate asymmetry, per the planning notes
    if (won) total += c.teamWinBonus;
    total += c.participation;
  } else if (player.role === "saboteur") {
    const s = POINTS.saboteur;
    const killsCounted = Math.min(player.killsCount || 0, s.maxKillsCounted);
    total += killsCounted * s.perKill;
    const meetingsCounted = Math.min(player.meetingsSurvivedCount || 0, s.maxMeetingsCounted);
    total += meetingsCounted * s.perMeetingSurvive;
    const sabotageCounted = Math.min(player.sabotageActionsCount || 0, s.maxSabotageCounted);
    total += sabotageCounted * s.perSabotageUse;
    const ventCounted = Math.min(player.ventUsesCount || 0, s.maxVentCounted);
    total += ventCounted * s.perVentUse;
    if (won) total += s.teamWinBonus;
    total += s.participation;
  } else {
    return 0; // no role assigned (shouldn't happen once a game has actually started, but never let an unrecognized role silently earn points)
  }
  return Math.min(Math.round(total), POINTS.hardCap);
}

// Called once, right when a room's winner is decided (from inside
// checkWinCondition, before gameOver is even broadcast) - computes and
// holds each player's match points ON THE ROOM ITSELF
// (room.players[id].pendingPoints), rather than writing to the database
// yet. This has to happen at this exact moment because room.winner (and
// every player's final missionsDone/killsCount/etc.) only exist in this
// complete, final form right now - by the time individual players press
// "Return to Lobby" (the actual DB-commit trigger), the FIRST one to do
// so already resets room.winner and the room's shared state for
// everyone, so waiting until then to compute results would silently
// give every later returner a wrong (or missing) answer.
function stagePendingPointsForRoom(room) {
  Object.values(room.players).forEach((p) => {
    if (!p.accountId) { p.pendingPoints = 0; return; } // guest - never staged, never committed
    p.pendingPoints = computeMatchPoints(p, room.winner);
    p.pendingWon = p.role === room.winner;
    // [SMART CONTRACT] This in-memory copy is now just a fast PREVIEW
    // for the Lobby's live pool card - the actual on-chain leaderboard
    // (which is what payout is computed from) only updates once each
    // player's signed result is reported via report_match_points - see
    // the returnToLobby handler.
    if (room.pool) {
      room.pool.leaderboard[p.accountId] = (room.pool.leaderboard[p.accountId] || 0) + p.pendingPoints;
    }
    // [LOBBY LEADERBOARD] Every room (not just pools) keeps its own
    // running, match-by-match leaderboard - see the block comment above
    // getOrCreateRoomLeaderboardEntry.
    const lbEntry = getOrCreateRoomLeaderboardEntry(room, p.accountId, p.accountUsername);
    lbEntry.matches.push({ matchId: room.currentMatchId || "", points: p.pendingPoints });
    lbEntry.totalPoints += p.pendingPoints;
  });
  // [POOL GAMES] One match in this pool just ended - advance the count,
  // and once every match the host asked for has been played, flag the
  // pool as awaiting finalization. [SMART CONTRACT] This flag is now
  // purely informational for the Lobby UI (prompts the host to open
  // their wallet and call finalize_pool) - the CONTRACT independently
  // tracks the real AwaitingFinalization state on-chain and is the
  // actual authority the host's wallet call is checked against.
  if (room.pool && !room.pool.finalized) {
    room.pool.matchesPlayed += 1;
    if (room.pool.matchesPlayed >= room.pool.maxMatches && !room.pool.awaitingFinalization) {
      room.pool.awaitingFinalization = true;
    }
    // [POOL GAMES] Let the room's Lobby screen show live pool progress
    // (matches played so far, current standings) without needing to
    // poll anything.
    io.to(room.code).emit("poolUpdated", { pool: room.pool });
  }
  // [LOBBY LEADERBOARD] Broadcast for every room, not just pools.
  broadcastRoomLeaderboard(room);
}

// [SMART CONTRACT] Reports one player's signed match result to the
// deployed contract, as the oracle - this is the ONLY thing that
// affects the contract's own on-chain leaderboard (what finalize_pool
// actually pays out from). Called from returnToLobby once a player's
// client has relayed their wallet-signed result. Independent per
// player - one signature missing/invalid never blocks anyone else's
// report or the match's own matches_played count on-chain (the
// contract derives that from distinct match_ids seen, same as the
// off-chain design).
async function reportMatchPointsOnChain({ onChainPoolId, matchId, accountId, points, signature }) {
  if (!onChainPoolId || !matchId || !accountId || !signature) return { success: false, error: "Missing data" };
  return callContractAsOracle("report_match_points", {
    pool_id: onChainPoolId,
    match_id: matchId,
    account_id: accountId,
    points,
    signature,
  });
}

// [POINTS SYSTEM - WEEKLY RESET FIX] Returns the Date (in UTC) of the
// most recent "Saturday 12:00 AM IST" at or before right now - the
// agreed weekly-leaderboard boundary (IST because that's Om7eth's own
// timezone; stored/compared in UTC internally to avoid ever doing
// timezone math against the server's local clock). Saturday 00:00 IST
// = Friday 18:30 UTC, since IST is UTC+5:30.
function getCurrentWeekStartUTC() {
  const now = new Date();
  // Work entirely in "IST-shifted" virtual time so day-of-week logic
  // stays simple, then shift back to real UTC at the very end.
  const istShiftMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istShiftMs);
  const istDay = istNow.getUTCDay(); // 0=Sun..6=Sat, in IST-shifted time
  const daysSinceSaturday = (istDay - 6 + 7) % 7;
  const istWeekStart = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() - daysSinceSaturday, 0, 0, 0, 0));
  return new Date(istWeekStart.getTime() - istShiftMs); // back to real UTC
}

// The only place points ever actually reach the database. Applies the
// daily diminishing-returns rule (first N completed matches today at
// full value, every one after that at a reduced multiplier), updates
// the Player's running totals, AND writes a MatchRecord for this one
// match - see the MatchRecord schema comment for why both are needed
// (Player = current totals for fast reads, MatchRecord = full history
// every leaderboard/the future admin dashboard actually queries).
// Never throws - a DB hiccup here should never be able to break a
// player's ability to return to the Lobby (see the try/catch at the
// call site in returnToLobby); worst case that one match's points don't
// get saved, same as if the player had been a guest.
// ============================================================
// [DEV-BRANCH ONLY - PHASE 2 STEP 3.2] LOBBY LEADERBOARD
// A running, per-ROOM leaderboard (distinct from room.pool.leaderboard,
// which only exists for pool rooms) - every logged-in player who's ever
// been in this room gets an entry the moment they join, and it grows
// with every match played in this room (Free Play "play again" cycles
// included, not just pools). Ranked by total points across every match
// in this room. Guests never get an entry (no account to key it by,
// same as everywhere else in the points system).
// ============================================================
function getOrCreateRoomLeaderboardEntry(room, accountId, username) {
  if (!accountId) return null;
  if (!room.roomLeaderboard) room.roomLeaderboard = {};
  if (!room.roomLeaderboard[accountId]) {
    room.roomLeaderboard[accountId] = { accountId, username: username || "", matches: [], totalPoints: 0, leftName: null, leftAvatarId: null };
  }
  return room.roomLeaderboard[accountId];
}

// [LOBBY LEADERBOARD] Called wherever a player permanently leaves a
// room (explicit leave, disconnect-grace expiry, inactivity kick, or
// switching to a different room) - BEFORE their room.players entry is
// deleted, since name/avatarId need to be read from it one last time.
// Per the planning notes: if they'd actually earned any points in this
// room, keep a frozen snapshot of their name/avatar so they still show
// up in the leaderboard; if they leave with zero, there's nothing worth
// remembering and their entry is removed entirely.
function snapshotRoomLeaderboardOnDeparture(room, accountId, name, avatarId) {
  if (!accountId || !room.roomLeaderboard || !room.roomLeaderboard[accountId]) return;
  const entry = room.roomLeaderboard[accountId];
  if (entry.totalPoints > 0) {
    entry.leftName = name;
    entry.leftAvatarId = avatarId;
  } else {
    delete room.roomLeaderboard[accountId];
  }
}

// Builds the actual display list: still-present players get their LIVE
// name/avatar (so a mid-room rename/avatar-change reflects immediately,
// per the planning notes), departed-but-remembered players get their
// frozen leftName/leftAvatarId snapshot instead. Sorted highest total
// first - this sort order IS the leaderboard ranking.
function getRoomLeaderboardList(room) {
  if (!room.roomLeaderboard) return [];
  const list = Object.values(room.roomLeaderboard).map((entry) => {
    const livePlayer = Object.values(room.players).find((p) => p.accountId === entry.accountId);
    return {
      accountId: entry.accountId,
      username: entry.username,
      name: livePlayer ? livePlayer.name : entry.leftName,
      avatarId: livePlayer ? livePlayer.avatarId : entry.leftAvatarId,
      totalPoints: entry.totalPoints,
      matches: entry.matches,
      present: !!livePlayer,
    };
  });
  list.sort((a, b) => b.totalPoints - a.totalPoints);
  return list;
}

function broadcastRoomLeaderboard(room) {
  io.to(room.code).emit("roomLeaderboardUpdated", { leaderboard: getRoomLeaderboardList(room) });
}

// The only place points ever actually reach the database. Applies the
// daily diminishing-returns rule (first N completed matches today at
// full value, every one after that at a reduced multiplier), updates
// the Player's running totals, AND writes a MatchRecord for this one
// match - see the MatchRecord schema comment for why both are needed
// (Player = current totals for fast reads, MatchRecord = full history
// every leaderboard/the future admin dashboard actually queries).
// Never throws - a DB hiccup here should never be able to break a
// player's ability to return to the Lobby (see the try/catch at the
// call site in returnToLobby); worst case that one match's points don't
// get saved, same as if the player had been a guest.
async function commitPendingPoints(meta) {
  const { accountId, matchPoints, won } = meta;
  if (!accountId || !MONGODB_URI) return null;
  try {
    const player = await Player.findById(accountId);
    if (!player) return null;

    const todayStr = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD", UTC
    if (player.pointsMatchesTodayDate !== todayStr) {
      player.pointsMatchesToday = 0;
      player.pointsMatchesTodayDate = todayStr;
    }
    // [POINTS SYSTEM - WEEKLY RESET FIX] currentSeasonPoints previously
    // only ever went up - this is the actual fix: whenever a player
    // earns points, first check whether we've crossed into a new
    // Saturday-12AM-IST week since their season points were last
    // touched, and zero it out if so, THEN add this match's points on
    // top. This is a lazy/on-write reset (checked whenever a player
    // next earns points), not a scheduled job - simplest reliable
    // option for a solo-maintained backend with no cron infrastructure,
    // and in practice the weekly leaderboard is only ever meaningful
    // for players who are actually still playing.
    const currentWeekStart = getCurrentWeekStartUTC();
    if (!player.seasonWeekStart || player.seasonWeekStart.getTime() < currentWeekStart.getTime()) {
      player.currentSeasonPoints = 0;
      player.seasonWeekStart = currentWeekStart;
    }
    const isReducedMatch = player.pointsMatchesToday >= POINTS.dailyFullPointsMatches;
    const awardedPoints = isReducedMatch
      ? Math.round(matchPoints * POINTS.dailyReducedMultiplier)
      : matchPoints;

    player.totalPoints += awardedPoints;
    player.currentSeasonPoints += awardedPoints;
    player.gamesPlayed += 1;
    if (won) player.gamesWon += 1;
    player.pointsMatchesToday += 1;

    await player.save();

    // [POINTS SYSTEM STEP 2] Per-match history row - deliberately a
    // SEPARATE try/catch from the Player save above, so a failure here
    // can never undo an otherwise-successful point award. This is what
    // the weekly leaderboard (sum by player+week), the future per-pool
    // leaderboard (sum by poolId), and the planned admin dashboard will
    // all actually query.
    try {
      await MatchRecord.create({
        playerId: accountId,
        playerName: meta.playerName || "",
        roomCode: meta.roomCode || "",
        matchId: meta.matchId || "",
        role: meta.role || "",
        won: !!won,
        points: awardedPoints,
        reduced: isReducedMatch,
        missionsDone: meta.missionsDone || 0,
        killsCount: meta.killsCount || 0,
        meetingsSurvivedCount: meta.meetingsSurvivedCount || 0,
        sabotageActionsCount: meta.sabotageActionsCount || 0,
        ventUsesCount: meta.ventUsesCount || 0,
        survived: !!meta.survived,
      });
    } catch (e2) {
      console.error("[POINTS] MatchRecord.create failed:", e2.message);
    }

    return { awardedPoints, totalPoints: player.totalPoints, currentSeasonPoints: player.currentSeasonPoints, reduced: isReducedMatch };
  } catch (e) {
    console.error("[POINTS] commitPendingPoints failed:", e.message);
    return null;
  }
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
    // [POOL GAMES] Opaque account id (never email/username) - lets the
    // Lobby's pool-leaderboard card match room.pool.leaderboard entries
    // (keyed by accountId) back to a display name. null for guests.
    accountId: p.accountId || null,
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
  // [LOBBY LEADERBOARD] Read accountId/name/avatarId one last time before
  // the delete below removes them.
  snapshotRoomLeaderboardOnDeparture(oldRoom, oldRoom.players[socket.id].accountId, oldRoom.players[socket.id].name, oldRoom.players[socket.id].avatarId);
  delete oldRoom.players[socket.id];
  socket.leave(oldRoomCode);

  const remaining = Object.keys(oldRoom.players);
  if (remaining.length === 0) {
    markRoomMessageClosedForever(oldRoom); // [NEW FEATURE] fire-and-forget
    delete rooms[oldRoomCode];
    console.log(`Room ${oldRoomCode} deleted (empty after player moved to a different room)`);
  } else {
    if (wasHost) {
      const nextHostId = pickNextHost(oldRoom, remaining);
      oldRoom.players[nextHostId].isHost = true;
      console.log(`Host migrated to ${nextHostId} in room ${oldRoomCode} (previous host moved to a different room)`);
    }
    io.to(oldRoomCode).emit("playerListUpdated", { players: getPlayerList(oldRoomCode) });
    broadcastRoomLeaderboard(oldRoom);
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

function checkWinCondition(roomCode, force = false) {
  const room = rooms[roomCode];
  if (!room || room.winner) return false; // already decided, don't re-announce
  // [BUG FIX] Defensive guard - every current call site only ever calls
  // this once a game is actually running, but without this explicit
  // check, a future/accidental call before roles are assigned would see
  // every player's `role`/`alive` as undefined - aliveCrewmates would
  // compute as an empty array, and `0 < 2` would incorrectly declare an
  // instant "Saboteur wins by elimination" in an empty Lobby.
  if (!room.gameStarted) return false;

  // [DEV-BRANCH ONLY TEST FEATURE] While Dev Mode is on for this room,
  // auto win-conditions are skipped entirely - a 2-player test session
  // would otherwise end the instant the Saboteur's first kill drops
  // crewmates below 2, before the host ever gets to test the meeting/
  // voting/chat flow that follows. The host ends a test round on demand
  // via the "Force End Round" Dev Mode button, which calls this same
  // function again with force=true to bypass this skip.
  if (room.devMode && !force) return false;

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
    stagePendingPointsForRoom(room); // [POINTS SYSTEM STEP 2] must happen now, before gameOver - see the comment on stagePendingPointsForRoom
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
    stagePendingPointsForRoom(room); // [POINTS SYSTEM STEP 2]
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
    stagePendingPointsForRoom(room); // [POINTS SYSTEM STEP 2]
    io.to(roomCode).emit("gameOver", { winner: "crewmate", reason: "missionsComplete" });
    console.log(`Room ${roomCode}: Crewmates win - all missions complete`);
    return true;
  }

  return false;
}

// [BUG FIX] "Alive" alone isn't enough when counting how many players
// must vote/skip - a mid-game disconnect deliberately keeps a player's
// `alive` flag true for their full grace period (see the disconnect
// handler) so a brief network blip can't hand the other side a win.
// But that same `alive` flag was ALSO being used as the denominator for
// the skip-discussion and elimination-vote thresholds, which meant a
// player who genuinely left (or is mid-grace-period after a disconnect)
// still counted toward "how many votes are needed" even though they can
// never actually cast one - e.g. an 8-alive room reporting a leaver
// would stay stuck expecting votes from 8, not the 7 people actually
// still present. This helper is for THOSE vote-threshold calculations
// specifically; win-condition checks intentionally keep using the plain
// `alive` filter and are NOT changed.
function getActiveAliveCount(room) {
  return Object.values(room.players).filter((p) => p.alive && !p.disconnectedAt).length;
}

function finalizeVoting(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.meeting) return;
  // [BUG FIX] Guards against this running twice for the same meeting -
  // previously nothing stopped that from happening if two trigger paths
  // (the client's own 30s timer calling forceFinalizeVoting, and now
  // also the new 3s-after-everyone-voted auto-finalize) both fired close
  // together. A second run would re-process the same votes and
  // re-broadcast votingResult a second time - harmless to the actual
  // outcome (same votes in, same result out) but a needless duplicate
  // event on every client. Setting this immediately, before any of the
  // actual resolution logic below, closes that window.
  if (room.meeting.finalized) return;
  room.meeting.finalized = true;

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

  // [POINTS SYSTEM STEP 2] Every Saboteur who was alive going into this
  // vote and DIDN'T just get ejected survived this meeting - raw count,
  // capped at points-calculation time (see
  // POINTS.saboteur.maxMeetingsCounted). Deliberately checked against
  // the alive flag from BEFORE eliminatedId's own alive=false was set
  // two lines above, so the just-ejected Saboteur (if any) never counts
  // themselves as having "survived" the very meeting that got them out.
  Object.entries(room.players).forEach(([id, p]) => {
    if (p.role === "saboteur" && id !== eliminatedId && p.alive) {
      p.meetingsSurvivedCount = (p.meetingsSurvivedCount || 0) + 1;
    }
  });

  // [BODY CLEANUP] Every player who was already dead BEFORE this voting
  // round (i.e. everyone announced when the meeting started) has now
  // been discussed and voted on — Among Us clears all known bodies once
  // a meeting concludes, not just the one that got specifically reported.
  // The newly-eliminated player (if any) is also included, since their
  // body never needs to be found/reported again either.
  const clearedBodyIds = Object.entries(room.players)
    .filter(([, p]) => !p.alive)
    .map(([id]) => id);

  // [BUG FIX] This was the actual persistence bug behind "a cleared body
  // reappears later" - clearedBodyIds above only ever told currently-
  // connected CLIENTS to drop the body from their own local visual state
  // for a few seconds (see the frontend's votingResult handler); it
  // never touched the SERVER's own p.bodyX/p.bodyY, which is the
  // canonical source every playerListUpdated broadcast re-reads from
  // (see getPlayerList). So the very next playerListUpdated for ANY
  // reason at all - someone else moving, joining, reconnecting -
  // resurrected the "cleared" body on every client, since as far as the
  // server was concerned it had never actually gone anywhere. Deleting
  // it here, once, is what makes the clearing permanent.
  clearedBodyIds.forEach((id) => {
    if (room.players[id]) {
      delete room.players[id].bodyX;
      delete room.players[id].bodyY;
    }
  });

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
  // [BUG FIX - DOUBLE POOL CREATION] `callback` is the optional socket.io
  // acknowledgement function - present only when the CLIENT passed one
  // (socket.emit('createRoom', data, callback)). Older/other call sites
  // that don't pass one are completely unaffected (callback is just
  // undefined there, same behavior as before). This is what lets the
  // Pool-creation button specifically AWAIT real confirmation the room
  // actually exists before switching screens - see the matching frontend
  // comment on handleCreateRoom for the full story of the bug this fixes
  // (premature screen-switch before the room existed, so the Lobby
  // rendered its own empty "create/join a room" fallback, which - if
  // clicked - created a second, ordinary Free Play room while the FIRST,
  // already-paid-for pool sat there unused; going back and creating the
  // pool again then charged the wallet a second time for the same pool).
  socket.on("createRoom", async ({ name, avatarId, isPublic, sessionToken, poolConfig }, callback) => {
    const ack = typeof callback === "function" ? callback : () => {};
    // [BUG FIX] Make sure we're not still attached to a previous room
    // before creating a brand new one - see leaveCurrentRoomIfAny.
    leaveCurrentRoomIfAny(io, socket);

    // [POINTS SYSTEM STEP 0] Resolve which account (if any) this socket
    // belongs to, and refuse to create a room if that same account is
    // already an active player somewhere else (a stale room slot from a
    // tab/device they forgot about, most likely). Guests (no valid
    // token) skip this check entirely and can always create a room.
    const account = await resolveAccountFromToken(sessionToken);
    if (account && findActiveRoomForAccount(account.accountId)) {
      const message = "Your account is already active in another room. Leave that room first, or wait a moment if you just closed it.";
      socket.emit("joinError", { message });
      ack({ ok: false, message });
      return;
    }

    // [SMART CONTRACT] poolConfig now must include the onChainPoolId the
    // host's own wallet already got back from calling the contract's
    // create_pool (with the entry-fee/storage-deposit actually attached
    // there, not through the backend) - the backend only ever links a
    // room to a pool that already exists on-chain, it never creates one
    // itself (it has no wallet of its own to fund a pool with). Guests
    // can't host a pool - there's no account to link. poolConfig is
    // otherwise entirely optional; an ordinary Free Play room just
    // never has room.pool at all.
    let poolSetup = null;
    if (poolConfig && account && poolConfig.onChainPoolId) {
      const maxMatches = Math.max(1, Math.min(3, parseInt(poolConfig.maxMatches, 10) || 1));
      const entryFeeNear = Math.max(0, Number(poolConfig.entryFeeNear) || 0);
      const hostFunded = !!poolConfig.hostFunded;
      poolSetup = {
        onChainPoolId: String(poolConfig.onChainPoolId),
        poolId: generateMatchId().replace("m_", "p_"), // internal id for off-chain bookkeeping only, distinct from onChainPoolId
        poolName: String(poolConfig.poolName || "").slice(0, 40),
        maxMatches,
        matchesPlayed: 0,
        entryFeeNear,
        hostFunded,
        hostAccountId: account.accountId,
        backupHostAccountId: null,
        totalFundNear: hostFunded ? entryFeeNear : 0, // live preview only now - the contract holds the real escrowed amount
        leaderboard: {}, // live preview only - see stagePendingPointsForRoom's comment; the contract's own leaderboard is the real one
        finalized: false,
        awaitingFinalization: false,
        // [LIVE POOLS SECTION] Every accountId that has ever been part of
        // this pool room (host at creation, plus anyone who later joins
        // the room via joinRoom below) - kept even after they disconnect
        // or explicitly leave, unlike room.players (which only tracks
        // currently-connected sockets). This is what lets the "Your Live
        // Pools" list find a room for someone to REJOIN after they left,
        // including the original host if a new host has since taken over.
        everJoinedAccountIds: [account.accountId],
      };
    }

    let code = generateRoomCode();
    // Extremely unlikely to collide, but check anyway for safety
    while (rooms[code]) {
      code = generateRoomCode();
    }

    const playerToken = generatePlayerToken();

    rooms[code] = {
      code,
      gameStarted: false,
      speedLevel: 4, // [UPDATE] Default 100% (was 75%) - levels now 50/75/100/125/150 - the room creator can change this in the Lobby
      // [NEW FEATURE] Public rooms get auto-posted to the Telegram
      // group; private ones (the default) are never mentioned there.
      // Defensively coerced to a plain boolean so a tampered/odd client
      // payload can never end up as anything but true/false.
      isPublic: !!isPublic,
      // [DEV-BRANCH ONLY TEST FEATURE] Off by default - lets a host
      // testing solo (e.g. 2 devices) lower the min-player requirement
      // and pause auto win-conditions so kill/vote/meeting/chat flows can
      // all be exercised without the round ending after one kill. Toggle
      // via setDevMode. Never present in the live/main branch.
      devMode: false,
      // [POOL GAMES] null for every ordinary Free Play/public room.
      pool: poolSetup,
      players: {
        // [POINTS SYSTEM STEP 0] accountId/accountEmail are null for
        // guests - every point-crediting/gating check downstream treats
        // a null accountId as "don't award points, this is a guest",
        // consistent with the guest-mode rules already in the frontend.
        [socket.id]: { name, avatarId, isHost: true, playerToken, accountId: account?.accountId || null, accountEmail: account?.accountEmail || null, accountUsername: account?.accountUsername || null },
      },
    };

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerToken = playerToken;

    // [LOBBY LEADERBOARD] Host appears in this room's leaderboard the
    // moment the room exists, with 0 points until they actually earn
    // some - same as any other logged-in player who joins.
    if (account) getOrCreateRoomLeaderboardEntry(rooms[code], account.accountId, account.accountUsername);

    socket.emit("roomCreated", {
      code,
      players: getPlayerList(code),
      playerToken,
      speedLevel: rooms[code].speedLevel,
      isPublic: rooms[code].isPublic,
      devMode: rooms[code].devMode,
      pool: rooms[code].pool,
      lobbyChat: rooms[code].lobbyChat || [],
      roomLeaderboard: getRoomLeaderboardList(rooms[code]),
    });
    // [BUG FIX - DOUBLE POOL CREATION] Same payload, delivered via the
    // ack this time - see the comment on the createRoom handler's
    // signature above for why this exists.
    ack({
      ok: true,
      code,
      players: getPlayerList(code),
      playerToken,
      speedLevel: rooms[code].speedLevel,
      isPublic: rooms[code].isPublic,
      devMode: rooms[code].devMode,
      pool: rooms[code].pool,
      lobbyChat: rooms[code].lobbyChat || [],
      roomLeaderboard: getRoomLeaderboardList(rooms[code]),
    });

    // [NEW FEATURE] Fire-and-forget - never awaited, so a slow/failed
    // Telegram call can never delay this player's own roomCreated
    // response or block the server in any way.
    postOrUpdateRoomMessage(rooms[code]);

    console.log(`Room ${code} created by ${name}${rooms[code].isPublic ? " (public)" : " (private)"}`);
  });

  // ---- SET ROOM VISIBILITY (host only) ----
  // Client sends: { isPublic }. [NEW FEATURE] Lets the host flip a room
  // between public/private at any time from the Lobby, not just at
  // creation. Broadcast to the WHOLE room (not just the host) so every
  // player sees the current public/private badge update live, and the
  // Telegram group message (if any) is kept in sync via the same
  // reuse-and-edit mechanism used everywhere else.
  socket.on("setRoomVisibility", ({ isPublic }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;

    if (!room.players[socket.id] || !room.players[socket.id].isHost) {
      socket.emit("setRoomVisibilityError", { message: "Only the host can change room visibility." });
      return;
    }

    const nextIsPublic = !!isPublic;
    if (room.isPublic === nextIsPublic) return; // no actual change - nothing to broadcast or post

    room.isPublic = nextIsPublic;
    io.to(roomCode).emit("roomVisibilityUpdated", { isPublic: room.isPublic });

    // [NEW FEATURE] Fire-and-forget - never awaited, so a slow/failed
    // Telegram call can never delay this broadcast or block the server.
    postOrUpdateRoomMessage(room);

    console.log(`Room ${roomCode} visibility set to ${room.isPublic ? "public" : "private"} by host`);
  });

  // ---- SET DEV MODE (host only) [DEV-BRANCH ONLY TEST FEATURE] ----
  // Client sends: { devMode }. Lets the host flip Dev Mode on/off from the
  // Lobby, same pattern as setRoomVisibility. When on: startGame accepts as
  // few as 2 players, and checkWinCondition skips auto-ending the round -
  // see both for details. Broadcast to the whole room so every player's
  // badge/toggle stays in sync.
  // ---- [BUG FIX - POOL FINALIZE MISMATCH] Live, authoritative pool
  // lookup for THIS socket's actual current room ----
  // Root cause of a real bug: the client's cached roomInfo.pool.onChainPoolId
  // (built up from past roomCreated/roomJoined/poolUpdated events) can go
  // stale relative to the room this socket is ACTUALLY connected to right
  // now - especially after a reconnect, a device/account swap during
  // testing, or any dropped event. A stale pool_id being sent to
  // finalize_pool/request_end_early/report_pool_issue/reactivate_pool
  // fails the contract's own state/host checks, confusingly, for a pool
  // that was never actually played.
  // Fix: every pool-action button now calls this FIRST and uses ONLY the
  // fresh onChainPoolId it returns - never the client's own cached value -
  // right before signing the transaction. socket.data.roomCode is the
  // server's own authoritative record of which room this exact socket
  // connection currently belongs to, so this can never be stale the way a
  // client-side React state value can.
  socket.on("getCurrentRoomPool", (_data, callback) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    const respond = typeof callback === "function" ? callback : (payload) => socket.emit("currentRoomPool", payload);
    if (!room) {
      respond({ ok: false, message: "You're not currently in a room." });
      return;
    }
    if (!room.pool) {
      respond({ ok: false, message: "This room has no pool attached." });
      return;
    }
    respond({ ok: true, roomCode, pool: room.pool });
  });

  socket.on("setDevMode", ({ devMode }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;

    if (!room.players[socket.id] || !room.players[socket.id].isHost) {
      socket.emit("setDevModeError", { message: "Only the host can change Dev Mode." });
      return;
    }

    const nextDevMode = !!devMode;
    if (room.devMode === nextDevMode) return;

    room.devMode = nextDevMode;
    io.to(roomCode).emit("devModeUpdated", { devMode: room.devMode });

    console.log(`Room ${roomCode} Dev Mode set to ${room.devMode} by host`);
  });

  // ---- DEV: FORCE END ROUND (host only) [DEV-BRANCH ONLY TEST FEATURE] ----
  // Manual override so the host can end a Dev Mode test round on demand,
  // since real win-conditions are intentionally skipped while devMode is
  // on. Tries the real conditions first (force=true bypasses the devMode
  // skip inside checkWinCondition) so a legitimately-earned win still
  // shows correctly; if nothing actually qualifies yet (e.g. everyone's
  // still alive), falls back to a neutral "devEnded" result so the host
  // is never stuck unable to get back to the Lobby.
  socket.on("devForceEndGame", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    if (!room.players[socket.id] || !room.players[socket.id].isHost) return;
    if (!room.devMode) return; // no-op outside Dev Mode
    if (room.winner) return; // already decided

    const decided = checkWinCondition(roomCode, true);
    if (!decided) {
      room.winner = "devEnded";
      io.to(roomCode).emit("gameOver", { winner: "devEnded", reason: "devForceEnd" });
      console.log(`Room ${roomCode}: Dev Mode round force-ended by host`);
    }
  });

  // ---- JOIN ROOM ----
  // Client sends: { code, name, avatarId }
  socket.on("joinRoom", async ({ code, name, avatarId, sessionToken }) => {
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

    // [POINTS SYSTEM STEP 0] Same account-resolution + single-session
    // check as createRoom - see the comment there for why this matters.
    // Done before leaveCurrentRoomIfAny/room-mutation below so a
    // rejected join never has any side effects.
    const account = await resolveAccountFromToken(sessionToken);
    if (account && findActiveRoomForAccount(account.accountId)) {
      socket.emit("joinError", { message: "Your account is already active in another room. Leave that room first, or wait a moment if you just closed it." });
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
    room.players[socket.id] = { name, avatarId: finalAvatarId, isHost: false, playerToken, accountId: account?.accountId || null, accountEmail: account?.accountEmail || null, accountUsername: account?.accountUsername || null };
    // [LIVE POOLS SECTION] Add this account to the pool's persistent
    // "ever joined" list (see createRoom's own comment on this field) -
    // this is separate from on-chain pool participation (join_pool) and
    // just tracks who's allowed to find/rejoin this room from the "Your
    // Live Pools" list later.
    if (account && room.pool && !room.pool.everJoinedAccountIds.includes(account.accountId)) {
      room.pool.everJoinedAccountIds.push(account.accountId);
    }
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerToken = playerToken;

    // [LOBBY LEADERBOARD] New player appears in the leaderboard the
    // moment they join, at 0 points, per the planning notes.
    if (account) getOrCreateRoomLeaderboardEntry(room, account.accountId, account.accountUsername);

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
      speedLevel: room.speedLevel || 4,
      isPublic: !!room.isPublic,
      lobbyChat: room.lobbyChat || [],
      devMode: !!room.devMode,
      pool: room.pool || null,
      roomLeaderboard: getRoomLeaderboardList(room),
    });

    // Updated player-list to everyone in the room (new player shows up for everyone)
    io.to(roomCode).emit("playerListUpdated", { players: playerList });
    // [LOBBY LEADERBOARD] Let everyone else's already-open leaderboard
    // view pick up the new player immediately too.
    broadcastRoomLeaderboard(room);

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
      isPublic: !!room.isPublic,
      devMode: !!room.devMode,
      pool: room.pool || null,
      roomLeaderboard: getRoomLeaderboardList(room),
      // [BUG FIX] Restore fellow-Saboteur info on reconnect - a
      // reconnecting Saboteur in a multi-Saboteur game previously lost
      // their partner list entirely on refresh.
      fellowSaboteurs: (playerData.role === "saboteur")
        ? Object.entries(room.players)
            .filter(([id, p]) => id !== socket.id && p.role === "saboteur")
            .map(([, p]) => ({ name: p.name, avatarId: p.avatarId }))
        : [],
      gameStarted: room.gameStarted || false,
      // [BUG FIX] This was the actual root cause of "someone can end up
      // back in a game that's already over, with nobody else in it" -
      // room.gameStarted deliberately stays true even after a winner is
      // decided (only returnToLobby resets it), but this reconnect
      // payload never told the reconnecting client that a winner had
      // already been decided, so the frontend's gameStarted check alone
      // routed them straight back into live gameplay instead of the
      // win/results screen everyone else was already looking at.
      winner: room.winner || null,
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

    // [LOBBY LEADERBOARD] Read accountId/name/avatarId one last time
    // before the delete below removes them.
    if (room.players[socket.id]) {
      snapshotRoomLeaderboardOnDeparture(room, room.players[socket.id].accountId, room.players[socket.id].name, room.players[socket.id].avatarId);
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
        const nextHostId = pickNextHost(room, remaining);
        room.players[nextHostId].isHost = true;
        console.log(`Host migrated to ${nextHostId} in room ${roomCode} (after explicit leave)`);
      }
      io.to(roomCode).emit("playerListUpdated", { players: getPlayerList(roomCode) });
      broadcastRoomLeaderboard(room);
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
    // [LOBBY LEADERBOARD] Live name/avatar changes should reflect
    // immediately for anyone with the leaderboard open, not just next
    // match - per the planning notes ("agar koi apna naam ya avatar
    // change kare toh wo yaha bhi change ho jaye").
    if (room.roomLeaderboard && room.roomLeaderboard[room.players[socket.id].accountId]) {
      broadcastRoomLeaderboard(room);
    }
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
  // ---- POOL GAMES: finalize ----
  // [SMART CONTRACT] No longer a backend action - finalize_pool is
  // host-gated ON THE CONTRACT ITSELF (only a transaction actually
  // signed by the host's own wallet can call it), which the backend has
  // never been able to do on anyone's behalf. The host's client calls
  // the contract directly; this socket event is intentionally gone.

  // ---- POOL GAMES: designate a backup host (host only) ----
  // Client sends: { accountId } - must belong to a player CURRENTLY in
  // this room. See pickNextHost for how this gets used if the actual
  // host later disconnects/leaves.
  socket.on("setPoolBackupHost", ({ accountId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.pool) return;
    if (!room.players[socket.id] || !room.players[socket.id].isHost) {
      socket.emit("poolError", { message: "Only the host can set a backup host." });
      return;
    }
    const validTarget = Object.values(room.players).some((p) => p.accountId === accountId);
    if (!validTarget) {
      socket.emit("poolError", { message: "That player isn't in this room." });
      return;
    }
    room.pool.backupHostAccountId = accountId;
    io.to(roomCode).emit("poolBackupHostSet", { accountId });
  });

  // ---- POOL GAMES: oracle confirms an end-early request ----
  // [SMART CONTRACT] The host calls request_end_early on-chain
  // themselves (their own wallet, their own signature - the backend
  // can't do that step for them). This is the SECOND half of that
  // two-step fairness check: the client asks the backend to have the
  // oracle independently call confirm_end_early, which the contract
  // only accepts within 30 minutes of the host's own request. Today
  // this confirms automatically whenever asked - the real fairness
  // guarantee is that a host alone, with no oracle involvement at all,
  // can never end a pool early; a sturdier reason-check here (e.g.
  // requiring the room to have genuinely lost players) is a reasonable
  // future improvement, not a gap that lets a host act completely
  // unilaterally.
  socket.on("requestOracleConfirmEndEarly", async ({ onChainPoolId }) => {
    if (!onChainPoolId) return;
    const result = await callContractAsOracle("confirm_end_early", { pool_id: onChainPoolId });
    socket.emit("oracleConfirmEndEarlyResult", result);
  });

  socket.on("returnToLobby", async ({ signature } = {}) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    if (!room.players[socket.id]) return;

    room.players[socket.id].inLobbyView = true;

    // [POINTS SYSTEM STEP 2] Commit THIS player's own already-staged
    // points (computed back when the winner was decided - see
    // stagePendingPointsForRoom) now that they've actually made it back
    // to the Lobby, per "a match's points only count once you return to
    // Lobby" from the planning notes. Deleting pendingPoints/pendingWon
    // right away (before the actual DB write even finishes) guards
    // against a double-fire of this event ever double-crediting the
    // same match. Guests (no accountId) never had pendingPoints staged
    // in the first place, so this is naturally a no-op for them.
    const me = room.players[socket.id];
    if (typeof me.pendingPoints === "number" && me.accountId) {
      const awardPoints = me.pendingPoints;
      const awardWon = !!me.pendingWon;
      delete me.pendingPoints;
      delete me.pendingWon;

      // [SMART CONTRACT] If this is a pool room, ALSO report this
      // player's signed result to the contract - this is what actually
      // feeds the on-chain leaderboard finalize_pool pays out from. The
      // off-chain commitPendingPoints below still runs regardless (a
      // pool match still counts toward this player's normal
      // totalPoints/season points too, same as any other match) -
      // independent of whether the on-chain report below succeeds.
      if (room.pool && room.pool.onChainPoolId && signature) {
        const onChainResult = await reportMatchPointsOnChain({
          onChainPoolId: room.pool.onChainPoolId,
          matchId: room.currentMatchId || "",
          accountId: me.accountId,
          points: awardPoints,
          signature,
        });
        socket.emit("onChainPointsReported", onChainResult);
      }

      const result = await commitPendingPoints({
        accountId: me.accountId,
        matchPoints: awardPoints,
        won: awardWon,
        matchId: room.currentMatchId || "",
        roomCode: room.code || roomCode,
        playerName: me.name || "",
        role: me.role || "",
        missionsDone: me.missionsDone || 0,
        killsCount: me.killsCount || 0,
        meetingsSurvivedCount: me.meetingsSurvivedCount || 0,
        sabotageActionsCount: me.sabotageActionsCount || 0,
        ventUsesCount: me.ventUsesCount || 0,
        survived: !!me.alive,
      });
      // [POINTS SYSTEM STEP 2] Tell just this player what they earned and
      // their new running totals - Step 3 (the point-popup/wallet-fly
      // animation) already consumes this on the frontend.
      if (result) socket.emit("pointsCommitted", result);
    }

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

    // [BUG FIX] A player who disconnected mid-game (see the disconnect
    // handler's grace period) but hadn't yet had their grace period
    // expire when the round ENDED was previously left sitting in
    // room.players indefinitely - they'd show up as a stale "ghost"
    // entry in the Lobby's player list (still showing their old name/
    // avatar) even though they're not actually connected, since nothing
    // ever cleaned them up once the game that grace period was
    // protecting had already concluded. Once we're back in the Lobby,
    // that protection no longer serves any purpose - remove them now,
    // the same way the grace-timeout path itself would eventually have.
    Object.keys(room.players).forEach((id) => {
      if (room.players[id].disconnectedAt) {
        const wasHost = room.players[id].isHost;
        snapshotRoomLeaderboardOnDeparture(room, room.players[id].accountId, room.players[id].name, room.players[id].avatarId);
        delete room.players[id];
        if (wasHost) {
          const remaining = Object.keys(room.players);
          if (remaining.length > 0) {
            const nextHostId = pickNextHost(room, remaining);
            room.players[nextHostId].isHost = true;
            console.log(`Host migrated to ${nextHostId} in room ${roomCode} (stale disconnect cleared on Lobby return)`);
          }
        }
      }
    });
    broadcastRoomLeaderboard(room);

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
    // [DEV-BRANCH ONLY TEST FEATURE] Dev Mode drops this to 2 so a host
    // testing solo (2 devices) doesn't need to round up real players.
    // Stays 4 whenever Dev Mode is off - identical to live behavior.
    const MIN_PLAYERS = room.devMode ? 2 : 4;
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
    let clampedSpeedLevel = Number.isInteger(speedLevel) ? speedLevel : (room.speedLevel || 4);
    clampedSpeedLevel = Math.max(2, Math.min(6, clampedSpeedLevel)); // [UPDATE] Range now 2-6 (50-150%), was 1-5 (25-125%)
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
      // [POINTS SYSTEM STEP 2] Per-match counters and any leftover
      // staged points from a previous round in this same room - a fresh
      // match must always start these at zero/absent.
      delete p.killsCount; delete p.meetingsSurvivedCount; delete p.sabotageActionsCount; delete p.ventUsesCount;
      delete p.pendingPoints; delete p.pendingWon;
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

    // [NEW FEATURE] Anchor timestamp for the Saboteur kill-timer (see the
    // saboteurKillTimer interval near the bottom of this file) - every
    // Saboteur's 7-minute "kill or be eliminated" deadline is measured
    // from this single moment, not from when they personally do anything.
    room.gameStartedAt = Date.now();
    // [POINTS SYSTEM STEP 2] Fresh identity for THIS specific match, not
    // the room - see generateMatchId's comment for why these can't just
    // share the room code.
    room.currentMatchId = generateMatchId();

    // [UPDATE] Kill-timer tracking is now room-level (team-wide), not
    // per-player - Om7eth's explicit request: with 2+ Saboteurs, ANY ONE
    // of them landing a kill satisfies the whole team's deadline (not
    // just that individual), and if nobody kills in time, only ONE
    // Saboteur is eliminated (not all of them at once) - the timer then
    // restarts fresh for whichever Saboteur(s) remain. saboteurAtRiskId
    // is whichever Saboteur is the CURRENT target of the countdown -
    // starts as the first one in spawn order, and gets reassigned to the
    // next surviving Saboteur each time one is eliminated (see the
    // interval below).
    room.saboteurTeamHasKilled = false;
    room.saboteurTimerStartedAt = room.gameStartedAt;
    room.saboteurAlarmStage = 0;
    room.saboteurAtRiskId = saboteurIdList[0] || null;
    // [BUG FIX] These two are only ever cleared by the interval's own
    // logic once a meeting ends (see the task-reminder/saboteur-alarm
    // intervals). If the game happened to end (a vote decided the
    // winner) WHILE one was still set - before that interval got a
    // chance to tick and clear it - it would otherwise carry over as a
    // stale, ancient timestamp into this room's NEXT game, causing a
    // huge bogus "pause duration" to get added to everyone's clocks the
    // first time either interval next ran. Explicitly clearing both here
    // guarantees a clean slate every game, regardless of how the
    // previous one ended.
    delete room.taskReminderMeetingPausedAt;
    delete room.saboteurMeetingPausedAt;

    playerIds.forEach((id, spawnIndex) => {
      const role = saboteurIds.has(id) ? "saboteur" : "crewmate";
      room.players[id].role = role;
      room.players[id].alive = true;
      // [NEW FEATURE] Task-reminder tracking - crewmates only (a
      // Saboteur has no missions to be reminded about). Reset fresh
      // every game. See the inactivity-check interval near the bottom
      // of this file for how these get used.
      if (role === "crewmate") {
        room.players[id].lastMissionActivityAt = Date.now();
        room.players[id].inactivityStrikes = 0;
      }
      const payload = {
        role, spawnIndex, speedLevel: clampedSpeedLevel, alive: true, saboteurCount,
        matchId: room.currentMatchId || null,
        onChainPoolId: room.pool?.onChainPoolId || null,
      };
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

    let clamped = Number.isInteger(speedLevel) ? speedLevel : 4;
    clamped = Math.max(2, Math.min(6, clamped)); // [UPDATE] Range now 2-6 (50-150%), was 1-5 (25-125%)
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
    // [POINTS SYSTEM] Per-match vent-use count, raw (capped at points-
    // calculation time - see POINTS.saboteur.maxVentCounted). Counted on
    // "enter" only - "travel" and "exit" are the same single vent-use,
    // not separate ones.
    if (phase === "enter") {
      player.ventUsesCount = (player.ventUsesCount || 0) + 1;
    }

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
    // [UPDATE] Team-wide, not per-killer - ANY Saboteur landing a kill
    // satisfies the whole team's kill-timer deadline (see the
    // saboteurKillTimer interval near the bottom of this file), not just
    // this specific one.
    room.saboteurTeamHasKilled = true;
    // [BUG-PROOFING] If someone OTHER than the currently at-risk
    // Saboteur got this kill, that at-risk Saboteur's screen may already
    // be mid-countdown - tell them specifically to clear it now, rather
    // than leaving a scary countdown ticking toward a deadline that (per
    // the check above) can no longer actually eliminate them.
    if (room.saboteurAtRiskId && room.saboteurAtRiskId !== socket.id) {
      io.to(room.saboteurAtRiskId).emit("saboteurTimerCleared");
    }

    target.alive = false;
    // [POINTS SYSTEM STEP 2] Per-match kill count for this Saboteur -
    // capped (see POINTS.saboteur.maxKillsCounted) when points are
    // actually calculated, not here - this just records the raw count.
    killer.killsCount = (killer.killsCount || 0) + 1;
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
    // [POINTS SYSTEM STEP 2] Per-match sabotage-use count, raw (capped
    // at points-calculation time - see POINTS.saboteur.maxSabotageCounted).
    player.sabotageActionsCount = (player.sabotageActionsCount || 0) + 1;

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

    const newDoneCount = missions.filter((m) => m.done).length;
    // [NEW FEATURE] Task-reminder timer resets on real progress - only
    // when the done-count actually WENT UP (a genuinely completed
    // mission), not on every report (this handler also fires for other,
    // non-completing mission updates). Also clears any accumulated
    // reminder strikes, matching "if they complete a mission within 3
    // minutes, no reminder" - a fresh mission resets the clock entirely.
    if (newDoneCount > (player.missionsDone || 0)) {
      player.lastMissionActivityAt = Date.now();
      player.inactivityStrikes = 0;
    }

    player.missionsList = missions;
    player.missionsDone = newDoneCount;
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
        if (meetingToken.stage !== "chat") return; // already moved on (e.g. 50% skip vote)
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

    // [NEW FEATURE] Full details (name + avatar) of whichever specific
    // body triggered this meeting (only meaningful when reason ===
    // "report" - a self-called meeting has no reportedBodyId) - lets the
    // Emergency Meeting popup show exactly who was found dead and by
    // whom, with avatars, instead of just names in a plain list.
    const reportedBody = room.meeting.reportedBodyId && room.players[room.meeting.reportedBodyId]
      ? {
          id: room.meeting.reportedBodyId,
          name: room.players[room.meeting.reportedBodyId].name,
          avatarId: room.players[room.meeting.reportedBodyId].avatarId,
        }
      : null;

    io.to(roomCode).emit("meetingStarted", {
      calledBy: socket.id,
      callerName: caller.name,
      callerAvatarId: caller.avatarId,
      reason: room.meeting.reason,
      deadPlayerNames,
      reportedBody,
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
  // [UPDATE] Threshold now 60% of alive players (was 50%, before that
  // 80% - Om7eth's explicit iterative tuning). [BUG FIX] totalAlive now
  // uses getActiveAliveCount (excludes anyone currently in a disconnect
  // grace period) - see that function's comment for why.
  socket.on("voteSkipDiscussion", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.meeting || room.meeting.stage !== "chat") return;

    const voter = room.players[socket.id];
    if (!voter || !voter.alive) return;

    room.meeting.skipDiscussionVotes[socket.id] = true;

    const totalAlive = getActiveAliveCount(room);
    const totalSkipVotes = Object.keys(room.meeting.skipDiscussionVotes).length;

    io.to(roomCode).emit("skipDiscussionUpdate", { totalSkipVotes, totalAlive });
    console.log(`Skip vote in room ${roomCode}: ${totalSkipVotes}/${totalAlive}`);

    // Using a tiny epsilon (0.0001) to guard against floating-point
    // rounding making an exact 60% (e.g. 3/5) compute as 0.5999999999
    // instead of exactly 0.6 and missing the threshold by a hair.
    if (totalAlive > 0 && totalSkipVotes / totalAlive >= 0.6 - 0.0001) {
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

  // ---- LOBBY CHAT (Lobby only, everyone currently in the room) ----
  // Client sends: { text, replyTo? }. [NEW FEATURE] Same shape/pattern as
  // sendGhostChatMessage above, just scoped to the Lobby instead of
  // ghosts-only - only usable while !room.gameStarted, and broadcasts to
  // every player currently in the room (not a filtered subset).
  socket.on("sendLobbyChatMessage", ({ text, replyTo }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    if (room.gameStarted) {
      socket.emit("chatError", { message: "Lobby chat isn't available once the game has started." });
      return;
    }

    const sender = room.players[socket.id];
    if (!sender) return;

    const trimmed = (text || "").trim().slice(0, 200);
    if (!trimmed) return;

    const message = {
      id: `${socket.id}-${Date.now()}`,
      senderId: socket.id,
      senderName: sender.name,
      senderAvatar: sender.avatarId,
      text: trimmed,
      timestamp: Date.now(),
      replyTo: (replyTo && replyTo.senderName && replyTo.text)
        ? { senderName: String(replyTo.senderName).slice(0, 40), text: String(replyTo.text).slice(0, 200) }
        : null,
    };

    room.lobbyChat = room.lobbyChat || [];
    room.lobbyChat.push(message);
    // [BUG-PROOFING] Cap the stored backlog so a very long-lived Lobby
    // (people chatting for a while before ever starting a game) can't
    // grow this array without bound - only the most recent 200 messages
    // are kept for new joiners/reconnects; live players still received
    // every message as it was sent, this only affects backlog replay.
    if (room.lobbyChat.length > 200) room.lobbyChat = room.lobbyChat.slice(-200);

    io.to(roomCode).emit("lobbyChatMessageReceived", message);
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

    const totalAlive = getActiveAliveCount(room);
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

    // [UPDATE] Once every currently-active alive player has voted, give
    // it a short 3s buffer (matching the same "let the moment land"
    // pattern used for the discussion-skip transition above) and then
    // finalize automatically, instead of always waiting out the full
    // 30s voting timer even when there's nobody left to vote. Re-checks
    // meeting.stage and the vote count fresh inside the timeout (not the
    // closed-over totalVotes) so a late reconnect/disconnect in that 3s
    // window, or the regular timer already having resolved it, can't
    // cause a double-resolution.
    if (totalAlive > 0 && totalVotes >= totalAlive) {
      // [BUG-PROOFING] Compares the MEETING OBJECT ITSELF (not some
      // token field - room.meeting has none) to detect whether this is
      // still the same meeting 3s later, matching the same reference-
      // identity pattern used for the alarm/chat/voting stage timers
      // elsewhere in this handler.
      const meetingAtVoteComplete = room.meeting;
      setTimeout(() => {
        const stillRoom = rooms[roomCode];
        if (!stillRoom || !stillRoom.meeting) return;
        if (stillRoom.meeting !== meetingAtVoteComplete) return; // a new meeting started
        if (stillRoom.meeting.stage !== "voting") return; // already resolved/moved on
        const stillTotalAlive = getActiveAliveCount(stillRoom);
        const stillTotalVotes = Object.keys(stillRoom.meeting.votes).length;
        if (stillTotalAlive > 0 && stillTotalVotes >= stillTotalAlive) {
          finalizeVoting(roomCode);
        }
      }, 3000);
    }
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
          snapshotRoomLeaderboardOnDeparture(stillRoom, stillRoom.players[socket.id].accountId, stillRoom.players[socket.id].name, stillRoom.players[socket.id].avatarId);
          delete stillRoom.players[socket.id];
          const remaining = Object.keys(stillRoom.players);
          if (remaining.length === 0) {
            markRoomMessageClosedForever(stillRoom); // [NEW FEATURE] fire-and-forget
            delete rooms[roomCode];
            console.log(`Room ${roomCode} deleted (empty after grace period)`);
          } else {
            if (wasHost) {
              const nextHostId = pickNextHost(stillRoom, remaining);
              stillRoom.players[nextHostId].isHost = true;
              console.log(`Host migrated to ${nextHostId} in room ${roomCode} (grace expired)`);
            }
            io.to(roomCode).emit("playerListUpdated", { players: getPlayerList(roomCode) });
            broadcastRoomLeaderboard(stillRoom);
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
        snapshotRoomLeaderboardOnDeparture(stillRoom, stillPlayer.accountId, stillPlayer.name, stillPlayer.avatarId);
        delete stillRoom.players[socket.id];
        const stillRemaining = Object.keys(stillRoom.players);
        if (stillRemaining.length === 0) {
          markRoomMessageClosedForever(stillRoom); // [NEW FEATURE] fire-and-forget
          delete rooms[roomCode];
          console.log(`Room ${roomCode} deleted (empty after Lobby grace period)`);
        } else {
          if (wasHost) {
            const nextHostId = pickNextHost(stillRoom, stillRemaining);
            stillRoom.players[nextHostId].isHost = true;
            console.log(`Host migrated to ${nextHostId} in room ${roomCode} (Lobby grace expired)`);
          }
          io.to(roomCode).emit("playerListUpdated", { players: getPlayerList(roomCode) });
          broadcastRoomLeaderboard(stillRoom);
          console.log(`${stillPlayer.name} removed from room ${roomCode} (Lobby grace period expired)`);
        }
      }
    }, 2 * 60 * 1000);
  });
});

// [NEW FEATURE] Task-reminder + inactivity-kick system. Runs once for
// every active game room every 20s (frequent enough that the 3-minute
// threshold below is never off by more than a few seconds, cheap enough
// that scanning every room's player list this often is a non-issue).
// For every crewmate (alive OR ghost - a dead crewmate can still finish
// missions in this game, see the departedCrewmateMissions/win-condition
// comments elsewhere) who still has incomplete missions and hasn't
// completed one in the last 3 minutes: send them (only them - nobody
// else's screen shows this) a brief reminder popup. After the 4th such
// reminder (Om7eth's explicit "more than 3 times" rule) with still no
// progress, they're removed from the game entirely - and, deliberately
// UNLIKE a normal disconnect/leave (which still counts against the team
// as an anti-exploit measure - see leaveRoom/the disconnect handler),
// an inactivity-kicked player's incomplete missions are simply dropped
// from the shared crew-progress meter and the missions-complete win
// check, instead of being added to departedCrewmateMissions. Punishing
// the whole team for one AFK player who then gets auto-removed anyway
// would be needlessly harsh.
const TASK_REMINDER_INTERVAL_MS = 20 * 1000;
const TASK_REMINDER_THRESHOLD_MS = 3 * 60 * 1000;
const TASK_REMINDER_MAX_STRIKES = 3; // a 4th reminder (strikes > 3) triggers the kick

setInterval(() => {
  const now = Date.now();
  Object.keys(rooms).forEach((roomCode) => {
    const room = rooms[roomCode];
    // [BUG FIX] room.gameStarted deliberately stays true even after a
    // winner is decided (only returnToLobby resets it - see the win-
    // condition/reconnect comments elsewhere), so this check alone let
    // the task-reminder keep running - and even KICKING crewmates for
    // "inactivity" - in a room whose game had already actually ended.
    // Added here too.
    if (!room || !room.gameStarted || room.winner) return;
    // [BUG FIX] Upgraded from just "skip while a meeting is active" to a
    // REAL pause - the earlier version stopped new reminders/kicks from
    // firing during a meeting, but each crewmate's lastMissionActivityAt
    // clock kept silently running in the background the whole time
    // anyway, so a long meeting could make the deadline effectively
    // "catch up" the instant it ended - possibly kicking someone almost
    // immediately as the meeting closes, with no real 3-minute grace
    // window at all. Now the elapsed meeting time is tracked
    // (taskReminderMeetingPausedAt) and, once the meeting ends, added
    // back onto every crewmate's own clock - so a meeting genuinely
    // freezes the countdown instead of just hiding its consequences.
    if (room.meeting) {
      if (!room.taskReminderMeetingPausedAt) room.taskReminderMeetingPausedAt = now;
      return;
    }
    if (room.taskReminderMeetingPausedAt) {
      const pauseDurationMs = now - room.taskReminderMeetingPausedAt;
      Object.values(room.players).forEach((p) => {
        if (p.lastMissionActivityAt) p.lastMissionActivityAt += pauseDurationMs;
      });
      room.taskReminderMeetingPausedAt = null;
    }

    Object.keys(room.players).forEach((id) => {
      const p = room.players[id];
      if (!p || p.role !== "crewmate") return;
      if (p.disconnectedAt) return; // mid-grace-period - not actively playing right now anyway
      const total = p.missionsTotal || 0;
      const done = p.missionsDone || 0;
      if (total === 0 || done >= total) return; // no missions assigned yet, or already all done

      const lastActivity = p.lastMissionActivityAt || now;
      if (now - lastActivity < TASK_REMINDER_THRESHOLD_MS) return;

      p.inactivityStrikes = (p.inactivityStrikes || 0) + 1;
      // Restart the 3-minute window from now, whether this is a normal
      // reminder or the final kick - keeps every subsequent check
      // spaced exactly 3 minutes apart rather than firing again next tick.
      p.lastMissionActivityAt = now;

      if (p.inactivityStrikes > TASK_REMINDER_MAX_STRIKES) {
        const wasHost = p.isHost;
        const playerName = p.name;
        io.to(id).emit("kickedForInactivity");
        snapshotRoomLeaderboardOnDeparture(room, p.accountId, p.name, p.avatarId);
        delete room.players[id];
        console.log(`${playerName} kicked from room ${roomCode} for mission inactivity`);

        const remaining = Object.keys(room.players);
        if (remaining.length === 0) {
          markRoomMessageClosedForever(room); // fire-and-forget
          delete rooms[roomCode];
          return;
        }
        if (wasHost) {
          room.players[pickNextHost(room, remaining)].isHost = true;
        }
        io.to(roomCode).emit("playerListUpdated", { players: getPlayerList(roomCode) });
        broadcastRoomLeaderboard(room);
        io.to(roomCode).emit("playerKickedForInactivity", { name: playerName });
        broadcastCrewProgress(roomCode);
        checkWinCondition(roomCode);
      } else {
        // [UPDATE] Now includes exactly how many warnings this player
        // has had, the max before removal, and how often they recur -
        // Om7eth's explicit request that the reminder itself explain the
        // stakes, not just say "do your mission" with no context.
        io.to(id).emit("taskReminder", {
          strikeNumber: p.inactivityStrikes,
          maxStrikes: TASK_REMINDER_MAX_STRIKES,
          intervalMs: TASK_REMINDER_THRESHOLD_MS,
        });
      }
    });
  });
}, TASK_REMINDER_INTERVAL_MS);

// [NEW FEATURE] Saboteur kill-timer - every Saboteur who hasn't landed
// their first kill within 7 minutes of the game starting is eliminated
// automatically. Deliberately NOT a strike-based system like the
// crewmate task-reminder above (Om7eth's explicit request) - it's a
// single hard deadline per Saboteur, measured from room.gameStartedAt,
// that either gets satisfied (they kill someone, hasKilled flips true -
// see killPlayer) or doesn't. Runs on a tighter 5s interval than the
// task-reminder's 20s, since the final minute is an active countdown
// and needs to feel reasonably real-time rather than jumping in coarse
// steps.
const SABOTEUR_ALARM_CHECK_MS = 5 * 1000;
const SABOTEUR_ALARM_STAGES = [
  { stage: 1, atMs: 0 },                 // immediate alert right at game start
  { stage: 2, atMs: 2 * 60 * 1000 },      // 2 min - alert
  { stage: 3, atMs: 4 * 60 * 1000 },      // 4 min - alert
  { stage: 4, atMs: 6 * 60 * 1000 },      // 6 min - start the final 60s countdown
  { stage: 5, atMs: 7 * 60 * 1000 },      // 7 min - eliminated if still no kill
];

setInterval(() => {
  const now = Date.now();
  Object.keys(rooms).forEach((roomCode) => {
    const room = rooms[roomCode];
    // [BUG FIX] Same fix as the task-reminder interval above -
    // room.gameStarted alone doesn't mean the game is still actually
    // going (it stays true even after a winner is decided, until
    // returnToLobby resets it), so without checking room.winner too,
    // this could keep counting down and even auto-eliminate a Saboteur
    // in a room whose game had already ended.
    if (!room || !room.gameStarted || room.winner || !room.saboteurTimerStartedAt) return;
    // [BUG FIX] Upgraded from just "skip while a meeting is active" to a
    // REAL pause - same reasoning/fix as the task-reminder interval
    // above. The earlier version stopped new alerts/elimination from
    // firing during a meeting, but the elapsed-time calculation kept
    // counting the meeting's own duration anyway, so a long meeting could
    // make the 7-minute deadline effectively "catch up" and eliminate the
    // Saboteur almost the instant the meeting ended - not a real pause,
    // just a delayed consequence. Now saboteurTimerStartedAt itself gets
    // pushed forward by however long the meeting actually took, once it
    // ends, so the deadline genuinely freezes during every meeting
    // instead of silently continuing in the background.
    if (room.meeting) {
      if (!room.saboteurMeetingPausedAt) room.saboteurMeetingPausedAt = now;
      return;
    }
    if (room.saboteurMeetingPausedAt) {
      room.saboteurTimerStartedAt += (now - room.saboteurMeetingPausedAt);
      room.saboteurMeetingPausedAt = null;
    }
    if (room.saboteurTeamHasKilled) return; // whole team is exempt once ANY Saboteur has killed
    const atRiskId = room.saboteurAtRiskId;
    if (!atRiskId) return;
    const p = room.players[atRiskId];
    // [BUG-PROOFING] The at-risk Saboteur disconnected mid-timer - don't
    // eliminate someone who isn't even actively playing right now; just
    // wait (the timer effectively pauses for them until they're back,
    // same spirit as the crewmate inactivity-check skipping disconnected
    // players).
    if (!p || p.role !== "saboteur" || !p.alive || p.disconnectedAt) return;

    const elapsed = now - room.saboteurTimerStartedAt;

    for (const { stage, atMs } of SABOTEUR_ALARM_STAGES) {
      if ((room.saboteurAlarmStage || 0) >= stage) continue; // already sent this milestone
      if (elapsed < atMs) break; // stages are in order - nothing later is due yet either

      room.saboteurAlarmStage = stage;

      if (stage <= 3) {
        // Stages 1-3: a brief "kill someone" alert popup - only the
        // current at-risk Saboteur's screen, nobody else's. [UPDATE] Now
        // includes how much time is left until the 7-minute deadline, so
        // the alert itself explains the stakes instead of just "kill
        // someone soon" with no context.
        const deadlineMs = SABOTEUR_ALARM_STAGES[4].atMs; // stage 5's atMs = 7 minutes
        io.to(atRiskId).emit("saboteurKillAlarm", { stage, remainingMs: Math.max(0, deadlineMs - elapsed) });
      } else if (stage === 4) {
        // Stage 4: hand off to a client-side 60s countdown instead of
        // the server pushing per-second updates - remainingMs is just
        // the starting value (time left until the stage-5, 7-minute
        // deadline), the client counts it down on its own from there.
        const deadlineMs = SABOTEUR_ALARM_STAGES[4].atMs; // stage 5's atMs = 7 minutes
        io.to(atRiskId).emit("saboteurKillCountdownStart", { remainingMs: Math.max(0, deadlineMs - elapsed) });
      } else if (stage === 5) {
        // Stage 5: the deadline passed with zero kills from the WHOLE
        // team - eliminate ONLY this one at-risk Saboteur (never all of
        // them at once), then hand the countdown off to the next
        // surviving, not-yet-tried Saboteur (if any) with a completely
        // fresh 7-minute cycle. A Saboteur eliminated this way becomes a
        // ghost exactly like a normal death (no kill/sabotage ability -
        // both killPlayer and sabotageAction already reject !alive
        // players, so nothing extra is needed there).
        p.alive = false;
        io.to(atRiskId).emit("saboteurEliminatedForInactivity");
        io.to(atRiskId).emit("ghostChatBacklog", { messages: room.ghostChat || [] });
        io.to(roomCode).emit("playerListUpdated", { players: getPlayerList(roomCode) });
        console.log(`${p.name} (Saboteur) auto-eliminated in room ${roomCode} - no kill within 7 minutes`);

        const nextSaboteur = Object.entries(room.players)
          .find(([id, pl]) => id !== atRiskId && pl.role === "saboteur" && pl.alive);
        if (nextSaboteur) {
          room.saboteurAtRiskId = nextSaboteur[0];
          room.saboteurTimerStartedAt = now;
          room.saboteurAlarmStage = 0;
        } else {
          room.saboteurAtRiskId = null; // no more Saboteurs left to time
        }
        checkWinCondition(roomCode); // may end the game right here if that was the last Saboteur
      }
    }
  });
}, SABOTEUR_ALARM_CHECK_MS);

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
