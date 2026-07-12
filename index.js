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
  // [BUG FIX - TOO QUICK TO DECLARE MOBILE CONNECTIONS DEAD] These were
  // left at Socket.io's library defaults (pingInterval 25s, pingTimeout
  // 20s - so a connection that's gone quiet but is technically still
  // open could get force-disconnected in as little as ~25s). Mobile
  // networks routinely have brief stalls (a cell tower handoff, a wifi-
  // to-cellular switch, a few seconds of weak signal) that are NOT the
  // same as the connection actually being gone - a more forgiving
  // pingTimeout means those brief stalls survive as the exact same
  // still-connected session, instead of forcing a full disconnect +
  // reconnect (and the 3-minute mid-game grace period, frozen avatar,
  // etc. that comes with it) for what was really just a few seconds of
  // spotty signal. Doesn't help the OTHER case - the mobile OS actively
  // suspending/killing a backgrounded tab's connection outright - that
  // closes the transport immediately and gets detected right away
  // regardless of these numbers; the visibilitychange-triggered resync
  // (see game.jsx) is what handles THAT case quickly instead.
  pingInterval: 25000,
  pingTimeout: 60000,
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
  // [UPDATE - WALLET-BASED SIGNUP] No longer strictly required - a
  // player who signs up via "Continue with Wallet" has neither an email
  // nor a password at first. See the partial unique index below (same
  // pattern already used for username) - required:true here would have
  // made this impossible outright, and a plain unique:true without the
  // partial filter would collide every wallet-signup account together
  // on email:null, exactly like the old username bug this file already
  // documents and fixed once before.
  email: { type: String, default: null, lowercase: true, trim: true },
  passwordHash: { type: String, default: null },
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
  // [NEW FEATURE - WALLET-BASED IDENTITY] A NEAR wallet the player has
  // cryptographically proven ownership of via a signed message (NEP-413,
  // zero gas, no transaction, nothing on-chain at all) - used for
  // signing in/up, and as a general "verified identity" a player can
  // link even if they signed up with email instead. Completely separate
  // from walletAddress above (the in-game gameplay wallet that actually
  // sends/receives real NEAR for pools) - a player's identity wallet and
  // gameplay wallet are never assumed to be the same wallet.
  verifiedWalletAddress: { type: String, default: null },
  // [NEW FEATURE - NEAR LEGION BADGE] Cached result of checking
  // verifiedWalletAddress against the Initiate-level SBT contract (see
  // checkLegionInitiateSbt) - refreshed every time verifiedWalletAddress
  // itself changes (sign-in, sign-up, link, or change). Cached (not
  // checked live on every read) since this is shown next to the
  // player's username everywhere, including places read very often
  // (leaderboards, player lists) - re-querying mainnet on every single
  // one of those reads would be wasteful and slow.
  hasLegionBadge: { type: Boolean, default: false },
  legionBadgeCheckedAt: { type: Date, default: null },
  // [NEW FEATURE] Staged email for the add-email OTP flow - only ever
  // copied into the real `email` field once the OTP is confirmed (see
  // /profile/confirm-add-email), so a mistyped address never partially
  // takes effect.
  pendingEmail: { type: String, default: null },
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
// [NEW FEATURE - WALLET-BASED SIGNUP] email is no longer required, so it
// needs the exact same partial-unique treatment as username above -
// otherwise every wallet-signup player (email: null) would collide on
// the very second one created.
playerSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: "string" } }, name: "email_partial_unique" }
);
// [NEW FEATURE - WALLET-BASED IDENTITY] Same reasoning - most players
// won't have a verified identity wallet linked at all (null), so this
// must only enforce uniqueness among players who actually have one set.
playerSchema.index(
  { verifiedWalletAddress: 1 },
  { unique: true, partialFilterExpression: { verifiedWalletAddress: { $type: "string" } }, name: "verifiedWalletAddress_partial_unique" }
);

// [BUG FIX - WALLET COLLISION] walletAddress had NO index at all before
// this - the checks added in /wallet/connect, /wallet/create-named-account
// and /profile/setup are all application-level (a findOne query before
// saving), which is normally enough but still has a narrow race-condition
// window if two requests land at almost the same instant. This is the
// actual database-level guarantee two players can never end up sharing a
// wallet address, no matter what. Excludes empty string (walletAddress
// defaults to "" for anyone who hasn't set up a wallet yet - without that
// exclusion, every wallet-less player would collide on "" and only the
// very first one could ever save).
playerSchema.index(
  { walletAddress: 1 },
  { unique: true, partialFilterExpression: { walletAddress: { $type: "string", $ne: "" } }, name: "walletAddress_partial_unique" }
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
  // [NEW FEATURE - ACTIVITY HISTORY] Permanent, never-reused identifier
  // for the ROOM this match belonged to (see generateRoomSessionId) -
  // deliberately separate from roomCode above, which DOES get reused
  // once a room closes. Grouping by roomCode alone would risk merging
  // two completely unrelated games together just because they happened
  // to land on the same 4-letter code months apart. Null on any record
  // written before this field existed - the Activity endpoint falls
  // back to roomCode for those older records specifically.
  roomSessionId: { type: String, default: null, index: true },
  // [NEW FEATURE - ACTIVITY HISTORY: POOL FINANCIALS] Both null for any
  // non-pool (Free Play) match, and for a pool match whose game hasn't
  // settled yet. Set once, at the moment the pool actually distributes
  // (see distributePoolPrizes) - entryFeeNear is set for every real
  // on-chain participant regardless of outcome; poolNearWon is only
  // set (to a real number, possibly 0 if this player didn't place)
  // for participants who were actually eligible to win a payout.
  entryFeeNear: { type: Number, default: null },
  poolNearWon: { type: Number, default: null },
  // [BUG FIX - WALLET HISTORY SHOWED "You lost" FOR A REAL PRIZE PAYOUT]
  // 1/2/3 for a top-3 finisher who actually got paid, null otherwise.
  // Deliberately separate from `won` above - `won` is about the MATCH's
  // crewmate/saboteur outcome, not the pool's overall points ranking, so
  // a player can rank 2nd/3rd in points (and get paid) while having lost
  // their very last individual match, or vice-versa.
  poolRank: { type: Number, default: null },
  // [BUG FIX - TOP 3/PAYOUT INFO NEVER SHOWED] poolId alone (the
  // on-chain contract's pool id) isn't a reliable "was this a paid
  // game" signal - it stays null whenever the on-chain pool contract
  // isn't configured for this deployment (POOL_CONTRACT_ACCOUNT_ID),
  // which is exactly the case in this test/dev environment - so a
  // check like `!!poolId` was always false here even for genuinely
  // paid games, hiding the Activity feature's top-3/entry-fee/payout
  // info entirely. This is set directly from whether the room had a
  // pool config at all, independent of on-chain state.
  isPoolGame: { type: Boolean, default: false },
  earnedAt: { type: Date, default: Date.now, index: true },
});
const MatchRecord = mongoose.model("MatchRecord", matchRecordSchema);

// ============================================================
// [POOL GAMES] A pool is a room where the host picks how many matches
// make up the pool; points from every match in that room accumulate
// into a pool-specific leaderboard (kept live on the room object - see
// room.pool below). Once the last match ends, every participant clicks
// "Confirm" on the final leaderboard - once everyone has, the backend's
// oracle account calls the contract's distribute_prizes ONCE to pay out
// the top 3. See confirmFinalResult further below for the full flow,
// including what happens if not everyone confirms.
// ============================================================

// [REBUILT - CLEAN POOL SYSTEM] The new contract is much simpler than
// before: no per-match signing, no on-chain leaderboard, no oracle
// point-reporting. Every match is played entirely off-chain. The ONLY
// thing the backend's oracle account ever does on-chain is call
// distribute_prizes ONCE per pool, after every participant has clicked
// "Confirm" on the final off-chain leaderboard (see confirmFinalResult
// below) - and even then, it can only ever pay THAT pool's own
// participants, in the ranked order this backend computes from its own
// off-chain leaderboard. It can never redirect funds anywhere else,
// never touch a different pool, and never move money more than once per
// pool (the contract itself enforces that with its own state machine).
// [BUG FIX - ESM-ONLY PACKAGE] near-api-js v7 dropped CommonJS support
// entirely (no more "require('near-api-js')" - this whole backend file
// is still plain CommonJS otherwise, so a straight top-level require
// crashes the server the instant it tries to load). The standard fix
// for using an ESM-only package from CommonJS is a dynamic import()
// instead, which is why every near-api-js call site below awaits
// loadNearAPI() first rather than referencing a top-level nearAPI
// constant directly.
let nearAPIPromise = null;
function loadNearAPI() {
  if (!nearAPIPromise) nearAPIPromise = import("near-api-js");
  return nearAPIPromise;
}
const NEAR_NETWORK = process.env.NEAR_NETWORK || "testnet";
// The deployed contract's own account - e.g. near_saboteur_contract.testnet.
const POOL_CONTRACT_ACCOUNT_ID = process.env.POOL_CONTRACT_ACCOUNT_ID || "";
const ORACLE_ACCOUNT_ID = process.env.ORACLE_ACCOUNT_ID || "";
const ORACLE_PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY || "";
if (!POOL_CONTRACT_ACCOUNT_ID) {
  console.warn("[POOL CONTRACT] POOL_CONTRACT_ACCOUNT_ID not set - on-chain pool features are disabled.");
}
if (!ORACLE_ACCOUNT_ID || !ORACLE_PRIVATE_KEY) {
  console.warn("[POOL CONTRACT] Oracle credentials not set - final prize distribution can't be triggered on-chain.");
}

const NEAR_RPC_URL = `https://rpc.${NEAR_NETWORK}.near.org`;
// [NEW FEATURE - WALLET-BASED IDENTITY] Deliberately hardcoded to
// mainnet, independent of NEAR_NETWORK/NEAR_RPC_URL above (which is
// scoped to whatever network the pool/game contract system currently
// uses - testnet, for now). The identity/verification wallet is a
// totally separate concern from the in-game gameplay wallet - it's
// meant to verify a player's REAL, real-world wallet (e.g. one holding
// an actual Legion SBT), which only ever exists on mainnet.
const MAINNET_RPC_URL = "https://rpc.mainnet.near.org";

// [NEW FEATURE - NEAR LEGION BADGE] Checks whether a wallet holds the
// NEAR Legion "Initiate" level SBT. This is a plain read-only view call
// (like checking a balance) - no gas, no signature, nothing on-chain,
// can be called as often as needed. Tries nft_tokens_for_owner first
// (the standard NEP-171 view method - most NEAR projects that call
// their token an "SBT" are actually a normal NFT contract with
// transfers disabled under the hood, so this is very likely correct),
// and logs clearly if the contract doesn't respond the way it expects
// so this can be adjusted if initiate.nearlegion.near's actual
// interface turns out to be different.
const LEGION_INITIATE_SBT_CONTRACT = "initiate.nearlegion.near";
async function checkLegionInitiateSbt(walletAddress) {
  if (!walletAddress) return false;
  try {
    const args = Buffer.from(JSON.stringify({ account_id: walletAddress, limit: 1 })).toString("base64");
    const rpcRes = await fetch(MAINNET_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "legion-sbt", method: "query",
        params: {
          request_type: "call_function", finality: "final",
          account_id: LEGION_INITIATE_SBT_CONTRACT, method_name: "nft_tokens_for_owner", args_base64: args,
        },
      }),
    });
    const rpcData = await rpcRes.json();
    if (rpcData.error || !rpcData.result || !rpcData.result.result) {
      console.warn(`[LEGION SBT] Unexpected response checking ${walletAddress} against ${LEGION_INITIATE_SBT_CONTRACT} - may need a different method name if this contract's interface isn't standard NEP-171:`, rpcData.error?.message || "no result");
      return false;
    }
    const bytes = Uint8Array.from(rpcData.result.result);
    const tokens = JSON.parse(Buffer.from(bytes).toString("utf8"));
    return Array.isArray(tokens) && tokens.length > 0;
  } catch (e) {
    console.warn(`[LEGION SBT] Check failed for ${walletAddress}:`, e.message);
    return false;
  }
}

// [NEW FEATURE - POOL GAMES: LEGION HUB BONUS MISSION] Everything below
// this point is the Legion Hub bonus mission system - Pool games only.
// Every check here is a plain read-only mainnet view call (exactly like
// checkLegionInitiateSbt above) - no transaction, no signature, no gas,
// no funds ever move. It only ever reads whichever wallet the player has
// already connected to their profile (Player.verifiedWalletAddress),
// live, at the moment they attempt the mission - never trusted from the
// client, so the awarded bonus points can't be spoofed by a modified
// client the same way regular mission points can't be (see
// reportMissionProgress's own security comments for that same
// principle).
const LEGION_ASCENDANT_SBT_CONTRACT = "ascendant.nearlegion.near";
const LEGION_VANGUARD_SBT_CONTRACT = "vanguard.nearlegion.near";
const LEGION_NFT_CONTRACT = "nearlegion.nfts.tg";

// Generic NEP-171-style "does this wallet hold anything from this
// contract" check - same shape as checkLegionInitiateSbt, factored out
// so the three SBT tiers (and the NFT count check below) don't each
// need their own near-identical copy of the RPC plumbing.
async function fetchNftTokensForOwner(contractId, walletAddress) {
  if (!walletAddress) return [];
  try {
    const args = Buffer.from(JSON.stringify({ account_id: walletAddress, limit: 100 })).toString("base64");
    const rpcRes = await fetch(MAINNET_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "legion-bonus", method: "query",
        params: {
          request_type: "call_function", finality: "final",
          account_id: contractId, method_name: "nft_tokens_for_owner", args_base64: args,
        },
      }),
    });
    const rpcData = await rpcRes.json();
    if (rpcData.error || !rpcData.result || !rpcData.result.result) return [];
    const bytes = Uint8Array.from(rpcData.result.result);
    const tokens = JSON.parse(Buffer.from(bytes).toString("utf8"));
    return Array.isArray(tokens) ? tokens : [];
  } catch (e) {
    console.warn(`[LEGION BONUS] nft_tokens_for_owner check failed for ${walletAddress} on ${contractId}:`, e.message);
    return [];
  }
}

// Bonus mission A - "What's your Legion rank?" Checks Vanguard first
// (the highest tier), then Ascendant, then Initiate, stopping at the
// first one the wallet actually holds - cumulative bonus per the
// planning notes: Initiate only = 2, Ascendant = 4 total, Vanguard = 6
// total (never adds more than the single highest tier's own value).
async function checkLegionRankBonus(walletAddress) {
  if (!walletAddress) return { rank: null, points: 0 };
  const vanguardTokens = await fetchNftTokensForOwner(LEGION_VANGUARD_SBT_CONTRACT, walletAddress);
  if (vanguardTokens.length > 0) return { rank: "vanguard", points: 6 };
  const ascendantTokens = await fetchNftTokensForOwner(LEGION_ASCENDANT_SBT_CONTRACT, walletAddress);
  if (ascendantTokens.length > 0) return { rank: "ascendant", points: 4 };
  const initiateTokens = await fetchNftTokensForOwner(LEGION_INITIATE_SBT_CONTRACT, walletAddress);
  if (initiateTokens.length > 0) return { rank: "initiate", points: 2 };
  return { rank: null, points: 0 };
}

// Bonus mission B - "How many Legion NFTs do you hold?" 2 points per
// NFT, capped at 10 NFTs (20 points max).
async function checkLegionNftBonus(walletAddress) {
  const tokens = await fetchNftTokensForOwner(LEGION_NFT_CONTRACT, walletAddress);
  const counted = Math.min(tokens.length, 10);
  return { nftCount: tokens.length, points: counted * 2 };
}

// Bonus mission C - "How much mainnet $NEAR do you hold?" 1 point per
// 10 NEAR, capped at 10 points (100+ NEAR). Deliberately the REAL
// mainnet wallet balance (view_account), not the in-game testnet
// custodial wallet used for actual gameplay - a completely separate
// read, no relation to game funds.
async function checkLegionNearBalanceBonus(walletAddress) {
  if (!walletAddress) return { nearBalance: 0, points: 0 };
  try {
    const rpcRes = await fetch(MAINNET_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "legion-balance", method: "query",
        params: { request_type: "view_account", finality: "final", account_id: walletAddress },
      }),
    });
    const rpcData = await rpcRes.json();
    if (rpcData.error || !rpcData.result || typeof rpcData.result.amount !== "string") {
      return { nearBalance: 0, points: 0 };
    }
    const nearBalance = Number(rpcData.result.amount) / 1e24;
    const points = Math.min(Math.floor(nearBalance / 10), 10);
    return { nearBalance, points };
  } catch (e) {
    console.warn(`[LEGION BONUS] Balance check failed for ${walletAddress}:`, e.message);
    return { nearBalance: 0, points: 0 };
  }
}

const BONUS_MISSION_TYPES = ["rank", "nft", "balance"];
const BONUS_MISSION_LABELS = {
  rank: "Prove Your Legion Rank",
  nft: "Show Your Legion Collection",
  balance: "Prove Your NEAR Holdings",
};

// Picks this match's ONE random bonus mission for a Pool room's Legion
// Hub - never repeats a type already used earlier in the SAME pool room
// (across its several matches), per Om7eth's explicit request. Falls
// back to a fresh random pick (allowing a repeat) only once every type
// has already been used at least once - a safe fallback for later, when
// more match counts / more mission types exist than are wired up today.
function pickBonusMissionType(room) {
  if (!room.usedBonusMissionTypes) room.usedBonusMissionTypes = [];
  let available = BONUS_MISSION_TYPES.filter((t) => !room.usedBonusMissionTypes.includes(t));
  if (available.length === 0) available = BONUS_MISSION_TYPES; // exhausted - see comment above
  const picked = available[Math.floor(Math.random() * available.length)];
  room.usedBonusMissionTypes.push(picked);
  return picked;
}

let oracleAccount = null;
async function getOracleAccount() {
  if (!ORACLE_ACCOUNT_ID || !ORACLE_PRIVATE_KEY) return null;
  if (!oracleAccount) {
    const nearAPI = await loadNearAPI();
    const provider = new nearAPI.JsonRpcProvider({ url: NEAR_RPC_URL });
    oracleAccount = new nearAPI.Account(ORACLE_ACCOUNT_ID, provider, ORACLE_PRIVATE_KEY);
  }
  return oracleAccount;
}

// Free, read-only - anyone can query contract view methods, no signing
// key needed at all. Used to show live on-chain pool status in the
// Lobby and admin dashboard.
let viewProvider = null;
async function viewContract(methodName, args = {}) {
  if (!POOL_CONTRACT_ACCOUNT_ID) return null;
  try {
    if (!viewProvider) {
      const nearAPI = await loadNearAPI();
      viewProvider = new nearAPI.JsonRpcProvider({ url: NEAR_RPC_URL });
    }
    return await viewProvider.callFunction({ contractId: POOL_CONTRACT_ACCOUNT_ID, method: methodName, args });
  } catch (e) {
    console.error(`[POOL CONTRACT] viewContract(${methodName}) failed:`, e.message);
    return null;
  }
}

