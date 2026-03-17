# Displacement Mechanism: Strategy-Agnostic Auction Trigger

A standalone specification for measuring portfolio displacement from a target
composition. This mechanism drives the auction system but depends on nothing
else in the hook — no fee logic, no surcharge, no oracle-reactive pricing. It
can be implemented and tested in isolation.

---

## 1. The Setup

A pool holds positions in two assets (asset0 and asset1). At any point in time,
the pool's vault state is:

```
deposits_0, debts_0    (in asset0 units)
deposits_1, debts_1    (in asset1 units)
```

The **net position** in each asset:

```
position_i = deposits_i − debts_i    (in asset_i units)
```

Positive = net long (deposits exceed debts). Negative = net short (debts exceed
deposits). Zero = no net holding.

To express positions in a common unit, we need a **price** `P` = value of asset1
in asset0 terms (e.g., 2000 USDC per WETH). Then:

```
value_0 = position_0                 (in asset0 units)
value_1 = position_1 × P            (in asset0 units)
NAV     = value_0 + value_1         (total equity, in asset0 units)
```

NAV is oracle-dependent for non-stablecoin pairs. For stablecoins where P ≈ 1,
NAV ≈ position_0 + position_1 in native units.

---

## 2. Target Composition

The LP specifies a **target weight vector** `[w_0, w_1]` at deploy time. The
weights define what fraction of current NAV should be held in each asset:

```
target_value_0 = w_0 × NAV          (in asset0 units)
target_value_1 = w_1 × NAV          (in asset0 units)
target_position_1 = target_value_1 / P    (in asset1 units)
```

The weights satisfy `w_0 + w_1 = 1` for unleveraged strategies. For leveraged
strategies, `w_0 + w_1 > 1` (long side > NAV, short side < 0).

Examples:

| Strategy | w_0 | w_1 | Constraint |
|----------|-----|-----|------------|
| 100% asset0 (delta-neutral) | 1.0 | 0.0 | Unleveraged |
| 100% asset1 (delta-neutral) | 0.0 | 1.0 | Unleveraged |
| 50:50 balanced | 0.5 | 0.5 | Unleveraged |
| 2x long asset1 | −1.0 | 2.0 | w_0 + w_1 = 1, leveraged |
| 3x long asset0 | 3.0 | −2.0 | w_0 + w_1 = 1, leveraged |

Note: for leveraged strategies, `w_0 + w_1 = 1` still holds (equity sums to
NAV), but individual weights can be negative (short positions via borrowing).

---

## 3. Displacement

**Displacement** is the signed difference between actual and target value, per
asset:

```
displacement_i = value_i − (w_i × NAV)    (in asset0 units)
```

Properties:

- **Signed**: positive = over-target (too much of asset i), negative =
  under-target (too little).
- **Zero-sum**: `displacement_0 + displacement_1 = 0` always. This follows
  from `value_0 + value_1 = NAV` and `w_0 + w_1 = 1`. Over-allocation in one
  asset implies equal under-allocation in the other.
- **NAV-relative**: scales with current NAV. A pool that doubles in value has
  double the absolute displacement for the same percentage deviation.
- **Oracle-dependent**: for non-stablecoin pairs, `value_1 = position_1 × P`
  requires a price. Displacement inherits the oracle's trust assumptions.

Because displacements are zero-sum, a single scalar captures the full state:

```
D = displacement_0 = −displacement_1
```

When `D > 0`: too much asset0, too little asset1. Clearing direction: sell
asset0, buy asset1.

When `D < 0`: too much asset1, too little asset0. Clearing direction: sell
asset1, buy asset0.

**Relative displacement**:

```
d = |D| / NAV
```

A dimensionless fraction of equity. This is what the trigger threshold
compares against.

---

## 4. Worked Examples

### Example 1: Delta-neutral, 100% USDC (USDC/WETH pool)

**Setup**: asset0 = USDC, asset1 = WETH, P = 2000 USDC/WETH.
Target weights: `[1.0, 0.0]`.

**Initial state** (at target):
```
deposits_0 = 1000 USDC,  debts_0 = 0
deposits_1 = 0 WETH,     debts_1 = 0
NAV = 1000 + 0 = $1000
```

Displacement: `D = 1000 − (1.0 × 1000) = 0`. At target.

