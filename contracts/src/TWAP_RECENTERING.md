# TWAP-Based Onchain Recentering

> **Related docs:**
> - [`docs/debt-management.md`](../../docs/debt-management.md) — Complete debt
>   management design: why debt = directional exposure, off-market pricing math,
>   two-mode hook design (Mode 1 auction + Mode 2 dynamic fee), edge cases, and
>   simulation findings showing dutch auction is 5-6x more expensive than direct
>   swap at current scale.
> - `scripts/sim-recenter.ts` (removed) — Original simulation
>   with additive boost, bidirectional dutch auction, and recenter logic. Superseded by `scripts/sim-v9-v7hook.ts`.
>
> **Status (2026-03-07):** This doc covers two independent problems:
> 1. **General recentering** (§Recentering Design Space) — not yet implemented.
>    Option B (permissionless keeper) is the leading candidate.
> 2. **Debt-triggered auction** (§Debt-Triggered Dutch Auction) — simulated and
>    abandoned at current scale. See debt-management.md for full findings.

## Motivation

The pool's equilibrium price (`priceX/priceY`) is currently recentered by the offchain agent via `reconfigure()`. This works but has drawbacks:
- Agent downtime leaves the pool mispriced indefinitely
- Agent gas costs for frequent recenters
- Trust assumption on the agent operator

A pure onchain mechanism could slowly drift the equilibrium toward a TWAP reference, removing the agent from the critical path for price tracking.

## Why TWAP (Not slot0) for Recentering

**slot0 is correct for fee-setting** — the hook needs instantaneous mismatch to charge arbers fairly. Lag would systematically undercharge during the critical first seconds after a price move.

**TWAP is correct for recentering** — different requirements:

| Property | Fee-setting | Recentering |
|---|---|---|
| Speed | Must react instantly | Should move slowly |
| Manipulation resistance | Less critical (manipulation unprofitable) | Critical (could force bad recenter) |
| Lag | Destroys value | Provides smoothing |
| Frequency | Every swap | Gradual drift |

A manipulated slot0 recenter would let an attacker shift the pool's equilibrium to a bad price, extracting value on the way back. TWAP resists this because sustaining a price displacement across many blocks is economically ruinous — other arbers trade against the displaced price.

## Uniswap V3 TWAP Mechanics

The pool stores a ring buffer of `(timestamp, tickCumulative)` observations. A new observation is written on the first swap of each block.

```
twapTick = (tickCumulative_now − tickCumulative_T_ago) / T
price = 1.0001^twapTick
```

This is a geometric mean (time-weighted average of log-price), which is harder to manipulate than an arithmetic mean.

### USDC/WETH 0.05% Pool (0x88e6...5640)

| Property | Value |
|---|---|
| Observation cardinality | 723 |
| Average observation spacing | ~72 seconds |
| Max lookback | ~14.5 hours |
| Current liquidity (L) | ~1.45e19 |

### Manipulation Cost

To shift a T-second TWAP by D bps, the attacker must hold slot0 displaced for a significant fraction of the window:

| Target shift | 30s window (1 block hold) | 5-min window (1 block hold) |
|---|---|---|
| 5 bps | 196 WETH ($388k) | 2,033 WETH ($4.0M) |
| 10 bps | 408 WETH ($807k) | 4,053 WETH ($8.0M) |
| 50 bps | 2,033 WETH ($4.0M) | 19,767 WETH ($39.1M) |

Critically, holding the position exposes the attacker to arbers who will trade against the displaced price. Multi-block manipulation is economically impractical.

### Gas Cost

| Method | Cold | Warm |
|---|---|---|
| `slot0()` | ~4,800 | ~500 |
| `observe([0, T])` | ~28,000 | ~8,000 |

Extra cost is ~23k gas cold, ~7.5k warm. At 0.04 gwei this is <$0.01 per swap — negligible.

### TWAP Lag

A T-second window lags the true price by ~T/2 on average:

| Window | Avg lag | Expected drift (70% vol) |
|---|---|---|
| 30s | 15s | ~5 bps |
| 5 min | 150s | ~15 bps |
| 30 min | 15 min | ~38 bps |

For recentering, this lag is acceptable — we're not trying to track price instantly, just drift toward it.

## Recentering Design Space

### Option A: afterSwap Hook Drift

The `afterSwap` hook reads TWAP, computes the target equilibrium price, and nudges `priceX/priceY` a small step toward it on every swap.

