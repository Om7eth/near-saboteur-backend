# NEAR Saboteur — backend

Node / Express / Socket.io server for NEAR Saboteur.

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
| **Testnet · auto payout** | Test NEAR held by the pool contract | The contract pays the top 3 automatically (50 / 30 / 20 after the 5% fee). |
| **Real NEAR · host pays** | Real NEAR, never held by the game | Players give a mainnet `.near` address when they join. After the last match the game ranks everyone and works out each prize from the host's own split. The host sends the NEAR from their own wallet and marks each winner as paid. Each winner gets an Inbox message. |

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
| Players tie (Real NEAR) | The tied players share the places they cover equally. For example, two players tied for #1 on a 50/30/20 split each get 40%. The testnet contract always pays 50/30/20 by position. |
| Fewer players scored than there are paid places | The prize for the empty places stays with the host. Only players with more than 0 points can win. |
| A Real NEAR host leaves before the first match | The pool stays open, and any player can run the lobby. A testnet pool host leaving before the start still cancels and refunds the pool. |

The lobby **Standings** board shows each player's line for every match: role, won or lost, missions or kills, and points. Tap a player to see it.

## Testnet wallet gift

These rules apply on **testnet only** (`NEAR_NETWORK=testnet`). None of them run on mainnet.

- **New in-game wallets:** each new wallet is created with 0.05 NEAR, which account creation uses. On top of that, the funder (`ORACLE_ACCOUNT_ID`) sends it **1 test NEAR**.
- **Funder reserve:** the gift is only sent if the funder still has **5 NEAR** left after sending it. Below that, wallets are still created, just without the gift.
- **Older wallets:** a wallet that was made before this and has less than 0.5 test NEAR gets the same 1 NEAR, **once**, via `POST /wallet/testnet-topup`.
- **Settings:** override the amounts with `TESTNET_WALLET_GIFT_NEAR` (default 1) and `TESTNET_FUNDER_RESERVE_NEAR` (default 5).