**After swaps push pool off-target** (acquired WETH exposure):
```
deposits_0 = 600 USDC,   debts_0 = 0
deposits_1 = 0.2 WETH,   debts_1 = 0
NAV = 600 + 0.2 × 2000 = $1000
```

Displacement: `D = 600 − (1.0 × 1000) = −$400`.

Negative D means under-target in asset0, over-target in asset1. Clearing
direction: sell WETH (asset1), buy USDC (asset0). Clearing amount: $400.

Relative: `d = 400/1000 = 40%`.

**After WETH price rises to $2500**:
```
deposits_0 = 600 USDC,   debts_0 = 0
deposits_1 = 0.2 WETH,   debts_1 = 0
NAV = 600 + 0.2 × 2500 = $1100
```

Displacement: `D = 600 − (1.0 × 1100) = −$500`.

The displacement grew from $400 to $500 — not because vault positions changed,
but because the NAV increased (the WETH is worth more, so the target amount of
USDC is higher). The target tracks NAV.

Relative: `d = 500/1100 = 45.5%`.

### Example 2: 2x Long WETH (USDC/WETH pool)

**Setup**: asset0 = USDC, asset1 = WETH, P = 2000 USDC/WETH.
Target weights: `[−1.0, 2.0]`.

**At target**:
```
deposits_0 = 0 USDC,     debts_0 = 1000 USDC
deposits_1 = 1.0 WETH,   debts_1 = 0
value_0 = 0 − 1000 = −$1000
value_1 = 1.0 × 2000 = $2000
NAV = −1000 + 2000 = $1000
```

Target check:
- `w_0 × NAV = −1.0 × 1000 = −$1000` ✓ (value_0 = −$1000)
- `w_1 × NAV = 2.0 × 1000 = $2000` ✓ (value_1 = $2000)
- Displacement: `D = −1000 − (−1000) = 0`. At target.

**WETH price rises 10% to $2200**:
```
deposits_0 = 0 USDC,     debts_0 = 1000 USDC  (debt unchanged)
deposits_1 = 1.0 WETH,   debts_1 = 0
value_0 = −$1000
value_1 = 1.0 × 2200 = $2200
NAV = −1000 + 2200 = $1200
```

Target at new NAV:
- `w_0 × NAV = −1.0 × 1200 = −$1200` (should have $1200 USDC debt)
- `w_1 × NAV = 2.0 × 1200 = $2400` (should have $2400 WETH)

Displacement: `D = −1000 − (−1200) = +$200`.

Positive D means over-target in asset0 (not enough debt — only $1000 vs target
$1200). Clearing direction: sell USDC (asset0), buy WETH (asset1). In practice:
borrow $200 more USDC, use it to buy 0.091 WETH at $2200.

After clearing:
```
debts_0 = 1200 USDC,  deposits_1 ≈ 1.091 WETH
value_0 = −$1200, value_1 = 1.091 × 2200 = $2400
NAV = $1200
```

Displacement: `D = −1200 − (−1200) = 0`. Back at target.

Relative pre-clearing: `d = 200/1200 = 16.7%`.

**WETH price drops 10% to $1800**:
```
deposits_0 = 0 USDC,     debts_0 = 1000 USDC
deposits_1 = 1.0 WETH,   debts_1 = 0
value_0 = −$1000
value_1 = 1.0 × 1800 = $1800
NAV = −1000 + 1800 = $800
```

Target at new NAV:
- `w_0 × NAV = −1.0 × 800 = −$800`
- `w_1 × NAV = 2.0 × 800 = $1600`

Displacement: `D = −1000 − (−800) = −$200`.

Negative D means under-target in asset0 (too much debt — $1000 vs target $800).
Clearing direction: sell WETH (asset1), buy USDC (asset0) to repay $200 debt.

Relative: `d = 200/800 = 25%`.

**Key insight**: For a leveraged long strategy, price going up creates
displacement that requires buying *more* of the long asset (increasing leverage
to maintain the target ratio). Price going down requires selling the long asset
(deleveraging). This is the classic "buy high, sell low" of leveraged
rebalancing — the variance drain.

### Example 3: 50:50 Balanced (ETH/BTC pool)

**Setup**: asset0 = ETH, asset1 = BTC, P = 20 ETH/BTC.
Target weights: `[0.5, 0.5]`.

