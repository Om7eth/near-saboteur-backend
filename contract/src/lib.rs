// ============================================================
// NEAR Saboteur — Pool Escrow Smart Contract (v3 — clean rewrite)
// ============================================================
// Deliberately much simpler than the previous version. No per-match
// signing, no oracle-verified point reporting, no on-chain leaderboard
// accumulation. The flow is:
//   1. create_pool - host either funds the ENTIRE pool alone
//      (host_funded=true, pays entry_fee as one lump sum), or every
//      participant (host included) pays the same entry_fee individually
//      via participate() (host_funded=false).
//   2. participate - each player registers + pays their share (skipped
//      entirely for a host-funded pool - the host is the only payer,
//      registered automatically at creation).
//   3. All matches are played entirely OFF-CHAIN. No wallet signature
//      happens during gameplay at all.
//   4. Once every player has confirmed the final leaderboard (an
//      off-chain, no-signature button click, tracked by the backend),
//      the backend (the one "oracle_id" account) calls distribute_prizes
//      ONCE with the final ranked order - this is the only signed
//      transaction the backend itself ever needs for a pool's whole
//      lifetime. The oracle can ONLY call this one function and can
//      never withdraw/redirect funds anywhere else.
//   5. If confirmation never completes, the pool sits in a 24-hour hold
//      after which admin_release_pool (owner-only) can send it to the
//      winners anyway, or admin_refund_pool can return everything to
//      the host.
// ============================================================

use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::collections::UnorderedMap;
use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId, PanicOnDefault, Promise};

pub type PoolId = u64;

// Platform's cut of every finalized pool - goes to owner_id.
const PLATFORM_FEE_BPS: u16 = 500; // 5%
// How long a pool can sit fully-participated-but-unconfirmed before the
// owner is allowed to step in (release to winners anyway, or refund).
const CONFIRMATION_HOLD_NANOS: u64 = 24 * 60 * 60 * 1_000_000_000;

#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(crate = "near_sdk::serde")]
pub enum PoolState {
    // Open - participants can still join (host-funded pools go straight
    // to Active with just the host as participant; entry-fee pools stay
    // Open until the host starts the game, see lock_participation).
    Open,
    // Game in progress / awaiting the backend's final distribute_prizes
    // call - no more participants can join once this state is reached.
    Locked,
    // Prizes paid out. Terminal.
    Distributed,
    // Refunded back to the host (admin fallback). Terminal.
    Refunded,
}

#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct PoolSummary {
    pub id: PoolId,
    pub name: String,
    pub host_id: AccountId,
    pub host_funded: bool,
    pub entry_fee: U128,
    pub max_matches: u8,
    pub state: PoolState,
    pub participants: Vec<AccountId>,
    pub total_fund: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub owner_id: AccountId,
    // The one account (the game's own backend) allowed to call
    // distribute_prizes - can ONLY move a pool's money to that pool's
    // OWN participants in the order it specifies, split by the fixed
    // platform-fee/prize-split rule below. It can never withdraw
    // anything to itself or to any account outside that pool.
    pub oracle_id: AccountId,
    pub pools: UnorderedMap<PoolId, Pool>,
    pub next_pool_id: PoolId,
    pub platform_fees_balance: u128,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
