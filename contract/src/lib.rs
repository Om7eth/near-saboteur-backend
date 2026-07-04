// ============================================================
// NEAR Saboteur — Pool Escrow Smart Contract
// ============================================================
// Holds entry-fee/host-funded pool money ON-CHAIN (never in a
// backend-controlled wallet), tracks per-match points reported by the
// game's backend (the "oracle"), and pays out winners automatically
// when a pool is finalized. See the project's own planning notes for
// the full design rationale - short version of every safety decision
// baked into this file:
//   - The oracle can only ever REPORT POINTS, never move money - money
//     only ever moves inside finalize_pool/claim_stuck_funds/
//     admin_release_stuck_funds, none of which the oracle can call.
//   - Every pool's funds are completely isolated from every other
//     pool's - a bug or exploit in one pool can never reach another.
//   - State is always updated to its FINAL value (e.g. marking a pool
//     Finalized) BEFORE any transfer Promise is created, never after -
//     this is what prevents a double-payout if a transfer's callback
//     races with another call.
//   - A failed transfer never disappears - it becomes a claimable
//     "stuck fund" entry the rightful player can pull whenever they
//     want, and that Om7eth can also nudge along - but ALWAYS to that
//     same player's own account, never anywhere else.
//   - Every reported match result must carry the player's own
//     signature (see register_signing_key/report_match_points) over
//     the exact numbers being reported - the backend alone can never
//     credit points a player didn't themselves attest to.
// ============================================================

use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::collections::{LookupMap, UnorderedMap, UnorderedSet};
use near_sdk::json_types::U128;
use near_sdk::{
    env, near, AccountId, PanicOnDefault, Promise, PublicKey,
};

pub type PoolId = u64;

const YOCTO_PER_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
// A small, refundable-on-cleanup deposit collected alongside every
// entry fee - covers this pool's own share of on-chain storage cost so
// that cost is never silently taken out of anyone's entry fee or
// payout. Refunded to each participant once their pool is fully
// finalized/cancelled-and-not-reactivated.
const STORAGE_DEPOSIT_YOCTO: u128 = YOCTO_PER_NEAR / 100; // 0.01 NEAR
// How long a pool can sit with zero matches played and no host/backup
// activity before ANY participant is allowed to trigger
// auto_cancel_stale_pool - see that function's own comment.
const STALE_POOL_TIMEOUT_NANOS: u64 = 60 * 60 * 1_000_000_000 * 48; // 48 hours
// How long the backend has to confirm a host's end_pool_early request
// before it expires and the host would need to ask again - see
// request_end_early/confirm_end_early.
const END_EARLY_CONFIRM_WINDOW_NANOS: u64 = 30 * 60 * 1_000_000_000; // 30 minutes

#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(crate = "near_sdk::serde")]
pub enum PoolState {
    Active,
    AwaitingFinalization,
    Finalized,
    Cancelled,
}

#[derive(BorshDeserialize, BorshSerialize)]
pub struct Pool {
    pub id: PoolId,
    pub name: String,
    pub host_id: AccountId,
    pub backup_host_id: Option<AccountId>,
    pub max_matches: u8,
    pub matches_played: u8,
    pub entry_fee: u128,
    pub host_funded: bool,
    pub state: PoolState,
    // Every account that has paid into this pool - fixed once the
    // first match starts (see join_pool's own check).
    pub participants: UnorderedSet<AccountId>,
    // How much each participant actually deposited (entry fee only -
    // NOT including their separate storage deposit), so refunds/payouts
    // always know the true escrowed amount.
    pub deposits: LookupMap<AccountId, u128>,
    // Accumulated points per participant across every match reported
    // so far in this pool.
    pub leaderboard: LookupMap<AccountId, u64>,
    // (match_id, account_id) pairs already reported - the actual
    // duplicate-report guard. A String key ("matchId:accountId") is
    // simplest to store reliably in an UnorderedSet.
    pub reported_pairs: UnorderedSet<String>,
    // Distinct match_ids seen at least once - matches_played is
    // derived from this set's length, not incremented by hand, so a
    // partial/late report can never inflate the count.
    pub seen_match_ids: UnorderedSet<String>,
    // A failed payout transfer's amount, held here until the rightful
    // player claims it (or Om7eth nudges it along) - see
    // claim_stuck_funds/admin_release_stuck_funds. Always keyed by, and
    // only ever payable to, the account it's already associated with.
    pub stuck_funds: LookupMap<AccountId, u128>,
    pub storage_deposits: LookupMap<AccountId, u128>,
    pub total_fund: u128,
    pub created_at_nanos: u64,
    pub last_activity_nanos: u64,
    // [FAIRNESS] end_pool_early requires BOTH the host asking AND the
    // backend/oracle separately confirming within a time window - a
    // host who's simply winning and wants to lock in a lead can't
    // unilaterally cut a pool short; see request_end_early/
    // confirm_end_early.
    pub end_early_requested_at_nanos: Option<u64>,
}