```
twapPrice = observe([0, WINDOW])  // e.g. 5-minute TWAP
currentEq = priceX / priceY
drift = (twapPrice - currentEq) * driftRate  // e.g. driftRate = 0.01 per swap
newEq = currentEq + drift
reconfigure(newEq)
```

**Pros**: Recenters automatically, no agent needed, fires on every swap.
**Cons**: `afterSwap` must call `reconfigure()` — writes ~13 storage slots per swap (~60k gas overhead). CurveLib.verify constraint may reject the new curve if reserves are far from new equilibrium.

### Option B: Periodic Keeper Recenter

A permissionless `recenter()` function that anyone can call. Reads TWAP, computes new equilibrium, calls `reconfigure()`. Rate-limited (e.g., once per 5 minutes).

```solidity
function recenter() external {
    require(block.timestamp >= lastRecenter + COOLDOWN);
    uint256 twapPrice = _getTwapPrice(WINDOW);
    // compute new equilibrium from twapPrice
    // call pool.reconfigure(newParams, currentState)
    lastRecenter = block.timestamp;
}
```

**Pros**: Lower gas overhead (only when called, not every swap). Permissionless — anyone can trigger it. Clear rate limiting.
**Cons**: Requires someone to call it. MEV searchers would likely call it if there's economic incentive (the recenter creates a small arb opportunity).

### Option C: Hybrid — Agent Sets Target, Hook Drifts

Agent sets a target price (via `setTargetPrice()`). The hook drifts equilibrium toward the target on each swap. No TWAP oracle needed in the hook — the agent already has better price information.

```
// Agent (offchain, infrequent):
hook.setTargetPrice(newTarget)

// Hook (onchain, every swap):
drift toward targetPrice by driftRate per swap
```

**Pros**: Agent provides better price signal (can use multiple sources). Hook handles the gradual execution. Agent downtime doesn't immediately stop recentering — the last target is still being drifted toward.
**Cons**: Still requires agent for price updates. Adds storage + gas for drift logic.

## Key Constraints

### CurveLib.verify

After any `reconfigure()`, the new curve must pass through (or above) the current reserve point. When reserves have drifted far from equilibrium (large trades), a big recenter may be rejected. The drift rate must be conservative enough that the new curve always passes verification.

### Which TWAP Window?

| Window | Lag | Manipulation resistance | Use case |
|---|---|---|---|
| 30s | Low | Moderate | Fast tracking, higher manipulation risk |
| 5 min | Medium | High | Good balance for volatile pairs |
| 30 min | High | Very high | Stablecoin pairs where speed doesn't matter |

For USDC/WETH, 5 minutes seems reasonable — enough smoothing to resist manipulation, short enough to track meaningful price moves within a few recenters.

### Interaction with getFee

The fee hook (slot0-based) and the recentering mechanism (TWAP-based) are independent:
- Fee hook uses slot0 for instantaneous mismatch → charges arbers correctly
- Recentering uses TWAP for gradual equilibrium drift → keeps the pool centered

They complement each other: the fee hook protects against LVR in the short term, while recentering keeps the pool's equilibrium tracking the market in the medium term.

## Debt-Triggered Dutch Auction Recentering

### The Real Problem: Directional Exposure

Interest cost is secondary. The primary risk of reserve imbalance is **directional price exposure**. When the pool borrows ETH from a vault (because swaps depleted its ETH reserves), the pool is effectively short ETH. If ETH price moves sharply, the debt value changes and the pool's NAV takes a hit — even if the swap fees were captured correctly.

The ideal state for a USDC/WETH pool is: **USDC collateral only, no ETH debt, no ETH exposure**. In this state the pool is pure fee harvesting — delta-neutral, no price risk. Every dollar of ETH debt is a dollar of unwanted directional exposure.

### Mechanism

When debt in either asset crosses a threshold (e.g., 50% of NAV), the hook enters **auction mode**:

1. **Trigger**: `poolDebt / NAV > debtThreshold` (checked onchain via vault reads)
2. **Recenter off-market**: Shift equilibrium price away from TWAP in the direction that makes the depleted asset cheap. If the pool is short asset1 (has borrowed it), price the pool so asset1 is offered at a discount — arbers sell asset1 to the pool, repaying debt.
3. **Dutch auction**: The discount starts small (e.g., 1 bps below TWAP) and widens over time (e.g., +1 bps per block, or per N seconds) until an arber finds it profitable to execute.
4. **Exit**: Once debt < target level, snap equilibrium back to TWAP and resume normal slot0-based fee mode.