**At target**:
```
deposits_0 = 5 ETH,      debts_0 = 0
deposits_1 = 0.25 BTC,   debts_1 = 0
value_0 = 5 ETH = $500 (in ETH terms)
value_1 = 0.25 × 20 = 5 ETH = $500
NAV = 10 ETH = $1000
```

Displacement: `D = 500 − (0.5 × 1000) = 0`. At target.

**BTC rises 10% relative to ETH** (P = 22 ETH/BTC):
```
deposits_0 = 5 ETH,      debts_0 = 0
deposits_1 = 0.25 BTC,   debts_1 = 0
value_0 = 5 ETH
value_1 = 0.25 × 22 = 5.5 ETH
NAV = 10.5 ETH
```

Target:
- `w_0 × NAV = 0.5 × 10.5 = 5.25 ETH`
- `w_1 × NAV = 0.5 × 10.5 = 5.25 ETH`

Displacement: `D = 5.0 − 5.25 = −0.25 ETH` (= −$25).

Under-target in asset0 (ETH), over-target in asset1 (BTC). Clearing: sell BTC,
buy ETH. This is the classic rebalancing that sells the winner and buys the
loser to maintain 50:50.

Relative: `d = 0.25/10.5 = 2.4%`.

### Example 4: 100% sDAI (sDAI/USDC pool)

**Setup**: asset0 = sDAI, asset1 = USDC, P = 1.0 USDC/sDAI.
Target weights: `[1.0, 0.0]`.

**At target**:
```
deposits_0 = 1000 sDAI,  debts_0 = 0
deposits_1 = 0 USDC,     debts_1 = 0
NAV = $1000
```

This is structurally identical to Example 1 — the "100% in asset0" strategy.
The fact that asset0 happens to be the yield-bearing asset (sDAI) rather than
a stablecoin is a strategy choice, not a mechanism difference. The displacement
formula doesn't care *why* the LP chose this target.

**After swaps push pool off-target**:
```
deposits_0 = 800 sDAI,   debts_0 = 0
deposits_1 = 200 USDC,   debts_1 = 0
NAV = $1000
```

Displacement: `D = 800 − (1.0 × 1000) = −$200`.

Clearing: sell USDC, buy sDAI. Amount: $200.

---

## 5. Trigger: From Displacement to Reserve Coordinates

### 5a. Why reserves, not vault reads

The auction trigger runs in `afterSwap` on every swap. It must be cheap.
Reading vault state (deposits, debts) on every swap is too expensive. But
current reserves are free — they are passed to `afterSwap` directly.

The key insight: **on an AMM, the only way the pool's state changes is through
swaps, and swaps change reserves.** There is no scenario where displacement
changes but reserves don't (ignoring interest — see §5f). If the external
market price moves but nobody trades the pool, reserves haven't moved, vault
positions haven't changed, and displacement hasn't changed. When an arb finally
corrects the pool price, the reserves move, and at that new reserve position
the marginal price, vault position deltas, and displacement are all
deterministic functions of the curve.

This means "price changes between snapshots" is not a separate concern from
"reserve changes between snapshots." They are the same thing, linked by the
curve equation. The trigger can operate entirely on reserve coordinates.

### 5b. The trigger is strategy-agnostic: reserve distance from equilibrium

The trigger itself is simple and **does not know about the strategy**. It asks:
"have reserves moved far enough from equilibrium that it's worth checking?"

At snapshot time (after a recenter, where eq = current reserves), the hook
precomputes two trigger coordinates — one per side of the curve:

```
trigger_0: a reserve_0 value below eq_0 (X branch, price above equilibrium)
trigger_1: a reserve_1 value below eq_1 (Y branch, price below equilibrium)
```

In `afterSwap`, the check is:

```
if reserve_0 < trigger_0  →  trigger fires (X branch)
if reserve_1 < trigger_1  →  trigger fires (Y branch)
```

Two `uint256` comparisons. No oracle, no vault read, no strategy logic.

The trigger coordinates are computed from the **marginal price** that
corresponds to "enough displacement." On the EulerSwap curve, the marginal
price is a function of the reserve position on each branch:

**X branch** (reserve_0 ≤ eq_0, price above equilibrium):
```
price = (px/py) × [cx + (1−cx) × (eq_0/reserve_0)²]
```