// The oracle's ONLY allowed action on the contract - see the big
// comment above. Never throws - always resolves to { success, txHash?,
// error? }, since a failed call here is an expected, handled outcome
// (see confirmFinalResult's own retry/hold-timeout handling), never a
// reason to crash the game-over flow it's called from.
async function distributePrizesOnChain(poolId, rankedWinnerAccountIds) {
  if (!POOL_CONTRACT_ACCOUNT_ID) return { success: false, error: "Contract not configured" };
  const account = await getOracleAccount();
  if (!account) return { success: false, error: "Oracle account not configured" };
  try {
    const nearAPI = await loadNearAPI();
    const result = await account.callFunction({
      contractId: POOL_CONTRACT_ACCOUNT_ID,
      methodName: "distribute_prizes",
      args: { pool_id: Number(poolId), ranked_winners: rankedWinnerAccountIds },
      gas: nearAPI.teraToGas("100"),
    });
    return { success: true, result };
  } catch (e) {
    console.error(`[POOL CONTRACT] distributePrizesOnChain(pool ${poolId}) failed:`, e.message);
    return { success: false, error: e.message };
  }
}

// [BUG FIX - REFUND NEVER ACTUALLY WORKED] This used to call
// admin_refund_pool, which is owner-only AND only works on a pool
// that's already Locked and past its 24h hold (see lib.rs) - but every
// caller of this function only ever refunds an OPEN pool (payment
// made, game never actually started). So this could never have
// succeeded here even with owner-level access - wrong method for the
// job entirely. Now calls the new cancel_pool contract method instead,
// which the oracle account is explicitly allowed to call for exactly
// this "never started, refund everyone now" case.
// [REFACTORED - SHARED DISTRIBUTION LOGIC] Pulled out of
// confirmFinalResult so closeRoomPermanently's "stuck room" fallback,
// and now also the auto-confirm-on-leave timer below, can all trigger
// the exact same ranking + on-chain payout logic once, instead of
// duplicating it. Moved to module level (used to live inside the
// per-connection closure) purely so the module-level timer can reach
// it too - it never actually referenced `socket`.
async function distributePoolPrizes(room, roomCode) {
  // [FUNDS SAFETY] Rank every participant with at least 1 point,
  // highest first - ties broken by whoever's leaderboard entry exists
  // first (object key insertion order), same tie-break philosophy the
  // contract itself used to use. Capped to the top 3, matching
  // distribute_prizes' own 50/30/20 split. Filtered down to
  // onChainParticipantAccountIds FIRST - a host-funded pool's own
  // free-joiners can win points and even the match itself, but were
  // never registered on the contract at all (only the host was, by
  // create_pool itself), so they can never be a real payout winner no
  // matter how well they scored - see onChainParticipantAccountIds'
  // own comment on why this list exists at all.
  const rankedAccountIds = Object.entries(room.pool.leaderboard)
    .filter(([accountId, points]) => points > 0 && (room.pool.onChainParticipantAccountIds || []).includes(accountId))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([accountId]) => accountId);

  // [BUG FIX - WRONG ACCOUNT SENT ON-CHAIN] Root cause of a real,
  // confirmed bug: room.pool.leaderboard (like every other pool-
  // tracking field) is keyed by this app's own internal accountId
  // (the Player document's MongoDB _id - see resolveAccountFromToken)
  // - that's the right identity for everything ELSE pool-related
  // (who's allowed to Enter, who still needs to confirm, and so on),
  // but distribute_prizes needs each winner's REAL NEAR wallet
  // address, not this app's internal id for them. Sending the Mongo
  // id straight through made every payout fail on-chain with "X never
  // participated in this pool" - true, since no NEAR account named
  // after a Mongo id ever could have. This looks each ranked winner's
  // actual walletAddress up before calling the contract at all.
  const winnerPlayers = await Player.find({ _id: { $in: rankedAccountIds } }, "walletAddress");
  const walletByAccountId = new Map(winnerPlayers.map((p) => [p._id.toString(), p.walletAddress]));
  // [BUG FIX - WINNERS SHOWED AS "Player"/"0 pts"] Pair each accountId
  // with its wallet address explicitly (rather than two separate
  // parallel arrays) - keeps them correctly aligned even in the edge
  // case where a winner somehow has no wallet on file and gets skipped,
  // which would otherwise have silently shifted a plain wallet-only
  // array out of sync with the accountId order.
  const rankedWinnerPairs = rankedAccountIds
    .map((accountId) => ({ accountId, walletAddress: walletByAccountId.get(accountId) || null }))
    .filter((w) => w.walletAddress); // skip anyone who somehow has no wallet on file - shouldn't happen, but never send a blank/undefined account to the contract
  const rankedWinners = rankedWinnerPairs.map((w) => w.walletAddress);
  const rankedWinnerAccountIds = rankedWinnerPairs.map((w) => w.accountId);
  // [BUG FIX - WALLET HISTORY SHOWED "You lost" FOR A REAL PRIZE PAYOUT]
  // 1-indexed rank per accountId, used below when committing each
  // participant's MatchRecord, so /wallet/history can say "2nd place"
  // instead of relying on the match's own won/lost flag.
  const poolRankByAccountId = new Map(rankedWinnerAccountIds.map((accountId, i) => [accountId, i + 1]));

  io.to(roomCode).emit("poolDistributing", {});
  const outcome = await distributePrizesOnChain(room.pool.onChainPoolId, rankedWinners);
  if (outcome.success) {
    room.pool.state = "Distributed";
  }
  io.to(roomCode).emit("poolDistributed", { success: outcome.success, error: outcome.error || null, rankedWinners, rankedWinnerAccountIds });
  io.to(roomCode).emit("poolUpdated", { pool: room.pool });

  // [NEW FEATURE - ACTIVITY HISTORY: POOL FINANCIALS] Same formula the
  // frontend's own Pool Complete popup already uses (see that
  // component's own comment) - kept identical on purpose so the two
  // can never disagree about what someone actually won. Only computed
  // when the on-chain payout genuinely succeeded - if it failed, no
  // NEAR actually moved, so recording a "won X NEAR" figure here would
  // be recording something that didn't really happen yet.
  const onChainParticipantCount = (room.pool.onChainParticipantAccountIds || []).length;
  const entryFeeNear = Number(room.pool.entryFeeNear || 0);
  const totalFundNear = room.pool.hostFunded ? entryFeeNear : entryFeeNear * onChainParticipantCount;
  const payoutPoolNear = totalFundNear - (totalFundNear * 0.05);
  const splitPctAll = [50, 30, 20];
  const splitTotal = splitPctAll.slice(0, rankedWinnerAccountIds.length).reduce((a, b) => a + b, 0) || 1;
  const nearWonByAccountId = new Map();
  if (outcome.success) {
    rankedWinnerAccountIds.forEach((accountId, i) => {
      nearWonByAccountId.set(accountId, payoutPoolNear * (splitPctAll[i] || 0) / splitTotal);
    });
  }

  // [BUG FIX - POINTS/MATCHRECORD LOST FOR THE POOL'S FINAL MATCH] The
  // pool has now definitively settled - commit pending points for every
  // participant still in the room right now, rather than leaving this
  // entirely dependent on each of them separately clicking Return to
  // Lobby afterward (which may never happen if they close the room or
  // leave right after confirming). This is exactly why a real prize
  // payout could show up in wallet history misclassified as a "refund"
  // - no MatchRecord had ever actually been written for that match.
  for (const socketId of Object.keys(room.players)) {
    try {
      const p = room.players[socketId];
      const isOnChainParticipant = p.accountId && (room.pool.onChainParticipantAccountIds || []).includes(p.accountId);
      const extraFields = isOnChainParticipant
        ? {
            entryFeeNear,
            poolNearWon: nearWonByAccountId.has(p.accountId) ? nearWonByAccountId.get(p.accountId) : 0,
            poolRank: poolRankByAccountId.has(p.accountId) ? poolRankByAccountId.get(p.accountId) : null,
          }
        : {};
      await commitPendingPointsForPlayer(room, socketId, extraFields);
    } catch (e) {
      console.error(`[POINTS] commitPendingPointsForPlayer failed for ${socketId} during pool settlement:`, e.message);
    }
  }
  return outcome;
}

// [NEW FEATURE - SHARED CONFIRM LOGIC] Marks one participant as having
// confirmed the final leaderboard, and triggers distribution the
// moment everyone has - used by BOTH the normal confirmFinalResult
// button press AND the new auto-confirm-on-leave timer below, so
// there's only one place this logic lives.
async function confirmParticipant(room, roomCode, accountId) {
  if (!room.pool || !accountId) return;
  if (!room.pool.participantAccountIds.includes(accountId)) return; // not actually a participant
  if (room.pool.state !== "Locked") return; // already distributed, cancelled, or never started
  // [BUG FIX] Never let this fire before every match is actually done -
  // confirmFinalResult previously had no such guard at all, so a
  // modified client could in theory confirm early and (if everyone
  // else also did) trigger a payout based on an incomplete leaderboard.
  if ((room.pool.matchesPlayed || 0) < room.pool.maxMatches) return;

  if (!room.pool.confirmedAccountIds.includes(accountId)) {
    room.pool.confirmedAccountIds.push(accountId);
  }
  io.to(roomCode).emit("poolUpdated", { pool: room.pool });

  const allConfirmed = room.pool.participantAccountIds.every((id) => room.pool.confirmedAccountIds.includes(id));
  if (!allConfirmed) return;

  await distributePoolPrizes(room, roomCode);
}

// [NEW FEATURE - AUTO-CONFIRM ON LEAVE] Per Om7eth's explicit request:
// if a participant leaves the room WITHOUT having confirmed the final
// leaderboard yet, auto-confirm on their behalf 1 minute after they
// leave (giving them a short window to rejoin and confirm themselves
// first) - otherwise one AFK/uninterested participant could block
// everyone else's prize money forever. If every participant ends up
// leaving this way, the pool auto-confirms and distributes entirely on
// its own. Cancelled if they rejoin before the minute is up (see
// leaveRoom's use of cancelAutoConfirmOnLeave on rejoin - actually
// re-entering the room happens via enterPool, which cancels this too).
const AUTO_CONFIRM_ON_LEAVE_MS = 60 * 1000;
const poolAutoConfirmTimers = {};
function scheduleAutoConfirmOnLeave(roomCode, accountId) {
  const key = `${roomCode}:${accountId}`;
  if (poolAutoConfirmTimers[key]) clearTimeout(poolAutoConfirmTimers[key]);
  poolAutoConfirmTimers[key] = setTimeout(async () => {
    delete poolAutoConfirmTimers[key];
    const room = rooms[roomCode];
    if (!room || !room.pool) return;
    await confirmParticipant(room, roomCode, accountId);
    console.log(`[AUTO-CONFIRM] ${accountId} auto-confirmed the final leaderboard in room ${roomCode} (left without confirming, 1 min grace passed).`);
  }, AUTO_CONFIRM_ON_LEAVE_MS);
}
function cancelAutoConfirmOnLeave(roomCode, accountId) {
  const key = `${roomCode}:${accountId}`;
  if (poolAutoConfirmTimers[key]) {
    clearTimeout(poolAutoConfirmTimers[key]);
    delete poolAutoConfirmTimers[key];
  }
}


// [MULTI-MODE ARCHITECTURE - FOUNDATION] Free Play, Pool, and Paid rooms
// all currently render the exact SAME map - this just labels which mode a
// room belongs to. The label alone changes nothing about how the room
// plays today (Free/Pool/Paid all still use the one shared map + one
// shared game engine). It exists so that WHENEVER a per-mode map is
// actually built later (e.g. special missions on the Pool map, or a
// future Sponsor mode - see MAP_REGISTRY on the frontend for the other
// half of this), the room already knows which mode it is without
// touching anything else. A "sponsor" mode is anticipated here too -
// COMING SOON, not wired up anywhere yet, deliberately left unbuilt
// until it's actually needed.
function getRoomGameMode(room) {
  if (!room.pool) return "free";
  return room.pool.hostFunded ? "pool" : "paid";
  // "sponsor" - COMING SOON. Will need its own branch here once a
  // sponsor-funded room type actually exists.
}

// [BUG FIX - EXTRACTED SHARED HELPER] This used to be built inline only
// inside reconnectToRoom - enterPool (explicitly documented as working
// "equally well... for getting back in after disconnecting or leaving
// mid-game") sent back a MUCH thinner response instead, missing
// fellowSaboteurs, sabotage/kill/disguise cooldowns, activeDisguise,
// activeGateLock/activeSabotageType, activeMeeting (so a returning
// player could be stuck not even knowing a meeting/vote was happening),
// ghostChat, and crewProgress entirely. A pool player who came back via
// the Enter button specifically (rather than the automatic reconnect
// path) got a far less complete restoration - not real data loss (the
// server always had the right state), just never actually SENT most of
// it back. Both call sites now build this exact same payload.
function buildFullRestorePayload(room, playerData, socketId) {
  return {
    gameMode: getRoomGameMode(room),
    players: getPlayerList(room.code),
    role: playerData.role || null,
    alive: playerData.alive !== false,
    isPublic: !!room.isPublic,
    devMode: !!room.devMode,
    pool: room.pool || null,
    matchLimit: room.matchLimit ?? null,
    matchesPlayed: room.matchesPlayed || 0,
    roomLeaderboard: getRoomLeaderboardList(room),
    // [NEW FEATURE - POOL GAMES: LEGION HUB BONUS MISSION] Lets a
    // reconnecting/re-entering player pick up exactly where they left
    // off - which mission is active this match, and whether they
    // already attempted it (so the client never re-prompts a wallet
    // pick for a mission that's already done).
    bonusMission: room.currentBonusMissionType
      ? { type: room.currentBonusMissionType, label: BONUS_MISSION_LABELS[room.currentBonusMissionType] }
      : null,
    bonusMissionDone: !!playerData.bonusMissionDone,
    bonusMissionResult: playerData.bonusMissionResult || null,
    bonusMissionPoints: playerData.bonusMissionPoints || 0,
    fellowSaboteurs: (playerData.role === "saboteur")
      ? Object.entries(room.players)
          .filter(([id, p]) => id !== socketId && p.role === "saboteur")
          .map(([, p]) => ({ name: p.name, avatarId: p.avatarId }))
      : [],
    gameStarted: room.gameStarted || false,
    winner: room.winner || null,
    missionsList: playerData.missionsList || null,
    sabotageUses: playerData.sabotageUses || null,
    sabotageCooldownUntil: playerData.sabotageCooldownUntil || 0,
    killCooldownUntil: playerData.killCooldownUntil || 0,
    meetingCooldownUntil: room.meetingCooldownUntil || 0,
    postKillSabotageLockUntil: playerData.postKillSabotageLockUntil || 0,
    disguiseUsesLeft: typeof playerData.disguiseUsesLeft === 'number' ? playerData.disguiseUsesLeft : null,
    disguiseCooldownUntil: playerData.disguiseCooldownUntil || 0,
    activeDisguise: (playerData.disguiseAvatarId && playerData.disguiseActiveUntil > Date.now())
      ? { avatarId: playerData.disguiseAvatarId, endsAt: playerData.disguiseActiveUntil }
      : null,
    activeGateLock: room.activeGateLock || null,
    activeSabotageType: room.activeSabotageType || null,
    activeMeeting: room.meeting ? {
      stage: room.meeting.stage,
      startedAt: room.meeting.startedAt,
      reason: room.meeting.reason,
      messages: room.meeting.messages || [],
      deadPlayerNames: Object.values(room.players).filter((p) => !p.alive).map((p) => p.name),
      calledBy: room.meeting.calledBy,
      liveVotes: room.meeting.votes || {},
    } : null,
    ghostChat: (playerData.alive === false) ? (room.ghostChat || []) : null,
    crewProgress: room.gameStarted ? computeCrewProgress(room.code) : null,
  };
}

// time before any real result exists: either it never even started
// (Open), or it started but a crash/host-quit meant zero matches ever
// actually got played (Locked with matchesPlayed still 0) - matches
// cancel_pool's own rules in lib.rs exactly. Once even one match has
// been played, this returns false and the pool has to go through the
// normal final-leaderboard settlement instead - there's a real result
// to protect at that point.
function poolIsCancellable(pool) {
  if (!pool) return false;
  if (pool.state === "Open") return true;
  if (pool.state === "Locked" && (pool.matchesPlayed || 0) === 0) return true;
  return false;
}

async function cancelPoolOnChain(poolId) {
  if (!POOL_CONTRACT_ACCOUNT_ID) return { success: false, error: "Contract not configured" };
  const account = await getOracleAccount();
  if (!account) return { success: false, error: "Oracle account not configured" };
  try {
    const nearAPI = await loadNearAPI();
    const result = await account.callFunction({
      contractId: POOL_CONTRACT_ACCOUNT_ID,
      methodName: "cancel_pool",
      args: { pool_id: Number(poolId) },
      gas: nearAPI.teraToGas("100"),
    });
    return { success: true, result };
  } catch (e) {
    console.error(`[POOL CONTRACT] cancelPoolOnChain(pool ${poolId}) failed:`, e.message);
    return { success: false, error: e.message };
  }
}

