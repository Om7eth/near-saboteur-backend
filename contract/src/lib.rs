// ============================================================
// NEAR Saboteur - Pool Escrow Smart Contract (v4 - audit fixes)
// ============================================================
// Holds the NEAR for Pool Games (host pays the whole prize) and Paid Games
// (every player pays the same entry fee) on NEAR testnet, and pays it out
// once the off-chain matches are over.
//
//   1. create_pool        host creates a pool (host-funded: attaches the
//                         whole prize; entry-fee: attaches nothing)
//   2. participate        players join (entry-fee: attach exactly the fee;
//                         host-funded: attach 0, joining is free)
//   3. lock_participation host starts the game - nobody can join after this
//   4. matches are played OFF-CHAIN (no signing during gameplay)
//   5. the backend ("oracle") pays out ONCE:
//        distribute_shares  (v4) any split in basis points - used for ties
//        distribute_prizes  (v3, kept) fixed 50/30/20 by rank
//      5% of every paid-out pool goes to the platform (owner).
//   6. escape hatches: cancel_pool (refund everyone), refund_participant,
//      and owner-only admin_release_pool / admin_refund_pool after a 24h hold.
//
// v4 fixes (see the "Pool contract" section of the backend README):
//   - a payout with ZERO winners is rejected (it used to mark the pool
//     Distributed and leave 95% of the money stuck in the contract forever)
//   - duplicate winners are rejected (one account could be paid twice)
//   - admin_refund_pool refunds every participant their own entry fee for
//     entry-fee pools (it used to send ALL of it to the host)
//   - every outgoing transfer is checked by a callback; if it fails (e.g. the
//     receiving account doesn't exist) the amount is kept for that account to
//     claim with claim_unclaimed() instead of silently vanishing into the
//     contract's balance
//   - rounding dust from splits goes to the platform balance instead of
//     staying untracked
//   - limits against storage spam: pool name <= 64 bytes, <= 50 participants
//   - get_version(), get_unclaimed() views; events logged in NEP-297 style
//
// State layout is IDENTICAL to v3 (same Contract and Pool structs), so this
// is a code-only upgrade: redeploy with run_init = false, no migration.
// The only new storage is a separate key prefix ("u") for unclaimed payouts.
// ============================================================

use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::collections::{LookupMap, UnorderedMap};
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise};

pub type PoolId = u64;

// Platform's cut of every paid-out pool - goes to owner_id via platform_fees_balance.
const PLATFORM_FEE_BPS: u128 = 500; // 5%
const BPS_DENOMINATOR: u128 = 10_000;
// How long a pool can sit Locked without a payout before the owner may step in.
const CONFIRMATION_HOLD_NANOS: u64 = 24 * 60 * 60 * 1_000_000_000;
// Storage-spam limits.
const MAX_NAME_BYTES: usize = 64;
const MAX_PARTICIPANTS: usize = 50;
// distribute_shares: at most this many receivers in one payout (ties included).
const MAX_PAYOUTS: usize = 10;
// Gas reserved for each transfer's result callback.
const CALLBACK_GAS: Gas = Gas::from_tgas(5);

#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(crate = "near_sdk::serde")]
pub enum PoolState {
    Open,
    Locked,
    Distributed,
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

// One line of a distribute_shares payout.
#[derive(Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct Payout {
    pub account_id: AccountId,
    pub bps: u16, // share of the prize pot (after the 5% fee), out of 10,000
}

// UNCHANGED from v3 - the on-chain state must keep exactly this layout.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub owner_id: AccountId,
    pub oracle_id: AccountId,
    pub pools: UnorderedMap<PoolId, Pool>,
    pub next_pool_id: PoolId,
    pub platform_fees_balance: u128,
}

// UNCHANGED from v3.
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
    pub locked_at_nanos: Option<u64>,
}

// Separate storage prefix, so the Contract struct above stays unchanged.
fn unclaimed_map() -> LookupMap<AccountId, u128> {
    LookupMap::new(b"u".to_vec())
}

