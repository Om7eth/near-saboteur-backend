//! $SABOTEUR v2 - the NEAR Saboteur game token (NEP-141 + NEP-148), testnet.
//!
//! The token's mechanics live HERE, in the contract, not in the game server:
//!   * Match rewards are computed by the contract from a fixed table. The game
//!     server only REPORTS a match (who placed where, how many real players);
//!     it can't choose amounts, and a match id can only be rewarded once.
//!   * "Catch = burn": every time the crew catches the saboteur, the contract
//!     burns tokens from its own Ritual Pool (never from players).
//!   * Play Pass can be bought by burning $SABOTEUR (the buyer signs).
//!   * Weekly mint budget = base + a share of LAST week's burns, so the more the
//!     community plays (and burns), the more rewards the next week can pay.
//!   * Every rule is public (`get_rules`). The owner can only change rules with a
//!     7-day public timelock, inside hard bounds checked here.
//!
//! Testnet token. It has no value and nothing is promised about its future.

use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::resolver::FungibleTokenResolver;
use near_contract_standards::fungible_token::FungibleToken;
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::collections::{LazyOption, LookupMap, LookupSet};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault,
    PromiseOrValue,
};

pub const ONE: u128 = 1_000_000_000_000_000_000; // 18 decimals
pub const MAX_SUPPLY: u128 = 1_000_000_000 * ONE;
pub const RITUAL_POOL: u128 = 50_000_000 * ONE;
pub const MIGRATION_CAP: u128 = 2_000_000 * ONE;
pub const RULES_TIMELOCK_NS: u64 = 7 * 24 * 60 * 60 * 1_000_000_000;
const SEC_NS: u64 = 1_000_000_000;
/// Weeks start Saturday 00:00 IST (= Friday 18:30 UTC), like the game's Ranks.
const WEEK_OFFSET_S: u64 = 153_000; // first such moment after the unix epoch
const WEEK_S: u64 = 604_800;
const DAY_S: u64 = 86_400;

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Token,
    Meta,
    Seen,
    Daily,
    Passes,
}

/// Every number the mechanics use. Amounts are in base units (18 decimals).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Rules {
    /// Reward for 1st, 2nd, 3rd place.
    pub rank_rewards: [U128; 3],
    /// Reward for everyone else who finished the match.
    pub finished_reward: U128,
    /// Share paid by how many REAL players were in the match (basis points).
    pub tier_4plus_bps: u16,
    pub tier_2to3_bps: u16,
    pub tier_1_bps: u16,
    /// First N matches a day pay in full, after that `after_daily_bps`.
    pub daily_full_matches: u8,
    pub after_daily_bps: u16,
    /// Play Pass holders earn this many times the reward.
    pub play_pass_multiplier: u8,
    /// Burned from the Ritual Pool when the saboteur is caught (times the tier).
    pub catch_burn: U128,
    /// Burned from the buyer to unlock Play Pass.
    pub play_pass_price: U128,
    /// Weekly mint budget = base + last week's burns * burn_to_budget_bps.
    pub weekly_base_budget: U128,
    pub burn_to_budget_bps: u16,
    /// Paid once per finished referral.
    pub referral_reward: U128,
}

impl Rules {
    pub fn launch() -> Self {
        Rules {
            rank_rewards: [U128(1_000 * ONE), U128(600 * ONE), U128(400 * ONE)],
            finished_reward: U128(100 * ONE),
            tier_4plus_bps: 10_000,
            tier_2to3_bps: 1_000,
            tier_1_bps: 100,
            daily_full_matches: 5,
            after_daily_bps: 2_500,
            play_pass_multiplier: 2,
            catch_burn: U128(1_000 * ONE),
            play_pass_price: U128(15_000 * ONE),
            weekly_base_budget: U128(150_000 * ONE),
            burn_to_budget_bps: 5_000,
            referral_reward: U128(1_000 * ONE),
        }
    }