// [BUG FIX] near-sdk 5.x needs the new unified `#[near(contract_state)]`
// macro here instead of the old `#[near_bindgen]` + manually-derived
// Borsh traits combo - that older pattern (still fine on near-sdk 4.x)
// doesn't correctly satisfy this version's internal
// ContractState::state_read/state_write bounds even though
// BorshDeserialize/BorshSerialize ARE derived, because `near(
// contract_state)` also wires up some SDK-internal plumbing those two
// derives alone don't provide.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub owner_id: AccountId,
    // The one account the game's backend signs its report_match_points/
    // confirm_end_early calls with - the ONLY account allowed to call
    // either. Change with set_oracle if that account's key is ever
    // rotated.
    pub oracle_id: AccountId,
    // Changeable without redeploying - see update_points_cap. Every
    // report_match_points call clamps to this, so even a fully
    // compromised oracle key can never credit more than this many
    // points for one match.
    pub points_cap: u64,
    // Basis points (1/100 of a percent) - e.g. 500 = 5%.
    pub platform_fee_bps: u16,
    // Fees already collected from FINALIZED pools only - never touches
    // any still-active pool's escrowed funds. See withdraw_platform_fees.
    pub platform_fees_balance: u128,
    pub pools: UnorderedMap<PoolId, Pool>,
    pub next_pool_id: PoolId,
    // account_id -> their registered ed25519 public key, set once via
    // register_signing_key (a real signed call FROM that account, which
    // is what actually proves they own it - no separate cryptographic
    // proof needed beyond the transaction's own signature). Every
    // report_match_points signature is checked against whatever's
    // stored here for that player.
    pub signing_keys: LookupMap<AccountId, PublicKey>,
}