// [AUTO-CLOSE - EMPTY LOBBY] A Lobby (game never started) that becomes
// completely empty isn't deleted right away - it's kept alive for 3
// more minutes in case the host (or anyone) comes back, then closed
// automatically if it's STILL empty at that point. Cancelled the moment
// anyone actually joins/re-enters. Pool/Paid games attempt an on-chain
// refund on auto-close if money was ever collected and nothing has been
// distributed yet - see refundPoolOnChain's own comment for the current
// limitation there.
const ROOM_EMPTY_AUTOCLOSE_MS = 3 * 60 * 1000;
const roomAutoCloseTimers = {};
function scheduleRoomEmptyClose(roomCode) {
  if (roomAutoCloseTimers[roomCode]) clearTimeout(roomAutoCloseTimers[roomCode]);
  roomAutoCloseTimers[roomCode] = setTimeout(async () => {
    delete roomAutoCloseTimers[roomCode];
    const room = rooms[roomCode];
    if (!room) return;
    if (Object.keys(room.players).length > 0) return; // someone came back - stay open
    if (room.pool && poolIsCancellable(room.pool) && (room.pool.onChainParticipantAccountIds || []).length > 0) {
      const refund = await cancelPoolOnChain(room.pool.onChainPoolId);
      if (refund.success) {
        console.log(`[AUTO-CLOSE] Pool #${room.pool.onChainPoolId} cancelled + refunded on-chain (room ${roomCode} empty 3+ min).`);
      } else {
        console.error(`[AUTO-CLOSE] Pool #${room.pool.onChainPoolId} could NOT be refunded automatically (room ${roomCode} empty 3+ min): ${refund.error}.`);
      }
    }
    markRoomMessageClosedForever(room);
    delete rooms[roomCode];
    console.log(`Room ${roomCode} auto-closed (empty for 3 minutes)`);
  }, ROOM_EMPTY_AUTOCLOSE_MS);
}
function cancelRoomEmptyClose(roomCode) {
  if (roomAutoCloseTimers[roomCode]) {
    clearTimeout(roomAutoCloseTimers[roomCode]);
    delete roomAutoCloseTimers[roomCode];
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

// [NEW FEATURE - WALLET-BASED IDENTITY] NEP-413 off-chain message
// signature verification - this is what lets a player prove they own a
// NEAR wallet with a single free, gas-less signature (no transaction,
// nothing broadcast on-chain, nothing ever moves) instead of a real
// transaction. Every NEAR wallet (HOT, Meteor, etc.) already implements
// signMessage() using exactly this spec on the frontend - this is just
// the matching backend verification.
// REQUIRES: `tweetnacl` and `bs58` npm packages - if these aren't
// already in package.json, add them (`npm install tweetnacl bs58`)
// before deploying this. Both are tiny, dependency-free, and already
// used by the frontend's own nearLite.js for the exact same primitives.
const nacl = require("tweetnacl");
const bs58 = require("bs58");

// Short-lived challenge store - a nonce is only valid for a few minutes
// and only usable once, closing the obvious replay-attack window (someone
// intercepting/reusing an old signature to impersonate a signed-in
// session later). In-memory is fine here: if the server restarts,
// worst case is a handful of in-flight sign-in attempts need to retry -
// nothing is lost or corrupted.
const walletChallenges = new Map(); // nonceBase64 -> { expiresAt }
const WALLET_CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const WALLET_SIGN_RECIPIENT = "near-saboteur.app"; // must match the frontend's own signMessage() call exactly
// [BUG FIX - SIGNATURE VERIFICATION ALWAYS FAILED FOR WALLET LINKING]
// One single message text, used EVERYWHERE (challenge issuance AND
// every verification call site) - previously /profile/link-wallet
// verified against different wording than what /auth/wallet-challenge
// actually issued to sign, so the signed payload could never match what
// was being checked, and every single "Connect" attempt from the
// Profile screen failed with "Signature verification failed" no matter
// what the player did right. The frontend always fetches its challenge
// from the same /auth/wallet-challenge endpoint regardless of purpose,
// so there was never a reason for this to vary by endpoint in the first
// place.
const WALLET_SIGN_MESSAGE = "Sign in to NEAR Saboteur. This only verifies you own this wallet - it never moves any funds or signs a transaction.";

function pruneExpiredWalletChallenges() {
  const now = Date.now();
  for (const [nonce, entry] of walletChallenges) {
    if (entry.expiresAt < now) walletChallenges.delete(nonce);
  }
}

// Borsh-serializes the exact NEP-413 payload structure (a small, fixed
// shape - not worth pulling in the full `borsh` package for just this
// one struct):
//   tag: u32 (LE) = 2147484061  (2^31 + 413)
//   message: string (u32 LE length prefix + utf8 bytes)
//   nonce: [u8; 32]  (fixed, no length prefix)
//   recipient: string (u32 LE length prefix + utf8 bytes)
//   callbackUrl: Option<string> = None (single 0x00 byte, never used here)
function borshSerializeNep413Payload(message, nonceBuf, recipient) {
  const messageBytes = Buffer.from(message, "utf8");
  const recipientBytes = Buffer.from(recipient, "utf8");
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2147484061, 0); // 2^31 + 413
  const messageLen = Buffer.alloc(4);
  messageLen.writeUInt32LE(messageBytes.length, 0);
  const recipientLen = Buffer.alloc(4);
  recipientLen.writeUInt32LE(recipientBytes.length, 0);
  const noCallback = Buffer.from([0x00]);
  return Buffer.concat([tag, messageLen, messageBytes, nonceBuf, recipientLen, recipientBytes, noCallback]);
}

// Verifies the signature is cryptographically valid for the exact
// message/nonce/recipient this server itself issued, AND that the
// public key used to sign is actually a real access key on the claimed
// accountId right now (via RPC) - the first check alone isn't enough on
// its own, since anyone can generate a valid signature from a keypair
// they made up; this second check is what proves that keypair actually
// controls the named account, not just that the signature math works out.
async function verifyWalletSignature({ accountId, publicKey, signature, message, nonceBase64 }) {
  pruneExpiredWalletChallenges();
  const challenge = walletChallenges.get(nonceBase64);
  if (!challenge) return { ok: false, error: "This sign-in request has expired or was already used. Try again." };
  walletChallenges.delete(nonceBase64); // one-time use, regardless of outcome below

  let sigValid = false;
  try {
    const nonceBuf = Buffer.from(nonceBase64, "base64");
    const payload = borshSerializeNep413Payload(message, nonceBuf, WALLET_SIGN_RECIPIENT);
    const payloadHash = crypto.createHash("sha256").update(payload).digest();
    const pubKeyBytes = bs58.decode(String(publicKey).replace(/^ed25519:/, ""));
    const sigBytes = Buffer.from(signature, "base64");
    sigValid = nacl.sign.detached.verify(payloadHash, sigBytes, pubKeyBytes);
  } catch (e) {
    return { ok: false, error: "Malformed signature." };
  }
  if (!sigValid) return { ok: false, error: "Signature verification failed." };

  // Confirm this public key is actually a live access key on the
  // claimed account right now - without this, the signature check above
  // proves nothing about who actually owns `accountId`.
  try {
    const rpcRes = await fetch(MAINNET_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "verify", method: "query",
        params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey },
      }),
    });
    const rpcData = await rpcRes.json();
    if (rpcData.error || !rpcData.result) {
      return { ok: false, error: "Could not confirm this key belongs to that account." };
    }
  } catch (e) {
    return { ok: false, error: "Could not reach the NEAR network to verify - try again." };
  }

  return { ok: true, accountId };
}
function generateSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