fn log_event(event: &str, data: String) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"near_saboteur_pool\",\"version\":\"4.0.0\",\"event\":\"{}\",\"data\":[{}]}}",
        event, data
    ));
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
    #[payable]
    pub fn create_pool(&mut self, name: String, max_matches: u8, entry_fee: U128, host_funded: bool) -> PoolId {
        assert!((1..=5).contains(&max_matches), "max_matches must be 1-5");
        assert!(name.len() <= MAX_NAME_BYTES, "Pool name is too long (max {} bytes)", MAX_NAME_BYTES);
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
            host_id: host_id.clone(),
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
        log_event("pool_created", format!("{{\"pool_id\":{},\"host_id\":\"{}\",\"host_funded\":{},\"entry_fee\":\"{}\"}}", pool_id, host_id, host_funded, entry_fee_val));
        pool_id
    }

    // ---- JOIN / PAY YOUR ENTRY FEE ----
    // Entry-fee pool: attach exactly entry_fee. Host-funded pool: attach 0
    // (the host already paid; joining just makes you prize-eligible).
    #[payable]
    pub fn participate(&mut self, pool_id: PoolId) {
        let mut pool = self.pools.get(&pool_id).expect("Pool not found");
        assert_eq!(pool.state, PoolState::Open, "This pool is no longer accepting new participants");
        let account_id = env::predecessor_account_id();
        assert!(!pool.participants.contains(&account_id), "You've already joined this pool");
        assert!(pool.participants.len() < MAX_PARTICIPANTS, "This pool is full ({} players max)", MAX_PARTICIPANTS);

        let attached = env::attached_deposit().as_yoctonear();
        let required = if pool.host_funded { 0 } else { pool.entry_fee };
        assert_eq!(attached, required, "Attached deposit must be exactly {} yoctoNEAR", required);

        pool.participants.push(account_id.clone());
        pool.total_fund += attached;
        self.pools.insert(&pool_id, &pool);
        log_event("participated", format!("{{\"pool_id\":{},\"account_id\":\"{}\",\"amount\":\"{}\"}}", pool_id, account_id, attached));
    }

    // ---- HOST: LOCK PARTICIPATION (start the game) ----
    pub fn lock_participation(&mut self, pool_id: PoolId) {
        let mut pool = self.pools.get(&pool_id).expect("Pool not found");
        assert_eq!(env::predecessor_account_id(), pool.host_id, "Only the host can start this pool's game");
        assert_eq!(pool.state, PoolState::Open, "This pool isn't open");
        pool.state = PoolState::Locked;
        pool.locked_at_nanos = Some(env::block_timestamp());
        self.pools.insert(&pool_id, &pool);
        log_event("pool_locked", format!("{{\"pool_id\":{}}}", pool_id));
    }

    // ---- BACKEND: PAY OUT (oracle only, once per pool) ----
    // v3 method, kept for compatibility: top 1-3 accounts, 50/30/20 of the
    // pot (renormalised if fewer than 3).
    pub fn distribute_prizes(&mut self, pool_id: PoolId, ranked_winners: Vec<AccountId>) {
        assert_eq!(env::predecessor_account_id(), self.oracle_id, "Only the backend can distribute prizes");
        let pool = self.pools.get(&pool_id).expect("Pool not found");
        assert_eq!(pool.state, PoolState::Locked, "This pool isn't awaiting distribution");
        let payouts = Self::ranked_to_payouts(ranked_winners);
        self.pay_out(pool, payouts);
    }

    // v4: any split. `payouts` must be 1-10 distinct participants whose bps
    // add up to exactly 10,000. Used for tied places (e.g. two players tied
    // for 1st share 50% + 30%).
    pub fn distribute_shares(&mut self, pool_id: PoolId, payouts: Vec<Payout>) {
        assert_eq!(env::predecessor_account_id(), self.oracle_id, "Only the backend can distribute prizes");
        let pool = self.pools.get(&pool_id).expect("Pool not found");
        assert_eq!(pool.state, PoolState::Locked, "This pool isn't awaiting distribution");
        self.pay_out(pool, payouts);
    }

    // ---- CANCEL (refund everyone) ----
    // Open pool: host or backend. Locked pool: backend only (it alone knows
    // off-chain that no match result exists yet).
    pub fn cancel_pool(&mut self, pool_id: PoolId) {
        let mut pool = self.pools.get(&pool_id).expect("Pool not found");
        let caller = env::predecessor_account_id();
        match pool.state {
            PoolState::Open => {
                assert!(caller == pool.host_id || caller == self.oracle_id, "Only the host or the backend can cancel this pool");
            }
            PoolState::Locked => {
                assert_eq!(caller, self.oracle_id, "Only the backend can cancel a pool that's already locked");
            }
            _ => panic!("Only a pool that hasn't produced any results yet can be cancelled"),
        }
        pool.state = PoolState::Refunded;
        self.pools.insert(&pool_id, &pool);
        log_event("pool_cancelled", format!("{{\"pool_id\":{}}}", pool_id));
        self.refund_all(&pool);
    }

    // ---- BACKEND: REFUND ONE PARTICIPANT (entry-fee pool, still Open) ----
    pub fn refund_participant(&mut self, pool_id: PoolId, account_id: AccountId) {
        assert_eq!(env::predecessor_account_id(), self.oracle_id, "Only the backend can do this");
        let mut pool = self.pools.get(&pool_id).expect("Pool not found");
        assert_eq!(pool.state, PoolState::Open, "Can only refund a single participant while the pool is still Open");
        assert!(!pool.host_funded, "Host-funded pools have no individual entry fee - use remove_free_participant");
        let idx = pool.participants.iter().position(|p| p == &account_id).expect("This account is not a participant in this pool");
        pool.participants.remove(idx);
        pool.total_fund = pool.total_fund.saturating_sub(pool.entry_fee);
        let refund_amount = pool.entry_fee;
        self.pools.insert(&pool_id, &pool);
        self.send(pool_id, account_id, refund_amount, "refund");
    }

    // ---- BACKEND: REMOVE A FREE JOINER (host-funded pool, still Open) ----
    // Nothing to refund (joining was free). Lets the backend clear out
    // accounts that joined only to fill the 50-player limit.
    pub fn remove_free_participant(&mut self, pool_id: PoolId, account_id: AccountId) {
        assert_eq!(env::predecessor_account_id(), self.oracle_id, "Only the backend can do this");
        let mut pool = self.pools.get(&pool_id).expect("Pool not found");
        assert_eq!(pool.state, PoolState::Open, "The pool has already started");
        assert!(pool.host_funded, "Only free joiners of host-funded pools can be removed this way");
        assert!(account_id != pool.host_id, "The host can't be removed");
        let idx = pool.participants.iter().position(|p| p == &account_id).expect("This account is not a participant in this pool");
        pool.participants.remove(idx);
        self.pools.insert(&pool_id, &pool);
        log_event("participant_removed", format!("{{\"pool_id\":{},\"account_id\":\"{}\"}}", pool_id, account_id));
    }

    // ---- ADMIN FALLBACK (owner only, 24h after lock with no payout) ----
    pub fn admin_release_pool(&mut self, pool_id: PoolId, ranked_winners: Vec<AccountId>) {
        assert_eq!(env::predecessor_account_id(), self.owner_id, "Only the owner can do this");
        let pool = self.pools.get(&pool_id).expect("Pool not found");
        Self::assert_hold_expired(&pool);
        let payouts = Self::ranked_to_payouts(ranked_winners);
        self.pay_out(pool, payouts);
    }

    // v4 fix: entry-fee pools refund every participant their own entry fee
    // (v3 sent the WHOLE pot to the host). Host-funded pools refund the host.
    pub fn admin_refund_pool(&mut self, pool_id: PoolId) {
        assert_eq!(env::predecessor_account_id(), self.owner_id, "Only the owner can do this");
        let mut pool = self.pools.get(&pool_id).expect("Pool not found");
        Self::assert_hold_expired(&pool);
        pool.state = PoolState::Refunded;
        self.pools.insert(&pool_id, &pool);
        log_event("pool_cancelled", format!("{{\"pool_id\":{},\"by\":\"owner\"}}", pool_id));
        self.refund_all(&pool);
    }

    pub fn set_oracle(&mut self, new_oracle_id: AccountId) {
        assert_eq!(env::predecessor_account_id(), self.owner_id, "Only the owner can do this");
        self.oracle_id = new_oracle_id;
    }

    pub fn withdraw_platform_fees(&mut self, amount: U128) -> Promise {
        assert_eq!(env::predecessor_account_id(), self.owner_id, "Only the owner can do this");
        let amount_val: u128 = amount.into();
        assert!(amount_val <= self.platform_fees_balance, "Not enough collected fees");
        self.platform_fees_balance -= amount_val;
        Promise::new(self.owner_id.clone()).transfer(NearToken::from_yoctonear(amount_val))
    }

    // ---- UNCLAIMED PAYOUTS ----
    // If a prize/refund transfer failed (e.g. the account didn't exist yet),
    // the amount is kept here. Only that same account can claim it, and it is
    // always sent to itself - nobody can redirect it.
    pub fn claim_unclaimed(&mut self) -> Promise {
        let account_id = env::predecessor_account_id();
        let mut map = unclaimed_map();
        let amount = map.get(&account_id).unwrap_or(0);
        assert!(amount > 0, "Nothing to claim");
        map.remove(&account_id);
        log_event("unclaimed_claimed", format!("{{\"account_id\":\"{}\",\"amount\":\"{}\"}}", account_id, amount));
        Promise::new(account_id.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_transfer_done(0, account_id, U128(amount), "claim".to_string()))
    }

    // Result of every outgoing transfer. A failed transfer's NEAR comes back
    // to this contract; record it so it isn't lost.
    #[private]
    pub fn on_transfer_done(&mut self, pool_id: PoolId, account_id: AccountId, amount: U128, kind: String) {
        // a plain transfer returns no data; anything else (or a failure) counts as not delivered
        let ok = env::promise_result_checked(0, 64).is_ok();
        if ok {
            log_event("transfer_ok", format!("{{\"pool_id\":{},\"account_id\":\"{}\",\"amount\":\"{}\",\"kind\":\"{}\"}}", pool_id, account_id, amount.0, kind));
        } else {
            let mut map = unclaimed_map();
            let prev = map.get(&account_id).unwrap_or(0);
            map.insert(&account_id, &(prev + amount.0));
            log_event("transfer_failed", format!("{{\"pool_id\":{},\"account_id\":\"{}\",\"amount\":\"{}\",\"kind\":\"{}\"}}", pool_id, account_id, amount.0, kind));
        }
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
    pub fn get_unclaimed(&self, account_id: AccountId) -> U128 {
        U128(unclaimed_map().get(&account_id).unwrap_or(0))
    }
    pub fn get_version(&self) -> String {
        "4.0.0".to_string()
    }
    pub fn get_config(&self) -> (AccountId, AccountId) {
        (self.owner_id.clone(), self.oracle_id.clone())
    }
}