### Why Dutch Auction

A fixed discount risks overpaying (too generous) or underpaying (no one bites). The dutch auction discovers the minimum concession needed:

- Block 0: 1 bps discount → no taker (gas + Uni fee > 1 bps)
- Block 5: 6 bps discount → still no taker
- Block 12: 13 bps discount → arber executes, debt repaid

The pool paid exactly 13 bps to eliminate its directional exposure. Any fixed discount would either be too high (overpaying) or too low (debt persists).

### Fee Mode During Auction

During the auction, the normal captureRate should be suspended for the rebalancing direction — the pool is actively *inviting* that trade, not trying to tax it. Options:

- Set `captureRate = 0` for the rebalancing direction (fee = baseFee only)
- Or set `baseFee = 0` for the rebalancing direction (maximum incentive)
- Keep normal fees for the worsening direction (discourage trades that add more debt)

### Break-Even Analysis

The concession is rational when:

```
concession < expected loss from holding the exposure

Expected loss from ETH exposure:
  debtAmount × expectedPriceMove × duration

Example:
  10 ETH debt, 70% annualized vol, 1 day to next agent recenter
  Expected |move| ≈ 70% × √(1/365) ≈ 3.7%
  Expected loss ≈ 10 ETH × 3.7% = 0.37 ETH ≈ $730

  If dutch auction clears at 13 bps on a 10 ETH trade:
  Concession = 10 × 0.0013 × $2000 = $26

  $26 to eliminate $730 of expected exposure — clearly rational.
```

The math strongly favors paying to eliminate directional exposure, especially for volatile pairs.

### TWAP as the Anchor

The auction discount must be relative to TWAP, not slot0. If anchored to slot0, a searcher could:
1. Manipulate slot0 in the same tx (push Uni price to make the discount appear larger)
2. Execute the discounted arb against the recentered pool
3. Profit from both the manipulation and the discount

TWAP resists this because it can't be moved within a single transaction.

### Simulation Results (2026-03-07)

The dutch auction was fully simulated in `scripts/sim-recenter.ts` (removed, superseded by `scripts/sim-v9-v7hook.ts`)
with bidirectional support (WETH and USDC debt). Key finding:

**The auction's LP cost is quadratic in delta** (`x0 * delta² / 4`) because the
arber captures average price improvement (delta/2), not just the marginal edge.
Direct swap cost is linear (`debt * uniFee`). At current scale ($3k deposits,
~$16k debt per cycle), the auction costs 5-6x more than a direct swap on
Uni V3's deep USDC/WETH pool.

The break-even analysis above (§Break-Even Analysis) is correct that *paying*
to eliminate exposure is rational. But the mechanism matters: direct swap wins
at current scale because Uni V3 slippage is negligible for $16k trades. The
auction only becomes competitive when debt per cycle exceeds ~$200k (real
deposits ~$50k+) where Uni slippage adds material cost.

**Near-term decision:** Agent detects large debt → direct swap → recenter to
delta-neutral. The onchain dutch auction remains a viable fallback for agent
downtime resilience at larger scale. See [`docs/debt-management.md` §Simulation
Findings](../../docs/debt-management.md#simulation-findings-2026-03-07) for
full results.

### Open Questions

- ~~**Auction granularity**~~: Simulated at 1-minute steps with linear decay (2bps/min from 200bps start). Works but auction mechanism abandoned for near-term.
- ~~**Partial fills**~~: Simulation used progressive fills (multiple arbers at different fee levels). Each trade updates position, next arber sees reduced offset.
- ~~**Multi-asset debt**~~: Simulation picks larger debt (in USDC terms). Both directions validated.
- **CurveLib.verify**: The off-market recenter moves equilibrium away from current reserves. Need to verify the curve math allows this at the debt levels where the trigger fires. (Still open — not tested onchain.)
- **Interaction with agent**: When the agent is online, it can recenter faster and more precisely. The onchain auction is the fallback — it should defer to agent recenters if they're happening.
- **Revisit at scale**: If real deposits reach $50k+, re-evaluate the dutch auction vs direct swap tradeoff. The quadratic/linear crossover depends on Uni V3 liquidity depth at the time.
