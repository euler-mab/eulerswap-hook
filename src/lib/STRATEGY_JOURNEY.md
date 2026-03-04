# EulerSwap Trading Strategy Hypothesis Tests — Journey

## Motivation

EulerSwap is a concentrated-liquidity AMM integrated with a lending market. The pool's math involves curves, boost (concentration + leverage), health scoring, and NAV computation across multiple phases. While existing tests verify algebraic correctness (curves, derivatives, round-trips, health at boundary), they don't explore the *economic* properties that matter for trading strategies.

This document narrates the process of formulating and testing 9 hypotheses about EulerSwap's trading strategy implications.

---

## The AMM in 30 seconds

- Two assets X and Y with oracle prices px, py
- Virtual reserves x0, y0 amplified beyond real deposits xr, yr via **concentration boost** (bXC) and **leverage boost** (bXL)
- The curve `fX(x)` governs the X side (x ≤ x0), `gY(y)` governs the Y side (y ≤ y0)
- Concentration parameter cx ∈ [0, 1) interpolates between constant-product (cx=0, `xy=k`) and constant-sum (cx→1, `x+y=k`)
- Range parameters rx, ry set how far price can deviate from equilibrium before hitting the boundary
- At boundary, health = 1 (by boost calibration). Beyond → liquidation.

---

## Hypotheses and Results

### H1: NAV is always positive (no-debt case) ✅ PASSED

**Hypothesis**: With no initial debt (xd=yd=zd=0), the LP's NAV should be strictly positive at every point within the range.

**Reasoning**: The LP deposited real assets. Even though the pool uses virtual reserves via concentration boost, the LP should never owe more than they have when there's no external debt. CXX ≥ 0 and CXY > 0 (Y received from swaps), so NAV = CXX + CXY·pXyx > 0 trivially.

**Result**: Confirmed across 500 random params on both X and Y sides.

### H2: Impermanent loss is always non-positive ✅ PASSED

**Hypothesis**: NAV_X(x) ≤ xr + yr·pXyx(x) for all x — the LP always loses vs holding.

**Reasoning**: The AMM sells the appreciating asset and buys the depreciating one. Each swap is at market price, but the accumulation at deteriorating prices leads to a loss vs holding. For constant-product (c=0, px=py, x0=y0):

```
IL = -(x0 - x)² / x0 < 0
```

This generalizes to all concentration values.

**Result**: Confirmed. Also verified IL = 0 at equilibrium (no price movement = no IL).

### H3: IL increases monotonically toward boundary ✅ PASSED

**Hypothesis**: As price moves further from equilibrium, IL strictly increases (becomes more negative).

**Reasoning**: Each additional swap at an increasingly unfavorable price makes the situation worse. The LP is always selling the rising asset cheaper and buying the falling asset dearer.

**Result**: Confirmed on both X and Y sides.

### H4: Higher concentration → more IL at same price deviation ✅ PASSED (after correction)

**Hypothesis**: Higher cx means more IL at the same % price deviation.

**Initial attempt**: Compared IL at the same x-space "frac" (fraction of the x0-to-xb range consumed). This **FAILED** on the first run.

**Discovery**: At the same x-space frac, higher cx maps to a price CLOSER to equilibrium, not the same price. This is because high-cx curves are flatter near equilibrium — the same frac represents less price deviation. So comparing at the same frac was comparing apples to oranges.

Concrete numbers (rx=0.05, xr=yr=1, px=py=0.1):

| cx   | x0      | Price at frac=0.1 | IL at frac=0.1  |
|------|---------|-------------------|-----------------|
| 0.05 | 71.80   | 1.004829          | -0.000437       |
| 0.20 | 60.89   | 1.004799          | -0.000435       |

The prices are almost the same but the ILs are slightly reversed — cx=0.20 has *less* IL because it's at a slightly lower price.

**Fix**: Compare at the same *price deviation* d, where d is the marginal price ratio minus 1. Given `pXxy = (px/py)(1+d)`, the x position is:

```
x = x0 / sqrt((1+d-cx)/(1-cx))
```

At the same price, higher cx → more IL. At the boundary (d=rx, same price for all cx), the effect is clearest:

| cx   | IL/hold at boundary |
|------|---------------------|
| 0.05 | -2.24%              |
| 0.20 | -2.25%              |
| 0.50 | -2.26%              |
| 0.80 | -2.33%              |