    /// Hard bounds: no rule change can ever go past these.
    fn validate(&self) {
        let bps = [self.tier_4plus_bps, self.tier_2to3_bps, self.tier_1_bps, self.after_daily_bps, self.burn_to_budget_bps];
        require!(bps.iter().all(|b| *b <= 10_000), "A share can't be above 100%");
        for r in self.rank_rewards.iter() {
            require!(r.0 <= 10_000 * ONE, "Match reward too big");
        }
        require!(self.finished_reward.0 <= 10_000 * ONE, "Match reward too big");
        require!(self.play_pass_multiplier >= 1 && self.play_pass_multiplier <= 3, "Multiplier must be 1-3");
        require!(self.daily_full_matches >= 1, "Daily matches must be at least 1");
        require!(self.catch_burn.0 <= 10_000 * ONE, "Catch burn too big");
        require!(self.play_pass_price.0 >= ONE && self.play_pass_price.0 <= 1_000_000 * ONE, "Play Pass price out of range");
        require!(self.weekly_base_budget.0 <= 10_000_000 * ONE, "Weekly budget too big");
        require!(self.referral_reward.0 <= 10_000 * ONE, "Referral reward too big");
    }

    fn tier_bps(&self, humans: u8) -> u128 {
        (match humans {
            0 => 0,
            1 => self.tier_1_bps,
            2 | 3 => self.tier_2to3_bps,
            _ => self.tier_4plus_bps,
        }) as u128
    }
}

/// One player in a reported match. rank 1-3 = podium, 0 = finished.
#[near(serializers = [json])]
#[derive(Clone)]
pub struct MatchResult {
    pub account_id: AccountId,
    pub rank: u8,
    pub play_pass: bool,
}

#[near(serializers = [json])]
pub struct Stats {
    pub total_supply: U128,
    pub reward_reserve: U128,
    pub ritual_pool: U128,
    pub minted_by_play: U128,
    pub migrated: U128,
    pub burned_total: U128,
    pub burned_by_catches: U128,
    pub burned_by_passes: U128,
    pub burned_by_holders: U128,
    pub saboteurs_caught: u64,
    pub play_passes: u64,
    pub matches_rewarded: u64,
    pub week: u64,
    pub week_minted: U128,
    pub week_budget: U128,
    pub week_burned: U128,
}

#[near(serializers = [json])]
pub struct RulesView {
    pub rules: Rules,
    pub pending: Option<Rules>,
    pub pending_applies_at_ns: Option<u64>,
    pub timelock_days: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    metadata: LazyOption<FungibleTokenMetadata>,
    owner: AccountId,
    game: AccountId,
    rules: Rules,
    pending: Option<(Rules, u64)>,
    reserve: u128,
    ritual_pool: u128,
    minted_by_play: u128,
    migrated: u128,
    burned_catch: u128,
    burned_pass: u128,
    burned_holders: u128,
    catches: u64,
    passes: u64,
    matches: u64,
    week: u64,
    week_minted: u128,
    week_burned: u128,
    week_budget: u128,
    seen: LookupSet<String>,
    daily: LookupMap<AccountId, (u64, u8)>,
    pass_holders: LookupSet<AccountId>,
    migration_open: bool,
}

fn event(kind: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "saboteur", "version": "2.0.0", "event": kind, "data": [data] })
    ));
}

fn now_s() -> u64 {
    env::block_timestamp() / SEC_NS
}

