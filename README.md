# NEAR Saboteur — backend

Node / Express / Socket.io server for NEAR Saboteur, plus the pool escrow contract (`contract/`, Rust).

**NEAR Hackathon (Games With Real Economies):** the main submission README, with the feature list and prior-work disclosure, is in the frontend repo: https://github.com/Om7eth/near-saboteur-frontend

- **Live game:** https://nearsaboteur.com
- **Baseline before the hackathon:** commit [`25b6b99`](https://github.com/Om7eth/near-saboteur-backend/commit/25b6b99) (6 Oct 2026), tagged `pre-hackathon`.
- **Hackathon work:** [compare `pre-hackathon...hackathon-submission`](https://github.com/Om7eth/near-saboteur-backend/compare/pre-hackathon...hackathon-submission)
- **AI tools:** much of the code was written with the help of Claude (Claude Code), directed, reviewed and tested by the founder.
- **License:** MIT, see [LICENSE](LICENSE).

## Pool Games

A pool game is a prize pool that one player (the **host**) puts up for a room. The host can host it for their own community and doesn't have to play.

When creating a pool, the host picks:

- **Matches:** 1 to 5 (default 3). Players are ranked by their total points across all matches.
- **Who can join:**
  - **Public:** listed under Live Pools, so anyone can join or share the invite link.
  - **Private:** only the host has the invite link, and they accept or decline each player.
- **Their own role:** **Play**, **Watch** (spectate the whole match) or **Host only**. This is fixed for the whole pool.
  - A playing host who leaves gets the lobby back when they return.
  - If the host isn't playing, any player can run the lobby. The host still controls approvals, wallets and payouts.

### Two payout modes

| Mode | Money | How winners get paid |
|---|---|---|
| **Testnet · auto payout** | Test NEAR held by the pool contract | The contract pays the top 3 automatically (50 / 30 / 20 after the 5% fee). Tied players share their places. |
| **Real NEAR · host pays** | Real NEAR on **mainnet**, never held by the game | Players give a mainnet address (`name.near`, `name.tg`, …) when they join. After the last match the game ranks everyone and works out each prize from the host's own split. The host pays everyone from their own wallet: in **one click** or manually, as described below. Each winner gets an Inbox message. |

### Real NEAR payouts: one click or manual

This is a real mainnet money flow inside the game today. When the host opens **Pool Games → History → Pay winners**, they can pay in either of two ways:

1. **One click: "Pay all winners".** The host connects their mainnet wallet (HOT, Meteor or Intear) and approves **once**.
   - The wallet sends one transfer per winner, straight to the address each winner gave when joining.
   - The server then reads every transaction on NEAR mainnet. It checks that the transaction succeeded, that the receiver is that winner's address, and that the amount is at least the prize.
   - Only then is the prize marked **✓ VERIFIED**, and the winner is told it was verified on-chain.
   - If the tab closes after the wallet approval but before every payment is checked, the check runs again the next time the page opens.
2. **Manual.** The host sends each amount themselves, from any wallet, and presses **Mark as paid**.
   - If they add the transaction hash, it is verified the same way.
   - Without a hash, the winner is told the host *marked* it as sent, not that it was verified.

Either way, one transaction can only prove one prize. The game never holds, touches or signs for this money.

> **Real NEAR mode is temporary.** It exists because the game runs on NEAR testnet today. When NEAR Saboteur moves to mainnet, the manual "host pays" flow will be removed. Prizes will then be held and paid out by the in-game contract, the same way the testnet mode works now.

Relevant endpoints and events:

- **Endpoints:**
  - `GET /pools/history`: pools you hosted and joined, with winners and paid status.
  - `POST /pools/manual/:poolId/paid`: the host marks a winner as paid.
  - `POST /pools/payout-wallet`: a player saves or changes their prize address.
- **Socket events:** `createRoom` with `poolConfig.mode = "manual"`, plus `joinRoom` / `requestJoinRoom` with `payoutWallet`.

### When a pool ends early

Prizes go out automatically 15 seconds after the last match. Nobody has to confirm anything. A pool can also end before all its matches are played:

| Situation | What happens |
|---|---|
| No match finished: the room empties, the host closes it, or the server restarts | **Cancelled.** Testnet pools refund entry fees on-chain. In Real NEAR pools nobody is owed anything. |
| Some matches finished (for example 1 or 2 of 3): the room is empty for 3 minutes, the host closes it, or the lobby sits idle | **Settled on the matches played.** The standings after those matches count, and the result is marked "ended early". |
| The lobby sits idle between matches | The next match must start within **10 minutes**. The lobby shows a countdown. After that, the pool settles on the matches played so far. |
| The server restarts in the middle of a Real NEAR pool | Standings are saved after every match. Once no server has touched the pool for 15 minutes, it is settled from those saved standings, or cancelled if no match had finished. |
| Players tie | The tied players share the places they cover equally. For example, two players tied for #1 on a 50/30/20 split each get 40%. This applies to Real NEAR pools and, with pool contract v4, to testnet pools too. |
| Nobody who paid scored a point (testnet) | Everyone is refunded. A payout to zero winners is impossible: contract v4 rejects it. |
| Fewer players scored than there are paid places | The prize for the empty places stays with the host. Only players with more than 0 points can win. |
| A Real NEAR host leaves before the first match | The pool stays open, and any player can run the lobby. A testnet pool host leaving before the start still cancels and refunds the pool. |

The lobby **Standings** board shows each player's line for every match: role, won or lost, missions or kills, and points. Tap a player to see it.

## Weekly Rewards Agent (NEAR Intents)

Every week the top 3 on the weekly Ranks get **real NEAR on mainnet**. An agent account on NEAR Intents pays them, through the [NEAR Intents Agent API](https://partners.demo.agentsonintents.com/). The code is in `economy/weeklyAgent.js`, and the admin page is Admin → Weekly rewards.

- **The owner is `saboteur.near`.** It signs the agent's rules once in the admin page, with its own wallet through NEAR Connect. The game server never holds its key.
- **The rules (policy):**
  - Withdraw only, and only wNEAR (no swaps, no transfers).
  - A weekly USD cap of 1.5× the prize.
  - A per-payment cap.
  - Rules are enforced by the API, not by our code.
- **The game server** holds only the partner API key (env) and a grant token, which is encrypted in MongoDB.
- **At the weekly reset (Saturday 00:00 IST)** the top 3 are queued as one batch with one **30-minute timer**. The admin can *Send now* or *Cancel this week*. When the timer ends, all three are paid together.
  - The split is 50/30/20.
  - The USD prize is converted at the live NEAR price.
  - Ties go to whoever reached the score first.
  - Held or banned accounts are skipped.
- **No double payments:** every payment's `Idempotency-Key` is saved before it is sent. A lost response is retried with the same key.
- **No wallet yet?** The prize waits 30 days and is paid automatically once the player adds a prize wallet (Ranks → prize wallet).
- **Notifications:**
  - Winners get Inbox messages when they are queued and again when the prize is paid (with the tx).
  - A News post goes out when the week is paid.
- **Switching it off:** choose "Pay this week, then stop" or "Stop now". *Freeze* and *Withdraw to saboteur.near* are owner-signed.

Env: `NEAR_INTENTS_AGENT_API_KEY` (required). Optional:
- `NEAR_INTENTS_AGENT_API_URL` (default `https://api.demo.agentsonintents.com`)
- `WEEKLY_AGENT_OWNER` (default `saboteur.near`)
- `WEEKLY_AGENT_SECRET` (encrypts the grant token; defaults to a key derived from `MONGODB_URI`)

## Testnet wallet gift

These rules apply on **testnet only** (`NEAR_NETWORK=testnet`). None of them run on mainnet.

- **New in-game wallets:** each new wallet is created with 0.05 NEAR, which account creation uses. On top of that, the funder (`ORACLE_ACCOUNT_ID`) sends it **1 test NEAR**.
- **Funder reserve:** the gift is only sent if the funder still has **5 NEAR** left after sending it. Below that, wallets are still created, just without the gift.
- **Older wallets:** a wallet that was made before this and has less than 0.5 test NEAR gets the same 1 NEAR, **once**, via `POST /wallet/testnet-topup`.
- **Settings:** override the amounts with `TESTNET_WALLET_GIFT_NEAR` (default 1) and `TESTNET_FUNDER_RESERVE_NEAR` (default 5).

## Pool contract (testnet)

The Rust contract is in [`contract/`](contract/). The tables below list what a v4 build protects against.

- **Deploy:** GitHub → Actions → *Build and Deploy Pool Contract*.
  - Pick the branch with the contract (`dev`) and set `run_init = false` when upgrading the live contract.
  - The workflow runs `cargo test` first and refuses to deploy if any test fails.
- **Upgrade:** v4 keeps the exact v3 storage layout, so existing pools keep working. No migration is needed.
- **Testing:** the upgrade was tested on testnet by deploying v3, creating pools, deploying v4 over it and finishing those pools.
- **Backend detection:** the backend calls `get_version` to see whether the contract is v4. It uses tie-aware `distribute_shares` with v4 and `distribute_prizes` with v3, so nothing has to be switched on by hand.

| Rule | Why |
|---|---|
| A payout needs at least 1 winner, with no duplicates, all of them real participants, and shares that add up to exactly 100%. | v3 could mark a pool paid while sending nothing, which trapped the money. |
| Every transfer has a result callback. A failed one, for example to an account that doesn't exist, is kept for that account to claim with `claim_unclaimed`. | The money never silently stays in the contract, and nobody else can redirect it. |
| Fee and rounding dust go to the platform balance. | Every yoctoNEAR is accounted for. |
| `admin_refund_pool` on an entry-fee pool refunds each player their own fee. | v3 sent the whole pot to the host. |
| Pool names are at most 64 bytes, with at most 50 participants per pool. | Stops storage spam. |
| Only the backend (oracle) can pay out or cancel a started pool. Only the owner can use the 24-hour fallback. | Unchanged from v3. |

### Backend money rules

- **Who gets paid:** before paying, the server reads the pool from the chain.
  - It only pays a pool that is Locked there, and never pays one twice.
  - Each winner is paid to the wallet that actually joined on-chain, so a later wallet change can't break the payout.
  - If nobody eligible scored, everyone is refunded.
- **Pre-lock check:** just before the host locks the pool, anyone who paid the entry fee but isn't in the room is either linked to their player or refunded.
- **$SABOTEUR rewards:** the payout transaction is signed and saved before it is sent. A retry re-sends that same transaction, so a timeout can never pay twice.
- **In-game wallets:** each player can create at most 2 in-game wallets, and the testnet gift is sent once per player. This stops anyone from draining the funder account that also pays pool gas.
- **Admin → Pools → On-chain check:** lists every pool still holding money in the contract with no live room behind it, including very old untracked ones, and resolves it with one click.