**Y branch** (reserve_1 ≤ eq_1, price below equilibrium):
```
price = (px/py) / [cy + (1−cy) × (eq_1/reserve_1)²]
```

Both have closed-form inverses — given a target marginal price, solve for the
reserve coordinate:

**X branch** (solve for reserve_0 given target price p):
```
reserve_0 = eq_0 / √((p × py/px − cx) / (1−cx))
```

**Y branch** (solve for reserve_1 given target price p):
```
reserve_1 = eq_1 / √((px/(py × p) − cy) / (1−cy))
```

Both use the forward direction (`y = f(x)` form) — no expensive inverse
function needed. These formulas are already implemented and tested in
`src/lib/simulate.ts` as `solveXForPrice` and `solveYForPrice`.

**Two coordinates rather than one** because the curve has two branches and
`y = f(x)` is cheaper than `x = f⁻¹(y)`. Each trigger coordinate is computed
using the forward solve for its respective branch.

### 5c. From trigger to action: strategy enters at auction start

The trigger fires based on reserve geometry alone. It doesn't know or care
about the strategy. What happens *after* the trigger fires is where the
strategy enters:

1. **Oracle guard** (§5d): validate that the marginal price divergence is
   confirmed by an external oracle — not a manipulation.
2. **Vault read**: read true vault state (deposits, debts for both assets).
3. **Displacement computation** (§3): compute exact `D` using the weight
   vector, vault positions, and oracle price.
4. **Clearing amount and direction** (§6): derive from `D`.
5. **Auction reconfiguration**: constant-sum with appropriate min reserves.

If the displacement turns out to be small (the trigger was a false positive —
possible if the strategy-level displacement doesn't align with the raw reserve
displacement), the hook just takes a fresh snapshot and returns to normal mode.
The cost of a false positive is one vault read — bounded by trigger frequency.

This separation means:
- **Trigger module**: knows curves and reserves. Knows nothing about strategies.
- **Displacement module**: knows weights, NAV, vault positions. Knows nothing
  about curves.
- **Auction module**: uses displacement output to set clearing params.

Each can be tested independently.

### 5d. Oracle guard at trigger time

The reserve-based trigger tells us the pool's marginal price has moved past
the threshold. But it doesn't tell us whether the *external market* has also
moved — maybe the pool was manipulated, or maybe the pool is just stale and
an arb moved it to the correct external price. The trigger should only fire
when the displacement is "real" — reflecting a genuine divergence of the pool
from target, not just a price correction.

When the trigger fires, the hook reads the **external oracle** and compares
it to the pool's marginal price (which is known from the reserve position):

```
guard_threshold = g × D × √(blocks_since_snapshot)
```

where `D ≈ σ₁` (per-block volatility), `g` is a confidence multiplier (e.g.,
3 for ~99.7%), and `√(blocks)` accounts for expected random-walk drift.

- **If `|marginal − oracle| > guard_threshold`**: the pool's price and the
  external market have diverged beyond what normal drift explains. The
  auction is **aborted** — instead, the hook takes a fresh snapshot (full
  vault read, recompute trigger coordinates from current state) and returns
  to normal mode. The next swap re-evaluates against fresh coordinates.

- **If prices agree within the threshold**: the displacement is confirmed as
  real. The auction proceeds.

The oracle guard is the *only* place an external oracle is used in the trigger
path. It fires rarely (only when reserve coordinates are crossed) and serves
as a validation gate, not a measurement input. The trigger decision itself is
entirely endogenous — derived from the pool's own curve.

### 5e. Calibrating the trigger fraction

The trigger fraction (e.g., "20% from equilibrium") is a deploy-time
parameter. It controls how much reserve displacement the pool tolerates before
checking whether an auction is needed.

At snapshot time, the hook computes the trigger coordinates from the fraction:

```
trigger_price_high = eq_price × (1 + triggerFraction)
trigger_price_low  = eq_price × (1 − triggerFraction)

trigger_0 = solveXForPrice(trigger_price_high, ...)
trigger_1 = solveYForPrice(trigger_price_low, ...)
```

The fraction is strategy-agnostic — it just says "how far can the pool move
before we check." The strategy enters only at auction start (§5c), where the
true displacement is computed and may turn out to be small (false positive)
or large (real auction needed).

Calibrating the fraction involves a trade-off:
- **Too tight** (small fraction): triggers frequently, many vault reads, but
  catches displacement early.