pub struct Pool {
    pub id: PoolId,
    pub name: String,
    pub host_id: AccountId,
    pub host_funded: bool,
    pub entry_fee: u128,
    pub max_matches: u8,
    pub state: PoolState,
    pub participants: Vec<AccountId>,
    pub total_fund: u128,
    pub created_at_nanos: u64,
    // Set the moment the host locks participation (starts the game) -
    // this is what the 24-hour admin-fallback window counts from.
    pub locked_at_nanos: Option<u64>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, oracle_id: AccountId) -> Self {
        Self {
            owner_id,
            oracle_id,
            pools: UnorderedMap::new(b"p"),
            next_pool_id: 1,
            platform_fees_balance: 0,
        }
    }

    // ---- POOL CREATION ----
    // host_funded=true: attached deposit must equal `entry_fee` exactly
    //   (the host pays the WHOLE pool alone, in one lump sum, right now).
    //   The host is the only participant unless/until others also want
    //   to play for free (see the frontend - non-paying players can
    //   still be added to `participants` for prize-eligibility purposes
    //   only by the host explicitly inviting them - not handled by this
    //   contract, which only ever tracks people who actually paid in).
    // host_funded=false: attached deposit must be exactly 0 - the host
    //   pays their own entry_fee share separately via participate(),
    //   exactly like everyone else.
    #[payable]
    pub fn create_pool(
        &mut self,
        name: String,
        max_matches: u8,
        entry_fee: U128,
        host_funded: bool,
    ) -> PoolId {
        assert!(max_matches >= 1 && max_matches <= 5, "max_matches must be 1-5");
        let entry_fee_val: u128 = entry_fee.into();
        assert!(entry_fee_val > 0, "entry_fee must be greater than 0");
        let host_id = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();

        let (participants, total_fund) = if host_funded {
            assert_eq!(attached, entry_fee_val, "As a host-funded pool, attach exactly the entry_fee as your total contribution");
            (vec![host_id.clone()], entry_fee_val)
        } else {
            assert_eq!(attached, 0, "Don't attach a deposit here - pay your own entry fee via participate()");
            (vec![], 0)
        };

        let pool_id = self.next_pool_id;
        self.next_pool_id += 1;

        let pool = Pool {
            id: pool_id,
            name,
            host_id,
            host_funded,
            entry_fee: entry_fee_val,
            max_matches,
            state: PoolState::Open,
            participants,
            total_fund,
            created_at_nanos: env::block_timestamp(),
            locked_at_nanos: None,
        };
        self.pools.insert(&pool_id, &pool);
        pool_id
    }

    // ---- JOIN / PAY YOUR ENTRY FEE ----
    // Only meaningful for host_funded=false pools - the host already
    // paid everything up front for a host_funded pool, and nobody else
    // needs to (or is able to) pay into it.
    #[payable]
    // [BUG FIX - HOST-FUNDED WINNERS COULD NEVER BE PAID] Root cause of
    // a real, confirmed bug: this used to flatly reject every call for
    // a host-funded pool (`assert!(!pool.host_funded, ...)`) - meaning
    // NOBODY but the host could ever become a real on-chain participant
    // in that mode, no matter how well they played. Since
    // distribute_prizes can only ever pay accounts already in
    // `participants`, a free-playing winner who wasn't the host could
    // win the whole match and still never be paid a single yoctoNEAR -
    // exactly what happened. The fix: still let anyone participate() in
    // a host-funded pool, just require attaching 0 (the host already
    // paid for everyone) instead of blocking the call outright - this
    // is what actually makes a non-host winner prize-eligible.
    pub fn participate(&mut self, pool_id: PoolId) {
        let mut pool = self.pools.get(&pool_id).expect("Pool not found");
        assert_eq!(pool.state, PoolState::Open, "This pool is no longer accepting new participants");
        let account_id = env::predecessor_account_id();
        assert!(!pool.participants.contains(&account_id), "You've already joined this pool");

        let attached = env::attached_deposit().as_yoctonear();
        let required = if pool.host_funded { 0 } else { pool.entry_fee };
        assert_eq!(attached, required, "Attached deposit must be exactly {} yoctoNEAR", required);

        pool.participants.push(account_id);
        pool.total_fund += attached; // adds nothing for a host-funded pool's free joiners - the host's own deposit is already the whole fund
        self.pools.insert(&pool_id, &pool);
    }

    // ---- HOST: LOCK PARTICIPATION (start the game) ----
    // Called the moment the host starts the match(es) - no one can
    // participate()/pay in after this, matching "participate button
    // locks once Start is pressed".
    pub fn lock_participation(&mut self, pool_id: PoolId) {
        let mut pool = self.pools.get(&pool_id).expect("Pool not found");
        assert_eq!(env::predecessor_account_id(), pool.host_id, "Only the host can start this pool's game");
        assert_eq!(pool.state, PoolState::Open, "This pool isn't open");
        pool.state = PoolState::Locked;
        pool.locked_at_nanos = Some(env::block_timestamp());
        self.pools.insert(&pool_id, &pool);
    }

    // ---- BACKEND: DISTRIBUTE PRIZES (oracle only, once per pool) ----
    // `ranked_winners` is the final leaderboard's top-3 accounts (or
    // fewer if the pool had fewer participants), highest rank first -
    // computed and agreed off-chain, called only once every participant
    // has confirmed it. 5% of the pool goes to the platform
    // (owner_id, via platform_fees_balance - see withdraw_platform_fees),
    // the rest splits 50/30/20 across up to 3 ranked winners.
    pub fn distribute_prizes(&mut self, pool_id: PoolId, ranked_winners: Vec<AccountId>) -> Promise {
        assert_eq!(env::predecessor_account_id(), self.oracle_id, "Only the backend can distribute prizes");
        let pool = self.pools.get(&pool_id).expect("Pool not found");
        assert_eq!(pool.state, PoolState::Locked, "This pool isn't awaiting distribution");
        self.distribute_prizes_internal(pool_id, ranked_winners)
    }

    // ---- CANCEL (host or backend, Open pools only) ----
    // [NEW FEATURE - CANCEL BEFORE START] Refunds everyone immediately
    // if the pool never even started (still Open - lock_participation
    // was never called, so no match was ever played). Deliberately NOT
    // owner-only and NOT subject to the 24h hold like admin_refund_pool
    // below - there's nothing to protect against here: no game
    // happened, no leaderboard to dispute, so there's no reason to make
    // anyone wait or need the contract owner personally. Both the host
    // (closing their own room) and the oracle (the backend's own
    // account, e.g. auto-closing an empty abandoned lobby with nobody
    // around to sign anything) can trigger this - the money only ever
    // goes back to whoever actually paid it in, never anywhere else.
    pub fn cancel_pool(&mut self, pool_id: PoolId) -> Promise {
        let mut pool = self.pools.get(&pool_id).expect("Pool not found");
        let caller = env::predecessor_account_id();
        match pool.state {
            PoolState::Open => {
                assert!(
                    caller == pool.host_id || caller == self.oracle_id,
                    "Only the host or the backend can cancel this pool"
                );
            }
            // [SECURITY] A Locked pool (the host already started the
            // match) can ONLY be cancelled by the backend, never the
            // host directly - only the backend can verify off-chain
            // that zero matches were actually played yet (the contract
            // itself has no concept of "matches" at all - that's purely
            // off-chain). Without this restriction, a host who started
            // losing partway through could just sign this themselves at
            // any time and get their own entry fee back instead of
            // letting the real leaderboard decide who's owed what.
            PoolState::Locked => {
                assert_eq!(caller, self.oracle_id, "Only the backend can cancel a pool that's already locked");
            }
            _ => panic!("Only a pool that hasn't produced any results yet can be cancelled - it needs to be settled through the normal final-leaderboard flow instead"),
        }
        pool.state = PoolState::Refunded;
        self.pools.insert(&pool_id, &pool);

        if pool.host_funded {
            // Host-funded: the host paid the entire lump sum alone, so
            // they're the only one to refund.
            Promise::new(pool.host_id.clone()).transfer(near_sdk::NearToken::from_yoctonear(pool.total_fund))
        } else {
            // Entry-fee pool: refund every individual participant their
            // own entry_fee - same "no .and() joining" pattern as
            // distribute_prizes_internal below (each transfer already
            // fires independently the moment it's created).
            let mut last_promise: Option<Promise> = None;
            for p in pool.participants.iter() {
                last_promise = Some(Promise::new(p.clone()).transfer(near_sdk::NearToken::from_yoctonear(pool.entry_fee)));
            }
            last_promise.unwrap_or_else(|| Promise::new(env::current_account_id()))
        }
    }

    // ---- ADMIN FALLBACK (owner only) ----
    // Only usable once the 24-hour hold has passed since the host locked
    // participation without distribute_prizes ever having been called.
    fn assert_hold_expired(&self, pool: &Pool) {
        assert_eq!(pool.state, PoolState::Locked, "This pool isn't in a holdable state");
        let locked_at = pool.locked_at_nanos.expect("This pool was never locked");
        assert!(
            env::block_timestamp() >= locked_at + CONFIRMATION_HOLD_NANOS,
            "The 24-hour confirmation hold hasn't passed yet"
        );
    }

    pub fn admin_release_pool(&mut self, pool_id: PoolId, ranked_winners: Vec<AccountId>) -> Promise {
        assert_eq!(env::predecessor_account_id(), self.owner_id, "Only the owner can do this");
        let pool = self.pools.get(&pool_id).expect("Pool not found");
        self.assert_hold_expired(&pool);
        self.distribute_prizes_internal(pool_id, ranked_winners)
    }

    pub fn admin_refund_pool(&mut self, pool_id: PoolId) -> Promise {
        assert_eq!(env::predecessor_account_id(), self.owner_id, "Only the owner can do this");
        let mut pool = self.pools.get(&pool_id).expect("Pool not found");
        self.assert_hold_expired(&pool);
        pool.state = PoolState::Refunded;
        let refund_amount = pool.total_fund;
        let host_id = pool.host_id.clone();
        self.pools.insert(&pool_id, &pool);
        Promise::new(host_id).transfer(near_sdk::NearToken::from_yoctonear(refund_amount))
    }

    // Shared by both the normal oracle path and the admin fallback path,
    // so there's only one place the actual payout math lives.
    fn distribute_prizes_internal(&mut self, pool_id: PoolId, ranked_winners: Vec<AccountId>) -> Promise {
        let mut pool = self.pools.get(&pool_id).expect("Pool not found");
        assert!(ranked_winners.len() <= 3, "At most 3 winners can be paid");
        for w in ranked_winners.iter() {
            assert!(pool.participants.contains(w), "{} never participated in this pool", w);
        }
        pool.state = PoolState::Distributed;
        self.pools.insert(&pool_id, &pool);

        let platform_cut = (pool.total_fund * PLATFORM_FEE_BPS as u128) / 10_000;
        self.platform_fees_balance += platform_cut;
        let payout_pool = pool.total_fund.saturating_sub(platform_cut);

        let split_bps: [u128; 3] = [5000, 3000, 2000]; // 50% / 30% / 20%
        let split_total: u128 = split_bps.iter().take(ranked_winners.len()).sum();

        // [BUG FIX - "Returning joint promise is currently prohibited"]
        // Root cause of a real, confirmed bug: .and()-combining the
        // individual transfer promises together (to return ONE Promise
        // value, since this function's signature only allows returning
        // one) hits a genuine NEAR runtime restriction - a promise
        // built by joining independent receipts together can't be
        // returned directly, only ever used as the setup for a
        // .then() callback. There's no callback needed here at all
        // though - each Promise::new(...).transfer(...) already
        // schedules its own real transfer the moment it's created,
        // completely independently of whatever this function ultimately
        // returns. Simply tracking (and returning) the LAST one made,
        // with no .and() joining at all, avoids the restriction while
        // still sending every single transfer exactly as before.
        let mut last_promise: Option<Promise> = None;
        if split_total > 0 {
            for (i, winner) in ranked_winners.iter().enumerate() {
                let share = (payout_pool * split_bps[i]) / split_total;
                if share == 0 { continue; }
                last_promise = Some(Promise::new(winner.clone()).transfer(near_sdk::NearToken::from_yoctonear(share)));
            }
        }
        last_promise.unwrap_or_else(|| Promise::new(env::current_account_id()))
    }

    // [ADMIN] Lets the owner rotate which account is trusted to call
    // distribute_prizes, without needing a full redeploy - e.g. to
    // switch from a personal wallet used during initial setup to a
    // dedicated backend-only account (recommended - keeps a
    // human-owned wallet's key off any server entirely).
    pub fn set_oracle(&mut self, new_oracle_id: AccountId) {
        assert_eq!(env::predecessor_account_id(), self.owner_id, "Only the owner can do this");
        self.oracle_id = new_oracle_id;
    }

    pub fn withdraw_platform_fees(&mut self, amount: U128) -> Promise {
        assert_eq!(env::predecessor_account_id(), self.owner_id, "Only the owner can do this");
        let amount_val: u128 = amount.into();
        assert!(amount_val <= self.platform_fees_balance, "Not enough collected fees");
        self.platform_fees_balance -= amount_val;
        Promise::new(self.owner_id.clone()).transfer(near_sdk::NearToken::from_yoctonear(amount_val))
    }

    // ---- VIEW METHODS ----
    pub fn get_pool(&self, pool_id: PoolId) -> Option<PoolSummary> {
        self.pools.get(&pool_id).map(|p| PoolSummary {
            id: p.id,
            name: p.name,
            host_id: p.host_id,
            host_funded: p.host_funded,
            entry_fee: U128(p.entry_fee),
            max_matches: p.max_matches,
            state: p.state,
            participants: p.participants,
            total_fund: U128(p.total_fund),
        })
    }

    pub fn get_platform_fees_balance(&self) -> U128 {
        U128(self.platform_fees_balance)
    }
}
