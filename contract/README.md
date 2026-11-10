# NEAR Saboteur: Pool Escrow Contract (v4)

This is a guide for an external reviewer. It assumes no knowledge of the game.

- **Live on testnet:** `near_saboteur_contract.testnet` (`get_version` → `4.0.0`). [Explorer](https://testnet.nearblocks.io/address/near_saboteur_contract.testnet)
- **Source:** [`src/lib.rs`](src/lib.rs). The contract itself is about 460 lines, and the unit tests below it take up the rest.
- **SDK:** `near-sdk = 5.26.1` with the `legacy` collections, built with Rust 1.93 for `wasm32-unknown-unknown`.

## 1. The game, in one minute

NEAR Saboteur is a browser game in the style of a social deduction game. 4–10 players are on a space station: most are *crew* who do missions, and 1–3 are secret *saboteurs*. Players meet, discuss and vote people out, and each match gives every player **points**.

Players can also play for a prize, over 1–5 matches in a row. That is what this contract is for:

| Mode | Who pays | Example |
|---|---|---|
| **Pool Game** (`host_funded = true`) | One person (the *host*) puts up the whole prize. Others join for free. | The host funds 1 NEAR, 6 friends play, and the top 3 by total points split it. |
| **Paid Game** (`host_funded = false`) | Every player pays the same entry fee. | 5 players × 0.2 NEAR = 1 NEAR pot, and the top 3 split it. |

**Who does what:**
- **Gameplay is off-chain.** It runs on a Node.js server, and nobody signs anything during play.
- **The contract only holds the money and pays it out.** It has no idea what a "match" or a "point" is.
- **The game server calls the payout** using one account, the **oracle**, once the last match ends. It ranks players by their total points and tells the contract who gets which share.

## 2. Roles

| Role | Account (testnet) | Can do |
|---|---|---|
| **Owner** | `om7eth.testnet` | Change the oracle, withdraw the 5% platform fees, and use the 24h emergency fallback. |
| **Oracle** (game server) | `nearsaboteurpool.testnet` | Pay out a pool, cancel/refund a pool, refund one player, or remove a free joiner. It can only ever send money to that pool's own participants, or back to whoever paid it in. |
| **Host** | any account | Create a pool, start it (`lock_participation`), and cancel it while it is still Open. |
| **Player** | any account | Join (`participate`), and claim a failed payout (`claim_unclaimed`). |

## 3. Lifecycle

```
create_pool ──► Open ──lock_participation (host)──► Locked ──distribute_* (oracle)──► Distributed
                 │                                     │
                 └──cancel_pool (host/oracle)──► Refunded ◄──cancel_pool (oracle only)
                                                       ▲
                          admin_refund_pool / admin_release_pool (owner, ≥24h after lock)
```

- **`create_pool(name, max_matches, entry_fee, host_funded)`**
  - With `host_funded`, attach exactly `entry_fee`, which is the whole prize. The host becomes participant #1.
  - Otherwise attach 0.
- **`participate(pool_id)`**
  - Entry-fee pool: attach exactly `entry_fee`.
  - Host-funded pool: attach 0. Joining is free and only makes you eligible to win.
- **`lock_participation(pool_id)`:** host only. Nobody can join after this.
- **Payout (oracle):** 5% of `total_fund` goes to the platform, and the rest (the *pot*) is split.
  - `distribute_prizes(pool_id, ranked_winners)` is the v3 method. It takes 1–3 accounts and pays 50/30/20, renormalised if there are fewer than 3.
  - `distribute_shares(pool_id, payouts: [{account_id, bps}])` was added in v4 for ties. It takes 1–10 distinct participants whose `bps` add up to exactly 10000. For example, two players tied for 1st get 4000 bps each.
- **Cancel:**
  - `cancel_pool` refunds everyone: each player gets their fee back, or the host gets the whole prize back for a host-funded pool.
  - `refund_participant` refunds one player while the pool is Open.

## 4. Trust model: please confirm this is acceptable

- **The oracle decides the winners.** The contract checks that every receiver is a participant, that there are no duplicates, and that the shares add up to 100%. It cannot check that the ranking is *true*, because points live off-chain. The oracle key sits on the game server.
- **The oracle can cancel a Locked pool,** which refunds everyone. That is how the server handles "a match started, but none finished".
- **The owner** can only act on a pool 24h after it was locked and never paid out. The owner can also change the oracle.
- **There is no upgrade lock.** The contract account's full-access key can redeploy the code. Deployment goes through a GitHub Action.

## 5. What changed from v3 to v4

v3 was written before the hackathon. v4 is the result of an internal audit.

| # | Problem in v3 | v4 fix |
|---|---|---|
| 1 | `distribute_prizes` with an **empty winner list** marked the pool `Distributed` and sent nothing. 95% of the pool was then stuck in the contract forever. About 7.4 NEAR on testnet is unaccounted for, probably from this. | A payout needs ≥ 1 winner. |
| 2 | The same account could appear **twice** in `ranked_winners` and be paid twice. | Duplicates are rejected. |
| 3 | `admin_refund_pool` on an **entry-fee pool sent the whole pot to the host**, not back to each player. | Each player gets their own fee back. |
| 4 | Transfers were fire-and-forget. If a receiver account didn't exist, the NEAR bounced back into the contract **with no record**. | Every transfer has an `on_transfer_done` callback (`#[private]`). A failure is stored under the receiver's own account, and only that account can `claim_unclaimed()` it, always to itself. |
| 5 | Rounding dust from splits stayed untracked in the contract balance. | `fee + dust = total_fund − sent` goes to `platform_fees_balance`. Every yocto is accounted for. |
| 6 | Ties were impossible: the payout was always 50/30/20 by position. | `distribute_shares` with explicit basis points. |
| 7 | Storage spam: unlimited name length and unlimited free joiners. | Name ≤ 64 bytes and ≤ 50 participants. The oracle can `remove_free_participant` on an Open host-funded pool. |
| 8 | No way to tell versions apart from the outside. | `get_version`, `get_config`, `get_unclaimed`, plus NEP-297-style `EVENT_JSON` logs. |

**The storage layout is unchanged** (same `Contract` and `Pool` structs). The only new storage is a separate `LookupMap` under prefix `u` for unclaimed amounts. v4 was deployed over v3 with no migration.

## 6. How it was tested

- **28 unit tests** at the bottom of `lib.rs`, run with `cargo test`. They cover:
  - Payout maths, including exact transfer amounts and the fee + dust accounting.
  - Ties, and that zero or duplicate winners and outsiders are rejected.
  - Access control for every role.
  - Cancel, refund and admin refund, including who receives the money.
  - The 24h hold, limits, and the failed-transfer → claim flow.
- **Testnet end-to-end:** v3 was deployed to a throwaway account and real pools were created with it (one Locked, one Open). v4 was then deployed over it with no init. The test checked:
  - Old pools still read correctly.
  - A tie payout delivered exactly 40/40/20.
  - Paying twice is rejected.
  - The private callback can't be called from outside.
  - A deleted winner's prize became claimable, and was claimed back after the account was recreated.

  22/22 checks passed.
- The deploy GitHub Action runs `cargo test` before deploying.

## 7. Build and test

```bash
rustup target add wasm32-unknown-unknown
cargo test
cargo build --target wasm32-unknown-unknown --release
# -> target/wasm32-unknown-unknown/release/near_saboteur_pool.wasm (~195 KB)
```

## 8. What we'd most like a second opinion on

1. **Detached promises.** Each transfer is created as `Promise::new(..).transfer(..).then(callback).detach()` inside a loop (up to 10 per call), and nothing is returned or joined. Is that sound with near-sdk 5.26? Is 5 Tgas enough for `on_transfer_done`?
2. **Callback result check.** `env::promise_result_checked(0, 64).is_ok()` is used as "transfer succeeded". Is that right for a plain Transfer?
3. **State changes before transfers.** The state is set to `Distributed`/`Refunded` before the transfers are sent. Is there any path where funds can be lost or double-spent, given the failed-transfer handling?
4. **Gas.** Is 100–200 Tgas enough for 10 transfers plus 10 callbacks? Should payouts be capped lower?
5. **Storage staking.** Pools are never deleted. Is there any way contract storage growth could make a transfer fail with `LackBalanceForState`?
6. **Trust model.** Is the trust model in section 4 reasonable for a small testnet game? Anything you would restrict further, for example a time window on the oracle cancelling a Locked pool?
7. **Anything else** you would change before this holds real (mainnet) NEAR.

*Out of scope:* the game's `$SABOTEUR` token is NEAR's unmodified official NEP-141 example contract (`fungible_token.wasm`), not this code.