- **Too loose** (large fraction): triggers rarely, fewer vault reads, but
  allows displacement to grow before detection.

Natural reverting flow still reduces displacement in the vault between
auctions — the vault doesn't need a recenter to benefit from helpful flow.
The auction handles the cases where net flow is persistently directional.

### 5f. No continuous recentering (for c = 0 curves)

V7 recentered on every displacement-reducing swap: setting eq = current
reserves, updating priceY to oracle, recomputing min reserves. V8 drops this
for c = 0 curves. The reasons:

1. **Gas cost is real.** Each `reconfigure()` call costs gas borne by the
   swapper, making the pool less competitive on routing. V7 made 103
   reconfigure calls in 4 days for continuous recentering alone.

2. **Price tracking is redundant.** On a c = 0 curve, the marginal price
   already reflects the market via reserve displacement — arbs push it there.
   Setting `px/py = oracle` just makes the curve parameter match what the
   marginal price already was. The oracle-reactive fee handles ongoing price
   tracking in `getFee` (a view function, no state change, no gas).

3. **Range centering is handled by the trigger.** The trigger fires before
   reserves hit the min reserve boundary. The auction clears and recenters.
   No need to recenter incrementally.

4. **Vault still benefits from helpful flow.** Reverting swaps reduce vault
   displacement regardless of whether eq is updated. The vault state improves
   for free from natural flow. The next auction just has less to clear.

The hot path is therefore **fully strategy-agnostic**: two uint256
comparisons, no position tracking, no price computation, no reconfigure
calls. Strategy logic only enters at auction start.

**Note**: for c > 0 curves, continuous recentering may be worth revisiting.
Concentration changes the curve shape significantly with displacement, and
recentering provides real liquidity benefits beyond price tracking. This is
a future exploration, not part of the core V8 mechanism.

### 5g. Sources of drift between snapshots

Two effects cause the reserve-based trigger to drift from the true displacement
between snapshots:

**Fee-induced drift.** When `feeRecipient == address(0)`, fees are deposited
into the vault but excluded from reserves. Vault positions grow faster than
reserve displacement predicts. The reserve-based trigger understates the true
displacement by the accumulated fees since the last snapshot — a systematic
bias that makes the trigger fire slightly late. For pools with an external fee
recipient (the common production case), vault and reserve deltas match exactly
and there is no drift.

**Interest-induced drift.** Vault interest (supply APY, borrow APY) changes
positions without moving reserves. An idle pool accumulating interest-driven
displacement will never cross the reserve-coordinate trigger, because reserves
haven't moved. For active pools where swap-driven displacement dominates, this
is negligible. For idle pools, a separate **time-based trigger** forces a
periodic snapshot (see walkthrough §4b), which resets the baseline and
recomputes trigger coordinates from the true vault state.

---

## 6. Clearing Amount and Direction

When the trigger fires, the hook reads the true vault state and computes the
exact displacement:

```
D_true = value_0 − (w_0 × NAV)
```

The clearing trade must move `|D_true|` worth of value from the over-allocated
asset to the under-allocated asset:

```
if D_true > 0:
    // Over-target in asset0. Sell asset0, buy asset1.
    clearing_direction = asset0_in, asset1_out
    clearing_amount_0 = D_true                     (in asset0 units)
    clearing_amount_1 = D_true / P                 (in asset1 units)

if D_true < 0:
    // Over-target in asset1. Sell asset1, buy asset0.
    clearing_direction = asset1_in, asset0_out
    clearing_amount_0 = |D_true|                   (in asset0 units)
    clearing_amount_1 = |D_true| / P               (in asset1 units)
```

The clearing amount is the **output** side of the swap — how much of the
over-allocated asset to drain. The input side is determined by the swap
mechanics (constant-sum pricing + fee).

### Wrong-direction blocking

During auction, the pool is reconfigured to constant-sum with min reserves
that block the wrong direction:

```
if clearing is asset0_in → asset1_out:
    minReserve_0 = reserve_0    // lock: no asset0 output
    minReserve_1 = reserve_1 − clearing_amount_1

if clearing is asset1_in → asset0_out:
    minReserve_0 = reserve_0 − clearing_amount_0
    minReserve_1 = reserve_1    // lock: no asset1 output
```

### Partial fill tracking

