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
// [NEW FEATURE - CUSTOM AVATAR REQUEST] Raised from Express's 100kb
// default - a 1MB reference image (MAX_CUSTOM_AVATAR_IMAGE_BYTES) comes
// out to ~1.37MB once base64-encoded, plus JSON overhead. 3mb leaves
// comfortable headroom without opening the door to arbitrarily large
// bodies on every other route.
app.use(express.json({ limit: "3mb" }));

// All rooms are stored here (in-memory)
const rooms = {};

// [AI BOTS - NEAR HACKATHON] Server-side bot players (Free Play only).
// All bot logic lives in ./bots - see bots/botManager.js for the rules.
const bots = require("./bots/botManager");
// [$SABOTEUR] testnet token economy - rules in economy/rules.js
const economy = require("./economy/match");
const saboteurToken = require("./economy/saboteurToken");
bots.init({ io, rooms });

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
    .then(() => {
      console.log("[DB] Connected to MongoDB");
      economy.startRetryLoop(); // [$SABOTEUR] retry payouts that failed (chain hiccups)
      console.log(saboteurToken.configured() ? `[SABOTEUR] token ${saboteurToken.TOKEN} (testnet), treasury ${saboteurToken.TREASURY}` : "[SABOTEUR] not configured (set SABOTEUR_PARENT_ACCOUNT_ID / SABOTEUR_PARENT_PRIVATE_KEY) - rewards are recorded but not paid");
      fixLegacyPlayerIndexes();
    })
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
  playPassPayerWallet: { type: String, default: null }, // [PLAY PASS - REAL NEAR] mainnet wallet this player proved they own (signed message)
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
  // [POOL v2] mainnet .near address a player gave for Real-NEAR pool prizes (host pays by hand)
  payoutWallet: { type: String, default: null },
  // [TESTNET GIFT] when an older, empty in-game wallet got its one-time 1 test NEAR
  testnetTopupAt: { type: Date, default: null },
  // [FUNDS SAFETY] how many in-game wallets the server has paid to create for this player (max 2)
  ingameWalletsCreated: { type: Number, default: 0 },
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
  // [NEW FEATURE - ADMIN-GRANTED PREMIUM] Premium purchasing itself
  // doesn't exist yet (still "Coming Soon" on the Home screen) - this
  // is the foundation so Om7eth can gift premium from the admin
  // dashboard right now, ready for real perks to check this same field
  // once they exist. Null = never granted; a past Date = expired.
  premiumUntil: { type: Date, default: null },
  // [NEW FEATURE - PLAY PASS] premiumUntil above is the actual on/off
  // flag (a real purchase sets it to 2099-12-31 = "permanent" - Play
  // Pass never expires by design, per Om7eth's spec). These two fields
  // are just extra bookkeeping for the admin dashboard - they don't
  // gate anything themselves.
  playPassSource: { type: String, default: null }, // 'purchased' | 'gifted' | null
  playPassTxHash: { type: String, default: null }, // the real on-chain transfer hash, only set for 'purchased'
  // [NEW FEATURE - REVENUE TRACKING] The exact NEAR amount actually paid
  // at purchase time - stamped once, at the moment of purchase, so
  // lifetime Play Pass revenue stays accurate even if the price or
  // discount changes later (admin-gifted grants leave this at 0, since
  // no money changed hands).
  playPassPricePaidNear: { type: Number, default: 0 },
  // [NEW FEATURE - PLAY PASS] Which premium avatar skin (see
  // PREMIUM_AVATAR_VARIANTS below) this player currently has active,
  // e.g. 'blackdragon'. Only meaningful/checked when premiumUntil is
  // active - a lapsed/revoked Play Pass silently falls back to the
  // player's plain avatarId everywhere without needing to clear this.
  activePremiumAvatarVariant: { type: String, default: null },
  // [NEW FEATURE - PLAY PASS SKIN UNLOCK PROGRESSION] Snapshot of
  // gamesPlayed at the moment Play Pass was granted - see
  // getUnlockedVariantCount. Games played BEFORE the purchase never
  // count toward unlocking skins, only games played after.
  playPassStartGamesPlayed: { type: Number, default: 0 },
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
  // [BUG FIX] Was `$ne: ""`, which MongoDB does not allow in a partial
  // index ("Expression not supported in partial index: $not"), so this
  // index was never actually created. `$gt: ""` means the same thing
  // here (any non-empty string) and is supported.
  { unique: true, partialFilterExpression: { walletAddress: { $type: "string", $gt: "" } }, name: "walletAddress_partial_unique" }
);

const Player = mongoose.model("Player", playerSchema);

// [BUG FIX - WALLET SIGNUP "Something went wrong"] Old auto-named unique
// indexes (e.g. "email_1" from when email was required+unique) can still
// live in Atlas even after the schema moved to partial indexes. Mongoose
// never drops old indexes by itself, so the old one keeps enforcing
// uniqueness on email:null - meaning only the FIRST wallet-signup
// account (no email) could ever be created; every next one crashed with
// a duplicate-key error. Runs once on every boot: drops only plain
// (non-partial) unique indexes on these exact fields, then makes sure
// the correct partial ones exist. Safe to run repeatedly.
const PLAYER_PARTIAL_INDEX_FIELDS = ["email", "username", "verifiedWalletAddress", "walletAddress"];
async function fixLegacyPlayerIndexes() {
  try {
    const indexes = await Player.collection.indexes();
    for (const idx of indexes) {
      const keys = Object.keys(idx.key || {});
      if (keys.length !== 1 || !PLAYER_PARTIAL_INDEX_FIELDS.includes(keys[0])) continue;
      if (idx.unique && !idx.partialFilterExpression) {
        await Player.collection.dropIndex(idx.name);
        console.log(`[DB] Dropped legacy Player index "${idx.name}" (non-partial unique on ${keys[0]})`);
      }
    }
    await Player.createIndexes();
    console.log("[DB] Player indexes OK");
  } catch (err) {
    console.error("[DB] Player index check failed:", err.message);
  }
}

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
  // [BUG FIX - ACTIVITY POINTS LOOKED "COMPLETELY DIFFERENT" FROM WHAT
  // THE PLAYER SAW IN-GAME] The in-game room leaderboard (and the live
  // points tray) always showed the RAW, un-reduced match performance -
  // but only `points` (the post-daily-cap-reduction amount) was ever
  // saved, with no way to tell the two apart later. A player who'd
  // already played several matches that day would see a real match's
  // worth of points in-game, then find a much smaller number in
  // Activity days later, with zero explanation why. rawPoints preserves
  // the true, un-reduced performance total so Activity can show both
  // ("earned 48, counted 12 - daily bonus limit") instead of just the
  // smaller number with no context.
  rawPoints: { type: Number, default: 0 },
  // [BUG FIX - BONUS MISSION POINTS INVISIBLE IN ACTIVITY] These were
  // always correctly folded into the match's total point count (see
  // computeMatchPoints), so they DID count toward the player's real
  // totals - but were never saved as their own field anywhere, so
  // Activity (or anywhere else) had no way to show "you also earned +15
  // from the Bonus Mission" as its own line item.
  bonusMissionPoints: { type: Number, default: 0 },
  bonusMissionDone: { type: Boolean, default: false },
  bonusMissionResult: { type: mongoose.Schema.Types.Mixed, default: null },
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
  // [NEW FEATURE - ADMIN ROOMS TAB: ROOM TYPE] isPoolGame alone can't
  // tell a host-funded Pool Game apart from an entry-fee Paid Game (or
  // a future Sponsor game) - null on any record written before this
  // field existed, same "older records just don't have it" pattern as
  // roomSessionId above. 'free' | 'pool' | 'paid' | 'sponsor'.
  gameMode: { type: String, default: null },
  earnedAt: { type: Date, default: Date.now, index: true },
});
const MatchRecord = mongoose.model("MatchRecord", matchRecordSchema);

// [NEW FEATURE - FUNDS SAFETY: PERSISTENT POOL TRACKING] Every other
// piece of pool state (room.pool) lives ONLY in the in-memory `rooms`
// object - if the server process restarts for ANY reason (a crash, a
// normal redeploy, or Render's own free-tier "spun down after 15
// minutes idle" behavior) while a pool is still Open or Locked, that
// entire room - and with it, the ONLY record that this pool even
// exists - is gone. The on-chain pool itself is unaffected (the money
// is still sitting there exactly as it was), but nothing server-side
// would ever again know to refund or settle it - it would just sit
// until someone manually notices and the contract owner personally
// steps in after the 24h admin-fallback hold, with no alert, no list,
// nothing. This collection is a lightweight, always-kept-in-sync
// mirror of just enough pool state to safely recover from that: a
// periodic reconciliation job (see reconcileOrphanedPools) uses it to
// find any pool that's Open/Locked here but has no live room behind it
// anymore, and safely refunds or settles it automatically - covering
// both "the server restarted" and "the normal on-chain refund/
// distribute call silently failed and nothing ever retried it" in one
// mechanism.
const poolRecordSchema = new mongoose.Schema({
  onChainPoolId: { type: String, required: true, unique: true, index: true },
  roomCode: { type: String, default: null },
  hostAccountId: { type: String, default: null },
  hostFunded: { type: Boolean, default: false },
  entryFeeNear: { type: Number, default: 0 },
  maxMatches: { type: Number, default: 1 },
  state: { type: String, enum: ["Open", "Locked", "Distributed", "Refunded"], default: "Open", index: true },
  participantAccountIds: { type: [String], default: [] },
  onChainParticipantAccountIds: { type: [String], default: [] },
  // [FUNDS SAFETY v4] accountId -> the exact wallet that paid/joined on-chain,
  // so a later wallet change can never make a payout fail.
  onChainWalletByAccountId: { type: mongoose.Schema.Types.Mixed, default: {} },
  matchesPlayed: { type: Number, default: 0 },
  // accountId -> points, last-known snapshot - kept updated every time
  // room.pool.leaderboard changes (see stagePendingPointsForRoom), so
  // a real result can still be safely paid out to the right people even
  // if the server dies before the pool's own normal flow gets to finish.
  leaderboardSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
  // [PAID HISTORY] filled in when the contract pays out
  poolName: { type: String, default: null },
  isPublic: { type: Boolean, default: true },
  winners: { type: [{ rank: Number, accountId: String, name: String, avatarId: String, points: Number, amountNear: Number, _id: false }], default: [] },
  standings: { type: mongoose.Schema.Types.Mixed, default: [] }, // [{ accountId, name, avatarId, matches:[pts], total }]
  payoutTxHash: { type: String, default: null },
  settlementAttempts: { type: Number, default: 0 },
  lastSettlementError: { type: String, default: null },
  lastSettlementAttemptAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  lockedAt: { type: Date, default: null },
  settledAt: { type: Date, default: null },
  // [NEW FEATURE - PLAYER-REPORTED STUCK PAYMENT] Filled in by the
  // player themselves (via POST /pools/report-stuck) when they paid
  // on-chain but the app-side room/session never came up and Retry
  // kept failing. This is a SEPARATE signal from settlementAttempts/
  // lastSettlementError above - those only catch cases the automatic
  // reconciliation job can detect on its own; a player report catches
  // anything else (e.g. participate() succeeded but confirmParticipated
  // never reached the backend, so nothing here looks "wrong" to the
  // reconciler at all). Never cleared automatically - only when an
  // admin actually resolves it (refunds or manually confirms it's
  // fine), so it can never silently disappear before being looked at.
  stuckReports: {
    type: [{
      accountId: { type: String },
      playerName: { type: String, default: null },
      reportedAt: { type: Date, default: Date.now },
      resolved: { type: Boolean, default: false },
      resolvedAt: { type: Date, default: null },
      resolutionNote: { type: String, default: null },
    }],
    default: [],
  },
  // [NEW FEATURE - TRANSACTIONS LEDGER] Every individual money-moving
  // (or money-adjacent, like a gas-only free-join) event tied to this
  // pool, in the order it happened. txHash is captured client-side for
  // player-signed actions (create_pool/participate/lock_participation -
  // the client already gets this back from the wallet the instant the
  // transaction settles, see callPoolContract in game.jsx) and is best-
  // effort/omittable for backend-signed ones (distribute_prizes/
  // cancel_pool/refund_participant - the oracle account's own
  // callFunction() helper only ever returns the decoded value, not the
  // full outcome, so no hash is captured there today; still fully
  // listed here by type/amount/accountId even without one). Never
  // trusted for anything financial - purely a display/audit trail for
  // the admin Transactions tab, same "never delete, only append" spirit
  // as the rest of this collection.
  txnLog: {
    type: [{
      type: { type: String }, // create_pool | participate | lock_participation | distribute_prizes | platform_fee | cancel_pool | refund_participant
      accountId: { type: String, default: null },
      amountNear: { type: Number, default: 0 },
      txHash: { type: String, default: null },
      note: { type: String, default: null },
      createdAt: { type: Date, default: Date.now },
    }],
    default: [],
  },
});
const PoolRecord = mongoose.model("PoolRecord", poolRecordSchema);
// Fire-and-forget wrapper - persisting this mirror should never be able
// to block or crash whatever real game-logic path triggered the
// update; if the write itself fails (e.g. a brief DB hiccup), the next
// natural update a few seconds later will just overwrite it anyway.
function savePoolRecord(filter, update) {
  if (!MONGODB_URI) return;
  if (filter && "onChainPoolId" in filter && !filter.onChainPoolId) return; // [POOL v2] Real-NEAR pools have no on-chain id
  PoolRecord.updateOne(filter, { $set: update }, { upsert: true }).catch((e) => {
    console.error("[POOL RECORD] savePoolRecord failed:", e.message);
  });
}
// [NEW FEATURE - TRANSACTIONS LEDGER] Fire-and-forget, same reasoning
// as savePoolRecord above - appends one entry to a pool's txnLog.
// upsert:true so this can also be the very first write for a pool that
// hasn't had its main savePoolRecord call yet (order between the two
// is never guaranteed - both just eventually converge).
function pushTxnLog(onChainPoolId, entry) {
  if (!MONGODB_URI || !onChainPoolId) return;
  PoolRecord.updateOne(
    { onChainPoolId: String(onChainPoolId) },
    { $push: { txnLog: { ...entry, createdAt: new Date() } }, $setOnInsert: { onChainPoolId: String(onChainPoolId) } },
    { upsert: true }
  ).catch((e) => {
    console.error("[POOL RECORD] pushTxnLog failed:", e.message);
  });
}

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
// [NEW FEATURE - ADMIN REVENUE TAB] Optional - the contract owner's own
// wallet (where withdraw_platform_fees sends money). Just a public
// account-id STRING for read-only balance display on the admin
// dashboard - never a key, never used to sign anything. If unset, the
// Revenue tab simply skips showing this one balance.
const OWNER_ACCOUNT_ID =
  process.env.OWNER_ACCOUNT_ID ||
  process.env.OWNER_WALLET_ID ||
  process.env.OWNER_WALLET_ACCOUNT_ID ||
  process.env.OWNER_WALLET_ADDRESS ||
  "";
// [NEW FEATURE - PLAY PASS] Where the 5 NEAR purchase transfer actually
// lands. Deliberately reuses ORACLE_ACCOUNT_ID by default (already
// funded/managed on Render, no new key to provision) rather than
// requiring a brand-new env var on day one - but a dedicated
// PLAY_PASS_RECEIVING_ACCOUNT_ID can be set later (e.g. once Om7eth
// wants Play Pass revenue kept separate from oracle/gas float) without
// any code change.
const PLAY_PASS_RECEIVING_ACCOUNT_ID = process.env.PLAY_PASS_RECEIVING_ACCOUNT_ID || ORACLE_ACCOUNT_ID;
// [NEW FEATURE - PLAY PASS] Server-side mirror of game.jsx's premium
// avatar registry - deliberately hardcoded (redeploy-to-add, per
// Om7eth's choice) rather than DB-driven. This is what lets
// /play-pass/select-variant validate a variantId actually exists AND
// belongs to the base color (avatarId) the player currently has
// selected, without trusting the client's claim of either. baseAvatarId
// must match one of the ids in game.jsx's AVATARS array.
// [UPDATED - PLAY PASS SKIN UNLOCK PROGRESSION] Array order IS the
// unlock order now (index 0 unlocks immediately on purchase, each
// following index needs unlockGamesGap more games played) - see
// getUnlockedVariantCount below. Do not reorder without meaning to
// change the unlock sequence.
const PREMIUM_AVATAR_VARIANTS = [
  { id: "ironclaw", baseAvatarId: "cyan", name: "Ironclaw" },
  { id: "halfblood", baseAvatarId: "brown", name: "Halfblood" },
  { id: "blackdragon", baseAvatarId: "black", name: "BlackDragon" },
  { id: "shitzu", baseAvatarId: "green", name: "Shitzu" },
  { id: "jambo", baseAvatarId: "red", name: "Jambo" },
];
function getPremiumVariant(variantId) {
  return PREMIUM_AVATAR_VARIANTS.find((v) => v.id === variantId) || null;
}
// [NEW FEATURE - PLAY PASS SKIN UNLOCK PROGRESSION] How many of the 5
// premium skins this player has unlocked so far, based on games played
// since their Play Pass purchase. First skin (index 0) is unlocked the
// moment Play Pass is granted (playPassStartGamesPlayed gets stamped
// then); every subsequent skin costs playPassConfig.unlockGamesGap
// more games played. Capped at the full variant count.
function getUnlockedVariantCount(player, unlockGamesGap) {
  if (!player || !player.premiumUntil || player.premiumUntil.getTime() <= Date.now()) return 0;
  const gap = Math.max(1, Number(unlockGamesGap) || 2);
  const playedSinceStart = Math.max(0, (player.gamesPlayed || 0) - (player.playPassStartGamesPlayed || 0));
  const unlocked = 1 + Math.floor(playedSinceStart / gap);
  return Math.min(unlocked, PREMIUM_AVATAR_VARIANTS.length);
}

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
// [TESTNET GIFT] Testnet only: every new in-game wallet gets 1 test NEAR on top
// of the 0.05 that creating the account costs, so it can actually play pool
// games (gas, small pools). Skipped - never failing wallet creation - whenever
// sending it would leave the funder (ORACLE_ACCOUNT_ID) under the reserve, so
// the funder can always keep creating wallets. Never runs on mainnet.
const TESTNET_GIFT_NEAR = Number(process.env.TESTNET_WALLET_GIFT_NEAR || 1);
const TESTNET_FUNDER_RESERVE_NEAR = Number(process.env.TESTNET_FUNDER_RESERVE_NEAR || 5);
async function giftTestnetNear(accountId) {
  if (NEAR_NETWORK !== "testnet" || !(TESTNET_GIFT_NEAR > 0)) return { sent: false, reason: "not testnet" };
  const funder = await getOracleAccount();
  if (!funder) return { sent: false, reason: "no funder" };
  try {
    const nearAPI = await loadNearAPI();
    const balance = BigInt(await funder.getBalance());
    const needed = BigInt(nearAPI.nearToYocto(String(TESTNET_GIFT_NEAR + TESTNET_FUNDER_RESERVE_NEAR)));
    if (balance < needed) {
      console.warn(`[TESTNET GIFT] funder ${ORACLE_ACCOUNT_ID} is low (${nearAPI.yoctoToNear ? nearAPI.yoctoToNear(balance) : balance} yocto) - keeping the ${TESTNET_FUNDER_RESERVE_NEAR} NEAR reserve, not sending ${TESTNET_GIFT_NEAR} NEAR to ${accountId}`);
      return { sent: false, reason: "funder low" };
    }
    await funder.transfer({ receiverId: accountId, amount: BigInt(nearAPI.nearToYocto(String(TESTNET_GIFT_NEAR))) });
    console.log(`[TESTNET GIFT] sent ${TESTNET_GIFT_NEAR} test NEAR to ${accountId}`);
    return { sent: true, amountNear: TESTNET_GIFT_NEAR };
  } catch (e) {
    console.error(`[TESTNET GIFT] ${accountId} failed:`, e.message);
    return { sent: false, reason: "error" };
  }
}

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

// ============================================================
// [FUNDS SAFETY v4] One place that decides WHO gets paid and HOW MUCH for an
// on-chain pool, used by both the live-room path and the restart-recovery
// path. Rules:
//  - reads the pool from the CHAIN first: already settled -> nothing to do;
//    not Locked -> never call distribute (it would fail).
//  - a winner must be a real on-chain participant, paid to the exact wallet
//    that joined (a later wallet change can't break the payout).
//  - nobody eligible scored -> the caller refunds everyone instead (a payout
//    to zero winners would leave the money stuck in the contract forever).
//  - shares: 50/30/20 of 95%. With the v4 contract (POOL_CONTRACT_V4=1) ties
//    split their places evenly, same as the standings screen shows.
// ============================================================
// Detected from the contract itself (get_version exists from v4 on), so
// nothing needs to be switched on by hand after the upgrade is deployed.
let poolContractV4 = { value: false, checkedAt: 0 };
async function isPoolContractV4() {
  if (Date.now() - poolContractV4.checkedAt < 10 * 60 * 1000) return poolContractV4.value;
  const v = await viewContract("get_version", {});
  poolContractV4 = { value: typeof v === "string" && Number(v.split(".")[0]) >= 4, checkedAt: Date.now() };
  return poolContractV4.value;
}
const POOL_SPLIT_BPS = [5000, 3000, 2000];
const POOL_MAX_PAYOUTS = 10;
async function planOnChainPayout(pool, leaderboard) {
  const chainPool = await viewContract("get_pool", { pool_id: Number(pool.onChainPoolId) });
  if (!chainPool) return { error: "Couldn't read this pool on-chain right now - will retry." };
  if (chainPool.state === "Distributed" || chainPool.state === "Refunded") return { chainPool, settled: chainPool.state };
  if (chainPool.state !== "Locked") return { chainPool, error: `Pool is "${chainPool.state}" on-chain, not Locked - can't pay out.` };
  const onChain = new Set(chainPool.participants || []);
  const eligible = new Set(pool.onChainParticipantAccountIds || []);
  const ranked = Object.entries(leaderboard || {})
    .filter(([id, pts]) => Number(pts) > 0 && eligible.has(id))
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  const saved = pool.onChainWalletByAccountId || {};
  const docs = ranked.length ? await Player.find({ _id: { $in: ranked.map((r) => r[0]) } }, "walletAddress").lean() : [];
  const current = new Map(docs.map((d) => [String(d._id), d.walletAddress]));
  const people = [];
  const used = new Set();
  for (const [accountId, points] of ranked) {
    const wallet = [saved[accountId], current.get(accountId)].filter(Boolean).find((w) => onChain.has(w) && !used.has(w));
    if (!wallet) continue; // never joined on-chain with any wallet we know - can't be paid
    used.add(wallet);
    people.push({ accountId, wallet, points: Number(points) });
  }
  let pairs = [];
  const v4 = await isPoolContractV4();
  if (v4) {
    let place = 0;
    for (let i = 0; i < people.length && place < POOL_SPLIT_BPS.length; ) {
      let j = i;
      while (j < people.length && people[j].points === people[i].points) j++;
      const n = j - i;
      const groupBps = POOL_SPLIT_BPS.slice(place, place + n).reduce((a, b) => a + b, 0);
      for (let k = i; k < j; k++) pairs.push({ ...people[k], rank: place + 1, rawBps: groupBps / n, tied: n > 1 });
      place += n; i = j;
    }
    if (pairs.length > POOL_MAX_PAYOUTS) pairs = pairs.slice(0, POOL_MAX_PAYOUTS); // only with a 10+-way tie
  } else {
    pairs = people.slice(0, 3).map((p, i) => ({ ...p, rank: i + 1, rawBps: POOL_SPLIT_BPS[i], tied: false }));
  }
  // Normalise to 10,000 basis points exactly like the contract does when
  // fewer than 3 places are filled, so the numbers we show = what is paid.
  const sum = pairs.reduce((a, p) => a + p.rawBps, 0);
  let given = 0;
  for (const p of pairs) { p.bps = Math.floor((p.rawBps * 10000) / sum); given += p.bps; }
  if (pairs.length) pairs[0].bps += 10000 - given;
  const totalFundNear = Number(BigInt(chainPool.total_fund || "0") / 10n ** 18n) / 1e6; // 6-decimal precision is plenty for display
  const payoutPoolNear = totalFundNear * 0.95;
  for (const p of pairs) p.amountNear = Math.floor(payoutPoolNear * p.bps / 10000 * 1e5) / 1e5;
  return { chainPool, pairs, totalFundNear, payoutPoolNear, v4 };
}
async function executeOnChainPayout(poolId, plan) {
  if (!plan.v4) return distributePrizesOnChain(poolId, plan.pairs.map((p) => p.wallet));
  if (!POOL_CONTRACT_ACCOUNT_ID) return { success: false, error: "Contract not configured" };
  const account = await getOracleAccount();
  if (!account) return { success: false, error: "Oracle account not configured" };
  try {
    const nearAPI = await loadNearAPI();
    const result = await account.callFunction({
      contractId: POOL_CONTRACT_ACCOUNT_ID,
      methodName: "distribute_shares",
      args: { pool_id: Number(poolId), payouts: plan.pairs.map((p) => ({ account_id: p.wallet, bps: p.bps })) },
      gas: nearAPI.teraToGas("200"),
    });
    return { success: true, result };
  } catch (e) {
    console.error(`[POOL CONTRACT] distribute_shares(pool ${poolId}) failed:`, e.message);
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
  // [AUTO SETTLE] one payout only - the auto-settle timer and the older
  // "room closing" paths can both arrive here
  if (!room.pool || room.pool.state === "Distributed") return { success: true, already: true };
  if (room.pool._distributing) return { success: true, inProgress: true };
  room.pool._distributing = true;
  try {
    return await distributePoolPrizesOnce(room, roomCode);
  } finally {
    if (room.pool) room.pool._distributing = false;
  }
}
async function distributePoolPrizesOnce(room, roomCode) {
  if (room.pool && room.pool.mode === "manual") return settleManualPool(room, roomCode); // [POOL v2]
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
  // [FUNDS SAFETY v4] see planOnChainPayout
  const plan = await planOnChainPayout(room.pool, room.pool.leaderboard);
  if (plan.settled) {
    room.pool.state = plan.settled;
    savePoolRecord({ onChainPoolId: room.pool.onChainPoolId }, { state: plan.settled, settledAt: new Date(), lastSettlementError: null });
    io.to(roomCode).emit("poolUpdated", { pool: room.pool });
    return { success: true, already: true };
  }
  if (plan.error) {
    savePoolRecord({ onChainPoolId: room.pool.onChainPoolId }, { lastSettlementError: plan.error, lastSettlementAttemptAt: new Date() });
    PoolRecord.updateOne({ onChainPoolId: room.pool.onChainPoolId }, { $inc: { settlementAttempts: 1 } }).catch(() => {});
    io.to(roomCode).emit("poolDistributed", { success: false, error: plan.error, rankedWinners: [], rankedWinnerAccountIds: [], winners: [], payoutTxHash: null, entryFeeNear: room.pool.entryFeeNear, potNear: 0 });
    return { success: false, error: plan.error };
  }
  if (plan.pairs.length === 0) {
    // Nobody who really joined on-chain scored a point - refund everyone
    // rather than "paying" zero winners (that would trap the money).
    const refund = await cancelPoolOnChain(room.pool.onChainPoolId);
    if (refund.success) room.pool.state = "Refunded";
    io.to(roomCode).emit("poolDistributed", { success: refund.success, refunded: true, error: refund.error || null, rankedWinners: [], rankedWinnerAccountIds: [], winners: [], payoutTxHash: null, entryFeeNear: room.pool.entryFeeNear, potNear: 0 });
    io.to(roomCode).emit("poolUpdated", { pool: room.pool });
    return refund;
  }
  const rankedWinners = plan.pairs.map((p) => p.wallet);
  const rankedWinnerAccountIds = plan.pairs.map((p) => p.accountId);
  const poolRankByAccountId = new Map(plan.pairs.map((p) => [p.accountId, p.rank]));

  io.to(roomCode).emit("poolDistributing", {});
  const outcome = await executeOnChainPayout(room.pool.onChainPoolId, plan);
  const payoutTxHash = outcome.success ? (outcome.result?.transaction?.hash || outcome.result?.transaction_outcome?.id || null) : null;
  if (outcome.success) {
    room.pool.state = "Distributed";
    room.pool.payoutTxHash = payoutTxHash;
    savePoolRecord({ onChainPoolId: room.pool.onChainPoolId }, { state: "Distributed", settledAt: new Date(), lastSettlementError: null, payoutTxHash });
  } else {
    // [NEW FEATURE - FUNDS SAFETY: PERSISTENT POOL TRACKING] Record the
    // failure so reconcileOrphanedPools picks this up and keeps retrying
    // even if this room gets deleted right after (see every caller of
    // distributePoolPrizes - none of them currently check outcome.success
    // before continuing to close/delete the room).
    savePoolRecord({ onChainPoolId: room.pool.onChainPoolId }, {
      lastSettlementError: outcome.error || "unknown error",
      lastSettlementAttemptAt: new Date(),
    });
    PoolRecord.updateOne({ onChainPoolId: room.pool.onChainPoolId }, { $inc: { settlementAttempts: 1 } }).catch(() => {});
  }

  // [NEW FEATURE - ACTIVITY HISTORY: POOL FINANCIALS] Same formula the
  // frontend's own Pool Complete popup already uses (see that
  // component's own comment) - kept identical on purpose so the two
  // can never disagree about what someone actually won. Only computed
  // when the on-chain payout genuinely succeeded - if it failed, no
  // NEAR actually moved, so recording a "won X NEAR" figure here would
  // be recording something that didn't really happen yet.
  // [FUNDS SAFETY v4] amounts come from the on-chain pot and the exact
  // shares sent to the contract - what we show is what was paid.
  const entryFeeNear = Number(room.pool.entryFeeNear || 0);
  const payoutPoolNear = plan.payoutPoolNear;
  const nearWonByAccountId = new Map();
  if (outcome.success) {
    for (const p of plan.pairs) {
      nearWonByAccountId.set(p.accountId, p.amountNear);
      if (p.amountNear > 0) pushTxnLog(room.pool.onChainPoolId, { type: "distribute_prizes", accountId: p.accountId, amountNear: p.amountNear, note: `Rank ${p.rank}${p.tied ? " (tied)" : ""} of ${plan.pairs.length}` });
    }
    const platformFeeNear = plan.totalFundNear * 0.05;
    if (platformFeeNear > 0) {
      pushTxnLog(room.pool.onChainPoolId, { type: "platform_fee", amountNear: platformFeeNear, note: "5% platform fee" });
    }
  }

  // [NEW FEATURE - AUTO INBOX MESSAGE ON POOL WIN] Fire-and-forget -
  // sendInboxMessage never throws, so this can never block or fail the
  // real settlement flow above it. Only sent when the on-chain payout
  // genuinely succeeded (same guard as nearWonByAccountId itself) and
  // only to real top-3 finishers who actually received a nonzero share.
  // [PAID HISTORY + RESULT BANNER] who won what, and every player's match-by-match points
  const lbList = getRoomLeaderboardList(room);
  const lbById = new Map(lbList.map((e) => [e.accountId, e]));
  const winnersOut = rankedWinnerAccountIds.map((accountId, i) => {
    const e = lbById.get(accountId) || {};
    return { rank: poolRankByAccountId.get(accountId) || i + 1, accountId, name: e.name || e.username || "Player", avatarId: e.avatarId || null, points: e.totalPoints || 0, amountNear: Math.round((nearWonByAccountId.get(accountId) || 0) * 1000) / 1000 };
  });
  const standings = lbList.filter((e) => (room.pool.onChainParticipantAccountIds || []).includes(e.accountId))
    .map((e) => ({ accountId: e.accountId, name: e.name || e.username || "Player", avatarId: e.avatarId || null, matches: (e.matches || []).map((m) => m.points), total: e.totalPoints || 0 }));
  if (outcome.success) savePoolRecord({ onChainPoolId: room.pool.onChainPoolId }, { winners: winnersOut, standings });
  io.to(roomCode).emit("poolDistributed", { success: outcome.success, error: outcome.error || null, rankedWinners, rankedWinnerAccountIds, winners: winnersOut, payoutTxHash, entryFeeNear, potNear: Math.round(payoutPoolNear * 1000) / 1000 });
  io.to(roomCode).emit("poolUpdated", { pool: room.pool });

  if (outcome.success) {
    const ordinal = (n) => (n === 1 ? "1st" : n === 2 ? "2nd" : "3rd");
    for (const [accountId, rank] of poolRankByAccountId.entries()) {
      const nearWon = nearWonByAccountId.get(accountId) || 0;
      if (nearWon > 0) {
        sendInboxMessage(accountId, {
          title: "🎉 Congratulations!",
          body: `You placed ${ordinal(rank)} in "${room.pool.poolName || "a pool game"}" and won ${nearWon.toFixed(3)} NEAR - it's already been sent to your wallet.`,
        });
      }
    }
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
  // [BUG FIX - REAL PRIZE WINNERS SHOWED "You lost" IN WALLET HISTORY]
  // Root cause of a real, confirmed bug: a top-3 finisher who left the
  // room (closed the app, or clicked away) BEFORE the pool actually
  // settled had their MatchRecord already committed earlier via
  // leaveRoom's own commitPendingPointsForPlayer call - with NO
  // poolRank/poolNearWon yet, since the pool hadn't distributed at that
  // point. The loop above only ever updates players still connected
  // right now, so anyone who'd already left never got their existing
  // MatchRecord backfilled once the real payout actually happened
  // moments later - /wallet/history's findNearestMatch then matched
  // their real prize transfer against that stale, still-poolRank:null
  // record and showed "You lost" for a payout they genuinely won.
  // Directly updates the most recent matching MatchRecord for anyone
  // [BUG FIX - ADMIN LEADERBOARD ALWAYS EMPTY, NO REWARD BREAKDOWN]
  // Root cause: this used to ONLY patch a participant's MatchRecord here
  // if they were NOT still connected (the `updatedAccountIds` skip
  // below), on the assumption the "live player" loop above had already
  // handled anyone still in the room via commitPendingPointsForPlayer.
  // In practice that assumption was wrong almost every time - a match's
  // points are already committed the moment the MATCH itself ends,
  // well before this async on-chain pool settlement finishes running,
  // so `me.pendingPoints` is already gone by the time this function
  // runs and commitPendingPointsForPlayer's very first guard
  // (`typeof me.pendingPoints !== "number"`) just returns null without
  // touching anything. Net effect: nobody EVER got their poolRank/
  // poolNearWon/entryFeeNear stamped - not departed players (correctly
  // skipped as "already handled" when they weren't), and not connected
  // ones either (the thing that was supposed to handle them silently
  // did nothing) - exactly matching "leaderboard is always empty, no
  // matter what". Fix: drop the connected/departed distinction
  // entirely and unconditionally find-and-patch every real on-chain
  // participant's latest matching MatchRecord directly, right here -
  // both the ranked top-3 (poolRank + poolNearWon) AND every other
  // participant who played but didn't place (entryFeeNear only, so the
  // admin pool summary's totalPoolNear/participantCount are correct
  // even when nobody who ranked is even in this list). Idempotent by
  // design - safe to run every time regardless of what happened above.
  for (const accountId of (room.pool.onChainParticipantAccountIds || [])) {
    try {
      const latestMatch = await MatchRecord.findOne({ playerId: accountId, poolId: room.pool.onChainPoolId }).sort({ earnedAt: -1 });
      if (!latestMatch) continue;
      latestMatch.entryFeeNear = entryFeeNear;
      if (outcome.success && poolRankByAccountId.has(accountId)) {
        latestMatch.poolRank = poolRankByAccountId.get(accountId);
        latestMatch.poolNearWon = nearWonByAccountId.get(accountId) || 0;
      }
      await latestMatch.save();
    } catch (e) {
      console.error(`[POINTS] Stamping pool financials failed for ${accountId}:`, e.message);
    }
  }
  return outcome;
}

// [NEW FEATURE - FUNDS SAFETY: ORPHANED POOL RECOVERY] The
// record-only counterpart to distributePoolPrizes above - used when
// there's no live `room` left at all (the server restarted, or the
// room got deleted before an earlier settlement attempt succeeded).
// Works purely from the persisted PoolRecord snapshot - no
// room.players to touch, no per-player MatchRecord/points to commit
// (those either already got committed while the room was still alive,
// or are unrecoverable either way once the room's gone - this function
// only exists to make sure the MONEY still reaches the right people,
// which is the one thing that's still fully recoverable from the
// snapshot alone).
async function settlePoolFromRecord(record) {
  // [FUNDS SAFETY v4] same winner rules as the live path (planOnChainPayout)
  const plan = await planOnChainPayout(record, record.leaderboardSnapshot || {});
  if (plan.settled) {
    savePoolRecord({ onChainPoolId: record.onChainPoolId }, { state: plan.settled, settledAt: new Date(), lastSettlementError: null });
    return { success: true, already: true };
  }
  if (plan.error) {
    savePoolRecord({ onChainPoolId: record.onChainPoolId }, { lastSettlementError: plan.error, lastSettlementAttemptAt: new Date() });
    return { success: false, error: plan.error };
  }
  if (plan.pairs.length === 0) {
    // No real winner in the snapshot - refund everyone (paying zero
    // winners would trap the money in the contract).
    return cancelPoolOnChain(record.onChainPoolId);
  }
  const outcome = await executeOnChainPayout(record.onChainPoolId, plan);
  if (outcome.success) {
    savePoolRecord({ onChainPoolId: record.onChainPoolId }, { state: "Distributed", settledAt: new Date(), lastSettlementError: null });
  } else {
    savePoolRecord({ onChainPoolId: record.onChainPoolId }, { lastSettlementError: outcome.error || "unknown error", lastSettlementAttemptAt: new Date() });
    PoolRecord.updateOne({ onChainPoolId: record.onChainPoolId }, { $inc: { settlementAttempts: 1 } }).catch(() => {});
  }
  return outcome;
}

// [NEW FEATURE - FUNDS SAFETY: ORPHANED POOL RECOVERY] Runs
// periodically (see the setInterval call near the bottom of this file)
// AND once shortly after server startup - the single mechanism that
// closes BOTH of these gaps at once:
//   1. The server restarted (crash, redeploy, Render free-tier cold
//      start) while a pool was still Open/Locked - the in-memory
//      `rooms` object is gone, so nothing would otherwise ever revisit
//      that pool again except the 24h owner-only admin fallback.
//   2. A normal on-chain refund/distribute call failed for some
//      mundane reason (RPC hiccup, brief oracle/network issue) and the
//      room got deleted anyway right after (every caller of
//      cancelPoolOnChain/distributePoolPrizes proceeds to close the
//      room regardless of outcome.success) - previously a silent,
//      permanent dead end with just a console.error line.
// For every Open/Locked pool this finds with no live room behind it,
// it asks the CHAIN itself (not our own possibly-stale bookkeeping)
// what's really going on before doing anything, then either syncs
// (already actually settled), refunds (nothing real happened yet), or
// settles from the last-known real leaderboard snapshot (a real match
// was actually played) - never guesses, never sends money based on
// anything other than genuinely-verified on-chain state plus this
// pool's own persisted history.
const RECONCILE_RETRY_COOLDOWN_MS = 2 * 60 * 1000; // don't hammer a repeatedly-failing pool more than once every 2 min

// [NEW FEATURE - ADMIN MANUAL "RESOLVE NOW"] The actual per-pool
// decision logic, extracted so both the periodic reconcileOrphanedPools
// loop AND a manual admin-triggered retry can share the exact same
// verified logic - never two different code paths that could disagree
// about what's safe to do with real money. `force` skips the "a live
// room is already handling this" and cooldown checks - only meant for
// the admin-triggered path, where a human has explicitly asked for an
// immediate re-check.
async function reconcileOnePool(record, { force = false } = {}) {
  if (!force) {
    const liveRoom = Object.values(rooms).find((r) => r.pool && r.pool.onChainPoolId === record.onChainPoolId);
    if (liveRoom) return { skipped: true, reason: "A live room is still handling this pool normally." };
    if (record.lastSettlementAttemptAt && (Date.now() - new Date(record.lastSettlementAttemptAt).getTime()) < RECONCILE_RETRY_COOLDOWN_MS) {
      return { skipped: true, reason: "Retried too recently - wait a couple minutes and try again." };
    }
  }

  const chainPool = await viewContract("get_pool", { pool_id: Number(record.onChainPoolId) });
  if (!chainPool) return { skipped: true, reason: "Couldn't reach the NEAR network just now - try again shortly." };

  if (chainPool.state === "Distributed" || chainPool.state === "Refunded") {
    // Already genuinely settled on-chain (an earlier attempt may well
    // have actually succeeded, just crashed before we recorded it) -
    // just sync our record, nothing more to do.
    savePoolRecord({ onChainPoolId: record.onChainPoolId }, { state: chainPool.state, settledAt: new Date(), lastSettlementError: null });
    return { skipped: false, action: "synced", outcome: { success: true } };
  }

  if (chainPool.state === "Open" || (chainPool.state === "Locked" && (record.matchesPlayed || 0) === 0)) {
    const outcome = await cancelPoolOnChain(record.onChainPoolId);
    return { skipped: false, action: "refund", outcome };
  }
  if (chainPool.state === "Locked" && (record.matchesPlayed || 0) > 0) {
    const outcome = await settlePoolFromRecord(record);
    return { skipped: false, action: "distribute", outcome };
  }
  return { skipped: true, reason: "Unexpected on-chain state - needs a manual look." };
}

async function reconcileOrphanedPools() {
  if (!MONGODB_URI || !POOL_CONTRACT_ACCOUNT_ID) return;
  let candidates;
  try {
    candidates = await PoolRecord.find({ state: { $in: ["Open", "Locked"] } });
  } catch (e) {
    console.error("[RECONCILE] Failed to load PoolRecord candidates:", e.message);
    return;
  }
  for (const record of candidates) {
    try {
      await reconcileOnePool(record);
    } catch (e) {
      console.error(`[RECONCILE] Pool #${record.onChainPoolId} reconciliation attempt failed:`, e.message);
    }
  }
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

  // [AUTO SETTLE] confirmations are no longer required - the pool settles on
  // its own (scheduleAutoSettle). Everyone confirming just settles it sooner.
  const allConfirmed = room.pool.participantAccountIds.every((id) => room.pool.confirmedAccountIds.includes(id));
  if (!allConfirmed) return;

  await settlePoolNow(room, "everyone confirmed");
}

// [AUTO SETTLE] Replaces "every participant must confirm the final leaderboard".
// One AFK or confused player used to block the payout for everyone; the
// leaderboard is computed by the server, so a confirm step proved nothing.
const AUTO_SETTLE_DELAY_MS = 15 * 1000;
// [EARLY END] Every way a pool can end before all its matches are played:
//  - no match finished  -> cancelled (testnet: refund on-chain; Real NEAR: nothing owed)
//  - 1+ matches finished -> settled on the points from the matches that WERE played
const POOL_IDLE_SETTLE_MS = Number(process.env.POOL_IDLE_SETTLE_MS) || 10 * 60 * 1000; // env override is for local testing only // lobby sits 10 min without starting the next match
const poolIdleTimers = {};
function scheduleIdleSettle(room) {
  const pool = room.pool;
  if (!pool || pool.state !== "Locked" || (pool.matchesPlayed || 0) >= pool.maxMatches) return;
  const key = pool.poolId || room.code;
  clearTimeout(poolIdleTimers[key]);
  pool.idleSettlesAt = Date.now() + POOL_IDLE_SETTLE_MS;
  io.to(room.code).emit("poolUpdated", { pool }); // lobby shows the countdown
  poolIdleTimers[key] = setTimeout(() => {
    delete poolIdleTimers[key];
    if (room.gameStarted) return;
    finishPoolEarly(room, `no match started for ${POOL_IDLE_SETTLE_MS / 60000} minutes`);
  }, POOL_IDLE_SETTLE_MS);
}
function cancelIdleSettle(room) {
  const pool = room && room.pool;
  if (!pool) return;
  const key = pool.poolId || room.code;
  clearTimeout(poolIdleTimers[key]); delete poolIdleTimers[key];
  delete pool.idleSettlesAt;
}
async function finishPoolEarly(room, why) {
  const pool = room.pool;
  if (!pool || pool.state === "Distributed" || pool.state === "Refunded" || pool.state === "Cancelled") return;
  cancelIdleSettle(room);
  if ((pool.matchesPlayed || 0) >= 1 && pool.state === "Locked") {
    pool.endedEarly = (pool.matchesPlayed || 0) < pool.maxMatches;
    console.log(`[EARLY END] room ${room.code}: settling on ${pool.matchesPlayed}/${pool.maxMatches} matches (${why})`);
    await settlePoolNow(room, why, true);
    return;
  }
  // nothing finished -> cancel
  if (pool.mode === "manual") {
    pool.state = "Cancelled";
    saveManualPool(pool, { state: "Cancelled", finishedAt: new Date() });
    sendInboxMessage(pool.hostAccountId, { title: `Pool cancelled · ${pool.poolName || "Pool game"}`, body: `No match was finished (${why}), so nobody is owed anything.`, nameTag: "Pool Games" }).catch(() => {});
    io.to(room.code).emit("poolUpdated", { pool });
  } else if ((pool.onChainParticipantAccountIds || []).length > 0) {
    const refund = await cancelPoolOnChain(pool.onChainPoolId);
    if (refund.success) pool.state = "Refunded";
    console.log(`[EARLY END] room ${room.code}: pool cancelled (${why}) - refund ${refund.success ? "sent" : "FAILED: " + refund.error}`);
    io.to(room.code).emit("poolUpdated", { pool });
  }
}
const poolSettleTimers = {};
function scheduleAutoSettle(room) {
  const pool = room.pool;
  if (!pool) return;
  const key = pool.poolId || pool.onChainPoolId || room.code;
  if (poolSettleTimers[key]) return;
  pool.settlesAt = Date.now() + AUTO_SETTLE_DELAY_MS;
  poolSettleTimers[key] = setTimeout(() => settlePoolNow(room, "timer"), AUTO_SETTLE_DELAY_MS);
}
async function settlePoolNow(room, why, partial) {
  const pool = room.pool;
  if (!pool) return;
  const key = pool.poolId || pool.onChainPoolId || room.code;
  if (poolSettleTimers[key]) { clearTimeout(poolSettleTimers[key]); delete poolSettleTimers[key]; }
  if (pool.state !== "Locked" || pool.settling) return;
  if ((pool.matchesPlayed || 0) < (partial ? 1 : pool.maxMatches)) return;
  pool.settling = true;
  try {
    console.log(`[AUTO SETTLE] room ${room.code} pool ${key} settling (${why})`);
    await distributePoolPrizes(room, room.code); // works even if the room was closed meanwhile - we hold the object
  } catch (e) {
    console.error(`[AUTO SETTLE] ${room.code} failed:`, e.message);
  } finally {
    pool.settling = false;
  }
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
    // [BUG FIX - SPEED WENT SLOW ON RECONNECT] This function's whole
    // purpose (per its own extraction comment) was to be the ONE shared
    // payload for both enterPool and reconnectToRoom, but speedLevel was
    // missing from it - the client only updates its own speed when it
    // sees `typeof data.speedLevel === 'number'` (see roleAssigned's
    // client handler), so a reconnecting player just kept whatever
    // speed their client happened to have locally instead of the room's
    // actual configured speed, which reads as "my speed got slower"
    // whenever the room's speed was set above the default.
    speedLevel: room.speedLevel || 1,
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
          .map(([, p]) => ({ name: p.name, avatarId: p.avatarId, avatarVariantId: p.avatarVariantId || null, hasPlayPass: !!p.hasPlayPass }))
      : [],
    gameStarted: room.gameStarted || false,
    winner: room.winner || null,
    missionsList: playerData.missionsList || null,
    sabotageUses: playerData.sabotageUses || null,
    sabotageCooldownUntil: playerData.sabotageCooldownUntil || 0,
    killCooldownUntil: playerData.killCooldownUntil || 0,
    meetingCooldownUntil: room.meetingCooldownUntil || 0,
    postKillSabotageLockUntil: playerData.postKillSabotageLockUntil || 0,
    // [NEW FEATURE - SABOTEUR CAN REPORT BODIES] So a reconnecting
    // Saboteur's report button correctly stays locked out for whatever's
    // left of their 15s post-kill cooldown, instead of resetting to
    // "available" on refresh.
    postKillReportLockUntil: playerData.postKillReportLockUntil || 0,
    disguiseUsesLeft: typeof playerData.disguiseUsesLeft === 'number' ? playerData.disguiseUsesLeft : null,
    disguiseCooldownUntil: playerData.disguiseCooldownUntil || 0,
    activeDisguise: (playerData.disguiseAvatarId && playerData.disguiseActiveUntil > Date.now())
      ? { avatarId: playerData.disguiseAvatarId, avatarVariantId: playerData.disguiseAvatarVariantId || null, hasPlayPass: !!playerData.disguiseHasPlayPass, endsAt: playerData.disguiseActiveUntil }
      : null,
    activeGateLock: room.activeGateLock || null,
    activeSabotageType: room.activeSabotageType || null,
    activeMeeting: room.meeting ? {
      stage: room.meeting.stage,
      startedAt: room.meeting.startedAt,
      reason: room.meeting.reason,
      messages: room.meeting.messages || [],
      history: room.matchChat || [],
      meetingNo: room.meetingNo || 1,
      botChatMode: room.botChatMode || "auto",
      deadPlayerNames: Object.values(room.players).filter((p) => !p.alive).map((p) => p.name),
      calledBy: room.meeting.calledBy,
      liveVotes: room.meeting.votes || {}, // live votes are shown to everyone (voter avatar under target)
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
  if (!poolId) return { success: true, skipped: true }; // [POOL v2] Real-NEAR pool: nothing on-chain to cancel
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
    // [NEW FEATURE - FUNDS SAFETY: PERSISTENT POOL TRACKING] Single
    // choke point every refund path already goes through - covers all
    // of them (auto-close, host-leave, room-close, last-player-left,
    // reconcileOrphanedPools) with this one write.
    savePoolRecord({ onChainPoolId: String(poolId) }, { state: "Refunded", settledAt: new Date(), lastSettlementError: null });
    pushTxnLog(poolId, { type: "cancel_pool", note: "Pool cancelled - full refund to every participant (or the host, if host-funded)." });
    return { success: true, result };
  } catch (e) {
    console.error(`[POOL CONTRACT] cancelPoolOnChain(pool ${poolId}) failed:`, e.message);
    savePoolRecord({ onChainPoolId: String(poolId) }, { lastSettlementError: e.message, lastSettlementAttemptAt: new Date() });
    PoolRecord.updateOne({ onChainPoolId: String(poolId) }, { $inc: { settlementAttempts: 1 } }).catch(() => {});
    return { success: false, error: e.message };
  }
}

// [NEW FEATURE - SINGLE PARTICIPANT REFUND] Calls the contract's
// refund_participant (oracle-callable, see lib.rs) - refunds ONLY the
// given account's own entry_fee and removes them from the pool,
// leaving every other participant untouched. For the "paid on-chain,
// but the app-side room/session never got created for this one
// player" scenario. Only ever valid on a still-Open, non-host-funded
// pool - the contract itself enforces this and will throw otherwise,
// which this function surfaces as a normal { success:false, error }
// result, same as every other on-chain call helper here.
async function refundParticipantOnChain(poolId, accountId) {
  if (!poolId) return { success: true, skipped: true };
  if (!POOL_CONTRACT_ACCOUNT_ID) return { success: false, error: "Contract not configured" };
  const account = await getOracleAccount();
  if (!account) return { success: false, error: "Oracle account not configured" };
  try {
    const nearAPI = await loadNearAPI();
    const result = await account.callFunction({
      contractId: POOL_CONTRACT_ACCOUNT_ID,
      methodName: "refund_participant",
      args: { pool_id: Number(poolId), account_id: accountId },
      gas: nearAPI.teraToGas("100"),
    });
    return { success: true, result };
  } catch (e) {
    console.error(`[POOL CONTRACT] refundParticipantOnChain(pool ${poolId}, ${accountId}) failed:`, e.message);
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
    if (room.pool && room.pool.mode === "manual") { await finishPoolEarly(room, "room empty for 3 minutes"); }
    else if (room.pool && room.pool.state === "Locked" && (room.pool.matchesPlayed || 0) >= 1) { await finishPoolEarly(room, "room empty for 3 minutes"); }
    else if (room.pool && poolIsCancellable(room.pool) && (room.pool.onChainParticipantAccountIds || []).length > 0) {
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
// [UPDATE] Now managed from the admin dashboard's own Announcements tab
// (create/edit/delete, custom name tag, optional auto-expire) - no
// longer MongoDB-dashboard-only.
const announcementSchema = new mongoose.Schema({
  title: { type: String, required: true },
  body: { type: String, default: "" },
  // [NEW FEATURE] Defaults to the platform's own name - Om7eth can
  // override this per-announcement (e.g. post as a specific event name)
  // from the admin dashboard.
  nameTag: { type: String, default: "NEAR Saboteur" },
  // [NEW FEATURE] A plain URL, not an uploaded/stored image - keeps
  // MongoDB Atlas's free-tier storage cap untouched regardless of how
  // many announcements ever get posted. See the admin dashboard's own
  // notes on where to host one (Cloudinary/Imgur free tier).
  imageUrl: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  // [NEW FEATURE - AUTO-DELETE] Null = never auto-expires (MongoDB's
  // TTL monitor skips documents where the indexed field is absent/null
  // entirely, so this is a true opt-in, not "expires immediately").
  // `expires: 0` means "delete AT this exact timestamp" (0 extra
  // seconds added) - Om7eth sets this from the admin dashboard as
  // "auto-delete after N days", converted to a concrete date there.
  // Can also always be deleted manually regardless of this.
  expiresAt: { type: Date, default: null, expires: 0 },
});
const Announcement = mongoose.model("Announcement", announcementSchema);

// [NEW FEATURE - PLAYER INBOX] Per-player messages - manual (admin
// dashboard, any custom name tag) or automatic (pool win congratulations,
// future premium-purchase confirmation, etc. - see sendInboxMessage).
const inboxMessageSchema = new mongoose.Schema({
  playerId: { type: mongoose.Schema.Types.ObjectId, ref: "Player", required: true, index: true },
  nameTag: { type: String, default: "NEAR Saboteur" },
  title: { type: String, required: true },
  body: { type: String, default: "" },
  imageUrl: { type: String, default: null }, // same URL-only approach as Announcement.imageUrl
  read: { type: Boolean, default: false },
  // [NEW FEATURE - MANUAL VS AUTOMATIC FILTER] 'manual' only ever set by
  // the admin dashboard's own send endpoint (POST /admin/inbox/send) -
  // every other sender in this file goes through sendInboxMessage()
  // below, which always stamps 'auto'. Lets the Inbox History tab tell
  // apart a real conversation the admin personally sent from a system
  // notification (pool win, dispute reply, etc.).
  source: { type: String, enum: ["manual", "auto"], default: "auto", index: true },
  createdAt: { type: Date, default: Date.now, index: true },
});
const InboxMessage = mongoose.model("InboxMessage", inboxMessageSchema);

// [POOL v2 - REAL NEAR POOLS] A pool whose prize is paid by the HOST by
// hand (real NEAR, mainnet .near addresses). Nothing goes on-chain - the
// game ranks players, works out who gets what from the host's own split,
// and keeps the list of winners + wallets so the host can pay and tick
// each one off. When the game itself moves to mainnet this manual mode is
// meant to be replaced by in-game payouts (see README).
const manualPoolSchema = new mongoose.Schema({
  poolId: { type: String, index: true, unique: true },
  roomCode: String,
  roomSessionId: String,
  hostAccountId: { type: String, index: true },
  hostName: String,
  hostUsername: String,
  poolName: String,
  prizeNear: Number,
  split: [Number],
  maxMatches: Number,
  matchesPlayed: { type: Number, default: 0 },
  hostRole: String, // 'play' | 'watch' | 'host'
  isPublic: Boolean,
  state: { type: String, default: "Open" }, // Open | Live | Finished | Cancelled
  players: [{ accountId: String, name: String, username: String, wallet: String, _id: false }],
  winners: [{ rank: Number, accountId: String, name: String, username: String, wallet: String, points: Number, amountNear: Number, tied: Boolean, paidAt: Date, verifiedAt: Date, txHash: String, _id: false }],
  finishedAt: Date,
  leaderboard: { type: mongoose.Schema.Types.Mixed, default: {} }, // accountId -> points, saved after every match
  endedEarly: { type: Boolean, default: false },  // settled before all planned matches were played
  unclaimedNear: { type: Number, default: 0 },    // prize left with the host (fewer scorers than paid places)
}, { timestamps: true });
manualPoolSchema.index({ "players.accountId": 1 });
const ManualPool = mongoose.model("ManualPool", manualPoolSchema);

const NEAR_ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
// Any mainnet NEAR account (name.near, name.tg from HOT wallet, 64-hex implicit, 0x… eth-implicit) - never a .testnet one.
function cleanPayoutWallet(w) {
  const v = String(w || "").trim().toLowerCase();
  if (v.length < 2 || v.length > 64 || !NEAR_ACCOUNT_ID.test(v) || v.endsWith(".testnet")) return null;
  return v.includes(".") || /^[0-9a-f]{64}$/.test(v) || /^0x[0-9a-f]{40}$/.test(v) ? v : null;
}
function cleanSplit(arr) {
  if (!Array.isArray(arr)) return null;
  const s = arr.map((n) => Math.round(Number(n))).filter((n) => Number.isFinite(n) && n >= 0).slice(0, 10);
  while (s.length && s[s.length - 1] === 0) s.pop();
  return s.length && s.reduce((a, b) => a + b, 0) === 100 ? s : null;
}
// Prize wallets live OUTSIDE room.pool on purpose: room.pool is broadcast to
// every player (poolUpdated / roomJoined), and only the host may see these.
const poolWalletsById = new Map();
function poolWallets(pool) {
  if (!pool) return {};
  if (!poolWalletsById.has(pool.poolId)) poolWalletsById.set(pool.poolId, {});
  return poolWalletsById.get(pool.poolId);
}
function setPoolWallet(pool, accountId, wallet) {
  poolWallets(pool)[accountId] = wallet;
  pool.walletHolders = Object.keys(poolWallets(pool)); // ids only - who still needs to add one
}
function saveManualPool(pool, update) {
  if (!MONGODB_URI || !pool || pool.mode !== "manual") return;
  ManualPool.updateOne({ poolId: pool.poolId }, { $set: update }, { upsert: true }).catch((e) => console.error("[MANUAL POOL] save failed:", e.message));
}
function manualPoolPlayers(room) {
  return Object.values(room.players)
    .filter((p) => p.accountId && !p.isBot && !p.spectator)
    .map((p) => ({ accountId: p.accountId, name: p.name, username: p.accountUsername || null, wallet: poolWallets(room.pool)[p.accountId] || null }));
}
// Ranks every non-spectator participant by total pool points and pays the
// host's split down the list - called instead of the on-chain payout.
//  - Ties: players on the same points share the places they cover equally
//    (two tied for #1 on a 50/30/20 split each get 40%).
//  - Fewer scorers than paid places: the leftover share stays with the host.
//  - Only players with more than 0 points can win.
function computeManualWinners(pool, info) {
  const split = pool.split || [];
  const excluded = pool.hostRole !== "play" ? pool.hostAccountId : null;
  const ranked = Object.entries(pool.leaderboard || {})
    .filter(([id, pts]) => pts > 0 && id !== excluded)
    .sort((a, b) => b[1] - a[1]);
  const winners = [];
  let place = 0;
  for (let i = 0; i < ranked.length && place < split.length; ) {
    let j = i;
    while (j < ranked.length && ranked[j][1] === ranked[i][1]) j++;
    const group = ranked.slice(i, j);
    const covered = split.slice(place, place + group.length);
    const sharePct = covered.reduce((a, b) => a + b, 0) / group.length;
    for (const [accountId, points] of group) {
      const who = info(accountId);
      winners.push({
        rank: place + 1, accountId, points, tied: group.length > 1,
        name: who.name || "Player", username: who.username || null, wallet: who.wallet || null,
        amountNear: Math.floor(pool.prizeNear * (sharePct / 100) * 1000) / 1000, // floor: never pay out more than the prize
        paidAt: null,
      });
    }
    place += group.length; i = j;
  }
  const paid = winners.reduce((a, w) => a + w.amountNear, 0);
  const unclaimedNear = Math.max(0, Math.round((pool.prizeNear - paid) * 1000) / 1000);
  return { winners, unclaimedNear };
}
function notifyManualSettle(pool, winners, unclaimedNear) {
  const early = pool.endedEarly ? ` The pool ended after ${pool.matchesPlayed} of ${pool.maxMatches} matches, so the standings after those matches count.` : "";
  for (const w of winners) {
    sendInboxMessage(w.accountId, {
      title: `You placed #${w.rank}${w.tied ? " (tied)" : ""} in ${pool.poolName || "a pool game"}`,
      body: `Your prize is ${w.amountNear} NEAR. The host pays it by hand to ${w.wallet || "your wallet (add one in Pool Games)"} — you'll get another message once it's sent.${early}`,
      nameTag: "Pool Games",
    }).catch(() => {});
  }
  const kept = unclaimedNear > 0 ? ` ${unclaimedNear} NEAR wasn't won by anyone (not enough players scored), so you keep it.` : "";
  sendInboxMessage(pool.hostAccountId, {
    title: winners.length ? `Pay your winners · ${pool.poolName || "Pool game"}` : `Pool finished · ${pool.poolName || "Pool game"}`,
    body: winners.length
      ? `${winners.length} winner${winners.length === 1 ? "" : "s"} to pay, ${Math.round((pool.prizeNear - unclaimedNear) * 1000) / 1000} NEAR in total. Open Pool Games → History → Pay winners for their wallets.${kept}${early}`
      : `Nobody scored any points, so there is nobody to pay - you keep the whole prize.${early}`,
    nameTag: "Pool Games",
  }).catch(() => {});
}
async function settleManualPool(room, roomCode) {
  const pool = room.pool;
  const ids = Object.keys(pool.leaderboard || {});
  const people = await Player.find({ _id: { $in: ids } }, "name username payoutWallet").catch(() => []);
  const byId = new Map(people.map((p) => [p._id.toString(), p]));
  const { winners, unclaimedNear } = computeManualWinners(pool, (id) => {
    const pl = byId.get(id);
    return { name: pl?.name, username: pl?.username, wallet: poolWallets(pool)[id] || pl?.payoutWallet };
  });
  pool.state = "Distributed";
  pool.winners = winners;
  pool.unclaimedNear = unclaimedNear;
  saveManualPool(pool, { state: "Finished", winners, unclaimedNear, endedEarly: !!pool.endedEarly, finishedAt: new Date(), matchesPlayed: pool.matchesPlayed || 0, leaderboard: pool.leaderboard || {}, players: manualPoolPlayers(room) });
  notifyManualSettle(pool, winners, unclaimedNear);
  io.to(roomCode).emit("poolDistributed", { success: true, manual: true, winners, unclaimedNear, endedEarly: !!pool.endedEarly, rankedWinnerAccountIds: winners.map((w) => w.accountId) });
  io.to(roomCode).emit("poolUpdated", { pool });
  return { success: true, manual: true };
}
// Every 2 min, touch each manual pool that still has a live room here - so a
// second server sharing the database (or this one after a restart) never
// mistakes a running pool for an abandoned one.
function manualPoolHeartbeat() {
  if (!MONGODB_URI) return;
  const ids = Object.values(rooms).map((r) => r.pool && r.pool.mode === "manual" && r.pool.poolId).filter(Boolean);
  if (ids.length) ManualPool.updateMany({ poolId: { $in: ids }, state: { $in: ["Open", "Live"] } }, { $set: { updatedAt: new Date() } }, { timestamps: false }).catch(() => {});
}
setInterval(manualPoolHeartbeat, 2 * 60 * 1000);
// [EARLY END] After a server restart the room is gone but the saved pool
// isn't: settle it from its last saved standings (or cancel it if no match
// had finished). Pools still running in a live room are left alone.
async function reconcileManualPools() {
  if (!MONGODB_URI) return;
  try {
    const live = new Set(Object.values(rooms).map((r) => r.pool && r.pool.poolId).filter(Boolean));
    // 15 min without a heartbeat = no server has this room any more (see manualPoolHeartbeat)
    const stale = await ManualPool.find({ state: { $in: ["Open", "Live"] }, updatedAt: { $lt: new Date(Date.now() - 15 * 60 * 1000) } }).lean();
    for (const doc of stale) {
      if (live.has(doc.poolId)) continue;
      if ((doc.matchesPlayed || 0) < 1) {
        await ManualPool.updateOne({ poolId: doc.poolId, state: doc.state }, { $set: { state: "Cancelled", finishedAt: new Date() } });
        sendInboxMessage(doc.hostAccountId, { title: `Pool cancelled · ${doc.poolName || "Pool game"}`, body: "The room closed before any match finished, so nobody is owed anything.", nameTag: "Pool Games" }).catch(() => {});
        console.log(`[EARLY END] manual pool ${doc.poolId} cancelled (room gone, 0 matches)`);
        continue;
      }
      const pool = { ...doc, endedEarly: (doc.matchesPlayed || 0) < (doc.maxMatches || 1) };
      const byId = new Map((doc.players || []).map((p) => [p.accountId, p]));
      const people = await Player.find({ _id: { $in: Object.keys(doc.leaderboard || {}) } }, "name username payoutWallet").catch(() => []);
      const dbById = new Map(people.map((p) => [p._id.toString(), p]));
      const { winners, unclaimedNear } = computeManualWinners(pool, (id) => {
        const a = byId.get(id) || {}; const b = dbById.get(id);
        return { name: a.name || b?.name, username: a.username || b?.username, wallet: a.wallet || b?.payoutWallet };
      });
      // only the first reconciler to flip the state sends anything
      const res = await ManualPool.updateOne({ poolId: doc.poolId, state: doc.state }, { $set: { state: "Finished", winners, unclaimedNear, endedEarly: pool.endedEarly, finishedAt: new Date() } });
      if (!res.modifiedCount) continue;
      notifyManualSettle(pool, winners, unclaimedNear);
      console.log(`[EARLY END] manual pool ${doc.poolId} settled from snapshot (${doc.matchesPlayed}/${doc.maxMatches} matches)`);
    }
  } catch (e) { console.error("[EARLY END] reconcileManualPools failed:", e.message); }
}
// Fire-and-forget - sending a notification should never be able to
// block or fail the real event that triggered it (a pool payout, a
// future premium purchase, etc.).
async function sendInboxMessage(playerId, { title, body = "", nameTag = "NEAR Saboteur", imageUrl = null }) {
  if (!playerId || !MONGODB_URI) return;
  try {
    await InboxMessage.create({ playerId, title, body, nameTag, imageUrl: imageUrl || null });
  } catch (e) {
    console.error("[INBOX] sendInboxMessage failed:", e.message);
  }
}

// [NEW FEATURE - PLAYER DISPUTES / FEEDBACK] Submitted from inside the
// same Inbox modal in-app ("Report an issue"). Denormalized playerName/
// playerUsername the same way MatchRecord does, so a report still reads
// sensibly even if that player later renames or deletes their account.
const playerReportSchema = new mongoose.Schema({
  playerId: { type: mongoose.Schema.Types.ObjectId, ref: "Player", required: true, index: true },
  playerName: { type: String, default: "" },
  playerUsername: { type: String, default: "" },
  type: { type: String, enum: ["dispute", "feedback"], required: true, index: true },
  subject: { type: String, required: true },
  body: { type: String, default: "" },
  status: { type: String, enum: ["open", "resolved"], default: "open", index: true },
  adminNote: { type: String, default: "" },
  // [NEW FEATURE - REPLY ON RESOLVE] Whatever message (if any) was sent
  // to the player's Inbox when this was resolved - null if the admin
  // chose to skip sending one. Purely a record of what was sent, kept
  // separate from adminNote (which is private, admin-eyes-only).
  replySentText: { type: String, default: null },
  createdAt: { type: Date, default: Date.now, index: true },
});
const PlayerReport = mongoose.model("PlayerReport", playerReportSchema);

// [NEW FEATURE - ADMIN LEADERBOARD RESET] A real, backend-effective
// reset (not just hidden on the admin page) that still preserves every
// player's actual match history - see the weekly/monthly leaderboard
// endpoints below, which both take the LATER of the natural calendar
// boundary (Saturday/1st-of-month) and whatever's stored here as the
// effective cutoff. One doc per type, upserted in place.
const leaderboardResetSchema = new mongoose.Schema({
  type: { type: String, enum: ["weekly", "monthly"], required: true, unique: true },
  resetAt: { type: Date, required: true },
});
const LeaderboardReset = mongoose.model("LeaderboardReset", leaderboardResetSchema);
async function getEffectiveLeaderboardStart(type, naturalStart) {
  try {
    const doc = await LeaderboardReset.findOne({ type });
    if (doc && doc.resetAt.getTime() > naturalStart.getTime()) return doc.resetAt;
  } catch (e) { /* fall through to the natural boundary - never block the leaderboard over this */ }
  return naturalStart;
}

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
  // [SECURITY FIX] No more email-only fallback: knowing someone's email was
  // enough to replace their wallet, change their profile or buy on their
  // behalf. Every current client call sends its session token.
  return null;
}

function publicPlayer(p) {
  // Never send passwordHash/otpCode back to the client.
  return {
    email: p.email,
    verified: p.verified,
    name: p.name,
    username: p.username,
    payoutWallet: p.payoutWallet || null, // [POOL v2] prefilled when joining a Real-NEAR pool
    playPassPayerWallet: p.playPassPayerWallet || null, // [PLAY PASS - REAL NEAR]
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
    // [NEW FEATURE - PLAY PASS] hasPlayPass is the one field the
    // frontend actually needs to gate the swap button/premium UI -
    // computed here rather than sending the raw premiumUntil date, so
    // the client never has to duplicate the "is this still active"
    // date-comparison logic itself.
    hasPlayPass: !!(p.premiumUntil && p.premiumUntil.getTime() > Date.now()),
    activePremiumAvatarVariant: (p.premiumUntil && p.premiumUntil.getTime() > Date.now()) ? (p.activePremiumAvatarVariant || null) : null,
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
    console.error("[Auth] /auth/wallet-verify error:", err.message, err.keyPattern ? JSON.stringify(err.keyPattern) : "");
    // Duplicate-key on verifiedWalletAddress = this wallet's account was
    // just created by a parallel request - log into that one instead.
    if (err.code === 11000 && err.keyPattern && err.keyPattern.verifiedWalletAddress) {
      try {
        const accountId = String(req.body.accountId || "").trim().toLowerCase();
        const existing = await Player.findOne({ verifiedWalletAddress: accountId });
        if (existing && !existing.accountHeld) {
          existing.sessionToken = generateSessionToken();
          existing.sessionTokenExpiresAt = new Date(Date.now() + SESSION_TTL_MS);
          await existing.save();
          return res.json({ success: true, player: publicPlayer(existing), sessionToken: existing.sessionToken });
        }
      } catch (e2) { console.error("[Auth] wallet-verify retry failed:", e2.message); }
    }
    if (err.code === 11000) {
      // Kick the index fixer so the very next attempt works.
      fixLegacyPlayerIndexes();
      return res.status(500).json({ message: "Account setup hit a database conflict - please tap Connect Wallet once more." });
    }
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

// [NEW FEATURE - DISCONNECT CONNECTED NEAR WALLET] Clears
// verifiedWalletAddress (and the Legion badge state that depends on
// it). Same email-on-file safety guard as /profile/link-wallet above -
// a wallet-only signup account with no email/password fallback must
// add an email before it can disconnect its only way to log back in.
app.post("/profile/unlink-wallet", async (req, res) => {
  try {
    const sessionToken = String(req.body.sessionToken || "").trim();
    const player = await Player.findOne({ sessionToken });
    if (!player || !player.sessionTokenExpiresAt || player.sessionTokenExpiresAt.getTime() < Date.now()) {
      return res.status(401).json({ message: "Session expired. Please log in again." });
    }
    if (!player.verifiedWalletAddress) {
      return res.status(400).json({ message: "No wallet is currently connected." });
    }
    if (!player.email) {
      return res.status(400).json({ message: "Add an email to your account first, so you always have a way back in - then you can disconnect your connected wallet.", code: "EMAIL_REQUIRED_FIRST" });
    }
    player.verifiedWalletAddress = null;
    player.hasLegionBadge = false;
    player.legionBadgeCheckedAt = new Date();
    await player.save();
    res.json({ success: true, player: publicPlayer(player) });
  } catch (err) {
    console.error("[Auth] /profile/unlink-wallet error:", err.message);
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
    // [SECURITY FIX] Logout used to need only an email, so anyone could log
    // any player out of every device just by knowing their email. Now the
    // caller has to hold that account's current session token.
    const email = String(req.body.email || "").trim().toLowerCase();
    const sessionToken = String(req.body.sessionToken || "").trim();
    const player = sessionToken ? await Player.findOne({ email, sessionToken }) : null;
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
    // [SECURITY FIX] Used to need only an email - anyone could point another
    // player's prizes at their own wallet. Now the account's session is required.
    const walletAddress = String(req.body.walletAddress || "").trim();
    if (!walletAddress) {
      return res.status(400).json({ message: "Missing wallet address." });
    }
    const sessionToken = String(req.body.sessionToken || "").trim();
    const player = sessionToken ? await Player.findOne({ sessionToken, verified: true }) : null;
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
    const walletOwner = await Player.findOne({ walletAddress, _id: { $ne: player._id } });
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

    // [FUNDS SAFETY] Every new wallet is paid for by the oracle account (the
    // same account that pays gas for pool payouts). Without a limit, one
    // logged-in player could create wallets in a loop and drain it, which
    // would also stop pool prizes from being paid. Max 2 per player (the
    // second one covers a wallet reset), claimed atomically.
    const MAX_INGAME_WALLETS = 2;
    const claimed = await Player.updateOne(
      { _id: player._id, $or: [{ ingameWalletsCreated: { $lt: MAX_INGAME_WALLETS } }, { ingameWalletsCreated: { $exists: false } }] },
      { $inc: { ingameWalletsCreated: 1 } },
    );
    if (!claimed.modifiedCount) {
      return res.status(429).json({ message: "You've already created the maximum number of in-game wallets. Contact support if you need help." });
    }
    const releaseClaim = () => Player.updateOne({ _id: player._id, ingameWalletsCreated: { $gt: 0 } }, { $inc: { ingameWalletsCreated: -1 } }).catch(() => {});

    try {
      const nearAPI = await loadNearAPI();
      // keep the oracle's gas reserve: never create a wallet that would dip under it
      const funderBalance = BigInt(await oracleAccount.getBalance());
      if (NEAR_NETWORK === "testnet" && funderBalance < BigInt(nearAPI.nearToYocto(String(TESTNET_FUNDER_RESERVE_NEAR)))) {
        await releaseClaim();
        console.warn(`[WALLET] oracle balance under the ${TESTNET_FUNDER_RESERVE_NEAR} NEAR reserve - not creating ${newAccountId}`);
        return res.status(503).json({ message: "Wallet creation is paused for a moment. Try again later." });
      }
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
      await releaseClaim(); // nothing was created - doesn't count
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
    // [TESTNET GIFT] 1 test NEAR on top - once per player (shares the claim
    // with /wallet/testnet-topup), if the funder can spare it
    let gift = { sent: false };
    const giftClaim = await Player.updateOne({ _id: player._id, testnetTopupAt: null }, { $set: { testnetTopupAt: new Date() } });
    if (giftClaim.modifiedCount) {
      gift = await giftTestnetNear(newAccountId);
      if (!gift.sent) await Player.updateOne({ _id: player._id }, { $set: { testnetTopupAt: null } });
    }
    res.json({ accountId: newAccountId, giftedNear: gift.sent ? gift.amountNear : 0 });
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
// [NEW FEATURE - GIF PICKER] Klipy GIF search + trending, proxied
// server-side so the real API key (KLIPY_API_KEY) never reaches the
// client - the same reasoning as every other on-chain credential in
// this file, just for a third-party API key instead of a NEAR key.
// customerId is just Klipy's own per-user analytics identifier (not a
// game account), so a stable per-socket id is enough - no PII needed.
const KLIPY_API_KEY = process.env.KLIPY_API_KEY || "";
// [NEW FEATURE - GIF PICKER] Every chat message that carries a gifUrl
// goes through this first - never trust a client-supplied URL outright
// (could otherwise be any arbitrary link dressed up as a "GIF", used
// for tracking pixels, phishing, or worse). Only accepts a plausible
// https image/gif URL shape; anything else is silently dropped (the
// message still sends as text-only if there was any text alongside it).
const { validateSticker } = require("./stickers"); // [PLAY PASS - STICKERS]
function validateGifUrl(url) {
  if (typeof url !== "string") return null;
  if (!/^https:\/\/.+\.(gif|webp|png|jpe?g)(\?.*)?$/i.test(url) || url.length > 500) return null;
  return url;
}
async function klipyRequest(res, path, params) {
  if (!KLIPY_API_KEY) return res.status(503).json({ message: "GIFs aren't configured on this server yet." });
  try {
    const qs = new URLSearchParams(params).toString();
    const url = `https://api.klipy.com/api/v1/${encodeURIComponent(KLIPY_API_KEY)}/gifs/${path}?${qs}`;
    const klipyRes = await fetch(url);
    const text = await klipyRes.text();
    res.status(klipyRes.status);
    res.set("Content-Type", klipyRes.headers.get("content-type") || "application/json");
    res.send(text);
  } catch (e) {
    res.status(502).json({ message: `GIF request failed: ${e.message}` });
  }
}
app.post("/gif/search", async (req, res) => {
  const query = String(req.body.query || "").trim();
  const locale = String(req.body.locale || "en");
  const customerId = String(req.body.customerId || "guest").slice(0, 64);
  if (!query) return res.status(400).json({ message: "Missing search query." });
  await klipyRequest(res, "search", { q: query, customer_id: customerId, page: "1", per_page: "30", locale });
});
app.post("/gif/trending", async (req, res) => {
  const locale = String(req.body.locale || "en");
  const customerId = String(req.body.customerId || "guest").slice(0, 64);
  await klipyRequest(res, "trending", { customer_id: customerId, page: "1", per_page: "30", locale });
});

// [BUG FIX - WALLET HISTORY STOPPED SHOWING NEW TRANSACTIONS] Root cause:
// nearblocks' /v1/account/{id}/txns is their LEGACY endpoint (officially
// "NOT RECOMMENDED") and stopped returning recent activity - that's why
// the wallet's newest row was weeks old and a fresh pool game (entry fee
// + prize) never appeared at all. Now reads /receipts (which also
// includes incoming contract payouts like prizes/refunds - those are
// receipts, never transactions signed by the player), falling back to
// /txns-only and then the legacy /txns. Short per-account cache so the
// free nearblocks rate limit isn't hammered by repeated wallet opens.
const nearblocksCache = new Map(); // key -> { at, rows }
const NEARBLOCKS_CACHE_MS = 10 * 1000;
async function fetchNearblocksAccountRows(accountId, perPage = 50) {
  const key = `${accountId}|${perPage}`;
  const cached = nearblocksCache.get(key);
  if (cached && Date.now() - cached.at < NEARBLOCKS_CACHE_MS) return cached.rows;
  const apiBase = NEAR_NETWORK === "testnet" ? "https://api-testnet.nearblocks.io" : "https://api.nearblocks.io";
  const headers = process.env.NEARBLOCKS_API_KEY ? { Authorization: `Bearer ${process.env.NEARBLOCKS_API_KEY}` } : {};
  const paths = ["receipts", "txns-only", "txns"];
  let lastErr = null;
  for (const path of paths) {
    try {
      const resp = await fetch(`${apiBase}/v1/account/${encodeURIComponent(accountId)}/${path}?per_page=${perPage}&order=desc`, { headers });
      if (!resp.ok) { lastErr = new Error(`nearblocks /${path} responded with ${resp.status}`); continue; }
      const data = await resp.json();
      const rows = Array.isArray(data.txns) ? data.txns : (Array.isArray(data.receipts) ? data.receipts : null);
      if (!rows) { lastErr = new Error(`nearblocks /${path} returned an unexpected shape`); continue; }
      nearblocksCache.set(key, { at: Date.now(), rows });
      return rows;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("nearblocks unavailable");
}
function nearblocksRowTimeMs(t) {
  const rawTs = t.block_timestamp || t.timestamp || (t.block && t.block.block_timestamp);
  if (!rawTs) return null;
  return String(rawTs).length > 13 ? Number(rawTs) / 1e6 : Number(rawTs);
}
function msToUtcString(ms) {
  return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) : "";
}

app.post("/wallet/history", async (req, res) => {
  try {
    const walletAddress = String(req.body.walletAddress || "").trim();
    if (!walletAddress) return res.status(400).json({ message: "Missing wallet address." });

    // ---- App's own ledger (instant, no indexer lag) ----
    let player = null;
    let poolMatches = [];
    let poolRecords = [];
    if (MONGODB_URI) {
      try {
        player = await Player.findOne({ walletAddress }, "_id");
        if (player) {
          const pid = String(player._id);
          [poolMatches, poolRecords] = await Promise.all([
            MatchRecord.find({ playerId: player._id, poolId: { $ne: null } }, "poolId poolName won points role poolRank poolNearWon earnedAt").sort({ earnedAt: -1 }).limit(60).lean(),
            PoolRecord.find(
              { $or: [{ hostAccountId: pid }, { onChainParticipantAccountIds: pid }, { "txnLog.accountId": pid }] },
              "onChainPoolId hostAccountId hostFunded entryFeeNear state onChainParticipantAccountIds txnLog createdAt"
            ).sort({ createdAt: -1 }).limit(40).lean(),
          ]);
        }
      } catch (e) {
        console.error("[WALLET] Could not load pool context:", e.message);
      }
    }
    const pid = player ? String(player._id) : null;

    function findNearestMatch(txTimeMs, onChainPoolId) {
      if (poolMatches.length === 0) return null;
      // Exact pool match first (MatchRecord.poolId can be the on-chain id).
      if (onChainPoolId) {
        const exact = poolMatches.find((m) => String(m.poolId) === String(onChainPoolId));
        if (exact) return exact;
      }
      if (!txTimeMs) return null;
      // 20 min window - settlement and the MatchRecord commit happen in
      // the same breath, so anything further away is a different pool.
      const WINDOW_MS = 20 * 60 * 1000;
      let best = null, bestDiff = Infinity;
      for (const m of poolMatches) {
        const diff = Math.abs(new Date(m.earnedAt).getTime() - txTimeMs);
        if (diff < bestDiff && diff <= WINDOW_MS) { best = m; bestDiff = diff; }
      }
      return best;
    }
    function attachMatch(row, match, isPrize) {
      if (!match) return;
      row.poolName = row.poolName || match.poolName || null;
      row.poolId = row.poolId || match.poolId || null;
      row.gamePoints = match.points ?? null;
      row.gameRole = match.role || null;
      if (isPrize) {
        row.poolRank = typeof match.poolRank === "number" ? match.poolRank : null;
        row.gameOutcome = row.poolRank ? "placed" : (match.won ? "won" : "lost");
      } else if (row.kind === "entry_fee") {
        row.poolRank = typeof match.poolRank === "number" ? match.poolRank : null;
        row.gameOutcome = row.poolRank ? "placed" : (match.won ? "won" : "lost");
      }
    }

    const ledgerRows = [];
    for (const pr of poolRecords) {
      const entryFee = Number(pr.entryFeeNear || 0);
      for (const e of pr.txnLog || []) {
        const t = e.createdAt ? new Date(e.createdAt).getTime() : null;
        const base = {
          counterparty: POOL_CONTRACT_ACCOUNT_ID || "pool contract",
          timestampUtc: msToUtcString(t), _t: t, txHash: e.txHash || null,
          poolName: null, poolId: pr.onChainPoolId, gameOutcome: null, poolRank: null, gamePoints: null, gameRole: null,
          source: "app",
        };
        let row = null;
        if (e.accountId === pid && e.type === "participate") {
          row = { ...base, type: "sent", kind: "entry_fee", amountNear: Number(e.amountNear || 0).toFixed(4) };
        } else if (e.accountId === pid && e.type === "create_pool") {
          row = { ...base, type: "sent", kind: "pool_created", amountNear: Number(e.amountNear || 0).toFixed(4) };
        } else if (e.accountId === pid && e.type === "distribute_prizes" && Number(e.amountNear) > 0) {
          row = { ...base, type: "received", kind: "prize", amountNear: Number(e.amountNear).toFixed(4) };
        } else if (e.accountId === pid && e.type === "refund_participant" && Number(e.amountNear) > 0) {
          row = { ...base, type: "received", kind: "refund", amountNear: Number(e.amountNear).toFixed(4) };
        } else if (e.type === "cancel_pool" && pid && (pr.onChainParticipantAccountIds || []).includes(pid)) {
          const refund = pr.hostFunded ? (pr.hostAccountId === pid ? entryFee : 0) : entryFee;
          if (refund > 0) row = { ...base, type: "received", kind: "refund", amountNear: refund.toFixed(4) };
        }
        if (row) {
          attachMatch(row, findNearestMatch(t, pr.onChainPoolId), row.kind === "prize");
          ledgerRows.push(row);
        }
      }
    }

    // ---- On-chain rows from nearblocks ----
    let chainRows = [];
    let chainError = null;
    try {
      const rawRows = await fetchNearblocksAccountRows(walletAddress, 50);
      const seenReceipt = new Set();
      chainRows = rawRows
        .filter((t) => {
          // NEAR returns unused gas to the signer via "system" receipts on
          // EVERY transaction - noise, never shown to the player.
          const predecessor = String(t.predecessor_account_id || t.signer_account_id || t.signer_id || "").toLowerCase();
          if (predecessor === "system") return false;
          const id = t.receipt_id || `${t.transaction_hash}|${t.predecessor_account_id}|${t.receiver_account_id}`;
          if (seenReceipt.has(id)) return false;
          seenReceipt.add(id);
          return true;
        })
        .map((t) => {
          const receiver = t.receiver_account_id || t.receiver_id || "";
          const predecessor = t.predecessor_account_id || t.signer_account_id || t.signer_id || "";
          if (receiver !== walletAddress && predecessor !== walletAddress) return null;
          const isReceived = receiver === walletAddress && predecessor !== walletAddress;
          const counterparty = isReceived ? (predecessor || "unknown") : (receiver || "unknown");
          let amountYocto = "0";
          if (t.actions_agg && t.actions_agg.deposit) amountYocto = String(t.actions_agg.deposit);
          else if (Array.isArray(t.actions) && t.actions[0] && t.actions[0].deposit) amountYocto = String(t.actions[0].deposit);
          const amountNum = Number(amountYocto) / 1e24;
          // A received row with no deposit is a contract callback / no-op
          // receipt, not money - skip it.
          if (isReceived && !(amountNum > 0)) return null;
          const txTimeMs = nearblocksRowTimeMs(t);
          const method = (Array.isArray(t.actions) && t.actions[0] && (t.actions[0].method || t.actions[0].method_name)) || null;
          const row = {
            type: isReceived ? "received" : "sent",
            counterparty, amountNear: amountNum > 0 ? amountNum.toFixed(4) : "0.0000",
            timestampUtc: msToUtcString(txTimeMs), _t: txTimeMs, txHash: t.transaction_hash || t.hash || null,
            kind: "transfer", poolName: null, poolId: null, gameOutcome: null, poolRank: null, gamePoints: null, gameRole: null,
            source: "chain",
          };
          if (POOL_CONTRACT_ACCOUNT_ID && counterparty === POOL_CONTRACT_ACCOUNT_ID) {
            if (!isReceived && method === "participate") row.kind = "entry_fee";
            else if (!isReceived && method === "create_pool") row.kind = "pool_created";
            else if (!isReceived && method === "cancel_pool") row.kind = "cancel_pool";
            else if (!isReceived && method === "lock_participation") row.kind = "pool_created";
            else if (isReceived) {
              const match = findNearestMatch(txTimeMs, null);
              row.kind = match ? "prize" : "refund";
              attachMatch(row, match, true);
            }
            if (!row.poolName && row.kind !== "prize") attachMatch(row, findNearestMatch(txTimeMs, null), false);
          }
          return row;
        })
        .filter(Boolean);
    } catch (e) {
      chainError = e.message;
      console.error("[WALLET] nearblocks fetch failed:", e.message);
    }

    // ---- Merge: chain rows win; ledger rows fill in what the indexer
    // hasn't caught up on yet (or never will show, e.g. if it's down). ----
    const merged = [...chainRows];
    for (const lr of ledgerRows) {
      let dup = null;
      if (lr.txHash) dup = chainRows.find((c) => c.txHash && c.txHash === lr.txHash);
      if (!dup) {
        dup = chainRows.find((c) =>
          c.type === lr.type &&
          c.counterparty === lr.counterparty &&
          Math.abs(Number(c.amountNear) - Number(lr.amountNear)) < 0.0011 &&
          c._t && lr._t && Math.abs(c._t - lr._t) < 30 * 60 * 1000 &&
          !c._claimed
        );
      }
      if (dup) {
        dup._claimed = true;
        // Ledger knows the real purpose for sure - prefer its labels.
        dup.kind = lr.kind;
        dup.poolName = dup.poolName || lr.poolName;
        dup.poolId = dup.poolId || lr.poolId;
        if (lr.gameOutcome) { dup.gameOutcome = lr.gameOutcome; dup.poolRank = lr.poolRank; dup.gamePoints = lr.gamePoints; dup.gameRole = lr.gameRole; }
      } else {
        merged.push(lr);
      }
    }
    merged.sort((a, b) => (b._t || 0) - (a._t || 0));
    const transactions = merged.slice(0, 35).map(({ _t, _claimed, ...rest }) => rest);
    if (transactions.length === 0 && chainError) {
      return res.status(502).json({ message: "Could not load transaction history." });
    }
    res.json({ transactions, partial: !!chainError });
  } catch (err) {
    console.error("[WALLET] /wallet/history error:", err.message);
    res.status(500).json({ message: "Could not load transaction history." });
  }
});

// [NEW FEATURE - WALLET PORTFOLIO] Coins + NFTs held by a wallet, with
// every token valued in NEAR so the wallet can show one portfolio total.
//   - Holdings: FastNEAR's free account API (lists FT contracts + NFT
//     contracts an account touches - recommended in NEAR's own docs).
//   - Token/NFT details: plain read-only RPC view calls (ft_metadata,
//     ft_balance_of, nft_metadata, nft_tokens_for_owner) - no gas, no keys.
//   - Prices: Ref Finance's public price list (USD), converted to NEAR via
//     wrap.near's own price. Mainnet only - testnet tokens have no market,
//     so on testnet tokens are listed with valueNear: null and simply
//     don't count toward the total (the wallet says so in the UI).
// Read-only end to end - nothing here can ever move funds.
const portfolioCache = new Map(); // walletAddress -> { at, data }
const PORTFOLIO_CACHE_MS = 30 * 1000;
let refPriceCache = { at: 0, prices: null };
async function rpcViewCall(contractId, methodName, args = {}) {
  const resp = await fetch(NEAR_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "pf", method: "query",
      params: { request_type: "call_function", finality: "final", account_id: contractId, method_name: methodName, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") },
    }),
  });
  const data = await resp.json();
  if (data.error || !data.result || !data.result.result) throw new Error(data.error?.message || "view call failed");
  return JSON.parse(Buffer.from(Uint8Array.from(data.result.result)).toString("utf8"));
}
async function getRefPricesUsd() {
  if (NEAR_NETWORK !== "mainnet") return null;
  if (refPriceCache.prices && Date.now() - refPriceCache.at < 60 * 1000) return refPriceCache.prices;
  try {
    const resp = await fetch("https://indexer.ref.finance/list-token-price");
    if (!resp.ok) throw new Error(`ref prices ${resp.status}`);
    const prices = await resp.json();
    refPriceCache = { at: Date.now(), prices };
    return prices;
  } catch (e) {
    console.error("[PORTFOLIO] Ref price fetch failed:", e.message);
    return refPriceCache.prices; // stale is better than nothing
  }
}
function rawToUnits(raw, decimals) {
  try {
    const big = BigInt(String(raw || "0"));
    const d = BigInt(10) ** BigInt(Math.max(0, Math.min(36, Number(decimals) || 0)));
    const whole = big / d;
    const frac = big % d;
    return Number(whole) + Number(frac) / Number(d);
  } catch (e) {
    return 0;
  }
}
app.post("/wallet/portfolio", async (req, res) => {
  try {
    const walletAddress = String(req.body.walletAddress || "").trim();
    if (!walletAddress) return res.status(400).json({ message: "Missing wallet address." });
    const cached = portfolioCache.get(walletAddress);
    if (cached && Date.now() - cached.at < PORTFOLIO_CACHE_MS) return res.json(cached.data);

    const fastBase = NEAR_NETWORK === "mainnet" ? "https://api.fastnear.com" : "https://test.api.fastnear.com";
    const [ftResp, nftResp, pricesUsd] = await Promise.all([
      fetch(`${fastBase}/v1/account/${encodeURIComponent(walletAddress)}/ft`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`${fastBase}/v1/account/${encodeURIComponent(walletAddress)}/nft`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      getRefPricesUsd(),
    ]);
    const nearUsd = pricesUsd && pricesUsd["wrap.near"] ? Number(pricesUsd["wrap.near"].price) : null;

    // ---- Fungible tokens ----
    const ftContracts = (ftResp && Array.isArray(ftResp.tokens) ? ftResp.tokens : []).slice(0, 25);
    const tokens = (await Promise.all(ftContracts.map(async (t) => {
      const contractId = t.contract_id;
      try {
        const [meta, freshBalance] = await Promise.all([
          rpcViewCall(contractId, "ft_metadata"),
          rpcViewCall(contractId, "ft_balance_of", { account_id: walletAddress }).catch(() => t.balance),
        ]);
        const amount = rawToUnits(freshBalance ?? t.balance, meta.decimals);
        if (!(amount > 0)) return null;
        const p = pricesUsd && pricesUsd[contractId] ? Number(pricesUsd[contractId].price) : null;
        const priceNear = p && nearUsd ? p / nearUsd : null;
        let icon = typeof meta.icon === "string" && meta.icon.startsWith("data:image/") && meta.icon.length < 60000 ? meta.icon : null;
        return {
          contractId,
          symbol: String(meta.symbol || "").slice(0, 12) || contractId.split(".")[0].slice(0, 10).toUpperCase(),
          name: String(meta.name || contractId).slice(0, 40),
          icon,
          decimals: Number(meta.decimals) || 0,
          raw: String(freshBalance ?? t.balance ?? "0"),
          amount,
          priceNear,
          valueNear: priceNear != null ? amount * priceNear : null,
        };
      } catch (e) {
        return null; // not a real NEP-141 token, or contract unreachable - skip it
      }
    }))).filter(Boolean)
      .filter((t) => t.contractId !== "wrap.near" || t.amount > 0)
      .sort((a, b) => (b.valueNear ?? -1) - (a.valueNear ?? -1));

    // ---- NFTs ----
    const nftContracts = (nftResp && Array.isArray(nftResp.tokens) ? nftResp.tokens : []).slice(0, 12);
    const nftGroups = await Promise.all(nftContracts.map(async (c) => {
      const contractId = c.contract_id;
      try {
        const [meta, owned] = await Promise.all([
          rpcViewCall(contractId, "nft_metadata").catch(() => ({})),
          rpcViewCall(contractId, "nft_tokens_for_owner", { account_id: walletAddress, from_index: "0", limit: 12 }),
        ]);
        return (Array.isArray(owned) ? owned : []).map((tok) => {
          const m = tok.metadata || {};
          let media = m.media || null;
          if (media && !/^https?:\/\/|^data:image\//.test(media)) {
            media = meta.base_uri ? `${String(meta.base_uri).replace(/\/$/, "")}/${String(media).replace(/^\//, "")}` : `https://ipfs.io/ipfs/${media}`;
          }
          return {
            contractId,
            tokenId: String(tok.token_id),
            title: String(m.title || `#${tok.token_id}`).slice(0, 60),
            collection: String(meta.name || contractId).slice(0, 40),
            media,
            isSbt: /sbt|nearlegion/i.test(contractId),
          };
        });
      } catch (e) {
        return [];
      }
    }));
    const nfts = nftGroups.flat().slice(0, 40);

    const tokensValueNear = tokens.reduce((sum, t) => sum + (t.valueNear || 0), 0);
    const data = {
      network: NEAR_NETWORK,
      pricesAvailable: !!nearUsd,
      tokens,
      tokensValueNear,
      unpricedTokenCount: tokens.filter((t) => t.valueNear == null).length,
      nfts,
    };
    portfolioCache.set(walletAddress, { at: Date.now(), data });
    res.json(data);
  } catch (err) {
    console.error("[PORTFOLIO] /wallet/portfolio error:", err.message);
    res.status(500).json({ message: "Could not load wallet tokens." });
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

// ============================================================
// [NEW FEATURE - PLAY PASS] Player-facing routes.
// ============================================================

// ---- GET PLAY PASS CONFIG (public, no auth needed) ----
// Powers the Home screen preview screen (price shown before purchase)
// without requiring the player to be logged in just to see it.
app.get("/play-pass/config", async (req, res) => {
  try {
    const config = await getPlayPassConfig();
    res.json({
      success: true,
      enabled: !!config.enabled,
      priceNear: config.priceNear,
      discountPercent: config.discountPercent || 0,
      effectivePriceNear: effectivePlayPassPriceNear(config),
      receivingAccountId: PLAY_PASS_MAINNET_RECEIVER,
      network: "mainnet",
      refundPolicy: "If your payment arrives but Play Pass isn't switched on, we send the NEAR back. Once Play Pass is active, purchases are final - no refunds.",
      variants: PREMIUM_AVATAR_VARIANTS,
      unlockGamesGap: config.unlockGamesGap || 2,
    });
  } catch (err) {
    console.error("[PLAY PASS] /play-pass/config error:", err.message);
    res.status(500).json({ message: "Could not load Play Pass info." });
  }
});

// ---- GET THIS PLAYER'S PLAY PASS STATUS ---- Client sends: { sessionToken }
app.post("/play-pass/status", async (req, res) => {
  try {
    const player = await findActingPlayer(req);
    if (!player) return res.status(404).json({ message: "Account not found." });
    const config = await getPlayPassConfig();
    const gap = config.unlockGamesGap || 2;
    const unlockedCount = getUnlockedVariantCount(player, gap);
    const playedSinceStart = Math.max(0, (player.gamesPlayed || 0) - (player.playPassStartGamesPlayed || 0));
    // [NEW FEATURE - PLAY PASS SKIN UNLOCK PROGRESSION] gamesUntilNext =
    // how many more games until the NEXT skin unlocks (0 once every
    // skin is unlocked) - lets the frontend show "1 more game to
    // unlock Halfblood" style progress without doing the math itself.
    const gamesUntilNext = unlockedCount >= PREMIUM_AVATAR_VARIANTS.length
      ? 0
      : gap - (playedSinceStart % gap);
    res.json({
      success: true,
      hasPlayPass: !!(player.premiumUntil && player.premiumUntil.getTime() > Date.now()),
      activePremiumAvatarVariant: player.activePremiumAvatarVariant || null,
      playPassSource: player.playPassSource || null,
      unlockedVariantCount: unlockedCount,
      unlockGamesGap: gap,
      gamesPlayedSincePlayPass: playedSinceStart,
      gamesUntilNextUnlock: gamesUntilNext,
    });
  } catch (err) {
    console.error("[PLAY PASS] /play-pass/status error:", err.message);
    res.status(500).json({ message: "Could not load Play Pass status." });
  }
});

// ---- PURCHASE PLAY PASS ---- Client sends: { sessionToken, txHash }
// [NEW FEATURE - PLAY PASS - PAYMENT SECURITY] Same "trust the client
// for nothing" principle as pool/paid entry fees - the client only ever
// hands over a txHash of a transfer it already signed and sent with the
// player's own in-game custodial wallet. This route independently
// re-checks that transaction against the NEAR RPC before granting
// anything (see verifyPlayPassTransfer). A Play Pass, once granted,
// never expires (premiumUntil is set far in the future, per Om7eth's
// "permanent" spec) - this is a one-time purchase, not a subscription.
app.post("/play-pass/purchase", async (req, res) => {
  try {
    const player = await findActingPlayer(req);
    if (!player) return res.status(404).json({ message: "Account not found." });
    if (player.premiumUntil && player.premiumUntil.getTime() > Date.now()) {
      return res.status(409).json({ message: "You already have Play Pass." });
    }
    if (player.walletType !== "ingame" || !player.walletAddress) {
      return res.status(400).json({ message: "You need an in-game wallet set up to purchase Play Pass." });
    }
    const txHash = String(req.body.txHash || "").trim();
    if (!txHash) return res.status(400).json({ message: "Missing transaction hash." });

    const config = await getPlayPassConfig();
    if (!config.enabled) return res.status(403).json({ message: "Play Pass purchases are currently unavailable." });
    // [PLAY PASS - REAL NEAR] the old test-NEAR purchase is closed - Play Pass is bought with real NEAR now
    if (!process.env.PLAY_PASS_ALLOW_TESTNET) return res.status(410).json({ message: "Play Pass is now bought with real NEAR from your own wallet. Update the game and try again." });

    const nearAPI = await loadNearAPI();
    // [BUG FIX] near-api-js v7 dropped the old utils.format.parseNearAmount
    // API entirely - this codebase already uses the correct v7 replacement
    // (nearToYocto) successfully everywhere else (e.g. the funding-amount
    // call above, and every wallet transfer in game.jsx's nearLite.js).
    // The old call here silently threw "Cannot read properties of
    // undefined (reading 'format')" on every single purchase attempt,
    // which is why real payments went through on-chain (visible in the
    // player's own wallet history) but always got rejected here with a
    // generic "Something went wrong" - the exception was thrown before
    // verifyPlayPassTransfer ever even ran.
    const priceYocto = nearAPI.nearToYocto(String(effectivePlayPassPriceNear(config)));
    const verification = await verifyPlayPassTransfer(txHash, player.walletAddress, priceYocto);
    if (!verification.ok) {
      return res.status(400).json({ message: verification.error || "Could not verify your payment." });
    }

    player.premiumUntil = new Date("2099-12-31");
    player.playPassSource = "purchased";
    player.playPassTxHash = txHash;
    // [NEW FEATURE - REVENUE TRACKING] Exact amount paid, not just the
    // current config price - see schema comment.
    player.playPassPricePaidNear = effectivePlayPassPriceNear(config);
    // [NEW FEATURE - PLAY PASS SKIN UNLOCK PROGRESSION] Snapshot right
    // now, so unlock progress counts only games played AFTER this
    // purchase - see getUnlockedVariantCount.
    player.playPassStartGamesPlayed = player.gamesPlayed || 0;
    await player.save();

    sendInboxMessage(player._id, {
      title: "🎉 Play Pass activated!",
      body: "Thanks for grabbing Play Pass! Head to your Home screen to swap in your premium avatar skins.",
    });
    logAdminAction("play-pass-purchased", { playerId: String(player._id), playerName: player.name, txHash });

    res.json({ success: true, hasPlayPass: true });
  } catch (err) {
    console.error("[PLAY PASS] /play-pass/purchase error:", err.stack || err.message);
    res.status(500).json({ message: "Something went wrong verifying your purchase. Please try again." });
  }
});

// ---- SELECT ACTIVE PREMIUM AVATAR VARIANT ----
// Client sends: { sessionToken, variantId, avatarId }
// [NEW FEATURE - PLAY PASS] variantId must (a) exist in the hardcoded
// PREMIUM_AVATAR_VARIANTS registry and (b) belong to the same base
// color (avatarId) the player says they currently have selected - this
// is what stops a player swapping, say, a green slot into the
// BlackDragon skin. Passing variantId: null clears back to the plain
// avatar for that color (the "revert" action).
app.post("/play-pass/select-variant", async (req, res) => {
  try {
    const player = await findActingPlayer(req);
    if (!player) return res.status(404).json({ message: "Account not found." });
    if (!player.premiumUntil || player.premiumUntil.getTime() <= Date.now()) {
      return res.status(403).json({ message: "Play Pass required to use premium avatars." });
    }
    const variantId = req.body.variantId ? String(req.body.variantId).trim() : null;
    if (variantId === null) {
      player.activePremiumAvatarVariant = null;
      await player.save();
      return res.json({ success: true, activePremiumAvatarVariant: null });
    }
    const avatarId = String(req.body.avatarId || "").trim();
    const variant = getPremiumVariant(variantId);
    if (!variant) return res.status(400).json({ message: "Unknown premium avatar." });
    if (avatarId && variant.baseAvatarId !== avatarId) {
      return res.status(400).json({ message: "That skin doesn't match your selected avatar color." });
    }
    // [NEW FEATURE - PLAY PASS SKIN UNLOCK PROGRESSION] Never trust the
    // client's claim that a skin is unlocked - re-derive from
    // gamesPlayed server-side, same as every other unlock check.
    const config = await getPlayPassConfig();
    const unlockedCount = getUnlockedVariantCount(player, config.unlockGamesGap || 2);
    const variantIndex = PREMIUM_AVATAR_VARIANTS.findIndex((v) => v.id === variant.id);
    if (variantIndex === -1 || variantIndex >= unlockedCount) {
      return res.status(403).json({ message: "This skin hasn't unlocked yet - keep playing to unlock it." });
    }
    player.activePremiumAvatarVariant = variant.id;
    await player.save();
    res.json({ success: true, activePremiumAvatarVariant: variant.id });
  } catch (err) {
    console.error("[PLAY PASS] /play-pass/select-variant error:", err.message);
    res.status(500).json({ message: "Could not update your avatar. Please try again." });
  }
});

// [NEW FEATURE - CUSTOM AVATAR REQUEST] Public config - price, support
// Telegram link, on/off - same pattern as GET /play-pass/config.
app.get("/custom-avatar-request/config", async (req, res) => {
  try {
    const config = await getCustomAvatarRequestConfig();
    res.json({
      enabled: config.enabled,
      priceNear: config.priceNear,
      telegramLink: config.telegramLink || null,
      // [NEW FEATURE] Same receiving wallet as Play Pass - the frontend
      // needs this to actually send the payment to.
      receivingAccountId: PLAY_PASS_RECEIVING_ACCOUNT_ID,
    });
  } catch (err) {
    console.error("[CUSTOM AVATAR REQUEST] /custom-avatar-request/config error:", err.message);
    res.status(500).json({ message: "Could not load custom avatar request info." });
  }
});

// [NEW FEATURE - CUSTOM AVATAR REQUEST] Player submits the actual
// request - payment is verified independently against the chain first
// (same verifyPlayPassTransfer used for Play Pass, since both pay into
// PLAY_PASS_RECEIVING_ACCOUNT_ID), THEN the request document (with
// image + description + Telegram contact) is created. If a player pays
// but this call never completes (closes the app, connection drops),
// the payment still shows up in the admin Revenue/Transactions view via
// the receiving wallet's own on-chain history - see
// /admin/revenue-wallet-history - so nothing is silently lost even
// without a matching request document.
app.post("/custom-avatar-request/submit", async (req, res) => {
  try {
    const player = await findActingPlayer(req);
    if (!player) return res.status(404).json({ message: "Account not found." });
    if (player.walletType !== "ingame" || !player.walletAddress) {
      return res.status(400).json({ message: "You need an in-game wallet set up to request a custom character." });
    }
    const config = await getCustomAvatarRequestConfig();
    if (!config.enabled) return res.status(403).json({ message: "Custom character requests aren't open right now." });

    const telegramUsername = String(req.body.telegramUsername || "").trim().replace(/^@/, "");
    if (!telegramUsername) return res.status(400).json({ message: "A Telegram username is required so we can contact you." });
    const description = String(req.body.description || "").trim();
    if (!description) return res.status(400).json({ message: "Please describe the character you want." });
    if (description.length > 2000) return res.status(400).json({ message: "Description is too long (max 2000 characters)." });

    const imageBase64 = String(req.body.imageBase64 || "");
    const imageMimeType = String(req.body.imageMimeType || "");
    if (!imageBase64 || !imageMimeType) return res.status(400).json({ message: "Please attach a reference image." });
    if (!["image/png", "image/jpeg", "image/webp"].includes(imageMimeType)) {
      return res.status(400).json({ message: "Image must be PNG, JPEG, or WEBP." });
    }
    // [SECURITY] Reject an oversized image server-side too - the
    // client-side check is just for a fast, friendly error; base64
    // length ≈ 4/3 of raw byte size, so this is a safe upper estimate.
    if (imageBase64.length > MAX_CUSTOM_AVATAR_IMAGE_BYTES * 1.4) {
      return res.status(400).json({ message: "Image is too large (max 1MB)." });
    }

    const txHash = String(req.body.txHash || "").trim();
    if (!txHash) return res.status(400).json({ message: "Missing payment transaction hash." });
    const nearAPI = await loadNearAPI();
    const minYocto = nearAPI.nearToYocto(String(config.priceNear));
    const verification = await verifyPlayPassTransfer(txHash, player.walletAddress, minYocto);
    if (!verification.ok) {
      return res.status(400).json({ message: verification.error || "Could not verify your payment." });
    }

    const request = await CustomAvatarRequest.create({
      playerId: player._id,
      playerName: player.name || player.username || "Player",
      walletAddress: player.walletAddress,
      telegramUsername,
      description,
      imageBase64,
      imageMimeType,
      pricePaidNear: config.priceNear,
      paymentTxHash: txHash,
    });

    // [NEW FEATURE] Confirms to the player their request actually went
    // through, matching the pattern of every other inbox confirmation
    // in this file (Play Pass, pool wins, etc).
    sendInboxMessage(player._id, {
      title: "Custom character request received",
      body: "We got your request and reference image - our team will reach out on Telegram once it's reviewed.",
      nameTag: "NEAR Saboteur",
    });

    res.json({ success: true, requestId: request._id });
  } catch (err) {
    console.error("[CUSTOM AVATAR REQUEST] /custom-avatar-request/submit error:", err.message);
    res.status(500).json({ message: "Could not submit your request. Please try again." });
  }
});

// ---- PROFILE SETUP ---- Client sends: { email, name, avatarId }
const USERNAME_REGEX = /^[a-z0-9_]{3,20}$/;

// ---- PROFILE SETUP / EDIT ---- Client sends: { email, name, username }
// [BUG FIX/UPDATE] avatarId removed - avatar selection lives in the
// Lobby (per-match, room-scoped) only, never on the account profile.
// Also used for LATER edits (via Settings → Profile), not just the
// initial post-wallet setup - same endpoint, same validation either way.
// [ONBOARDING] Live "available ✓ / taken" while a new player types their
// username. Same rules as /profile/setup; the setup call still re-checks.
app.get("/profile/username-available", async (req, res) => {
  try {
    const username = String(req.query.username || "").trim().toLowerCase();
    if (!USERNAME_REGEX.test(username)) return res.json({ ok: false, reason: "format" });
    if (!MONGODB_URI) return res.json({ ok: true });
    const me = req.query.sessionToken ? await Player.findOne({ sessionToken: String(req.query.sessionToken) }).select("_id") : null;
    const taken = await Player.exists(me ? { username, _id: { $ne: me._id } } : { username });
    res.json({ ok: !taken, reason: taken ? "taken" : null });
  } catch (e) { res.status(500).json({ ok: false, reason: "error" }); }
});

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
const FREE_ROOM_TAGS = ["VOICE CHAT", "NEWBIES OK", "COMPETITIVE", "CHILL"];
// Free Play rooms only (no pool/paid) - public, not yet started. Now also
// carries the host's briefing/tags, host identity (for the Legion badge
// + Play Pass name tag rules) and each seated player's avatar so the
// room-details sheet can show who's on board before joining.
app.get("/rooms/public", (req, res) => {
  const openRooms = Object.values(rooms)
    .filter((r) => r.isPublic && !r.gameStarted && !r.pool && (r.gameMode || "free") === "free")
    .map((r) => {
      const players = Object.values(r.players);
      const host = players.find((p) => p.isHost) || null;
      return {
        code: r.code,
        name: r.freeName || "",
        briefing: r.freeBriefing || "",
        tags: Array.isArray(r.freeTags) ? r.freeTags : [],
        playerCount: players.length,
        matchLimit: r.matchLimit ?? null, // null = No Limit
        matchesPlayed: r.matchesPlayed || 0,
        hostName: host?.name || "Host",
        hostUsername: host?.accountUsername || null,
        hostAvatarId: host?.avatarId || null,
        hostAvatarVariantId: host?.avatarVariantId || null,
        hostHasPlayPass: !!host?.hasPlayPass,
        hostHasLegionBadge: !!host?.hasLegionBadge,
        seats: players.slice(0, 10).map((p) => ({
          avatarId: p.avatarId || null,
          avatarVariantId: p.avatarVariantId || null,
          hasPlayPass: !!p.hasPlayPass,
          isHost: !!p.isHost,
        })),
      };
    });
  res.json({ rooms: openRooms });
});

// [NEW FEATURE - PRE-PAYMENT PAUSE CHECK] Public (no admin auth) - the
// game client calls this BEFORE triggering any wallet transaction on
// the Create Pool / Create Paid / Participate buttons, so a pause set
// by the admin blocks things before money ever moves, not just after
// (the createRoom socket handler below still also enforces this
// server-side as the real backstop - this endpoint only exists to give
// the player an honest message up front instead of a wasted signed
// transaction). Also used by the Lobby/Pool-details screen to show a
// non-blocking warning when opening an already-live room during a
// pause - existing rooms are intentionally still joinable, since money
// already committed to them shouldn't get stuck over an unrelated
// pause.
app.get("/pools-status", async (req, res) => {
  try {
    const poolsPaused = await getPoolsPaused();
    res.json({ poolsPaused });
  } catch (err) {
    // Fail open (report "not paused") rather than block every player
    // from playing Pool/Paid games just because this one status check
    // had a hiccup - the real server-side enforcement in createRoom
    // still applies no matter what this endpoint says.
    res.json({ poolsPaused: false });
  }
});

// [NEW FEATURE - HOME SCREEN LIVE ROOMS WINDOW] Same idea as
// /rooms/public above, but combined across ALL room types (Free, Pool,
// Paid) in one call - the new Home screen window shows all three
// together instead of just Free Play. Private rooms are deliberately
// excluded here (same as /rooms/public always was) - they're only ever
// reachable by someone who already has the code, via the new
// requestJoinRoom flow, never by browsing this list.
// [POOL v2] Everything this player hosted or joined - Real-NEAR pools
// (with winners + paid status) and Testnet auto-payout pools.
app.get("/pools/history", async (req, res) => {
  try {
    const account = await resolveAccountFromToken(req.query.sessionToken);
    if (!account) return res.status(401).json({ message: "Sign in to see your pool history." });
    const me = String(account.accountId);
    const [hostedManual, joinedManual, chainPools] = await Promise.all([
      ManualPool.find({ hostAccountId: me }).sort({ createdAt: -1 }).limit(50).lean(),
      ManualPool.find({ "players.accountId": me, hostAccountId: { $ne: me } }).sort({ createdAt: -1 }).limit(50).lean(),
      PoolRecord.find({ $or: [{ hostAccountId: me }, { participantAccountIds: me }] }).sort({ createdAt: -1 }).limit(50).lean().catch(() => []),
    ]);
    const manualItem = (m, hosted) => {
      const mine = (m.winners || []).find((w) => w.accountId === me);
      const paid = (m.winners || []).filter((w) => w.paidAt).length;
      return {
        id: m.poolId, kind: "manual", hosted, name: m.poolName || "Pool game", roomCode: m.roomCode,
        prizeNear: m.prizeNear, split: m.split, maxMatches: m.maxMatches, state: m.state,
        players: (m.players || []).length, createdAt: m.createdAt, finishedAt: m.finishedAt || null,
        winners: hosted ? (m.winners || []) : (m.winners || []).map((w) => ({ rank: w.rank, name: w.name, amountNear: w.amountNear, paid: !!w.paidAt })),
        paidCount: paid, myRank: mine ? mine.rank : null, myPrize: mine ? mine.amountNear : null, myPaid: mine ? !!mine.paidAt : null,
      };
    };
    const chainItem = (r) => {
      const mine = (r.winners || []).find((w) => w.accountId === me);
      const paidPlayers = (r.onChainParticipantAccountIds || []).length;
      return {
        id: `chain_${r.onChainPoolId}`, kind: "auto", paid: !r.hostFunded, hosted: r.hostAccountId === me, name: r.poolName || (r.hostFunded ? "Pool game" : "Paid Game"),
        roomCode: r.roomCode || null, onChainPoolId: r.onChainPoolId,
        entryFeeNear: r.entryFeeNear || 0,
        prizeNear: r.hostFunded ? r.entryFeeNear : (r.entryFeeNear || 0) * (paidPlayers || 1),
        potNear: r.hostFunded ? Math.round((r.entryFeeNear || 0) * 0.95 * 1000) / 1000 : Math.round((r.entryFeeNear || 0) * paidPlayers * 0.95 * 1000) / 1000,
        maxMatches: r.maxMatches, matchesPlayed: r.matchesPlayed || 0, state: r.state,
        players: paidPlayers || (r.participantAccountIds || []).length, createdAt: r.createdAt, finishedAt: r.settledAt || null,
        winners: (r.winners || []).map((w) => ({ rank: w.rank, name: w.name, avatarId: w.avatarId, points: w.points, amountNear: w.amountNear, me: w.accountId === me })),
        standings: (Array.isArray(r.standings) ? r.standings : []).map((e) => ({ name: e.name, avatarId: e.avatarId, matches: e.matches, total: e.total, me: e.accountId === me })),
        payoutTxHash: r.payoutTxHash || null,
        myRank: mine ? mine.rank : null, myPrize: mine ? mine.amountNear : null,
        iPaidIn: (r.onChainParticipantAccountIds || []).includes(me),
      };
    };
    const hosted = [...hostedManual.map((m) => manualItem(m, true)), ...chainPools.filter((r) => r.hostAccountId === me).map(chainItem)]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const joined = [...joinedManual.map((m) => manualItem(m, false)), ...chainPools.filter((r) => r.hostAccountId !== me).map(chainItem)]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ hosted, joined });
  } catch (e) {
    console.error("[POOL HISTORY]", e.message);
    res.status(500).json({ message: "Couldn't load your pool history." });
  }
});

// [POOL v2] Host ticks a Real-NEAR winner off as paid - the winner gets an Inbox message.
app.post("/pools/manual/:poolId/paid", async (req, res) => {
  try {
    const account = await resolveAccountFromToken(req.body && req.body.sessionToken);
    if (!account) return res.status(401).json({ message: "Sign in again." });
    const m = await ManualPool.findOne({ poolId: String(req.params.poolId) });
    if (!m || m.hostAccountId !== String(account.accountId)) return res.status(404).json({ message: "Pool not found." });
    const rank = parseInt(req.body.rank, 10);
    const w = (m.winners || []).find((x) => x.rank === rank);
    if (!w) return res.status(400).json({ message: "No winner at that rank." });
    const txNote = String(req.body.txHash || "").trim().slice(0, 120);
    // [FUNDS SAFETY] If the host gives a transaction hash, check it on
    // mainnet: it must have succeeded, sent NEAR to this winner's wallet,
    // and be at least the prize. Unverified marks are labelled as such -
    // we never tell a winner "verified" on the host's word alone.
    let verified = false;
    // one transaction can only ever prove one prize
    const reused = txNote ? await ManualPool.findOne({ winners: { $elemMatch: { txHash: txNote } } }, "poolId").lean() : null;
    if (reused && !(reused.poolId === m.poolId && w.txHash === txNote)) {
      return res.status(409).json({ message: "That transaction was already used for another prize." });
    }
    if (txNote && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(txNote) && w.wallet) {
      const host = await Player.findById(account.accountId, "payoutWallet playPassPayerWallet walletAddress").lean();
      const senders = [...new Set([req.body.fromWallet, host && host.payoutWallet, host && host.playPassPayerWallet, host && host.walletAddress]
        .filter(Boolean).map((x) => String(x).trim().toLowerCase()))];
      const nearAPI = await loadNearAPI();
      for (const from of senders) {
        const tx = await readMainnetTransfer(txNote, from);
        if (!tx.ok) continue;
        const minYocto = BigInt(nearAPI.nearToYocto(String(w.amountNear))) * 999n / 1000n;
        verified = tx.succeeded && tx.receiver === w.wallet && tx.yocto >= minYocto;
        break;
      }
    }
    if (!w.paidAt || (verified && !w.verifiedAt)) {
      if (!w.paidAt) w.paidAt = new Date();
      if (verified) { w.verifiedAt = new Date(); w.txHash = txNote; }
      m.markModified("winners");
      await m.save();
      sendInboxMessage(w.accountId, {
        title: `Your prize was sent · ${m.poolName || "Pool game"}`,
        body: verified
          ? `Your #${w.rank} prize of ${w.amountNear} NEAR was sent to ${w.wallet} - verified on the NEAR blockchain. Transaction: ${txNote}`
          : `The host marked your #${w.rank} prize of ${w.amountNear} NEAR as sent to ${w.wallet || "your wallet"}. We couldn't verify it on-chain yet - check your wallet, and report it from Inbox if nothing arrived.${txNote ? ` Transaction given: ${txNote}` : ""}`,
        nameTag: "Pool Games",
      }).catch(() => {});
    }
    res.json({ ok: true, verified, winners: m.winners });
  } catch (e) {
    res.status(500).json({ message: "Couldn't update that winner." });
  }
});

// [POOL v2] A player in a Real-NEAR pool lobby adds / changes their prize wallet.
app.post("/pools/payout-wallet", async (req, res) => {
  try {
    const account = await resolveAccountFromToken(req.body && req.body.sessionToken);
    if (!account) return res.status(401).json({ message: "Sign in again." });
    const w = cleanPayoutWallet(req.body.wallet);
    if (!w) return res.status(400).json({ message: "That doesn't look like a mainnet NEAR address (name.near, name.tg …)." });
    await Player.updateOne({ _id: account.accountId }, { $set: { payoutWallet: w } });
    const activeCode = findActiveRoomForAccount(account.accountId);
    const room = activeCode ? rooms[activeCode] : null;
    if (room && room.pool && room.pool.mode === "manual") {
      setPoolWallet(room.pool, account.accountId, w);
      saveManualPool(room.pool, { players: manualPoolPlayers(room) });
      io.to(room.code).emit("poolUpdated", { pool: room.pool });
    }
    res.json({ ok: true, wallet: w });
  } catch (e) {
    res.status(500).json({ message: "Couldn't save that wallet." });
  }
});

// [TESTNET GIFT] One-time 1 test NEAR for an existing in-game wallet that's
// (nearly) empty - wallets made before the gift existed only ever got the
// 0.05 that account creation uses up. Testnet only, once per player.
app.post("/wallet/testnet-topup", async (req, res) => {
  try {
    if (NEAR_NETWORK !== "testnet") return res.json({ sent: false, reason: "not testnet" });
    const player = await Player.findOne({ sessionToken: String((req.body && req.body.sessionToken) || ""), verified: true });
    if (!player) return res.status(401).json({ message: "Not logged in." });
    if (player.walletType !== "ingame" || !player.walletAddress) return res.json({ sent: false, reason: "no in-game wallet" });
    if (player.testnetTopupAt) return res.json({ sent: false, reason: "already topped up" });
    const nearAPI = await loadNearAPI();
    const provider = new nearAPI.JsonRpcProvider({ url: NEAR_RPC_URL });
    const view = await provider.viewAccount({ accountId: player.walletAddress }).catch(() => null);
    if (!view) return res.json({ sent: false, reason: "wallet not found on-chain" });
    if (BigInt(view.amount) >= BigInt(nearAPI.nearToYocto("0.5"))) return res.json({ sent: false, reason: "has enough" });
    // claim the one-time slot first so two quick calls can't both send
    const claimed = await Player.updateOne({ _id: player._id, testnetTopupAt: null }, { $set: { testnetTopupAt: new Date() } });
    if (!claimed.modifiedCount) return res.json({ sent: false, reason: "already topped up" });
    const gift = await giftTestnetNear(player.walletAddress);
    if (!gift.sent) await Player.updateOne({ _id: player._id }, { $set: { testnetTopupAt: null } }); // let them try again later
    res.json(gift);
  } catch (e) {
    console.error("[TESTNET GIFT] topup error:", e.message);
    res.status(500).json({ sent: false, message: "Couldn't top up right now." });
  }
});

app.get("/rooms/live", (req, res) => {
  const openRooms = Object.values(rooms)
    .filter((r) => r.isPublic && !r.gameStarted)
    .map((r) => {
      const host = Object.values(r.players).find((p) => p.isHost);
      const base = {
        code: r.code,
        playerCount: Object.keys(r.players).length,
        hostUsername: host?.accountUsername || null,
        hostName: host?.name || "Host",
        hostHasLegionBadge: !!host?.hasLegionBadge,
      };
      if (r.pool) {
        // [BUG FIX - LIVE ROOMS WINDOW SHOWED "PAID" FOR AN ACTUAL POOL
        // GAME] entryFeeNear is set (and nonzero) for BOTH room types -
        // for a Pool game it's the total amount the HOST committed, for
        // a Paid game it's the per-player fee - so "entryFeeNear > 0"
        // was true for both and told you nothing about which one this
        // actually is. hostFunded is the real, only correct signal
        // (same field the in-Lobby POOL/PAID badge and every other
        // pool/paid distinction in the app already uses).
        const numPlayers = Object.keys(r.players).length;
        return {
          ...base,
          category: r.pool.hostFunded ? "pool" : "paid",
          name: r.pool.poolName || "Pool Game",
          entryFeeNear: r.pool.entryFeeNear || 0,
          // [BUG FIX] Same reasoning - a Pool game's total prize IS
          // entryFeeNear (the host already committed that whole
          // amount up front), not entryFeeNear times playerCount. Only
          // a Paid game's total actually scales with how many players
          // have joined.
          poolSizeNear: r.pool.hostFunded ? (r.pool.entryFeeNear || 0) : (r.pool.entryFeeNear || 0) * numPlayers,
          hostFunded: !!r.pool.hostFunded,
          // [POOL v2] what a player needs to decide before joining
          payout: r.pool.mode === "manual" ? "manual" : "auto",
          split: r.pool.mode === "manual" ? r.pool.split : [50, 30, 20],
          maxMatches: r.pool.maxMatches || 1,
          hostRole: r.pool.hostRole || "play",
          seats: Object.values(r.players).filter((p) => !p.spectator).length,
          ...(() => { const ph = Object.values(r.players).find((p) => p.accountId === r.pool.hostAccountId); return { poolHostName: ph?.name || null, poolHostUsername: ph?.accountUsername || null }; })(),
        };
      }
      return {
        ...base,
        category: "free",
        name: r.freeName || "",
        matchLimit: r.matchLimit ?? null,
        matchesPlayed: r.matchesPlayed || 0,
      };
    });
  res.json({ rooms: openRooms });
});

// [NEW FEATURE - HOME SCREEN LIVE ROOMS WINDOW] Looks a room code up
// WITHOUT joining it - the new Home window uses this first to decide
// how "Enter Room Code" should behave: direct join (public, free),
// direct wallet participate() (public, pool/paid - no approval needed,
// same as tapping it in the live list), or send a join REQUEST to the
// host (private). Never exposes anything about a room beyond what's
// needed to make that one decision.
app.get("/rooms/check/:code", async (req, res) => {
  const roomCode = String(req.params.code || "").toUpperCase().trim();
  const room = rooms[roomCode];
  if (!room) return res.json({ found: false });
  // [BUG FIX - COULDN'T RE-ENTER A PRIVATE POOL/PAID ROOM AFTER
  // LEAVING] A returning participant re-entering via code was always
  // routed through requestJoinRoom (a fresh host-approval request) and
  // then, once approved, through participate() again - which the
  // contract correctly rejects since they already paid, and which also
  // needlessly bothers the host for someone who was already let in
  // once. The existing "Enter" button (from My Pools) never had this
  // problem because it skips straight to enterPool - this makes code
  // entry do the exact same check, so the frontend can route a genuine
  // returning participant straight back in too, no new request or
  // payment involved.
  let alreadyParticipant = false;
  if (room.pool) {
    const account = await resolveAccountFromToken(req.query.sessionToken);
    if (account) {
      alreadyParticipant =
        (room.pool.participantAccountIds || []).includes(account.accountId) ||
        account.accountId === room.pool.hostAccountId;
    }
  }
  res.json({
    found: true,
    isPublic: !!room.isPublic,
    gameStarted: !!room.gameStarted,
    full: Object.keys(room.players).length >= 10,
    pool: room.pool
      ? {
          onChainPoolId: room.pool.onChainPoolId,
          poolName: room.pool.poolName || "Pool Game",
          entryFeeNear: room.pool.entryFeeNear || 0,
          hostFunded: !!room.pool.hostFunded,
          alreadyParticipant,
          // [POOL v2]
          roomCode,
          payout: room.pool.mode === "manual" ? "manual" : "auto",
          prizeNear: room.pool.mode === "manual" ? room.pool.prizeNear : room.pool.entryFeeNear,
          split: room.pool.mode === "manual" ? room.pool.split : [50, 30, 20],
          maxMatches: room.pool.maxMatches,
          hostRole: room.pool.hostRole || "play",
          isPublic: !!room.isPublic,
          seats: Object.values(room.players).filter((p) => !p.spectator).length,
          poolHostName: (Object.values(room.players).find((p) => p.accountId === room.pool.hostAccountId) || {}).name || null,
        }
      : null,
  });
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
      // [POOL v2]
      roomCode: r.code,
      payout: r.pool.mode === "manual" ? "manual" : "auto",
      prizeNear: r.pool.mode === "manual" ? r.pool.prizeNear : r.pool.entryFeeNear,
      split: r.pool.mode === "manual" ? r.pool.split : [50, 30, 20],
      hostRole: r.pool.hostRole || "play",
      isPublic: !!r.isPublic,
      seats: Object.values(r.players).filter((p) => !p.spectator).length,
      poolHostName: (Object.values(r.players).find((p) => p.accountId === r.pool.hostAccountId) || {}).name || null,
      poolHostUsername: (Object.values(r.players).find((p) => p.accountId === r.pool.hostAccountId) || {}).accountUsername || null,
    });

    const allPoolRooms = Object.values(rooms).filter((r) => r.pool);

    const myPools = accountId
      ? allPoolRooms.filter((r) => r.pool.participantAccountIds.includes(accountId) || r.pool.hostAccountId === accountId).map(summarize)
      : [];

    const publicPools = allPoolRooms
      .filter((r) => r.isPublic && r.pool.state === "Open")
      .filter((r) => !accountId || (!r.pool.participantAccountIds.includes(accountId) && r.pool.hostAccountId !== accountId))
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
        title: a.title, body: a.body, nameTag: a.nameTag || "NEAR Saboteur", imageUrl: a.imageUrl || null, createdAt: a.createdAt,
      })),
    });
  } catch (err) {
    console.error("[Auth] /announcements error:", err.message);
    res.json({ announcements: [] }); // never blocks the Home screen from loading
  }
});

// [NEW FEATURE - PLAYER INBOX] A player's own messages - manual (admin
// dashboard) or automatic (pool win, future premium purchase). Session-
// gated the same way every other player-identity endpoint in this file
// is (sessionToken query param, same as /activity/games).
app.get("/inbox", async (req, res) => {
  try {
    const sessionToken = String(req.query.sessionToken || "").trim();
    if (!sessionToken) return res.status(401).json({ message: "Not logged in." });
    const me = await Player.findOne({ sessionToken });
    if (!me || !me.sessionTokenExpiresAt || me.sessionTokenExpiresAt.getTime() < Date.now()) {
      return res.status(401).json({ message: "Session expired. Please log in again." });
    }
    const messages = await InboxMessage.find({ playerId: me._id }).sort({ createdAt: -1 }).limit(50);
    res.json({ messages });
  } catch (err) {
    console.error("[INBOX] /inbox error:", err.message);
    res.status(500).json({ message: "Could not load your inbox." });
  }
});
app.post("/inbox/:id/read", async (req, res) => {
  try {
    const sessionToken = String(req.body.sessionToken || "").trim();
    if (!sessionToken) return res.status(401).json({ message: "Not logged in." });
    const me = await Player.findOne({ sessionToken });
    if (!me) return res.status(401).json({ message: "Not logged in." });
    // Scoped to this player's own id too - never lets a session mark
    // someone ELSE's message as read via a guessed id.
    await InboxMessage.updateOne({ _id: req.params.id, playerId: me._id }, { read: true });
    res.json({ success: true });
  } catch (err) {
    console.error("[INBOX] mark-read error:", err.message);
    res.status(500).json({ message: "Could not update that message." });
  }
});
// [NEW FEATURE - PLAYER-SIDE INBOX DELETE] Lets a player clear a
// notification from their own inbox. Deliberately a real delete (not
// just a "hidden" flag) - once a player's dismissed their own copy of
// a notification, there's no reason to keep it around just for them;
// the admin's own /admin/inbox/:id delete route is separate and
// unaffected, since this only ever touches this player's own message.
app.delete("/inbox/:id", async (req, res) => {
  try {
    const sessionToken = String(req.body.sessionToken || req.query.sessionToken || "").trim();
    if (!sessionToken) return res.status(401).json({ message: "Not logged in." });
    const me = await Player.findOne({ sessionToken });
    if (!me) return res.status(401).json({ message: "Not logged in." });
    // Scoped to this player's own id, same reasoning as mark-read above -
    // never lets a session delete someone ELSE's message via a guessed id.
    await InboxMessage.deleteOne({ _id: req.params.id, playerId: me._id });
    res.json({ success: true });
  } catch (err) {
    console.error("[INBOX] player delete error:", err.message);
    res.status(500).json({ message: "Could not delete that message." });
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
// [NEW FEATURE - READ-ONLY ADMIN ACCESS] A second, separate credential
// set for someone Om7eth wants to give visibility to without any
// ability to act - view-only. Optional; if unset, only the full-access
// login above works.
const VIEWER_ADMIN_USERNAME = process.env.VIEWER_ADMIN_USERNAME || "";
const VIEWER_ADMIN_PASSWORD = process.env.VIEWER_ADMIN_PASSWORD || "";
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
  // [NEW FEATURE - READ-ONLY ADMIN ACCESS] 'full' | 'viewer' - decided
  // once at login time from which credential set matched, never
  // trusted from the client afterward.
  role: { type: String, enum: ["full", "viewer"], default: "full" },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
});
const AdminSession = mongoose.model("AdminSession", adminSessionSchema);
const ADMIN_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, same as a player's session

// [NEW FEATURE - ADMIN ACTION LOG] Every mutating admin action, who (by
// role, since both logins currently share one set of credentials per
// role rather than individual named accounts) and what changed -
// separate from the game's own MatchRecord/PoolRecord history, this is
// specifically an audit trail of ADMIN decisions (holds, premium
// grants, deleted messages, manual pool resolutions, etc).
const adminActionLogSchema = new mongoose.Schema({
  action: { type: String, required: true },
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now, index: true },
});
const AdminActionLog = mongoose.model("AdminActionLog", adminActionLogSchema);
function logAdminAction(action, details = {}) {
  if (!MONGODB_URI) return;
  AdminActionLog.create({ action, details }).catch((e) => console.error("[ADMIN LOG] failed:", e.message));
}

// [NEW FEATURE - EMERGENCY PAUSE] A single persisted settings doc -
// right now just the one flag, but a natural place to add more
// platform-wide switches later without another schema migration.
const appSettingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed },
});
const AppSettings = mongoose.model("AppSettings", appSettingsSchema);
let poolsPausedCache = false; // in-memory mirror, refreshed on read/write - avoids a DB round-trip on every single createRoom call
async function getPoolsPaused() {
  try {
    const doc = await AppSettings.findOne({ key: "poolsPaused" });
    poolsPausedCache = !!(doc && doc.value);
  } catch (e) { /* leave cache as-is on a DB hiccup - fail open rather than block the whole platform over a read error */ }
  return poolsPausedCache;
}

// [NEW FEATURE - PLAY PASS] Same AppSettings key-value doc pattern as
// poolsPaused above - one row (key: "playPassConfig"), lets Om7eth
// change price/discount/on-off from the admin dashboard without ever
// touching code or redeploying. Cached in-memory the same way, since
// every purchase attempt and every Home-screen load will read this.
// [NEW FEATURE - PLAY PASS SKIN UNLOCK PROGRESSION] unlockGamesGap =
// how many games a player must play (after the previous unlock) before
// their next premium skin unlocks - admin-adjustable, see
// /admin/play-pass/config below. The first skin unlocks immediately on
// purchase (gap 0 for step 1), every subsequent skin costs one gap.
const PLAY_PASS_DEFAULT_CONFIG = { priceNear: 1, discountPercent: 0, enabled: true, unlockGamesGap: 2 };
// [PLAY PASS - REAL NEAR] Play Pass is paid in real NEAR on mainnet, straight
// from the player's own wallet (HOT / Meteor / Intear - they approve it in
// their wallet; the game never sees a key) to the game's official wallet.
// The server only RECEIVES here - no key for this account lives on the server.
const PLAY_PASS_MAINNET_RECEIVER = process.env.PLAY_PASS_MAINNET_RECEIVER || "saboteur.near";
const MAINNET_RPC_URLS = ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"];
const playPassPurchaseSchema = new mongoose.Schema({
  playerId: { type: String, index: true },
  playerName: String,
  payerAccountId: String,                              // the player's mainnet wallet that paid
  txHash: { type: String, unique: true, index: true }, // one transaction can only ever be used once
  amountNear: Number,                                  // what actually arrived
  priceNear: Number,                                   // the price at that moment
  status: { type: String, enum: ["granted", "needs_refund", "refunded"], index: true },
  reason: String,                                      // why a refund is owed
  refundTxHash: String,
  refundedAt: Date,
  createdAt: { type: Date, default: Date.now, index: true },
});
const PlayPassPurchase = mongoose.models.PlayPassPurchase || mongoose.model("PlayPassPurchase", playPassPurchaseSchema);
// Reads a mainnet transaction and reports exactly what it did. Never trusts the client.
async function readMainnetTransfer(txHash, payerAccountId) {
  let lastErr = "Could not reach the NEAR network.";
  for (const rpcUrl of MAINNET_RPC_URLS) {
    try {
      const r = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        jsonrpc: "2.0", id: "pp", method: "tx", params: { tx_hash: txHash, sender_account_id: payerAccountId, wait_until: "FINAL" },
      }) });
      const j = await r.json();
      if (j.error) { lastErr = j.error.cause?.name === "UNKNOWN_TRANSACTION" ? "That transaction isn't on mainnet (yet). Wait a few seconds and try again." : (j.error.message || "RPC error"); continue; }
      const res = j.result;
      const st = res?.status || {};
      const succeeded = Object.prototype.hasOwnProperty.call(st, "SuccessValue") || Object.prototype.hasOwnProperty.call(st, "SuccessReceiptId");
      const tx = res?.transaction || {};
      // every Transfer action counts (a wallet may split one payment); nothing else does
      const yocto = (tx.actions || []).filter((a) => a && a.Transfer).reduce((sum, a) => sum + BigInt(a.Transfer.deposit || "0"), 0n);
      return { ok: true, succeeded, signer: tx.signer_id, receiver: tx.receiver_id, yocto };
    } catch (e) { lastErr = e.message; }
  }
  return { ok: false, error: lastErr };
}
let playPassConfigCache = { ...PLAY_PASS_DEFAULT_CONFIG };
async function getPlayPassConfig() {
  try {
    const doc = await AppSettings.findOne({ key: "playPassConfig" });
    if (doc && doc.value) playPassConfigCache = { ...PLAY_PASS_DEFAULT_CONFIG, ...doc.value };
  } catch (e) { /* fail open with last-known cache, same reasoning as getPoolsPaused */ }
  return playPassConfigCache;
}
async function setPlayPassConfig(patch) {
  const current = await getPlayPassConfig();
  const next = { ...current, ...patch };
  await AppSettings.updateOne({ key: "playPassConfig" }, { $set: { value: next } }, { upsert: true });
  playPassConfigCache = next;
  return next;
}

// [NEW FEATURE - CUSTOM AVATAR REQUEST] Same AppSettings key-value
// pattern again - price, the support Telegram link, and on/off, all
// admin-adjustable without a redeploy. telegramLink and priceNear start
// blank/0 on purpose - Om7eth fills these in himself from the admin
// dashboard before turning it on, rather than shipping a guessed price
// or a placeholder link that could get tapped for real.
const CUSTOM_AVATAR_REQUEST_DEFAULT_CONFIG = { priceNear: 0, telegramLink: "", enabled: false };
let customAvatarRequestConfigCache = { ...CUSTOM_AVATAR_REQUEST_DEFAULT_CONFIG };
async function getCustomAvatarRequestConfig() {
  try {
    const doc = await AppSettings.findOne({ key: "customAvatarRequestConfig" });
    if (doc && doc.value) customAvatarRequestConfigCache = { ...CUSTOM_AVATAR_REQUEST_DEFAULT_CONFIG, ...doc.value };
  } catch (e) { /* fail open with last-known cache */ }
  return customAvatarRequestConfigCache;
}
async function setCustomAvatarRequestConfig(patch) {
  const current = await getCustomAvatarRequestConfig();
  const next = { ...current, ...patch };
  await AppSettings.updateOne({ key: "customAvatarRequestConfig" }, { $set: { value: next } }, { upsert: true });
  customAvatarRequestConfigCache = next;
  return next;
}

// [NEW FEATURE - CUSTOM AVATAR REQUEST] One document per request. The
// reference image is stored as base64 directly on the document (capped
// at 1MB by MAX_CUSTOM_AVATAR_IMAGE_BYTES below, well under Mongo's
// 16MB doc limit) rather than on disk - Render's filesystem is
// ephemeral (wiped on every redeploy/restart), so anything meant to
// survive has to live in MongoDB Atlas like everything else here.
// pricePaidNear/paymentTxHash are stamped at submit time, verified the
// same way a Play Pass purchase is (see verifyPlayPassTransfer) -
// never trust a client-reported "I paid" without checking the chain.
const customAvatarRequestSchema = new mongoose.Schema({
  playerId: { type: mongoose.Schema.Types.ObjectId, ref: "Player", required: true },
  playerName: { type: String, default: "" },
  walletAddress: { type: String, default: "" },
  telegramUsername: { type: String, default: "" },
  description: { type: String, default: "" },
  imageBase64: { type: String, default: null },
  imageMimeType: { type: String, default: null },
  pricePaidNear: { type: Number, default: 0 },
  paymentTxHash: { type: String, default: null },
  status: { type: String, enum: ["submitted", "replied"], default: "submitted" },
  adminReply: { type: String, default: null },
  adminRepliedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});
const CustomAvatarRequest = mongoose.model("CustomAvatarRequest", customAvatarRequestSchema);
const MAX_CUSTOM_AVATAR_IMAGE_BYTES = 1 * 1024 * 1024; // 1MB, per Om7eth's spec
// [NEW FEATURE - PLAY PASS] Effective price after any active discount -
// shared by the player-facing config endpoint and the purchase
// verification below, so they can never disagree about what the
// player was actually supposed to pay.
function effectivePlayPassPriceNear(config) {
  const discount = Math.max(0, Math.min(100, Number(config.discountPercent) || 0));
  const price = Number(config.priceNear) || PLAY_PASS_DEFAULT_CONFIG.priceNear;
  return +(price * (1 - discount / 100)).toFixed(4);
}

// [NEW FEATURE - PLAY PASS - PAYMENT SECURITY] Independently verifies a
// Play Pass purchase transfer against the NEAR RPC itself, same "never
// trust the client" principle as the pool payment audit - the client
// only ever sends a txHash, never a claim of success. Confirms: the
// transaction actually succeeded on-chain, was signed by the player's
// own custodial wallet, sent TO the platform's receiving account, and
// transferred at least the currently-effective price. A too-small or
// wrong-direction transfer is rejected even if the tx itself succeeded
// (e.g. a player accidentally/maliciously sending 0.001 NEAR).
// [BUG FIX - RELIABILITY] Two real testnet failures in a row, both
// version-mismatch issues with near-api-js's own Provider class
// (utils.format.parseNearAmount not existing, then provider.txStatus
// not existing either on whatever version is actually installed here) -
// rather than guess at a THIRD SDK method that might also not exist on
// this install, this calls the NEAR RPC's "tx" method directly via a
// raw fetch, exactly the same proven pattern checkLegionInitiateSbt
// above already uses successfully in production. This makes the check
// entirely independent of near-api-js's Provider API surface - it can
// never break again just because a dependency version changed
// something. Falls back to a second, independently-run RPC provider
// (FastNear's public endpoint) if the first one fails for ANY reason
// (timeout, rate limit, temporary outage) - a single RPC provider
// having a bad moment should never be the reason a genuine,
// already-confirmed on-chain payment gets rejected.
const TX_VERIFY_RPC_URLS = [
  NEAR_RPC_URL,
  NEAR_NETWORK === "testnet" ? "https://test.rpc.fastnear.com" : "https://free.rpc.fastnear.com",
];
async function verifyPlayPassTransfer(txHash, fromAccountId, minAmountYocto) {
  if (!txHash || !fromAccountId) return { ok: false, error: "Missing transaction details." };
  let lastErr = null;
  for (const rpcUrl of TX_VERIFY_RPC_URLS) {
    try {
      const rpcRes = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: "play-pass-verify", method: "tx",
          params: { tx_hash: txHash, sender_account_id: fromAccountId, wait_until: "EXECUTED_OPTIMISTIC" },
        }),
      });
      const rpcData = await rpcRes.json();
      if (rpcData.error) {
        lastErr = new Error(rpcData.error.message || rpcData.error.cause?.name || "RPC error");
        console.error(`[PLAY PASS] verifyPlayPassTransfer via ${rpcUrl} - RPC returned an error for txHash ${txHash}:`, JSON.stringify(rpcData.error));
        continue;
      }
      const result = rpcData.result;
      const successValue = result?.status && Object.prototype.hasOwnProperty.call(result.status, "SuccessValue");
      const successReceipt = result?.status && Object.prototype.hasOwnProperty.call(result.status, "SuccessReceiptId");
      if (!successValue && !successReceipt) return { ok: false, error: "Transaction did not succeed on-chain." };
      if (result?.transaction?.signer_id !== fromAccountId) return { ok: false, error: "Transaction was not signed by this player's wallet." };
      if (result?.transaction?.receiver_id !== PLAY_PASS_RECEIVING_ACCOUNT_ID) return { ok: false, error: "Transaction did not go to the Play Pass account." };
      const actions = result?.transaction?.actions || [];
      const transferAction = actions.find((a) => a && a.Transfer);
      const transferredYocto = transferAction ? BigInt(transferAction.Transfer.deposit || "0") : 0n;
      if (transferredYocto < BigInt(minAmountYocto)) return { ok: false, error: "Transferred amount was less than the Play Pass price." };
      return { ok: true };
    } catch (err) {
      lastErr = err;
      console.error(`[PLAY PASS] verifyPlayPassTransfer via ${rpcUrl} failed for txHash ${txHash}:`, err?.message, "\n", err?.stack);
      // try the next RPC endpoint in the fallback list
    }
  }
  console.error("[PLAY PASS] verifyPlayPassTransfer: all RPC endpoints failed for txHash", txHash, "- last error:", lastErr?.message);
  return { ok: false, error: "Could not verify this transaction. Please try again in a moment." };
}

// [BUG FIX] admin searches went into $regex unescaped
function rxSafe(t) { return String(t || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function generateAdminToken() {
  // [SECURITY FIX] was Math.random() - guessable. 32 random bytes now.
  return "adm_" + crypto.randomBytes(32).toString("hex");
}
// [SECURITY FIX] Admin login: constant-time password check + lockout after
// 5 wrong tries from one address for 15 minutes.
const adminLoginFails = new Map(); // ip -> { n, until }
function safeEqual(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
async function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  // [NEW FEATURE - CUSTOM AVATAR REQUEST IMAGES] A plain <img src> tag
  // can't send an Authorization header, so the admin dashboard's image/
  // download links pass the token as a query param instead - still the
  // same real session token, just carried a different way. Every other
  // admin route keeps using the header as normal; this is purely an
  // additional accepted source, not a weaker check.
  const token = (auth.startsWith("Bearer ") ? auth.slice(7) : "") || String(req.query.token || "");
  if (!token) return res.status(401).json({ message: "Not logged in." });
  if (!MONGODB_URI) return res.status(503).json({ message: "Admin dashboard is not configured on this server." });
  try {
    const session = await AdminSession.findOne({ token });
    if (!session || session.expiresAt.getTime() < Date.now()) {
      return res.status(401).json({ message: "Not logged in." });
    }
    req.adminRole = session.role || "full";
    next();
  } catch (e) {
    console.error("[ADMIN] requireAdmin lookup failed:", e.message);
    res.status(500).json({ message: "Server error checking your session." });
  }
}
// [NEW FEATURE - READ-ONLY ADMIN ACCESS] Chained AFTER requireAdmin (so
// req.adminRole is already set) - blocks every mutating route for a
// viewer-role session. GET routes never use this at all, so a viewer
// can still see everything.
function requireFullAdmin(req, res, next) {
  if (req.adminRole !== "full") {
    return res.status(403).json({ message: "View-only access - this action isn't available to you." });
  }
  next();
}

app.post("/admin/login", async (req, res) => {
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
    return res.status(503).json({ message: "Admin dashboard is not configured on this server." });
  }
  const { username, password } = req.body || {};
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const fail = adminLoginFails.get(ip);
  if (fail && fail.until > Date.now()) {
    return res.status(429).json({ message: `Too many wrong tries. Try again in ${Math.ceil((fail.until - Date.now()) / 60000)} min.` });
  }
  let role = null;
  if (safeEqual(username, ADMIN_USERNAME) && safeEqual(password, ADMIN_PASSWORD)) role = "full";
  else if (VIEWER_ADMIN_USERNAME && safeEqual(username, VIEWER_ADMIN_USERNAME) && safeEqual(password, VIEWER_ADMIN_PASSWORD)) role = "viewer";
  if (!role) {
    const n = (fail && fail.until && fail.until <= Date.now() ? 0 : (fail ? fail.n : 0)) + 1;
    adminLoginFails.set(ip, { n, until: n >= 5 ? Date.now() + 15 * 60 * 1000 : 0 });
    logAdminAction("admin-login-failed", { ip, tries: n });
    return res.status(401).json({ message: n >= 5 ? "Too many wrong tries - locked for 15 minutes." : `Incorrect username or password. (${5 - n} tries left)` });
  }
  adminLoginFails.delete(ip);
  const token = generateAdminToken();
  try {
    await AdminSession.create({ token, role, expiresAt: new Date(Date.now() + ADMIN_SESSION_TTL_MS) });
    res.json({ token, role });
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
    // [NEW FEATURE - ADMIN LEADERBOARD RESET] Uses the later of the
    // natural Saturday boundary or any manual reset Om7eth triggered
    // from the admin dashboard.
    const weekStart = await getEffectiveLeaderboardStart("weekly", getCurrentWeekStartUTC());

    const rows = await MatchRecord.aggregate([
      { $match: { earnedAt: { $gte: weekStart } } },
      { $group: { _id: "$playerId", points: { $sum: "$points" } } },
      { $match: { points: { $gt: 0 } } },
      { $sort: { points: -1 } },
      { $limit: 10 },
    ]);

    const players = await Player.find(
      { _id: { $in: rows.map((r) => r._id) } },
      "name username avatarId hasLegionBadge premiumUntil activePremiumAvatarVariant"
    );
    const byId = new Map(players.map((p) => [p._id.toString(), p]));

    const leaderboard = rows
      .map((r) => {
        const p = byId.get(r._id.toString());
        if (!p) return null; // account since deleted - skip rather than show a blank row
        return { name: p.name, username: p.username, avatarId: p.avatarId, avatarVariantId: avatarVariantForPlayerDoc(p), hasPlayPass: hasPlayPassForPlayerDoc(p), hasLegionBadge: !!p.hasLegionBadge, points: r.points };
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
            name: me.name, username: me.username, avatarId: me.avatarId, avatarVariantId: avatarVariantForPlayerDoc(me), hasPlayPass: hasPlayPassForPlayerDoc(me),
            hasLegionBadge: !!me.hasLegionBadge, points: myPoints,
          };
        }
      }
    }

    res.json({ leaderboard, myRank, weekStart, nextResetAt: new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000) });
  } catch (err) {
    console.error("[LEADERBOARD] /leaderboard/weekly error:", err.message);
    res.status(500).json({ message: "Could not load the leaderboard." });
  }
});

// [NEW FEATURE - MONTHLY LEADERBOARD] Identical shape/logic to
// /leaderboard/weekly above, just scoped to the current calendar month
// (getCurrentMonthStartUTC) instead of the current week. This replaces
// the old user-facing "All-Time" tab - all-time totals still exist
// (Player.totalPoints, queried by /leaderboard/alltime) and will surface
// later on the admin dashboard instead.
app.get("/leaderboard/monthly", async (req, res) => {
  try {
    const sessionToken = String(req.query.sessionToken || "").trim();
    const monthStart = await getEffectiveLeaderboardStart("monthly", getCurrentMonthStartUTC());

    const rows = await MatchRecord.aggregate([
      { $match: { earnedAt: { $gte: monthStart } } },
      { $group: { _id: "$playerId", points: { $sum: "$points" } } },
      { $match: { points: { $gt: 0 } } },
      { $sort: { points: -1 } },
      { $limit: 10 },
    ]);

    const players = await Player.find(
      { _id: { $in: rows.map((r) => r._id) } },
      "name username avatarId hasLegionBadge premiumUntil activePremiumAvatarVariant"
    );
    const byId = new Map(players.map((p) => [p._id.toString(), p]));

    const leaderboard = rows
      .map((r) => {
        const p = byId.get(r._id.toString());
        if (!p) return null; // account since deleted - skip rather than show a blank row
        return { name: p.name, username: p.username, avatarId: p.avatarId, avatarVariantId: avatarVariantForPlayerDoc(p), hasPlayPass: hasPlayPassForPlayerDoc(p), hasLegionBadge: !!p.hasLegionBadge, points: r.points };
      })
      .filter(Boolean)
      .map((entry, i) => ({ ...entry, rank: i + 1 }));

    let myRank = null;
    if (sessionToken) {
      const me = await Player.findOne({ sessionToken });
      if (me && me.sessionTokenExpiresAt && me.sessionTokenExpiresAt.getTime() > Date.now()) {
        const myAgg = await MatchRecord.aggregate([
          { $match: { earnedAt: { $gte: monthStart }, playerId: me._id } },
          { $group: { _id: "$playerId", points: { $sum: "$points" } } },
        ]);
        const myPoints = myAgg[0]?.points || 0;
        if (myPoints > 0) {
          const higherCount = await MatchRecord.aggregate([
            { $match: { earnedAt: { $gte: monthStart } } },
            { $group: { _id: "$playerId", points: { $sum: "$points" } } },
            { $match: { points: { $gt: myPoints } } },
            { $count: "n" },
          ]);
          myRank = {
            rank: (higherCount[0]?.n || 0) + 1,
            name: me.name, username: me.username, avatarId: me.avatarId, avatarVariantId: avatarVariantForPlayerDoc(me), hasPlayPass: hasPlayPassForPlayerDoc(me),
            hasLegionBadge: !!me.hasLegionBadge, points: myPoints,
          };
        }
      }
    }

    const istShiftMs = 5.5 * 60 * 60 * 1000;
    const istMonthStart = new Date(monthStart.getTime() + istShiftMs);
    const nextMonthStart = new Date(Date.UTC(istMonthStart.getUTCFullYear(), istMonthStart.getUTCMonth() + 1, 1, 0, 0, 0, 0) - istShiftMs);
    res.json({ leaderboard, myRank, monthStart, nextResetAt: nextMonthStart });
  } catch (err) {
    console.error("[LEADERBOARD] /leaderboard/monthly error:", err.message);
    res.status(500).json({ message: "Could not load the leaderboard." });
  }
});

// [NEW FEATURE - HOME SCREEN POINTS POPUP] Everything the Points popup
// needs in one call: this week's points + a light breakdown (missions
// /wins/kills COUNTS only - not a full per-match log, that's what the
// Activity tab is for), last week's total, this player's rank among
// everyone who scored this week, their best week ever, matches played
// this week, and when the current week resets. All built the same way
// as /leaderboard/weekly - aggregated straight from MatchRecord by
// actual earnedAt timestamp, never from the lazily-reset
// Player.currentSeasonPoints field, so it's always accurate regardless
// of when this player last actually played.
app.get("/points/summary", async (req, res) => {
  try {
    const sessionToken = String(req.query.sessionToken || "").trim();
    if (!sessionToken) return res.status(400).json({ message: "Missing session." });
    const me = await Player.findOne({ sessionToken });
    if (!me || !me.sessionTokenExpiresAt || me.sessionTokenExpiresAt.getTime() <= Date.now()) {
      return res.status(401).json({ message: "Session expired." });
    }

    const weekStart = getCurrentWeekStartUTC();
    const lastWeekStart = new Date(weekStart.getTime() - 7 * 24 * 60 * 60 * 1000);
    const nextWeekStart = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);

    const [thisWeekAgg, lastWeekAgg, bestWeekAgg, higherCount] = await Promise.all([
      MatchRecord.aggregate([
        { $match: { playerId: me._id, earnedAt: { $gte: weekStart } } },
        { $group: { _id: null, points: { $sum: "$points" }, matches: { $sum: 1 }, missions: { $sum: "$missionsDone" }, wins: { $sum: { $cond: ["$won", 1, 0] } }, kills: { $sum: "$killsCount" } } },
      ]),
      MatchRecord.aggregate([
        { $match: { playerId: me._id, earnedAt: { $gte: lastWeekStart, $lt: weekStart } } },
        { $group: { _id: null, points: { $sum: "$points" } } },
      ]),
      // [APPROXIMATION] Grouped by ISO calendar week (Mon-Sun) rather
      // than the app's own Saturday-IST week boundary - close enough
      // for a fun "best week ever" stat, not worth the extra
      // aggregation complexity of matching the exact custom boundary.
      MatchRecord.aggregate([
        { $match: { playerId: me._id } },
        { $group: { _id: { y: { $isoWeekYear: "$earnedAt" }, w: { $isoWeek: "$earnedAt" } }, points: { $sum: "$points" } } },
        { $sort: { points: -1 } },
        { $limit: 1 },
      ]),
      MatchRecord.aggregate([
        { $match: { earnedAt: { $gte: weekStart }, playerId: { $ne: me._id } } },
        { $group: { _id: "$playerId", points: { $sum: "$points" } } },
        { $match: { points: { $gt: (await MatchRecord.aggregate([
          { $match: { playerId: me._id, earnedAt: { $gte: weekStart } } },
          { $group: { _id: null, points: { $sum: "$points" } } },
        ]))[0]?.points || 0 } } },
        { $count: "n" },
      ]),
    ]);

    const thisWeek = thisWeekAgg[0] || { points: 0, matches: 0, missions: 0, wins: 0, kills: 0 };
    const lastWeekPoints = lastWeekAgg[0]?.points || 0;
    const bestWeekPoints = Math.max(bestWeekAgg[0]?.points || 0, thisWeek.points);
    const weeklyRank = thisWeek.points > 0 ? (higherCount[0]?.n || 0) + 1 : null;

    res.json({
      currentWeekPoints: thisWeek.points,
      lastWeekPoints,
      bestWeekPoints,
      matchesThisWeek: thisWeek.matches,
      missionsThisWeek: thisWeek.missions,
      winsThisWeek: thisWeek.wins,
      killsThisWeek: thisWeek.kills,
      weeklyRank,
      weekResetsAt: nextWeekStart,
    });
  } catch (err) {
    console.error("[POINTS] /points/summary error:", err.message);
    res.status(500).json({ message: "Could not load your points summary." });
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
      "name username avatarId hasLegionBadge totalPoints premiumUntil activePremiumAvatarVariant"
    ).sort({ totalPoints: -1 }).limit(50);

    const leaderboard = top.map((p, i) => ({
      rank: i + 1, name: p.name, username: p.username, avatarId: p.avatarId, avatarVariantId: avatarVariantForPlayerDoc(p), hasPlayPass: hasPlayPassForPlayerDoc(p),
      hasLegionBadge: !!p.hasLegionBadge, points: p.totalPoints,
    }));

    let myRank = null;
    if (sessionToken) {
      const me = await Player.findOne({ sessionToken });
      if (me && me.sessionTokenExpiresAt && me.sessionTokenExpiresAt.getTime() > Date.now() && me.totalPoints > 0) {
        const higherCount = await Player.countDocuments({ totalPoints: { $gt: me.totalPoints } });
        myRank = {
          rank: higherCount + 1,
          name: me.name, username: me.username, avatarId: me.avatarId, avatarVariantId: avatarVariantForPlayerDoc(me), hasPlayPass: hasPlayPassForPlayerDoc(me),
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

    // Pull a generous recent batch of this player's own records - several
    // can belong to the same game (a 3-match pool, or a long Free Play
    // session) and still only count as ONE game toward the 20-game limit.
    const myRecords = await MatchRecord.find({ playerId: me._id })
      .sort({ earnedAt: -1 })
      .limit(300)
      .lean();

    // [ACTIVITY FIX] Group by roomSessionId. Older records only have a
    // (reused) roomCode - those are now also split wherever there's a
    // gap of 3h+ between matches, so two unrelated games that landed on
    // the same code are no longer merged into one card.
    const LEGACY_GAP_MS = 3 * 3600 * 1000;
    const groups = new Map(); // key -> { records: [], mostRecentAt }
    const legacyCursor = new Map(); // roomCode -> { key, oldestAt }
    for (const r of myRecords) { // newest first
      let key = r.roomSessionId;
      if (!key) {
        const cur = legacyCursor.get(r.roomCode);
        if (cur && cur.oldestAt - new Date(r.earnedAt).getTime() < LEGACY_GAP_MS) key = cur.key;
        else key = `legacy:${r.roomCode}:${new Date(r.earnedAt).getTime()}`;
        legacyCursor.set(r.roomCode, { key, oldestAt: new Date(r.earnedAt).getTime() });
      }
      if (!groups.has(key)) groups.set(key, { records: [], mostRecentAt: r.earnedAt });
      groups.get(key).records.push(r);
    }

    const orderedGroups = [...groups.entries()]
      .sort((a, b) => new Date(b[1].mostRecentAt) - new Date(a[1].mostRecentAt))
      .slice(0, 20);

    // [ACTIVITY FIX] $SABOTEUR earned per match was only visible in the
    // wallet - join it in here by matchId so each match shows its reward.
    const matchIds = [...new Set(orderedGroups.flatMap(([, g]) => g.records.map((r) => r.matchId)).filter(Boolean))];
    const tokenByMatch = new Map();
    if (matchIds.length) {
      try {
        const rows = await economy.TokenLedger.find({ holderType: "player", holderId: String(me._id), matchId: { $in: matchIds } }).lean();
        for (const t of rows) tokenByMatch.set(t.matchId, t);
      } catch (_) { /* token rewards are optional extra info */ }
    }
    const tokenInfo = (t) => (t ? {
      amount: t.amount || 0, status: t.status, rank: t.rank || null, players: t.players || null,
      txUrl: t.txHash && saboteurToken.explorerTx ? saboteurToken.explorerTx(t.txHash) : null,
    } : null);

    const modeOf = (r) => r.gameMode || (r.isPoolGame ? "pool" : "free");

    const games = [];
    for (const [groupKey, group] of orderedGroups) {
      // Chronological within the game: "Match 1, 2, 3..."
      const records = group.records.sort((a, b) => new Date(a.earnedAt) - new Date(b.earnedAt)).slice(-20);
      const first = records[0];
      const last = records[records.length - 1];
      const mode = modeOf(last);
      const isPaid = mode !== "free"; // pool/paid/sponsor all carry NEAR financials
      const displayName = last.poolName || first.poolName || last.roomCode || "Game";
      const withFinancials = records.find((r) => typeof r.entryFeeNear === "number" || typeof r.poolNearWon === "number");
      const entryFeeNear = withFinancials && typeof withFinancials.entryFeeNear === "number" ? withFinancials.entryFeeNear : null;
      const poolNearWon = withFinancials && typeof withFinancials.poolNearWon === "number" ? withFinancials.poolNearWon : null;
      const myRankRec = records.find((r) => typeof r.poolRank === "number");

      let topThree = null;
      if (isPaid && first.roomSessionId) {
        // Rank by raw (un-capped) performance, same as distributePoolPrizes.
        // [ACTIVITY FIX] When the pool actually paid out, the real payout
        // rank (poolRank) wins over the recomputed one, so this list
        // always agrees with who actually got paid.
        const allRecordsThisGame = await MatchRecord.find({ roomSessionId: first.roomSessionId }).lean();
        const byPlayer = new Map();
        for (const r of allRecordsThisGame) {
          const pid = r.playerId.toString();
          const perf = typeof r.rawPoints === "number" && r.rawPoints > 0 ? r.rawPoints : r.points;
          const e = byPlayer.get(pid) || { points: 0, nearWon: null, paidRank: null };
          e.points += perf || 0;
          if (typeof r.poolNearWon === "number" && e.nearWon == null) e.nearWon = r.poolNearWon;
          if (typeof r.poolRank === "number" && e.paidRank == null) e.paidRank = r.poolRank;
          byPlayer.set(pid, e);
        }
        const ranked = [...byPlayer.entries()].sort((a, b) => {
          const ra = a[1].paidRank ?? 99, rb = b[1].paidRank ?? 99;
          return ra !== rb ? ra - rb : b[1].points - a[1].points;
        }).slice(0, 3);
        const rankedPlayers = await Player.find(
          { _id: { $in: ranked.map(([pid]) => pid) } },
          "name username avatarId hasLegionBadge premiumUntil activePremiumAvatarVariant"
        );
        const playerById = new Map(rankedPlayers.map((p) => [p._id.toString(), p]));
        topThree = ranked.map(([pid, e], i) => {
          const p = playerById.get(pid);
          if (!p) return null;
          return {
            rank: i + 1, name: p.name, username: p.username, avatarId: p.avatarId, avatarVariantId: avatarVariantForPlayerDoc(p), hasPlayPass: hasPlayPassForPlayerDoc(p),
            hasLegionBadge: !!p.hasLegionBadge, points: e.points, nearWon: e.nearWon, isMe: pid === String(me._id),
          };
        }).filter(Boolean);
      }

      const matches = records.map((r) => ({
        matchId: r.matchId || null,
        at: r.earnedAt,
        role: r.role, won: r.won, points: r.points,
        rawPoints: r.rawPoints || r.points,
        reduced: !!r.reduced,
        bonusMissionPoints: r.bonusMissionPoints || 0,
        bonusMissionDone: !!r.bonusMissionDone,
        missionsDone: r.missionsDone || 0, killsCount: r.killsCount || 0,
        meetingsSurvivedCount: r.meetingsSurvivedCount || 0, sabotageActionsCount: r.sabotageActionsCount || 0,
        ventUsesCount: r.ventUsesCount || 0, survived: !!r.survived,
        saboteur: tokenInfo(tokenByMatch.get(r.matchId)),
      }));
      const wins = matches.filter((m) => m.won).length;

      games.push({
        id: groupKey,
        displayName,
        roomCode: last.roomCode || null,
        mode, // 'free' | 'pool' | 'paid' | 'sponsor'
        isPaid,
        // [ACTIVITY FIX] Was the FIRST match's time while the list was
        // sorted by the LAST one - a game that ran past midnight landed
        // under the wrong day and could repeat a day header. Now both
        // sorting and grouping use the last match; the start is separate.
        earnedAtUtc: last.earnedAt,
        startedAt: first.earnedAt,
        endedAt: last.earnedAt,
        totals: {
          matches: matches.length, wins, losses: matches.length - wins,
          points: matches.reduce((a, m) => a + (m.points || 0), 0),
          saboteur: matches.reduce((a, m) => a + (m.saboteur ? m.saboteur.amount : 0), 0),
          kills: matches.reduce((a, m) => a + m.killsCount, 0),
          missions: matches.reduce((a, m) => a + m.missionsDone, 0),
        },
        entryFeeNear,
        poolNearWon,
        myPoolRank: myRankRec ? myRankRec.poolRank : null,
        topThree,
        matches,
      });
    }

    // [ACTIVITY FIX] The old summary mixed things up: "Played" counted
    // matches while the list below counted games, and "Points" was the
    // all-time total while Home shows this week's. Every number is now
    // explicitly named.
    const weekStart = getCurrentWeekStartUTC();
    const weekValid = me.seasonWeekStart && me.seasonWeekStart.getTime() >= weekStart.getTime();
    let saboteurEarned = 0;
    try {
      const agg = await economy.TokenLedger.aggregate([
        { $match: { holderType: "player", holderId: String(me._id), status: "sent" } },
        { $group: { _id: null, sum: { $sum: "$amount" } } },
      ]);
      saboteurEarned = agg[0] ? agg[0].sum : 0;
    } catch (_) {}
    const matchesPlayed = me.gamesPlayed || 0;
    const matchesWon = me.gamesWon || 0;

    res.json({
      games,
      summary: {
        totalPoints: me.totalPoints || 0,
        weekPoints: weekValid ? (me.currentSeasonPoints || 0) : 0,
        matchesPlayed, matchesWon,
        winRate: matchesPlayed > 0 ? Math.round((matchesWon / matchesPlayed) * 100) : 0,
        saboteurEarned,
        // old names kept so an older frontend build keeps working
        gamesPlayed: matchesPlayed, gamesWon: matchesWon,
      },
    });
  } catch (err) {
    console.error("[ACTIVITY] /activity/games error:", err.message);
    res.status(500).json({ message: "Could not load your activity." });
  }
});

// Quick top-line numbers for the dashboard's overview tab - the fuller
// version (mode breakdown, 24h actives, needs-attention count) lives
// further down, right before the /admin static route.
// [LIVE] Every currently active room, straight from server memory - this
// is the only source for "what's happening right now" (a match in
// progress has no MatchRecord yet; that only gets written once a player
// actually returns to the Lobby afterward).
// ---- [$SABOTEUR] token economy reads ----
// Player: own balance + per-match history (wallet screen).
app.get("/saboteur/me", async (req, res) => {
  try {
    const account = await resolveAccountFromToken(req.query.sessionToken);
    if (!account) return res.status(401).json({ message: "Sign in to see your $SABOTEUR." });
    res.json(await economy.playerSummary(account.accountId));
  } catch (e) { res.status(500).json({ message: "Couldn't load $SABOTEUR right now." }); }
});
// Public: every bot's wallet and track record (for players and judges).
app.get("/saboteur/bots", async (req, res) => {
  try { res.json(await economy.botsSummary(bots.BOT_NAMES)); }
  catch (e) { res.status(500).json({ message: "Couldn't load bot wallets right now." }); }
});
// Admin: totals, top earners, farm flags, current rules.
app.get("/admin/saboteur", requireAdmin, async (req, res) => {
  try { res.json(await economy.adminSummary()); }
  catch (e) { res.status(500).json({ message: e.message }); }
});

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
          { playerName: { $regex: rxSafe(search), $options: "i" } },
          { roomCode: { $regex: rxSafe(search), $options: "i" } },
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
    // [BUG FIX] search went into $regex raw - "(" crashed the request and a crafted pattern could stall the DB
    const safe = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const filter = search
      ? { $or: [
          { name: { $regex: safe, $options: "i" } },
          { username: { $regex: safe, $options: "i" } },
          { email: { $regex: safe, $options: "i" } },
          { walletAddress: { $regex: safe, $options: "i" } },
        ] }
      : {};
    // [ADMIN v2] quick filters
    const show = String(req.query.show || "");
    if (show === "pass") filter.premiumUntil = { $gt: new Date() };
    else if (show === "held") filter.accountHeld = true;
    else if (show === "new") filter.createdAt = { $gte: new Date(Date.now() - 7 * 86400000) };
    else if (show === "walletReset") { filter.walletResetRequestedAt = { $ne: null }; filter.walletResetApproved = { $ne: true }; }
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
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Player not found." });
    const player = await Player.findById(req.params.id, "-passwordHash -otpCode -walletKeystoreCiphertext -walletKeystoreSalt -walletKeystoreIv -sessionToken");
    if (!player) return res.status(404).json({ message: "Player not found." });
    // [BUG FIX - OLDER MATCHES INVISIBLE FOR ACTIVE PLAYERS] This used to
    // hard-cap at the 50 most recent matches with no pagination and no
    // total count returned at all - a player with 200+ matches had no
    // way to see (or even know about) anything past their most recent
    // 50. Now paginated like every other list in this dashboard.
    const matchesPage = Math.max(1, parseInt(req.query.matchesPage, 10) || 1);
    const matchesLimit = 50;
    const [matches, matchesTotal] = await Promise.all([
      MatchRecord.find({ playerId: player._id }).sort({ earnedAt: -1 }).skip((matchesPage - 1) * matchesLimit).limit(matchesLimit),
      MatchRecord.countDocuments({ playerId: player._id }),
    ]);
    // [NEW FEATURE] Live on-chain NEAR balance, if this player has any
    // wallet at all - a simple read-only RPC call, no signing key
    // needed. Never blocks the rest of the response if it fails (wrong
    // network, account doesn't exist yet, RPC hiccup, etc.).
    let walletBalanceNear = null;
    if (player.walletAddress) {
      try {
        const nearAPI = await loadNearAPI();
        const provider = new nearAPI.JsonRpcProvider({ url: NEAR_RPC_URL });
        // [PERF FIX] a missing wallet made the RPC hang ~3s - cap it at 1.5s
        const account = await Promise.race([
          provider.query({ request_type: "view_account", account_id: player.walletAddress, finality: "optimistic" }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1500)),
        ]);
        walletBalanceNear = nearAPI.yoctoToNear(account.amount, 4);
      } catch (e) { /* leave null - account may not exist on-chain yet, or RPC hiccup */ }
    }
    res.json({
      player, matches, walletBalanceNear,
      matchesTotal, matchesPage, matchesPages: Math.ceil(matchesTotal / matchesLimit) || 1,
    });
  } catch (err) {
    console.error("[ADMIN] /admin/players/:id error:", err.message);
    res.status(500).json({ message: "Failed to load player." });
  }
});

// ---- APPROVE A PENDING WALLET-RESET REQUEST ----
app.post("/admin/players/:id/approve-wallet-reset", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    const player = await Player.findById(req.params.id);
    if (!player) return res.status(404).json({ message: "Player not found." });
    if (!player.walletResetRequestedAt) return res.status(400).json({ message: "This player hasn't requested a wallet reset." });
    player.walletResetApproved = true;
    await player.save();
    logAdminAction("approve-wallet-reset", { playerId: String(player._id), playerName: player.name });
    res.json({ success: true });
  } catch (err) {
    console.error("[ADMIN] approve-wallet-reset error:", err.message);
    res.status(500).json({ message: "Failed to approve." });
  }
});

// ---- HOLD / UNHOLD AN ACCOUNT ----
// Client sends: { reason } (hold only - unhold needs nothing)
app.post("/admin/players/:id/hold", requireAdmin, requireFullAdmin, async (req, res) => {
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
    // [BUG FIX] a held player used to stay inside a running match - disconnect them now
    for (const r of Object.values(rooms)) {
      for (const [sid, p] of Object.entries(r.players)) {
        if (p.accountId === String(player._id)) { const so = io.sockets.sockets.get(sid); if (so) { so.emit("sessionMovedElsewhere"); so.disconnect(true); } }
      }
    }
    logAdminAction("hold-account", { playerId: String(player._id), playerName: player.name, reason: player.accountHeldReason });
    res.json({ success: true });
  } catch (err) {
    console.error("[ADMIN] hold error:", err.message);
    res.status(500).json({ message: "Failed to hold this account." });
  }
});
app.post("/admin/players/:id/unhold", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    const player = await Player.findById(req.params.id);
    if (!player) return res.status(404).json({ message: "Player not found." });
    player.accountHeld = false;
    player.accountHeldReason = "";
    await player.save();
    logAdminAction("unhold-account", { playerId: String(player._id), playerName: player.name });
    res.json({ success: true });
  } catch (err) {
    console.error("[ADMIN] unhold error:", err.message);
    res.status(500).json({ message: "Failed to unhold this account." });
  }
});

// [NEW FEATURE - PLAY PASS - ADMIN GIFTING] Client sends: { days }
// (blank/0 = grant forever, matching a real purchase). This is the
// "gift Play Pass to a player" action from the admin Play Pass section.
app.post("/admin/players/:id/grant-premium", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    const player = await Player.findById(req.params.id);
    if (!player) return res.status(404).json({ message: "Player not found." });
    const days = Number(req.body?.days) || 0;
    player.premiumUntil = days > 0 ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : new Date("2099-12-31");
    player.playPassSource = "gifted";
    // [NEW FEATURE - PLAY PASS SKIN UNLOCK PROGRESSION] Same snapshot as
    // a real purchase - see getUnlockedVariantCount.
    player.playPassStartGamesPlayed = player.gamesPlayed || 0;
    await player.save();
    sendInboxMessage(player._id, {
      title: "🎁 You've got Play Pass!",
      body: days > 0
        ? `You've been gifted Play Pass for ${days} day${days === 1 ? "" : "s"}. Enjoy your premium avatars!`
        : "You've been gifted Play Pass. Enjoy your premium avatars!",
    });
    logAdminAction("grant-premium", { playerId: String(player._id), playerName: player.name, days: days || "forever" });
    res.json({ success: true, premiumUntil: player.premiumUntil });
  } catch (err) {
    console.error("[ADMIN] grant-premium error:", err.message);
    res.status(500).json({ message: "Failed to grant Play Pass." });
  }
});
// [NEW FEATURE - PLAY PASS - ADMIN REVOKE] Also clears the player's
// active premium avatar variant and source tag - a revoked Play Pass
// should fully reset back to "never had it", not leave a stale variant
// choice sitting around that silently reactivates if premium is ever
// re-granted without the player noticing.
app.post("/admin/players/:id/revoke-premium", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    const player = await Player.findById(req.params.id);
    if (!player) return res.status(404).json({ message: "Player not found." });
    player.premiumUntil = null;
    player.activePremiumAvatarVariant = null;
    player.playPassSource = null;
    player.playPassStartGamesPlayed = 0;
    await player.save();
    logAdminAction("revoke-premium", { playerId: String(player._id), playerName: player.name });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to revoke Play Pass." });
  }
});

// ============================================================
// [NEW FEATURE - PLAY PASS] Admin dashboard section routes.
// ============================================================

// ---- GET / UPDATE PLAY PASS CONFIG (price, discount, on/off) ----
// [PLAY PASS - REAL NEAR] Player paid from their own mainnet wallet; check it
// on-chain and switch Play Pass on. Safe to call again with the same tx.
// [PLAY PASS - REAL NEAR] The player proves a mainnet wallet is theirs by
// signing a one-time message with it. Only that wallet's payments count for
// them - so nobody can claim someone else's transfer.
app.post("/play-pass/link-wallet", async (req, res) => {
  try {
    const sessionToken = String(req.body.sessionToken || "").trim();
    const player = sessionToken ? await Player.findOne({ sessionToken, verified: true }) : null;
    if (!player) return res.status(401).json({ message: "Please log in again." });
    const accountId = String(req.body.accountId || "").trim().toLowerCase();
    const publicKey = String(req.body.publicKey || "").trim();
    const signature = String(req.body.signature || "").trim();
    const nonceBase64 = String(req.body.nonce || "").trim();
    if (!accountId || !publicKey || !signature || !nonceBase64) return res.status(400).json({ message: "Missing signature data." });
    const v = await verifyWalletSignature({ accountId, publicKey, signature, nonceBase64, message: WALLET_SIGN_MESSAGE });
    if (!v.ok) return res.status(401).json({ message: v.error });
    player.playPassPayerWallet = accountId;
    await player.save();
    res.json({ success: true, wallet: accountId });
  } catch (e) {
    console.error("[PLAY PASS] link-wallet error:", e.message);
    res.status(500).json({ message: "Couldn't verify your wallet right now. Try again." });
  }
});

// [NEAR AI MISSION] Storage-room mission: real NEAR AI answers, auto-reply
// when NEAR AI isn't available. No login needed (guests play missions too).
const nearAiMission = require("./nearAiMission");
app.post("/near-ai/mission-ask", async (req, res) => {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const r = await nearAiMission.ask(ip, req.body && req.body.question, req.body && req.body.history);
  res.status(r.status).json(r.body);
});

app.post("/play-pass/purchase-mainnet", async (req, res) => {
  try {
    const sessionToken = String(req.body.sessionToken || "").trim();
    const player = sessionToken ? await Player.findOne({ sessionToken, verified: true }) : null;
    if (!player) return res.status(401).json({ message: "Please log in again." });
    const txHash = String(req.body.txHash || "").trim();
    const payer = String(req.body.payerAccountId || "").trim().toLowerCase();
    if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(txHash)) return res.status(400).json({ message: "That doesn't look like a NEAR transaction hash." });
    if (!payer) return res.status(400).json({ message: "Missing the wallet that paid." });
    if (!player.playPassPayerWallet || player.playPassPayerWallet !== payer) return res.status(403).json({ message: "Confirm this wallet is yours first (sign the message in your wallet), then try again." });

    const existing = await PlayPassPurchase.findOne({ txHash });
    if (existing) {
      if (existing.playerId !== String(player._id)) return res.status(409).json({ message: "That payment was already used by another account." });
      const hasPass = !!(player.premiumUntil && player.premiumUntil.getTime() > Date.now());
      return res.json({ success: existing.status === "granted", hasPlayPass: hasPass, status: existing.status, message: existing.status === "granted" ? "Play Pass is active." : "This payment is waiting for a refund." });
    }

    const tx = await readMainnetTransfer(txHash, payer);
    if (!tx.ok) return res.status(502).json({ message: tx.error });
    if (!tx.succeeded) return res.status(400).json({ message: "That transaction failed on-chain, so no NEAR was sent." });
    if (tx.signer !== payer) return res.status(400).json({ message: "That transaction wasn't sent from your wallet." });
    if (tx.receiver !== PLAY_PASS_MAINNET_RECEIVER || tx.yocto <= 0n) return res.status(400).json({ message: `That transaction didn't send NEAR to ${PLAY_PASS_MAINNET_RECEIVER}.` });

    const nearAPI = await loadNearAPI();
    const config = await getPlayPassConfig();
    const price = effectivePlayPassPriceNear(config);
    const amountNear = Number(nearAPI.yoctoToNear(tx.yocto, 5));
    const hadPass = !!(player.premiumUntil && player.premiumUntil.getTime() > Date.now());
    let reason = null;
    if (hadPass) reason = "you already had Play Pass";
    else if (!config.enabled) reason = "Play Pass sales were switched off";
    else if (tx.yocto < BigInt(nearAPI.nearToYocto(String(price)))) reason = `paid ${amountNear} NEAR, the price was ${price} NEAR`;

    const base = { playerId: String(player._id), playerName: player.name || player.username || "", payerAccountId: payer, txHash, amountNear, priceNear: price };
    if (reason) {
      await PlayPassPurchase.create({ ...base, status: "needs_refund", reason });
      sendInboxMessage(player._id, {
        title: "We received your payment — refund on the way",
        body: `${amountNear} NEAR arrived from ${payer}, but Play Pass couldn't be switched on (${reason}). We'll send it back to ${payer}. You'll get a message when it's sent.`,
        nameTag: "Play Pass",
      });
      logAdminAction("play-pass-needs-refund", { playerId: base.playerId, txHash, reason });
      return res.status(402).json({ message: `Payment received, but Play Pass couldn't be switched on (${reason}). Your ${amountNear} NEAR will be sent back to ${payer}.`, status: "needs_refund" });
    }
    await PlayPassPurchase.create({ ...base, status: "granted" });
    player.premiumUntil = new Date("2099-12-31");
    player.playPassSource = "purchased";
    player.playPassTxHash = txHash;
    player.playPassPricePaidNear = amountNear;
    player.playPassStartGamesPlayed = player.gamesPlayed || 0;
    await player.save();
    sendInboxMessage(player._id, {
      title: "Play Pass activated!",
      body: `Thanks! ${amountNear} NEAR received from ${payer}. Your premium skins, 24 chat stickers, GIFs, gold name and 2x $SABOTEUR rewards are on. Purchases are final once Play Pass is active.`,
      nameTag: "Play Pass",
    });
    logAdminAction("play-pass-purchased", { playerId: base.playerId, playerName: base.playerName, txHash, amountNear, payer });
    res.json({ success: true, hasPlayPass: true, status: "granted" });
  } catch (err) {
    if (err && err.code === 11000) return res.status(409).json({ message: "That payment was already used." });
    console.error("[PLAY PASS] purchase-mainnet error:", err.message);
    res.status(500).json({ message: "Something went wrong checking your payment. Your NEAR is safe - try again in a moment." });
  }
});

// [PLAY PASS - REAL NEAR] every real purchase, and the ones still owed a refund
app.get("/admin/play-pass/purchases", requireAdmin, async (req, res) => {
  try {
    const q = req.query.status ? { status: String(req.query.status) } : {};
    const rows = await PlayPassPurchase.find(q).sort({ createdAt: -1 }).limit(200).lean();
    const owed = await PlayPassPurchase.countDocuments({ status: "needs_refund" });
    const total = await PlayPassPurchase.aggregate([{ $match: { status: "granted" } }, { $group: { _id: null, n: { $sum: 1 }, near: { $sum: "$amountNear" } } }]);
    res.json({ success: true, receiver: PLAY_PASS_MAINNET_RECEIVER, refundsOwed: owed, sold: total[0]?.n || 0, revenueNear: Math.round((total[0]?.near || 0) * 1e5) / 1e5, rows });
  } catch (e) { res.status(500).json({ message: "Failed to load purchases." }); }
});
app.post("/admin/play-pass/purchases/:id/refunded", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    const row = await PlayPassPurchase.findById(req.params.id);
    if (!row) return res.status(404).json({ message: "Purchase not found." });
    if (row.status !== "needs_refund") return res.status(400).json({ message: "This purchase isn't waiting for a refund." });
    row.status = "refunded"; row.refundedAt = new Date(); row.refundTxHash = String(req.body.refundTxHash || "").trim().slice(0, 64) || null;
    await row.save();
    sendInboxMessage(row.playerId, { title: "Your refund was sent", body: `${row.amountNear} NEAR was sent back to ${row.payerAccountId}.${row.refundTxHash ? ` Transaction: ${row.refundTxHash}` : ""}`, nameTag: "Play Pass" });
    logAdminAction("play-pass-refunded", { id: String(row._id), refundTxHash: row.refundTxHash });
    res.json({ success: true, row });
  } catch (e) { res.status(500).json({ message: "Failed to mark refunded." }); }
});

app.get("/admin/play-pass/config", requireAdmin, async (req, res) => {
  try {
    const config = await getPlayPassConfig();
    res.json({ success: true, ...config, effectivePriceNear: effectivePlayPassPriceNear(config) });
  } catch (err) {
    res.status(500).json({ message: "Failed to load Play Pass config." });
  }
});
app.post("/admin/play-pass/config", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    const patch = {};
    if (req.body.priceNear !== undefined) {
      const price = Number(req.body.priceNear);
      if (!(price > 0)) return res.status(400).json({ message: "Price must be a positive number." });
      patch.priceNear = price;
    }
    if (req.body.discountPercent !== undefined) {
      const discount = Number(req.body.discountPercent);
      if (!(discount >= 0 && discount <= 100)) return res.status(400).json({ message: "Discount must be between 0 and 100." });
      patch.discountPercent = discount;
    }
    if (req.body.enabled !== undefined) patch.enabled = !!req.body.enabled;
    // [NEW FEATURE - PLAY PASS SKIN UNLOCK PROGRESSION] Admin-adjustable
    // gap - see getUnlockedVariantCount for how this is used.
    if (req.body.unlockGamesGap !== undefined) {
      const gap = Number(req.body.unlockGamesGap);
      if (!(gap >= 1)) return res.status(400).json({ message: "Games between unlocks must be at least 1." });
      patch.unlockGamesGap = Math.round(gap);
    }
    // [NEW FEATURE - AUTO-ANNOUNCE DISCOUNT] Snapshot the discount BEFORE
    // this update lands, so we can tell "just turned on/raised" apart
    // from "already was this discount, admin changed something else
    // (like enabled)" - only posts a fresh announcement on an actual
    // increase, never on every single config save.
    const configBefore = await getPlayPassConfig();
    const previousDiscount = Number(configBefore.discountPercent) || 0;
    const config = await setPlayPassConfig(patch);
    if (typeof patch.discountPercent === "number" && patch.discountPercent > previousDiscount) {
      const price = effectivePlayPassPriceNear(config);
      Announcement.create({
        title: `Play Pass is ${patch.discountPercent}% off!`,
        body: `For a limited time, Play Pass is ${price} NEAR (${patch.discountPercent}% off the regular price). Grab it now before the discount ends.`,
        nameTag: "NEAR Saboteur",
      }).catch((e) => console.error("[ADMIN] auto-announcement for discount failed:", e.message));
    }
    logAdminAction("play-pass-config-update", patch);
    res.json({ success: true, ...config, effectivePriceNear: effectivePlayPassPriceNear(config) });
  } catch (err) {
    console.error("[ADMIN] play-pass/config update error:", err.message);
    res.status(500).json({ message: "Failed to update Play Pass config." });
  }
});

// ---- LIST / SEARCH PLAY PASS HOLDERS ----
// Query params: ?search=<name/username/email>&page=1
app.get("/admin/play-pass/holders", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 30;
    const search = String(req.query.search || "").trim();
    const filter = { premiumUntil: { $ne: null } };
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: rx }, { username: rx }, { email: rx }];
    }
    const [holders, total] = await Promise.all([
      Player.find(filter)
        .select("name username email premiumUntil playPassSource playPassTxHash activePremiumAvatarVariant createdAt")
        .sort({ premiumUntil: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Player.countDocuments(filter),
    ]);
    res.json({
      success: true,
      holders: holders.map((h) => ({
        id: h._id,
        name: h.name,
        username: h.username,
        email: h.email,
        isPermanent: h.premiumUntil && new Date(h.premiumUntil).getFullYear() >= 2098,
        premiumUntil: h.premiumUntil,
        source: h.playPassSource,
        txHash: h.playPassTxHash,
        activeVariant: h.activePremiumAvatarVariant,
      })),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("[ADMIN] play-pass/holders error:", err.message);
    res.status(500).json({ message: "Failed to load Play Pass holders." });
  }
});

// [NEW FEATURE - ADMIN OVERVIEW: FUND SAFETY] Shared by /admin/overview
// and /admin/funds - a pool needing a human look right now.
// [BUG FIX - RESOLVED POOLS STAYED FLAGGED FOREVER] Previously matched
// ANY pool with a lastSettlementError set, even ones that had since
// genuinely settled (state now Distributed/Refunded) via a later retry
// or reconciliation pass - a pool that self-recovered kept showing a
// scary "ATTENTION" badge forever, with no way to tell it apart from a
// real ongoing problem. Only Open/Locked (still actually unresolved)
// pools count now - once a pool reaches Distributed/Refunded, whatever
// happened before is history, not something needing action today.
function fundsNeedsAttentionFilter() {
  return {
    $or: [
      {
        state: { $in: ["Open", "Locked"] },
        $or: [
          { lastSettlementError: { $ne: null } },
          { createdAt: { $lt: new Date(Date.now() - 30 * 60 * 1000) } },
        ],
      },
      // [NEW FEATURE - PLAYER-REPORTED STUCK PAYMENT] A player can flag
      // themselves as stuck (paid, but no room) at any moment, even
      // seconds after paying - don't make them wait 30 minutes to show
      // up here. Matches on ANY unresolved report existing in the array.
      { "stuckReports.resolved": false },
    ],
  };
}

// [NEW FEATURE - PLAIN-LANGUAGE ERROR TRANSLATION] Raw Rust panic
// messages are accurate but unreadable to a non-developer - this maps
// the handful of panic messages the contract can actually produce to a
// short, honest explanation of what happened and whether it's already
// been handled. Falls back to the raw message for anything unrecognized
// (never hides real information, just adds context where it can).
function explainSettlementError(rawError) {
  if (!rawError) return null;
  if (/isn't awaiting distribution/i.test(rawError) || /isn't Locked/i.test(rawError)) {
    return "An earlier automatic attempt ran into a timing conflict (the pool had already moved on by the time it tried). If this pool's status below shows Distributed or Refunded, it resolved itself on a later attempt - this message is just history.";
  }
  if (/Only a pool that hasn't produced any results yet can be cancelled/i.test(rawError)) {
    return "The system tried to refund this pool, but real match results already existed on-chain by then, so a refund wasn't the correct action - it needed a real payout instead. If this pool's status below shows Distributed, a later attempt correctly paid out the real winners.";
  }
  if (/never participated/i.test(rawError)) {
    return "A payout attempt referenced a wallet that was never actually registered in this pool on-chain - usually means the player's wallet address on file doesn't match what they actually joined with.";
  }
  if (/Not enough collected fees/i.test(rawError)) {
    return "A platform-fee withdrawal was attempted for more than is currently available.";
  }
  return rawError; // unrecognized - show the raw message rather than hide it
}

// ============================================================
// [NEW FEATURE - CUSTOM AVATAR REQUEST] Admin dashboard section routes.
// ============================================================

// ---- GET / UPDATE CONFIG (price, Telegram support link, on/off) ----
app.get("/admin/custom-avatar-request/config", requireAdmin, async (req, res) => {
  try {
    const config = await getCustomAvatarRequestConfig();
    res.json({ success: true, ...config });
  } catch (err) {
    res.status(500).json({ message: "Failed to load custom avatar request config." });
  }
});
app.post("/admin/custom-avatar-request/config", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    const patch = {};
    if (req.body.priceNear !== undefined) {
      const price = Number(req.body.priceNear);
      if (!(price >= 0)) return res.status(400).json({ message: "Price must be zero or a positive number." });
      patch.priceNear = price;
    }
    if (req.body.telegramLink !== undefined) {
      const link = String(req.body.telegramLink || "").trim();
      if (link && !/^https:\/\/t\.me\//i.test(link)) {
        return res.status(400).json({ message: "Telegram link must start with https://t.me/" });
      }
      patch.telegramLink = link;
    }
    if (req.body.enabled !== undefined) patch.enabled = !!req.body.enabled;
    const config = await setCustomAvatarRequestConfig(patch);
    logAdminAction("custom-avatar-request-config-update", patch);
    res.json({ success: true, ...config });
  } catch (err) {
    console.error("[ADMIN] custom-avatar-request/config update error:", err.message);
    res.status(500).json({ message: "Failed to update config." });
  }
});

// ---- LIST REQUESTS (paginated, newest first) ----
app.get("/admin/custom-avatar-request/list", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;
    const [requests, total] = await Promise.all([
      CustomAvatarRequest.find({}, "-imageBase64") // list view never sends the image itself - see the dedicated /image route below
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      CustomAvatarRequest.countDocuments({}),
    ]);
    res.json({
      success: true,
      requests,
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
    });
  } catch (err) {
    console.error("[ADMIN] custom-avatar-request/list error:", err.message);
    res.status(500).json({ message: "Failed to load requests." });
  }
});

// ---- FETCH THE REFERENCE IMAGE (view/download) ----
app.get("/admin/custom-avatar-request/:id/image", requireAdmin, async (req, res) => {
  try {
    const request = await CustomAvatarRequest.findById(req.params.id, "imageBase64 imageMimeType playerName");
    if (!request || !request.imageBase64) return res.status(404).json({ message: "Image not found." });
    const buffer = Buffer.from(request.imageBase64, "base64");
    res.set("Content-Type", request.imageMimeType || "image/png");
    if (req.query.download) {
      const ext = (request.imageMimeType || "").split("/")[1] || "png";
      res.set("Content-Disposition", `attachment; filename="custom-avatar-${req.params.id}.${ext}"`);
    }
    res.send(buffer);
  } catch (err) {
    console.error("[ADMIN] custom-avatar-request image error:", err.message);
    res.status(500).json({ message: "Failed to load image." });
  }
});

// ---- DELETE A REQUEST ----
app.delete("/admin/custom-avatar-request/:id", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    await CustomAvatarRequest.deleteOne({ _id: req.params.id });
    logAdminAction("custom-avatar-request-delete", { requestId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete request." });
  }
});

// ---- REPLY TO A REQUEST (sends the reply straight to the player's inbox) ----
app.post("/admin/custom-avatar-request/:id/reply", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    const replyText = String(req.body.reply || "").trim();
    if (!replyText) return res.status(400).json({ message: "Reply can't be empty." });
    const request = await CustomAvatarRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: "Request not found." });
    request.status = "replied";
    request.adminReply = replyText;
    request.adminRepliedAt = new Date();
    await request.save();
    sendInboxMessage(request.playerId, {
      title: "Update on your custom character request",
      body: replyText,
      nameTag: "NEAR Saboteur",
    });
    logAdminAction("custom-avatar-request-reply", { requestId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    console.error("[ADMIN] custom-avatar-request reply error:", err.message);
    res.status(500).json({ message: "Failed to send reply." });
  }
});

// [NEW FEATURE - ADMIN OVERVIEW] Expanded from the original 5 numbers -
// mode breakdown, 24h active players, and the funds-needing-attention
// count all in one place.
// [ADMIN SPEED] The sidebar badges only need a few counts - this is what
// every page refreshes, instead of the heavy overview below.
app.get("/admin/counts", requireAdmin, async (req, res) => {
  try {
    const [refundsOwed, needsAttentionCount, openReports, customAvatarPending] = await Promise.all([
      PlayPassPurchase.countDocuments({ status: "needs_refund" }).catch(() => 0),
      PoolRecord.countDocuments(fundsNeedsAttentionFilter()).catch(() => 0),
      PlayerReport.countDocuments({ status: "open" }).catch(() => 0),
      CustomAvatarRequest.countDocuments({ status: "submitted" }).catch(() => 0),
    ]);
    res.json({ network: NEAR_NETWORK, activeRooms: Object.keys(rooms).length, refundsOwed, needsAttentionCount, openReports, customAvatarPending });
  } catch (e) { res.status(500).json({ message: "Failed to load counts." }); }
});
// [ADMIN SPEED] the overview scans every match record - reuse it for 20s
let adminOverviewCache = null;
app.get("/admin/overview", requireAdmin, async (req, res) => {
  if (adminOverviewCache && Date.now() - adminOverviewCache.at < 20000) return res.json(adminOverviewCache.body);
  const send = (body) => { adminOverviewCache = { at: Date.now(), body }; res.json(body); };
  try {
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const fortnightAgo = new Date(startOfToday.getTime() - 13 * 24 * 60 * 60 * 1000);
    // [BUG FIX] MatchRecord has one row PER PLAYER per match - count distinct matchIds instead
    const distinctMatches = (match) => MatchRecord.aggregate([{ $match: match }, { $group: { _id: "$matchId" } }, { $count: "n" }]).then((a) => a[0]?.n || 0);
    const [byDay, newPlayersToday, refundsOwed, openReports, ppSold, manualUnpaid, customPending] = await Promise.all([
      MatchRecord.aggregate([{ $match: { earnedAt: { $gte: fortnightAgo } } }, { $group: { _id: { d: { $dateToString: { format: "%Y-%m-%d", date: "$earnedAt" } }, m: "$matchId" } } }, { $group: { _id: "$_id.d", n: { $sum: 1 } } }, { $sort: { _id: 1 } }]).catch(() => []),
      Player.countDocuments({ verified: true, createdAt: { $gte: startOfToday } }).catch(() => 0),
      PlayPassPurchase.countDocuments({ status: "needs_refund" }).catch(() => 0),
      PlayerReport.countDocuments({ status: "open" }).catch(() => 0),
      PlayPassPurchase.aggregate([{ $match: { status: "granted" } }, { $group: { _id: null, n: { $sum: 1 }, near: { $sum: "$amountNear" } } }]).catch(() => []),
      ManualPool.countDocuments({ state: "Finished", winners: { $elemMatch: { paidAt: null } } }).catch(() => 0),
      CustomAvatarRequest.countDocuments({ status: "submitted" }).catch(() => 0),
    ]);
    const days = [];
    for (let i = 13; i >= 0; i--) { const d = new Date(startOfToday.getTime() - i * 86400000).toISOString().slice(0, 10); days.push({ day: d, matches: (byDay.find((x) => x._id === d) || {}).n || 0 }); }
    const playersOnline = Object.values(rooms).reduce((a, r) => a + Object.values(r.players).filter((p) => !p.isBot && !p.disconnectedAt).length, 0);
    const [
      totalPlayers, totalMatches, matchesToday, activePlayerIds,
      freePlayMatches, poolStyleMatches, needsAttentionCount,
      poolRecordsByFunding,
    ] = await Promise.all([
      Player.countDocuments({ verified: true }),
      distinctMatches({}),
      distinctMatches({ earnedAt: { $gte: startOfToday } }),
      MatchRecord.distinct("playerId", { earnedAt: { $gte: dayAgo } }),
      distinctMatches({ isPoolGame: false }),
      distinctMatches({ isPoolGame: true }),
      PoolRecord.countDocuments(fundsNeedsAttentionFilter()),
      // hostFunded=true is "Pool Games" mode, hostFunded=false is "Paid
      // Games" mode - both share isPoolGame=true on MatchRecord, this is
      // the only place that distinguishes them.
      PoolRecord.aggregate([{ $group: { _id: "$hostFunded", n: { $sum: 1 } } }]),
    ]);
    const activeRooms = Object.keys(rooms).length;
    const activeGames = Object.values(rooms).filter((r) => r.gameStarted).length;
    const openOrLockedPools = Object.values(rooms).filter((r) => r.pool && (r.pool.state === "Open" || r.pool.state === "Locked")).length;
    const poolGamesCreated = poolRecordsByFunding.find((g) => g._id === true)?.n || 0;
    const paidGamesCreated = poolRecordsByFunding.find((g) => g._id === false)?.n || 0;
    send({
      network: NEAR_NETWORK,
      totalPlayers, totalMatches, matchesToday,
      activeRooms, activeGames, openOrLockedPools,
      activePlayers24h: activePlayerIds.length,
      freePlayMatches, poolStyleMatches, poolGamesCreated, paidGamesCreated,
      needsAttentionCount,
      // [ADMIN v2] what needs the admin + the 14-day chart
      playersOnline, newPlayersToday, matchesByDay: days,
      refundsOwed, openReports, manualPoolsUnpaid: manualUnpaid, customAvatarPending: customPending,
      playPassSold: ppSold[0]?.n || 0, playPassRevenueNear: Math.round((ppSold[0]?.near || 0) * 1e5) / 1e5, playPassWallet: PLAY_PASS_MAINNET_RECEIVER,
    });
  } catch (err) {
    console.error("[ADMIN] /admin/overview error:", err.message);
    res.status(500).json({ message: "Failed to load overview." });
  }
});

// [NEW FEATURE] Which network this deployment is actually pointed at -
// the admin dashboard shows this as a permanent badge so testnet vs
// mainnet is never ambiguous. Everything else (RPC URL, nearblocks
// links, contract id) already derives from this same NEAR_NETWORK env
// var throughout the backend - nothing else needs to change when this
// flips to "mainnet" at launch.
app.get("/admin/network", requireAdmin, (req, res) => {
  res.json({
    network: NEAR_NETWORK,
    contractId: POOL_CONTRACT_ACCOUNT_ID || null,
    oracleAccountId: ORACLE_ACCOUNT_ID || null,
    ownerAccountId: OWNER_ACCOUNT_ID || null,
  });
});

// [NEW FEATURE - FREE-TIER MONITORING] MongoDB Atlas M0's own hard cap
// is 512MB - self-reported straight from the database, no external
// service/API key needed, so this stays free regardless of scale.
app.get("/admin/db-stats", requireAdmin, async (req, res) => {
  try {
    const stats = await mongoose.connection.db.stats();
    const ATLAS_M0_LIMIT_MB = 512;
    res.json({
      storageUsedMb: +((stats.storageSize || 0) / (1024 * 1024)).toFixed(2),
      dataUsedMb: +((stats.dataSize || 0) / (1024 * 1024)).toFixed(2),
      indexUsedMb: +((stats.indexSize || 0) / (1024 * 1024)).toFixed(2),
      storageLimitMb: ATLAS_M0_LIMIT_MB,
      percentUsed: +(((stats.storageSize || 0) / (1024 * 1024) / ATLAS_M0_LIMIT_MB) * 100).toFixed(1),
      collections: stats.collections || 0,
      // [NEW FEATURE] Node process uptime - a free, always-available
      // proxy for "did Render's free tier just cold-start this?" (a
      // low number means it very recently spun back up from idle).
      serverUptimeSeconds: Math.round(process.uptime()),
    });
  } catch (err) {
    console.error("[ADMIN] /admin/db-stats error:", err.message);
    res.status(500).json({ message: "Failed to load database stats." });
  }
});

// [NEW FEATURE - REVENUE TAB] Everything read-only: the contract's own
// unwithdrawn platform-fee balance (a free view call, no gas), the
// oracle account's real NEAR balance (its OWN operating gas money, not
// revenue - flagged low here specifically because if this account ever
// runs dry, real players' pool settlements start failing, which is
// exactly the "funds stuck" scenario the Funds tab also watches for),
// and the owner wallet's balance if OWNER_ACCOUNT_ID is set. Actually
// withdrawing platform fees is NOT done from here on purpose - that
// needs the owner's own signature, which correctly never touches this
// server; do that from Om7eth's own wallet app, same as always.
app.get("/admin/revenue", requireAdmin, async (req, res) => {
  try {
    const nearAPI = await loadNearAPI();
    if (!viewProvider) viewProvider = new nearAPI.JsonRpcProvider({ url: NEAR_RPC_URL });

    const platformFeesBalanceRaw = await viewContract("get_platform_fees_balance", {});
    const platformFeesBalanceNear = platformFeesBalanceRaw != null ? Number(nearAPI.yoctoToNear(platformFeesBalanceRaw, 4)) : null;

    async function readBalance(accountId) {
      if (!accountId) return null;
      try {
        const acc = await viewProvider.query({ request_type: "view_account", account_id: accountId, finality: "optimistic" });
        return Number(nearAPI.yoctoToNear(acc.amount, 4));
      } catch (e) { return null; }
    }
    const [oracleBalanceNear, ownerBalanceNear, contractBalanceNear] = await Promise.all([
      readBalance(ORACLE_ACCOUNT_ID), readBalance(OWNER_ACCOUNT_ID), readBalance(POOL_CONTRACT_ACCOUNT_ID),
    ]);

    // Lifetime total (withdrawn + still-sitting-on-contract) - computed
    // from PoolRecord since the contract itself doesn't expose a
    // running lifetime total, only the current unwithdrawn balance.
    // Same 5% the contract itself takes (PLATFORM_FEE_BPS) applied to
    // every settled pool's real total fund.
    const distributedPools = await PoolRecord.find(
      { state: "Distributed" },
      "entryFeeNear hostFunded onChainParticipantAccountIds"
    );
    let lifetimeFeesNear = 0;
    for (const p of distributedPools) {
      const n = (p.onChainParticipantAccountIds || []).length;
      const totalFund = p.hostFunded ? (p.entryFeeNear || 0) : (p.entryFeeNear || 0) * n;
      lifetimeFeesNear += totalFund * 0.05;
    }

    // [BUG FIX - REVENUE PAGE] Play Pass has been live for a while now,
    // this was still reporting a hardcoded 0 with a "not built yet"
    // note. Real lifetime revenue = sum of what was actually paid at
    // each purchase (playPassPricePaidNear, stamped in /play-pass/purchase),
    // not count × current price (which would be wrong the moment the
    // price or discount ever changes).
    const purchasedPlayPassPlayers = await Player.find(
      { playPassSource: "purchased" },
      "playPassPricePaidNear"
    );
    const playPassRevenueNear = purchasedPlayPassPlayers.reduce((sum, p) => sum + (p.playPassPricePaidNear || 0), 0);
    const playPassPurchaseCount = purchasedPlayPassPlayers.length;
    const premiumGrantsCount = await Player.countDocuments({ playPassSource: "gifted" });

    // [BUG FIX - REVENUE PAGE] Custom avatar request fees - see the
    // CustomAvatarRequest model. Only requests that actually paid
    // (status beyond just "submitted with no payment yet") count.
    const paidCustomRequests = await CustomAvatarRequest.find(
      { paymentTxHash: { $ne: null } },
      "pricePaidNear"
    );
    const customAvatarRevenueNear = paidCustomRequests.reduce((sum, r) => sum + (r.pricePaidNear || 0), 0);

    // [BUG FIX - REVENUE PAGE] The wallet Play Pass (and custom avatar
    // request) payments actually land in - PLAY_PASS_RECEIVING_ACCOUNT_ID
    // defaults to the oracle wallet until a dedicated one is configured
    // (see that constant's own comment) - surfaced explicitly here so
    // it's obvious in the dashboard when they're still the same wallet,
    // instead of silently mixing gas-operating funds with real revenue.
    const revenueWalletSameAsOracle = PLAY_PASS_RECEIVING_ACCOUNT_ID === ORACLE_ACCOUNT_ID;
    const revenueWalletBalanceNear = await readBalance(PLAY_PASS_RECEIVING_ACCOUNT_ID);
    // [ADMIN v2] Play Pass is real NEAR on mainnet now - read that wallet from mainnet, never add it to testnet totals
    let playPassWalletBalanceNear = null;
    try {
      const j = await fetch(MAINNET_RPC_URLS[0], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: PLAY_PASS_MAINNET_RECEIVER } }) }).then((r) => r.json());
      if (j.result) playPassWalletBalanceNear = Number((BigInt(j.result.amount) / 10n ** 20n)) / 10000;
    } catch (e) { /* leave null */ }
    const ppMain = await PlayPassPurchase.aggregate([{ $match: { status: "granted" } }, { $group: { _id: null, n: { $sum: 1 }, near: { $sum: "$amountNear" } } }]).catch(() => []);

    res.json({
      network: NEAR_NETWORK,
      playPassWallet: PLAY_PASS_MAINNET_RECEIVER, playPassWalletBalanceNear,
      playPassMainnetSold: ppMain[0]?.n || 0, playPassMainnetRevenueNear: Math.round((ppMain[0]?.near || 0) * 1e5) / 1e5,
      platformFeesBalanceNear, // currently sitting on-chain, unwithdrawn
      lifetimeFeesNear: +lifetimeFeesNear.toFixed(4),
      oracleAccountId: ORACLE_ACCOUNT_ID || null,
      oracleBalanceNear,
      oracleLowBalance: typeof oracleBalanceNear === "number" && oracleBalanceNear < 2,
      ownerAccountId: OWNER_ACCOUNT_ID || null,
      ownerBalanceNear,
      // [NEW FEATURE] The contract account's own total balance - this
      // is EVERY locked pool's funds plus the unwithdrawn platform fee,
      // all together, since that's literally what the contract account
      // is holding on-chain right now. Not the same number as
      // platformFeesBalanceNear (that's just the fee portion, tracked
      // separately inside the contract's own state).
      contractAccountId: POOL_CONTRACT_ACCOUNT_ID || null,
      contractBalanceNear,
      playPassRevenueNear: +playPassRevenueNear.toFixed(4),
      playPassPurchaseCount,
      premiumGrantsCount,
      customAvatarRevenueNear: +customAvatarRevenueNear.toFixed(4),
      customAvatarPaidRequestCount: paidCustomRequests.length,
      revenueWalletAccountId: PLAY_PASS_RECEIVING_ACCOUNT_ID || null,
      revenueWalletBalanceNear,
      revenueWalletSameAsOracle,
      // [BUG FIX] testnet only - mainnet Play Pass money is reported separately above
      totalRevenueNear: +(lifetimeFeesNear + customAvatarRevenueNear).toFixed(4),
    });
  } catch (err) {
    console.error("[ADMIN] /admin/revenue error:", err.message);
    res.status(500).json({ message: "Failed to load revenue." });
  }
});

// [NEW FEATURE - REVENUE WALLET RAW HISTORY] The authoritative source
// of truth for "did someone actually pay" - proxies nearblocks for
// every incoming transfer to PLAY_PASS_RECEIVING_ACCOUNT_ID directly
// from the chain itself, independent of whether our own DB has a
// matching Play Pass purchase or CustomAvatarRequest document. This is
// exactly how a payment that succeeded on-chain but never turned into
// a saved request (closed app, connection dropped mid-submit, etc)
// still shows up here - the money moved, so nearblocks knows about it
// even if this server's own database doesn't. Each incoming transfer
// is cross-referenced against known Player wallets AND known Play
// Pass/CustomAvatarRequest payments (matched by sender wallet + txHash)
// so the dashboard can flag "matched" vs "no matching request found -
// needs follow-up" per row.
app.get("/admin/revenue-wallet-history", requireAdmin, async (req, res) => {
  try {
    if (!PLAY_PASS_RECEIVING_ACCOUNT_ID) return res.status(400).json({ message: "No revenue wallet configured." });
    const nearAPI = await loadNearAPI();
    // Shared helper - legacy /txns stopped returning recent rows.
    const rawTxns = await fetchNearblocksAccountRows(PLAY_PASS_RECEIVING_ACCOUNT_ID, 60);

    // Only INCOMING transfers to this wallet - outgoing (e.g. Om7eth
    // moving funds out) isn't a "did someone pay" question.
    const incoming = rawTxns.filter((t) => t.receiver_account_id === PLAY_PASS_RECEIVING_ACCOUNT_ID && String(t.predecessor_account_id || '').toLowerCase() !== 'system');

    // Known Play Pass purchase tx hashes + known Custom Avatar Request
    // payment tx hashes, both fetched once up front rather than per-row.
    const [playPassPayers, customRequests] = await Promise.all([
      Player.find({ playPassTxHash: { $ne: null } }, "playPassTxHash walletAddress name username").lean(),
      CustomAvatarRequest.find({ paymentTxHash: { $ne: null } }, "paymentTxHash walletAddress playerName telegramUsername").lean(),
    ]);
    const playPassByHash = new Map(playPassPayers.map((p) => [p.playPassTxHash, p]));
    const customByHash = new Map(customRequests.map((r) => [r.paymentTxHash, r]));
    // Wallet → player name, so even an UNMATCHED transfer can still say
    // whose in-game wallet it came from (if it's a known player wallet
    // at all - could also be a totally external wallet).
    const allWallets = await Player.find({ walletAddress: { $ne: null } }, "walletAddress name username").lean();
    const nameByWallet = new Map(allWallets.map((p) => [p.walletAddress, p.username ? `@${p.username}` : (p.name || "Player")]));

    const rows = incoming.map((t) => {
      const hash = t.transaction_hash || t.hash;
      const fromWallet = t.predecessor_account_id || t.signer_account_id || null;
      const playPassMatch = playPassByHash.get(hash);
      const customMatch = customByHash.get(hash);
      let matchType = "unmatched";
      let matchLabel = "No matching Play Pass purchase or custom avatar request found - may need manual follow-up.";
      if (playPassMatch) {
        matchType = "play_pass";
        matchLabel = `Play Pass purchase - ${playPassMatch.username ? "@" + playPassMatch.username : playPassMatch.name || "Player"}`;
      } else if (customMatch) {
        matchType = "custom_avatar";
        matchLabel = `Custom avatar request - ${customMatch.playerName} (Telegram @${customMatch.telegramUsername})`;
      }
      let amountNear = null;
      try {
        const deposit = t.actions_agg?.deposit || t.deposit;
        if (deposit) amountNear = Number(nearAPI.yoctoToNear(deposit, 4)) || null;
      } catch (e) { /* leave null - nearblocks response shape can vary, never worth crashing the whole list over one row */ }
      return {
        txHash: hash,
        fromWallet,
        fromPlayerName: fromWallet ? (nameByWallet.get(fromWallet) || null) : null,
        amountNear,
        blockTimestamp: t.block_timestamp || null,
        matchType,
        matchLabel,
      };
    });

    res.json({ success: true, network: NEAR_NETWORK, revenueWalletAccountId: PLAY_PASS_RECEIVING_ACCOUNT_ID, rows });
  } catch (err) {
    console.error("[ADMIN] /admin/revenue-wallet-history error:", err.message);
    res.status(500).json({ message: "Failed to load wallet history." });
  }
});


// [NEW FEATURE - FUNDS / TRANSACTIONS TAB] PoolRecord IS the fund-safety
// ledger (see its own schema comment) - this just finally surfaces it,
// now enriched with WHO (usernames, not raw wallet ids) and WHAT
// actually happened in plain language, plus how much is actually at
// stake for each pool. ?filter=attention shows only pools a human
// should actually look at right now.
// [NEW FEATURE - TRANSACTIONS TAB] Flattens every pool's txnLog into
// one single chronological feed across the whole game - every money-
// moving (or money-adjacent) event, who it belongs to, what it was
// for, and whether that pool ended in a win/loss/refund for that
// specific account. Built entirely from PoolRecord.txnLog (see its own
// schema comment) rather than re-querying nearblocks per-wallet (which
// the existing player-facing /wallet/history already does, but doing
// that for EVERY wallet that's ever played would be far too slow/rate-
// limited for a single admin page load) - this is the authoritative,
// already-persisted record of every action this app itself initiated
// or witnessed on-chain. Capped to the most recent 300 pools (plenty
// for a game this size right now) rather than a true DB-level
// pagination across the unwound array - simpler, and fast enough at
// today's volume; revisit with a real aggregation pipeline if pool
// count ever gets large enough for this to matter.
app.get("/admin/transactions", requireAdmin, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim().toLowerCase();
    const typeFilter = String(req.query.type || "").trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 40;

    const records = await PoolRecord.find({ "txnLog.0": { $exists: true } })
      .sort({ createdAt: -1 })
      .limit(300)
      .lean();

    // Resolve every accountId referenced across every txnLog entry to a
    // real name in one batch query, same pattern as /admin/funds.
    const allAccountIds = new Set();
    for (const p of records) {
      for (const t of p.txnLog || []) {
        if (t.accountId) allAccountIds.add(t.accountId);
      }
    }
    const players = await Player.find({ _id: { $in: [...allAccountIds] } }, "name username");
    const nameById = new Map(players.map((pl) => [pl._id.toString(), pl.username ? `@${pl.username}` : (pl.name || "Player")]));

    let rows = [];
    for (const p of records) {
      const winnerAccountIds = new Set((p.txnLog || []).filter((t) => t.type === "distribute_prizes").map((t) => t.accountId));
      const stillUnresolved = ["Open", "Locked"].includes(p.state);
      const stuck = stillUnresolved && (!!p.lastSettlementError || (Date.now() - new Date(p.createdAt).getTime()) > 30 * 60 * 1000 || (p.stuckReports || []).some((r) => !r.resolved));
      for (const t of p.txnLog || []) {
        let outcome = null;
        if (t.type === "create_pool" || t.type === "participate") {
          if (p.state === "Distributed") outcome = winnerAccountIds.has(t.accountId) ? "won" : "lost";
          else if (p.state === "Refunded") outcome = "refunded";
          else outcome = "pending";
        } else if (t.type === "distribute_prizes") {
          outcome = "won";
        }
        rows.push({
          type: t.type,
          accountId: t.accountId || null,
          playerName: t.accountId ? (nameById.get(t.accountId) || "Unknown player") : null,
          amountNear: t.amountNear || 0,
          txHash: t.txHash || null,
          note: t.note || null,
          createdAt: t.createdAt,
          onChainPoolId: p.onChainPoolId,
          roomCode: p.roomCode,
          poolState: p.state,
          hostFunded: p.hostFunded,
          outcome,
          stuck,
        });
      }
    }

    if (typeFilter) rows = rows.filter((r) => r.type === typeFilter);

    // [NEW FEATURE - TRANSACTIONS TAB: PLAY PASS + CUSTOM AVATAR ROWS]
    // The feed above only ever covered PoolRecord.txnLog - meaning
    // Play Pass purchases and custom avatar request payments (both real
    // money moving into the game) never showed up here at all. Merged
    // in as their own row types, same shape as every pool row so the
    // frontend can render them identically. Skipped entirely if a type
    // filter is set to something pool-specific, so filtering still
    // works the way it always did.
    if (!typeFilter || typeFilter === "play_pass_purchase") {
      const playPassBuyers = await Player.find(
        { playPassSource: "purchased", playPassTxHash: { $ne: null } },
        "name username playPassTxHash playPassPricePaidNear premiumUntil"
      ).lean();
      for (const buyer of playPassBuyers) {
        rows.push({
          type: "play_pass_purchase",
          accountId: String(buyer._id),
          playerName: buyer.username ? `@${buyer.username}` : (buyer.name || "Player"),
          amountNear: buyer.playPassPricePaidNear || 0,
          txHash: buyer.playPassTxHash,
          note: "Play Pass purchase",
          // No exact purchase timestamp is stored on Player today - the
          // premiumUntil field is set at purchase time for a permanent
          // pass, so it's the closest available proxy for "when".
          createdAt: buyer.premiumUntil || new Date(),
          onChainPoolId: null, roomCode: null, poolState: null, hostFunded: null,
          outcome: null, stuck: false,
        });
      }
    }
    if (!typeFilter || typeFilter === "custom_avatar_payment") {
      const paidRequests = await CustomAvatarRequest.find(
        { paymentTxHash: { $ne: null } },
        "playerId playerName paymentTxHash pricePaidNear createdAt"
      ).lean();
      for (const r of paidRequests) {
        rows.push({
          type: "custom_avatar_payment",
          accountId: String(r.playerId),
          playerName: r.playerName || "Player",
          amountNear: r.pricePaidNear || 0,
          txHash: r.paymentTxHash,
          note: "Custom avatar request payment",
          createdAt: r.createdAt,
          onChainPoolId: null, roomCode: null, poolState: null, hostFunded: null,
          outcome: null, stuck: false,
        });
      }
    }

    if (search) {
      rows = rows.filter((r) =>
        (r.accountId || "").toLowerCase().includes(search) ||
        (r.playerName || "").toLowerCase().includes(search) ||
        (r.roomCode || "").toLowerCase().includes(search) ||
        String(r.onChainPoolId || "").toLowerCase().includes(search) ||
        (r.txHash || "").toLowerCase().includes(search)
      );
    }
    rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const total = rows.length;
    const pageRows = rows.slice((page - 1) * limit, page * limit);
    res.json({ rows: pageRows, total, page, pages: Math.ceil(total / limit) || 1, network: NEAR_NETWORK });
  } catch (err) {
    console.error("[ADMIN] /admin/transactions error:", err.message);
    res.status(500).json({ message: "Failed to load transactions." });
  }
});

// [NEW FEATURE - LEGACY POOL HISTORY] PoolRecord (the Funds ledger)
// only exists going forward from when that feature was built - any
// pool game played BEFORE that has NO PoolRecord at all, so it's
// invisible in the Funds/Transactions tabs no matter what. This is a
// genuine, permanent data gap, not a bug to "fix" outright: MatchRecord
// (the per-player results log) and PoolRecord share no common key at
// all - MatchRecord's own poolId is this app's internal id
// (room.pool.poolId, a "p_..." string), never the real on-chain
// onChainPoolId - so there's no reliable way to reconstruct which
// on-chain pool a historical match even belonged to, and MatchRecord
// never stored who was host either. What CAN be recovered from
// MatchRecord alone is surfaced honestly here: which players were in
// each old pool game, their entry fee/payout/rank, and roughly when -
// grouped by MatchRecord's own internal poolId. No host, no on-chain
// state, no stuck-detection, no refund action possible from this view -
// it's read-only historical context, clearly labeled as such by the
// frontend.
app.get("/admin/funds/legacy-history", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 20;
    const groupIds = await MatchRecord.aggregate([
      { $match: { isPoolGame: true, poolId: { $ne: null } } },
      { $group: { _id: "$poolId", latest: { $max: "$earnedAt" } } },
      { $sort: { latest: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
    ]);
    const totalAgg = await MatchRecord.aggregate([
      { $match: { isPoolGame: true, poolId: { $ne: null } } },
      { $group: { _id: "$poolId" } }, { $count: "total" },
    ]);
    const total = totalAgg[0]?.total || 0;
    const poolIds = groupIds.map((g) => g._id);
    const records = await MatchRecord.find({ poolId: { $in: poolIds } }).sort({ earnedAt: 1 });
    const byPool = {};
    for (const r of records) {
      if (!byPool[r.poolId]) {
        byPool[r.poolId] = { poolId: r.poolId, poolName: r.poolName, roomCode: r.roomCode, participants: [], earliestAt: r.earnedAt, latestAt: r.earnedAt };
      }
      const g = byPool[r.poolId];
      g.participants.push({
        playerName: r.playerName, entryFeeNear: r.entryFeeNear, poolNearWon: r.poolNearWon, poolRank: r.poolRank, won: r.won,
      });
      if (r.earnedAt < g.earliestAt) g.earliestAt = r.earnedAt;
      if (r.earnedAt > g.latestAt) g.latestAt = r.earnedAt;
    }
    const pools = Object.values(byPool).sort((a, b) => new Date(b.latestAt) - new Date(a.latestAt));
    res.json({ pools, total, page, pages: Math.ceil(total / limit) || 1 });
  } catch (err) {
    console.error("[ADMIN] /admin/funds/legacy-history error:", err.message);
    res.status(500).json({ message: "Failed to load legacy pool history." });
  }
});

app.get("/admin/funds", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 25;
    const filter = req.query.filter === "attention" ? fundsNeedsAttentionFilter() : {};
    const [records, total, needsAttentionCount] = await Promise.all([
      PoolRecord.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      PoolRecord.countDocuments(filter),
      PoolRecord.countDocuments(fundsNeedsAttentionFilter()),
    ]);

    // [NEW FEATURE] Resolve every accountId this page references (host
    // + every participant, across every record) to a real name/username
    // in one batch query, rather than raw Mongo ids nobody can read.
    const allAccountIds = new Set();
    for (const p of records) {
      if (p.hostAccountId) allAccountIds.add(p.hostAccountId);
      (p.participantAccountIds || []).forEach((id) => allAccountIds.add(id));
    }
    const players = await Player.find({ _id: { $in: [...allAccountIds] } }, "name username");
    const nameById = new Map(players.map((pl) => [pl._id.toString(), pl.username ? `@${pl.username}` : (pl.name || "Player")]));

    const enriched = records.map((p) => {
      const stillUnresolved = ["Open", "Locked"].includes(p.state);
      const attention = stillUnresolved && (!!p.lastSettlementError || (Date.now() - new Date(p.createdAt).getTime()) > 30 * 60 * 1000);
      const participantCount = (p.onChainParticipantAccountIds || []).length;
      const stuckAmountNear = p.hostFunded ? (p.entryFeeNear || 0) : (p.entryFeeNear || 0) * participantCount;
      return {
        onChainPoolId: p.onChainPoolId,
        roomCode: p.roomCode,
        hostFunded: p.hostFunded,
        hostName: p.hostAccountId ? (nameById.get(p.hostAccountId) || "Unknown player") : null,
        entryFeeNear: p.entryFeeNear,
        maxMatches: p.maxMatches,
        matchesPlayed: p.matchesPlayed,
        state: p.state,
        participantCount,
        participantNames: (p.onChainParticipantAccountIds || []).map((id) => nameById.get(id) || "Unknown player"),
        // Whose money is actually on the line - the host alone if
        // host-funded, everyone who joined otherwise.
        moneyBelongsTo: p.hostFunded ? [p.hostAccountId ? (nameById.get(p.hostAccountId) || "Unknown player") : "Unknown host"] : (p.onChainParticipantAccountIds || []).map((id) => nameById.get(id) || "Unknown player"),
        stuckAmountNear: stillUnresolved ? +stuckAmountNear.toFixed(4) : null,
        createdAt: p.createdAt,
        lockedAt: p.lockedAt,
        settledAt: p.settledAt,
        settlementAttempts: p.settlementAttempts,
        lastSettlementError: p.lastSettlementError,
        lastSettlementErrorExplained: explainSettlementError(p.lastSettlementError),
        lastSettlementAttemptAt: p.lastSettlementAttemptAt,
        // [NEW FEATURE] Player-reported stuck payments - shown
        // regardless of pool state, since a player can report even on
        // an already-Locked/Distributed pool if THEIR OWN entry never
        // worked right, even if the pool overall went fine for others.
        stuckReports: (p.stuckReports || []).map((r) => ({
          accountId: r.accountId,
          playerName: r.playerName,
          reportedAt: r.reportedAt,
          resolved: r.resolved,
          resolvedAt: r.resolvedAt,
          resolutionNote: r.resolutionNote,
        })),
        hasOpenStuckReport: (p.stuckReports || []).some((r) => !r.resolved),
        // A single-participant refund is only ever possible while the
        // contract still allows it - keeps the dashboard from showing a
        // refund button that would just fail on-chain.
        canRefundSingleParticipant: p.state === "Open" && !p.hostFunded,
        attention: attention || (p.stuckReports || []).some((r) => !r.resolved),
        // [NEW FEATURE] Genuinely self-resolved: has an error in its
        // history but is no longer Open/Locked - tells the frontend to
        // show "resolved after retry" instead of a scary red badge.
        selfResolvedAfterError: !stillUnresolved && !!p.lastSettlementError,
      };
    });

    res.json({ records: enriched, total, page, pages: Math.ceil(total / limit), needsAttentionCount });
  } catch (err) {
    console.error("[ADMIN] /admin/funds error:", err.message);
    res.status(500).json({ message: "Failed to load funds." });
  }
});

// [NEW FEATURE - ADMIN MANUAL "RESOLVE NOW"] Lets Om7eth trigger an
// immediate re-check/resolution for one specific still-stuck pool,
// instead of waiting for the next periodic reconcileOrphanedPools pass
// (up to a few minutes away). Reuses the EXACT same verified decision
// logic (reconcileOnePool) - never a separate, less-trusted code path
// for something that moves real money. Refuses to run on anything
// already resolved (Distributed/Refunded) - nothing to do there.
// [FUNDS SAFETY] Reads EVERY pool straight from the contract and lists the
// ones still holding money (Open/Locked) with no live room behind them -
// including very old pools from before PoolRecord tracking existed, which
// the automatic reconcile loop never sees. Read-only.
async function scanChainOrphans() {
  const out = [];
  let misses = 0;
  const records = new Map((await PoolRecord.find({}, "onChainPoolId matchesPlayed state createdAt roomCode poolName").lean()).map((r) => [String(r.onChainPoolId), r]));
  // get_pool returns null for a pool that doesn't exist; a network error must
  // NOT look like that (it would end the scan early), so errors are retried
  // and, if they persist, abort the scan instead of returning a partial list.
  const nearAPI = await loadNearAPI();
  const fallback = NEAR_NETWORK === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com";
  const providers = [...new Set([fallback, NEAR_RPC_URL])].map((url) => new nearAPI.JsonRpcProvider({ url })); // fastnear first: much higher rate limit
  const getPool = async (pool_id) => {
    for (let t = 0; t < 6; t++) {
      try { return await providers[t % providers.length].callFunction({ contractId: POOL_CONTRACT_ACCOUNT_ID, method: "get_pool", args: { pool_id } }); }
      catch (e) { await new Promise((r) => setTimeout(r, 700 * (t + 1))); }
    }
    throw new Error(`couldn't read pool #${pool_id} from the network - try again`);
  };
  if (!POOL_CONTRACT_ACCOUNT_ID) return out;
  // a few at a time - public RPCs rate-limit big bursts
  for (let id = 1; misses < 5 && id < 5000; id += 3) {
    const batch = await Promise.all([0, 1, 2].map((k) => getPool(id + k)));
    for (const p of batch) {
      if (!p) { misses++; continue; }
      misses = 0;
      if (p.state !== "Open" && p.state !== "Locked") continue;
      const key = String(p.id);
      const live = Object.values(rooms).some((r) => r.pool && String(r.pool.onChainPoolId) === key);
      if (live) continue;
      const rec = records.get(key) || null;
      out.push({
        onChainPoolId: key, name: p.name, state: p.state, hostFunded: p.host_funded, hostId: p.host_id,
        participants: p.participants, totalNear: Number(BigInt(p.total_fund) / 10n ** 18n) / 1e6,
        tracked: !!rec, matchesPlayed: rec ? rec.matchesPlayed || 0 : null, roomCode: rec ? rec.roomCode : null,
        action: rec && p.state === "Locked" && (rec.matchesPlayed || 0) > 0 ? "pay out from the last saved standings" : "refund everyone (no finished match on record)",
      });
    }
  }
  return out;
}
// The scan reads every pool from a public RPC, so it's slow: keep the last
// result for 3 minutes, share one running scan, and ?fresh=1 forces a new one.
let chainScan = { at: 0, pools: null, running: null };
app.get("/admin/pools/chain-orphans", requireAdmin, async (req, res) => {
  try {
    const fresh = req.query.fresh === "1";
    if (!fresh && chainScan.pools && Date.now() - chainScan.at < 3 * 60 * 1000) return res.json({ success: true, pools: chainScan.pools, scannedAt: chainScan.at });
    if (!chainScan.running) {
      chainScan.running = scanChainOrphans()
        .then((pools) => { chainScan = { at: Date.now(), pools, running: null }; return pools; })
        .catch((e) => { chainScan.running = null; throw e; });
    }
    const pools = await chainScan.running;
    res.json({ success: true, pools, scannedAt: chainScan.at });
  }
  catch (e) { res.status(500).json({ message: "Couldn't scan the contract: " + e.message }); }
});
app.post("/admin/pools/chain-orphans/:onChainPoolId/resolve", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    const key = String(req.params.onChainPoolId);
    if (Object.values(rooms).some((r) => r.pool && String(r.pool.onChainPoolId) === key)) return res.status(409).json({ message: "A live room is still using this pool." });
    const rec = await PoolRecord.findOne({ onChainPoolId: key });
    const result = rec ? await reconcileOnePool(rec, { force: true }) : { action: "refund", outcome: await cancelPoolOnChain(key) };
    logAdminAction("pool-orphan-resolved", { onChainPoolId: key, action: result.action || null, ok: !!(result.outcome && result.outcome.success) });
    if (chainScan.pools) chainScan.pools = chainScan.pools.filter((p) => p.onChainPoolId !== key || !(result.outcome && result.outcome.success));
    res.json({ success: true, result });
  } catch (e) { res.status(500).json({ message: "Couldn't resolve that pool: " + e.message }); }
});

app.post("/admin/funds/:onChainPoolId/retry", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    const record = await PoolRecord.findOne({ onChainPoolId: req.params.onChainPoolId });
    if (!record) return res.status(404).json({ message: "Pool record not found." });
    if (!["Open", "Locked"].includes(record.state)) {
      return res.status(400).json({ message: "This pool is already resolved (" + record.state + ") - nothing to retry." });
    }
    const result = await reconcileOnePool(record, { force: true });
    logAdminAction("resolve-pool-now", { onChainPoolId: req.params.onChainPoolId, roomCode: record.roomCode, result });
    res.json({ success: true, result });
  } catch (err) {
    console.error("[ADMIN] /admin/funds retry error:", err.message);
    res.status(500).json({ message: "Retry failed - see server logs." });
  }
});

// [NEW FEATURE - SINGLE PARTICIPANT REFUND] Refunds ONE stuck player's
// own entry fee, leaving everyone else in the pool untouched. Only
// valid on a still-Open, non-host-funded pool (contract enforces this
// too - this is just a friendlier pre-check). Automatically marks any
// matching open stuckReports entry for that account as resolved.
app.post("/admin/funds/:onChainPoolId/refund-participant", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    const accountId = String(req.body?.accountId || "").trim();
    if (!accountId) return res.status(400).json({ message: "accountId is required." });
    const record = await PoolRecord.findOne({ onChainPoolId: req.params.onChainPoolId });
    if (!record) return res.status(404).json({ message: "Pool record not found." });
    if (record.state !== "Open") {
      return res.status(400).json({ message: `This pool is ${record.state}, not Open - a single-participant refund isn't possible anymore. Use the pool-wide Retry/Refund instead.` });
    }
    if (record.hostFunded) {
      return res.status(400).json({ message: "Host-funded pools don't have individual entry fees to refund this way." });
    }
    const outcome = await refundParticipantOnChain(req.params.onChainPoolId, accountId);
    if (!outcome.success) {
      return res.status(500).json({ message: outcome.error || "Refund failed on-chain." });
    }
    // [BUG FIX] accountId here is a real NEAR wallet address (matches
    // stuckReports' own convention, and what the contract call above
    // actually needs) - but onChainParticipantAccountIds/
    // participantAccountIds store this app's internal Mongo player id
    // instead (see confirmParticipated), a completely different value.
    // Pulling the wallet address string out of those lists directly
    // would silently match nothing at all. Resolve to the matching
    // player's Mongo id first.
    const refundedPlayer = await Player.findOne({ walletAddress: accountId }, "name username").catch(() => null);
    if (refundedPlayer) {
      await PoolRecord.updateOne(
        { onChainPoolId: req.params.onChainPoolId },
        { $pull: { onChainParticipantAccountIds: String(refundedPlayer._id), participantAccountIds: String(refundedPlayer._id) } }
      );
    }
    await PoolRecord.updateOne(
      { onChainPoolId: req.params.onChainPoolId },
      { $set: { "stuckReports.$[r].resolved": true, "stuckReports.$[r].resolvedAt": new Date(), "stuckReports.$[r].resolutionNote": "Refunded individually by admin." } },
      { arrayFilters: [{ "r.accountId": accountId, "r.resolved": false }] }
    );
    pushTxnLog(req.params.onChainPoolId, { type: "refund_participant", accountId: refundedPlayer ? String(refundedPlayer._id) : null, amountNear: record.entryFeeNear || 0, note: `Single-player admin refund (${accountId}).` });
    logAdminAction("refund-single-participant", {
      onChainPoolId: req.params.onChainPoolId,
      accountId,
      playerName: refundedPlayer ? (refundedPlayer.username ? `@${refundedPlayer.username}` : refundedPlayer.name) : "Unknown player",
      roomCode: record.roomCode,
      amountNear: record.entryFeeNear || 0,
    });
    res.json({ success: true });
  } catch (err) {
    console.error("[ADMIN] refund-participant error:", err.message);
    res.status(500).json({ message: "Refund failed - see server logs." });
  }
});

// [NEW FEATURE] Dismiss a player-reported stuck payment without a
// refund - e.g. after manually confirming on nearblocks that it's
// actually fine, or after the player got sorted out some other way.
app.post("/admin/funds/:onChainPoolId/resolve-stuck-report", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    const accountId = String(req.body?.accountId || "").trim();
    const note = String(req.body?.note || "").slice(0, 500);
    if (!accountId) return res.status(400).json({ message: "accountId is required." });
    await PoolRecord.updateOne(
      { onChainPoolId: req.params.onChainPoolId },
      { $set: { "stuckReports.$[r].resolved": true, "stuckReports.$[r].resolvedAt": new Date(), "stuckReports.$[r].resolutionNote": note || "Marked resolved by admin (no refund)." } },
      { arrayFilters: [{ "r.accountId": accountId, "r.resolved": false }] }
    );
    const reportedPlayer = await Player.findOne({ walletAddress: accountId }, "name username").catch(() => null);
    logAdminAction("resolve-stuck-report", {
      onChainPoolId: req.params.onChainPoolId,
      accountId,
      playerName: reportedPlayer ? (reportedPlayer.username ? `@${reportedPlayer.username}` : reportedPlayer.name) : "Unknown player",
      note,
    });
    res.json({ success: true });
  } catch (err) {
    console.error("[ADMIN] resolve-stuck-report error:", err.message);
    res.status(500).json({ message: "Failed to update." });
  }
});

// ---- ANNOUNCEMENTS (admin CRUD) ----
app.get("/admin/announcements", requireAdmin, async (req, res) => {
  try {
    const announcements = await Announcement.find().sort({ createdAt: -1 }).limit(50);
    res.json({ announcements });
  } catch (err) {
    res.status(500).json({ message: "Failed to load announcements." });
  }
});
app.post("/admin/announcements", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    const { title, body, nameTag, imageUrl, expiresInDays } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ message: "Title is required." });
    const expiresAt = expiresInDays ? new Date(Date.now() + Number(expiresInDays) * 24 * 60 * 60 * 1000) : null;
    const doc = await Announcement.create({
      title: String(title).trim().slice(0, 120),
      body: String(body || "").slice(0, 2000),
      nameTag: String(nameTag || "NEAR Saboteur").trim().slice(0, 40) || "NEAR Saboteur",
      imageUrl: imageUrl ? String(imageUrl).slice(0, 500) : null,
      expiresAt,
    });
    logAdminAction("post-announcement", { announcementId: String(doc._id), title: doc.title, body: doc.body ? doc.body.slice(0, 200) : "" });
    res.json({ success: true, announcement: doc });
  } catch (err) {
    console.error("[ADMIN] create announcement error:", err.message);
    res.status(500).json({ message: "Failed to post announcement." });
  }
});
app.delete("/admin/announcements/:id", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    // [NEW FEATURE] Fetch before deleting so the log can record WHAT was
    // deleted, not just an id that's now meaningless once it's gone.
    const doc = await Announcement.findById(req.params.id);
    await Announcement.deleteOne({ _id: req.params.id });
    logAdminAction("delete-announcement", { announcementId: req.params.id, title: doc?.title || "(unknown)" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete announcement." });
  }
});

// ---- INBOX (admin manual send) ----
app.post("/admin/inbox/send", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    const { playerId, title, body, nameTag, imageUrl } = req.body || {};
    if (!playerId || !title || !String(title).trim()) return res.status(400).json({ message: "playerId and title are required." });
    const player = await Player.findById(playerId, "name username");
    if (!player) return res.status(404).json({ message: "Player not found." });
    const doc = await InboxMessage.create({
      playerId,
      title: String(title).trim().slice(0, 120),
      body: String(body || "").slice(0, 2000),
      nameTag: String(nameTag || "NEAR Saboteur").trim().slice(0, 40) || "NEAR Saboteur",
      imageUrl: imageUrl ? String(imageUrl).slice(0, 500) : null,
      source: "manual",
    });
    logAdminAction("send-inbox-message", {
      playerId,
      playerName: player.username ? `@${player.username}` : player.name,
      title: doc.title,
      body: doc.body ? doc.body.slice(0, 200) : "",
    });
    res.json({ success: true, message: doc });
  } catch (err) {
    console.error("[ADMIN] send inbox message error:", err.message);
    res.status(500).json({ message: "Failed to send message." });
  }
});
app.get("/admin/inbox/:playerId", requireAdmin, async (req, res) => {
  try {
    const messages = await InboxMessage.find({ playerId: req.params.playerId }).sort({ createdAt: -1 }).limit(50);
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ message: "Failed to load messages." });
  }
});
// [NEW FEATURE - INBOX SEND HISTORY] Every message ever sent, across
// every player, newest first - with the recipient's name/username
// joined in so it's actually readable. ?search= matches the
// recipient's name/username (case-insensitive).
app.get("/admin/inbox", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 25;
    const search = String(req.query.search || "").trim();
    let playerIdFilter = null;
    if (search) {
      const matchingPlayers = await Player.find(
        { $or: [{ name: { $regex: rxSafe(search), $options: "i" } }, { username: { $regex: rxSafe(search), $options: "i" } }] },
        "_id"
      );
      playerIdFilter = matchingPlayers.map((p) => p._id);
    }
    const filter = playerIdFilter ? { playerId: { $in: playerIdFilter } } : {};
    if (req.query.source === "manual" || req.query.source === "auto") filter.source = req.query.source;
    const [messages, total] = await Promise.all([
      InboxMessage.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      InboxMessage.countDocuments(filter),
    ]);
    const players = await Player.find({ _id: { $in: messages.map((m) => m.playerId) } }, "name username");
    const nameById = new Map(players.map((p) => [p._id.toString(), { name: p.name, username: p.username }]));
    const enriched = messages.map((m) => ({
      _id: m._id, title: m.title, body: m.body, nameTag: m.nameTag, imageUrl: m.imageUrl,
      read: m.read, createdAt: m.createdAt, source: m.source || "auto",
      recipient: nameById.get(m.playerId.toString()) || { name: "(deleted player)", username: null },
    }));
    res.json({ messages: enriched, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("[ADMIN] /admin/inbox history error:", err.message);
    res.status(500).json({ message: "Failed to load inbox history." });
  }
});
// [BUG FIX - COULDN'T DELETE A SENT MESSAGE] This endpoint simply
// never existed before - the admin dashboard had no way to call it.
app.delete("/admin/inbox/:id", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    const doc = await InboxMessage.findById(req.params.id);
    const recipient = doc ? await Player.findById(doc.playerId, "name username").catch(() => null) : null;
    await InboxMessage.deleteOne({ _id: req.params.id });
    logAdminAction("delete-inbox-message", {
      messageId: req.params.id,
      title: doc?.title || "(unknown)",
      playerName: recipient ? (recipient.username ? `@${recipient.username}` : recipient.name) : "(unknown player)",
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete message." });
  }
});

// ---- LEADERBOARD RESET ----
app.post("/admin/leaderboard/reset", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    const type = req.body && req.body.type === "monthly" ? "monthly" : "weekly";
    await LeaderboardReset.findOneAndUpdate(
      { type }, { type, resetAt: new Date() }, { upsert: true }
    );
    logAdminAction("reset-leaderboard", { type });
    res.json({ success: true, type });
  } catch (err) {
    console.error("[ADMIN] leaderboard reset error:", err.message);
    res.status(500).json({ message: "Failed to reset leaderboard." });
  }
});

// ---- ROOMS (grouped match-activity view) ----
// One entry per permanent room session (see roomSessionId), not one
// per match - click into a room to see every match/player inside it.
// [BUG FIX - 150+ OLDER MATCHES INVISIBLE HERE] Root cause of a real,
// confirmed bug: this used to hard-filter out every MatchRecord with
// roomSessionId===null (baseFilter had { roomSessionId: { $ne: null } })
// - roomSessionId is a newer field (added after roomSessionId's own
// permanent-id feature), so every match played BEFORE that existed has
// it as null and was silently excluded from both the listing AND the
// total count, with no error or indication anything was missing. Uses
// the exact same "legacy:<roomCode>" fallback grouping key the Activity
// tab's own per-player match grouping already established for this
// same gap (see roomSessionId's own comment, ~line 3395) - each
// distinct legacy roomCode becomes its own room entry, same as a real
// session id would, just without a real permanent id behind it.
app.get("/admin/rooms", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 20;
    const search = String(req.query.search || "").trim();
    const baseFilter = {};
    if (search) baseFilter.roomCode = { $regex: rxSafe(search), $options: "i" };
    // Same fallback computed at the DB level - a real roomSessionId
    // when present, "legacy:<roomCode>" otherwise.
    const groupKeyExpr = { $ifNull: ["$roomSessionId", { $concat: ["legacy:", "$roomCode"] }] };

    const sessionsSorted = await MatchRecord.aggregate([
      { $match: baseFilter },
      { $group: { _id: groupKeyExpr, latest: { $max: "$earnedAt" } } },
      { $sort: { latest: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
    ]);
    const groupKeys = sessionsSorted.map((s) => s._id);
    const totalAgg = await MatchRecord.aggregate([
      { $match: baseFilter }, { $group: { _id: groupKeyExpr } }, { $count: "total" },
    ]);
    const total = totalAgg[0]?.total || 0;

    // groupKeys is a mix of real roomSessionIds and "legacy:<roomCode>"
    // strings - split them so the actual query can match each kind
    // correctly (a legacy key was never a real field value stored
    // anywhere, it only exists as this endpoint's own fallback).
    const realSessionIds = groupKeys.filter((k) => !k.startsWith("legacy:"));
    const legacyRoomCodes = groupKeys.filter((k) => k.startsWith("legacy:")).map((k) => k.slice("legacy:".length));
    const records = await MatchRecord.find({
      $or: [
        ...(realSessionIds.length ? [{ roomSessionId: { $in: realSessionIds } }] : []),
        ...(legacyRoomCodes.length ? [{ roomSessionId: null, roomCode: { $in: legacyRoomCodes } }] : []),
      ],
    }).sort({ earnedAt: 1 }).lean();
    const bySession = {};
    for (const r of records) {
      const key = r.roomSessionId || `legacy:${r.roomCode}`;
      if (!bySession[key]) {
        bySession[key] = {
          roomSessionId: key, roomCode: r.roomCode, isPoolGame: r.isPoolGame, poolName: r.poolName,
          // [NEW FEATURE - ROOM TYPE BADGE] Prefer the stored gameMode;
          // for older records written before that field existed, fall
          // back to the best guess isPoolGame alone can offer (can't
          // distinguish Pool vs Paid for those - shown as "Pool/Paid").
          gameMode: r.gameMode || (r.isPoolGame ? null : "free"),
          players: new Set(), matchIds: new Set(), earliestAt: r.earnedAt, latestAt: r.earnedAt,
          // [NEW FEATURE] Flags a legacy-grouped room so the frontend can
          // show a small note explaining why it has no real session id.
          isLegacyGrouping: !r.roomSessionId,
        };
      }
      const s = bySession[key];
      s.players.add(String(r.playerId));
      s.matchIds.add(r.matchId);
      // A room can have matches from before gameMode existed mixed with
      // ones after (if this room stayed open across that change) -
      // prefer any real value over the initial fallback guess.
      if (!s.gameMode && r.gameMode) s.gameMode = r.gameMode;
      if (r.earnedAt < s.earliestAt) s.earliestAt = r.earnedAt;
      if (r.earnedAt > s.latestAt) s.latestAt = r.earnedAt;
    }
    const roomsOut = Object.values(bySession)
      .map((s) => ({
        roomSessionId: s.roomSessionId, roomCode: s.roomCode, isPoolGame: s.isPoolGame, poolName: s.poolName,
        gameMode: s.gameMode || (s.isPoolGame ? "pool_or_paid" : "free"),
        playerCount: s.players.size, matchCount: s.matchIds.size, earliestAt: s.earliestAt, latestAt: s.latestAt,
        isLegacyGrouping: s.isLegacyGrouping,
      }))
      .sort((a, b) => new Date(b.latestAt) - new Date(a.latestAt));

    res.json({ rooms: roomsOut, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("[ADMIN] /admin/rooms error:", err.message);
    res.status(500).json({ message: "Failed to load rooms." });
  }
});
app.get("/admin/rooms/:sessionId", requireAdmin, async (req, res) => {
  try {
    // [BUG FIX] A legacy grouping key ("legacy:<roomCode>") was never a
    // real stored roomSessionId value - querying by it directly would
    // always return nothing. Same split as the listing endpoint above.
    const sessionId = req.params.sessionId;
    const query = sessionId.startsWith("legacy:")
      ? { roomSessionId: null, roomCode: sessionId.slice("legacy:".length) }
      : { roomSessionId: sessionId };
    const matches = await MatchRecord.find(query).sort({ earnedAt: 1 }).lean();

    // [NEW FEATURE - FINAL POOL LEADERBOARD] For a Pool/Paid room, the
    // per-match points table alone doesn't show what actually got PAID
    // OUT - poolRank/poolNearWon only ever land on whichever match was
    // being committed at the moment the pool actually settled (see
    // distributePoolPrizes), so they have to be pulled out and
    // summarized separately here rather than shown as just another
    // match row. One entry per distinct player, keeping their highest-
    // rank/most-recent poolRank-bearing record if they have one.
    let poolSummary = null;
    const gameMode = matches.find((m) => m.gameMode)?.gameMode || (matches.some((m) => m.isPoolGame) ? null : "free");
    if (matches.some((m) => m.isPoolGame)) {
      const byPlayer = new Map();
      for (const m of matches) {
        if (!m.isPoolGame) continue;
        const key = String(m.playerId);
        const existing = byPlayer.get(key);
        // Prefer a record that actually has a poolRank (the real
        // settlement snapshot) over an earlier one that doesn't.
        if (!existing || (m.poolRank != null && existing.poolRank == null) || (m.poolRank != null && m.earnedAt > existing.earnedAt)) {
          byPlayer.set(key, m);
        }
      }
      const entries = [...byPlayer.values()];
      const entryFeeNear = entries.find((e) => e.entryFeeNear != null)?.entryFeeNear || 0;
      const participantCount = entries.length;
      // Host-funded (Pool Game): entryFeeNear already IS the total lump
      // sum. Entry-fee (Paid Game): total is per-player fee × how many
      // actually paid in. See distributePoolPrizes' own comment on why
      // this split matters - entryFeeNear means something different
      // depending on which mode this was.
      const totalPoolNear = gameMode === "pool" ? entryFeeNear : entryFeeNear * participantCount;
      const platformFeeNear = totalPoolNear * 0.05;
      const topFinishers = entries
        .filter((e) => e.poolRank != null)
        .sort((a, b) => a.poolRank - b.poolRank)
        .map((e) => ({ playerName: e.playerName, poolRank: e.poolRank, poolNearWon: e.poolNearWon || 0 }));
      poolSummary = {
        gameMode, entryFeeNear, participantCount, totalPoolNear: +totalPoolNear.toFixed(4),
        platformFeeNear: +platformFeeNear.toFixed(4), topFinishers,
        settled: topFinishers.length > 0,
      };
    }

    res.json({ matches, poolSummary, gameMode });
  } catch (err) {
    res.status(500).json({ message: "Failed to load this room's matches." });
  }
});

// [NEW FEATURE - FREE-TIER BACKUP] MongoDB Atlas M0 has no automated
// backups at all - this is the stopgap: a full JSON export of every
// collection that actually matters, downloadable on demand. Excludes
// password/wallet-key/OTP fields from Player, same redaction as every
// other admin player query in this file.
app.get("/admin/backup/export", requireAdmin, async (req, res) => {
  try {
    const [players, matches, pools, announcements, inbox] = await Promise.all([
      Player.find({}, "-passwordHash -otpCode -walletKeystoreCiphertext -walletKeystoreSalt -walletKeystoreIv -sessionToken").lean(),
      MatchRecord.find({}).lean(),
      PoolRecord.find({}).lean(),
      Announcement.find({}).lean(),
      InboxMessage.find({}).lean(),
    ]);
    res.setHeader("Content-Disposition", `attachment; filename="near-saboteur-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({ exportedAt: new Date(), network: NEAR_NETWORK, players, matches, pools, announcements, inbox });
  } catch (err) {
    console.error("[ADMIN] backup export error:", err.message);
    res.status(500).json({ message: "Backup export failed." });
  }
});

// ---- ADMIN ACTION LOG ----
app.get("/admin/action-log", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 40;
    const [logs, total] = await Promise.all([
      AdminActionLog.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      AdminActionLog.countDocuments(),
    ]);
    res.json({ logs, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ message: "Failed to load the action log." });
  }
});

// ---- SETTINGS (emergency pause) ----
app.get("/admin/settings", requireAdmin, async (req, res) => {
  try {
    const poolsPaused = await getPoolsPaused();
    res.json({ poolsPaused });
  } catch (err) {
    res.status(500).json({ message: "Failed to load settings." });
  }
});
app.post("/admin/settings/pools-paused", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    const value = !!(req.body && req.body.value);
    await AppSettings.findOneAndUpdate({ key: "poolsPaused" }, { key: "poolsPaused", value }, { upsert: true });
    poolsPausedCache = value;
    logAdminAction(value ? "pause-new-pools" : "unpause-new-pools", {});
    res.json({ success: true, poolsPaused: value });
  } catch (err) {
    res.status(500).json({ message: "Failed to update setting." });
  }
});

// ---- CSV EXPORT ----
function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => esc(c.label)).join(",");
  const lines = rows.map((r) => columns.map((c) => esc(typeof c.value === "function" ? c.value(r) : r[c.value])).join(","));
  return [header, ...lines].join("\n");
}
app.get("/admin/export/csv", requireAdmin, async (req, res) => {
  try {
    const type = String(req.query.type || "");
    let csv, filename;
    if (type === "players") {
      const players = await Player.find({}, "name username email walletAddress totalPoints gamesPlayed gamesWon accountHeld").lean();
      csv = toCsv(players, [
        { label: "Name", value: "name" }, { label: "Username", value: "username" }, { label: "Email", value: "email" },
        { label: "Wallet", value: "walletAddress" }, { label: "Total Points", value: "totalPoints" },
        { label: "Games Played", value: "gamesPlayed" }, { label: "Games Won", value: "gamesWon" },
        { label: "Held", value: (r) => (r.accountHeld ? "yes" : "no") },
      ]);
      filename = "players.csv";
    } else if (type === "matches") {
      const matches = await MatchRecord.find({}).sort({ earnedAt: -1 }).limit(5000).lean();
      csv = toCsv(matches, [
        { label: "Player", value: "playerName" }, { label: "Room", value: "roomCode" }, { label: "Role", value: "role" },
        { label: "Won", value: (r) => (r.won ? "yes" : "no") }, { label: "Points", value: "points" },
        { label: "Reduced", value: (r) => (r.reduced ? "yes" : "no") }, { label: "Date", value: (r) => new Date(r.earnedAt).toISOString() },
      ]);
      filename = "matches.csv";
    } else if (type === "funds") {
      const pools = await PoolRecord.find({}).sort({ createdAt: -1 }).lean();
      csv = toCsv(pools, [
        { label: "Pool ID", value: "onChainPoolId" }, { label: "Room", value: "roomCode" }, { label: "State", value: "state" },
        { label: "Host-Funded", value: (r) => (r.hostFunded ? "yes" : "no") }, { label: "Entry Fee (NEAR)", value: "entryFeeNear" },
        { label: "Matches Played", value: "matchesPlayed" }, { label: "Created", value: (r) => new Date(r.createdAt).toISOString() },
        { label: "Settled", value: (r) => (r.settledAt ? new Date(r.settledAt).toISOString() : "") },
        { label: "Last Error", value: "lastSettlementError" },
      ]);
      filename = "funds.csv";
    } else {
      return res.status(400).json({ message: "Unknown export type." });
    }
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error("[ADMIN] CSV export error:", err.message);
    res.status(500).json({ message: "Export failed." });
  }
});

// ---- PLAYER DISPUTES / FEEDBACK ----
app.post("/report", async (req, res) => {
  try {
    const sessionToken = String(req.body.sessionToken || "").trim();
    if (!sessionToken) return res.status(401).json({ message: "Not logged in." });
    const me = await Player.findOne({ sessionToken });
    if (!me) return res.status(401).json({ message: "Session expired." });
    const { type, subject, body } = req.body || {};
    if (!subject || !String(subject).trim()) return res.status(400).json({ message: "Subject is required." });
    const doc = await PlayerReport.create({
      playerId: me._id, playerName: me.name, playerUsername: me.username,
      type: type === "dispute" ? "dispute" : "feedback",
      subject: String(subject).trim().slice(0, 150),
      body: String(body || "").slice(0, 3000),
    });
    res.json({ success: true, report: doc });
  } catch (err) {
    console.error("[REPORT] submit error:", err.message);
    res.status(500).json({ message: "Could not submit - try again." });
  }
});
// [NEW FEATURE - PLAYER SELF-REPORT: STUCK PAYMENT] Reachable from the
// Retry Room Setup screen (see pendingPoolLink/pendingPaidLink in
// game.jsx) when Retry itself keeps failing - flags this specific pool
// + this specific player in PoolRecord.stuckReports, which surfaces
// immediately (no 30-min wait) in the admin Funds tab's "Needs
// Attention" list. Deliberately NOT session-gated on which pool they
// can report - only requires being logged in, since a player who paid
// but never got a working room might not even have a session token
// for that room yet.
app.post("/pools/report-stuck", async (req, res) => {
  try {
    const sessionToken = String(req.body.sessionToken || "").trim();
    if (!sessionToken) return res.status(401).json({ message: "Not logged in." });
    const me = await Player.findOne({ sessionToken });
    if (!me) return res.status(401).json({ message: "Session expired." });
    const onChainPoolId = String(req.body.onChainPoolId || "").trim();
    if (!onChainPoolId) return res.status(400).json({ message: "onChainPoolId is required." });
    const accountId = String(req.body.accountId || me.walletAddress || "").trim();
    if (!accountId) return res.status(400).json({ message: "No wallet address on file for this account." });
    const record = await PoolRecord.findOne({ onChainPoolId });
    if (!record) return res.status(404).json({ message: "We don't have a record of that pool - contact support directly." });
    // Don't add a duplicate open report for the same account+pool if
    // one already exists (e.g. they tapped the button twice).
    const alreadyOpen = (record.stuckReports || []).some((r) => r.accountId === accountId && !r.resolved);
    if (!alreadyOpen) {
      record.stuckReports.push({ accountId, playerName: me.username ? `@${me.username}` : me.name });
      await record.save();
    }
    res.json({ success: true });
  } catch (err) {
    console.error("[POOLS] report-stuck error:", err.message);
    res.status(500).json({ message: "Could not submit - try again." });
  }
});

app.get("/admin/reports", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 25;
    const filter = {};
    if (req.query.type === "dispute" || req.query.type === "feedback") filter.type = req.query.type;
    if (req.query.status === "open" || req.query.status === "resolved") filter.status = req.query.status;
    const [reports, total, openCount] = await Promise.all([
      PlayerReport.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      PlayerReport.countDocuments(filter),
      PlayerReport.countDocuments({ status: "open" }),
    ]);
    res.json({ reports, total, page, pages: Math.ceil(total / limit), openCount });
  } catch (err) {
    res.status(500).json({ message: "Failed to load reports." });
  }
});
app.post("/admin/reports/:id/resolve", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    const report = await PlayerReport.findById(req.params.id);
    if (!report) return res.status(404).json({ message: "Report not found." });
    report.status = "resolved";
    report.adminNote = String(req.body?.note || "").slice(0, 1000);
    // [NEW FEATURE - REPLY ON RESOLVE] replyMode: 'auto' sends a
    // friendly default thanks-message, 'custom' sends whatever text the
    // admin typed, 'skip' sends nothing at all - matches the player's
    // own report right back to them via the same Inbox mechanism
    // already used for pool-win notifications, so it shows up exactly
    // where they'd expect a reply to their own report.
    const replyMode = req.body?.replyMode === "custom" ? "custom" : req.body?.replyMode === "skip" ? "skip" : "auto";
    let replyText = null;
    if (replyMode === "auto") {
      replyText = report.type === "dispute"
        ? "Thanks for reaching out - we've looked into this and it's been resolved. Reach out again if anything still seems off!"
        : "Thanks for the feedback - we really appreciate you taking the time to share it!";
    } else if (replyMode === "custom") {
      replyText = String(req.body?.replyText || "").trim().slice(0, 1000) || null;
    }
    report.replySentText = replyText;
    await report.save();
    if (replyText) {
      sendInboxMessage(String(report.playerId), { title: report.type === "dispute" ? "Re: your report" : "Re: your feedback", body: replyText });
    }
    logAdminAction("resolve-report", {
      reportId: String(report._id),
      type: report.type,
      playerName: report.playerUsername ? `@${report.playerUsername}` : report.playerName,
      subject: report.subject,
      replySent: !!replyText,
      replyText: replyText || null,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to update report." });
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
    return {
      accountId: player._id.toString(), accountEmail: player.email, accountUsername: player.username || "", hasLegionBadge: !!player.hasLegionBadge,
      // [NEW FEATURE - PLAY PASS] Cached at room-join time, same pattern
      // as hasLegionBadge above - this is what lets a room's other
      // players see this player's premium avatar skin without every
      // client needing its own database lookup. See
      // resolveAvatarVariantForRoom for how this actually gets applied
      // to a room.players[...] entry (it's never trusted blindly - the
      // chosen variant always has to match the player's current avatarId
      // color too).
      hasPlayPass: !!(player.premiumUntil && player.premiumUntil.getTime() > Date.now()),
      activePremiumAvatarVariant: player.activePremiumAvatarVariant || null,
    };
  } catch (e) {
    console.error("[POINTS] resolveAccountFromToken failed:", e.message);
    return null;
  }
}

// [NEW FEATURE - PLAY PASS] Single choke point for deciding what
// avatarVariantId (if any) a room.players[...] entry should get -
// called from every place a player object is created or their avatarId
// changes. Deliberately conservative: returns null (falls back to the
// plain avatar) unless the account genuinely has an active Play Pass
// AND the variant actually belongs to the color they're using right
// now. This is purely a DISPLAY field - it's never read by any
// gameplay/lock logic, so getting it wrong can never affect who can
// select which avatarId slot.
function resolveAvatarVariantForRoom(account, avatarId) {
  if (!account || !account.hasPlayPass || !account.activePremiumAvatarVariant) return null;
  const variant = getPremiumVariant(account.activePremiumAvatarVariant);
  if (!variant || variant.baseAvatarId !== avatarId) return null;
  return variant.id;
}
// [NEW FEATURE - PLAY PASS] Same validation as resolveAvatarVariantForRoom
// above, just taking a raw Player mongoose document/lean-object directly -
// used by the global leaderboard endpoints, which read straight from
// Player rather than going through a room/account shape.
function avatarVariantForPlayerDoc(p) {
  if (!p) return null;
  const hasPlayPass = !!(p.premiumUntil && new Date(p.premiumUntil).getTime() > Date.now());
  return resolveAvatarVariantForRoom({ hasPlayPass, activePremiumAvatarVariant: p.activePremiumAvatarVariant || null }, p.avatarId);
}
// [NEW FEATURE - PLAY PASS] Companion to avatarVariantForPlayerDoc - the
// raw hasPlayPass flag itself, for the "Sigil Prefix" name tag styling
// (which applies regardless of whether a premium avatar skin happens to
// be active right now).
function hasPlayPassForPlayerDoc(p) {
  return !!(p && p.premiumUntil && new Date(p.premiumUntil).getTime() > Date.now());
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
// [BUG FIX - DUPLICATE SEATS] A player whose connection dropped (phone killed
// the browser, app reopened, new tab) and who comes back through JOIN rather
// than the automatic reconnect used to get a second seat, while the old one
// sat there as "(reconnecting...)" for the whole grace window. Same account,
// same lobby -> the old disconnected seat is dropped first. Returns true if
// that old seat was the host, so the new one can keep host power.
function dropStaleSeatsForAccount(room, accountId, keepSocketId) {
  if (!room || !accountId || room.gameStarted) return false;
  let wasHost = false;
  for (const [sid, p] of Object.entries(room.players)) {
    if (sid !== keepSocketId && p.accountId === accountId && p.disconnectedAt) {
      if (p.isHost) wasHost = true;
      delete room.players[sid];
    }
  }
  return wasHost;
}

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
  // [AI BOTS] Defensive: a bot can never be host, even if a caller
  // passes a list that still includes bots.
  const humanIds = remainingIds.filter((id) => room.players[id] && !room.players[id].isBot);
  if (humanIds.length) remainingIds = humanIds;
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
  // [POOL v2] a pool host who isn't playing doesn't take the lobby back - anyone can run it
  const creatorId = room.pool ? (room.pool.hostRole && room.pool.hostRole !== "play" ? null : room.pool.hostAccountId) : room.creatorAccountId;
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
  // [UPDATE - DISABLED FOR NOW, PER OM7ETH] Game just launched - no real
  // farming concern yet, and this was actively confusing the "why don't
  // my Activity points match what I saw in-game" investigation. Flip
  // this back to true later if farming actually becomes a problem -
  // pointsMatchesToday is still tracked either way (see
  // commitPendingPoints below), so re-enabling needs nothing else
  // changed here. The admin-dashboard farm-detection view Om7eth wants
  // (flagging any single player who's unusually often placing top-3 /
  // repeatedly maxing out points) is a separate, later feature - not
  // this toggle.
  dailyLimitEnabled: false,
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
    // [BUG FIX - UNDERCOUNTED MISSION POINTS AT MATCH END] missionsDone
    // is deliberately rate-limited to +1 every MIN_MISSION_COMPLETE_
    // INTERVAL_MS (see applyMissionCatchUp) - a player who legitimately
    // finished 2+ missions close together can have a still-in-progress
    // catch-up timer at the exact moment the round ends (e.g. the
    // Saboteur wins by elimination, or gets voted out, right after that
    // player's last couple of missions). Since stagePendingPointsForRoom
    // snapshots points immediately when the round ends, reading
    // missionsDone alone here would understate their real, already-
    // verified progress. pendingMissionsDone is that verified target
    // (never trusts anything beyond what a legitimate report already
    // established) - using whichever is higher gives the player full,
    // correct credit without reopening any of the original exploit this
    // rate limit exists to prevent.
    const realMissionsDone = Math.max(player.missionsDone || 0, player.pendingMissionsDone || 0);
    const missionsCounted = Math.min(realMissionsDone, c.maxMissionsCounted);
    total += missionsCounted * c.perMission;
    if (realMissionsDone >= (player.missionsTotal || Infinity) && (player.missionsTotal || 0) > 0) {
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
  Object.entries(room.players).forEach(([pid, p]) => {
    if (!p.accountId) { p.pendingPoints = 0; return; } // guest - never staged, never committed
    // [$SABOTEUR] + backed-vote results (right +5 / wrong -5), never below 0
    if (p.spectator) { p.pendingPoints = 0; return; } // [POOL v2] a watching host earns nothing
    p.pendingPoints = Math.max(0, computeMatchPoints(p, room.winner) + economy.backDelta(room, pid));
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
    lbEntry.matches.push({
      matchId: room.currentMatchId || "", points: p.pendingPoints,
      // [PER-MATCH STATS] what the player actually did in this match - shown in the lobby standings
      role: p.role || null, won: !!p.pendingWon, survived: !!p.alive,
      missionsDone: Math.max(p.missionsDone || 0, p.pendingMissionsDone || 0), missionsTotal: p.missionsTotal || 0,
      kills: p.killsCount || 0, meetingsSurvived: p.meetingsSurvivedCount || 0, sabotages: p.sabotageActionsCount || 0,
    });
    lbEntry.totalPoints += p.pendingPoints;
  });
  // [POOL GAMES] One match in this pool just ended - advance the count.
  // Once matchesPlayed reaches maxMatches, the frontend shows the final
  // leaderboard with a "Confirm" button for every participant (no wallet
  // signature - just an in-app click) - see confirmFinalResult for what
  // happens once everyone has.
  if (room.pool && room.pool.state === "Locked") {
    room.pool.matchesPlayed += 1;
    // [NEW FEATURE - FUNDS SAFETY: PERSISTENT POOL TRACKING] The most
    // important write in the whole PoolRecord mechanism - this is what
    // lets a real, already-earned result survive a server restart
    // instead of just becoming a stuck Locked pool with no memory of
    // who actually won.
    savePoolRecord({ onChainPoolId: room.pool.onChainPoolId }, {
      matchesPlayed: room.pool.matchesPlayed,
      leaderboardSnapshot: room.pool.leaderboard,
    });
    // [AUTO SETTLE] The server already counts every point, so nobody has to
    // confirm anything any more: the pool pays out on its own a short moment
    // after the last match (enough to see the result screen).
    if (room.pool.matchesPlayed >= room.pool.maxMatches) scheduleAutoSettle(room);
    else scheduleIdleSettle(room); // [EARLY END] next match must start within 10 min
    saveManualPool(room.pool, { matchesPlayed: room.pool.matchesPlayed, leaderboard: room.pool.leaderboard, players: manualPoolPlayers(room) }); // survives a restart
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

// [NEW FEATURE - MONTHLY LEADERBOARD] Same idea as getCurrentWeekStartUTC
// above, but for "the 1st of this calendar month, IST midnight" - so the
// monthly leaderboard resets at the same real-world moment every month
// (IST midnight on the 1st), consistent with the weekly board's own
// IST-anchored reset.
function getCurrentMonthStartUTC() {
  const now = new Date();
  const istShiftMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istShiftMs);
  const istMonthStart = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), 1, 0, 0, 0, 0));
  return new Date(istMonthStart.getTime() - istShiftMs); // back to real UTC
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
    room.roomLeaderboard[accountId] = { accountId, username: username || "", matches: [], totalPoints: 0, leftName: null, leftAvatarId: null, leftHasLegionBadge: false, leftAvatarVariantId: null, leftHasPlayPass: false };
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
function snapshotRoomLeaderboardOnDeparture(room, accountId, name, avatarId, hasLegionBadge, avatarVariantId, hasPlayPass) {
  if (!accountId || !room.roomLeaderboard || !room.roomLeaderboard[accountId]) return;
  const entry = room.roomLeaderboard[accountId];
  if (entry.totalPoints > 0) {
    entry.leftName = name;
    entry.leftAvatarId = avatarId;
    entry.leftHasLegionBadge = !!hasLegionBadge;
    entry.leftAvatarVariantId = avatarVariantId || null;
    entry.leftHasPlayPass = !!hasPlayPass;
  } else {
    delete room.roomLeaderboard[accountId];
  }
}

// Builds the actual display list: still-present players get their LIVE
// name/avatar (so a mid-room rename/avatar-change reflects immediately,
// per the planning notes), departed-but-remembered players get their
// frozen leftName/leftAvatarId snapshot instead. Sorted highest total
// first - this sort order IS the leaderboard ranking.
// [NEW FEATURE - MISSION PROGRESS ON RETURN TO LOBBY] Captures each
// crewmate's final missionsDone/missionsTotal for the match that just
// ended, right before the returnToLobby/playAgainSameRoom reset wipes
// those fields for the next match. Saboteurs never have missions, so
// they're naturally excluded (role !== "crewmate"). Stored on the room
// so a late-arriving client (reconnect/restore) can still see it too,
// not just whoever happened to be connected the instant it was captured.
function snapshotMatchMissionsSummary(room) {
  const summary = Object.values(room.players)
    .filter((p) => p.role === "crewmate" && typeof p.missionsTotal === "number" && p.missionsTotal > 0)
    .map((p) => ({
      accountId: p.accountId || null,
      name: p.name,
      avatarId: p.avatarId,
      missionsDone: Math.min(p.missionsDone || 0, p.missionsTotal),
      missionsTotal: p.missionsTotal,
    }));
  room.lastMatchMissions = summary;
}

function getRoomLeaderboardList(room) {
  if (!room.roomLeaderboard) return [];
  const list = Object.values(room.roomLeaderboard).map((entry) => {
    const livePlayer = Object.values(room.players).find((p) => p.accountId === entry.accountId);
    return {
      accountId: entry.accountId,
      username: entry.username,
      name: livePlayer ? livePlayer.name : entry.leftName,
      avatarId: livePlayer ? livePlayer.avatarId : entry.leftAvatarId,
      // [NEW FEATURE - PLAY PASS] Live variant if still present,
      // otherwise whatever was last known when they left - same pattern
      // as hasLegionBadge right below.
      avatarVariantId: livePlayer ? (livePlayer.avatarVariantId || null) : entry.leftAvatarVariantId,
      // [NEW FEATURE - PLAY PASS] Same live-vs-frozen pattern as
      // avatarVariantId/hasLegionBadge - drives the room leaderboard's
      // own "Sigil Prefix" name tag.
      hasPlayPass: livePlayer ? !!livePlayer.hasPlayPass : !!entry.leftHasPlayPass,
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
    const isReducedMatch = POINTS.dailyLimitEnabled && player.pointsMatchesToday >= POINTS.dailyFullPointsMatches;
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
        // [BUG FIX] See this schema field's own comment - preserves the
        // true un-reduced total so Activity can explain any gap instead
        // of just silently showing a smaller number.
        rawPoints: matchPoints,
        // [BUG FIX] See this schema field's own comment - the bonus
        // mission's own points were always already folded into
        // matchPoints/awardedPoints above, this just makes that portion
        // separately visible afterward.
        bonusMissionPoints: meta.bonusMissionPoints || 0,
        bonusMissionDone: !!meta.bonusMissionDone,
        bonusMissionResult: meta.bonusMissionResult || null,
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
        // [ACTIVITY FIX] gameMode was passed in but never saved, so Activity
        // couldn't tell a host-funded Pool game from an entry-fee Paid game.
        gameMode: meta.gameMode || null,
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
    // [BUG FIX] See the schema field's own comment - these were being
    // tracked in-memory the whole time (and already correctly counted
    // toward matchPoints via computeMatchPoints) but never actually
    // persisted anywhere, so they could never be shown back to the
    // player afterward.
    bonusMissionPoints: me.bonusMissionPoints || 0,
    bonusMissionDone: !!me.bonusMissionDone,
    bonusMissionResult: me.bonusMissionResult || null,
    poolId: room.pool ? room.pool.onChainPoolId : null,
    poolName: room.pool ? room.pool.poolName : null,
    isPoolGame: !!room.pool,
    // Prefer the room's own live gameMode (covers free/pool/paid and
    // any future mode like sponsor) - falls back to deriving it from
    // room.pool for any code path that hasn't set room.gameMode.
    gameMode: room.gameMode || (room.pool ? (room.pool.hostFunded ? "pool" : "paid") : "free"),
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
    // [NEW FEATURE - PLAY PASS] The active premium skin id (e.g.
    // 'blackdragon'), or null - already validated at the moment it was
    // set (see resolveAvatarVariantForRoom / updateAvatarVariant), so
    // the frontend can just resolve+render it directly without
    // re-checking anything itself.
    avatarVariantId: p.avatarVariantId || null,
    isHost: p.isHost,
    spectator: !!p.spectator, // [POOL v2] watching pool host - not in the match
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
    // [BUG FIX - IDENTITY LEAK] Previously trusted p.disguiseAvatarId
    // blindly forever - if the explicit end-of-disguise events
    // (endDisguise from the Saboteur's own client, or the server's own
    // 15s safety-net timer) were EVER missed by a specific observer
    // (e.g. their socket briefly dropped at exactly the wrong moment,
    // or a background/throttled mobile tab delayed their own timer),
    // that one player's screen could keep showing the disguise
    // indefinitely - a real Saboteur-identity leak risk, not just a
    // cosmetic glitch. Every broadcast now independently re-checks the
    // real expiry (disguiseActiveUntil) against the current time, so
    // even a fully missed clear-event self-heals the very next time
    // this player list is sent for ANY reason (join, leave, profile
    // update, reconnect) - it can never show an already-expired
    // disguise as still active, regardless of what happened to the
    // explicit clear events.
    disguiseAvatarId: (p.disguiseAvatarId && p.disguiseActiveUntil && p.disguiseActiveUntil > Date.now()) ? p.disguiseAvatarId : null,
    // [NEW FEATURE - PLAY PASS] The disguise's borrowed premium skin (if
    // the impersonated player has one active) - resolved server-side at
    // the moment the disguise was activated, see activateDisguise.
    disguiseAvatarVariantId: (p.disguiseAvatarId && p.disguiseActiveUntil && p.disguiseActiveUntil > Date.now()) ? (p.disguiseAvatarVariantId || null) : null,
    // [NEW FEATURE - PLAY PASS] Own real Play Pass status - drives the
    // "Sigil Prefix" name tag styling wherever this player's name is
    // shown. Kept separate from the disguise-aware field below, same
    // pattern as avatarId/disguiseAvatarId - a render site picks
    // whichever one is actually relevant to it.
    hasPlayPass: !!p.hasPlayPass,
    // [NEW FEATURE - PLAY PASS] Whether the player CURRENTLY BEING
    // IMPERSONATED (via disguise) has Play Pass - resolved server-side
    // at the moment the disguise was activated (see activateDisguise),
    // same "genuine impersonation" principle as disguiseAvatarVariantId
    // right above. Only meaningful while disguiseAvatarId is non-null.
    disguiseHasPlayPass: (p.disguiseAvatarId && p.disguiseActiveUntil && p.disguiseActiveUntil > Date.now()) ? !!p.disguiseHasPlayPass : false,
    // [NEW FEATURE] Lets a client run its OWN local safety-net timer for
    // another player's disguise (mirroring the exact same pattern the
    // Saboteur's own client already uses for itself) - so even a
    // completely missed playerDisguiseEnded broadcast still visually
    // clears on time locally, without waiting for the next player-list
    // sync.
    disguiseEndsAt: (p.disguiseAvatarId && p.disguiseActiveUntil && p.disguiseActiveUntil > Date.now()) ? p.disguiseActiveUntil : null,
    // [NEW FEATURE] Whether this player has personally pressed "Return
    // to Lobby" after the last game ended - lets the Lobby's
    // player-list show who's actually back and ready, vs who's still on
    // their old win-screen.
    // [AI BOTS] Bots are always "in the Lobby" whenever no match is
    // running (they have no client to send returnToLobby).
    inLobbyView: p.isBot ? !room.gameStarted : (p.inLobbyView || false),
    // [AI BOTS] Lets every client show the BOT tag.
    isBot: !!p.isBot,
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
  snapshotRoomLeaderboardOnDeparture(oldRoom, oldRoom.players[socket.id].accountId, oldRoom.players[socket.id].name, oldRoom.players[socket.id].avatarId, oldRoom.players[socket.id].hasLegionBadge, oldRoom.players[socket.id].avatarVariantId, oldRoom.players[socket.id].hasPlayPass);
  delete oldRoom.players[socket.id];
  socket.leave(oldRoomCode);

  const remaining = bots.humansRemainingAfterLeave(oldRoom); // [AI BOTS] humans only - an all-bot room counts as empty, and a bot can never be picked as host
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
    .map((p) => ({ name: p.name, avatarId: p.avatarId, avatarVariantId: p.avatarVariantId || null, hasPlayPass: !!p.hasPlayPass, kills: p.killsCount || 0 }));
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
    stagePendingPointsForRoom(room); bots.onMatchEnd(roomCode, room); // [AI BOTS] learn from the match // [POINTS SYSTEM STEP 2] must happen now, before gameOver - see the comment on stagePendingPointsForRoom
    economy.settleMatch({ io, roomCode, room, computePoints: computeMatchPoints, hasDb: !!MONGODB_URI }); // [$SABOTEUR] rank rewards
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
    stagePendingPointsForRoom(room); bots.onMatchEnd(roomCode, room); // [AI BOTS] learn from the match // [POINTS SYSTEM STEP 2]
    economy.settleMatch({ io, roomCode, room, computePoints: computeMatchPoints, hasDb: !!MONGODB_URI }); // [$SABOTEUR] rank rewards
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
    stagePendingPointsForRoom(room); bots.onMatchEnd(roomCode, room); // [AI BOTS] learn from the match // [POINTS SYSTEM STEP 2]
    economy.settleMatch({ io, roomCode, room, computePoints: computeMatchPoints, hasDb: !!MONGODB_URI }); // [$SABOTEUR] rank rewards
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
      room.players[eliminatedId].ejected = true;
      // [AI BOTS] public record of who was voted out and what they really were (everyone sees the reveal)
      (room.ejections = room.ejections || []).push({ name: room.players[eliminatedId].name, role: room.players[eliminatedId].role, meetingNo: room.meetingNo || 0 });
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
        delete room.players[eliminatedId].disguiseAvatarVariantId;
        delete room.players[eliminatedId].disguiseHasPlayPass;
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
    eliminatedAvatarVariantId: eliminatedId ? (room.players[eliminatedId]?.avatarVariantId || null) : null,
    eliminatedHasPlayPass: eliminatedId ? !!room.players[eliminatedId]?.hasPlayPass : false,
    // [MATCH MOMENTS] "1 Saboteur still on board" on the ejection screen - a count only, never who
    saboteursLeft: eliminatedId ? Object.entries(room.players).filter(([id, p]) => p.role === "saboteur" && p.alive !== false && id !== eliminatedId).length : null,
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
        postKillReportLockUntil: p.postKillReportLockUntil || 0,
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

// [NEW FEATURE - HOST CONTROL PANEL SPEED SLIDER] speedLevel now stores
// the actual movement MULTIPLIER directly (0.5x-2x) instead of an
// integer 2-6 "level" that the frontend had to divide by 2 to turn into
// a real multiplier. Only 7 exact stops are ever valid - snapToSpeedStep
// clamps/snaps ANY incoming number (including a tampered client's) to
// the nearest one, so room.speedLevel can never end up holding anything
// else. 1 (100%) stays the default, matching the old level-4 default.
const SPEED_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
function snapToSpeedStep(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  let closest = SPEED_STEPS[0];
  let minDiff = Math.abs(value - closest);
  for (const step of SPEED_STEPS) {
    const diff = Math.abs(value - step);
    if (diff < minDiff) { minDiff = diff; closest = step; }
  }
  return closest;
}

// [AI BOTS] Extracted from the killPlayer socket handler so server-side
// bots go through EXACTLY the same checks as humans (range, cooldown,
// meeting, vent, roles). Returns null on success or { message } on error.
// [CHAT REDESIGN] One meeting-chat history for the whole match: every
// meeting adds a divider, every message and "X voted" line is kept, so the
// discussion from earlier meetings stays visible until the match ends.
// Cleared at game start / return to lobby, like ghost chat.
const MATCH_CHAT_MAX = 400;
function pushMatchChat(room, entry) {
  room.matchChat = room.matchChat || [];
  room.matchChat.push(entry);
  if (room.matchChat.length > MATCH_CHAT_MAX) room.matchChat.splice(0, room.matchChat.length - MATCH_CHAT_MAX);
}

function performKill(roomCode, killerId, targetId) {
  const room = rooms[roomCode];
  if (!room) return;
  // [BUG FIX] Reject any game action once the game has already ended -
  // see the comment above this handler for why.
  if (room.winner || !room.gameStarted) {
    return { message: "The game has already ended." };
  }

  const killer = room.players[killerId];
  const target = room.players[targetId];

  // Security checks - the server verifies this itself, never trusting the client
  if (!killer || killer.role !== "saboteur") {
    return { message: "You are not the Saboteur." };
  }
  // [BUG FIX] No kill checks ever stopped this from happening DURING an
  // active meeting (alarm/chat/voting) - everyone's frozen on the
  // meeting screen at that point and shouldn't be killable at all, same
  // as Among Us. A modified client could otherwise sneak a kill in
  // mid-discussion.
  if (room.meeting) {
    return { message: "Cannot kill during a meeting." };
  }
  // [BUG FIX] Same logic as the meeting-block above - a Saboteur who's
  // currently inside a vent (between an 'enter' and matching 'exit')
  // shouldn't be able to kill, since they're supposed to be physically
  // tucked away in the walls at that moment, not standing next to
  // anyone.
  if (killer.inVent) {
    return { message: "Cannot kill while inside a vent." };
  }
  if (!killer.alive) {
    return { message: "You are already dead." };
  }
  if (!target || !target.alive) {
    return { message: "Target is not valid." };
  }
  if (target.role === "saboteur") {
    return { message: "The Saboteur cannot kill another Saboteur." };
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
    return { message: "Target is too far away." };
  }
  // Server-side cooldown enforcement (20s) - mirrors the client's own
  // KILL_COOLDOWN_MS, but checked here too so a modified client can't
  // bypass the cooldown by just not enforcing it locally.
  // [UPDATE] Standardized to 20s (was 25s) to match the same cooldown
  // now also applied at game start and at the end of every meeting -
  // one consistent number everywhere, per Om7eth's explicit request.
  const now = Date.now();
  if (killer.killCooldownUntil && now < killer.killCooldownUntil) {
    return { message: "Kill is still on cooldown." };
  }
  killer.killCooldownUntil = now + 20000;
  // [BUG FIX] Server-side mirror of the frontend's postKillLockUntil
  // (20s sabotage lockdown after any kill) - set here so the
  // server-side sabotage check above can actually enforce it too,
  // not just block based on its own independent cooldown.
  killer.postKillSabotageLockUntil = now + 20000;
  // [NEW FEATURE - SABOTEUR CAN NOW REPORT BODIES] Saboteurs can report
  // a dead body themselves now (see callMeeting), but reporting the
  // instant after a kill would be an obvious fake-alibi exploit - stand
  // over the body, kill, immediately report, look like you "found" it.
  // This 15s lockout (server-authoritative, checked in callMeeting)
  // forces a believable gap before the killer themself can be the one
  // to call it in.
  killer.postKillReportLockUntil = now + 15000;
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
  if (room.saboteurAtRiskId && room.saboteurAtRiskId !== killerId) {
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
  io.to(killerId).emit("playerKilled", { targetId, killerId: killerId });
  io.to(targetId).emit("playerKilled", { targetId, killerId: killerId });
  // [BUG FIX] A player who just died had no way to see ghost chat
  // history from before their death - they'd only get messages going
  // forward via the live listener. Send them the existing backlog now.
  io.to(targetId).emit("ghostChatBacklog", { messages: room.ghostChat || [] });

  // Everyone else (and the killer/victim too) gets the body's raw
  // position/avatar data so it can render on their map once they're
  // close enough to see it for themselves — same as how any other
  // player's position is just data, not an announcement.
  io.to(roomCode).except(killerId).emit("bodyDropped", {
    bodyOwnerId: targetId,
    x: target.bodyX,
    y: target.bodyY,
    avatarId: target.avatarId,
    avatarVariantId: target.avatarVariantId || null,
  });

  console.log(`${target.name} was killed by ${killer.name} in room ${roomCode}`);

  // [WIN CONDITION] A kill can immediately end the game if crewmates
  // are now too few relative to Saboteurs - check right away rather
  // than waiting for the next meeting.
  // [AI BOTS] let bots that could see this happen remember it
  bots.onKill(roomCode, killerId, targetId);

  checkWinCondition(roomCode);
  return null;
}

// [AI BOTS] Extracted from the sabotageAction socket handler (same rules
// for humans and bots). Returns null on success or { message } on error.
function performSabotage(roomCode, playerId, type) {
  const room = rooms[roomCode];
  if (!room) return;
  // [BUG FIX] Same post-game-end guard as killPlayer.
  if (room.winner || !room.gameStarted) {
    return { message: "The game has already ended." };
  }

  const player = room.players[playerId];

  if (!player || player.role !== "saboteur") {
    return { message: "You are not the Saboteur." };
  }
  if (!player.alive) {
    return { message: "You are already dead." };
  }
  // [BUG FIX] Same fix as killPlayer - sabotage shouldn't be triggerable
  // while everyone's frozen in an active meeting either.
  if (room.meeting) {
    return { message: "Cannot sabotage during a meeting." };
  }
  if (player.inVent) {
    return { message: "Cannot sabotage while inside a vent." };
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
    return { message: "Invalid sabotage type." };
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
    return { message: "No uses left for that sabotage." };
  }
  if (player.sabotageCooldownUntil && now < player.sabotageCooldownUntil) {
    return { message: "Sabotage is on cooldown." };
  }
  // Same post-kill lockdown the frontend enforces (20s after any kill,
  // tracked separately from postKillLockUntil there - mirrored here as
  // its own field so the server doesn't need to cross-reference the
  // kill-cooldown timer for an unrelated rule).
  if (player.postKillSabotageLockUntil && now < player.postKillSabotageLockUntil) {
    return { message: "Sabotage actions are locked out after a recent kill." };
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
  // `triggeredBy: playerId` - since only the Saboteur can ever
  // trigger a sabotage, broadcasting that id to the WHOLE room
  // (crewmates included) directly exposed the Saboteur's identity to
  // anyone who opened their browser's network inspector, regardless of
  // whether any current UI code happened to render it. No client logic
  // actually needs this field - removed entirely.
  io.to(roomCode).emit("sabotageTriggered", { type });

  console.log(`Sabotage "${type}" triggered by ${player.name} in room ${roomCode}`);
  return null;
}

// [AI BOTS] Extracted from the callMeeting socket handler so bots can
// report bodies / call meetings under the same rules as humans. Returns
// null on success or { message, cooldownRemainingMs? } on error.
function startMeeting(roomCode, callerId, reason, reportedBodyId) {
  const room = rooms[roomCode];
  if (!room) return;
  // [BUG FIX] Same post-game-end guard as killPlayer/sabotageAction.
  if (room.winner || !room.gameStarted) {
    return { message: "The game has already ended." };
  }

  const caller = room.players[callerId];
  if (!caller || !caller.alive) {
    return { message: "You cannot call a meeting." };
  }
  // [BUG FIX] A Saboteur mid-vent-travel is supposed to be hidden in
  // the walls, not physically present to slam an emergency button -
  // same consistency fix as blocking kills/sabotage while inVent.
  if (caller.inVent) {
    return { message: "Cannot call a meeting while inside a vent." };
  }

  if (room.meeting) {
    return { message: "A meeting is already in progress." };
  }

  // [NEW FEATURE - SABOTEUR CAN NOW REPORT BODIES] Saboteurs are now
  // allowed to report a body themselves (previously crewmate-only on
  // the frontend) - but only 15s after their own most recent kill, so
  // they can't stand over a body, kill, and instantly "find" it as a
  // fake alibi. Only applies to actually reporting a body (reason ===
  // "report"); self-called emergency meetings are unaffected. Checked
  // here server-side (not just hidden client-side) so a modified
  // client can't skip the wait.
  if (reason === "report" && caller.role === "saboteur" && caller.postKillReportLockUntil && Date.now() < caller.postKillReportLockUntil) {
    return {
      message: "You must wait before reporting this body.",
      cooldownRemainingMs: caller.postKillReportLockUntil - Date.now(),
    };
  }

  // Discussion cooldown: no meeting can be called within 30s of the
  // game starting, or within 30s of the previous meeting ending. This
  // is tracked on the room itself (meetingCooldownUntil), set both when
  // the game starts and whenever a meeting's voting resolves (see
  // finalizeVoting).
  const now = Date.now();
  if (room.meetingCooldownUntil && now < room.meetingCooldownUntil) {
    return {
      message: "Discussion is on cooldown.",
      cooldownRemainingMs: room.meetingCooldownUntil - now,
    };
  }

  room.meetingNo = (room.meetingNo || 0) + 1;
  {
    const bodyP = reportedBodyId && room.players[reportedBodyId];
    pushMatchChat(room, {
      kind: "sep", meetingNo: room.meetingNo, reason: reason || "self",
      callerName: caller.name, bodyName: bodyP ? bodyP.name : null, timestamp: Date.now(),
    });
  }
  room.meeting = {
    stage: "alarm",
    startedAt: Date.now(),
    calledBy: callerId,
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
      delete p.disguiseAvatarVariantId;
      delete p.disguiseHasPlayPass;
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
        avatarVariantId: room.players[room.meeting.reportedBodyId].avatarVariantId || null,
        hasPlayPass: !!room.players[room.meeting.reportedBodyId].hasPlayPass,
      }
    : null;

  io.to(roomCode).emit("meetingStarted", {
    meetingNo: room.meetingNo,
    history: room.matchChat || [], // [CHAT REDESIGN] whole match's meeting chat
    botChatMode: room.botChatMode || "auto",
    calledBy: callerId,
    callerName: caller.name,
    callerAvatarId: caller.avatarId,
    callerAvatarVariantId: caller.avatarVariantId || null,
    callerHasPlayPass: !!caller.hasPlayPass,
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
        postKillReportLockUntil: p.postKillReportLockUntil || 0,
      });
    }
  });

  console.log(`Meeting called by ${caller.name} in room ${roomCode}`);
  return null;
}

// [AI BOTS] Extracted from sendChatMessage so bots post meeting chat
// under the same rules (alive, 200 chars). Returns the stored message, or
// { message } (an error object without senderId) on failure.
function postMeetingChat(roomCode, senderId, text, replyTo, gifUrl, sticker) {
  const room = rooms[roomCode];
  if (!room || !room.meeting) return { message: "No meeting in progress." };

  const sender = room.players[senderId];
  if (!sender) return { message: "Not in this room." };

  // [GHOST RULE] - dead players (ghosts) can't send chat messages, only
  // read them (which they already get, since chatMessageReceived is
  // broadcast to the whole room via io.to(roomCode)).
  if (!sender.alive) {
    return { message: "You are a ghost and cannot send chat messages." };
  }

  const trimmed = (text || "").trim().slice(0, 200); // 200 char limit, spam-protection
  // [NEW FEATURE - GIF PICKER] validateGifUrl (defined once, shared by
  // all three chat handlers) rejects anything that isn't a plausible
  // https image/gif URL - a message with an invalid/missing gifUrl
  // just silently drops the GIF and falls back to text-only, exactly
  // like a normal text message would.
  // [NEW FEATURE - PLAY PASS] GIFs are a Play Pass perk - strip any
  // gifUrl server-side if the sender doesn't actually have Play Pass,
  // regardless of what the client sent (the UI already locks this, but
  // never trust the client alone for a gated feature).
  const safeGifUrl = sender.hasPlayPass ? validateGifUrl(gifUrl) : null;
  // [PLAY PASS - STICKERS] same rule: only known ids, only Play Pass holders.
  const safeSticker = sender.hasPlayPass ? validateSticker(sticker) : null;
  if (!trimmed && !safeGifUrl && !safeSticker) return { message: "Empty message." };

  const message = {
    senderId: senderId,
    senderName: sender.name,
    senderAvatar: sender.avatarId,
    // [NEW FEATURE - PLAY PASS] Frozen at send time, same reasoning as
    // senderHasLegionBadge right below.
    senderAvatarVariant: sender.avatarVariantId || null,
    senderHasPlayPass: !!sender.hasPlayPass,
    // [NEW FEATURE - NEAR LEGION BADGE] Frozen at send time, same as
    // senderName/senderAvatar - keeps working even if the sender later
    // leaves the room, unlike a live lookup would.
    senderHasLegionBadge: !!sender.hasLegionBadge,
    text: trimmed,
    gifUrl: safeGifUrl,
    sticker: safeSticker,
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
  pushMatchChat(room, { kind: "msg", ...message });
  bots.onMeetingChat(roomCode, message); // [AI BOTS] let bots react

  io.to(roomCode).emit("chatMessageReceived", message);
  return message;
}

// [AI BOTS] Extracted from voteSkipDiscussion (same 60% rule for bots).
function voteSkipDiscussion(roomCode, voterId) {
  const room = rooms[roomCode];
  if (!room || !room.meeting || room.meeting.stage !== "chat") return;

  const voter = room.players[voterId];
  if (!voter || !voter.alive) return;

  room.meeting.skipDiscussionVotes[voterId] = true;

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
}

// [AI BOTS] Extracted from castVote so bots vote under the same rules.
// Returns null on success or { message } on error.
function castMeetingVote(roomCode, voterId, targetId, back = false) {
  const room = rooms[roomCode];
  if (!room || !room.meeting) return;

  const voter = room.players[voterId];
  if (!voter || !voter.alive) {
    return { message: "You cannot vote." };
  }
  // [CHAT REDESIGN] Votes only count in the voting window (the last 30s,
  // shown inside the chat). One vote per player, no changes.
  if (room.meeting.stage !== "voting") {
    return { message: "Voting hasn't started yet." };
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
  if (room.meeting.votes[voterId]) {
    return { message: "You've already voted." };
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
    return { message: "That target is no longer valid." };
  }
  room.meeting.votes[voterId] = choice;
  // [$SABOTEUR] Optional "back your vote": settled in match points at the end.
  const backed = !!back && economy.recordBack(room, voterId, choice);

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
  // Live votes stay visible on purpose (Om7eth's call): every screen shows
  // the voter's small avatar under whoever they voted for, as it happens.
  io.to(roomCode).emit("voteUpdate", { totalVotes, totalAlive, voterId: voterId, voterName: voter.name, choice, backed });
  pushMatchChat(room, { kind: "sys", text: `${voter.name} voted${backed ? " · backed it" : ""}`, voterId, timestamp: Date.now() });

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
    }, 5000); // everyone voted: result 5s later
  }
  return null;
}

// [AI BOTS] A crew bot finished one of its missions - same bookkeeping a
// human's reportMissionProgress ends up doing (progress bar + win check).
function completeBotMission(roomCode, botId) {
  const room = rooms[roomCode];
  if (!room || !room.gameStarted || room.winner) return;
  const p = room.players[botId];
  if (!p || !p.isBot || p.role !== "crewmate") return; // ghosts can still finish missions, like humans
  const now = Date.now();
  p.missionsDone = Math.min((p.missionsDone || 0) + 1, p.missionsTotal || 0);
  p.lastMissionCompletedAt = now;
  p.lastMissionActivityAt = now;
  broadcastCrewProgress(roomCode);
  checkWinCondition(roomCode);
}
bots.setHooks({
  performKill,
  performSabotage,
  startMeeting,
  completeMission: completeBotMission,
  postMeetingChat,
  castMeetingVote,
  voteSkipDiscussion,
  killRangePx: SERVER_KILL_RANGE_PX,
});

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

    // [NEW FEATURE - EMERGENCY PAUSE] Only affects Pool/Paid rooms
    // (poolConfig present) - Free Play is never affected. The on-chain
    // pool itself already exists by this point (the host's wallet
    // already paid before this call even happens), so this can't
    // prevent that - it just stops a new GAME SESSION from starting
    // for it while Om7eth investigates something. The host can still
    // cancel that on-chain pool normally to get their money back.
    if (poolConfig && (await getPoolsPaused())) {
      const message = "Pool and Paid games are temporarily paused for maintenance. Free Play is unaffected. Try again shortly.";
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
      // [SECURITY FIX - CRITICAL] This used to build poolSetup entirely
      // from client-supplied poolConfig values (entryFeeNear, maxMatches,
      // hostFunded, even which onChainPoolId to claim at all) with ZERO
      // verification against the actual chain. A malicious client could
      // claim an onChainPoolId that either doesn't exist, belongs to a
      // totally different pool/host, or is already Locked/Distributed/
      // Refunded elsewhere - and if that pool happened to have real
      // funds and the claiming account happened to be a genuine
      // participant of it from somewhere else entirely, they could get
      // the backend to fabricate a fake off-chain "room" claiming to be
      // that pool, rig a fake result, and trigger a real payout of
      // someone else's pool to themselves. This looks up the REAL
      // on-chain pool via a free view call and uses ONLY those values
      // from here on - the client's poolConfig numbers are never
      // trusted for anything financial again.
      const chainPool = await viewContract("get_pool", { pool_id: Number(poolConfig.onChainPoolId) });
      if (!chainPool) {
        const message = "Couldn't verify that pool on-chain - it may not exist, or the network is having trouble. Try again in a moment.";
        ack({ ok: false, message });
        return;
      }
      const hostPlayer = await Player.findById(account.accountId, "walletAddress");
      if (!hostPlayer || !hostPlayer.walletAddress || chainPool.host_id !== hostPlayer.walletAddress) {
        const message = "That pool's on-chain host doesn't match your connected wallet.";
        ack({ ok: false, message });
        return;
      }
      if (chainPool.state !== "Open") {
        const message = "That pool isn't open anymore - it may already be in progress or settled elsewhere.";
        ack({ ok: false, message });
        return;
      }
      // [BUG FIX - DUPLICATE ROOM FOR THE SAME ON-CHAIN POOL] Without
      // this, a network retry, an accidental double-tap, or two people
      // racing to create a room for the same freshly-created pool could
      // each pass the "still Open on-chain" check above (it only
      // flips to Locked once someone's lock_participation actually
      // lands) and end up with TWO separate off-chain rooms both
      // claiming to represent the exact same pool - confusing at best,
      // and only one of them could ever actually start for real (the
      // other's lock_participation would fail once the pool locks).
      const duplicateRoom = Object.values(rooms).find((r) => r.pool && r.pool.onChainPoolId === String(poolConfig.onChainPoolId));
      if (duplicateRoom) {
        const message = "A room for this pool already exists - go back and use that one instead.";
        ack({ ok: false, message });
        return;
      }
      const maxMatches = Math.max(1, Math.min(5, chainPool.max_matches || 1));
      const entryFeeNear = Number(chainPool.entry_fee) / 1e24;
      const hostFunded = !!chainPool.host_funded;
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
        onChainWalletByAccountId: hostFunded ? { [account.accountId]: hostPlayer.walletAddress } : {}, // [FUNDS SAFETY v4]
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

    // [POOL v2 - REAL NEAR] Host pays the winners by hand - nothing on-chain.
    if (poolConfig && poolConfig.mode === "manual") {
      if (!account) { ack({ ok: false, message: "Sign in to host a pool game." }); return; }
      const split = cleanSplit(poolConfig.split);
      const prizeNear = Math.round(Number(poolConfig.prizeNear) * 1000) / 1000;
      if (!split) { ack({ ok: false, message: "The prize split has to add up to exactly 100%." }); return; }
      if (!(prizeNear > 0 && prizeNear <= 100000)) { ack({ ok: false, message: "Enter a prize amount above 0." }); return; }
      poolSetup = {
        mode: "manual",
        onChainPoolId: null,
        poolId: generateMatchId().replace("m_", "mp_"),
        poolName: String(poolConfig.poolName || "").trim().slice(0, 40),
        maxMatches: Math.max(1, Math.min(5, parseInt(poolConfig.maxMatches, 10) || 3)),
        matchesPlayed: 0,
        entryFeeNear: prizeNear, // existing UI reads the pool size from here
        prizeNear,
        split,
        hostFunded: true,
        hostAccountId: account.accountId,
        state: "Open",
        participantAccountIds: [],
        onChainParticipantAccountIds: [],
        leaderboard: {},
        confirmedAccountIds: [],
        walletHolders: [],
      };
    }
    // [POOL v2] Host decides once, at creation: play, watch, or just host.
    if (poolSetup) poolSetup.hostRole = ["play", "watch", "host"].includes(poolConfig && poolConfig.hostRole) ? poolConfig.hostRole : "play";
    if (poolSetup) poolSetup.hostUsername = account?.accountUsername || null; // lets the client know which player is the pool host
    if (poolSetup && poolSetup.mode === "manual" && poolSetup.hostRole === "play") {
      poolSetup.participantAccountIds.push(account.accountId);
      const w = cleanPayoutWallet(poolConfig.payoutWallet);
      if (w) setPoolWallet(poolSetup, account.accountId, w);
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
    // [FREE PLAY REDESIGN] Optional host briefing (free text) + quick
    // vibe tags - both purely informational, shown in the Free Play
    // room list and room-details sheet. Tags are whitelisted so a
    // modified client can never inject arbitrary labels.
    let freeBriefing = "";
    let freeTags = [];
    if (!poolSetup && freeConfig) {
      freeName = String(freeConfig.name || "").trim().slice(0, 24);
      freeBriefing = String(freeConfig.briefing || "").replace(/\s+/g, " ").trim().slice(0, 120);
      if (Array.isArray(freeConfig.tags)) {
        freeTags = [...new Set(freeConfig.tags.map((t) => String(t)))].filter((t) => FREE_ROOM_TAGS.includes(t)).slice(0, 4);
      }
      const rawLimit = freeConfig.maxMatches;
      if (rawLimit && rawLimit !== "nolimit") {
        const parsed = parseInt(rawLimit, 10);
        // [FREE PLAY REDESIGN] Host can now pick any number 1-50 (was 1-3).
        if (Number.isFinite(parsed) && parsed > 0) matchLimit = Math.max(1, Math.min(50, parsed));
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
      speedLevel: 1, // [UPDATE] Now a direct multiplier (0.5x-2x, 7 steps) - the room creator can change this in the Lobby's Host Control panel
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
      freeBriefing,
      freeTags,
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
        [socket.id]: { name, avatarId, isHost: true, spectator: !!(poolSetup && poolSetup.hostRole !== "play"), playerToken, accountId: account?.accountId || null, accountEmail: account?.accountEmail || null, accountUsername: account?.accountUsername || null, hasLegionBadge: !!account?.hasLegionBadge, hasPlayPass: !!account?.hasPlayPass, premiumVariantId: account?.activePremiumAvatarVariant || null, avatarVariantId: resolveAvatarVariantForRoom(account, avatarId) },
      },
    };

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerToken = playerToken;

    // [LOBBY LEADERBOARD] Host appears in this room's leaderboard the
    // moment the room exists, with 0 points until they actually earn
    // some - same as any other logged-in player who joins.
    if (account) getOrCreateRoomLeaderboardEntry(rooms[code], account.accountId, account.accountUsername);

    // [NEW FEATURE - FUNDS SAFETY: PERSISTENT POOL TRACKING] See
    // PoolRecord's own comment - this is the initial write, the moment
    // this room becomes the pool's off-chain home.
    if (poolSetup && poolSetup.mode === "manual") {
      saveManualPool(poolSetup, {
        poolId: poolSetup.poolId, roomCode: code, roomSessionId: rooms[code].sessionId,
        hostAccountId: account.accountId, hostName: name, hostUsername: account.accountUsername || null,
        poolName: poolSetup.poolName, prizeNear: poolSetup.prizeNear, split: poolSetup.split,
        maxMatches: poolSetup.maxMatches, hostRole: poolSetup.hostRole, isPublic: !!isPublic, state: "Open",
        players: manualPoolPlayers(rooms[code]),
      });
    }
    if (poolSetup && poolSetup.mode !== "manual") {
      savePoolRecord({ onChainPoolId: poolSetup.onChainPoolId }, {
        onChainPoolId: poolSetup.onChainPoolId,
        roomCode: code,
        hostAccountId: poolSetup.hostAccountId,
        hostFunded: poolSetup.hostFunded,
        entryFeeNear: poolSetup.entryFeeNear,
        maxMatches: poolSetup.maxMatches,
        state: "Open",
        participantAccountIds: poolSetup.participantAccountIds,
        onChainParticipantAccountIds: poolSetup.onChainParticipantAccountIds,
        onChainWalletByAccountId: poolSetup.onChainWalletByAccountId || {},
        matchesPlayed: 0,
        leaderboardSnapshot: {},
        poolName: poolSetup.poolName || null,
        isPublic: !!isPublic,
      });
      // [NEW FEATURE - TRANSACTIONS LEDGER] createTxHash is client-
      // supplied (captured the instant the host's wallet confirmed
      // create_pool - see callPoolContract in game.jsx) - never trusted
      // for anything financial, purely a display convenience so the
      // admin Transactions tab can link straight to nearblocks for this
      // row instead of just knowing an amount moved.
      pushTxnLog(poolSetup.onChainPoolId, {
        type: "create_pool",
        accountId: poolSetup.hostAccountId,
        amountNear: poolSetup.hostFunded ? poolSetup.entryFeeNear : 0,
        txHash: (poolConfig && poolConfig.createTxHash) ? String(poolConfig.createTxHash).slice(0, 100) : null,
        note: poolSetup.hostFunded ? "Host-funded pool created" : "Entry-fee pool created (gas only)",
      });
    }

    socket.emit("roomCreated", {
      code,
      players: getPlayerList(code),
      playerToken,
      speedLevel: rooms[code].speedLevel || 1,
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
      botChatMode: rooms[code].botChatMode || "auto",
      code,
      players: getPlayerList(code),
      playerToken,
      speedLevel: rooms[code].speedLevel || 1,
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
  socket.on("confirmParticipated", async ({ onChainPoolId, sessionToken, txHash }, callback) => {
    const respond = typeof callback === "function" ? callback : () => {};
    const account = await resolveAccountFromToken(sessionToken);
    if (!account) { respond({ ok: false, message: "You need to be logged in with a wallet to do this." }); return; }
    const room = Object.values(rooms).find((r) => r.pool && r.pool.onChainPoolId === String(onChainPoolId));
    if (!room) { respond({ ok: false, message: "Couldn't find that pool's room - it may have been removed." }); return; }
    // [SECURITY FIX - CRITICAL] This used to just trust the client that a
    // real participate() call had happened, and directly add the account
    // to onChainParticipantAccountIds - the exact list that determines
    // who's real-payout-eligible when distribute_prizes gets called. A
    // fabricated confirmParticipated event (no wallet transaction at all)
    // could get a non-paying account marked payout-eligible off-chain -
    // the contract's own participants check inside distribute_prizes
    // would then reject the WHOLE payout transaction the moment that
    // fraudulent account is included as a winner (since they're not
    // really in pool.participants on-chain), which would freeze the
    // ENTIRE pool's payout for every legitimate winner too, not just
    // fail quietly for the fraud attempt - a real griefing vector, not
    // just a data-integrity nice-to-have. Verifying here, before ever
    // trusting the claim, closes it completely.
    const playerDoc = await Player.findById(account.accountId, "walletAddress");
    const wallet = playerDoc?.walletAddress || null;
    if (!wallet) { respond({ ok: false, message: "Connect a wallet to your account first." }); return; }
    const chainPool = await viewContract("get_pool", { pool_id: Number(onChainPoolId) });
    if (!chainPool) { respond({ ok: false, message: "Couldn't verify your participation on-chain - try again in a moment." }); return; }
    if (!Array.isArray(chainPool.participants) || !chainPool.participants.includes(wallet)) {
      respond({ ok: false, message: "That wallet doesn't show up as a participant of this pool on-chain yet - the transaction may still be confirming, try again shortly." });
      return;
    }
    if (!room.pool.participantAccountIds.includes(account.accountId)) {
      room.pool.participantAccountIds.push(account.accountId);
    }
    // This account really did just call participate() on-chain (see the
    // frontend's own handleParticipateInPool) - unlike a host-funded
    // pool's free-joiners, they're genuinely eligible for a real payout.
    // [NEW FEATURE - TRANSACTIONS LEDGER] Only log once, the first time
    // this account is genuinely newly added - confirmParticipated can
    // legitimately fire more than once for the same account (retries,
    // the re-entry-after-crash path) and this must never turn into a
    // duplicate ledger row each time.
    const isFirstTimeRegistration = !room.pool.onChainParticipantAccountIds.includes(account.accountId);
    if (isFirstTimeRegistration) {
      room.pool.onChainParticipantAccountIds.push(account.accountId);
    }
    // [FUNDS SAFETY v4] remember the exact wallet that joined on-chain
    room.pool.onChainWalletByAccountId = { ...(room.pool.onChainWalletByAccountId || {}), [account.accountId]: wallet };
    savePoolRecord({ onChainPoolId: room.pool.onChainPoolId }, {
      participantAccountIds: room.pool.participantAccountIds,
      onChainParticipantAccountIds: room.pool.onChainParticipantAccountIds,
      onChainWalletByAccountId: room.pool.onChainWalletByAccountId,
    });
    if (isFirstTimeRegistration) {
      pushTxnLog(room.pool.onChainPoolId, {
        type: "participate",
        accountId: account.accountId,
        amountNear: room.pool.hostFunded ? 0 : (room.pool.entryFeeNear || 0),
        txHash: txHash ? String(txHash).slice(0, 100) : null,
        note: room.pool.hostFunded ? "Joined host-funded pool (free)" : "Paid entry fee",
      });
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
      if (oldSocket && oldSocket.connected) { oldSocket.emit("sessionMovedElsewhere"); oldSocket.disconnect(true); }
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
        spectator: account.accountId === room.pool.hostAccountId && !!room.pool.hostRole && room.pool.hostRole !== "play", // [POOL v2]
        accountId: account.accountId, accountEmail: account.accountEmail || null, accountUsername: account.accountUsername || null, hasLegionBadge: !!account.hasLegionBadge,
        hasPlayPass: !!account.hasPlayPass, premiumVariantId: account.activePremiumAvatarVariant || null,
        avatarVariantId: resolveAvatarVariantForRoom(account, finalAvatarId),
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
  socket.on("joinRoom", async ({ code, name, avatarId, sessionToken, payoutWallet }, callback) => {
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
    if (room.pool && room.pool.mode !== "manual") {
      const message = "This is a paid pool room - it can't be joined with a room code. Use Enter/Participate instead.";
      socket.emit("joinError", { message });
      ack({ ok: false, message });
      return;
    }
    // [POOL v2 - REAL NEAR] public pool: join straight in, but only with a
    // signed-in account and a valid mainnet .near address for the prize.
    let manualWallet = null;
    if (room.pool && room.pool.mode === "manual") {
      const acct = await resolveAccountFromToken(sessionToken);
      const isPoolHost = acct && acct.accountId === room.pool.hostAccountId;
      if (!acct) { const message = "Sign in to join a pool game."; socket.emit("joinError", { message }); ack({ ok: false, message }); return; }
      const alreadyIn = (room.pool.participantAccountIds || []).includes(acct.accountId);
      if (!room.isPublic && !isPoolHost && !alreadyIn) { const message = "This is a private pool - send a join request and the host will let you in."; socket.emit("joinError", { message }); ack({ ok: false, message, needsApproval: true }); return; }
      manualWallet = cleanPayoutWallet(payoutWallet) || poolWallets(room.pool)[acct.accountId] || null;
      if (!manualWallet && !(isPoolHost && room.pool.hostRole !== "play")) { const message = "Add your mainnet NEAR wallet (like name.near or name.tg) so the host can send your prize - testnet addresses can't receive real NEAR."; socket.emit("joinError", { message }); ack({ ok: false, message, needsWallet: true }); return; }
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
    const tookOverHost = account ? dropStaleSeatsForAccount(room, account.accountId, socket.id) : false;

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
    room.players[socket.id] = { name, avatarId: finalAvatarId, isHost: tookOverHost, playerToken, accountId: account?.accountId || null, accountEmail: account?.accountEmail || null, accountUsername: account?.accountUsername || null, hasLegionBadge: !!account?.hasLegionBadge, hasPlayPass: !!account?.hasPlayPass, premiumVariantId: account?.activePremiumAvatarVariant || null, avatarVariantId: resolveAvatarVariantForRoom(account, finalAvatarId) };
    bots.resolveNameClash(room); // [$SABOTEUR] a person's name wins over a bot's
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
    if (room.pool && room.pool.mode === "manual" && account) {
      if (account.accountId === room.pool.hostAccountId && room.pool.hostRole !== "play") room.players[socket.id].spectator = true;
      if (!room.players[socket.id].spectator && !room.pool.participantAccountIds.includes(account.accountId)) room.pool.participantAccountIds.push(account.accountId);
      if (manualWallet) {
        setPoolWallet(room.pool, account.accountId, manualWallet);
        Player.updateOne({ _id: account.accountId }, { $set: { payoutWallet: manualWallet } }).catch(() => {});
      }
      saveManualPool(room.pool, { players: manualPoolPlayers(room) });
      io.to(roomCode).emit("poolUpdated", { pool: room.pool });
    }

    const playerList = getPlayerList(roomCode);

    // Confirmation to the new player themself - includes the FINAL
    // avatarId (may differ from what was requested, if it had to be
    // reassigned above due to a conflict).
    socket.emit("roomJoined", {
      botChatMode: room.botChatMode || "auto",
      code: roomCode,
      players: playerList,
      playerToken,
      avatarId: finalAvatarId,
      gameMode: room.gameMode || "free",
      // [NEW FEATURE] So a newly-joined player immediately sees whatever
      // speed the host has already set, not just the default.
      speedLevel: room.speedLevel || 1,
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
      speedLevel: room.speedLevel || 1,
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

  // ---- REQUEST TO JOIN A PRIVATE ROOM (new) ----
  // Client sends: { code, name, avatarId, sessionToken }
  // [NEW FEATURE - HOME SCREEN LIVE ROOMS WINDOW] Entered a room code
  // for a room that's PRIVATE - instead of joining directly (like
  // joinRoom does for public rooms), this sends the host a request
  // they have to approve, wherever they currently are in the app. The
  // requester sits on a "waiting for host approval" screen until the
  // host responds or 2 minutes pass, whichever comes first.
  socket.on("requestJoinRoom", async ({ code, name, avatarId, sessionToken, payoutWallet }, callback) => {
    const ack = typeof callback === "function" ? callback : () => {};
    const roomCode = (code || "").toUpperCase().trim();
    const room = rooms[roomCode];

    if (!room) {
      ack({ ok: false, message: "Room not found. Check the code." });
      return;
    }
    if (room.gameStarted) {
      ack({ ok: false, message: "This game has already started. Wait for it to end, or for everyone to return to the Lobby, then try again." });
      return;
    }
    const MAX_PLAYERS = 10;
    if (Object.keys(room.players).length >= MAX_PLAYERS) {
      ack({ ok: false, message: "This room is full (max 10 players)." });
      return;
    }
    const hostEntry = Object.entries(room.players).find(([, p]) => p.isHost);
    if (!hostEntry) {
      ack({ ok: false, message: "This room has no host right now. Try again in a moment." });
      return;
    }
    const [hostSocketId] = hostEntry;

    const account = await resolveAccountFromToken(sessionToken);
    if (account && findActiveRoomForAccount(account.accountId)) {
      ack({ ok: false, message: "Your account is already active in another room. Leave that room first." });
      return;
    }

    room.pendingJoinRequests = room.pendingJoinRequests || {};
    // [BUG FIX] Don't let the same requester pile up multiple pending
    // requests into one room (e.g. tapping the button twice) - replace
    // any existing one from this same socket instead.
    for (const rid of Object.keys(room.pendingJoinRequests)) {
      if (room.pendingJoinRequests[rid].socketId === socket.id) {
        clearTimeout(room.pendingJoinRequests[rid].timeoutHandle);
        delete room.pendingJoinRequests[rid];
      }
    }

    // [POOL v2] Real-NEAR private pool: the wallet comes with the request so the host sees it before accepting
    const reqWallet = room.pool && room.pool.mode === "manual" ? cleanPayoutWallet(payoutWallet) : null;
    if (room.pool && room.pool.mode === "manual") {
      if (!account) { ack({ ok: false, message: "Sign in to join a pool game." }); return; }
      if (!reqWallet) { ack({ ok: false, message: "Add your mainnet NEAR wallet (like name.near or name.tg) so the host can send your prize - testnet addresses can't receive real NEAR.", needsWallet: true }); return; }
    }
    const requestId = generatePlayerToken();
    const requestRecord = {
      socketId: socket.id, name, avatarId, payoutWallet: reqWallet,
      accountId: account?.accountId || null,
      accountEmail: account?.accountEmail || null,
      accountUsername: account?.accountUsername || null,
      hasLegionBadge: !!account?.hasLegionBadge,
      // [NEW FEATURE - PLAY PASS] Cached here too, same reasoning as
      // hasLegionBadge - resolveAvatarVariantForRoom needs both of these
      // once the host actually accepts the request (see below).
      hasPlayPass: !!account?.hasPlayPass,
      activePremiumAvatarVariant: account?.activePremiumAvatarVariant || null,
    };
    // [NEW FEATURE] 2-minute expiry - if the host never responds (away,
    // busy, mid-match), the requester isn't left waiting forever.
    requestRecord.timeoutHandle = setTimeout(() => {
      if (!room.pendingJoinRequests || !room.pendingJoinRequests[requestId]) return;
      delete room.pendingJoinRequests[requestId];
      io.to(socket.id).emit("joinRequestExpired", { code: roomCode });
    }, 2 * 60 * 1000);
    room.pendingJoinRequests[requestId] = requestRecord;

    // [POOL v2] the pool host gets the request when they're in the room, even if someone else runs the lobby
    const poolHostSid = room.pool ? Object.keys(room.players).find((id) => room.players[id].accountId === room.pool.hostAccountId) : null;
    io.to(poolHostSid || hostSocketId).emit("joinRequestReceived", {
      requestId,
      roomCode,
      requesterName: name,
      requesterUsername: account?.accountUsername || null,
      requesterWallet: reqWallet,
      requesterAvatarId: avatarId,
    });
    ack({ ok: true, requestId });
    console.log(`${name} requested to join private room ${roomCode}`);
  });

  // ---- HOST RESPONDS TO A JOIN REQUEST (new) ----
  // Client sends: { requestId, approve }
  // [NEW FEATURE] Host-only. For a Pool/Paid room, approval doesn't
  // join them directly - it hands off to the SAME secure on-chain
  // participate() flow the Pool Games screen already uses (see
  // joinRequestApprovedNeedsPayment below), so this never becomes a
  // second, weaker way to get into a paid room for free. For a Free
  // room, approval completes the join right here, the same way
  // joinRoom above does.
  socket.on("respondJoinRequest", async ({ requestId, approve }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    const isPoolHostHere = !!(room && room.pool && room.players[socket.id] && room.players[socket.id].accountId === room.pool.hostAccountId);
    if (!room || !room.players[socket.id] || (!room.players[socket.id].isHost && !isPoolHostHere)) return;
    const reqRec = room.pendingJoinRequests && room.pendingJoinRequests[requestId];
    if (!reqRec) return; // already expired, withdrawn, or already handled

    clearTimeout(reqRec.timeoutHandle);
    delete room.pendingJoinRequests[requestId];

    const requesterSocket = io.sockets.sockets.get(reqRec.socketId);
    if (!requesterSocket) return; // requester disconnected before this got resolved

    if (!approve) {
      io.to(reqRec.socketId).emit("joinRequestRejected", { code: roomCode });
      return;
    }

    if (room.pool && room.pool.mode !== "manual") {
      io.to(reqRec.socketId).emit("joinRequestApprovedNeedsPayment", {
        code: roomCode,
        poolId: room.pool.poolId,
        onChainPoolId: room.pool.onChainPoolId,
        poolName: room.pool.poolName || "Pool Game",
        entryFeeNear: room.pool.entryFeeNear || 0,
        hostFunded: !!room.pool.hostFunded,
      });
      return;
    }

    // Free private room - complete the join right here (re-checking the
    // same conditions joinRoom itself checks, since time has passed).
    if (room.gameStarted) {
      io.to(reqRec.socketId).emit("joinRequestRejected", { code: roomCode, message: "The match started before you were approved." });
      return;
    }
    const approvedTookHost = dropStaleSeatsForAccount(room, reqRec.accountId, reqRec.socketId); // [BUG FIX - DUPLICATE SEATS]
    const MAX_PLAYERS = 10;
    if (Object.keys(room.players).length >= MAX_PLAYERS) {
      io.to(reqRec.socketId).emit("joinRequestRejected", { code: roomCode, message: "The room filled up before you were approved." });
      return;
    }

    const playerToken = generatePlayerToken();
    const takenAvatarIds = new Set(Object.values(room.players).map((p) => p.avatarId));
    let finalAvatarId = reqRec.avatarId;
    if (takenAvatarIds.has(finalAvatarId)) {
      const allAvatarIds = ["purple", "green", "red", "black", "darkgreen", "magenta", "yellow", "brown", "orange", "cyan"];
      finalAvatarId = allAvatarIds.find((id) => !takenAvatarIds.has(id)) || finalAvatarId;
    }
    room.players[reqRec.socketId] = {
      name: reqRec.name, avatarId: finalAvatarId, isHost: approvedTookHost, playerToken,
      accountId: reqRec.accountId, accountEmail: reqRec.accountEmail,
      accountUsername: reqRec.accountUsername, hasLegionBadge: reqRec.hasLegionBadge,
      hasPlayPass: !!reqRec.hasPlayPass, premiumVariantId: reqRec.activePremiumAvatarVariant || null,
      avatarVariantId: resolveAvatarVariantForRoom({ hasPlayPass: reqRec.hasPlayPass, activePremiumAvatarVariant: reqRec.activePremiumAvatarVariant }, finalAvatarId),
    };
    bots.resolveNameClash(room); // [$SABOTEUR] a person's name wins over a bot's
    restoreHostToCreatorIfPresent(room);
    cancelRoomEmptyClose(room.code);
    requesterSocket.join(roomCode);
    requesterSocket.data.roomCode = roomCode;
    requesterSocket.data.playerToken = playerToken;
    if (reqRec.accountId) getOrCreateRoomLeaderboardEntry(room, reqRec.accountId, reqRec.accountUsername);
    if (room.pool && room.pool.mode === "manual" && reqRec.accountId && reqRec.payoutWallet) {
      if (!room.pool.participantAccountIds.includes(reqRec.accountId)) room.pool.participantAccountIds.push(reqRec.accountId);
      setPoolWallet(room.pool, reqRec.accountId, reqRec.payoutWallet);
      Player.updateOne({ _id: reqRec.accountId }, { $set: { payoutWallet: reqRec.payoutWallet } }).catch(() => {});
      saveManualPool(room.pool, { players: manualPoolPlayers(room) });
      io.to(roomCode).emit("poolUpdated", { pool: room.pool });
    }

    const playerList = getPlayerList(roomCode);
    io.to(reqRec.socketId).emit("roomJoined", {
      code: roomCode, players: playerList, playerToken, avatarId: finalAvatarId,
      gameMode: room.gameMode || "free", speedLevel: room.speedLevel || 1,
      isPublic: !!room.isPublic, lobbyChat: room.lobbyChat || [], devMode: !!room.devMode,
      pool: room.pool || null, matchLimit: room.matchLimit ?? null, matchesPlayed: room.matchesPlayed || 0,
      roomLeaderboard: getRoomLeaderboardList(room),
    });
    io.to(roomCode).emit("playerListUpdated", { players: playerList });
    broadcastRoomLeaderboard(room);
    console.log(`${reqRec.name} joined room ${roomCode} (private, approved by host)`);
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
      // [AI BOTS] a client can never "reconnect" into a bot's seat
      (id) => !room.players[id].isBot && room.players[id].playerToken === playerToken
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
        // Tell that tab/device why, so it stops trying to win the seat back
        // (two open tabs used to kick each other in an endless rejoin loop).
        oldSocket.emit("sessionMovedElsewhere");
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
  // [BUG FIX - COULDN'T REJOIN RIGHT AFTER LEAVING] This used to be
  // fire-and-forget from the client's side - it emitted leaveRoom and
  // immediately cleared its own local state / navigated to Home
  // without waiting for the server to actually finish removing them.
  // If the player then tried to create/join a new room fast enough,
  // findActiveRoomForAccount could still find their OLD room slot
  // (the server hadn't gotten to process the leave yet) and reject the
  // new attempt with "already active in another room" - a real, if
  // narrow, race condition. Adding an ack the client now actually
  // waits for (see handleLeaveRoom on the frontend) closes it
  // completely: the client only proceeds once the server confirms this
  // player is genuinely, fully removed.
  socket.on("leaveRoom", async (callback) => {
    const ack = typeof callback === "function" ? callback : () => {};
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!roomCode || !room) { ack({ ok: true }); return; }

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
      room.pool && room.pool.mode !== "manual" && !room.gameStarted && poolIsCancellable(room.pool) &&
      departingAccountId && departingAccountId === room.pool.hostAccountId
    );
    // [BUG FIX - PAID PARTICIPANT LEAVING PRE-GAME HAD NO REFUND PATH]
    // The contract has no per-participant withdrawal - only a whole-
    // pool cancel_pool (refunds everyone) or a whole-pool
    // distribute_prizes. So a single non-host participant in a Paid
    // (entry-fee, non-host-funded) pool leaving before the game starts
    // previously had NOTHING happen to their money at all - they stayed
    // registered as an on-chain participant with their entry fee just
    // sitting there, and if the game proceeded without them, their
    // stake effectively got silently absorbed into the pool for
    // whoever else won, never refunded to them. The only clean, safe
    // option available without a contract change: cancel + refund the
    // WHOLE pool the moment ANY paying participant leaves pre-game -
    // same as the host-leaving case already does. Disruptive to
    // whoever else is still waiting to play, but guarantees nobody's
    // money is ever silently kept by someone else. Host-funded Pool
    // games are unaffected - a free-joining crewmate there never paid
    // anything, so their leaving needs no refund at all.
    const wasPaidParticipantLeavingPreGame = !!(
      room.pool && !room.gameStarted && !room.pool.hostFunded && poolIsCancellable(room.pool) &&
      departingAccountId && departingAccountId !== room.pool.hostAccountId &&
      (room.pool.onChainParticipantAccountIds || []).includes(departingAccountId)
    );
    const mustCancelWholePoolOnLeave = wasOnChainPoolHostLeaving || wasPaidParticipantLeavingPreGame;
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
      snapshotRoomLeaderboardOnDeparture(room, room.players[socket.id].accountId, room.players[socket.id].name, room.players[socket.id].avatarId, room.players[socket.id].hasLegionBadge, room.players[socket.id].avatarVariantId, room.players[socket.id].hasPlayPass);
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
    if (mustCancelWholePoolOnLeave) {
      const onChainPoolId = room.pool.onChainPoolId;
      const reason = wasOnChainPoolHostLeaving
        ? "Host left before the pool started - refunding everyone."
        : "A paying participant left before the pool started - refunding everyone.";
      io.to(roomCode).emit("roomClosedByHost", { reason });
      markRoomMessageClosedForever(room); // fire-and-forget
      delete rooms[roomCode];
      if ((room.pool.onChainParticipantAccountIds || []).length > 0) {
        const refund = await cancelPoolOnChain(onChainPoolId);
        if (refund.success) {
          console.log(`[PRE-GAME LEAVE] Pool #${onChainPoolId} cancelled + refunded on-chain (${wasOnChainPoolHostLeaving ? "host" : "a paid participant"} left room ${roomCode} before it started).`);
        } else {
          console.error(`[PRE-GAME LEAVE] Pool #${onChainPoolId} could NOT be refunded automatically (room ${roomCode}): ${refund.error} - will keep retrying automatically.`);
        }
      }
      console.log(`Room ${roomCode} closed - on-chain pool ${wasOnChainPoolHostLeaving ? "host" : "paid participant"} left before the pool started`);
      ack({ ok: true });
      return;
    }

    const remaining = bots.humansRemainingAfterLeave(room); // [AI BOTS] humans only - an all-bot room counts as empty, and a bot can never be picked as host
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
            } else if (room.pool.state === "Locked" && (room.pool.matchesPlayed || 0) >= 1 /* [EARLY END] partial result counts */) {
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
    ack({ ok: true });
  });

  // ---- KICK PLAYER (host only, Lobby only, from the Host Control panel) ----
  // Client sends: { targetId } - the target's socket.id (see the player
  // list in playerListUpdated). [NEW FEATURE] Restricted to the Lobby
  // (gameStarted === false) - once a match is live, removing a player
  // has entirely different implications (alive/dead state, win
  // conditions) that this isn't meant to cover.
  // ---- [AI BOTS - NEAR HACKATHON] ADD / REMOVE BOT ----
  // Host-only, Lobby-only, Free Play only (bots.addBot refuses any room
  // with a pool, i.e. Pool and Paid rooms). Bots never get an accountId,
  // so they can't earn points or touch any wallet/contract.
  // Client sends: addBot(_, ack) / removeBot({ botId }, ack)
  socket.on("addBot", (_data, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return reply({ ok: false, error: "Room not found." });
    if (!room.players[socket.id] || !room.players[socket.id].isHost) {
      return reply({ ok: false, error: "Only the host can add bots." });
    }
    const result = bots.addBot(room);
    if (!result.ok) return reply(result);
    io.to(roomCode).emit("playerListUpdated", { players: getPlayerList(roomCode) });
    // The bot says hi in lobby chat, so every player (not just the host)
    // sees that an AI bot joined. Same message shape as a human's.
    const bot = room.players[result.botId];
    const hello = {
      id: `${result.botId}-${Date.now()}`,
      senderId: result.botId,
      senderName: bot.name,
      senderAvatar: bot.avatarId,
      senderAvatarVariant: null,
      senderHasPlayPass: false,
      senderHasLegionBadge: false,
      text: "Hi! I'm an AI bot. Joined the room 👋",
      gifUrl: null,
      timestamp: Date.now(),
      replyTo: null,
    };
    room.lobbyChat = room.lobbyChat || [];
    room.lobbyChat.push(hello);
    if (room.lobbyChat.length > 200) room.lobbyChat = room.lobbyChat.slice(-200);
    io.to(roomCode).emit("lobbyChatMessageReceived", hello);
    postOrUpdateRoomMessage(room);
    console.log(`[BOTS] ${result.name} (${result.botId}) added to room ${roomCode}`);
    reply({ ok: true, botId: result.botId });
  });

  socket.on("removeBot", ({ botId } = {}, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return reply({ ok: false, error: "Room not found." });
    if (!room.players[socket.id] || !room.players[socket.id].isHost) {
      return reply({ ok: false, error: "Only the host can remove bots." });
    }
    const result = bots.removeBot(room, botId);
    if (!result.ok) return reply(result);
    io.to(roomCode).emit("playerListUpdated", { players: getPlayerList(roomCode) });
    postOrUpdateRoomMessage(room);
    console.log(`[BOTS] ${botId} removed from room ${roomCode}`);
    reply({ ok: true });
  });

  // ---- [CHAT REDESIGN] Bots: Auto / @ only ----
  // Anyone in the room may flip it; everyone sees the change. In "mention"
  // mode bots only speak when someone tags them with @Name (they still vote).
  socket.on("setBotChatMode", ({ mode } = {}) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.players[socket.id]) return;
    if (mode !== "auto" && mode !== "mention") return;
    if ((room.botChatMode || "auto") === mode) return;
    room.botChatMode = mode;
    const byName = room.players[socket.id].name;
    const text = `${byName} set bot chat to ${mode === "auto" ? "Auto" : "@ only"}`;
    if (room.meeting) pushMatchChat(room, { kind: "sys", text, timestamp: Date.now() });
    io.to(roomCode).emit("botChatModeChanged", { mode, byName, text });
  });

  socket.on("kickPlayer", async ({ targetId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    if (!room.players[socket.id] || !room.players[socket.id].isHost) {
      socket.emit("kickError", { message: "Only the host can remove players." });
      return;
    }
    if (room.gameStarted) {
      socket.emit("kickError", { message: "Can't remove a player once the match has started." });
      return;
    }
    if (!targetId || targetId === socket.id || !room.players[targetId]) {
      socket.emit("kickError", { message: "That player isn't in this room anymore." });
      return;
    }
    // [AI BOTS] Removing a bot is just a bot removal - none of the human
    // kick side effects (leaderboard snapshot, pool refund, etc.) apply.
    if (room.players[targetId].isBot) {
      const result = bots.removeBot(room, targetId);
      if (!result.ok) { socket.emit("kickError", { message: result.error }); return; }
      io.to(roomCode).emit("playerListUpdated", { players: getPlayerList(roomCode) });
      postOrUpdateRoomMessage(room);
      return;
    }

    const hostName = room.players[socket.id].name || "The host";
    const targetAccountId = room.players[targetId].accountId || null;

    // [SECURITY - PAYMENT SAFETY] Same rule as a paying participant
    // leaving pre-game (see leaveRoom above): the contract has no way to
    // refund a single participant, so if the kicked player already paid
    // an entry fee on-chain for a non-host-funded Paid pool, the WHOLE
    // pool is cancelled + refunded rather than silently dropping them.
    const wasPaidParticipantKicked = !!(
      room.pool && !room.gameStarted && !room.pool.hostFunded && poolIsCancellable(room.pool) &&
      targetAccountId && (room.pool.onChainParticipantAccountIds || []).includes(targetAccountId)
    );

    if (wasPaidParticipantKicked) {
      const onChainPoolId = room.pool.onChainPoolId;
      io.to(roomCode).emit("roomClosedByHost", { reason: "A paying participant was removed before the pool started - refunding everyone." });
      markRoomMessageClosedForever(room);
      delete rooms[roomCode];
      if ((room.pool.onChainParticipantAccountIds || []).length > 0) {
        const refund = await cancelPoolOnChain(onChainPoolId);
        if (refund.success) {
          console.log(`[KICK] Pool #${onChainPoolId} cancelled + refunded on-chain (paid participant kicked from room ${roomCode}).`);
        } else {
          console.error(`[KICK] Pool #${onChainPoolId} could NOT be refunded automatically (room ${roomCode}): ${refund.error} - will keep retrying automatically.`);
        }
      }
      console.log(`Room ${roomCode} closed - paying participant kicked before the pool started`);
      return;
    }

    snapshotRoomLeaderboardOnDeparture(room, room.players[targetId].accountId, room.players[targetId].name, room.players[targetId].avatarId, room.players[targetId].hasLegionBadge, room.players[targetId].avatarVariantId, room.players[targetId].hasPlayPass);
    delete room.players[targetId];

    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.leave(roomCode);
      targetSocket.data.roomCode = null;
      targetSocket.data.playerToken = null;
    }
    io.to(targetId).emit("kickedByHost", { hostName });

    const remaining = bots.humansRemainingAfterLeave(room); // [AI BOTS] humans only - an all-bot room counts as empty, and a bot can never be picked as host
    if (remaining.length === 0) {
      scheduleRoomEmptyClose(roomCode);
      console.log(`Room ${roomCode} empty (Lobby) after kick - auto-closing in 3 min unless someone returns`);
    } else {
      io.to(roomCode).emit("playerListUpdated", { players: getPlayerList(roomCode) });
      broadcastRoomLeaderboard(room);
    }
    console.log(`${hostName} kicked a player from room ${roomCode}`);
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
      } else if (room.pool.state === "Locked" && (room.pool.matchesPlayed || 0) >= 1 /* [EARLY END] partial result counts */) {
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
        socket.emit("closeRoomError", { message: "This pool can't be closed right now - try again in a moment." });
        return;
      }
    }
    cancelRoomEmptyClose(roomCode);
    // Tell every OTHER player in the room right now, before it's gone -
    // the frontend sends them back to Home with a clear reason.
    socket.to(roomCode).emit("roomClosedByHost");
    if (poolNeedsRefundOnClose && room.pool.mode === "manual") {
      await finishPoolEarly(room, "host closed the room before any match finished");
    } else if (poolNeedsRefundOnClose && (room.pool.onChainParticipantAccountIds || []).length > 0) {
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
      bots.resolveNameClash(room); // [$SABOTEUR] a person's name wins over a bot's
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
        // [NEW FEATURE - PLAY PASS] A color change invalidates whatever
        // premium variant was active for the OLD color - e.g. switching
        // from black to green means BlackDragon no longer applies.
        // resolveAvatarVariantForRoom re-validates against this
        // player's cached account state (hasPlayPass/premiumVariantId,
        // set once at room-join time - see the 4 creation sites above),
        // so this naturally reapplies the right variant if they switch
        // back to a color they had one for, and silently clears it
        // (falls back to the plain avatar) otherwise.
        room.players[socket.id].avatarVariantId = resolveAvatarVariantForRoom(
          { hasPlayPass: room.players[socket.id].hasPlayPass, activePremiumAvatarVariant: room.players[socket.id].premiumVariantId },
          avatarId
        );
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

  // ---- SWAP PREMIUM AVATAR SKIN (Play Pass holders, while in a room) ----
  // Client sends: { variantId } (null clears back to the plain avatar).
  // [NEW FEATURE - PLAY PASS] Deliberately a SEPARATE event from
  // updateProfile above rather than folded into it - swapping a skin is
  // a distinct action from changing color (no collision-check needed,
  // since the color/avatarId itself never changes here), and keeping it
  // isolated means this is the only place that ever needs to change if
  // Play Pass swap behavior evolves later. Re-validates against this
  // player's cached hasPlayPass/premiumVariantId every time (never
  // trusts the client's claim that a variant is theirs) - the same
  // resolveAvatarVariantForRoom used everywhere else Play Pass touches
  // room state.
  socket.on("updateAvatarVariant", ({ variantId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    const me = room && room.players[socket.id];
    if (!me) return;
    if (!me.hasPlayPass) return; // silently ignore - no client-side error needed for something that should never be reachable in the UI anyway
    if (variantId === null || variantId === undefined) {
      me.avatarVariantId = null;
    } else if (typeof variantId === "string") {
      me.premiumVariantId = variantId; // remember their choice even if it doesn't match the current color (mirrors the account-level field)
      me.avatarVariantId = resolveAvatarVariantForRoom({ hasPlayPass: me.hasPlayPass, activePremiumAvatarVariant: variantId }, me.avatarId);
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
    // [NEW FEATURE - MISSION PROGRESS ON RETURN TO LOBBY] Capture this
    // now, before the missionsDone/missionsTotal wipe further below.
    snapshotMatchMissionsSummary(room);
    delete room.winner;
    delete room.meeting;
    delete room.meetingCooldownUntil;
    // speedLevel is kept: it's the host's choice and everyone still in the
    // lobby is moving at it, so a new joiner must get the same value.
    delete room.activeGateLock;
    delete room.activeSabotageType;
    delete room.departedCrewmateMissions;
    delete room.ghostChat; // [BUG FIX] Clear ghost chat between games
    delete room.matchChat; delete room.ejections; delete room.meetingNo; delete room.backVotes; // [CHAT REDESIGN] new match, fresh meeting chat (+ backed votes)

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
        snapshotRoomLeaderboardOnDeparture(room, room.players[id].accountId, room.players[id].name, room.players[id].avatarId, room.players[id].hasLegionBadge, room.players[id].avatarVariantId, room.players[id].hasPlayPass);
        delete room.players[id];
        if (wasHost) {
          const remaining = bots.humansRemainingAfterLeave(room); // [AI BOTS] humans only - an all-bot room counts as empty, and a bot can never be picked as host
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
      delete p.postKillReportLockUntil;
      delete p.missionsTotal;
      delete p.pendingMissionsDone;
      delete p.killCooldownUntil;
      delete p.x;
      delete p.y;
      delete p.bodyX;
      delete p.bodyY;
      delete p.disguiseAvatarId;
      delete p.disguiseAvatarVariantId;
      delete p.disguiseHasPlayPass;
      delete p.inVent;
    });

    io.to(roomCode).emit("playerListUpdated", { players: getPlayerList(roomCode) });
    // [NEW FEATURE - MISSION PROGRESS ON RETURN TO LOBBY] Sent once,
    // right as everyone lands back in the Lobby - the frontend only
    // ever shows this in the auto-popup leaderboard that greets them at
    // that exact moment, not on later manual opens of the same modal.
    io.to(roomCode).emit("matchMissionsSummary", { missions: room.lastMatchMissions || [] });
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
          (id) => id !== hostId && stillRoom.players[id].inLobbyView && !stillRoom.players[id].isBot // [AI BOTS] never a bot
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
    // [NEW FEATURE - MISSION PROGRESS ON RETURN TO LOBBY] Same capture
    // as returnToLobby - the host can trigger this reset directly
    // without every player individually returning first.
    snapshotMatchMissionsSummary(room);
    delete room.winner;
    delete room.meeting;
    delete room.meetingCooldownUntil;
    // speedLevel is kept: it's the host's choice and everyone still in the
    // lobby is moving at it, so a new joiner must get the same value.
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
    delete room.matchChat; delete room.ejections; delete room.meetingNo; delete room.backVotes; // [CHAT REDESIGN] new match, fresh meeting chat (+ backed votes)

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
      delete p.postKillReportLockUntil;
      delete p.missionsTotal;
      delete p.pendingMissionsDone;
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
      delete p.disguiseAvatarVariantId;
      delete p.disguiseHasPlayPass;
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
  // [FUNDS SAFETY] Called by the host right BEFORE lock_participation.
  // Anyone who paid the entry fee on-chain but never got registered in the
  // room (closed tab, failed confirm) would otherwise have their fee go to
  // the winners while they can't play. While the pool is still Open we
  // either attach them to their player in this room, or refund them.
  socket.on("preparePoolLock", async (_d, callback) => {
    const respond = typeof callback === "function" ? callback : () => {};
    try {
      const room = rooms[socket.data.roomCode];
      if (!room || !room.pool || !room.pool.onChainPoolId) return respond({ ok: true });
      const me = room.players[socket.id];
      if (!me || !me.isHost) return respond({ ok: false, message: "Only the host can start the pool." });
      const chainPool = await viewContract("get_pool", { pool_id: Number(room.pool.onChainPoolId) });
      if (!chainPool) return respond({ ok: false, message: "Couldn't reach the NEAR network - try again in a moment." });
      if (chainPool.state !== "Open") return respond({ ok: true });
      if (chainPool.host_funded) return respond({ ok: true }); // free joiners paid nothing; non-registered ones can never win
      const pool = room.pool;
      const known = new Set(Object.values(pool.onChainWalletByAccountId || {}));
      const strays = (chainPool.participants || []).filter((w) => !known.has(w));
      const refunded = [];
      for (const wallet of strays) {
        // a player in this room with that wallet? register them (their confirm was lost)
        const owner = await Player.findOne({ walletAddress: wallet }, "_id").lean();
        const inRoom = owner && Object.values(room.players).some((p) => p.accountId === String(owner._id));
        if (inRoom) {
          const id = String(owner._id);
          if (!pool.participantAccountIds.includes(id)) pool.participantAccountIds.push(id);
          if (!pool.onChainParticipantAccountIds.includes(id)) pool.onChainParticipantAccountIds.push(id);
          pool.onChainWalletByAccountId = { ...(pool.onChainWalletByAccountId || {}), [id]: wallet };
          pushTxnLog(pool.onChainPoolId, { type: "participate", accountId: id, amountNear: pool.entryFeeNear || 0, note: "Paid entry fee (registered at start)" });
          continue;
        }
        const r = await refundParticipantOnChain(pool.onChainPoolId, wallet);
        if (r.success) {
          refunded.push(wallet);
          pushTxnLog(pool.onChainPoolId, { type: "refund_participant", accountId: owner ? String(owner._id) : null, amountNear: pool.entryFeeNear || 0, note: `Paid but wasn't in the room at start - refunded to ${wallet}` });
          if (owner) sendInboxMessage(owner._id, { title: "Entry fee refunded", body: `You paid ${pool.entryFeeNear} NEAR to join "${pool.poolName || "a paid game"}" but weren't in the room when it started, so it was sent back to ${wallet}.`, nameTag: "Paid Games" }).catch(() => {});
        } else {
          return respond({ ok: false, message: `A player paid but isn't in the room, and their refund failed (${r.error}). Try again in a moment.` });
        }
      }
      savePoolRecord({ onChainPoolId: pool.onChainPoolId }, {
        participantAccountIds: pool.participantAccountIds,
        onChainParticipantAccountIds: pool.onChainParticipantAccountIds,
        onChainWalletByAccountId: pool.onChainWalletByAccountId,
      });
      io.to(room.code).emit("poolUpdated", { pool });
      respond({ ok: true, refunded: refunded.length });
    } catch (e) {
      console.error("[POOL] preparePoolLock failed:", e.message);
      respond({ ok: false, message: "Couldn't check the pool before starting - try again." });
    }
  });

  socket.on("confirmPoolLocked", async () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.pool) return;
    // [SECURITY FIX - CRITICAL] This used to set room.pool.state =
    // "Locked" purely because the client claimed lock_participation had
    // succeeded, with no on-chain check at all. The real risk isn't
    // direct fund theft (distribute_prizes independently checks the
    // REAL on-chain state before paying anyone) - it's a match getting
    // played entirely off-chain while the pool is genuinely STILL "Open"
    // on-chain (e.g. a fabricated confirmPoolLocked event, or a
    // legitimate transaction that silently failed but still reached
    // here somehow) - the final payout would then fail outright (the
    // contract requires Locked), AND the 24h admin fallback also
    // requires Locked, meaning an Open pool with a real completed match
    // behind it could become genuinely unrecoverable. Verifying here
    // catches that before an entire match gets played on a foundation
    // that was never actually real.
    const chainPool = await viewContract("get_pool", { pool_id: Number(room.pool.onChainPoolId) });
    if (!chainPool || chainPool.state !== "Locked") {
      console.warn(`[POOL CONTRACT] confirmPoolLocked rejected for room ${roomCode} - on-chain state is "${chainPool?.state}", not Locked. Not trusting the client's claim.`);
      socket.emit("poolLockVerifyFailed", { message: "Couldn't verify the pool actually locked on-chain yet - wait a moment and try Start again." });
      return;
    }
    room.pool.state = "Locked";
    savePoolRecord({ onChainPoolId: room.pool.onChainPoolId }, { state: "Locked", lockedAt: new Date() });
    pushTxnLog(room.pool.onChainPoolId, { type: "lock_participation", accountId: room.pool.hostAccountId, note: "Host started the game - no more entries accepted." });
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
  // [POOL v2] Only the pool host gets the prize-wallet list.
  socket.on("getPoolWallets", (_d, callback) => {
    const ack = typeof callback === "function" ? callback : () => {};
    const room = rooms[socket.data.roomCode];
    const me = room && room.players[socket.id];
    if (!room || !room.pool || room.pool.mode !== "manual" || !me || me.accountId !== room.pool.hostAccountId) return ack({ ok: false });
    ack({ ok: true, players: manualPoolPlayers(room) });
  });

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

    // [POOL v2] a watching pool host is in the room but never in the match
    const spectatorIds = Object.keys(room.players).filter((id) => room.players[id].spectator);
    const playerIds = Object.keys(room.players).filter((id) => !room.players[id].spectator);

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
    // [PAID GAMES] the top 3 share the pot - fewer than 3 paid players makes no sense, even in dev mode
    if (room.pool && room.pool.mode !== "manual" && !room.pool.hostFunded) {
      const paidIn = playerIds.filter((id) => (room.pool.onChainParticipantAccountIds || []).includes(room.players[id].accountId)).length;
      if (paidIn < 3) {
        socket.emit("startGameError", { message: `Paid games need at least 3 players who paid the entry fee (${paidIn} so far).` });
        return;
      }
    }

    // [NEW POOL SYSTEM] In this design, participate() always happens
    // BEFORE someone ever joins this room's socket room at all (see
    // confirmParticipated) - so there's no more "someone joined the
    // Lobby before their on-chain join landed" race to guard against
    // here. The only remaining gate: the host's own lock_participation
    // call (made right when they press Start) needs to have actually
    // succeeded first - see confirmPoolLocked.
    cancelIdleSettle(room); // [EARLY END] the next match started in time
    if (room.pool && room.pool.mode === "manual" && room.pool.state === "Open") {
      room.pool.state = "Locked"; // nothing on-chain to lock - the first match just starts it
      saveManualPool(room.pool, { state: "Live", players: manualPoolPlayers(room) });
    }
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

    // [NEW FEATURE - HOST CONTROL PANEL] Speed is now a direct movement
    // multiplier - 0.5x to 2x across 7 slider stops. Snapped here too,
    // server-side, so a tampered client can't request an off-step or
    // out-of-range value - defaults to room.speedLevel (or 1x) if not
    // provided.
    let clampedSpeedLevel = snapToSpeedStep(typeof speedLevel === "number" ? speedLevel : (room.speedLevel || 1));
    room.speedLevel = clampedSpeedLevel;

    // [FAIRNESS - SABOTEUR ANTI-STREAK] Still fully random (crypto-grade
    // randomness), but someone who was Saboteur in the previous match(es)
    // of THIS room gets a lower chance next time (1/3 after one turn, 1/5
    // after two in a row, ...). Pure random with 2-3 players often handed
    // the same person the role several times in a row - legit odds, but it
    // feels rigged. Identity = account (or the room seat token for guests),
    // so a refresh/reconnect doesn't reset it. Nobody is ever excluded.
    if (!room.saboteurStreak) room.saboteurStreak = {};
    const streakKey = (id) => {
      const pl = room.players[id] || {};
      return pl.accountId || pl.playerToken || id;
    };
    const rand01 = () => crypto.randomInt(0, 1_000_000) / 1_000_000;
    // [AI BOTS] Only ids allowed to be Saboteur go into the draw (bots
    // are crew-only until saboteur bots can actually kill - see
    // BOTS_CAN_BE_SABOTEUR in bots/botManager.js). Rooms without bots get
    // exactly the same list as before.
    const pool = bots.saboteurCandidateIds(room, playerIds).map((id) => ({ id, w: 1 / (1 + 2 * (room.saboteurStreak[streakKey(id)] || 0)) }));
    const pickedIds = [];
    for (let n = 0; n < saboteurCount && pool.length > 0; n++) {
      const total = pool.reduce((sum, p) => sum + p.w, 0);
      let r = rand01() * total;
      let idx = 0;
      for (; idx < pool.length - 1; idx++) { r -= pool[idx].w; if (r <= 0) break; }
      pickedIds.push(pool[idx].id);
      pool.splice(idx, 1);
    }
    // [AI BOTS] With a restricted candidate list fewer Saboteurs than
    // requested may be drawn - keep the count sent to clients truthful.
    saboteurCount = pickedIds.length;
    const saboteurIds = new Set(pickedIds);
    const nextStreak = {};
    playerIds.forEach((id) => {
      const k = streakKey(id);
      nextStreak[k] = saboteurIds.has(id) ? (room.saboteurStreak[k] || 0) + 1 : 0;
    });
    room.saboteurStreak = nextStreak;

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
    delete room.matchChat; delete room.ejections; delete room.meetingNo; delete room.backVotes; // [CHAT REDESIGN]
    delete room.activeGateLock;
    delete room.activeSabotageType;
    delete room.departedCrewmateMissions;
    Object.values(room.players).forEach((p) => {
      delete p.bodyX; delete p.bodyY;
      delete p.disguiseAvatarId; delete p.disguiseAvatarVariantId; delete p.disguiseHasPlayPass; delete p.disguiseActiveUntil;
      delete p.disconnectedAt;
      delete p.missionsList; delete p.missionsDone; delete p.missionsTotal; delete p.lastMissionCompletedAt; delete p.pendingMissionsDone;
      delete p.sabotageUses; delete p.sabotageCooldownUntil;
      delete p.disguiseCooldownUntil; delete p.postKillSabotageLockUntil; delete p.postKillReportLockUntil;
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
    // [SAME GAME EVERYWHERE] Pool / paid matches now play exactly like Free
    // Play - same map, missions and rules. The pool-only Legion Hub bonus
    // mission is retired (pickBonusMissionType kept for reference).
    delete room.currentBonusMissionType;
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
      room.players[id].alive = true; delete room.players[id].ejected;
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
        mapVersion: bots.MAP_VERSION, // [AI BOTS] lets the client spot a backend running an old map
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
          .map((sid) => ({ name: room.players[sid].name, avatarId: room.players[sid].avatarId, avatarVariantId: room.players[sid].avatarVariantId || null, hasPlayPass: !!room.players[sid].hasPlayPass }));
      }
      io.to(id).emit("roleAssigned", payload);
    });

    // [AI BOTS] Place bots on their spawn points and start their brains.
    spectatorIds.forEach((id, k) => {
      const sp = room.players[id];
      sp.role = "spectator"; sp.alive = false;
      io.to(id).emit("roleAssigned", { role: "spectator", spectator: true, spawnIndex: playerIds.length + k, speedLevel: clampedSpeedLevel, alive: false, saboteurCount, mapVersion: bots.MAP_VERSION, matchId: room.currentMatchId || null, onChainPoolId: room.pool?.onChainPoolId || null, bonusMission: null });
    });
    bots.onGameStarted(roomCode, room, playerIds);

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
  // Client sends: { speedLevel } - a multiplier, one of 0.5/0.75/1/1.25/1.5/1.75/2
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

    const clamped = snapToSpeedStep(speedLevel);
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
    // [NEW FEATURE - PLAY PASS] A disguise's whole point is to make the
    // Saboteur look like a SPECIFIC live player - so avatarId must
    // actually belong to a currently-alive player in this room right
    // now (never trust the client's claim that a color is "available" -
    // resolved and validated here, same principle as every other
    // security-sensitive check in this file). Whatever premium skin
    // that live player currently has active gets copied along with the
    // color, so the disguise is a genuine, exact impersonation - never
    // trust a client-supplied avatarVariantId either, since it's always
    // derived from the target's OWN live state, not sent by the
    // disguising player.
    const targetEntry = Object.entries(room.players).find(
      ([pid, p]) => pid !== socket.id && p.avatarId === avatarId && p.alive !== false
    );
    if (!targetEntry) {
      socket.emit("sabotageError", { message: "That avatar isn't available to disguise as right now." });
      return;
    }
    const targetAvatarVariantId = targetEntry[1].avatarVariantId || null;
    const targetHasPlayPass = !!targetEntry[1].hasPlayPass;

    player.disguiseUsesLeft -= 1;
    player.disguiseCooldownUntil = now + 30000;

    player.disguiseAvatarId = avatarId;
    player.disguiseAvatarVariantId = targetAvatarVariantId;
    player.disguiseHasPlayPass = targetHasPlayPass;
    // [BUG FIX] Track exactly when this disguise expires - needed so a
    // reconnecting Saboteur (their OWN client, after a refresh mid-
    // disguise) can restore their local disguiseActive countdown with the
    // correct remaining time, instead of it just resetting to "not
    // disguised" on their own screen even though the server still has it
    // active (and other players still correctly see them disguised).
    player.disguiseActiveUntil = now + 15000;
    io.to(roomCode).emit("playerDisguised", { id: socket.id, avatarId, avatarVariantId: targetAvatarVariantId, hasPlayPass: targetHasPlayPass, endsAt: player.disguiseActiveUntil });

    // Auto-clear after the same 15s duration the frontend's own
    // DISGUISE_DURATION_MS uses, in case the disguiseEnded event from the
    // Saboteur's own client (sent when their local timer runs out) is
    // ever missed - this is a server-side safety net, not the primary
    // mechanism.
    setTimeout(() => {
      if (room.players[socket.id] && room.players[socket.id].disguiseAvatarId === avatarId) {
        delete room.players[socket.id].disguiseAvatarId;
        delete room.players[socket.id].disguiseAvatarVariantId;
        delete room.players[socket.id].disguiseHasPlayPass;
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
    delete room.players[socket.id].disguiseAvatarVariantId;
    delete room.players[socket.id].disguiseHasPlayPass;
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
    const err = performKill(socket.data.roomCode, socket.id, targetId);
    if (err) socket.emit("killError", err);
  });

  // ---- SABOTAGE ACTION (Saboteur only) ----
  // Client sends: { type } - "electricity" | "hacker" | "gateLeft" | "gateRight"
  // [MULTIPLAYER: SHARED] - server validates the role, then tells every
  // player. Cooldown/timing logic still lives client-side (already built
  // into the frontend) - the server just broadcasts "this action happened".
  socket.on("sabotageAction", ({ type }) => {
    const err = performSabotage(socket.data.roomCode, socket.id, type);
    if (err) socket.emit("sabotageError", err);
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
    const clientDoneCount = missions.filter((m) => m.done).length;
    // Never regress - a modified client "rewinding" its own done count
    // should never be able to undo real progress already recorded.
    if (clientDoneCount < prevDoneCount) return;

    // [BUG FIX - PERMANENTLY STUCK MISSION PROGRESS] The specific list of
    // WHICH missions are done/not-done is always safe to store as-is (it's
    // just display data) - only the aggregate missionsDone COUNT actually
    // needs rate-limiting, since that's what feeds checkWinCondition and
    // real pool prize money. Previously, missionsList/missionsTotal were
    // only ever saved at the very bottom of this handler, AFTER the rate
    // limit check - so if two real missions were completed within
    // MIN_MISSION_COMPLETE_INTERVAL_MS of each other (very possible for a
    // fast player, or several quick missions in a row), that second report
    // was REJECTED OUTRIGHT and NOTHING was saved at all, not even the
    // mission list. Because the frontend only calls this event again on
    // the NEXT completion, and there wasn't one (the player had already
    // finished), the server's missionsDone stayed wrong forever - showing
    // as stuck at 1, the crew progress meter undercounting, and the
    // "every crewmate finished their missions" win condition never
    // firing even once everyone had genuinely finished. Saving the list/
    // total unconditionally here fixes that part immediately.
    player.missionsList = missions;
    player.missionsTotal = missions.length;

    if (clientDoneCount > prevDoneCount) {
      // [SECURITY FIX - REAL EXPLOIT: FAKE MISSION COMPLETION STOLE POOL
      // PRIZE MONEY] missionsDone feeds straight into computeMatchPoints
      // (real NEAR prize money) AND checkWinCondition, so a modified
      // client still can't be trusted to jump the done-COUNT by more than
      // 1 per report, or faster than MIN_MISSION_COMPLETE_INTERVAL_MS -
      // that part of the original fix is unchanged. What's different is
      // what happens when a report legitimately arrives faster than that:
      // instead of dropping it, pendingMissionsDone remembers the real
      // target and applyMissionCatchUp (below) keeps ticking the count up
      // by 1 every interval, fully server-scheduled, until it catches up -
      // so a fast player's progress is never silently lost or frozen,
      // it's just spread out exactly as the rate limit always intended.
      player.pendingMissionsDone = clientDoneCount;
      applyMissionCatchUp(roomCode, socket.id);
    }
  });

  // [BUG FIX - PERMANENTLY STUCK MISSION PROGRESS] Applies at most +1 to a
  // player's missionsDone every MIN_MISSION_COMPLETE_INTERVAL_MS, catching
  // them up toward pendingMissionsDone over time via a self-rescheduling
  // timer. This replaces the old "reject anything faster than the rate
  // limit" behavior, which could permanently freeze a fast player's
  // mission count (and the whole crew's win condition) the moment they
  // completed two missions close together. The rate limit itself is still
  // fully enforced (still exactly 1 real completion credited per
  // interval, still can't be gamed by a modified client reporting a huge
  // jump instantly) - progress just always eventually catches up instead
  // of getting stuck.
  function applyMissionCatchUp(roomCode, socketId) {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players[socketId];
    if (!player) return;
    const target = typeof player.pendingMissionsDone === "number" ? player.pendingMissionsDone : (player.missionsDone || 0);
    const current = player.missionsDone || 0;
    if (target <= current) return; // already caught up, nothing to do

    const now = Date.now();
    const elapsed = player.lastMissionCompletedAt ? now - player.lastMissionCompletedAt : Infinity;

    if (elapsed >= MIN_MISSION_COMPLETE_INTERVAL_MS) {
      player.missionsDone = current + 1;
      player.lastMissionCompletedAt = now;
      // [NEW FEATURE] Task-reminder timer resets on real progress - see
      // the original comment this carried over from: only when the
      // done-count actually goes up, not on every report.
      player.lastMissionActivityAt = now;
      player.inactivityStrikes = 0;

      // [NEW FEATURE] Every mission update moves the shared crew-progress
      // meter too - broadcast the fresh aggregate to the WHOLE room right
      // away so everyone's bar updates live, not just whoever just acted.
      broadcastCrewProgress(roomCode);
      checkWinCondition(roomCode);

      if (player.missionsDone < target) {
        setTimeout(() => applyMissionCatchUp(roomCode, socketId), MIN_MISSION_COMPLETE_INTERVAL_MS);
      }
    } else {
      setTimeout(() => applyMissionCatchUp(roomCode, socketId), MIN_MISSION_COMPLETE_INTERVAL_MS - elapsed);
    }
  }

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
    const err = startMeeting(socket.data.roomCode, socket.id, reason, reportedBodyId);
    if (err) socket.emit("meetingError", err);
  });

  // ---- SKIP DISCUSSION VOTE (during the chat stage) ----
  // Client sends nothing — just casts a "I want to skip discussion" vote.
  // [UPDATE] Threshold now 60% of alive players (was 50%, before that
  // 80% - Om7eth's explicit iterative tuning). [BUG FIX] totalAlive now
  // uses getActiveAliveCount (excludes anyone currently in a disconnect
  // grace period) - see that function's comment for why.
  socket.on("voteSkipDiscussion", () => {
    voteSkipDiscussion(socket.data.roomCode, socket.id);
  });

  // ---- MEETING CHAT MESSAGE ----
  // Client sends: { text }
  // [MULTIPLAYER: SHARED] - every player's chat history should show the
  // same messages, so the server is the single source of truth here.
  socket.on("sendChatMessage", ({ text, replyTo, gifUrl, sticker }) => {
    const res = postMeetingChat(socket.data.roomCode, socket.id, text, replyTo, gifUrl, sticker);
    if (res && !res.senderId && res.message === "You are a ghost and cannot send chat messages.") socket.emit("chatError", res);
  });

  // ---- GHOST CHAT (dead players only, anytime during the game) ----
  // [NEW FEATURE] A completely separate channel from the normal meeting
  // chat above. Only ever sent to OTHER CURRENTLY-DEAD players'
  // individual sockets (never broadcast to the whole room) - this is
  // what makes it structurally impossible for an alive player to ever
  // see a ghost chat message, regardless of any client-side bug, since
  // their socket is simply never one of the targets in the first place.
  socket.on("sendGhostChatMessage", ({ text, replyTo, gifUrl, sticker }) => {
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
    // [NEW FEATURE - PLAY PASS] GIFs are a Play Pass perk - strip any
    // gifUrl server-side if the sender doesn't actually have Play Pass,
    // regardless of what the client sent (the UI already locks this, but
    // never trust the client alone for a gated feature).
    const safeGifUrl = sender.hasPlayPass ? validateGifUrl(gifUrl) : null;
    const safeSticker = sender.hasPlayPass ? validateSticker(sticker) : null; // [PLAY PASS - STICKERS]
    if (!trimmed && !safeGifUrl && !safeSticker) return;

    const message = {
      senderId: socket.id,
      senderName: sender.name,
      senderAvatar: sender.avatarId,
      // [NEW FEATURE - PLAY PASS] Frozen at send time, same reasoning as
      // senderHasLegionBadge right below.
      senderAvatarVariant: sender.avatarVariantId || null,
      senderHasPlayPass: !!sender.hasPlayPass,
      // [NEW FEATURE - NEAR LEGION BADGE] Frozen at send time, same as
      // senderName/senderAvatar - keeps working even if the sender later
      // leaves the room, unlike a live lookup would.
      senderHasLegionBadge: !!sender.hasLegionBadge,
      text: trimmed,
      gifUrl: safeGifUrl,
      sticker: safeSticker,
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
  socket.on("sendLobbyChatMessage", ({ text, replyTo, gifUrl, sticker }) => {
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
    // [NEW FEATURE - PLAY PASS] GIFs are a Play Pass perk - strip any
    // gifUrl server-side if the sender doesn't actually have Play Pass,
    // regardless of what the client sent (the UI already locks this, but
    // never trust the client alone for a gated feature).
    const safeGifUrl = sender.hasPlayPass ? validateGifUrl(gifUrl) : null;
    const safeSticker = sender.hasPlayPass ? validateSticker(sticker) : null; // [PLAY PASS - STICKERS]
    if (!trimmed && !safeGifUrl && !safeSticker) return;

    const message = {
      id: `${socket.id}-${Date.now()}`,
      senderId: socket.id,
      senderName: sender.name,
      senderAvatar: sender.avatarId,
      // [NEW FEATURE - PLAY PASS] Frozen at send time, same reasoning as
      // senderHasLegionBadge right below.
      senderAvatarVariant: sender.avatarVariantId || null,
      senderHasPlayPass: !!sender.hasPlayPass,
      // [NEW FEATURE - NEAR LEGION BADGE] Frozen at send time, same as
      // senderName/senderAvatar - keeps working even if the sender later
      // leaves the room, unlike a live lookup would.
      senderHasLegionBadge: !!sender.hasLegionBadge,
      text: trimmed,
      gifUrl: safeGifUrl,
      sticker: safeSticker,
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
  socket.on("castVote", ({ targetId, back }) => {
    const err = castMeetingVote(socket.data.roomCode, socket.id, targetId, !!back);
    if (err) socket.emit("voteError", err);
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

    // [NEW FEATURE - PRIVATE ROOM JOIN REQUESTS] A requester isn't
    // actually "in" any room yet (no socket.data.roomCode set) while
    // their request is pending, so this can't rely on the room-lookup
    // below - scan every room's pending requests for this socket.id
    // directly. Cheap in practice (there are never many rooms/pending
    // requests at once), and stops a host from being able to approve a
    // request whose requester already left.
    for (const rc of Object.keys(rooms)) {
      const r = rooms[rc];
      if (!r.pendingJoinRequests) continue;
      for (const rid of Object.keys(r.pendingJoinRequests)) {
        if (r.pendingJoinRequests[rid].socketId === socket.id) {
          clearTimeout(r.pendingJoinRequests[rid].timeoutHandle);
          delete r.pendingJoinRequests[rid];
        }
      }
    }

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
      // [BUG FIX - AUTO-CONFIRM NEVER FIRED ON DISCONNECT] leaveRoom
      // (the explicit Leave button) already schedules the 1-minute
      // auto-confirm-on-leave grace timer for a participant who hasn't
      // confirmed the final leaderboard yet - a plain disconnect (app
      // closed, connection dropped, tab killed) never did, even though
      // room.gameStarted deliberately stays true after a winner is
      // decided (only returnToLobby resets it), meaning THIS is the
      // branch a post-match disconnect actually goes through. Without
      // this, one player simply closing the app after a match ended
      // could block everyone else's prize money indefinitely - exactly
      // what this feature exists to prevent, just missing from this
      // path. Scheduled immediately (same as leaveRoom), independent of
      // the separate reconnect-grace timer below - cancelAutoConfirmOnLeave
      // already runs on a successful reconnect, so coming back in time
      // still cancels it either way.
      if (
        room.pool && room.pool.state === "Locked" &&
        (room.pool.matchesPlayed || 0) >= room.pool.maxMatches &&
        player.accountId &&
        (room.pool.participantAccountIds || []).includes(player.accountId) &&
        !(room.pool.confirmedAccountIds || []).includes(player.accountId)
      ) {
        scheduleAutoConfirmOnLeave(roomCode, player.accountId);
      }
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
          snapshotRoomLeaderboardOnDeparture(stillRoom, stillRoom.players[socket.id].accountId, stillRoom.players[socket.id].name, stillRoom.players[socket.id].avatarId, stillRoom.players[socket.id].hasLegionBadge, stillRoom.players[socket.id].avatarVariantId, stillRoom.players[socket.id].hasPlayPass);
          delete stillRoom.players[socket.id];
          const remaining = bots.humansRemainingAfterLeave(stillRoom); // [AI BOTS] humans only - an all-bot room counts as empty, and a bot can never be picked as host
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
                } else if (room.pool.state === "Locked" && (room.pool.matchesPlayed || 0) >= 1 /* [EARLY END] partial result counts */) {
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
    // [BUG FIX - AUTO-CONFIRM NEVER FIRED ON DISCONNECT] Same safety net
    // as the mid-game disconnect branch above, for the (normally
    // unreachable, since room.gameStarted stays true until
    // returnToLobby) edge case where this room somehow still has an
    // unconfirmed pool leaderboard while gameStarted is false.
    if (
      room.pool && room.pool.state === "Locked" &&
      (room.pool.matchesPlayed || 0) >= room.pool.maxMatches &&
      player.accountId &&
      (room.pool.participantAccountIds || []).includes(player.accountId) &&
      !(room.pool.confirmedAccountIds || []).includes(player.accountId)
    ) {
      scheduleAutoConfirmOnLeave(roomCode, player.accountId);
    }
    io.to(roomCode).emit("playerListUpdated", { players: getPlayerList(roomCode) });

    setTimeout(() => {
      const stillRoom = rooms[roomCode];
      if (!stillRoom) return;
      const stillPlayer = stillRoom.players[socket.id];
      if (stillPlayer && stillPlayer.disconnectedAt) {
        const wasHost = stillPlayer.isHost;
        // [BUG FIX - PAID PARTICIPANT LEAVING PRE-GAME HAD NO REFUND
        // PATH] Same trigger as leaveRoom's explicit-Leave version -
        // this covers the "just closed the app / lost connection and
        // never came back" case instead. Only fires once the grace
        // period has genuinely expired (they didn't reconnect), not on
        // the disconnect itself, so a brief network blip never
        // needlessly cancels a whole pool.
        const departedAccountId = stillPlayer.accountId || null;
        const mustCancelPoolOnDepart = !!(
          stillRoom.pool && stillRoom.pool.mode !== "manual" && !stillRoom.gameStarted && poolIsCancellable(stillRoom.pool) &&
          departedAccountId && (
            departedAccountId === stillRoom.pool.hostAccountId ||
            (!stillRoom.pool.hostFunded && (stillRoom.pool.onChainParticipantAccountIds || []).includes(departedAccountId))
          )
        );
        if (mustCancelPoolOnDepart) {
          const onChainPoolId = stillRoom.pool.onChainPoolId;
          const wasHostDeparting = departedAccountId === stillRoom.pool.hostAccountId;
          io.to(roomCode).emit("roomClosedByHost", { reason: wasHostDeparting ? "Host left before the pool started - refunding everyone." : "A paying participant left before the pool started - refunding everyone." });
          markRoomMessageClosedForever(stillRoom); // fire-and-forget
          delete rooms[roomCode];
          (async () => {
            if ((stillRoom.pool.onChainParticipantAccountIds || []).length > 0) {
              const refund = await cancelPoolOnChain(onChainPoolId);
              console.log(refund.success
                ? `[PRE-GAME DISCONNECT] Pool #${onChainPoolId} cancelled + refunded on-chain (${wasHostDeparting ? "host" : "a paid participant"} disconnected from room ${roomCode} before it started).`
                : `[PRE-GAME DISCONNECT] Pool #${onChainPoolId} could NOT be refunded automatically (room ${roomCode}): ${refund.error} - will keep retrying automatically.`);
            }
          })();
          return;
        }
        snapshotRoomLeaderboardOnDeparture(stillRoom, stillPlayer.accountId, stillPlayer.name, stillPlayer.avatarId, stillPlayer.hasLegionBadge, stillPlayer.avatarVariantId, stillPlayer.hasPlayPass);
        delete stillRoom.players[socket.id];
        const stillRemaining = bots.humansRemainingAfterLeave(stillRoom); // [AI BOTS] humans only - an all-bot room counts as empty, and a bot can never be picked as host
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
      if (p.isBot) return; // [AI BOTS] the inactivity kick is for AFK humans only
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
        snapshotRoomLeaderboardOnDeparture(room, p.accountId, p.name, p.avatarId, p.hasLegionBadge, p.avatarVariantId, p.hasPlayPass);
        delete room.players[id];
        console.log(`${playerName} kicked from room ${roomCode} for mission inactivity`);

        const remaining = bots.humansRemainingAfterLeave(room); // [AI BOTS] humans only - an all-bot room counts as empty, and a bot can never be picked as host
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

// [NEW FEATURE - FUNDS SAFETY: ORPHANED POOL RECOVERY] See
// reconcileOrphanedPools' own comment for what this actually protects
// against. The startup run is delayed 30s to give the MongoDB
// connection (and, less critically, the RPC provider) a moment to be
// ready right after a fresh boot - exactly the moment this is most
// likely to actually find something to do, since a restart is one of
// the two things this whole mechanism exists to recover from.
setTimeout(() => { reconcileOrphanedPools(); reconcileManualPools(); }, 30 * 1000);
const RECONCILE_INTERVAL_MS = 3 * 60 * 1000;
setInterval(() => { reconcileOrphanedPools(); reconcileManualPools(); }, RECONCILE_INTERVAL_MS);

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