fn week_of(ts_s: u64) -> u64 {
    ts_s.saturating_sub(WEEK_OFFSET_S) / WEEK_S
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, game_id: AccountId) -> Self {
        let rules = Rules::launch();
        rules.validate();
        let me = env::current_account_id();
        let mut this = Self {
            token: FungibleToken::new(Key::Token),
            metadata: LazyOption::new(
                Key::Meta,
                Some(&FungibleTokenMetadata {
                    spec: FT_METADATA_SPEC.to_string(),
                    name: "SABOTEUR".to_string(),
                    symbol: "SABOTEUR".to_string(),
                    icon: Some("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTQiIGZpbGw9IiMwYjBkMTIiLz48Y2lyY2xlIGN4PSIzMiIgY3k9IjMyIiByPSIyMiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmY4YTNkIiBzdHJva2Utd2lkdGg9IjUiLz48dGV4dCB4PSIzMiIgeT0iNDEiIGZvbnQtZmFtaWx5PSJBcmlhbCBCbGFjayxBcmlhbCIgZm9udC1zaXplPSIyNCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0iIzZlZmZjMCI+UzwvdGV4dD48L3N2Zz4=".to_string()),
                    reference: None,
                    reference_hash: None,
                    decimals: 18,
                }),
            ),
            owner: owner_id,
            game: game_id,
            rules: rules.clone(),
            pending: None,
            reserve: MAX_SUPPLY - RITUAL_POOL,
            ritual_pool: RITUAL_POOL,
            minted_by_play: 0,
            migrated: 0,
            burned_catch: 0,
            burned_pass: 0,
            burned_holders: 0,
            catches: 0,
            passes: 0,
            matches: 0,
            week: week_of(now_s()),
            week_minted: 0,
            week_burned: 0,
            week_budget: rules.weekly_base_budget.0,
            seen: LookupSet::new(Key::Seen),
            daily: LookupMap::new(Key::Daily),
            pass_holders: LookupSet::new(Key::Passes),
            migration_open: true,
        };
        // The whole supply is created once, held by the contract itself:
        // the reward reserve plus the Ritual Pool. Nothing is minted later.
        this.token.internal_register_account(&me);
        this.token.internal_deposit(&me, MAX_SUPPLY);
        FtMint { owner_id: &me, amount: U128(MAX_SUPPLY), memo: Some("Genesis: reward reserve + Ritual Pool") }.emit();
        this
    }

    // ------------------------------------------------------------ helpers
    fn assert_game(&self) {
        require!(env::predecessor_account_id() == self.game, "Only the game account can report matches");
    }
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "Only the owner");
    }
    fn mark_seen(&mut self, key: String) {
        require!(key.len() <= 80, "Id too long");
        require!(self.seen.insert(&key), "Already recorded");
    }
    /// Applies timelocked rules once due, and rolls the weekly budget.
    fn tick(&mut self) {
        if let Some((r, at)) = self.pending.clone() {
            if env::block_timestamp() >= at {
                self.rules = r.clone();
                self.pending = None;
                event("rules_applied", json!({ "rules": r }));
            }
        }
        let w = week_of(now_s());
        if w != self.week {
            let carry = if w == self.week + 1 { self.week_burned } else { 0 };
            self.week = w;
            self.week_minted = 0;
            self.week_burned = 0;
            self.week_budget = self.rules.weekly_base_budget.0 + carry * self.rules.burn_to_budget_bps as u128 / 10_000;
            event("new_week", json!({ "week": w, "budget": U128(self.week_budget), "from_burns": U128(carry) }));
        }
    }
    /// Pays from the reward reserve, never past this week's budget.
    fn pay_budgeted(&mut self, to: &AccountId, want: u128) -> u128 {
        let left = self.week_budget.saturating_sub(self.week_minted);
        let amount = want.min(left).min(self.reserve);
        if amount == 0 {
            return 0;
        }
        self.pay(to, amount);
        self.week_minted += amount;
        self.minted_by_play += amount;
        amount
    }
    fn pay(&mut self, to: &AccountId, amount: u128) {
        let me = env::current_account_id();
        require!(to != &me, "Can't pay the contract itself");
        if !self.token.accounts.contains_key(to) {
            self.token.internal_register_account(to); // the contract pays this storage
        }
        self.reserve -= amount;
        self.token.internal_transfer(&me, to, amount, None);
    }
    fn burn_from(&mut self, owner: &AccountId, amount: u128, memo: &str) {
        self.token.internal_withdraw(owner, amount);
        self.week_burned += amount;
        FtBurn { owner_id: owner, amount: U128(amount), memo: Some(memo) }.emit();
    }

    // ------------------------------------------------- game reports (game account)
    /// The game reports a finished match. The contract computes every amount.
    pub fn reward_match(&mut self, match_id: String, humans: u8, results: Vec<MatchResult>) -> Vec<U128> {
        self.assert_game();
        require!(!match_id.is_empty(), "Missing match id");
        require!(results.len() <= 16, "Too many players");
        require!(humans as usize <= 16, "Too many players");
        self.mark_seen(format!("m:{}", match_id));
        self.tick();
        let day = now_s() / DAY_S;
        let tier = self.rules.tier_bps(humans);
        let mut out = Vec::with_capacity(results.len());
        let mut total = 0u128;
        for (i, r) in results.iter().enumerate() {
            require!(results[..i].iter().all(|x| x.account_id != r.account_id), "Player listed twice");
            require!(r.rank <= 3, "Rank must be 0-3");
            let base = if r.rank >= 1 { self.rules.rank_rewards[(r.rank - 1) as usize].0 } else { self.rules.finished_reward.0 };
            let mut amount = base * tier / 10_000;
            let (d, c) = self.daily.get(&r.account_id).unwrap_or((day, 0));
            let count = if d == day { c.saturating_add(1) } else { 1 };
            self.daily.insert(&r.account_id, &(day, count));
            if count > self.rules.daily_full_matches {
                amount = amount * self.rules.after_daily_bps as u128 / 10_000;
            }
            if r.play_pass {
                amount *= self.rules.play_pass_multiplier as u128;
            }
            let paid = self.pay_budgeted(&r.account_id, amount);
            total += paid;
            out.push(U128(paid));
        }
        self.matches += 1;
        event("match_rewarded", json!({ "match_id": match_id, "humans": humans, "total": U128(total) }));
        out
    }

    /// "Catch = burn": the crew caught the saboteur. Burns from the Ritual Pool.
    pub fn catch_ritual(&mut self, match_id: String, humans: u8) -> U128 {
        self.assert_game();
        require!(!match_id.is_empty(), "Missing match id");
        self.mark_seen(format!("c:{}", match_id));
        self.tick();
        let amount = (self.rules.catch_burn.0 * self.rules.tier_bps(humans) / 10_000).min(self.ritual_pool);
        if amount > 0 {
            self.ritual_pool -= amount;
            self.burned_catch += amount;
            let me = env::current_account_id();
            self.burn_from(&me, amount, "Saboteur caught");
        }
        self.catches += 1;
        event("saboteur_caught", json!({ "match_id": match_id, "humans": humans, "burned": U128(amount) }));
        U128(amount)
    }

    /// A referred friend finished their matches.
    pub fn reward_referral(&mut self, referral_id: String, account_id: AccountId) -> U128 {
        self.assert_game();
        self.mark_seen(format!("r:{}", referral_id));
        self.tick();
        let paid = self.pay_budgeted(&account_id, self.rules.referral_reward.0);
        event("referral_rewarded", json!({ "account_id": account_id, "amount": U128(paid) }));
        U128(paid)
    }

    // ----------------------------------------------------------- holders
    /// Burns the Play Pass price from the caller. One pass per account.
    #[payable]
    pub fn buy_play_pass(&mut self) {
        assert_one_yocto();
        self.tick();
        let buyer = env::predecessor_account_id();
        require!(!self.pass_holders.contains(&buyer), "This account already has Play Pass");
        let price = self.rules.play_pass_price.0;
        require!(self.token.ft_balance_of(buyer.clone()).0 >= price, "Not enough $SABOTEUR for Play Pass");
        self.burn_from(&buyer, price, "Play Pass");
        self.burned_pass += price;
        self.pass_holders.insert(&buyer);
        self.passes += 1;
        event("play_pass", json!({ "account_id": buyer, "burned": U128(price) }));
    }

    /// Any holder can burn their own tokens.
    #[payable]
    pub fn burn(&mut self, amount: U128) {
        assert_one_yocto();
        require!(amount.0 > 0, "Nothing to burn");
        self.tick();
        let who = env::predecessor_account_id();
        self.burn_from(&who, amount.0, "Holder burn");
        self.burned_holders += amount.0;
    }

    // ------------------------------------------------------------- owner
    /// Proposes new rules. They apply only after the 7-day public timelock.
    #[payable]
    pub fn propose_rules(&mut self, rules: Rules) {
        assert_one_yocto();
        self.assert_owner();
        rules.validate();
        let at = env::block_timestamp() + RULES_TIMELOCK_NS;
        self.pending = Some((rules.clone(), at));
        event("rules_proposed", json!({ "rules": rules, "applies_at_ns": at }));
    }
    #[payable]
    pub fn cancel_proposed_rules(&mut self) {
        assert_one_yocto();
        self.assert_owner();
        self.pending = None;
        event("rules_cancelled", json!({}));
    }
    /// Anyone can apply due rules / roll the week.
    pub fn poke(&mut self) {
        self.tick();
    }
    /// Rotates the game reporter key (it can only do what the rules allow).
    #[payable]
    pub fn set_game(&mut self, game_id: AccountId) {
        assert_one_yocto();
        self.assert_owner();
        event("game_changed", json!({ "from": self.game, "to": game_id }));
        self.game = game_id;
    }
    /// One-time copy of balances from $SABOTEUR v1 (capped, then closed forever).
    pub fn migrate(&mut self, entries: Vec<(AccountId, U128)>) {
        self.assert_owner();
        require!(self.migration_open, "Migration is closed");
        for (acc, amt) in entries.iter() {
            require!(self.migrated + amt.0 <= MIGRATION_CAP, "Migration cap reached");
            self.mark_seen(format!("v1:{}", acc));
            self.pay(acc, amt.0);
            self.migrated += amt.0;
        }
        event("migrated", json!({ "accounts": entries.len(), "total": U128(self.migrated) }));
    }
    pub fn finish_migration(&mut self) {
        self.assert_owner();
        self.migration_open = false;
        event("migration_closed", json!({ "total": U128(self.migrated) }));
    }

    // ------------------------------------------------------------- views
    pub fn get_rules(&self) -> RulesView {
        RulesView {
            rules: self.rules.clone(),
            pending: self.pending.as_ref().map(|p| p.0.clone()),
            pending_applies_at_ns: self.pending.as_ref().map(|p| p.1),
            timelock_days: 7,
        }
    }
    pub fn get_stats(&self) -> Stats {
        // A view can't write, so show the week as it would look right now.
        let w = week_of(now_s());
        let (week_minted, week_burned, week_budget) = if w == self.week {
            (self.week_minted, self.week_burned, self.week_budget)
        } else {
            let carry = if w == self.week + 1 { self.week_burned } else { 0 };
            (0, 0, self.rules.weekly_base_budget.0 + carry * self.rules.burn_to_budget_bps as u128 / 10_000)
        };
        Stats {
            total_supply: self.token.ft_total_supply(),
            reward_reserve: U128(self.reserve),
            ritual_pool: U128(self.ritual_pool),
            minted_by_play: U128(self.minted_by_play),
            migrated: U128(self.migrated),
            burned_total: U128(self.burned_catch + self.burned_pass + self.burned_holders),
            burned_by_catches: U128(self.burned_catch),
            burned_by_passes: U128(self.burned_pass),
            burned_by_holders: U128(self.burned_holders),
            saboteurs_caught: self.catches,
            play_passes: self.passes,
            matches_rewarded: self.matches,
            week: w,
            week_minted: U128(week_minted),
            week_budget: U128(week_budget),
            week_burned: U128(week_burned),
        }
    }
    pub fn has_play_pass(&self, account_id: AccountId) -> bool {
        self.pass_holders.contains(&account_id)
    }
    pub fn get_config(&self) -> (AccountId, AccountId, bool) {
        (self.owner.clone(), self.game.clone(), self.migration_open)
    }
}