**Analytical proof**: At boundary, IL = xr · (PX/(1+rx) - 1) where PX = cx + (1-cx)·sx. Since PX/(1+rx) is strictly decreasing in cx, IL becomes more negative.

**Result**: Confirmed after correcting the comparison metric.

### H5: Curve is convex (price impact is superlinear) ✅ PASSED

**Hypothesis**: f''X(x) > 0 everywhere — price impact increases with trade size.

**Analytical derivation**:
```
f''X(x) = 2(px/py)(1-cx)(x0²/x³) > 0
```
for all valid x and cx < 1.

**Trading implication**: The second half of a swap is always more expensive (per unit) than the first half. A trader buying X faces progressively worse prices. This is what makes the AMM work — it automatically charges more for larger trades.

**Result**: Confirmed via numerical second derivatives and also via a direct "trade splitting" test showing the second half always costs more per unit.

### H6: Leverage amplifies IL ✅ PASSED

**Hypothesis**: A leveraged LP (with Y debt) has more IL than an unleveraged LP at the same fractional position.

**Reasoning**: Leverage increases x0 beyond xr·bXC. More virtual reserves means more tokens change hands per unit price movement. The LP's exposure is amplified.

**Result**: Confirmed. A pool with Y debt of 10-70% of yr consistently shows more IL.

### H7: Symmetric pools have symmetric IL ✅ PASSED

**Hypothesis**: When cx=cy, rx=ry, px=py, xr=yr, the fractional IL at the X boundary equals the fractional IL at the Y boundary.

**Result**: Confirmed within 5% relative error (limited by the different numeraire conventions).

### H8: NAV at boundary with leverage ✅ PASSED (after correction)

**Hypothesis**: At the X boundary, in the H_XX phase: NAV = DXX · (1/vyx - 1).

**Initial attempt**: Evaluated 0.1% inside boundary and compared with the formula. **FAILED** because health at 0.1% inside is ~1.01, not exactly 1.0.

**Discovery**: The formula NAV = DXX · (1/vyx - 1) only holds when H = 1 exactly (the boundary). Slightly inside: H > 1, and the correct formula is:

```
NAV = DXX · (H/vyx - 1)
```

Derivation: In H_XX phase, CXX = 0, DXY = 0.
- H_XX = vyx · CXY · pXyx / DXX
- NAV = CXY · pXyx - DXX = (H·DXX/vyx) - DXX = DXX · (H/vyx - 1)

At H=1: NAV = DXX · (1/vyx - 1) > 0 since vyx < 1. The LP always retains positive value because the LLTV creates a safety buffer.

**Trading implication**: Even at maximum adverse price movement, the LP's position is worth DXX · (1/vyx - 1). For vyx = 0.9, that's ~11% of the debt amount. The LLTV acts as a floor on the LP's loss.

**Result**: Confirmed using the corrected formula with measured H values.

### H9: Constant-product IL formula ✅ PASSED

**Hypothesis**: For c=0 (constant-product) with px=py and symmetric reserves:

```
IL_X(x) = -(x0 - x)² / x0
```

This is the classic AMM impermanent loss formula.

**Result**: Confirmed within 1% relative error across 500 random params.

---

## Key Insights for LP Strategies

1. **IL is unavoidable**: Every AMM LP loses vs holding. The profit must come from fees, not from the curve itself.

2. **Concentration is a tradeoff**: Higher cx gives more capital efficiency (better for fee capture) but more IL at the same price deviation. Choose based on expected price volatility and fee income.

3. **Leverage amplifies everything**: More fees AND more IL. Only profitable if fee income exceeds the amplified IL.

4. **The LLTV floor**: Even at worst case (boundary), the LP retains NAV = Debt × (1/LLTV - 1). This is the minimum recovery value.

5. **Price impact protects LPs**: The convexity of the curve means large trades pay disproportionately more. This is automatic protection against informed traders (who typically want large positions).

6. **The x-space vs price-space distinction matters**: Same % of x-range consumed ≠ same % price deviation. Higher cx "compresses" the price range near equilibrium. When comparing strategies, always use price-space metrics.

---

## Test file

All tests are in `src/lib/math.strategy.test.ts` (17 tests, ~650 lines). They use fast-check property-based testing with 500 random params per test.