// [BUG FIX - WALLET-SIGNUP ACCOUNTS COULD NEVER COMPLETE SETUP] Several
// endpoints on the mandatory post-signup path (profile setup, in-game
// wallet creation) used to look the acting player up by email ONLY -
// which could never match a wallet-signup account (email: null), so
// every wallet-signup player would hit a hard "Account not found" wall
// trying to do the very first required steps after creating their
// account. sessionToken works for every account type, wallet-signup or
// not, so it's tried first; the email fallback is kept so any older
// frontend call site that still only ever sends email keeps working
// unchanged for accounts that do have one.
async function findActingPlayer(req) {
  const sessionToken = String(req.body.sessionToken || "").trim();
  if (sessionToken) {
    const bySession = await Player.findOne({ sessionToken });
    if (bySession && bySession.sessionTokenExpiresAt && bySession.sessionTokenExpiresAt.getTime() > Date.now()) {
      return bySession;
    }
  }
  const email = String(req.body.email || "").trim().toLowerCase();
  if (email) return Player.findOne({ email, verified: true });
  return null;
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
    // [NEW FEATURE - WALLET-BASED IDENTITY] Separate from walletAddress
    // above - this is the verified NEAR wallet used for sign-in/identity,
    // not the in-game gameplay wallet.
    verifiedWalletAddress: p.verifiedWalletAddress || null,
    hasLegionBadge: !!p.hasLegionBadge,
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
const LEGION_BADGE_RECHECK_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// [NEW FEATURE - NEAR LEGION BADGE] Lazily re-checks the cached SBT
// result if it's more than a week stale - called on login/session-
// restore (natural "player is active right now" moments) rather than
// needing a separate scheduled job. Mutates the player in place but
// does NOT save - callers already save the player shortly after for
// their own reasons (session token, etc.), so this just piggybacks on
// that.
async function refreshLegionBadgeIfStale(player) {
  if (!player.verifiedWalletAddress) return;
  const isStale = !player.legionBadgeCheckedAt || (Date.now() - player.legionBadgeCheckedAt.getTime()) > LEGION_BADGE_RECHECK_MS;
  if (!isStale) return;
  player.hasLegionBadge = await checkLegionInitiateSbt(player.verifiedWalletAddress);
  player.legionBadgeCheckedAt = new Date();
}

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
    await refreshLegionBadgeIfStale(player);
    await player.save();

    res.json({ success: true, player: publicPlayer(player), sessionToken: player.sessionToken });
  } catch (err) {
    console.error("[Auth] /auth/login error:", err.message);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

// ---- WALLET SIGN-IN: STEP 1 - CHALLENGE ---- issues a fresh nonce to
// sign. Client sends nothing meaningful here; just asks for a challenge.
app.post("/auth/wallet-challenge", async (req, res) => {
  pruneExpiredWalletChallenges();
  const nonceBuf = crypto.randomBytes(32);
  const nonceBase64 = nonceBuf.toString("base64");
  walletChallenges.set(nonceBase64, { expiresAt: Date.now() + WALLET_CHALLENGE_TTL_MS });
  res.json({
    nonce: nonceBase64,
    recipient: WALLET_SIGN_RECIPIENT,
    message: WALLET_SIGN_MESSAGE,
  });
});

// ---- WALLET SIGN-IN: STEP 2 - VERIFY ---- Client sends:
// { accountId, publicKey, signature, nonce } (nonce/message/publicKey/
// signature all come straight out of the wallet's own signMessage()
// response). Logs in if this wallet is already linked to a player,
// otherwise creates a brand new wallet-based account (no email/password
// at all yet - see /profile/add-email for adding one later).
app.post("/auth/wallet-verify", async (req, res) => {
  try {
    const accountId = String(req.body.accountId || "").trim().toLowerCase();
    const publicKey = String(req.body.publicKey || "").trim();
    const signature = String(req.body.signature || "").trim();
    const nonceBase64 = String(req.body.nonce || "").trim();
    if (!accountId || !publicKey || !signature || !nonceBase64) {
      return res.status(400).json({ message: "Missing signature data." });
    }
    const verify = await verifyWalletSignature({
      accountId, publicKey, signature, nonceBase64,
      message: WALLET_SIGN_MESSAGE,
    });
    if (!verify.ok) return res.status(401).json({ message: verify.error });

    let player = await Player.findOne({ verifiedWalletAddress: accountId });
    if (!player) {
      // Brand new wallet-based account - no email/password at all.
      // [NEW FEATURE - NEAR LEGION BADGE] Check once, right at account
      // creation - this wallet is now permanently tied to this account
      // (until they explicitly change it via /profile/link-wallet,
      // which re-checks then).
      const hasLegionBadge = await checkLegionInitiateSbt(accountId);
      player = await Player.create({
        verifiedWalletAddress: accountId,
        verified: true, // a signed wallet proof IS the verification - no separate OTP step needed
        hasLegionBadge,
        legionBadgeCheckedAt: new Date(),
      });
    }
    if (player.accountHeld) {
      return res.status(403).json({ message: player.accountHeldReason || "This account is currently on hold. Contact support." });
    }
    player.sessionToken = generateSessionToken();
    player.sessionTokenExpiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await player.save();
    res.json({ success: true, player: publicPlayer(player), sessionToken: player.sessionToken });
  } catch (err) {
    console.error("[Auth] /auth/wallet-verify error:", err.message);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

// ---- LINK/CHANGE VERIFIED WALLET (existing player) ---- Client sends:
// { sessionToken, accountId, publicKey, signature, nonce }. Lets an
// email-signup player link their NEAR wallet for the first time, or any
// player CHANGE which wallet is linked - changing is blocked if this
// account has no email on file yet (see the comment below for why).
app.post("/profile/link-wallet", async (req, res) => {
  try {
    const sessionToken = String(req.body.sessionToken || "").trim();
    const player = await Player.findOne({ sessionToken });
    if (!player || !player.sessionTokenExpiresAt || player.sessionTokenExpiresAt.getTime() < Date.now()) {
      return res.status(401).json({ message: "Session expired. Please log in again." });
    }
    // [SAFETY - NEVER LOCK SOMEONE OUT OF THEIR OWN ACCOUNT] If this
    // player has no email at all (a wallet-signup account that never
    // added one) and already has a DIFFERENT wallet linked, changing it
    // now would leave them with no way to ever log in again once this
    // wallet is disconnected - no email/password to fall back to, and
    // the old wallet no longer works. Require an email first in exactly
    // this one case; a first-time link (no wallet linked yet) or an
    // account that already has an email is always fine.
    if (player.verifiedWalletAddress && player.verifiedWalletAddress !== "" && !player.email) {
      return res.status(400).json({ message: "Add an email to your account first, so you always have a way back in - then you can change your connected wallet.", code: "EMAIL_REQUIRED_FIRST" });
    }

    const accountId = String(req.body.accountId || "").trim().toLowerCase();
    const publicKey = String(req.body.publicKey || "").trim();
    const signature = String(req.body.signature || "").trim();
    const nonceBase64 = String(req.body.nonce || "").trim();
    if (!accountId || !publicKey || !signature || !nonceBase64) {
      return res.status(400).json({ message: "Missing signature data." });
    }
    const verify = await verifyWalletSignature({
      accountId, publicKey, signature, nonceBase64,
      message: WALLET_SIGN_MESSAGE,
    });
    if (!verify.ok) return res.status(401).json({ message: verify.error });

    const existing = await Player.findOne({ verifiedWalletAddress: accountId });
    if (existing && String(existing._id) !== String(player._id)) {
      return res.status(409).json({ message: "This wallet is already linked to a different account." });
    }

    player.verifiedWalletAddress = accountId;
    // [NEW FEATURE - NEAR LEGION BADGE] Re-check whenever the linked
    // wallet actually changes - the old wallet's SBT status is no
    // longer relevant once a different wallet is linked.
    player.hasLegionBadge = await checkLegionInitiateSbt(accountId);
    player.legionBadgeCheckedAt = new Date();
    await player.save();
    res.json({ success: true, player: publicPlayer(player) });
  } catch (err) {
    console.error("[Auth] /profile/link-wallet error:", err.message);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

// ---- ADD EMAIL (wallet-signup player without one yet) ---- Client
// sends: { sessionToken, email }. Sends an OTP to confirm - see
// /profile/confirm-add-email for the second step. One-time only: once
// an account has an email on file, this always rejects (matches the
// existing "email/username stay fixed once set" pattern elsewhere).
app.post("/profile/add-email", async (req, res) => {
  try {
    const sessionToken = String(req.body.sessionToken || "").trim();
    const player = await Player.findOne({ sessionToken });
    if (!player || !player.sessionTokenExpiresAt || player.sessionTokenExpiresAt.getTime() < Date.now()) {
      return res.status(401).json({ message: "Session expired. Please log in again." });
    }
    if (player.email) {
      return res.status(400).json({ message: "This account already has an email on file." });
    }
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ message: "Please enter a valid email address." });
    }
    const emailTaken = await Player.findOne({ email });
    if (emailTaken) {
      return res.status(409).json({ message: "This email is already in use on another account." });
    }

    const otpCode = generateOtp();
    player.otpCode = otpCode;
    player.otpExpiresAt = new Date(Date.now() + OTP_TTL_MS);
    player.otpPurpose = "add-email";
    // Stash the pending email separately - not written to the real
    // `email` field until the OTP is actually confirmed below, so a
    // wrong/mistyped address never partially takes effect.
    player.pendingEmail = email;
    await player.save();

    await sendOtpEmail(email, otpCode, "signup");
    res.json({ message: "OTP sent to your email. Enter it to confirm." });
  } catch (err) {
    console.error("[Auth] /profile/add-email error:", err.message);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

// ---- CONFIRM ADD EMAIL ---- Client sends: { sessionToken, otp }
app.post("/profile/confirm-add-email", async (req, res) => {
  try {
    const sessionToken = String(req.body.sessionToken || "").trim();
    const player = await Player.findOne({ sessionToken });
    if (!player || !player.sessionTokenExpiresAt || player.sessionTokenExpiresAt.getTime() < Date.now()) {
      return res.status(401).json({ message: "Session expired. Please log in again." });
    }
    const otp = String(req.body.otp || "").trim();
    if (player.otpPurpose !== "add-email" || !player.otpCode || player.otpCode !== otp) {
      return res.status(400).json({ message: "Incorrect code." });
    }
    if (!player.otpExpiresAt || player.otpExpiresAt.getTime() < Date.now()) {
      return res.status(400).json({ message: "This code has expired. Please try again." });
    }
    if (!player.pendingEmail) {
      return res.status(400).json({ message: "No pending email to confirm." });
    }
    const emailTaken = await Player.findOne({ email: player.pendingEmail, _id: { $ne: player._id } });
    if (emailTaken) {
      return res.status(409).json({ message: "This email is already in use on another account." });
    }
    player.email = player.pendingEmail;
    player.pendingEmail = null;
    player.otpCode = null;
    player.otpExpiresAt = null;
    player.otpPurpose = null;
    await player.save();
    res.json({ success: true, player: publicPlayer(player) });
  } catch (err) {
    console.error("[Auth] /profile/confirm-add-email error:", err.message);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});


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
    // [NEW FEATURE - NEAR LEGION BADGE] Piggyback the lazy weekly
    // recheck on session-restore too - fires every time the app is
    // reopened, frequent enough to keep this reasonably fresh.
    await refreshLegionBadgeIfStale(player);
    await player.save();
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
    // [BUG FIX - WALLET COLLISION] Same class of issue as the named
    // in-game wallet check elsewhere - without this, any player could
    // connect a wallet address someone else had ALREADY linked to their
    // own account, with zero warning. The connecting player still
    // couldn't sign transactions without the real owner's key, but two
    // Player records sharing one walletAddress breaks every off-chain
    // "is this account the participant/host of this pool" check that
    // looks accounts up by wallet address.
    const walletOwner = await Player.findOne({ walletAddress, email: { $ne: email } });
    if (walletOwner) {
      return res.status(409).json({ message: "That wallet is already connected to a different account." });
    }
    player.walletType = "connected";
    player.walletAddress = walletAddress;
    await player.save();
    res.json({ success: true, player: publicPlayer(player) });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "That wallet is already connected to a different account." });
    }
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
    const desiredName = String(req.body.desiredName || "").trim().toLowerCase();
    if (!sessionToken || !publicKey) return res.status(400).json({ message: "Missing session or public key." });
    if (!ORACLE_ACCOUNT_ID || !ORACLE_PRIVATE_KEY) {
      return res.status(503).json({ message: "Named wallets aren't configured on this server yet." });
    }
    const player = await Player.findOne({ sessionToken, verified: true });
    if (!player) return res.status(401).json({ message: "Not logged in." });
    if (!player.username) return res.status(400).json({ message: "Set up your username first." });

    // [BUG FIX - CHOOSE YOUR OWN WALLET NAME] Used to always derive the
    // account name straight from the username - fine for a player's very
    // first wallet, but it's DETERMINISTIC, so creating a genuinely NEW
    // wallet later (after a disconnect/reset) always computed the exact
    // same already-used account id. Combined with the old "already
    // exists -> just reuse it" fallback right below, that silently
    // handed back a seed phrase for a brand new key that was NEVER
    // actually registered on that account (creation had failed) - it
    // looked like a working wallet but couldn't sign a single
    // transaction. The player now picks their own name every time they
    // create a wallet (the frontend suggests their username, but they
    // can change it), so a fresh wallet is guaranteed to be a fresh,
    // genuinely-theirs account.
    const base = desiredName || player.username;
    const sanitized = base.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
    if (sanitized.length < 2) {
      return res.status(400).json({ message: "Wallet name must be at least 2 characters (letters, numbers, _ and - only)." });
    }
    const newAccountId = `${sanitized}.${ORACLE_ACCOUNT_ID}`;

    // [BUG FIX - WALLET COLLISION] If this exact named account already
    // belongs to a DIFFERENT player's record, refuse rather than
    // silently handing back an account this player doesn't actually
    // control the key for.
    const ownerOfThisWallet = await Player.findOne({ walletAddress: newAccountId });
    if (ownerOfThisWallet && String(ownerOfThisWallet._id) !== String(player._id)) {
      return res.status(409).json({ message: "That wallet name is already taken. Please choose a different one." });
    }

    const oracleAccount = await getOracleAccount();
    if (!oracleAccount) return res.status(503).json({ message: "Wallet creation service is temporarily unavailable." });

    try {
      const nearAPI = await loadNearAPI();
      // [NEW FEATURE - TESTNET ONLY] Every new wallet gets funded with a
      // real, spendable 0.05 NEAR right away - but ONLY on testnet,
      // where it's worthless play-money the oracle account can hand out
      // freely so players can actually try Pool/Paid games without a
      // separate faucet trip. On mainnet this must NEVER happen - that
      // would be giving away real money from the oracle's own balance to
      // every signup - so mainnet gets just enough to cover the new
      // account's storage cost and nothing more.
      const fundingAmount = NEAR_NETWORK === "testnet" ? "0.05" : "0.01";
      // [BUG FIX] near-api-js v7's Account.createAccount takes a single
      // options OBJECT, not positional arguments - same migration pattern
      // already applied to callFunction/deployContract elsewhere in this
      // file. The old positional-args call (createAccount(id, key,
      // amount)) crashed internally with "Cannot read properties of
      // undefined (reading 'endsWith')" because the library was reading
      // completely different (undefined) parameters than intended.
      await oracleAccount.createAccount({
        newAccountId,
        publicKey,
        amount: nearAPI.nearToYocto(fundingAmount),
      });
    } catch (createErr) {
      // [BUG FIX] This used to silently treat "already exists" as
      // success and hand back the existing account id anyway - see the
      // big comment above for why that's actually broken (the freshly
      // generated key for THIS attempt was never added to that
      // account). Always a clear, hard error now - the player picks a
      // different name instead of ending up with a wallet that looks
      // fine but can't sign anything.
      if (String(createErr.message || "").toLowerCase().includes("already exists")) {
        return res.status(409).json({ message: "That wallet name is already taken on-chain. Please choose a different one." });
      }
      throw createErr;
    }
    res.json({ accountId: newAccountId });
  } catch (err) {
    console.error("[WALLET] /wallet/create-named-account error:", err.message);
    res.status(500).json({ message: "Could not create your wallet right now. Try again in a moment." });
  }
});

// [NEW FEATURE] Transaction history for the Wallet screen - proxies
// nearblocks' public API (their exact response shape isn't something I
// can verify without live testing, so this is deliberately defensive:
// any field that isn't where expected just falls back to a safe
// default rather than crashing the whole list). Capped at the 10 most
// recent, matching the "only last 10 shown" note in the UI.
app.post("/wallet/history", async (req, res) => {
  try {
    const walletAddress = String(req.body.walletAddress || "").trim();
    if (!walletAddress) return res.status(400).json({ message: "Missing wallet address." });
    const apiBase = NEAR_NETWORK === "testnet" ? "https://api-testnet.nearblocks.io" : "https://api.nearblocks.io";
    // [BUG FIX - ONLY 6 TRANSACTIONS SHOWED] Was fetching just 10 raw
    // txns from nearblocks, then filtering out gas-refund "system"
    // entries - on a wallet with a lot of gas-refund noise that could
    // leave as few as 6 real rows after filtering. Fetching more up
    // front (and keeping up to 20 after filtering) fixes that.
    const url = `${apiBase}/v1/account/${encodeURIComponent(walletAddress)}/txns?per_page=25`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`nearblocks responded with ${resp.status}`);
    const data = await resp.json();
    const rawTxns = Array.isArray(data.txns) ? data.txns : [];
    // [NEW FEATURE - GAME CONTEXT PER TRANSACTION] Pull this wallet's
    // own pool match history once, up front, so every transaction below
    // can be matched against it instead of re-querying per-transaction.
    // Correlates by NEAREST TIMESTAMP (within a generous 48h window,
    // since settlement can lag a bit after a match actually finishes) -
    // there's no direct tx-hash link stored today, so this is the best
    // available signal without a deeper (and much more expensive) per-
    // transaction receipt lookup against nearblocks for every single row.
    let poolMatches = [];
    if (POOL_CONTRACT_ACCOUNT_ID) {
      try {
        const player = await Player.findOne({ walletAddress }, "_id");
        if (player) {
          poolMatches = await MatchRecord.find({ playerId: player._id, poolId: { $ne: null } }, "poolId poolName won points role earnedAt").sort({ earnedAt: -1 }).limit(50);
        }
      } catch (e) {
        console.error("[WALLET] Could not load pool match context:", e.message);
      }
    }
    function findNearestMatch(txTimeMs) {
      if (!txTimeMs || poolMatches.length === 0) return null;
      const WINDOW_MS = 48 * 60 * 60 * 1000;
      let best = null, bestDiff = Infinity;
      for (const m of poolMatches) {
        const diff = Math.abs(new Date(m.earnedAt).getTime() - txTimeMs);
        if (diff < bestDiff && diff <= WINDOW_MS) { best = m; bestDiff = diff; }
      }
      return best;
    }
    const transactions = rawTxns
      // [BUG FIX] NEAR protocol refunds unused prepaid gas back to the
      // signer via a "system"-labeled transfer on EVERY transaction,
      // completely unrelated to deposit amounts or pool payouts (this is
      // exactly what a user reported seeing as confusing "free money" -
      // the amount was near-identical whether the actual deposit was 0.2
      // NEAR or 0, which is the signature of a gas refund, not a real
      // transfer). These aren't meaningful to a player and get filtered
      // out entirely rather than shown as a "Received" transaction.
      .filter((t) => {
        const predecessor = t.predecessor_account_id || t.signer_account_id || t.signer_id || "";
        return predecessor.toLowerCase() !== "system";
      })
      .slice(0, 20)
      .map((t) => {
      const receiver = t.receiver_account_id || t.receiver_id || "";
      const predecessor = t.predecessor_account_id || t.signer_account_id || t.signer_id || "";
      const isReceived = receiver === walletAddress && predecessor !== walletAddress;
      const counterparty = isReceived ? (predecessor || "unknown") : (receiver || "unknown");
      let amountYocto = "0";
      if (t.actions_agg && t.actions_agg.deposit) amountYocto = String(t.actions_agg.deposit);
      else if (Array.isArray(t.actions) && t.actions[0] && t.actions[0].deposit) amountYocto = String(t.actions[0].deposit);
      const amountNear = amountYocto && amountYocto !== "0" ? (Number(amountYocto) / 1e24).toFixed(4) : "0.0000";
      let timestampUtc = "";
      let txTimeMs = null;
      const rawTs = t.block_timestamp || t.timestamp;
      if (rawTs) {
        const ms = String(rawTs).length > 13 ? Number(rawTs) / 1e6 : Number(rawTs);
        txTimeMs = ms;
        timestampUtc = new Date(ms).toISOString().replace("T", " ").slice(0, 16);
      }
      const txHash = t.transaction_hash || t.hash || null;

      // [NEW FEATURE - GAME CONTEXT] Default: an ordinary transfer,
      // nothing pool-related.
      let kind = "transfer";
      let poolName = null;
      let poolId = null;
      let gameOutcome = null; // 'won' | 'lost' | 'placed' | null
      let poolRank = null; // 1/2/3 for a real top-3 prize payout, else null
      let gamePoints = null;
      let gameRole = null;

      if (POOL_CONTRACT_ACCOUNT_ID && counterparty === POOL_CONTRACT_ACCOUNT_ID) {
        // Outgoing call TO the contract - the method name IS directly
        // knowable here, since this wallet itself made the call.
        const method = (Array.isArray(t.actions) && t.actions[0] && t.actions[0].method) || null;
        if (!isReceived && method === "participate") {
          kind = "entry_fee";
        } else if (!isReceived && method === "create_pool") {
          kind = "pool_created";
        } else if (!isReceived && method === "cancel_pool") {
          kind = "cancel_pool";
        } else if (isReceived) {
          // Incoming plain transfer FROM the contract - no method name
          // to read (a Promise::transfer isn't a function call from this
          // wallet's point of view) - correlate against match history
          // instead. A matched record that was actually played means
          // this was a real prize share; no matching record at all in
          // the window means nothing was ever played, so it can only be
          // a cancellation refund.
          const match = findNearestMatch(txTimeMs);
          if (match) {
            kind = "prize";
            poolName = match.poolName || null;
            poolId = match.poolId || null;
            // [BUG FIX - "You lost" SHOWN FOR A REAL PRIZE PAYOUT] A prize
            // transaction only ever exists because this player placed top-3
            // and actually got paid - the match's own won/lost flag (crewmate/
            // saboteur outcome) is a different thing and was misleadingly
            // used here before. Prefer the pool RANK when it's known.
            poolRank = typeof match.poolRank === "number" ? match.poolRank : null;
            gameOutcome = poolRank ? "placed" : (match.won ? "won" : "lost");
            gamePoints = match.points ?? null;
            gameRole = match.role || null;
          } else {
            kind = "refund";
          }
        }
        // If a match was found for an entry_fee/pool_created row too,
        // attach the pool name/outcome for context even though no money
        // moved on THIS specific row for that reason.
        if (!poolName) {
          const match = findNearestMatch(txTimeMs);
          if (match) {
            poolName = match.poolName || null;
            poolId = match.poolId || null;
            if (kind === "entry_fee") {
              gameOutcome = match.won ? "won" : "lost";
              gamePoints = match.points ?? null;
              gameRole = match.role || null;
            }
          }
        }
      }

      return {
        type: isReceived ? "received" : "sent",
        counterparty, amountNear, timestampUtc, txHash,
        kind, poolName, poolId, gameOutcome, poolRank, gamePoints, gameRole,
      };
    });
    res.json({ transactions });
  } catch (err) {
    console.error("[WALLET] /wallet/history error:", err.message);
    res.status(500).json({ message: "Could not load transaction history." });
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
    const player = await findActingPlayer(req);
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
    // [BUG FIX - VIEW SEED PHRASE NEVER WORKED FOR WALLET-SIGNUP
    // ACCOUNTS] A wallet-signup account (see the auth screen's Wallet
    // tab) has no passwordHash at all - /wallet/keystore (which is what
    // actually lets someone view their seed phrase again later from
    // Profile) requires bcrypt-comparing against one, so it could never
    // succeed for them. ONLY set this if the account doesn't already
    // have a real password (never silently overwrite an existing one -
    // this only ever fires once, the very first time a wallet-signup
    // account creates its in-game wallet) and a plaintext password was
    // actually sent (the frontend already collects one here regardless
    // of account type - see the "SET A WALLET PASSWORD" field for a
    // wallet-signup account). This is the exact same password an
    // email-signup account's own password already does double duty for
    // (login AND wallet encryption) - not a new concept, just extending
    // it to an account type that didn't have one yet.
    const plainPassword = String(req.body.password || "");
    if (!player.passwordHash && plainPassword) {
      player.passwordHash = await bcrypt.hash(plainPassword, 10);
    }
    await player.save();
    res.json({ success: true, player: publicPlayer(player) });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "That wallet address is already in use by another account." });
    }
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
    const password = String(req.body.password || "");

    // [BUG FIX] Same email-only lookup gap as /profile/setup and
    // /wallet/create had - fixed the same way.
    const player = await findActingPlayer(req);
    if (!player) {
      return res.status(404).json({ message: "Account not found." });
    }
    const match = await bcrypt.compare(password, player.passwordHash || "");
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

    // [BUG FIX - WALLET-SIGNUP ACCOUNTS COULD NEVER COMPLETE SETUP] Used
    // to look this up by email only - which could never match a
    // wallet-signup account (email: null), permanently blocking every
    // one of them at this exact mandatory step. findActingPlayer tries
    // sessionToken first (works for every account type).
    const player = await findActingPlayer(req);
    if (!player) {
      return res.status(404).json({ message: "Account not found." });
    }

    // [BUG FIX] Uniqueness check excludes THIS player's own current
    // username - otherwise re-saving your own unchanged username would
    // incorrectly report itself as "already taken". Excludes by _id now
    // (not email) - email-based exclusion silently excluded NOBODY for
    // an email-less wallet-signup account, since none of them ever
    // equal empty string.
    const existing = await Player.findOne({ username, _id: { $ne: player._id } });
    if (existing) {
      return res.status(409).json({ message: "That username is already taken." });
    }

    // [BUG FIX - WALLET COLLISION] A player's named in-game wallet is
    // permanently username.ORACLE_ACCOUNT_ID - if they later CHANGE their
    // username, that old wallet still exists on-chain under the old name
    // forever. Without this check, a completely different player could
    // later claim that same old (now-free) username and mint a named
    // wallet that resolves to the EXACT SAME on-chain account someone
    // else already owns/used. Checking walletAddress (not just the live
    // username field) catches this even after the original owner has
    // renamed.
    if (ORACLE_ACCOUNT_ID) {
      const walletCollision = await Player.findOne({ walletAddress: `${username}.${ORACLE_ACCOUNT_ID}`, _id: { $ne: player._id } });
      if (walletCollision) {
        return res.status(409).json({ message: "That username's wallet is already in use by another account - please pick a different username." });
      }
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
    const password = String(req.body.password || "");

    // [BUG FIX] Same email-only lookup gap as the other profile/wallet
    // endpoints - fixed the same way.
    const player = await findActingPlayer(req);
    if (!player) {
      return res.status(404).json({ message: "Account not found." });
    }
    const match = await bcrypt.compare(password, player.passwordHash || "");
    if (!match) {
      return res.status(401).json({ message: "Incorrect password." });
    }

    await Player.deleteOne({ _id: player._id });
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
    .filter((r) => r.isPublic && !r.gameStarted && !r.pool)
    .map((r) => ({
      code: r.code,
      name: r.freeName || "",
      playerCount: Object.keys(r.players).length,
      matchLimit: r.matchLimit ?? null, // null = No Limit
      matchesPlayed: r.matchesPlayed || 0,
    }));
  res.json({ rooms: openRooms });
});