// ------------------------------------------------------- NEP-141 plumbing
#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }
    #[payable]
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }
    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }
    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, _burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }
    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        require!(env::predecessor_account_id() != env::current_account_id(), "The contract can't unregister");
        require!(force != Some(true), "Use burn() instead of force-unregistering");
        self.token.internal_storage_unregister(force).is_some()
    }
    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }
    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.get().unwrap()
    }
}

// ------------------------------------------------------------------ tests
#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const START_NS: u64 = 1_794_000_000 * SEC_NS; // Nov 2026
    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn ctx(pred: &str, ts: u64, dep: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acc("sabo.saboteur.testnet"))
            .predecessor_account_id(acc(pred))
            .block_timestamp(ts)
            .attached_deposit(NearToken::from_yoctonear(dep))
            .account_balance(NearToken::from_near(50))
            .build());
    }
    fn setup() -> Contract {
        ctx("owner.testnet", START_NS, 0);
        Contract::new(acc("owner.testnet"), acc("game.testnet"))
    }
    fn r(a: &str, rank: u8, pass: bool) -> MatchResult {
        MatchResult { account_id: acc(a), rank, play_pass: pass }
    }
    fn bal(c: &Contract, a: &str) -> u128 {
        c.ft_balance_of(acc(a)).0 / ONE
    }
    fn full_match(c: &mut Contract, id: &str, ts: u64) {
        ctx("game.testnet", ts, 0);
        c.reward_match(id.into(), 6, vec![r("a.testnet", 1, false), r("b.testnet", 2, false), r("c.testnet", 3, false), r("d.testnet", 0, false)]);
    }

    #[test]
    fn genesis_supply_and_pools() {
        let c = setup();
        assert_eq!(c.ft_total_supply().0, MAX_SUPPLY);
        let s = c.get_stats();
        assert_eq!(s.ritual_pool.0, RITUAL_POOL);
        assert_eq!(s.reward_reserve.0, MAX_SUPPLY - RITUAL_POOL);
        assert_eq!(s.week_budget.0, 150_000 * ONE);
        assert_eq!(c.get_rules().rules.play_pass_price.0, 15_000 * ONE);
    }

    #[test]
    fn full_room_pays_the_table() {
        let mut c = setup();
        full_match(&mut c, "m1", START_NS);
        assert_eq!((bal(&c, "a.testnet"), bal(&c, "b.testnet"), bal(&c, "c.testnet"), bal(&c, "d.testnet")), (1000, 600, 400, 100));
        assert_eq!(c.get_stats().minted_by_play.0, 2_100 * ONE);
        assert_eq!(c.ft_total_supply().0, MAX_SUPPLY); // paying moves tokens, it doesn't mint
    }

    #[test]
    fn real_player_tiers() {
        let mut c = setup();
        ctx("game.testnet", START_NS, 0);
        c.reward_match("two".into(), 2, vec![r("a.testnet", 1, false)]);
        c.reward_match("solo".into(), 1, vec![r("b.testnet", 1, false)]);
        c.reward_match("bots".into(), 0, vec![r("c.testnet", 1, false)]);
        assert_eq!((bal(&c, "a.testnet"), bal(&c, "b.testnet"), bal(&c, "c.testnet")), (100, 10, 0));
    }

    #[test]
    #[should_panic(expected = "Already recorded")]
    fn a_match_pays_once() {
        let mut c = setup();
        full_match(&mut c, "m1", START_NS);
        full_match(&mut c, "m1", START_NS);
    }

    #[test]
    #[should_panic(expected = "Only the game account")]
    fn only_game_reports() {
        let mut c = setup();
        ctx("someone.testnet", START_NS, 0);
        c.reward_match("x".into(), 6, vec![r("someone.testnet", 1, false)]);
    }

    #[test]
    #[should_panic(expected = "Player listed twice")]
    fn no_double_listing() {
        let mut c = setup();
        ctx("game.testnet", START_NS, 0);
        c.reward_match("x".into(), 6, vec![r("a.testnet", 1, false), r("a.testnet", 2, false)]);
    }

    #[test]
    fn sixth_match_of_the_day_pays_a_quarter_and_pass_doubles() {
        let mut c = setup();
        ctx("game.testnet", START_NS, 0);
        for i in 0..6 {
            c.reward_match(format!("d{}", i), 6, vec![r("a.testnet", 1, false)]);
        }
        assert_eq!(bal(&c, "a.testnet"), 5 * 1000 + 250);
        c.reward_match("p".into(), 6, vec![r("p.testnet", 1, true)]);
        assert_eq!(bal(&c, "p.testnet"), 2000);
        // next day resets the count
        ctx("game.testnet", START_NS + DAY_S * SEC_NS, 0);
        c.reward_match("next".into(), 6, vec![r("a.testnet", 1, false)]);
        assert_eq!(bal(&c, "a.testnet"), 5 * 1000 + 250 + 1000);
    }

    #[test]
    fn weekly_budget_caps_and_burns_raise_next_week() {
        let mut c = setup();
        ctx("game.testnet", START_NS, 0);
        let mut i = 0;
        // 150 different winners x 1000 = the whole 150k budget
        while c.get_stats().week_minted.0 < 150_000 * ONE {
            ctx("game.testnet", START_NS, 0); // fresh context = fresh log buffer
            c.reward_match(format!("w{}", i), 6, vec![r(&format!("p{}.testnet", i), 1, false)]);
            i += 1;
        }
        let paid = c.reward_match("over".into(), 6, vec![r("late.testnet", 1, false)]);
        assert_eq!(paid[0].0, 0);
        // burn 10 catches this week (10 x 1000) -> next week +5,000
        for k in 0..10 {
            c.catch_ritual(format!("c{}", k), 6);
        }
        let next = START_NS + WEEK_S * SEC_NS;
        ctx("game.testnet", next, 0);
        assert_eq!(c.get_stats().week_budget.0, 155_000 * ONE);
        c.poke();
        let s = c.get_stats();
        assert_eq!((s.week_budget.0, s.week_minted.0), (155_000 * ONE, 0));
    }

    #[test]
    fn catch_burns_from_the_ritual_pool_once() {
        let mut c = setup();
        ctx("game.testnet", START_NS, 0);
        assert_eq!(c.catch_ritual("m1".into(), 6).0, 1_000 * ONE);
        assert_eq!(c.catch_ritual("m2".into(), 3).0, 100 * ONE);
        assert_eq!(c.catch_ritual("m3".into(), 1).0, 10 * ONE);
        let s = c.get_stats();
        assert_eq!(s.burned_by_catches.0, 1_110 * ONE);
        assert_eq!(s.ritual_pool.0, RITUAL_POOL - 1_110 * ONE);
        assert_eq!(s.total_supply.0, MAX_SUPPLY - 1_110 * ONE);
        assert_eq!(s.saboteurs_caught, 3);
    }

    #[test]
    #[should_panic(expected = "Already recorded")]
    fn catch_once_per_match() {
        let mut c = setup();
        ctx("game.testnet", START_NS, 0);
        c.catch_ritual("m1".into(), 6);
        c.catch_ritual("m1".into(), 6);
    }

    #[test]
    fn play_pass_burns_15k_once() {
        let mut c = setup();
        ctx("owner.testnet", START_NS, 0);
        c.migrate(vec![(acc("rich.testnet"), U128(20_000 * ONE))]);
        ctx("rich.testnet", START_NS, 1);
        c.buy_play_pass();
        assert!(c.has_play_pass(acc("rich.testnet")));
        assert_eq!(bal(&c, "rich.testnet"), 5_000);
        let s = c.get_stats();
        assert_eq!((s.play_passes, s.burned_by_passes.0), (1, 15_000 * ONE));
        assert_eq!(s.total_supply.0, MAX_SUPPLY - 15_000 * ONE);
    }

    #[test]
    #[should_panic(expected = "already has Play Pass")]
    fn play_pass_only_once() {
        let mut c = setup();
        ctx("owner.testnet", START_NS, 0);
        c.migrate(vec![(acc("rich.testnet"), U128(40_000 * ONE))]);
        ctx("rich.testnet", START_NS, 1);
        c.buy_play_pass();
        c.buy_play_pass();
    }

    #[test]
    #[should_panic(expected = "Not enough $SABOTEUR")]
    fn play_pass_needs_balance() {
        let mut c = setup();
        full_match(&mut c, "m1", START_NS);
        ctx("a.testnet", START_NS, 1);
        c.buy_play_pass();
    }

    #[test]
    fn rules_change_only_after_timelock() {
        let mut c = setup();
        let mut new_rules = Rules::launch();
        new_rules.play_pass_price = U128(12_000 * ONE);
        ctx("owner.testnet", START_NS, 1);
        c.propose_rules(new_rules.clone());
        ctx("game.testnet", START_NS + RULES_TIMELOCK_NS - 1, 0);
        c.poke();
        assert_eq!(c.get_rules().rules.play_pass_price.0, 15_000 * ONE);
        assert!(c.get_rules().pending.is_some());
        ctx("game.testnet", START_NS + RULES_TIMELOCK_NS, 0);
        c.poke();
        assert_eq!(c.get_rules().rules, new_rules);
        assert!(c.get_rules().pending.is_none());
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn only_owner_proposes() {
        let mut c = setup();
        ctx("game.testnet", START_NS, 1);
        c.propose_rules(Rules::launch());
    }

    #[test]
    #[should_panic(expected = "Multiplier must be 1-3")]
    fn rules_have_hard_bounds() {
        let mut c = setup();
        let mut bad = Rules::launch();
        bad.play_pass_multiplier = 10;
        ctx("owner.testnet", START_NS, 1);
        c.propose_rules(bad);
    }

    #[test]
    #[should_panic(expected = "Migration is closed")]
    fn migration_closes_forever() {
        let mut c = setup();
        ctx("owner.testnet", START_NS, 0);
        c.migrate(vec![(acc("x.testnet"), U128(10 * ONE))]);
        c.finish_migration();
        c.migrate(vec![(acc("y.testnet"), U128(10 * ONE))]);
    }

    #[test]
    #[should_panic(expected = "Migration cap reached")]
    fn migration_is_capped() {
        let mut c = setup();
        ctx("owner.testnet", START_NS, 0);
        c.migrate(vec![(acc("x.testnet"), U128(MIGRATION_CAP + 1))]);
    }

    #[test]
    fn holders_can_burn_and_transfer() {
        let mut c = setup();
        full_match(&mut c, "m1", START_NS);
        ctx("a.testnet", START_NS, 1);
        c.burn(U128(100 * ONE));
        assert_eq!(bal(&c, "a.testnet"), 900);
        assert_eq!(c.get_stats().burned_by_holders.0, 100 * ONE);
    }

    #[test]
    fn referral_pays_once_inside_budget() {
        let mut c = setup();
        ctx("game.testnet", START_NS, 0);
        assert_eq!(c.reward_referral("ref1".into(), acc("inviter.testnet")).0, 1_000 * ONE);
        assert_eq!(c.get_stats().week_minted.0, 1_000 * ONE);
    }
}
