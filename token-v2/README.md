# $SABOTEUR v2: the game token with its mechanic in the contract

`sabo.saboteur.testnet` (NEAR testnet), NEP-141 + NEP-148, `near-sdk 5.26.1`.

**$SABOTEUR is a testnet token you earn by playing. You can burn it for in-game items like Play Pass, but it has no cash value: it can't be bought, sold, transferred or cashed out, and nothing is promised about its future.**

## The mechanic: catch = burn

| Rule (fixed in the contract, read it with `get_rules`) | Value |
|---|---|
| Match reward, 1st / 2nd / 3rd / finished | 1,000 / 600 / 400 / 100 |
| Share by real players in the match: 4+ / 2–3 / 1 / bots only | 100% / 10% / 1% / 0 |
| Daily: first 5 matches full, then | 25% |
| Play Pass holders | ×2 |
| **Saboteur caught**: burned from the Ritual Pool (× the same share) | **1,000** |
| **Play Pass**: burned from the buyer | **15,000** |
| **Weekly reward budget** | **150,000 + 50% of last week's burns** |
| Referral | 1,000 (inside the weekly budget) |
| Supply | 1,000,000,000, created once at genesis (no minting later) |
| Ritual Pool | 50,000,000 |

- **The game reports, the contract decides.** The game account can only call `reward_match` (who placed where, how many real players), `catch_ritual` and `reward_referral`. Every amount is computed here. Each match id is accepted once, so a retry can never pay twice.
- **Catch = burn.** When the crew votes out the real saboteur, `catch_ritual` burns tokens from the contract's own Ritual Pool. It never burns from players.
- **Supply reacts to the community.** Burns from catches, Play Passes and holders raise next week's reward budget. More real games mean more catches, more burns and bigger rewards. Farming with bots earns and burns almost nothing (1% / 0).
- **Rules can't change quietly.** The owner (a cold key) can only `propose_rules`. A proposal is public and applies after **7 days**, inside hard bounds checked by the contract (for example a multiplier of at most 3x, and no reward above 10,000).
- **v1 → v2 migration.** Every v1 balance (39 holders, 36,573 tokens) was copied once, then `finish_migration` closed it forever. The migration is capped at 2M tokens.

## Limits (stated plainly)

- **The game server is a trusted reporter.** Matches are played off-chain, so the game account reports who placed where and how many real players there were. The contract decides every amount, accepts each match id once, and caps everything with the weekly budget. A leaked game key can at most pay out this week's budget, and can never change the rules.
- **Sybil resistance (good enough for a demo):** full rewards need 4+ real players in a match (1 player + bots earns 1%, bots-only earns 0). After 5 matches a day an account earns 25%. Guests and players who leave early earn nothing (enforced by the game). Burns from bot-only catches are 1%. Someone with many accounts in one room could still farm up to the weekly budget.
- **No one can change the code.** The contract account `sabo.saboteur.testnet` has **0 access keys** (its only key was deleted on 12 Nov 2026, tx `BKngCdhS11HRJci2of97Fx6PK7ryM4PoDKctUt3n775i`). Nobody can redeploy it, not even us.
- **No instant admin.** The owner (a cold key, not on the server) can only *propose* new rules. They apply after a public 7-day timelock, inside hard limits checked by the contract.
- **Testnet only**, by choice: no cash value, nothing promised.

## 60-day supply simulation

`python3 token-v2/simulate.py` runs the contract's exact rules over 60 days for three community sizes (standard library only). Day 60:

| Community | Matches a day (real players) | Earned by players | Burned by catches | Burned for Play Pass | Total supply | Days the weekly budget ran out |
|---|---|---|---|---|---|---|
| Today (small) | 10 (~2) | 233,823 | 37,630 | 0 | 999,962,370 | 0 |
| Growing | 60 (~4) | 2,128,333 | 1,198,630 | 360,000 | 998,441,370 | 43 |
| Busy | 250 (~6) | 5,446,523 | 6,756,200 | 1,800,000 | 991,443,800 | 59 |

What it shows: supply only goes down, burns grow faster than rewards as more real people play, and the weekly budget is what stops farming. At 60+ full matches a day the budget runs out late in the week, so a growing community would raise `weekly_base_budget` through the public 7-day timelock.

## Methods

- **Game account:** `reward_match(match_id, humans, results[{account_id, rank, play_pass}])`, `catch_ritual(match_id, humans)`, `reward_referral(referral_id, account_id)`.
- **Holders** (1 yocto deposit): `buy_play_pass()`, `burn(amount)`, and the standard `ft_transfer` / `ft_transfer_call`.
- **Owner** (1 yocto deposit): `propose_rules(rules)`, `cancel_proposed_rules()`, `set_game(id)`, plus the one-time `migrate(entries)` and `finish_migration()`.
- **Views:** `get_rules`, `get_stats` (supply, burned by catches / passes / holders, catches, passes, this week's budget), `has_play_pass`, `get_config`, and the NEP-141 views.
- **Events:** NEP-141 `ft_burn` / `ft_transfer`, plus `saboteur` events: `match_rewarded`, `saboteur_caught`, `play_pass`, `new_week`, `rules_proposed`, `rules_applied`.

## Build, test and deploy

```bash
cargo test                                           # 20 unit tests
cargo build --target wasm32-unknown-unknown --release
node ../scripts/deploy-saboteur-v2.mjs               # create, deploy, init, migrate (safe to re-run)
```

The contract account and the owner use cold keys kept only on the founder's machine. The game server holds only the game account's key.