On constant-sum, the cleared fraction is directly observable:

```
cleared = (eq_out − reserve_out) / (eq_out − minReserve_out)
```

No separate counter needed.

---

## 7. Properties That Must Hold

These are the invariants the test suite must verify:

### 7a. Zero-sum

```
displacement_0 + displacement_1 = 0    (always, for any weights)
```

This follows from the definition. It must hold for all examples, all weight
vectors, all vault states.

### 7b. At-target detection

```
displacement = 0  ⟺  value_i = w_i × NAV for all i
```

If displacement is zero, the portfolio is at target. If the portfolio is at
target, displacement is zero.

### 7c. Sign determines direction

```
D > 0  →  clearing is asset0_in, asset1_out
D < 0  →  clearing is asset1_in, asset0_out
D = 0  →  no clearing needed
```

### 7d. NAV invariance under clearing

A perfect clearing trade (ignoring fees and curve spread) should:
- Move displacement to zero
- Leave NAV unchanged

```
post_clearing_D = 0
post_clearing_NAV = pre_clearing_NAV
```

In practice, fees and curve spread cause small deviations. Constant-sum
clearing has zero curve spread, so NAV change = fees only.

### 7e. Displacement scales with NAV

In the abstract formula, if NAV changes (e.g., because asset1 price changes)
while positions stay fixed:

```
new_D = value_0 − w_0 × new_NAV
```

The displacement changes even though no trade occurred.

However, **on an AMM, this scenario doesn't happen in isolation.** The pool's
marginal price only changes through swaps, which change reserves. If the
external market moves, the pool's positions don't change until someone arbs it.
When the arb trade happens, it moves reserves (triggering the check) and
simultaneously updates the marginal price and vault positions. The trigger
coordinates, which encode the displacement threshold as reserve positions,
capture this combined effect — the reserve movement from the arb trade is
exactly what the trigger detects.

### 7f. Weight symmetry

The formula makes no assumption about which asset is 0 or 1. Swapping the
asset ordering (relabeling asset0 ↔ asset1) and swapping the weights
(`w_0 ↔ w_1`) must produce the same displacement magnitude with opposite sign:

```
D(w_0, w_1, value_0, value_1) = −D(w_1, w_0, value_1, value_0)
```

### 7g. Trigger coordinates match displacement threshold at snapshot time

At the moment trigger coordinates are computed (snapshot time), the reserve
position that crosses a trigger coordinate must correspond to exactly the
displacement threshold:

```
displacement_at(trigger_0_reserve) = threshold × NAV    (positive direction)
displacement_at(trigger_1_reserve) = threshold × NAV    (negative direction)
```

where `displacement_at(reserve)` uses the curve's marginal price at that
reserve position and the vault position implied by the reserve delta from
equilibrium.

### 7h. Trigger coordinates are exact for the snapshot curve

For a fixed curve (eq, min, px, py, c all constant), the mapping from reserve
position to marginal price to displacement is deterministic. The trigger
coordinates are exact — not an approximation. The only sources of drift are
fee accumulation and interest accrual between snapshots (see §5f), both of
which are corrected at the next snapshot.

### 7i. Forward-solve consistency

The reserve coordinate computed by `solveXForPrice(p)` must satisfy:
```
marginalPrice(reserve_0) = p    (within numerical precision)
```

And likewise `solveYForPrice(p)` for reserve_1. This is already verified
by `src/lib/simulate.test.ts` ("arb solver" tests).

---

## 8. What This Mechanism Does NOT Specify

The displacement mechanism is deliberately minimal. It does NOT specify:

- **Fee computation**: how swap fees are set (oracle-reactive, fixed, or other).
  The auction fee (starting fee, decay rate) is a separate concern.
- **Surcharge logic**: post-recenter protection is independent of displacement.
- **Oracle source**: the price `P` is an input. Where it comes from (Uniswap
  TWAP, Chainlink, marginal price, etc.) is an injected dependency.
- **Recenter mechanics**: how equilibrium reserves are updated. Displacement
  drives the *decision* to recenter; the recenter itself is curve math.
- **Pool curve shape**: the displacement formula (§3) operates on vault
  positions, independent of curve shape. The trigger coordinate precomputation
  (§5c) uses the curve's price function, but the hot-path check is just
  reserve comparisons regardless of curve type.