// ---- internal helpers (not callable on-chain) ----
impl Contract {
    fn assert_hold_expired(pool: &Pool) {
        assert_eq!(pool.state, PoolState::Locked, "This pool isn't in a holdable state");
        let locked_at = pool.locked_at_nanos.expect("This pool was never locked");
        assert!(env::block_timestamp() >= locked_at + CONFIRMATION_HOLD_NANOS, "The 24-hour confirmation hold hasn't passed yet");
    }

    // 1st/2nd/3rd -> 5000/3000/2000 bps, renormalised to 10,000 when fewer
    // than 3 winners (same maths as v3).
    fn ranked_to_payouts(ranked_winners: Vec<AccountId>) -> Vec<Payout> {
        assert!(!ranked_winners.is_empty(), "At least one winner is required - cancel the pool to refund instead");
        assert!(ranked_winners.len() <= 3, "At most 3 winners can be paid");
        let split: [u128; 3] = [5000, 3000, 2000];
        let total: u128 = split.iter().take(ranked_winners.len()).sum();
        let mut out: Vec<Payout> = ranked_winners
            .into_iter()
            .enumerate()
            .map(|(i, account_id)| Payout { account_id, bps: (split[i] * BPS_DENOMINATOR / total) as u16 })
            .collect();
        let given: u128 = out.iter().map(|p| p.bps as u128).sum();
        out[0].bps += (BPS_DENOMINATOR - given) as u16; // rounding remainder to 1st place
        out
    }

