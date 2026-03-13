# LPAgentHookV3 — Audit & Simulation Findings

> **Contract:** `contracts/src/LPAgentHookV3.sol`
> **Tests:** `contracts/test/LPAgentHookV3.t.sol` (44 tests passing)
> **Simulation:** `scripts/sim-v3-rebalance.ts`

## Critical Bug Found & Fixed

### Clearing condition used trigger-time eq (not pre-drift eq)

The original `_checkAuctionClear` compared reserves against
`dp.equilibriumReserve` — which `_triggerAuction` had just overwritten to
the current reserves. Every auction cleared on the first arb swap with zero
exposure reversal.

**Fix:** Added `preAuctionEq0` / `preAuctionEq1` storage variables. Trigger
saves original eq before overwriting; clearing compares against the saved
values:

```solidity
// _triggerAuction:
preAuctionEq0 = dp.equilibriumReserve0;  // save neutral eq
preAuctionEq1 = dp.equilibriumReserve1;
dp.equilibriumReserve0 = reserve0;        // then overwrite

// _checkAuctionClear:
cleared = reserve0 >= preAuctionEq0;      // compare against saved
```

## Simulation vs Contract Discrepancies (Fixed)

### 1. Clearing condition (MAJOR — fixed)

| | Before | After |
|---|---|---|
| Contract | `reserve >= preAuctionEq` | (unchanged) |
| Simulation | `vault.yr < 1e-6` (vault net position) | `absoluteX >= origEq0` (matches contract) |

### 2. Reserve tracking during auction (MAJOR — fixed)

The simulation now tracks absolute reserves including fee accumulation,
matching what the contract's `afterSwap` callback receives:

```typescript
absoluteX += totalUsdcIn;  // full input including fees
absoluteY -= dyOut;
if (absoluteX >= origEq0) { cleared = true; break; }
```

### 3. Fee decay granularity (MINOR — accepted)

- Contract: decays per second, continuous
- Simulation: decays per minute, one trade per minute
- Impact: negligible for the questions being tested

## Dynamic Delta Analysis

### Motivation

With fixed 100bps delta, the arb capacity is ~`eq * delta/2`. For large
exposures (>1% of eq), the auction stalls — it partially clears but can't
reach preAuctionEq within the fee decay window.

### Formula tested

Exact minimum delta for arb to reach preAuctionEq:

```
delta_min = (eq / reserve)^2 - 1 ≈ 2 * deficit_ratio  (for small deficit)
```

With safety factor to compensate for fee overhead:

```
delta = (eq/reserve)^2 - 1) * safetyFactor
```

### Results (60% vol, 30 days, seed=42)

| Strategy | Final NAV | Auctions | Cost | Cleared | Avg Exp |
|----------|-----------|----------|------|---------|---------|
| Dynamic delta (2.0x) | $1,539 (-57%) | 367 | $1,381 | 367/367 | 61% |
| Fixed 100bps | $5,597 (+55%) | 366 | $907 | 310/366 | 59% |

### Why dynamic delta is worse

The smoking gun — Day 0.4 at 261% NAV exposure:

- **Fixed 100bps**: 48 trades, cost $3.33, STALLED at exp_after=$3,350.
  Partial clearing, cheap, stable.
- **Dynamic 500bps**: 1 trade, cost $222.76, CLEARED but exp_after=$6,377.
  Massive overshoot creates opposite exposure → cascade of follow-up auctions.

**Root cause:** With large delta, the arber maximizes profit by trading
to the no-arb point (marginal = market). This overshoots the clearing target.
The excess flow creates opposite-direction exposure that triggers the next
auction. Each iteration amplifies costs.

### Why stalls are a feature

Fixed delta stalls provide natural damping:

1. **Partial clearing at low cost** — $3-5 per stalled auction reduces
   exposure significantly (e.g., $8,897 → $3,350)
2. **No cascade** — residual exposure resolves when price reverts, or is
   absorbed on next recenter
3. **Pool remains functional** — normal swaps continue with auction-mode fees

## Conclusion

**Keep fixed delta at 100bps.** Dynamic delta doesn't improve outcomes —
it trades stalls (benign) for overshoots (costly cascades). The fixed delta
auction mechanism is well-calibrated: 100bps provides enough arb incentive
with controlled trade sizes, and the fee decay from 200→0 bps paces the
clearing over ~50 minutes.

The 15% stall rate at 60% vol is acceptable — stalled auctions still clear
most of the exposure, and the remaining amount is small relative to eq.

## Test Coverage

44 tests covering:
- Mode 2 dynamic fees (mismatch-based, gas threshold scaling)
- Exposure-based trigger (both directions, asset0-terms conversion)
- Auction clearing (must reach original eq, not trigger-time eq)
- Restore behavior (BOUNDARY_FACTOR minReserves, priceY restoration)
- Owner management (setFeeParams, setAuctionParams, clearAuction)
- Edge cases (nav=0, triggerBps=0, oracle failure)