- **Gas optimisation**: how trigger coordinates are packed into storage,
  whether snapshot data is compressed, etc.

These are all important, but they are separate modules that compose with the
displacement mechanism without coupling to it.

---

## 9. Test Plan

The mechanism has two independent modules (displacement math, trigger) plus
their interactions with the auction/clearing system. Tests are organised
accordingly.

### Level 1: Displacement math (pure math, no curve, no EVM)

These test the formula from §3 in isolation, with explicit vault states and
prices — no curve, no reserves.

1. **Displacement computation**: for each example (§4), verify D and d match
   expected values at every state transition (initial, post-swap, post-price-
   move, post-clearing).
2. **Zero-sum property**: fuzz over random weights, positions, and prices.
   Verify `displacement_0 + displacement_1 = 0` always.
3. **At-target detection**: for each weight vector, construct the exact target
   state and verify D = 0. Then perturb by 1 wei and verify D ≠ 0.
4. **Sign determines direction**: for all four examples, verify clearing
   direction matches displacement sign at every state.
5. **NAV scaling**: double/halve asset prices with fixed positions. Verify
   displacement changes as predicted by the formula.
6. **Weight symmetry**: swap asset labels and weights, verify D flips sign.
7. **Clearing restores target**: given displacement D, simulate a perfect
   clearing trade of |D| value. Verify post-clearing D = 0 and NAV unchanged
   (ignoring fees).
8. **Fee residual on clearing**: simulate clearing with a fee. Verify
   post-clearing D is small (proportional to fee × clearing amount) and NAV
   decreased by the fee amount.

### Level 2: Trigger (with EulerSwap curve, no vaults)

These test the reserve-coordinate trigger from §5 — the mapping from
displacement threshold to trigger coordinates, and the hot-path check.

9. **Forward-solve round-trip**: for various target prices on both branches,
   verify `solveXForPrice(p)` and `solveYForPrice(p)` produce reserves
   where `marginalPrice(reserve) = p` (extend existing `simulate.test.ts`).
10. **Trigger coordinate computation**: for several trigger fractions (5%,
    20%, 50%), compute trigger_0 and trigger_1. Verify the marginal price
    at each trigger coordinate matches the expected threshold price.