// ---- LIVE POOL GAMES (for the Pool Games page) ----
// Polled whenever the Pool Games page opens. Returns two separate
// lists:
//   - myPools: pools this account has confirmed participation in (paid
//     on-chain via participate(), or freely joined for a host-funded
//     pool - see confirmParticipated/joinFreeHostFundedPool below).
//     These show an "Enter" button (see the enterPool socket handler) -
//     there's no room code anywhere in this whole flow at all; the pool
//     itself, plus a server-side participant check, IS the access
//     control. This is also how someone gets back in after
//     disconnecting/leaving mid-game - just tap Enter on the same pool
//     card again, any time before it's Distributed/Refunded.
//   - publicPools: OTHER open pools (not yet locked - participate()/free
//     joining is still possible) this account hasn't joined. Guests (no
//     sessionToken/account) only ever see this list, and only ever as
//     information - they can't participate (no account to link) or free
//     join (host-funded free-join still needs an account, to track who
//     gets to reconnect later).
app.get("/pools/live", async (req, res) => {
  try {
    const account = await resolveAccountFromToken(req.query.sessionToken);
    const accountId = account?.accountId || null;

    const summarize = (r) => ({
      poolId: r.pool.poolId,
      onChainPoolId: r.pool.onChainPoolId,
      poolName: r.pool.poolName || "Pool Game",
      maxMatches: r.pool.maxMatches,
      matchesPlayed: r.pool.matchesPlayed,
      entryFeeNear: r.pool.entryFeeNear,
      hostFunded: r.pool.hostFunded,
      state: r.pool.state,
      playerCount: Object.keys(r.players).length,
      gameStarted: !!r.gameStarted,
      isHost: accountId ? r.pool.hostAccountId === accountId : false,
    });

    const allPoolRooms = Object.values(rooms).filter((r) => r.pool);

    const myPools = accountId
      ? allPoolRooms.filter((r) => r.pool.participantAccountIds.includes(accountId)).map(summarize)
      : [];

    const publicPools = allPoolRooms
      .filter((r) => r.isPublic && r.pool.state === "Open")
      .filter((r) => !accountId || !r.pool.participantAccountIds.includes(accountId))
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
// [NEW FEATURE - GLOBAL LEADERBOARD] Weekly leaderboard, top 10 - built
// by aggregating MatchRecord (not the cached Player.currentSeasonPoints
// field) because that field only resets lazily, the next time each
// individual player earns more points - a player who simply hasn't
// played since the last Saturday reset would still show their STALE,
// pre-reset total if this queried that field directly. Aggregating
// MatchRecord by actual match timestamp is always accurate regardless
// of who's played recently, matching the field's own original design
// comment ("MatchRecord = full history every leaderboard... actually
// queries").
app.get("/leaderboard/weekly", async (req, res) => {
  try {
    const sessionToken = String(req.query.sessionToken || "").trim();
    const weekStart = getCurrentWeekStartUTC();

    const rows = await MatchRecord.aggregate([
      { $match: { earnedAt: { $gte: weekStart } } },
      { $group: { _id: "$playerId", points: { $sum: "$points" } } },
      { $match: { points: { $gt: 0 } } },
      { $sort: { points: -1 } },
      { $limit: 10 },
    ]);

    const players = await Player.find(
      { _id: { $in: rows.map((r) => r._id) } },
      "name username avatarId hasLegionBadge"
    );
    const byId = new Map(players.map((p) => [p._id.toString(), p]));

    const leaderboard = rows
      .map((r) => {
        const p = byId.get(r._id.toString());
        if (!p) return null; // account since deleted - skip rather than show a blank row
        return { name: p.name, username: p.username, avatarId: p.avatarId, hasLegionBadge: !!p.hasLegionBadge, points: r.points };
      })
      .filter(Boolean)
      .map((entry, i) => ({ ...entry, rank: i + 1 }));

    let myRank = null;
    if (sessionToken) {
      const me = await Player.findOne({ sessionToken });
      if (me && me.sessionTokenExpiresAt && me.sessionTokenExpiresAt.getTime() > Date.now()) {
        const myAgg = await MatchRecord.aggregate([
          { $match: { earnedAt: { $gte: weekStart }, playerId: me._id } },
          { $group: { _id: "$playerId", points: { $sum: "$points" } } },
        ]);
        const myPoints = myAgg[0]?.points || 0;
        if (myPoints > 0) {
          const higherCount = await MatchRecord.aggregate([
            { $match: { earnedAt: { $gte: weekStart } } },
            { $group: { _id: "$playerId", points: { $sum: "$points" } } },
            { $match: { points: { $gt: myPoints } } },
            { $count: "n" },
          ]);
          myRank = {
            rank: (higherCount[0]?.n || 0) + 1,
            name: me.name, username: me.username, avatarId: me.avatarId,
            hasLegionBadge: !!me.hasLegionBadge, points: myPoints,
          };
        }
      }
    }

    res.json({ leaderboard, myRank, weekStart });
  } catch (err) {
    console.error("[LEADERBOARD] /leaderboard/weekly error:", err.message);
    res.status(500).json({ message: "Could not load the leaderboard." });
  }
});

// [NEW FEATURE - GLOBAL LEADERBOARD] All-time leaderboard, top 50 -
// built straight from Player.totalPoints, which is safe to read
// directly here (unlike currentSeasonPoints) since it only ever
// accumulates and is never reset, so there's no staleness concern.
app.get("/leaderboard/alltime", async (req, res) => {
  try {
    const sessionToken = String(req.query.sessionToken || "").trim();

    const top = await Player.find(
      { totalPoints: { $gt: 0 } },
      "name username avatarId hasLegionBadge totalPoints"
    ).sort({ totalPoints: -1 }).limit(50);

    const leaderboard = top.map((p, i) => ({
      rank: i + 1, name: p.name, username: p.username, avatarId: p.avatarId,
      hasLegionBadge: !!p.hasLegionBadge, points: p.totalPoints,
    }));

    let myRank = null;
    if (sessionToken) {
      const me = await Player.findOne({ sessionToken });
      if (me && me.sessionTokenExpiresAt && me.sessionTokenExpiresAt.getTime() > Date.now() && me.totalPoints > 0) {
        const higherCount = await Player.countDocuments({ totalPoints: { $gt: me.totalPoints } });
        myRank = {
          rank: higherCount + 1,
          name: me.name, username: me.username, avatarId: me.avatarId,
          hasLegionBadge: !!me.hasLegionBadge, points: me.totalPoints,
        };
      }
    }

    res.json({ leaderboard, myRank });
  } catch (err) {
    console.error("[LEADERBOARD] /leaderboard/alltime error:", err.message);
    res.status(500).json({ message: "Could not load the leaderboard." });
  }
});

// [NEW FEATURE - ACTIVITY HISTORY] Returns this player's own recent
// games (grouped by room, not flattened by match - see the plan notes
// on why roomSessionId exists at all), each with up to 20 of their own
// matches, plus - for pool/paid games specifically - a top-3 mini
// leaderboard of who actually won that game and how much NEAR they
// were paid, with their Legion badge alongside their name like every
// other username display in this app.
app.get("/activity/games", async (req, res) => {
  try {
    const sessionToken = String(req.query.sessionToken || "").trim();
    if (!sessionToken) return res.status(401).json({ message: "Not logged in." });
    const me = await Player.findOne({ sessionToken });
    if (!me || !me.sessionTokenExpiresAt || me.sessionTokenExpiresAt.getTime() < Date.now()) {
      return res.status(401).json({ message: "Session expired. Please log in again." });
    }

    // Pull a generous recent batch of this player's own records - more
    // than 20 raw records, since several can belong to the same game
    // (a 3-match pool, or an unlimited Free Play session) and still
    // only count as ONE game toward the 20-game limit.
    const myRecords = await MatchRecord.find({ playerId: me._id })
      .sort({ earnedAt: -1 })
      .limit(300);

    // Group by roomSessionId (the permanent id) - falls back to
    // roomCode only for older records written before that field
    // existed, since those can't be grouped any more precisely than
    // that (a real but unavoidable gap for pre-existing history).
    const groups = new Map(); // groupKey -> { records: [...], mostRecentAt }
    for (const r of myRecords) {
      const key = r.roomSessionId || `legacy:${r.roomCode}`;
      if (!groups.has(key)) groups.set(key, { records: [], mostRecentAt: r.earnedAt });
      groups.get(key).records.push(r);
    }

    // Most-recently-played games first, capped to the last 20 GAMES
    // (not matches) - exactly Om7eth's spec.
    const orderedGroups = [...groups.entries()]
      .sort((a, b) => b[1].mostRecentAt - a[1].mostRecentAt)
      .slice(0, 20);

    const games = [];
    for (const [groupKey, group] of orderedGroups) {
      // Chronological within the game (oldest match first, "Match 1, 2, 3...")
      const records = group.records.sort((a, b) => a.earnedAt - b.earnedAt).slice(-20); // last 20 matches within this one game, per Om7eth's spec for unlimited Free Play sessions
      const first = records[0];
      const isPaid = !!first.isPoolGame;
      const displayName = first.poolName || first.roomCode || "Game";
      // [NEW FEATURE - FINANCIALS] Only ONE record in the group actually
      // has these set (see this endpoint's own top comment for why) -
      // find whichever one does, since it's the same fact for the whole
      // game either way.
      const withFinancials = records.find((r) => typeof r.entryFeeNear === "number");
      const entryFeeNear = withFinancials ? withFinancials.entryFeeNear : null;
      const poolNearWon = withFinancials ? withFinancials.poolNearWon : null;

      let topThree = null;
      if (isPaid && first.roomSessionId) {
        // [NEW FEATURE - TOP 3 + PAYOUTS] Aggregate points across EVERY
        // participant in this exact game (not just this player), same
        // ranking logic distributePoolPrizes itself used at settlement
        // time, then join in live Player data (name/username/avatarId/
        // hasLegionBadge) - live, not frozen, matching the standing rule
        // that a badge/username always reflects the CURRENT state
        // wherever it's shown.
        const allRecordsThisGame = await MatchRecord.find({ roomSessionId: first.roomSessionId });
        const pointsByPlayer = new Map();
        const financialsByPlayer = new Map();
        for (const r of allRecordsThisGame) {
          const pid = r.playerId.toString();
          pointsByPlayer.set(pid, (pointsByPlayer.get(pid) || 0) + r.points);
          if (typeof r.poolNearWon === "number" && !financialsByPlayer.has(pid)) {
            financialsByPlayer.set(pid, r.poolNearWon);
          }
        }
        const ranked = [...pointsByPlayer.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
        const rankedPlayers = await Player.find(
          { _id: { $in: ranked.map(([pid]) => pid) } },
          "name username avatarId hasLegionBadge"
        );
        const playerById = new Map(rankedPlayers.map((p) => [p._id.toString(), p]));
        topThree = ranked
          .map(([pid, points], i) => {
            const p = playerById.get(pid);
            if (!p) return null; // account since deleted - skip rather than show a blank row
            return {
              rank: i + 1, name: p.name, username: p.username, avatarId: p.avatarId,
              hasLegionBadge: !!p.hasLegionBadge, points,
              nearWon: financialsByPlayer.has(pid) ? financialsByPlayer.get(pid) : null,
            };
          })
          .filter(Boolean);
      }

      games.push({
        id: groupKey,
        displayName,
        isPaid,
        earnedAtUtc: first.earnedAt,
        entryFeeNear,
        poolNearWon,
        topThree,
        matches: records.map((r) => ({
          role: r.role, won: r.won, points: r.points,
          missionsDone: r.missionsDone, killsCount: r.killsCount,
          meetingsSurvivedCount: r.meetingsSurvivedCount, sabotageActionsCount: r.sabotageActionsCount,
          ventUsesCount: r.ventUsesCount, survived: r.survived,
        })),
      });
    }

    res.json({
      games,
      summary: { totalPoints: me.totalPoints || 0, gamesPlayed: me.gamesPlayed || 0, gamesWon: me.gamesWon || 0 },
    });
  } catch (err) {
    console.error("[ACTIVITY] /activity/games error:", err.message);
    res.status(500).json({ message: "Could not load your activity." });
  }
});

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
      matchLimit: room.matchLimit ?? null,
      matchesPlayed: room.matchesPlayed || 0,
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
        const nearAPI = await loadNearAPI();
        const provider = new nearAPI.JsonRpcProvider({ url: NEAR_RPC_URL });
        const account = await provider.query({ request_type: "view_account", account_id: player.walletAddress, finality: "optimistic" });
        walletBalanceNear = nearAPI.yoctoToNear(account.amount, 4);
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
// [SECURITY FIX - MISSION COMPLETION WAS FULLY CLIENT-TRUSTED] Minimum
// realistic gap between two mission completions from the same player -
// see reportMissionProgress's own comment for the exploit this closes.
const MIN_MISSION_COMPLETE_INTERVAL_MS = 2000;
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

// [NEW FEATURE - ACTIVITY HISTORY] One of these is generated once, when
// a room is first CREATED - unlike generateMatchId (fresh per match) or
// the room code (a short 4-letter string that gets handed out again to
// a totally different room once this one closes), this id is what
// lets every match this room ever hosts be reliably grouped together
// later, even long after the room itself is gone and its code has been
// reused by someone else entirely.
function generateRoomSessionId() {
  return "rs_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
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
    return { accountId: player._id.toString(), accountEmail: player.email, accountUsername: player.username || "", hasLegionBadge: !!player.hasLegionBadge };
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
      // [BUG FIX] A player sitting in a disconnect-grace window (their tab
      // closed, app backgrounded, etc.) is NOT actively blocking anything -
      // that's exactly the "gone for now, might come back" state this grace
      // period exists for. Without this exclusion, a host who left without
      // hitting the explicit LEAVE button (or was just testing - closing and
      // reopening the app) stayed "stuck" unable to create or join ANY other
      // room for the full length of the grace window (2 min in the Lobby, up
      // to 3-4 min mid-game), even though they were plainly not using that
      // old session anymore. Reconnecting to that SAME room still works fine
      // regardless (enterPool/joinRoom/reconnectToRoom never call this check).
      if (p.accountId === accountId && !p.disconnectedAt) return code;
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

// [HOST RETURNS TO CREATOR] Whoever originally created the room (pool
// rooms: room.pool.hostAccountId; plain Free Play rooms:
// room.creatorAccountId) always gets host power back the moment they're
// present in the room again - even if someone else was temporarily
// hosting while they were away. Guests (no account) never trigger this,
// since a guest can't be "the creator" in any way that survives a
// reconnect anyway. Safe to call any time a player's socket enters a
// room (join, re-enter, reconnect) - a no-op if the creator isn't the
// one who just joined, or is already host.
function restoreHostToCreatorIfPresent(room) {
  const creatorId = room.pool ? room.pool.hostAccountId : room.creatorAccountId;
  if (!creatorId) return;
  const creatorSocketId = Object.keys(room.players).find((id) => room.players[id].accountId === creatorId);
  if (!creatorSocketId || room.players[creatorSocketId].isHost) return;
  Object.values(room.players).forEach((p) => { p.isHost = false; });
  room.players[creatorSocketId].isHost = true;
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
  // [NEW FEATURE - POOL GAMES: LEGION HUB BONUS MISSION] Raised from 50
  // - the bonus mission adds up to +20 more on top (the NFT-count
  // mission's own cap) in a Pool room, so the real ceiling is now
  // crewmate 61 / saboteur 67. Still a defensive ceiling only.
  hardCap: 70,
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
  // [NEW FEATURE - POOL GAMES: LEGION HUB BONUS MISSION] Same for both
  // roles - whatever the server already verified and staged on the
  // player object in attemptBonusMission (0 if they never attempted it,
  // or it wasn't a Pool room). Added on top of the role-specific total
  // above, not counted toward either role's own point caps.
  total += player.bonusMissionPoints || 0;
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
    // [POOL GAMES] This is now the DEFINITIVE running total for this
    // pool - there's no separate on-chain leaderboard anymore (see the
    // new contract's own comment on why: no per-match signing/oracle
    // reporting at all). Once every match is done and every participant
    // confirms this exact leaderboard, it's what gets turned into the
    // ranked winners list for distribute_prizes - see confirmFinalResult.
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
  // [POOL GAMES] One match in this pool just ended - advance the count.
  // Once matchesPlayed reaches maxMatches, the frontend shows the final
  // leaderboard with a "Confirm" button for every participant (no wallet
  // signature - just an in-app click) - see confirmFinalResult for what
  // happens once everyone has.
  if (room.pool && room.pool.state === "Locked") {
    room.pool.matchesPlayed += 1;
    // [POOL GAMES] Let the room's Lobby screen show live pool progress
    // (matches played so far, current standings) without needing to
    // poll anything.
    io.to(room.code).emit("poolUpdated", { pool: room.pool });
  } else if (!room.pool && room.matchLimit != null) {
    // [FREE PLAY - MATCH LIMIT] Same idea as pools, but with no money
    // involved there's nothing to confirm/distribute - once the last of
    // the creator's chosen match count ends, everyone in the room just
    // gets the final standings as an automatic popup (see
    // freeRoomComplete below). "No Limit" rooms (matchLimit stays null)
    // never hit this at all - they behave exactly as Free Play always
    // has.
    room.matchesPlayed = (room.matchesPlayed || 0) + 1;
    io.to(room.code).emit("freeRoomProgress", { matchesPlayed: room.matchesPlayed, matchLimit: room.matchLimit });
    if (room.matchesPlayed >= room.matchLimit) {
      io.to(room.code).emit("freeRoomComplete", { leaderboard: getRoomLeaderboardList(room) });
    }
  }
  // [LOBBY LEADERBOARD] Broadcast for every room, not just pools.
  broadcastRoomLeaderboard(room);
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
    room.roomLeaderboard[accountId] = { accountId, username: username || "", matches: [], totalPoints: 0, leftName: null, leftAvatarId: null, leftHasLegionBadge: false };
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
function snapshotRoomLeaderboardOnDeparture(room, accountId, name, avatarId, hasLegionBadge) {
  if (!accountId || !room.roomLeaderboard || !room.roomLeaderboard[accountId]) return;
  const entry = room.roomLeaderboard[accountId];
  if (entry.totalPoints > 0) {
    entry.leftName = name;
    entry.leftAvatarId = avatarId;
    entry.leftHasLegionBadge = !!hasLegionBadge;
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
      // [NEW FEATURE - NEAR LEGION BADGE] Live status if still present,
      // otherwise whatever was last known when they left.
      hasLegionBadge: livePlayer ? !!livePlayer.hasLegionBadge : !!entry.leftHasLegionBadge,
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
        // [BUG FIX] These were never actually set before, on ANY
        // MatchRecord ever written - so a poolId-based lookup (like
        // /wallet/history's win/loss/refund classification) could never
        // find a match for ANY pool game, ever, regardless of whether
        // this function even got called in time.
        poolId: meta.poolId || null,
        poolName: meta.poolName || null,
        isPoolGame: !!meta.isPoolGame,
        roomSessionId: meta.roomSessionId || null,
        entryFeeNear: typeof meta.entryFeeNear === "number" ? meta.entryFeeNear : null,
        poolNearWon: typeof meta.poolNearWon === "number" ? meta.poolNearWon : null,
        poolRank: typeof meta.poolRank === "number" ? meta.poolRank : null,
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

// [BUG FIX - POINTS/MATCHRECORD COULD BE LOST ENTIRELY] Extracted so
// this can ALSO be called as a fallback from places a player's final
// match could end without them ever explicitly clicking "Return to
// Lobby" - most importantly, the moment a pool actually settles (see
// distributePoolPrizes) and whenever a player leaves/disconnects with
// points still staged. Without this, commitPendingPoints (the ONLY
// place points/MatchRecord ever reach the database) could simply never
// fire for a match at all - the exact reason a real prize payout showed
// up in wallet history misclassified as a "refund" (no MatchRecord ever
// existed to match it against, since the winner closed the room right
// after confirming instead of separately tapping Return to Lobby).
async function commitPendingPointsForPlayer(room, socketId, extraFields = {}) {
  const me = room.players[socketId];
  if (!me || typeof me.pendingPoints !== "number" || !me.accountId) return null;
  const awardPoints = me.pendingPoints;
  const awardWon = !!me.pendingWon;
  delete me.pendingPoints;
  delete me.pendingWon;
  return commitPendingPoints({
    accountId: me.accountId,
    matchPoints: awardPoints,
    won: awardWon,
    matchId: room.currentMatchId || "",
    roomCode: room.code || "",
    playerName: me.name || "",
    role: me.role || "",
    missionsDone: me.missionsDone || 0,
    killsCount: me.killsCount || 0,
    meetingsSurvivedCount: me.meetingsSurvivedCount || 0,
    sabotageActionsCount: me.sabotageActionsCount || 0,
    ventUsesCount: me.ventUsesCount || 0,
    survived: !!me.alive,
    poolId: room.pool ? room.pool.onChainPoolId : null,
    poolName: room.pool ? room.pool.poolName : null,
    isPoolGame: !!room.pool,
    roomSessionId: room.sessionId || null,
    ...extraFields,
  });
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
    // [NEW FEATURE - NEAR LEGION BADGE] Cached at room-join time (see
    // resolveAccountFromToken) - lets the frontend show the badge next
    // to this player's name anywhere the player list is used.
    hasLegionBadge: !!p.hasLegionBadge,
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
    // [BUG FIX - DISCONNECTED PLAYER LOOKED FULLY ACTIVE] This was only
    // ever exposed on the separate REST room-info endpoint, never here -
    // but playerListUpdated (this function) is what actually drives the
    // Lobby player list AND the in-game voting/chat player cards. Without
    // it, a player sitting in their grace period (frozen, network down,
    // tab backgrounded, whatever) looked 100% identical to someone
    // actively playing: still listed as available in the Lobby, still
    // shown as a normal vote target with no indication they might never
    // actually cast a vote. Now the frontend can grey them out / label
    // them "Reconnecting..." instead.
    disconnected: !!p.disconnectedAt,
    // [NEW FEATURE - PING DISPLAY] Last round-trip time this player's
    // own client measured and reported (see reportPing) - null until
    // their first measurement comes in, a few seconds after joining.
    pingMs: typeof p.pingMs === 'number' ? p.pingMs : null,
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
  snapshotRoomLeaderboardOnDeparture(oldRoom, oldRoom.players[socket.id].accountId, oldRoom.players[socket.id].name, oldRoom.players[socket.id].avatarId, oldRoom.players[socket.id].hasLegionBadge);
  delete oldRoom.players[socket.id];
  socket.leave(oldRoomCode);

  const remaining = Object.keys(oldRoom.players);
  if (remaining.length === 0) {
    if (wasGameStarted) {
      markRoomMessageClosedForever(oldRoom); // [NEW FEATURE] fire-and-forget
      delete rooms[oldRoomCode];
      console.log(`Room ${oldRoomCode} deleted (empty after player moved to a different room)`);
    } else {
      scheduleRoomEmptyClose(oldRoomCode);
      console.log(`Room ${oldRoomCode} empty (Lobby) - auto-closing in 3 min unless someone returns`);
    }
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

// [NEW FEATURE - SABOTEUR REVEAL] Builds the "who was the Saboteur"
// payload attached to every gameOver broadcast. Per Om7eth's explicit
// request: when the game ends (e.g. the Saboteur's very first kill
// immediately drops crewmates below 2 in a small lobby), the winner
// announcement used to appear instantly with zero indication of who
// the Saboteur actually was - now every saboteur in this match (dead
// or still alive when the game ended - there's always 1-3 of them) is
// included here so the frontend can show a brief reveal before the
// win banner, exactly like the real Among Us "here's who the
// impostor(s) were" moment.
function buildSaboteurReveal(room) {
  return Object.values(room.players)
    .filter((p) => p.role === "saboteur")
    .map((p) => ({ name: p.name, avatarId: p.avatarId }));
}

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
    io.to(roomCode).emit("gameOver", { winner: "saboteur", reason: "elimination", saboteurReveal: buildSaboteurReveal(room) });
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
    io.to(roomCode).emit("gameOver", { winner: "crewmate", reason: "saboteurEjected", saboteurReveal: buildSaboteurReveal(room) });
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
    io.to(roomCode).emit("gameOver", { winner: "crewmate", reason: "missionsComplete", saboteurReveal: buildSaboteurReveal(room) });
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
  // [BUG FIX - NO KILL COOLDOWN AFTER A MEETING] Per Om7eth's explicit
  // request, every surviving Saboteur also gets a fresh 20s kill
  // cooldown the moment a meeting resolves - previously a Saboteur
  // could walk straight out of a meeting and kill again instantly.
  Object.entries(room.players).forEach(([id, p]) => {
    if (p.role === "saboteur" && p.alive) {
      p.killCooldownUntil = Date.now() + 20000;
      io.to(id).emit("sabotageStateSync", {
        sabotageUses: p.sabotageUses || { electricity: 3, hacker: 3, gateLeft: 5, gateRight: 5 },
        sabotageCooldownUntil: p.sabotageCooldownUntil || 0,
        disguiseCooldownUntil: p.disguiseCooldownUntil || 0,
        postKillSabotageLockUntil: p.postKillSabotageLockUntil || 0,
        killCooldownUntil: p.killCooldownUntil,
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
  socket.on("createRoom", async ({ name, avatarId, isPublic, sessionToken, poolConfig, freeConfig }, callback) => {
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

    // [NEW POOL SYSTEM] poolConfig must include the onChainPoolId the
    // host's own wallet already got back from calling the contract's
    // create_pool (with the entry-fee/deposit actually attached there,
    // not through the backend) - the backend only ever links a room to a
    // pool that already exists on-chain, it never creates one itself (it
    // has no wallet of its own to fund a pool with). Guests can't host a
    // pool - there's no account to link. poolConfig is otherwise
    // entirely optional; an ordinary Free Play room just never has
    // room.pool at all.
    let poolSetup = null;
    if (poolConfig && account && poolConfig.onChainPoolId) {
      const maxMatches = Math.max(1, Math.min(5, parseInt(poolConfig.maxMatches, 10) || 1));
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
        // Mirrors the contract's own PoolState ("Open" | "Locked" |
        // "Distributed" | "Refunded") - kept in sync via
        // confirmPoolLocked/confirmFinalResult below, so the Lobby/Pool
        // Games list can show accurate status without a view-call round
        // trip every time.
        state: "Open",
        // [ACCESS CONTROL] Every accountId allowed to Enter/re-Enter this
        // room and see it under "My Pools" - a host-funded pool's own
        // free-joiners belong here (see joinFreeHostFundedPool) even
        // though they were never registered on the CONTRACT itself (see
        // onChainParticipantAccountIds below for that, separate, list).
        participantAccountIds: hostFunded ? [account.accountId] : [],
        // [BUG FIX - WRONG WINNERS PAID] Root cause of a real, confirmed
        // bug: this used to not exist at all, and confirmFinalResult
        // ranked EVERY accountId in the off-chain leaderboard for
        // payout - including a host-funded pool's free-joining, non-
        // paying players, who were never made real on-chain
        // participants by anything (a host-funded pool's own
        // create_pool only ever registers the HOST on-chain; joining
        // for free never calls the contract at all - see
        // joinFreeHostFundedPool's own comment). If one of them won,
        // distribute_prizes correctly rejected the whole payout with
        // "X never participated in this pool" - true, since they
        // genuinely never had. This is the definitive, contract-
        // matching list confirmFinalResult must filter the leaderboard
        // against before ranking anyone for a real payout.
        onChainParticipantAccountIds: hostFunded ? [account.accountId] : [],
        // Off-chain running total per participant across every match
        // played in this pool - the definitive source for computing the
        // final ranked winners once every match is done (there's no
        // on-chain equivalent anymore - see confirmFinalResult).
        leaderboard: {},
        // Who has clicked "Confirm" on the final leaderboard - once this
        // covers every participant, distribute_prizes fires automatically.
        // See confirmFinalResult.
        confirmedAccountIds: [],
      };
    }

    let code = generateRoomCode();
    // Extremely unlikely to collide, but check anyway for safety
    while (rooms[code]) {
      code = generateRoomCode();
    }

    const playerToken = generatePlayerToken();

    // [FREE PLAY - MATCH LIMIT] Only ever set on an ordinary (non-pool)
    // room - a pool room already has its own maxMatches/matchesPlayed on
    // room.pool. matchLimit is null for "No Limit" (the room just keeps
    // going, exactly like every Free Play room always has), or 1/2/3 -
    // once matchesPlayed reaches it, startGame refuses to start another
    // match (see the check below) and the Lobby badge shows it's done.
    // Entirely optional/backward-compatible: a plain createRoom call with
    // no freeConfig at all (every existing caller) behaves exactly as
    // before - matchLimit stays null, i.e. unlimited, forever.
    let freeName = "";
    let matchLimit = null;
    if (!poolSetup && freeConfig) {
      freeName = String(freeConfig.name || "").slice(0, 40);
      const rawLimit = freeConfig.maxMatches;
      if (rawLimit && rawLimit !== "nolimit") {
        const parsed = parseInt(rawLimit, 10);
        if (Number.isFinite(parsed) && parsed > 0) matchLimit = Math.max(1, Math.min(3, parsed));
      }
    }

    rooms[code] = {
      code,
      // [NEW FEATURE - ACTIVITY HISTORY] Permanent, generated once here
      // and never touched again for this room's whole lifetime - see
      // generateRoomSessionId's own comment for why this has to be
      // separate from the reusable room code.
      sessionId: generateRoomSessionId(),
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
      // [FUTURE - PER-MODE MAPS, not implemented yet] Tags which of the
      // three game types this room is, so a future map-data-per-mode
      // feature can pick the right layout without touching any of the
      // current shared ROOMS/DOORS/TASK_POINTS/VENT_* map constants.
      // Purely informational today - nothing reads this yet, so it's
      // safe: it can never change existing behavior. 'sponsor' is a
      // planned 4th mode, not built yet.
      gameMode: poolSetup ? (poolSetup.hostFunded ? "pool" : "paid") : "free",
      // [FREE PLAY - MATCH LIMIT] See the comment above - both stay at
      // their defaults (empty name, unlimited) for any room created
      // without freeConfig, and are simply unused for pool rooms.
      freeName,
      matchLimit,
      matchesPlayed: 0,
      // [HOST RETURNS TO CREATOR] null for guests (nothing to restore
      // to). Pool rooms don't use this field at all - room.pool.hostAccountId
      // already serves the exact same purpose there.
      creatorAccountId: poolSetup ? null : (account?.accountId || null),
      players: {
        // [POINTS SYSTEM STEP 0] accountId/accountEmail are null for
        // guests - every point-crediting/gating check downstream treats
        // a null accountId as "don't award points, this is a guest",
        // consistent with the guest-mode rules already in the frontend.
        [socket.id]: { name, avatarId, isHost: true, playerToken, accountId: account?.accountId || null, accountEmail: account?.accountEmail || null, accountUsername: account?.accountUsername || null, hasLegionBadge: !!account?.hasLegionBadge },
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
      gameMode: rooms[code].gameMode,
      matchLimit: rooms[code].matchLimit ?? null,
      matchesPlayed: rooms[code].matchesPlayed || 0,
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
      gameMode: rooms[code].gameMode,
      matchLimit: rooms[code].matchLimit ?? null,
      matchesPlayed: rooms[code].matchesPlayed || 0,
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

  // ---- [NEW POOL SYSTEM] Confirm on-chain participation ----
  // Called right after the frontend's own participate() (or, for the
  // host, create_pool) call succeeds on-chain. There's no room code
  // anywhere in this flow at all - the pool's own participant list IS
  // the access control (see /pools/live and enterPool below); this just
  // records that this account belongs on it. The frontend follows this
  // up by refetching /pools/live, where this pool's card now shows
  // "Enter" instead of "Participate" for them.
  socket.on("confirmParticipated", async ({ onChainPoolId, sessionToken }, callback) => {
    const respond = typeof callback === "function" ? callback : () => {};
    const account = await resolveAccountFromToken(sessionToken);
    if (!account) { respond({ ok: false, message: "You need to be logged in with a wallet to do this." }); return; }
    const room = Object.values(rooms).find((r) => r.pool && r.pool.onChainPoolId === String(onChainPoolId));
    if (!room) { respond({ ok: false, message: "Couldn't find that pool's room - it may have been removed." }); return; }
    if (!room.pool.participantAccountIds.includes(account.accountId)) {
      room.pool.participantAccountIds.push(account.accountId);
    }
    // This account really did just call participate() on-chain (see the
    // frontend's own handleParticipateInPool) - unlike a host-funded
    // pool's free-joiners, they're genuinely eligible for a real payout.
    if (!room.pool.onChainParticipantAccountIds.includes(account.accountId)) {
      room.pool.onChainParticipantAccountIds.push(account.accountId);
    }
    respond({ ok: true });
  });

  // [BUG FIX - COULD NEVER BE PAID] joinFreeHostFundedPool used to live
  // here as an OFF-CHAIN-ONLY join for a host-funded pool's non-host
  // players - since the contract used to flatly reject participate()
  // for that pool type, there was nothing on-chain to call at all. That
  // meant a non-host winner could score the whole match and still never
  // be a real, payable participant in the contract's eyes -
  // distribute_prizes correctly (if unhelpfully) refused to pay someone
  // it had genuinely never heard of. The real fix lives in the
  // contract's own participate() (see lib.rs) - it now accepts a 0
  // deposit for a host-funded pool instead of rejecting the call
  // outright, so joining for free is a real (if zero-value) on-chain
  // transaction. The frontend's handleJoinFreePool now calls
  // participate() itself and follows it with the exact same
  // confirmParticipated call a paying participant uses - no separate
  // free-join event needed here anymore.

  // ---- [NEW POOL SYSTEM] Enter a pool's room ----
  // The single door into every pool room, for hosts, paying
  // participants, and free-joined participants alike - there's no room
  // code involved anywhere; access is purely "is this account on this
  // pool's own participant list" (see confirmParticipated/
  // joinFreeHostFundedPool above, both of which must succeed BEFORE
  // this is ever called). Works equally well for a first-time entry and
  // for getting back in after disconnecting or leaving mid-game -
  // there's no separate "reconnect" step to remember for pools
  // specifically, just tap the same pool card's Enter button again.
  socket.on("enterPool", async ({ onChainPoolId, name, avatarId, sessionToken }, callback) => {
    const ack = typeof callback === "function" ? callback : () => {};
    const account = await resolveAccountFromToken(sessionToken);
    if (!account) { ack({ ok: false, message: "You need to be logged in with a wallet to enter a pool." }); return; }
    const room = Object.values(rooms).find((r) => r.pool && r.pool.onChainPoolId === String(onChainPoolId));
    if (!room) { ack({ ok: false, message: "This pool's room no longer exists." }); return; }
    if (!room.pool.participantAccountIds.includes(account.accountId) && account.accountId !== room.pool.hostAccountId) {
      ack({ ok: false, message: "You haven't joined this pool yet." });
      return;
    }
    const roomCode = room.code;
    // [NEW FEATURE - AUTO-CONFIRM ON LEAVE] They're back - cancel their
    // 1-minute auto-confirm grace timer (if one was running) so they
    // get the chance to tap Confirm themselves again instead of it
    // firing automatically out from under them.
    cancelAutoConfirmOnLeave(roomCode, account.accountId);

    // [RETURNING PLAYER] They were already in this room under some
    // earlier (now-stale) socket.id - move their existing data over
    // instead of creating a brand new player entry, so mid-game state
    // (role, alive/dead, missions, etc.) survives a disconnect/rejoin
    // exactly like reconnectToRoom does. This covers both "still in the
    // room list but their socket dropped" and "explicitly left, now
    // tapping Enter again to come back".
    const oldId = Object.keys(room.players).find((id) => room.players[id].accountId === account.accountId);
    if (oldId && oldId !== socket.id) {
      const playerData = room.players[oldId];
      delete playerData.disconnectedAt;
      delete room.players[oldId];
      room.players[socket.id] = playerData;
      const oldSocket = io.sockets.sockets.get(oldId);
      if (oldSocket && oldSocket.connected) oldSocket.disconnect(true);
    } else if (!oldId) {
      // Genuinely new to this room's socket-side player list (e.g. the
      // host, right after create_pool, entering for the first time).
      if (room.gameStarted) {
        ack({ ok: false, message: "This game is already in progress - wait for it to end." });
        return;
      }
      const playerToken = generatePlayerToken();
      const takenAvatarIds = new Set(Object.values(room.players).map((p) => p.avatarId));
      let finalAvatarId = avatarId;
      if (takenAvatarIds.has(avatarId)) {
        const allAvatarIds = ["purple", "green", "red", "black", "darkgreen", "magenta", "yellow", "brown", "orange", "cyan"];
        finalAvatarId = allAvatarIds.find((id) => !takenAvatarIds.has(id)) || avatarId;
      }
      room.players[socket.id] = {
        name, avatarId: finalAvatarId, isHost: account.accountId === room.pool.hostAccountId, playerToken,
        accountId: account.accountId, accountEmail: account.accountEmail || null, accountUsername: account.accountUsername || null, hasLegionBadge: !!account.hasLegionBadge,
      };
      getOrCreateRoomLeaderboardEntry(room, account.accountId, account.accountUsername);
    }

    // [HOST RETURNS TO CREATOR] Covers both branches above - a first-time
    // entry already sets isHost correctly, but a RETURNING player's
    // restored playerData keeps whatever isHost value it had before they
    // left, which could now be stale if someone else got promoted while
    // they were away.
    restoreHostToCreatorIfPresent(room);
    cancelRoomEmptyClose(room.code);

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerToken = room.players[socket.id].playerToken;

    const me = room.players[socket.id];
    ack({
      ok: true,
      playerToken: me.playerToken,
      avatarId: me.avatarId,
      ...buildFullRestorePayload(room, me, socket.id),
    });
    io.to(roomCode).emit("playerListUpdated", { players: getPlayerList(roomCode) });
    // [BUG FIX - NEW POOL PLAYER MISSING FROM OTHERS' LEADERBOARD] joinRoom
    // (free-play) already broadcasts this after a new player shows up -
    // enterPool never did, so anyone already sitting in the lobby (e.g.
    // the host) never saw a newly-entered pool player appear on their own
    // leaderboard view until something else happened to refresh it.
    broadcastRoomLeaderboard(room);
  });

  socket.on("setDevMode", ({ devMode }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;

    if (!room.players[socket.id] || !room.players[socket.id].isHost) {
      socket.emit("setDevModeError", { message: "Only the host can change Dev Mode." });
      return;
    }
    // [SECURITY - RE-ENABLE BEFORE REAL LAUNCH] Dev Mode skips real
    // win-conditions and lets the host force-end rounds that never
    // count toward matchesPlayed (see devForceEndGame/checkWinCondition)
    // - on a real pool/paid room, a malicious host could abuse this to
    // stall the pool forever (nobody's match count ever reaches
    // maxMatches, so the pool can never be settled/distributed),
    // locking up every participant's real money with no way out. Dev
    // Mode has no legitimate purpose on a room with actual money in it.
    // TEMPORARILY DISABLED per Om7eth's explicit request so pool/paid
    // rooms can still be tested with Dev Mode while the game isn't
    // live yet - UNCOMMENT this block before real launch (real money).
    // if (room.pool) {
    //   socket.emit("setDevModeError", { message: "Dev Mode isn't available on a pool/paid game." });
    //   return;
    // }

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
  // [BUG FIX - LIVE POOLS AUTO-JOIN NOT WORKING] `callback` is the
  // optional socket.io ack - same reasoning as createRoom's own ack (see
  // its comment). Without this, handleJoinRoom fired the request and
  // moved on immediately; a Live Pools list button then switched to the
  // Lobby screen before the room actually existed there yet, so the
  // Lobby rendered its own empty "enter a room code" fallback instead of
  // the room that was just auto-joined - exactly the bug being reported
  // as "auto room code apply nahi hota, manually karna padta hai".
  socket.on("joinRoom", async ({ code, name, avatarId, sessionToken }, callback) => {
    const ack = typeof callback === "function" ? callback : () => {};
    const roomCode = (code || "").toUpperCase().trim();
    const room = rooms[roomCode];

    if (!room) {
      const message = "Room not found. Check the code.";
      socket.emit("joinError", { message });
      ack({ ok: false, message });
      return;
    }

    // [SECURITY FIX - REAL EXPLOIT] joinRoom is the generic Free Play
    // entry point - it never charges anything and never records
    // on-chain participation. A pool/paid room MUST be entered through
    // enterPool instead (which verifies the on-chain payment via
    // onChainParticipantAccountIds before letting anyone in). Without
    // this check, anyone who got hold of a paid room's code (which
    // isn't even supposed to be shared - see "room codes hidden rehte
    // hain" - but a modified client could still just emit this event
    // directly with any code) could join for free with zero entry fee
    // and zero on-chain record, playing (and even winning prize money)
    // alongside people who actually paid.
    if (room.pool) {
      const message = "This is a paid pool room - it can't be joined with a room code. Use Enter/Participate instead.";
      socket.emit("joinError", { message });
      ack({ ok: false, message });
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
      const message = "This game has already started. Wait for it to end, or ask the host to start a new one.";
      socket.emit("joinError", { message });
      ack({ ok: false, message });
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
      const message = "This room is full (max 10 players).";
      socket.emit("joinError", { message });
      ack({ ok: false, message });
      return;
    }

    // [POINTS SYSTEM STEP 0] Same account-resolution + single-session
    // check as createRoom - see the comment there for why this matters.
    // Done before leaveCurrentRoomIfAny/room-mutation below so a
    // rejected join never has any side effects.
    const account = await resolveAccountFromToken(sessionToken);
    if (account && findActiveRoomForAccount(account.accountId)) {
      const message = "Your account is already active in another room. Leave that room first, or wait a moment if you just closed it.";
      socket.emit("joinError", { message });
      ack({ ok: false, message });
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
    room.players[socket.id] = { name, avatarId: finalAvatarId, isHost: false, playerToken, accountId: account?.accountId || null, accountEmail: account?.accountEmail || null, accountUsername: account?.accountUsername || null, hasLegionBadge: !!account?.hasLegionBadge };
    // [HOST RETURNS TO CREATOR] If this is the account that originally
    // created the room rejoining after having left, they get host power
    // back immediately - even if someone else was hosting in the
    // meantime. No-op for anyone else (including guests).
    restoreHostToCreatorIfPresent(room);
    cancelRoomEmptyClose(room.code);
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
      gameMode: room.gameMode || "free",
      // [NEW FEATURE] So a newly-joined player immediately sees whatever
      // speed the host has already set, not just the default.
      speedLevel: room.speedLevel || 4,
      isPublic: !!room.isPublic,
      lobbyChat: room.lobbyChat || [],
      devMode: !!room.devMode,
      pool: room.pool || null,
      matchLimit: room.matchLimit ?? null,
      matchesPlayed: room.matchesPlayed || 0,
      roomLeaderboard: getRoomLeaderboardList(room),
    });
    // [BUG FIX - LIVE POOLS AUTO-JOIN NOT WORKING] Same payload, via the
    // ack this time - see the comment on this handler's signature above.
    ack({
      ok: true,
      code: roomCode,
      players: playerList,
      playerToken,
      avatarId: finalAvatarId,
      gameMode: room.gameMode || "free",
      speedLevel: room.speedLevel || 4,
      isPublic: !!room.isPublic,
      lobbyChat: room.lobbyChat || [],
      devMode: !!room.devMode,
      pool: room.pool || null,
      matchLimit: room.matchLimit ?? null,
      matchesPlayed: room.matchesPlayed || 0,
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
  // [NEW POOL SYSTEM] `code` OR `onChainPoolId` - pool games never give
  // the client a room code at all anymore (see /pools/live and
  // enterPool below), so a returning pool player can only ever look
  // their room back up by the pool's own id, which they do already
  // know (it's public information, shown on every pool's own card).
  socket.on("reconnectToRoom", ({ code, playerToken, onChainPoolId }) => {
    const roomCode = (code || "").toUpperCase().trim();
    const room = roomCode ? rooms[roomCode] : Object.values(rooms).find((r) => r.pool && r.pool.onChainPoolId === String(onChainPoolId));

    if (!room) {
      socket.emit("reconnectError", { message: "Room no longer exists." });
      return;
    }

    // Find the player slot (under their OLD socket.id) matching this token
    const oldId = Object.keys(room.players).find(
      (id) => room.players[id].playerToken === playerToken
    );

    // [BUG FIX - AUTO-CONFIRM TIMER NEVER CANCELLED ON RECONNECT] Only
    // enterPool cancelled this before - but reconnectToRoom now handles
    // pool reconnection too (see its own onChainPoolId support above),
    // so a pool participant who left without confirming (starting their
    // 1-minute auto-confirm grace timer) and came back through a normal
    // reconnect (tab refocus, page refresh, etc.) rather than
    // specifically re-tapping the pool's Enter button would still get
    // silently auto-confirmed a minute later, even though they're
    // genuinely back and might want to review the standings first.
    const reconnectingAccountId = oldId ? room.players[oldId].accountId : null;
    if (reconnectingAccountId) cancelAutoConfirmOnLeave(room.code, reconnectingAccountId);

    // [BUG FIX - SELF-RECONNECT WOULD DISCONNECT THE CALLER] If this
    // exact socket is already the one holding this player slot (it's
    // asking to "reconnect" to itself - happens when the frontend
    // resyncs an already-healthy connection on tab-visibility-return
    // instead of tearing it down first), everything below this point
    // (moving player data to a "new" id, force-disconnecting the "old"
    // socket) would actually target THIS SAME live connection. Just
    // clear the disconnected flag (harmless no-op if it was never set)
    // and skip straight to re-sending fresh state - no teardown needed.
    let playerData;
    const actualRoomCode = room.code;
    if (oldId === socket.id) {
      delete room.players[socket.id].disconnectedAt;
      cancelRoomEmptyClose(room.code);
      playerData = room.players[socket.id];
    } else {
      if (!oldId) {
        socket.emit("reconnectError", { message: "Could not find your previous session." });
        return;
      }

      playerData = room.players[oldId];

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
      restoreHostToCreatorIfPresent(room);
      cancelRoomEmptyClose(room.code);

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
    }

    socket.join(actualRoomCode);
    socket.data.roomCode = actualRoomCode;
    socket.data.playerToken = playerToken;

    socket.emit("reconnected", {
      code: actualRoomCode,
      ...buildFullRestorePayload(room, playerData, socket.id),
    });

    io.to(actualRoomCode).emit("playerListUpdated", { players: getPlayerList(actualRoomCode) });
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
      io.to(actualRoomCode).emit("meetingVotesSync", {
        votes: room.meeting.votes || {},
        skipDiscussionVotes: room.meeting.skipDiscussionVotes || {},
      });
    }

    console.log(`${playerData.name} reconnected to room ${actualRoomCode}`);
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
  socket.on("leaveRoom", async () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!roomCode || !room) return;

    // [BUG FIX - POINTS/MATCHRECORD LOST ON LEAVE] If this player has a
    // just-finished match's points still staged (see
    // stagePendingPointsForRoom) and leaves without ever clicking Return
    // to Lobby, those points and that match's MatchRecord would
    // otherwise be lost entirely - commit them now, before anything else
    // below touches/removes this player's data.
    try {
      const result = await commitPendingPointsForPlayer(room, socket.id);
      if (result) socket.emit("pointsCommitted", result);
    } catch (e) {
      console.error(`[POINTS] commitPendingPointsForPlayer failed for ${socket.id} on leave:`, e.message);
    }

    const wasHost = room.players[socket.id]?.isHost;
    // [BUG FIX - HOST LEAVING AN OPEN POOL NEVER REFUNDED] Captured
    // before deletion below - only the on-chain host (room.pool.
    // hostAccountId, fixed at create_pool time) can ever call
    // lock_participation to start the game. If off-chain host status
    // had already migrated to someone else, THAT departure doesn't
    // matter here - only the ORIGINAL on-chain host leaving actually
    // strands the pool forever with no way for anyone to ever start
    // it, which is exactly when a refund is needed.
    const departingAccountId = room.players[socket.id]?.accountId || null;
    // [SECURITY FIX - REAL GAP] poolIsCancellable alone can't tell "the
    // pool was locked but a real match never actually got going" apart
    // from "the pool's very first match is live RIGHT NOW" - both look
    // identical (Locked, matchesPlayed still 0) until that first match
    // actually finishes and increments matchesPlayed. Without also
    // requiring !room.gameStarted here, a host leaving partway through
    // an actively in-progress first match would wrongly refund
    // everyone and close the room immediately, instead of letting the
    // match play out and settle through the real leaderboard - exactly
    // the "match completes but host still ends up refunded instead of
    // the top players getting paid" risk to guard against.
    const wasOnChainPoolHostLeaving = !!(
      room.pool && !room.gameStarted && poolIsCancellable(room.pool) &&
      departingAccountId && departingAccountId === room.pool.hostAccountId
    );
    // [NEW FEATURE - AUTO-CONFIRM ON LEAVE] If every match in this pool
    // is done and this participant hasn't confirmed the final
    // leaderboard yet, start their 1-minute auto-confirm grace period
    // now (see scheduleAutoConfirmOnLeave) - applies to ANY participant
    // leaving this way, not just the host. Deliberately still scheduled
    // even in the wasOnChainPoolHostLeaving case above (that branch
    // returns early below and closes the room, so the timer will just
    // no-op harmlessly once the room's gone - simpler than threading an
    // extra exception through both paths).
    if (
      room.pool && room.pool.state === "Locked" &&
      (room.pool.matchesPlayed || 0) >= room.pool.maxMatches &&
      departingAccountId &&
      (room.pool.participantAccountIds || []).includes(departingAccountId) &&
      !(room.pool.confirmedAccountIds || []).includes(departingAccountId)
    ) {
      scheduleAutoConfirmOnLeave(roomCode, departingAccountId);
    }
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
      snapshotRoomLeaderboardOnDeparture(room, room.players[socket.id].accountId, room.players[socket.id].name, room.players[socket.id].avatarId, room.players[socket.id].hasLegionBadge);
    }
    delete room.players[socket.id];
    socket.leave(roomCode);
    socket.data.roomCode = null;
    socket.data.playerToken = null;

    // [BUG FIX - HOST LEAVING AN OPEN POOL NEVER REFUNDED] Handle this
    // BEFORE the normal remaining-players/host-migration logic below -
    // migrating isHost to someone else would be pointless AND
    // misleading here, since only the real on-chain host can ever call
    // lock_participation, and they just left for good.
    if (wasOnChainPoolHostLeaving) {
      const onChainPoolId = room.pool.onChainPoolId;
      io.to(roomCode).emit("roomClosedByHost", { reason: "Host left before the pool started - refunding everyone." });
      markRoomMessageClosedForever(room); // fire-and-forget
      delete rooms[roomCode];
      if ((room.pool.onChainParticipantAccountIds || []).length > 0) {
        const refund = await cancelPoolOnChain(onChainPoolId);
        if (refund.success) {
          console.log(`[HOST LEFT] Pool #${onChainPoolId} cancelled + refunded on-chain (host left room ${roomCode} before it started).`);
        } else {
          console.error(`[HOST LEFT] Pool #${onChainPoolId} could NOT be refunded automatically (host left room ${roomCode}): ${refund.error}.`);
        }
      }
      console.log(`Room ${roomCode} closed - on-chain pool host left before the pool started`);
      return;
    }

    const remaining = Object.keys(room.players);
    if (remaining.length === 0) {
      if (wasGameStarted) {
        // [CRITICAL BUG FIX - SAME FUND-LOSS GAP AS THE DISCONNECT
        // PATH] This used to just delete the room outright here too -
        // identical gap to the one fixed in the disconnect-grace-
        // expiry handler, just reached via the LAST player explicitly
        // tapping Leave instead of a timeout. Same safe policy applies:
        // refund if the pool never produced a real result, settle from
        // the real leaderboard if every match actually finished,
        // otherwise leave funds safely locked on-chain rather than
        // guess wrong.
        (async () => {
          if (room.pool && room.pool.state !== "Distributed" && room.pool.state !== "Refunded") {
            if (poolIsCancellable(room.pool) && (room.pool.onChainParticipantAccountIds || []).length > 0) {
              const refund = await cancelPoolOnChain(room.pool.onChainPoolId);
              if (refund.success) {
                console.log(`[LAST PLAYER LEFT] Pool #${room.pool.onChainPoolId} cancelled + refunded on-chain (room ${roomCode} emptied via explicit leave mid-game).`);
              } else {
                console.error(`[LAST PLAYER LEFT] Pool #${room.pool.onChainPoolId} could NOT be refunded automatically (room ${roomCode} emptied via explicit leave): ${refund.error}.`);
              }
            } else if (room.pool.state === "Locked" && room.pool.matchesPlayed >= room.pool.maxMatches) {
              const outcome = await distributePoolPrizes(room, roomCode);
              console.log(outcome.success
                ? `[LAST PLAYER LEFT] Pool #${room.pool.onChainPoolId} settled from final leaderboard (room ${roomCode} emptied via explicit leave, all matches were done).`
                : `[LAST PLAYER LEFT] Pool #${room.pool.onChainPoolId} could NOT be settled automatically (room ${roomCode} emptied via explicit leave): ${outcome.error}.`);
            }
            // Else: real but incomplete progress exists - funds stay
            // safely locked on-chain, same conservative default used
            // everywhere else.
          }
        })();
        markRoomMessageClosedForever(room); // [NEW FEATURE] fire-and-forget
        delete rooms[roomCode];
        console.log(`Room ${roomCode} deleted (empty after explicit leave)`);
      } else {
        scheduleRoomEmptyClose(roomCode);
        console.log(`Room ${roomCode} empty (Lobby) - auto-closing in 3 min unless someone returns`);
      }
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

  // ---- CLOSE ROOM PERMANENTLY (host only) ----
  // [NEW FEATURE] The Lobby's LEAVE button now offers two choices:
  // "Leave Lobby" (the existing leaveRoom above - room stays open, or
  // gets the usual 3-minute empty grace, and the host gets their power
  // back automatically if they come back) vs this one, which shuts the
  // room down for EVERYONE right now, no grace period, no coming back.
  // Host-only, and - same rule as the final on-chain settlement -
  // refused once even one match has been played in a pool/paid game,
  // since at that point the pool needs to be settled through the normal
  // final-leaderboard flow rather than unilaterally closed.
  socket.on("closeRoomPermanently", async () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    if (!room.players[socket.id] || !room.players[socket.id].isHost) {
      socket.emit("closeRoomError", { message: "Only the host can close the room." });
      return;
    }
    if (room.gameStarted) {
      socket.emit("closeRoomError", { message: "Can't close the room while a match is in progress." });
      return;
    }
    // [BUG FIX] This used to block closing forever once even one match
    // had been played, even long after the pool was fully settled and
    // everyone already got paid - leaving the room permanently stuck
    // open with no way for the host to ever close it (exactly the "room
    // still looks like it's running" bug reported). Once the pool's
    // state is "Distributed" (or it's cleanly cancellable - see below),
    // there's nothing left to protect by keeping this blocked.
    let poolNeedsRefundOnClose = false;
    if (room.pool && room.pool.state !== "Distributed" && room.pool.state !== "Refunded") {
      if (poolIsCancellable(room.pool)) {
        // [BUG FIX - REFUND POLICY GAP] Covers BOTH: the pool never
        // started at all (Open), AND the pool started on-chain but a
        // crash/host-quit meant zero matches were ever actually played
        // (Locked with matchesPlayed still 0) - previously only the
        // Open case ever attempted a refund at all; a Locked-but-
        // nothing-played pool silently fell through NEITHER refund
        // branch NOR the "must settle via leaderboard" block below, so
        // the room just closed with real money stuck on-chain forever,
        // nobody ever refunded.
        poolNeedsRefundOnClose = true;
      } else if (room.pool.state === "Locked" && room.pool.matchesPlayed >= room.pool.maxMatches) {
        // [BUG FIX - STILL STUCK EVEN AFTER ALL MATCHES DONE] Distribution
        // (confirmFinalResult) only fires once EVERY participant has
        // individually tapped Confirm on the final standings screen - if
        // even one of them disconnected and never came back, that could
        // never happen, and the host had no way out at all, forever, even
        // with every match already played. If every match for this pool
        // is done, don't require the close button itself to also wait on
        // stragglers - go ahead and settle the pool from the current
        // final standings right now, exactly like confirmFinalResult
        // would have, then continue closing.
        const outcome = await distributePoolPrizes(room, roomCode);
        if (!outcome.success) {
          socket.emit("closeRoomError", { message: `Couldn't settle the pool automatically (${outcome.error || "on-chain error"}) - try again in a moment.` });
          return;
        }
      } else {
        socket.emit("closeRoomError", { message: "At least one match has already been played - this has to be settled through the final leaderboard, not closed directly." });
        return;
      }
    }
    cancelRoomEmptyClose(roomCode);
    // Tell every OTHER player in the room right now, before it's gone -
    // the frontend sends them back to Home with a clear reason.
    socket.to(roomCode).emit("roomClosedByHost");
    if (poolNeedsRefundOnClose && (room.pool.onChainParticipantAccountIds || []).length > 0) {
      const refund = await cancelPoolOnChain(room.pool.onChainPoolId);
      if (refund.success) {
        console.log(`[CLOSE ROOM] Pool #${room.pool.onChainPoolId} cancelled + refunded on-chain (closed by host, room ${roomCode}).`);
      } else {
        console.error(`[CLOSE ROOM] Pool #${room.pool.onChainPoolId} could NOT be refunded automatically (closed by host, room ${roomCode}): ${refund.error}.`);
      }
    }
    markRoomMessageClosedForever(room);
    delete rooms[roomCode];
    socket.emit("roomClosedByHost"); // confirms it to the host too, so their own client navigates home the same way
    console.log(`Room ${roomCode} closed permanently by host`);
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


  socket.on("returnToLobby", async () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    if (!room.players[socket.id]) return;

    room.players[socket.id].inLobbyView = true;

    // [POINTS SYSTEM STEP 2] Commit THIS player's own already-staged
    // points (computed back when the winner was decided - see
    // stagePendingPointsForRoom) now that they've actually made it back
    // to the Lobby, per "a match's points only count once you return to
    // Lobby" from the planning notes. Guests (no accountId) never had
    // pendingPoints staged in the first place, so this is naturally a
    // no-op for them. Also the primary path, but no longer the ONLY
    // path - see distributePoolPrizes and the leave/disconnect handlers
    // for the fallback that guarantees this still happens even if a
    // player never explicitly returns to Lobby (most importantly right
    // after winning the pool's very last match).
    const result = await commitPendingPointsForPlayer(room, socket.id);
    if (result) socket.emit("pointsCommitted", result);

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
        snapshotRoomLeaderboardOnDeparture(room, room.players[id].accountId, room.players[id].name, room.players[id].avatarId, room.players[id].hasLegionBadge);
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
  // ---- [NEW POOL SYSTEM] Confirm the host's on-chain lock ----
  // The host's client emits this right after its own lock_participation
  // contract call succeeds (fired the moment they press Start on a pool
  // room). See startGame's own gate above for why this exists - the
  // actual match doesn't begin until this has landed.
  socket.on("confirmPoolLocked", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.pool) return;
    room.pool.state = "Locked";
    io.to(roomCode).emit("poolUpdated", { pool: room.pool });
  });

  // ---- [NEW POOL SYSTEM] Confirm the final leaderboard ----
  // Called when a participant taps "Confirm" on the final standings
  // screen after every match in the pool has been played - no wallet
  // signature involved, just an in-app click (per the design: "game me
  // kahi bhi wallet signature nahi hoga, final leaderboard hi
  // important hai"). Once every participant (not just whoever's
  // currently connected - see participantAccountIds) has confirmed,
  // this automatically computes the top-3 ranked winners from
  // room.pool.leaderboard (the definitive off-chain running total - see
  // stagePendingPointsForRoom) and has the backend's oracle account call
  // distribute_prizes ONCE. If that on-chain call fails for any reason,
  // this doesn't retry automatically or lose the confirmations - the
  // pool just sits in its already-Locked state, which is exactly what
  // the contract's own 24-hour admin hold/release/refund fallback (see
  // lib.rs) exists to resolve if it's ever not sorted out manually
  // sooner.
  // [REFACTORED - SHARED DISTRIBUTION LOGIC] distributePoolPrizes moved
  // to module level (see above, near cancelPoolOnChain) so both this
  // connection's handlers AND the module-level auto-confirm-on-leave
  // timer can call the exact same ranking + on-chain payout logic.
  socket.on("confirmFinalResult", async () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.pool) return;
    const me = room.players[socket.id];
    if (!me || !me.accountId) return; // guests never had a stake to confirm
    cancelAutoConfirmOnLeave(roomCode, me.accountId); // they confirmed themselves - no need for the fallback timer anymore
    await confirmParticipant(room, roomCode, me.accountId);
  });

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

    // [NEW POOL SYSTEM] In this design, participate() always happens
    // BEFORE someone ever joins this room's socket room at all (see
    // confirmParticipated) - so there's no more "someone joined the
    // Lobby before their on-chain join landed" race to guard against
    // here. The only remaining gate: the host's own lock_participation
    // call (made right when they press Start) needs to have actually
    // succeeded first - see confirmPoolLocked.
    if (room.pool && room.pool.state !== "Locked") {
      socket.emit("startGameError", { message: "Confirming this pool's on-chain lock first - try again in a few seconds." });
      return;
    }

    // [FREE PLAY - MATCH LIMIT] Mirrors the pool check just above -
    // "No Limit" rooms (matchLimit null) never hit this.
    if (!room.pool && room.matchLimit != null && (room.matchesPlayed || 0) >= room.matchLimit) {
      socket.emit("startGameError", { message: "All matches for this room are already complete." });
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
      delete p.missionsList; delete p.missionsDone; delete p.missionsTotal; delete p.lastMissionCompletedAt;
      delete p.sabotageUses; delete p.sabotageCooldownUntil;
      delete p.disguiseCooldownUntil; delete p.postKillSabotageLockUntil;
      delete p.inVent;
      // [POINTS SYSTEM STEP 2] Per-match counters and any leftover
      // staged points from a previous round in this same room - a fresh
      // match must always start these at zero/absent.
      delete p.killsCount; delete p.meetingsSurvivedCount; delete p.sabotageActionsCount; delete p.ventUsesCount;
      delete p.pendingPoints; delete p.pendingWon;
      // [NEW FEATURE - POOL GAMES: LEGION HUB BONUS MISSION] A fresh
      // attempt is available every match - never carries over from a
      // previous match in this same room.
      delete p.bonusMissionPoints; delete p.bonusMissionDone; delete p.bonusMissionResult; delete p.bonusMissionAttempting;
    });
    // [NEW FEATURE - POOL GAMES: LEGION HUB BONUS MISSION] One random
    // mission for THIS match, Pool rooms only - Free/Paid rooms never
    // touch this (currentBonusMissionType stays unset, and the Legion
    // Hub keeps behaving exactly as it always has for them). Never
    // repeats a type already used earlier in this same room, across its
    // several matches - see pickBonusMissionType's own comment.
    if (getRoomGameMode(room) === "pool") {
      room.currentBonusMissionType = pickBonusMissionType(room);
    } else {
      delete room.currentBonusMissionType;
    }
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
      // [BUG FIX - NO KILL COOLDOWN AT GAME START] A Saboteur could
      // walk right up and kill someone the very first second of the
      // match, with zero warm-up at all. Per Om7eth's explicit
      // request, every Saboteur now starts every match with the same
      // 20s kill cooldown that normally only applied after an actual
      // kill (see killPlayer) or a meeting ending (see finalizeVoting).
      if (role === "saboteur") {
        room.players[id].killCooldownUntil = Date.now() + 20000;
      } else {
        delete room.players[id].killCooldownUntil;
      }
      const payload = {
        role, spawnIndex, speedLevel: clampedSpeedLevel, alive: true, saboteurCount,
        matchId: room.currentMatchId || null,
        onChainPoolId: room.pool?.onChainPoolId || null,
        killCooldownUntil: room.players[id].killCooldownUntil || 0,
        // [NEW FEATURE - POOL GAMES: LEGION HUB BONUS MISSION] null for
        // every Free/Paid room and for any Pool room before this exists -
        // both crewmates AND saboteurs get the exact same info here.
        bonusMission: room.currentBonusMissionType
          ? { type: room.currentBonusMissionType, label: BONUS_MISSION_LABELS[room.currentBonusMissionType] }
          : null,
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
    // Server-side cooldown enforcement (20s) - mirrors the client's own
    // KILL_COOLDOWN_MS, but checked here too so a modified client can't
    // bypass the cooldown by just not enforcing it locally.
    // [UPDATE] Standardized to 20s (was 25s) to match the same cooldown
    // now also applied at game start and at the end of every meeting -
    // one consistent number everywhere, per Om7eth's explicit request.
    const now = Date.now();
    if (killer.killCooldownUntil && now < killer.killCooldownUntil) {
      socket.emit("killError", { message: "Kill is still on cooldown." });
      return;
    }
    killer.killCooldownUntil = now + 20000;
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
    // [SECURITY FIX - REAL EXPLOIT] Saboteurs are never assigned real
    // missions at all (see roleAssigned) - without this, a modified
    // Saboteur client could still call this event with a fabricated
    // list. It's harmless to points/win-condition today (both only
    // ever read missionsDone for role === "crewmate"), but there's no
    // legitimate reason to let a Saboteur's client write player state
    // through this channel at all, so block it outright as defense in
    // depth against this becoming exploitable later.
    if (player.role !== "crewmate") return;

    const prevDoneCount = player.missionsDone || 0;
    const newDoneCount = missions.filter((m) => m.done).length;
    // [SECURITY FIX - REAL EXPLOIT: FAKE MISSION COMPLETION STOLE POOL
    // PRIZE MONEY] This used to trust newDoneCount completely, with no
    // limit on how much it could jump in a single report. In a paid
    // pool, missionsDone feeds straight into computeMatchPoints (real
    // NEAR prize money, split by final leaderboard rank) AND into
    // checkWinCondition's "every crewmate finished their missions" win
    // check - so a single modified client could report every mission
    // "done" in one shot, instantly win the match for the whole
    // crewmate team, and walk away with a leaderboard rank (and prize
    // share) that had nothing to do with anyone's actual performance -
    // taking money that should have gone to whoever really topped the
    // leaderboard. Two independent limits now apply: (1) the done-count
    // can only ever climb by exactly 1 real mission per report - no
    // jumping from 0 to 5 in one call - and (2) completions are rate-
    // limited to a realistic minimum gap, so even a script calling this
    // repeatedly can't finish a whole mission list faster than a real
    // player physically could. Also blocks the done-count from ever
    // going backwards, which would otherwise let a modified client
    // "rewind" prevDoneCount just to dodge the rate limit above and
    // then immediately re-claim it.
    if (newDoneCount > prevDoneCount) {
      if (newDoneCount - prevDoneCount > 1) return;
      const now = Date.now();
      if (player.lastMissionCompletedAt && now - player.lastMissionCompletedAt < MIN_MISSION_COMPLETE_INTERVAL_MS) return;
      player.lastMissionCompletedAt = now;
      // [NEW FEATURE] Task-reminder timer resets on real progress - only
      // when the done-count actually WENT UP (a genuinely completed
      // mission), not on every report (this handler also fires for other,
      // non-completing mission updates). Also clears any accumulated
      // reminder strikes, matching "if they complete a mission within 3
      // minutes, no reminder" - a fresh mission resets the clock entirely.
      player.lastMissionActivityAt = now;
      player.inactivityStrikes = 0;
    } else if (newDoneCount < prevDoneCount) {
      return;
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

  // ---- ATTEMPT LEGION HUB BONUS MISSION (Pool games only) ----
  // [NEW FEATURE - POOL GAMES: LEGION HUB BONUS MISSION] Both crewmates
  // AND saboteurs can call this (unlike reportMissionProgress above,
  // which is crewmate-only) - the whole point of this mission is that
  // either role can attempt it. Everything here is server-authoritative:
  // the client never reports a result or a point value, it only ever
  // asks "check my bonus mission" - the server does the live mainnet
  // read itself and decides the points, exactly like computeMatchPoints
  // already does for every other point source. This closes the same
  // class of exploit reportMissionProgress's own comments describe (a
  // modified client can never fabricate bonus points, since it never
  // gets to report them - only request a live check).
  socket.on("attemptBonusMission", async (payload, callback) => {
    const ack = typeof callback === "function" ? callback : () => {};
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) { ack({ ok: false, message: "Room not found." }); return; }
    if (!room.gameStarted) { ack({ ok: false, message: "The match hasn't started yet." }); return; }
    // [BUG FIX - PHANTOM POINTS THAT NEVER COUNTED] room.gameStarted
    // deliberately stays true even after a winner is decided (same
    // reasoning as reconnectToRoom elsewhere) - without this extra
    // check, a player could still successfully attempt (and see a "+X
    // points" popup for) the bonus mission during the post-game window,
    // AFTER stagePendingPointsForRoom already computed and locked in
    // everyone's final score for this match. Those points would never
    // actually reach the final total - a silent, confusing bug where
    // the player is shown points they never really got. Blocking the
    // attempt once room.winner exists closes that window entirely.
    if (room.winner) { ack({ ok: false, message: "This match has already ended." }); return; }
    if (getRoomGameMode(room) !== "pool" || !room.currentBonusMissionType) {
      ack({ ok: false, message: "No bonus mission is active in this match." });
      return;
    }
    const player = room.players[socket.id];
    if (!player) { ack({ ok: false, message: "You're not in this room." }); return; }
    if (player.bonusMissionDone) {
      // Already attempted this match - just resend the same cached
      // result rather than re-hitting the RPC (and definitely never
      // awarding points twice for the same match).
      ack({ ok: true, result: player.bonusMissionResult, points: player.bonusMissionPoints || 0, alreadyDone: true });
      return;
    }
    // [BUG FIX - RACE CONDITION] The wallet lookup + on-chain RPC checks
    // below are all async - without a synchronous lock set BEFORE any of
    // those awaits, two attemptBonusMission calls arriving close
    // together (e.g. a double-tap, or a modified client firing the
    // event repeatedly) would BOTH sail past the bonusMissionDone check
    // above (still false for both, since neither has finished yet) and
    // both run the full RPC flow concurrently - wasteful, and a source
    // of non-deterministic behavior if on-chain state changes between
    // the two concurrent checks. This flag is set immediately, sees the
    // very next concurrent call, and rejects it outright.
    if (player.bonusMissionAttempting) {
      ack({ ok: false, message: "Already checking - please wait." });
      return;
    }
    player.bonusMissionAttempting = true;
    if (!player.accountId) {
      delete player.bonusMissionAttempting;
      ack({ ok: false, message: "Log in with an account to attempt this mission." });
      return;
    }

    let walletAddress = null;
    try {
      const acct = await Player.findById(player.accountId, "verifiedWalletAddress");
      walletAddress = acct?.verifiedWalletAddress || null;
    } catch (e) {
      console.error("[BONUS MISSION] Failed to look up wallet:", e.message);
    }
    if (!walletAddress) {
      delete player.bonusMissionAttempting;
      ack({ ok: false, message: "Your wallet is not connected.", walletConnected: false });
      return;
    }

    let result;
    try {
      if (room.currentBonusMissionType === "rank") result = await checkLegionRankBonus(walletAddress);
      else if (room.currentBonusMissionType === "nft") result = await checkLegionNftBonus(walletAddress);
      else if (room.currentBonusMissionType === "balance") result = await checkLegionNearBalanceBonus(walletAddress);
      else result = { points: 0 };
    } catch (e) {
      console.error("[BONUS MISSION] Check failed:", e.message);
      delete player.bonusMissionAttempting;
      ack({ ok: false, message: "Couldn't verify your wallet right now - try again." });
      return;
    }

    // [BUG FIX] Re-check room.winner one more time here - the RPC calls
    // above can take a real amount of wall-clock time, long enough for
    // the match to end WHILE this request was in flight. Without this,
    // a request that started legitimately (before the match ended)
    // could still land its result afterward and create the exact same
    // phantom-points scenario the earlier room.winner check was meant
    // to prevent.
    if (room.winner) {
      delete player.bonusMissionAttempting;
      ack({ ok: false, message: "This match ended while checking - those points couldn't be counted." });
      return;
    }

    delete player.bonusMissionAttempting;
    player.bonusMissionDone = true;
    player.bonusMissionPoints = result.points || 0;
    player.bonusMissionResult = result;

    ack({
      ok: true,
      type: room.currentBonusMissionType,
      walletAddress,
      result,
      points: result.points || 0,
      alreadyDone: false,
    });
  });


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
      // [NEW FEATURE - NEAR LEGION BADGE] Frozen at send time, same as
      // senderName/senderAvatar - keeps working even if the sender later
      // leaves the room, unlike a live lookup would.
      senderHasLegionBadge: !!sender.hasLegionBadge,
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
      // [NEW FEATURE - NEAR LEGION BADGE] Frozen at send time, same as
      // senderName/senderAvatar - keeps working even if the sender later
      // leaves the room, unlike a live lookup would.
      senderHasLegionBadge: !!sender.hasLegionBadge,
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
      // [NEW FEATURE - NEAR LEGION BADGE] Frozen at send time, same as
      // senderName/senderAvatar - keeps working even if the sender later
      // leaves the room, unlike a live lookup would.
      senderHasLegionBadge: !!sender.hasLegionBadge,
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
  // [NEW FEATURE - PING DISPLAY] A bare echo - the client records its
  // own send time, waits for this ack, and computes the round-trip
  // itself. No payload needed either direction; the ack firing at all
  // is the entire signal.
  socket.on("pingCheck", (_data, callback) => {
    if (typeof callback === "function") callback(true);
  });

  // [NEW FEATURE - PING DISPLAY] The client reports its own measured
  // round-trip time here (see pingCheck above) - stored on their player
  // record. Per Om7eth's explicit request, only shown to the player
  // themselves (not broadcast to the room) - see getPlayerList's own
  // pingMs field for where this becomes visible again if needed later.
  socket.on("reportPing", ({ ms }) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms[roomCode] : null;
    if (!room || !room.players[socket.id]) return;
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return;
    room.players[socket.id].pingMs = Math.round(Math.min(ms, 9999));
  });

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
          // [BUG FIX - POINTS/MATCHRECORD LOST ON DISCONNECT] Same
          // reasoning as leaveRoom's own fix - if they won/played a
          // match and their connection dropped before they ever clicked
          // Return to Lobby, don't lose that match's points/MatchRecord
          // just because they never explicitly left. Fire-and-forget
          // (this callback isn't async) - nothing below depends on it.
          commitPendingPointsForPlayer(stillRoom, socket.id).catch((e) => {
            console.error(`[POINTS] commitPendingPointsForPlayer failed for ${socket.id} on disconnect-grace-expiry:`, e.message);
          });
          snapshotRoomLeaderboardOnDeparture(stillRoom, stillRoom.players[socket.id].accountId, stillRoom.players[socket.id].name, stillRoom.players[socket.id].avatarId, stillRoom.players[socket.id].hasLegionBadge);
          delete stillRoom.players[socket.id];
          const remaining = Object.keys(stillRoom.players);
          if (remaining.length === 0) {
            // [CRITICAL BUG FIX - REAL FUND LOSS] This used to just
            // delete the room outright with no refund/settlement
            // attempt at all - unlike every OTHER room-closing path
            // (auto-close, host-leave, permanent-close), which all go
            // through poolIsCancellable/distributePoolPrizes first. If
            // both/all participants in a paid pool disconnected mid-
            // game and nobody made it back within the grace window,
            // their money was simply abandoned on-chain with the room
            // gone and no record of it left server-side to ever settle
            // - exactly the "game ended, no refund came" bug reported.
            (async () => {
              if (room.pool && room.pool.state !== "Distributed" && room.pool.state !== "Refunded") {
                if (poolIsCancellable(room.pool) && (room.pool.onChainParticipantAccountIds || []).length > 0) {
                  const refund = await cancelPoolOnChain(room.pool.onChainPoolId);
                  if (refund.success) {
                    console.log(`[EVERYONE DISCONNECTED] Pool #${room.pool.onChainPoolId} cancelled + refunded on-chain (room ${roomCode} emptied mid-game, grace expired).`);
                  } else {
                    console.error(`[EVERYONE DISCONNECTED] Pool #${room.pool.onChainPoolId} could NOT be refunded automatically (room ${roomCode} emptied mid-game): ${refund.error}.`);
                  }
                } else if (room.pool.state === "Locked" && room.pool.matchesPlayed >= room.pool.maxMatches) {
                  // Every match actually finished before everyone
                  // disconnected - settle from the real final standings
                  // exactly like closeRoomPermanently's own fallback
                  // does, instead of abandoning a real result.
                  const outcome = await distributePoolPrizes(room, roomCode);
                  console.log(outcome.success
                    ? `[EVERYONE DISCONNECTED] Pool #${room.pool.onChainPoolId} settled from final leaderboard (room ${roomCode} emptied mid-game, all matches were done).`
                    : `[EVERYONE DISCONNECTED] Pool #${room.pool.onChainPoolId} could NOT be settled automatically (room ${roomCode} emptied mid-game): ${outcome.error}.`);
                }
                // Else: real progress exists but not all matches are
                // done - nothing safe to automatically do (can't fairly
                // rank an incomplete tournament, can't cancel a pool
                // with real results). Funds stay safely locked on-chain
                // rather than risk sending them to the wrong place -
                // same conservative default used everywhere else.
              }
            })();
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
        snapshotRoomLeaderboardOnDeparture(stillRoom, stillPlayer.accountId, stillPlayer.name, stillPlayer.avatarId, stillPlayer.hasLegionBadge);
        delete stillRoom.players[socket.id];
        const stillRemaining = Object.keys(stillRoom.players);
        if (stillRemaining.length === 0) {
          scheduleRoomEmptyClose(roomCode);
          console.log(`Room ${roomCode} empty (Lobby grace expired) - auto-closing in 3 min unless someone returns`);
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
        snapshotRoomLeaderboardOnDeparture(room, p.accountId, p.name, p.avatarId, p.hasLegionBadge);
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
