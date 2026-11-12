"""60-day $SABOTEUR supply simulation, using the exact rules in src/lib.rs (Rules::launch).

Run:  python3 token-v2/simulate.py      (standard library only)

Each scenario is a community size: how many matches a day, how many real
players are in a typical match, how often the crew catches the saboteur by
vote, and how many Play Passes get burned. The weekly reward budget, the
1%/10%/100% real-player tiers, the daily 25% rule and the Ritual Pool all
follow the contract.
"""
import random

ONE = 1
RANK = [1000, 600, 400]
FINISHED = 100
TIER = {1: 0.01, 2: 0.10, 3: 0.10}  # 4+ real players -> 1.0
CATCH_BURN = 1000
PASS_PRICE = 15000
WEEKLY_BASE = 150000
BURN_TO_BUDGET = 0.5
SUPPLY = 1_000_000_000
RITUAL_POOL = 50_000_000
MIGRATED = 36_573  # v1 balances copied at launch


def tier(humans):
    return 1.0 if humans >= 4 else TIER.get(humans, 0.0)


def run(name, matches_per_day, humans, players, catch_rate, passes_per_week, days=60, seed=7):
    rnd = random.Random(seed)
    minted = MIGRATED
    burned = 0          # catch burns (Ritual Pool) + Play Pass burns (players)
    pass_burned = 0
    ritual = RITUAL_POOL
    capped_days = 0
    week_budget, week_minted, week_burned = WEEKLY_BASE, 0, 0
    rows = []
    for day in range(1, days + 1):
        hit = False
        for _ in range(matches_per_day):
            h = max(1, min(players, round(rnd.gauss(humans, 1))))
            want = (sum(RANK) + FINISHED * (players - 3)) * tier(h)
            pay = min(want, week_budget - week_minted)
            hit = hit or pay < want
            week_minted += pay
            minted += pay
            if rnd.random() < catch_rate:
                b = min(CATCH_BURN * tier(h), ritual)
                ritual -= b
                burned += b
                week_burned += b
        capped_days += hit
        if day % 7 == 0:
            p = PASS_PRICE * passes_per_week
            burned += p
            pass_burned += p
            week_burned += p
            week_budget = WEEKLY_BASE + week_burned * BURN_TO_BUDGET
            week_minted, week_burned = 0, 0
        if day in (1, 7, 14, 30, 45, 60):
            rows.append((day, minted, burned - pass_burned, pass_burned, SUPPLY - burned, minted - pass_burned, week_budget, capped_days))
    print(f"\n{name}: {matches_per_day} matches/day, ~{humans} real players of {players}, saboteur caught {int(catch_rate*100)}%, {passes_per_week} Play Pass burns/week")
    print("| Day | Earned by players | Burned by catches (Ritual Pool) | Burned for Play Pass | Total supply | Held by players | Next week's budget | Days the budget ran out |")
    print("|---|---|---|---|---|---|---|---|")
    for d, m, bc, bp, s, c, wb, cd in rows:
        print(f"| {d} | {m:,.0f} | {bc:,.0f} | {bp:,.0f} | {s:,.0f} | {c:,.0f} | {wb:,.0f} | {cd} |")


if __name__ == "__main__":
    run("Today (small)", matches_per_day=10, humans=2, players=8, catch_rate=0.4, passes_per_week=0)
    run("Growing", matches_per_day=60, humans=4, players=8, catch_rate=0.45, passes_per_week=3)
    run("Busy", matches_per_day=250, humans=6, players=10, catch_rate=0.45, passes_per_week=15)
