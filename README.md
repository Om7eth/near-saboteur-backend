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