    // The ONE place money leaves for a payout. Validates everything first,
    // marks the pool Distributed, then sends each share.
    fn pay_out(&mut self, mut pool: Pool, payouts: Vec<Payout>) {
        assert!(!payouts.is_empty(), "At least one winner is required - cancel the pool to refund instead");
        assert!(payouts.len() <= MAX_PAYOUTS, "At most {} winners can be paid", MAX_PAYOUTS);
        let mut bps_sum: u128 = 0;
        for (i, p) in payouts.iter().enumerate() {
            assert!(p.bps > 0, "Every share must be greater than 0");
            assert!(pool.participants.contains(&p.account_id), "{} never participated in this pool", p.account_id);
            assert!(!payouts[..i].iter().any(|q| q.account_id == p.account_id), "{} is listed twice", p.account_id);
            bps_sum += p.bps as u128;
        }
        assert_eq!(bps_sum, BPS_DENOMINATOR, "Shares must add up to exactly 10000 bps");

        pool.state = PoolState::Distributed;
        self.pools.insert(&pool.id, &pool);

        let platform_cut = pool.total_fund * PLATFORM_FEE_BPS / BPS_DENOMINATOR;
        let pot = pool.total_fund - platform_cut;
        let mut sent: u128 = 0;
        for p in payouts.iter() {
            let share = pot * (p.bps as u128) / BPS_DENOMINATOR;
            if share == 0 {
                continue;
            }
            sent += share;
            self.send(pool.id, p.account_id.clone(), share, "prize");
        }
        // fee + rounding dust -> platform balance (nothing left untracked)
        self.platform_fees_balance += pool.total_fund - sent;
        log_event("pool_distributed", format!("{{\"pool_id\":{},\"total\":\"{}\",\"paid\":\"{}\",\"winners\":{}}}", pool.id, pool.total_fund, sent, payouts.len()));
    }

