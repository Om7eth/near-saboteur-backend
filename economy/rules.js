// ============================================================
// $SABOTEUR economy rules - the ONE readable place for every number.
// (Testnet only. Change a value here, restart the server, done.)
//
// The loop:
//   missions / kills  ->  match points
//   meeting vote      ->  optional "back your vote" (+/- points, settled at match end)
//   match end         ->  rank by points  ->  $SABOTEUR from the treasury
//
// Voting itself is ALWAYS free. Backing a vote never needs a balance:
// nothing is taken during the meeting, the +/- is applied at match end,
// and a player's match total never goes below 0.
// ============================================================

const RULES = {
  // ---- Back your vote ----
  backVote: {
    points: 5,              // right: +5, wrong: -5 (match points)
    freePlayOnly: true,     // Pool/Paid prizes are decided by points - don't touch real-money ranking
  },

  // ---- Rank rewards (whole $SABOTEUR) ----
  rewardsByRank: [1000, 600, 400], // 1st, 2nd, 3rd
  rewardFinished: 100,             // everyone else who finished the match

  // ---- How many real people played (bots don't count) ----
  // 1 person + bots -> 1st gets 10. 2-3 people -> 1st gets 100. 4+ -> 1000.
  humanTiers: [
    { minHumans: 4, multiplier: 1 },
    { minHumans: 2, multiplier: 0.1 },
    { minHumans: 1, multiplier: 0.01 },
  ],

  // ---- Anti-farming ----
  noRewardForGuests: true,       // must have an account (wallet is made for you automatically)
  noRewardIfLeftEarly: true,     // only players still in the room when the match ends
  dailyFullMatches: 5,           // per account, per UTC day
  afterDailyMultiplier: 0.25,    // 6th+ match of the day pays 25%
  noSignupBonus: true,           // tokens only ever come from finished matches

  // ---- Safety ----
  // The server only holds a SMALL hot wallet (rewards.<parent>); the big
  // treasury and the token contract are on a key kept offline.
  rewardsLowWarning: 50000,      // admin dashboard warns below this - refill rewards from the treasury
  botBalanceCap: 50000,          // a bot earning past this sends its rewards to the Bot Treasury instead
  // Players can NOT send or transfer $SABOTEUR: their wallet is made and
  // held by the game (no key is ever given out) and there is no transfer
  // feature. Tokens only arrive as match rewards.
  playerTransfers: false,

  // ---- Bots ----
  // Bots rank and earn exactly like people. Their tokens stay in their own
  // wallet (bot-<name>.<parent>) - up to botBalanceCap, the rest goes to the
  // Bot Treasury (bots.<parent>) - for NEAR AI credits,
  // game improvements, airdrops or campaigns, decided by the game owner.
  botsEarn: true,
  // Play Pass holders earn this many times the normal match reward. Testnet
  // tokens only - no cash value and no promise about the future.
  playPassMultiplier: 2,
  // A bot backs its vote only with real evidence from its memory (saw the
  // kill, or found the body next to someone). A saboteur bot sometimes
  // backs its scapegoat to look confident.
  saboteurBotBluffChance: 0.4,
};

function humanMultiplier(humans) {
  for (const t of RULES.humanTiers) if (humans >= t.minHumans) return t.multiplier;
  return 0;
}

// rank: 1-based. Returns whole tokens (may be fractional for small tiers).
function rewardFor(rank, humans, { reducedForDay = false } = {}) {
  const base = rank <= RULES.rewardsByRank.length ? RULES.rewardsByRank[rank - 1] : RULES.rewardFinished;
  const amount = base * humanMultiplier(humans) * (reducedForDay ? RULES.afterDailyMultiplier : 1);
  return Math.round(amount * 100) / 100;
}

module.exports = { RULES, humanMultiplier, rewardFor };