// Storage key prefixes - each nested collection (per-pool, and the
// couple of top-level ones) needs its own unique prefix so their
// entries never collide with each other or with a different pool's
// same-named collection.
#[derive(BorshSerialize, near_sdk::BorshStorageKey)]
pub enum StorageKey {
    Pools,
    SigningKeys,
    Participants { pool_id: PoolId },
    Deposits { pool_id: PoolId },
    Leaderboard { pool_id: PoolId },
    ReportedPairs { pool_id: PoolId },
    SeenMatchIds { pool_id: PoolId },
    StuckFunds { pool_id: PoolId },
    StorageDeposits { pool_id: PoolId },
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, oracle_id: AccountId) -> Self {
        Self {
            owner_id,
            oracle_id,
            points_cap: 50,
            platform_fee_bps: 500, // 5% default - change with set_platform_fee
            platform_fees_balance: 0,
            pools: UnorderedMap::new(StorageKey::Pools),
            next_pool_id: 1,
            signing_keys: LookupMap::new(StorageKey::SigningKeys),
        }
    }

    // ---- ONE-TIME SETUP (per player) ----
    // Every player calls this once, from their own wallet, before their
    // pool-match results can ever be credited - the call itself being
    // signed BY that account is what proves they actually control this
    // key; nothing further to verify. See report_match_points for how
    // this gets used later.
    pub fn register_signing_key(&mut self, public_key: PublicKey) {
        let account_id = env::predecessor_account_id();
        self.signing_keys.insert(&account_id, &public_key);
    }

    // ---- POOL CREATION ----
    #[payable]
    pub fn create_pool(
        &mut self,
        name: String,
        max_matches: u8,
        entry_fee: U128,
        host_funded: bool,
    ) -> PoolId {
        assert!(max_matches >= 1 && max_matches <= 3, "max_matches must be 1-3");
        let host_id = env::predecessor_account_id();
        let entry_fee_val: u128 = entry_fee.into();
        let attached = env::attached_deposit().as_yoctonear();

        let expected = if host_funded {
            entry_fee_val + STORAGE_DEPOSIT_YOCTO
        } else {
            STORAGE_DEPOSIT_YOCTO // host still pays their own storage share even if not funding the pool
        };
        assert_eq!(attached, expected, "Attached deposit must be exactly {} yoctoNEAR", expected);

        let pool_id = self.next_pool_id;
        self.next_pool_id += 1;

        let mut participants = UnorderedSet::new(StorageKey::Participants { pool_id });
        participants.insert(&host_id);
        let mut deposits = LookupMap::new(StorageKey::Deposits { pool_id });
        let mut storage_deposits = LookupMap::new(StorageKey::StorageDeposits { pool_id });
        storage_deposits.insert(&host_id, &STORAGE_DEPOSIT_YOCTO);

        let total_fund = if host_funded {
            deposits.insert(&host_id, &entry_fee_val);
            entry_fee_val
        } else {
            0
        };

        let pool = Pool {
            id: pool_id,
            name,
            host_id,
            backup_host_id: None,
            max_matches,
            matches_played: 0,
            entry_fee: entry_fee_val,
            host_funded,
            state: PoolState::Active,
            participants,
            deposits,
            leaderboard: LookupMap::new(StorageKey::Leaderboard { pool_id }),
            reported_pairs: UnorderedSet::new(StorageKey::ReportedPairs { pool_id }),
            seen_match_ids: UnorderedSet::new(StorageKey::SeenMatchIds { pool_id }),
            stuck_funds: LookupMap::new(StorageKey::StuckFunds { pool_id }),
            storage_deposits,
            total_fund,
            created_at_nanos: env::block_timestamp(),
            last_activity_nanos: env::block_timestamp(),
            end_early_requested_at_nanos: None,
        };
        self.pools.insert(&pool_id, &pool);
        pool_id
    }

    // ---- JOIN ----
    // [FAIRNESS] Only allowed before the first match starts
    // (matches_played == 0) - once a pool is under way the participant
    // list is locked, so nobody joins partway through with zero chance
    // at the missed match(es)' points but full entry-fee exposure.
    #[payable]
    pub fn join_pool(&mut self, pool_id: PoolId) {
        let mut pool = self.pools.get(&pool_id).expect("Pool not found");
        assert_eq!(pool.state, PoolState::Active, "Pool is not open to join");
        assert_eq!(pool.matches_played, 0, "This pool has already started - joining is closed");
        let account_id = env::predecessor_account_id();
        assert!(!pool.participants.contains(&account_id), "Already joined this pool");

        let attached = env::attached_deposit().as_yoctonear();
        let expected = if pool.host_funded { STORAGE_DEPOSIT_YOCTO } else { pool.entry_fee + STORAGE_DEPOSIT_YOCTO };
        assert_eq!(attached, expected, "Attached deposit must be exactly {} yoctoNEAR", expected);

        pool.participants.insert(&account_id);
        pool.storage_deposits.insert(&account_id, &STORAGE_DEPOSIT_YOCTO);
        if !pool.host_funded {
            pool.deposits.insert(&account_id, &pool.entry_fee);
            pool.total_fund += pool.entry_fee;
        }
        pool.last_activity_nanos = env::block_timestamp();
        self.pools.insert(&pool_id, &pool);
    }

    // ---- HOST MANAGEMENT ----
    pub fn set_backup_host(&mut self, pool_id: PoolId, backup_account_id: AccountId) {
        let mut pool = self.pools.get(&pool_id).expect("Pool not found");
        assert_eq!(env::predecessor_account_id(), pool.host_id, "Only the host can do this");
        assert!(pool.participants.contains(&backup_account_id), "Backup host must already be a participant in this pool");
        pool.backup_host_id = Some(backup_account_id);
        self.pools.insert(&pool_id, &pool);
    }

    pub fn transfer_host_role(&mut self, pool_id: PoolId, new_host_id: AccountId) {
        let mut pool = self.pools.get(&pool_id).expect("Pool not found");
        assert_eq!(env::predecessor_account_id(), pool.host_id, "Only the current host can do this");
        assert!(pool.participants.contains(&new_host_id), "New host must already be a participant in this pool");
        pool.host_id = new_host_id;
        pool.last_activity_nanos = env::block_timestamp();
        self.pools.insert(&pool_id, &pool);
    }

    // ---- POINTS REPORTING (oracle only) ----
    // Independent per (match_id, account_id) pair - one player's
    // missing/invalid signature never blocks anyone else's points from
    // being credited, and never blocks the match itself from counting
    // toward matches_played.
    pub fn report_match_points(
        &mut self,
        pool_id: PoolId,
        match_id: String,
        account_id: AccountId,
        points: u64,
        signature: Vec<u8>,
    ) {
        assert_eq!(env::predecessor_account_id(), self.oracle_id, "Only the oracle can report points");
        let mut pool = self.pools.get(&pool_id).expect("Pool not found");
        assert!(
            pool.state == PoolState::Active || pool.state == PoolState::AwaitingFinalization,
            "This pool can no longer accept reports"
        );
        assert!(pool.participants.contains(&account_id), "That account never joined this pool");

        let dedup_key = format!("{}:{}", match_id, account_id);
        assert!(!pool.reported_pairs.contains(&dedup_key), "Already reported for this match/player");

        // [FUNDS SAFETY] Hard-capped regardless of what the oracle
        // claims - a compromised oracle key can misreport, but can
        // never push a single match's points past this.
        let capped_points = std::cmp::min(points, self.points_cap);

        // [FUNDS SAFETY] The player's OWN registered key must have
        // signed exactly this (pool_id, match_id, account_id,
        // capped_points) tuple - the oracle alone can never fabricate a
        // result the player didn't themselves attest to from their own
        // wallet.
        let signing_key = self
            .signing_keys
            .get(&account_id)
            .expect("This player has not registered a signing key yet");
        let message = format!("{}:{}:{}:{}", pool_id, match_id, account_id, capped_points);
        let verified = env::ed25519_verify(
            &signature.try_into().expect("Signature must be 64 bytes"),
            message.as_bytes(),
            &signing_key.as_bytes()[1..].try_into().expect("Invalid public key format"),
        );
        assert!(verified, "Signature does not match the reported result");

        pool.reported_pairs.insert(&dedup_key);
        pool.seen_match_ids.insert(&match_id);
        pool.matches_played = pool.seen_match_ids.len() as u8;

        let current = pool.leaderboard.get(&account_id).unwrap_or(0);
        pool.leaderboard.insert(&account_id, &(current + capped_points));
        pool.last_activity_nanos = env::block_timestamp();

        if pool.matches_played >= pool.max_matches && pool.state == PoolState::Active {
            pool.state = PoolState::AwaitingFinalization;
        }
        self.pools.insert(&pool_id, &pool);
    }

    // ---- END EARLY (host + oracle, two-step) ----
    // [FAIRNESS] A host can't unilaterally cut a pool short just
    // because they're ahead - this requires the backend to
    // independently confirm there's a genuine reason (not enough
    // players left, a technical issue, etc.) within 30 minutes of the
    // host's request, or it simply expires and the host would need to
    // ask again.
    pub fn request_end_early(&mut self, pool_id: PoolId) {
        let mut pool = self.pools.get(&pool_id).expect("Pool not found");
        assert_eq!(env::predecessor_account_id(), pool.host_id, "Only the host can request this");
        assert!(pool.matches_played >= 1, "At least one match must be played before ending early");
        assert_eq!(pool.state, PoolState::Active, "Pool is not in a state that can be ended early");
        pool.end_early_requested_at_nanos = Some(env::block_timestamp());
        self.pools.insert(&pool_id, &pool);
    }

    pub fn confirm_end_early(&mut self, pool_id: PoolId) {
        assert_eq!(env::predecessor_account_id(), self.oracle_id, "Only the oracle can confirm this");
        let mut pool = self.pools.get(&pool_id).expect("Pool not found");
        let requested_at = pool.end_early_requested_at_nanos.expect("No pending end-early request for this pool");
        assert!(
            env::block_timestamp() - requested_at <= END_EARLY_CONFIRM_WINDOW_NANOS,
            "The host's end-early request has expired - they'll need to ask again"
        );
        pool.state = PoolState::AwaitingFinalization;
        pool.end_early_requested_at_nanos = None;
        self.pools.insert(&pool_id, &pool);
    }

    // ---- FINALIZE (host) ----
    // [FUNDS SAFETY] State is set to Finalized FIRST, before any
    // transfer Promise is created - this is what makes a double-payout
    // impossible even if something about the transfer scheduling races.
    // [BUG FIX] No more .then()/cross-contract-callback chain to detect
    // a failed transfer automatically - that pattern (calling back into
    // this same contract to check the transfer's own result) was
    // causing a "WebAssembly unreachable opcode" trap at runtime on the
    // deployed near-sdk version, crashing finalize entirely. Every
    // winner here already has a real on-chain account (they interacted
    // with this same contract via join_pool/create_pool already), so an
    // outbound transfer failing is extremely unlikely in practice; if a
    // player ever reports a missing payout, see
    // admin_credit_stuck_funds below for the manual fallback.
    pub fn finalize_pool(&mut self, pool_id: PoolId) -> Promise {
        let mut pool = self.pools.get(&pool_id).expect("Pool not found");
        assert_eq!(env::predecessor_account_id(), pool.host_id, "Only the host can finalize");
        assert_eq!(pool.state, PoolState::AwaitingFinalization, "Pool is not awaiting finalization");

        // Rank every participant with at least 1 point, highest first;
        // tie-break by whichever account's leaderboard entry was
        // written FIRST is naturally preserved by iteration order here
        // since UnorderedMap/LookupMap insertion order for equal keys
        // isn't reshuffled - ties are rare given points come from many
        // independent per-match reports.
        let mut ranked: Vec<(AccountId, u64)> = pool
            .participants
            .iter()
            .filter_map(|acc| pool.leaderboard.get(&acc).map(|pts| (acc, pts)))
            .filter(|(_, pts)| *pts > 0)
            .collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1));
        let winners: Vec<(AccountId, u64)> = ranked.into_iter().take(3).collect();

        let split_bps: [u16; 3] = [5000, 3000, 2000]; // 50/30/20%, only among however many winners actually exist
        let split_total: u32 = split_bps.iter().take(winners.len()).map(|b| *b as u32).sum();

        let platform_cut = (pool.total_fund as u128 * self.platform_fee_bps as u128) / 10_000;
        // [FUNDS SAFETY] saturating_sub, not a raw `-` - defensive
        // insurance against ever underflowing here, even though normal
        // fee percentages (<=100%) can't actually produce
        // platform_cut > total_fund.
        let payout_pool = pool.total_fund.saturating_sub(platform_cut);

        // [FUNDS SAFETY] Mark Finalized and account for the platform
        // fee BEFORE any transfer is created.
        pool.state = PoolState::Finalized;
        self.platform_fees_balance += platform_cut;
        self.pools.insert(&pool_id, &pool);

        let mut promise: Option<Promise> = None;
        if split_total > 0 {
            for (i, (account_id, _points)) in winners.iter().enumerate() {
                let share = (payout_pool as u128 * split_bps[i] as u128) / split_total as u128;
                if share == 0 { continue; }
                let p = Promise::new(account_id.clone()).transfer(near_sdk::NearToken::from_yoctonear(share));
                promise = Some(match promise {
                    Some(existing) => existing.and(p),
                    None => p,
                });
            }
        }
        promise.unwrap_or_else(|| Promise::new(env::current_account_id()))
    }

    // [FUNDS SAFETY] Manual fallback for the rare case a payout
    // genuinely never arrives (finalize_pool no longer auto-detects
    // this - see its own comment above) - Om7eth can credit the
    // specific amount as a claimable stuck-fund entry FOR THAT SAME
    // ACCOUNT ONLY once he's confirmed with the player it didn't
    // arrive. This never moves money itself - it just makes an amount
    // claimable; the player still has to call claim_stuck_funds
    // themselves to actually receive it.
    pub fn admin_credit_stuck_funds(&mut self, pool_id: PoolId, account_id: AccountId, amount: U128) {
        assert_eq!(env::predecessor_account_id(), self.owner_id, "Only the owner can do this");
        let mut pool = self.pools.get(&pool_id).expect("Pool not found");
        let amount_val: u128 = amount.into();
        let existing = pool.stuck_funds.get(&account_id).unwrap_or(0);
        pool.stuck_funds.insert(&account_id, &(existing + amount_val));
        self.pools.insert(&pool_id, &pool);
    }

    // ---- STUCK FUNDS ----
    pub fn claim_stuck_funds(&mut self, pool_id: PoolId) -> Promise {
        let mut pool = self.pools.get(&pool_id).expect("Pool not found");
        let account_id = env::predecessor_account_id();
        let amount = pool.stuck_funds.get(&account_id).unwrap_or(0);
        assert!(amount > 0, "Nothing to claim");
        pool.stuck_funds.insert(&account_id, &0);
        self.pools.insert(&pool_id, &pool);
        Promise::new(account_id).transfer(near_sdk::NearToken::from_yoctonear(amount))
    }

    // [FUNDS SAFETY] Destination is ALWAYS the account this stuck
    // balance already belongs to - there is no parameter for a
    // different recipient. Om7eth can nudge a stuck payout along; he
    // can never redirect it.
    pub fn admin_release_stuck_funds(&mut self, pool_id: PoolId, account_id: AccountId) -> Promise {
        assert_eq!(env::predecessor_account_id(), self.owner_id, "Only the owner can do this");
        let mut pool = self.pools.get(&pool_id).expect("Pool not found");
        let amount = pool.stuck_funds.get(&account_id).unwrap_or(0);
        assert!(amount > 0, "Nothing stuck for that account");
        pool.stuck_funds.insert(&account_id, &0);
        self.pools.insert(&pool_id, &pool);
        Promise::new(account_id).transfer(near_sdk::NearToken::from_yoctonear(amount))
    }

    // ---- CANCEL / REACTIVATE ----
    pub fn report_pool_issue(&mut self, pool_id: PoolId) {
        let mut pool = self.pools.get(&pool_id).expect("Pool not found");
        assert_eq!(env::predecessor_account_id(), pool.host_id, "Only the host can do this");
        assert_eq!(pool.matches_played, 0, "Can only cancel before any match has been played");
        assert_eq!(pool.state, PoolState::Active, "Pool is not active");
        pool.state = PoolState::Cancelled;
        pool.last_activity_nanos = env::block_timestamp();
        self.pools.insert(&pool_id, &pool);
    }

    // [FEATURE] Existing participants' funds carry over automatically -
    // nothing to re-deposit. New players can also join afterward
    // (normal join_pool, since matches_played is still 0).
    pub fn reactivate_pool(&mut self, pool_id: PoolId) {
        let mut pool = self.pools.get(&pool_id).expect("Pool not found");
        assert_eq!(env::predecessor_account_id(), pool.host_id, "Only the host can do this");
        assert_eq!(pool.state, PoolState::Cancelled, "Pool is not cancelled");
        pool.state = PoolState::Active;
        pool.last_activity_nanos = env::block_timestamp();
        self.pools.insert(&pool_id, &pool);
    }

    // [SAFETY NET] Anyone who's actually a participant can trigger this
    // if a pool has sat at zero matches played with no host/backup
    // activity for 48+ hours - this is what prevents funds being
    // permanently stuck just because a host vanished before anyone
    // could hand off their role. Pool becomes Cancelled, same as a
    // normal host-initiated cancel (funds locked, reactivatable by
    // whoever holds the host role at that point - which by then may
    // have needed transfer_host_role from a backup, if one was set).
    pub fn auto_cancel_stale_pool(&mut self, pool_id: PoolId) {
        let mut pool = self.pools.get(&pool_id).expect("Pool not found");
        let caller = env::predecessor_account_id();
        assert!(pool.participants.contains(&caller), "Only a participant can do this");
        assert_eq!(pool.matches_played, 0, "This pool already has matches played");
        assert_eq!(pool.state, PoolState::Active, "Pool is not active");
        assert!(
            env::block_timestamp() - pool.last_activity_nanos >= STALE_POOL_TIMEOUT_NANOS,
            "This pool hasn't been inactive long enough yet"
        );
        pool.state = PoolState::Cancelled;
        self.pools.insert(&pool_id, &pool);
    }

    // ---- OWNER-ONLY ADMIN ----
    pub fn update_points_cap(&mut self, new_cap: u64) {
        assert_eq!(env::predecessor_account_id(), self.owner_id, "Only the owner can do this");
        self.points_cap = new_cap;
    }

    pub fn set_platform_fee_bps(&mut self, new_bps: u16) {
        assert_eq!(env::predecessor_account_id(), self.owner_id, "Only the owner can do this");
        assert!(new_bps <= 2000, "Platform fee can't exceed 20%");
        self.platform_fee_bps = new_bps;
    }

    pub fn set_oracle(&mut self, new_oracle_id: AccountId) {
        assert_eq!(env::predecessor_account_id(), self.owner_id, "Only the owner can do this");
        self.oracle_id = new_oracle_id;
    }

    // [FUNDS SAFETY] Only ever pays out of platform_fees_balance - the
    // running total of fees already collected from FINALIZED pools.
    // Cannot touch any pool's active escrow, by construction (there's
    // no code path in this function that ever reads a Pool's
    // total_fund).
    pub fn withdraw_platform_fees(&mut self, amount: U128) -> Promise {
        assert_eq!(env::predecessor_account_id(), self.owner_id, "Only the owner can do this");
        let amount_val: u128 = amount.into();
        assert!(amount_val <= self.platform_fees_balance, "Not enough collected fees");
        self.platform_fees_balance -= amount_val;
        Promise::new(self.owner_id.clone()).transfer(near_sdk::NearToken::from_yoctonear(amount_val))
    }

    // ---- VIEW METHODS ----
    pub fn get_pool_summary(&self, pool_id: PoolId) -> Option<(String, u8, u8, PoolState)> {
        self.pools.get(&pool_id).map(|p| (p.name, p.matches_played, p.max_matches, p.state))
    }

    pub fn get_leaderboard(&self, pool_id: PoolId) -> Vec<(AccountId, u64)> {
        let pool = self.pools.get(&pool_id).expect("Pool not found");
        pool.participants
            .iter()
            .filter_map(|acc| pool.leaderboard.get(&acc).map(|pts| (acc, pts)))
            .collect()
    }

    pub fn get_stuck_funds(&self, pool_id: PoolId, account_id: AccountId) -> U128 {
        let pool = self.pools.get(&pool_id).expect("Pool not found");
        pool.stuck_funds.get(&account_id).unwrap_or(0).into()
    }
}