    fn refund_all(&mut self, pool: &Pool) {
        if pool.host_funded {
            if pool.total_fund > 0 {
                self.send(pool.id, pool.host_id.clone(), pool.total_fund, "refund");
            }
        } else {
            for p in pool.participants.iter() {
                self.send(pool.id, p.clone(), pool.entry_fee, "refund");
            }
        }
    }

    // Each transfer is its own promise with its own result callback. Promises
    // are scheduled when created, so nothing needs to be returned/joined.
    fn send(&self, pool_id: PoolId, to: AccountId, amount: u128, kind: &str) {
        Promise::new(to.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_transfer_done(pool_id, to, U128(amount), kind.to_string()))
            .detach();
    }
}

// ============================================================
// Unit tests: `cargo test` (runs natively, no blockchain needed)
// ============================================================
#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;
    use near_sdk::PromiseResult;
    use near_sdk::mock::MockAction;

    // (receiver, yoctoNEAR) of every transfer the last call scheduled
    fn transfers() -> Vec<(String, u128)> {
        near_sdk::test_utils::get_created_receipts()
            .into_iter()
            .flat_map(|r| {
                let to = r.receiver_id.to_string();
                r.actions.into_iter().filter_map(move |a| match a {
                    MockAction::Transfer { deposit, .. } => Some((to.clone(), deposit.as_yoctonear())),
                    _ => None,
                })
            })
            .collect()
    }

    const ONE: u128 = 1_000_000_000_000_000_000_000_000;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn ctx(predecessor: &str, deposit: u128) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("pool.testnet"))
            .predecessor_account_id(acc(predecessor))
            .signer_account_id(acc(predecessor))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_near(1000));
        testing_env!(b.build());
    }
    fn ctx_at(predecessor: &str, deposit: u128, ts: u64) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("pool.testnet"))
            .predecessor_account_id(acc(predecessor))
            .signer_account_id(acc(predecessor))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(ts)
            .account_balance(NearToken::from_near(1000));
        testing_env!(b.build());
    }
    fn setup() -> Contract {
        ctx("owner.testnet", 0);
        Contract::new(acc("owner.testnet"), acc("oracle.testnet"))
    }
    // entry-fee pool with alice, bob, carol paying 1 NEAR each, locked
    fn paid_pool(c: &mut Contract) -> PoolId {
        ctx("host.testnet", 0);
        let id = c.create_pool("Paid".into(), 3, U128(ONE), false);
        for who in ["alice.testnet", "bob.testnet", "carol.testnet"] {
            ctx(who, ONE);
            c.participate(id);
        }
        ctx("host.testnet", 0);
        c.lock_participation(id);
        id
    }

    #[test]
    fn host_funded_flow_and_fee() {
        let mut c = setup();
        ctx("host.testnet", 2 * ONE);
        let id = c.create_pool("Pool".into(), 3, U128(2 * ONE), true);
        ctx("alice.testnet", 0);
        c.participate(id);
        ctx("host.testnet", 0);
        c.lock_participation(id);
        ctx("oracle.testnet", 0);
        c.distribute_prizes(id, vec![acc("alice.testnet")]);
        let p = c.get_pool(id).unwrap();
        assert_eq!(p.state, PoolState::Distributed);
        // 5% fee, everything else to alice: nothing left untracked
        assert_eq!(c.platform_fees_balance, 2 * ONE * 5 / 100);
    }

    #[test]
    #[should_panic(expected = "At least one winner is required")]
    fn zero_winners_rejected() {
        let mut c = setup();
        let id = paid_pool(&mut c);
        ctx("oracle.testnet", 0);
        c.distribute_prizes(id, vec![]);
    }

    #[test]
    #[should_panic(expected = "is listed twice")]
    fn duplicate_winner_rejected() {
        let mut c = setup();
        let id = paid_pool(&mut c);
        ctx("oracle.testnet", 0);
        c.distribute_prizes(id, vec![acc("alice.testnet"), acc("alice.testnet")]);
    }

    #[test]
    #[should_panic(expected = "never participated")]
    fn outsider_cannot_be_paid() {
        let mut c = setup();
        let id = paid_pool(&mut c);
        ctx("oracle.testnet", 0);
        c.distribute_prizes(id, vec![acc("mallory.testnet")]);
    }

    #[test]
    #[should_panic(expected = "Only the backend")]
    fn only_oracle_distributes() {
        let mut c = setup();
        let id = paid_pool(&mut c);
        ctx("alice.testnet", 0);
        c.distribute_prizes(id, vec![acc("alice.testnet")]);
    }

    #[test]
    #[should_panic(expected = "isn't awaiting distribution")]
    fn cannot_distribute_twice() {
        let mut c = setup();
        let id = paid_pool(&mut c);
        ctx("oracle.testnet", 0);
        c.distribute_prizes(id, vec![acc("alice.testnet")]);
        c.distribute_prizes(id, vec![acc("bob.testnet")]);
    }

    #[test]
    fn shares_for_a_tie_and_dust_tracked() {
        let mut c = setup();
        let id = paid_pool(&mut c); // 3 NEAR
        ctx("oracle.testnet", 0);
        // alice + bob tied for 1st: (50+30)/2 = 40% each, carol 20%
        c.distribute_shares(id, vec![
            Payout { account_id: acc("alice.testnet"), bps: 4000 },
            Payout { account_id: acc("bob.testnet"), bps: 4000 },
            Payout { account_id: acc("carol.testnet"), bps: 2000 },
        ]);
        assert_eq!(c.get_pool(id).unwrap().state, PoolState::Distributed);
        let pot = 3 * ONE - 3 * ONE * 5 / 100;
        let sent = pot * 4000 / 10000 * 2 + pot * 2000 / 10000;
        assert_eq!(c.platform_fees_balance, 3 * ONE - sent);
        let t = transfers();
        assert_eq!(t, vec![
            ("alice.testnet".to_string(), pot * 4000 / 10000),
            ("bob.testnet".to_string(), pot * 4000 / 10000),
            ("carol.testnet".to_string(), pot * 2000 / 10000),
        ]);
        // paid + fee/dust == exactly what was collected
        assert_eq!(t.iter().map(|x| x.1).sum::<u128>() + c.platform_fees_balance, 3 * ONE);
    }

    #[test]
    fn entry_fee_pool_cancel_refunds_each_player() {
        let mut c = setup();
        let id = paid_pool(&mut c);
        ctx("oracle.testnet", 0);
        c.cancel_pool(id);
        assert_eq!(transfers(), vec![
            ("alice.testnet".to_string(), ONE),
            ("bob.testnet".to_string(), ONE),
            ("carol.testnet".to_string(), ONE),
        ]);
    }

    #[test]
    fn admin_refund_pays_players_not_host() {
        let mut c = setup();
        let id = paid_pool(&mut c);
        ctx_at("owner.testnet", 0, CONFIRMATION_HOLD_NANOS + 1);
        c.admin_refund_pool(id);
        let t = transfers();
        assert!(t.iter().all(|(to, _)| to != "host.testnet"), "host must not receive players' fees");
        assert_eq!(t.len(), 3);
    }

    #[test]
    fn host_funded_cancel_refunds_host_only() {
        let mut c = setup();
        ctx("host.testnet", 2 * ONE);
        let id = c.create_pool("Pool".into(), 3, U128(2 * ONE), true);
        ctx("alice.testnet", 0);
        c.participate(id);
        ctx("host.testnet", 0);
        c.cancel_pool(id);
        assert_eq!(transfers(), vec![("host.testnet".to_string(), 2 * ONE)]);
    }

    #[test]
    fn claim_sends_to_self() {
        let mut c = setup();
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("pool.testnet")).predecessor_account_id(acc("pool.testnet"));
        testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![PromiseResult::Failed]);
        c.on_transfer_done(1, acc("ghost.testnet"), U128(ONE), "prize".into());
        ctx("ghost.testnet", 0);
        let _ = c.claim_unclaimed();
        assert_eq!(transfers(), vec![("ghost.testnet".to_string(), ONE)]);
        assert_eq!(c.get_unclaimed(acc("ghost.testnet")).0, 0);
    }

    #[test]
    fn successful_transfer_not_recorded_as_unclaimed() {
        let mut c = setup();
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("pool.testnet")).predecessor_account_id(acc("pool.testnet"));
        testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![PromiseResult::Successful(vec![])]);
        c.on_transfer_done(1, acc("alice.testnet"), U128(ONE), "prize".into());
        assert_eq!(c.get_unclaimed(acc("alice.testnet")).0, 0);
    }


    #[test]
    #[should_panic(expected = "exactly 10000")]
    fn shares_must_sum_to_10000() {
        let mut c = setup();
        let id = paid_pool(&mut c);
        ctx("oracle.testnet", 0);
        c.distribute_shares(id, vec![Payout { account_id: acc("alice.testnet"), bps: 9000 }]);
    }

    #[test]
    fn two_winner_renormalisation() {
        let p = Contract::ranked_to_payouts(vec![acc("a.testnet"), acc("b.testnet")]);
        assert_eq!(p[0].bps as u32 + p[1].bps as u32, 10000);
        assert_eq!(p[0].bps, 6250); // 5000/8000
        assert_eq!(p[1].bps, 3750); // 3000/8000
    }

    #[test]
    fn cancel_open_by_host_refunds() {
        let mut c = setup();
        ctx("host.testnet", 0);
        let id = c.create_pool("Paid".into(), 3, U128(ONE), false);
        ctx("alice.testnet", ONE);
        c.participate(id);
        ctx("host.testnet", 0);
        c.cancel_pool(id);
        assert_eq!(c.get_pool(id).unwrap().state, PoolState::Refunded);
    }

    #[test]
    #[should_panic(expected = "Only the backend can cancel a pool that's already locked")]
    fn host_cannot_cancel_locked() {
        let mut c = setup();
        let id = paid_pool(&mut c);
        ctx("host.testnet", 0);
        c.cancel_pool(id);
    }

    #[test]
    #[should_panic(expected = "Only a pool that hasn't produced any results")]
    fn cannot_cancel_after_payout() {
        let mut c = setup();
        let id = paid_pool(&mut c);
        ctx("oracle.testnet", 0);
        c.distribute_prizes(id, vec![acc("alice.testnet")]);
        c.cancel_pool(id);
    }

    #[test]
    #[should_panic(expected = "Attached deposit must be exactly")]
    fn wrong_entry_fee_rejected() {
        let mut c = setup();
        ctx("host.testnet", 0);
        let id = c.create_pool("Paid".into(), 3, U128(ONE), false);
        ctx("alice.testnet", ONE / 2);
        c.participate(id);
    }

    #[test]
    #[should_panic(expected = "no longer accepting")]
    fn cannot_join_after_lock() {
        let mut c = setup();
        let id = paid_pool(&mut c);
        ctx("dave.testnet", ONE);
        c.participate(id);
    }

    #[test]
    #[should_panic(expected = "Pool name is too long")]
    fn long_name_rejected() {
        let mut c = setup();
        ctx("host.testnet", 0);
        c.create_pool("x".repeat(65), 3, U128(ONE), false);
    }

    #[test]
    #[should_panic(expected = "This pool is full")]
    fn participant_cap() {
        let mut c = setup();
        ctx("host.testnet", ONE);
        let id = c.create_pool("Pool".into(), 3, U128(ONE), true);
        for i in 0..MAX_PARTICIPANTS {
            ctx(&format!("p{}.testnet", i), 0);
            c.participate(id);
        }
    }

    #[test]
    #[should_panic(expected = "24-hour confirmation hold")]
    fn admin_needs_24h() {
        let mut c = setup();
        let id = paid_pool(&mut c);
        ctx("owner.testnet", 0);
        c.admin_refund_pool(id);
    }

    #[test]
    fn admin_refund_after_24h() {
        let mut c = setup();
        let id = paid_pool(&mut c);
        ctx_at("owner.testnet", 0, CONFIRMATION_HOLD_NANOS + 1);
        c.admin_refund_pool(id);
        assert_eq!(c.get_pool(id).unwrap().state, PoolState::Refunded);
    }

    #[test]
    fn refund_one_participant() {
        let mut c = setup();
        ctx("host.testnet", 0);
        let id = c.create_pool("Paid".into(), 3, U128(ONE), false);
        ctx("alice.testnet", ONE);
        c.participate(id);
        ctx("oracle.testnet", 0);
        c.refund_participant(id, acc("alice.testnet"));
        let p = c.get_pool(id).unwrap();
        assert!(p.participants.is_empty());
        assert_eq!(p.total_fund.0, 0);
    }

    #[test]
    fn remove_free_joiner() {
        let mut c = setup();
        ctx("host.testnet", ONE);
        let id = c.create_pool("Pool".into(), 3, U128(ONE), true);
        ctx("alice.testnet", 0);
        c.participate(id);
        ctx("oracle.testnet", 0);
        c.remove_free_participant(id, acc("alice.testnet"));
        assert_eq!(c.get_pool(id).unwrap().participants, vec![acc("host.testnet")]);
    }

    #[test]
    fn failed_transfer_becomes_claimable() {
        let mut c = setup();
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("pool.testnet")).predecessor_account_id(acc("pool.testnet"));
        testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![PromiseResult::Failed]);
        c.on_transfer_done(7, acc("ghost.testnet"), U128(ONE), "prize".into());
        assert_eq!(c.get_unclaimed(acc("ghost.testnet")).0, ONE);
    }

    #[test]
    #[should_panic(expected = "Nothing to claim")]
    fn nothing_to_claim() {
        let mut c = setup();
        ctx("alice.testnet", 0);
        let _ = c.claim_unclaimed();
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn only_owner_withdraws_fees() {
        let mut c = setup();
        ctx("oracle.testnet", 0);
        let _ = c.withdraw_platform_fees(U128(1));
    }
}