11. **Trigger fires on correct branch**: run swaps that drain reserve_0
    past trigger_0. Verify trigger fires. Run swaps in the other direction
    that drain reserve_1 past trigger_1. Verify trigger fires. Verify no
    cross-firing (draining reserve_0 doesn't fire trigger_1 and vice versa).
12. **Trigger does NOT fire before threshold**: run swaps that move reserves
    to 19% from eq (with a 20% trigger). Verify trigger does not fire.
    One more swap crosses 20%. Verify it fires.
13. **Trigger resets after snapshot**: fire trigger, take snapshot (update
    eq). Verify trigger coordinates are recomputed and old coordinates no
    longer apply.

### Level 3: Auction & clearing (trigger + displacement + constant-sum)

These test the full trigger → oracle guard → displacement → clearing flow.

14. **Full cycle: trigger → oracle guard → clearing → recenter**: start at
    eq. Run persistent directional flow until trigger fires. Verify oracle
    guard passes. Compute clearing amount from true vault state. Simulate
    constant-sum clearing. Recenter. Verify D ≈ 0.
15. **Multiple strategies, same swap sequence**: run the identical sequence
    of swaps against four pools with w = [1,0], [0,1], [0.5,0.5], [-1,2].
    Verify:
    - Triggers fire at different reserve positions
    - Clearing directions differ appropriately
    - Post-clearing displacement ≈ 0 for all
16. **False positive handling**: configure a pool where the trigger fraction
    maps to a reserve displacement that does NOT correspond to significant
    strategy-level displacement (possible for leveraged strategies where
    small reserve moves cause large price changes but small vault changes).
    Verify: trigger fires, auction start computes D ≈ 0, hook takes snapshot
    and returns to normal mode without starting an auction.
17. **Oracle guard rejects manipulation**: push pool reserves past trigger
    via a large swap, but don't move the external oracle. Verify oracle
    guard rejects the auction (marginal price diverges from oracle beyond
    the guard threshold). Verify fresh snapshot is taken.
18. **Arb-driven price correction does not false-trigger**: external price
    moves 10%. An arb trades the pool to the new price. Reserves move
    significantly. If the reserve displacement is below the trigger
    fraction, verify trigger does NOT fire despite the large reserve
    movement. If above, verify it does fire and displacement is real.
19. **Wrong-direction blocking**: during auction, verify swaps in the
    clearing direction succeed (reducing min reserve gap) while swaps in
    the opposite direction revert or are blocked by min reserves.
20. **Partial fill tracking**: during a constant-sum auction, verify the
    cleared fraction `(eq_out − reserve_out) / (eq_out − minReserve_out)`
    is accurate after partial fills.

### Level 4: Drift and edge cases

21. **Fee drift**: run 100 swaps with feeRecipient = address(0). At the
    trigger coordinate, compare reserve-implied displacement vs true vault
    displacement. Verify the trigger fires late by an amount proportional
    to accumulated fees.
22. **Interest drift**: advance 10,000 blocks with significant APY. Verify
    reserves haven't moved, trigger hasn't fired. Run one small swap.
    Verify the time-based trigger forces a snapshot. After snapshot, verify
    trigger coordinates reflect the interest-adjusted vault state.
23. **Boundary: pool at min reserves**: move pool to the min reserve
    boundary (maximum displacement). Verify trigger has fired. Verify
    clearing amount equals the maximum possible displacement.
24. **Boundary: pool at equilibrium**: verify both trigger coordinates are
    not crossed. Verify displacement = snapshot_D (initial displacement
    from last snapshot, which should be ≈ 0 after a recenter).
25. **Constant-sum pool (c = 1)**: verify trigger coordinates still work
    (the price formulas degenerate: price = px/py everywhere, so the
    trigger fraction maps to a simple reserve fraction).

### Level 5: Simulation — the definitive proof

The ultimate test of the mechanism: run a full simulation with random price
paths, and show that the trigger threshold controls the trade-off between
auction frequency and displacement accuracy — for any strategy and any
volatility regime.

26. **Tight trigger keeps displacement near zero**: set trigger fraction to
    1% (impractically tight — constant auctioning). Run a long random price
    path (1000+ blocks). For each strategy (w = [1,0], [0,1], [0.5,0.5],
    [-1,2]) and each volatility regime (stablecoin σ ≈ 0.05%, volatile
    σ ≈ 70%), verify:
    - Auctions fire frequently (roughly every time price moves 1%)
    - Displacement (measured at each block) stays within a small bound
      (close to 1% of NAV, never much larger)
    - Post-auction displacement ≈ 0
    - The mechanism works identically regardless of which assets are 0/1

    This proves: **the system keeps the portfolio on-target**, regardless
    of strategy or volatility. The tight trigger ensures every displacement
    is caught quickly.

27. **Loose trigger allows drift**: set trigger fraction to 99% (almost
    never triggers). Same price paths, same strategies. Verify:
    - Auctions fire rarely (only when reserves nearly hit min boundary)
    - Displacement grows freely, potentially reaching 50-90% of NAV
    - When an auction finally fires, it clears a large amount
    - Post-auction displacement ≈ 0 (even large clearings work)

    This proves: **the trigger threshold controls the frequency-accuracy
    trade-off**, and the clearing mechanism works at any scale.

28. **Sweep across trigger fractions**: for a fixed strategy and price path,
    run the simulation at trigger fractions [1%, 5%, 10%, 20%, 50%, 99%].
    Collect:
    - Number of auctions
    - Peak displacement (max |d| over the simulation)
    - Time-weighted average |d|
    - Total auction cost (fees paid to arbers)
    - Final NAV vs initial NAV

    Plot these metrics vs trigger fraction. The expected shape:
    - Auction count: monotonically decreasing
    - Peak displacement: monotonically increasing
    - Average displacement: monotonically increasing
    - Auction cost: decreasing (fewer auctions) but partially offset by
      larger per-auction costs
    - NAV erosion: U-shaped — too tight = high auction costs, too loose =
      high variance drain, optimal somewhere in between

    This provides the calibration curve for choosing the trigger fraction
    in production — the empirical version of the theoretical variance drain
    formula from the walkthrough (§1).

29. **Strategy-independence**: run test 28 for all four strategies on the
    same price path. Verify the curves have the same qualitative shape.
    The absolute values differ (leveraged strategies have higher variance
    drain), but the mechanism behaviour is consistent.
