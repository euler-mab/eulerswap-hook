# V7 Hook Auction: Step-by-Step Walkthrough

A detailed walkthrough of the V7 hook's auction mechanism, grounded in the
USDC/USDT pool as a concrete example.

---

## Step 0: The State of the AMM

At any point in time, we can snapshot two independent pieces of state:

### 0a. The Curve (Virtual Reserves)

The pool's trading function is defined by its **dynamic parameters**:

| Parameter | Description |
|-----------|-------------|
| `equilibriumReserve0`, `equilibriumReserve1` | The "center" of the curve — virtual reserves at equilibrium |
| `minReserve0`, `minReserve1` | Hard floors — reserves cannot go below these |
| `priceX`, `priceY` | Curve slope parameters — `pX/pY` sets the price at equilibrium |
| `concentrationX`, `concentrationY` | Curve shape — 0 = range-based, 1e18 = constant-sum |

And the pool's current position on the curve:

| Parameter | Description |
|-----------|-------------|
| `reserve0`, `reserve1` | Where the pool currently sits on the curve |

The curve provides **rules for how reserves can change**: any swap must move reserves
to a point that satisfies `CurveLib.verify()` — on or above the curve defined by
the equilibrium, price, and concentration parameters. The min reserves set absolute
boundaries.

For USDC/USDT at the time of writing:

```
eq0:      247,589,086 USDC      eq1:      242,346,365 USDT
min0:     247,576,708 USDC      min1:     242,334,248 USDT
reserve0: 247,589,086 USDC      reserve1: 242,346,365 USDT
px: 0.0655244965 WAD            py: 0.0655362576 WAD
cx: 0                           cy: 0
```

Key derived quantities from the curve:

- **Equilibrium price**: `px/py` = 0.9998 USDT/USDC
- **Virtual depth**: ~$490M total — this is the curve's "width"
- **Range**: `(eq - min) / eq` ≈ 0.005% (0.5 bps) per side
- **Price sensitivity**: `2 / eq0` ≈ 0.000081 bps per $1 of trade flow
  (for c=0 curves, the marginal price changes by `2 * Δreserve / eq0²` per unit)

### 0b. The Vaults (Real Balance Sheet)

Completely independently, the Euler vaults hold the pool's actual assets:

| Position | Value |
|----------|-------|
| Supply Vault 0 (USDC deposits) | $0 |
| Supply Vault 1 (USDT deposits) | $7,828.77 |
| Borrow Vault 0 (USDC debt) | $7,330.89 |
| Borrow Vault 1 (USDT debt) | $0 |
| **NAV (deposits − debts)** | **~$500** |

The vault positions don't tell us where we are on the curve. We could be at
equilibrium, at the min boundary, or anywhere in between. The curve just provides
rules for how swaps alter the deposits and debts.

### 0c. The Connection: Swaps

As the pool moves along the curve from any starting point, each swap produces a
displacement `(Δx, Δy)` — the net amounts in and out. These deltas change both
layers simultaneously:

1. **Reserves update**: `reserve_i(t) = reserve_i(t₀) + Σ(amountIn_i − amountOut_i)`
2. **Vault balances change** by the same net amounts (deposited into / withdrawn from vaults)

Critically, fees are taken from the **input** side before the reserve update.
In `SwapLib.doDeposit()`, the gross input has protocol fee and LP fee sliced off and
transferred out; only the remainder is deposited into the vault. Then in `finish()`:

```solidity
newReserve0 = s.reserve0 + ctx.amount0In - ctx.amount0Out;
```

where `amount0In` is the post-fee input (gross minus all fees). The output side
(`doWithdraw`) has no fee logic — `amount0Out` is withdrawn and sent directly to
the recipient. So reserves track post-fee input and gross output, and the vault
deposit/withdrawal amounts are consistent with the reserve deltas.

This means: given any snapshot of reserves, plus the sequence of all post-fee
`(amountIn, amountOut)` deltas, we know exactly where we are on the curve. We can
get these from the curve equation itself, or in production, simply accumulate the
real deltas from each swap.

**Reserves vs vaults diverge due to fees.** When `feeRecipient == address(0)` (as in
our pool), LP fees are deposited into the vault but excluded from reserves (line 215
of `SwapLib.doDeposit` subtracts the fee from the reserve-facing `amountIn`). So
reserves are a fee-absent accumulator, while vault deposits grow with fees. Over time,
vault equity exceeds what reserve displacement alone would predict — the difference is
accumulated fee revenue. (If `feeRecipient` is set, fees are transferred out before
deposit, and vault deltas match reserve deltas exactly.)

The displacement from equilibrium (`reserve_i − eq_i`) represents how far the pool
has moved from its configured center. When reserves equal equilibrium (as they do
now), the pool is "centered" — but that says nothing about the vault balances.

The vault balances are the cumulative result of all deposits, withdrawals, and swap
flows since the pool was created. They can be in any configuration regardless of
where reserves sit on the curve.

### 0d. Accumulator Identities (verified by test)

The following identities are verified by `test/EulerSwapAccumulator.t.sol` over 100
swaps with varying sizes and directions.

**1. Reserve accumulator (exact, zero rounding error):**

```
reserve_i(final) = reserve_i(init) + Σ(amountIn_i − amountOut_i)
```

where `amountIn` is the **post-fee** input from each Swap event. Reserves are a
fee-absent accumulator.

**2. Per-asset vault accumulator (exact at 1:1 share rate; ±1 wei/swap at non-unity rates):**

The vault accumulator depends on where fees go:

**When `feeRecipient == address(0)` (fees stay in vault):**

```
vaultNet_i(final) = vaultNet_i(init) + Σ(grossIn_i − amountOut_i)
```

where `grossIn = amountIn + fee` (the full pre-fee input). The entire gross input is
deposited into the vault, so the vault sees `grossIn` on the input side. `vaultNet =
deposits − debts` for each asset independently.

**When `feeRecipient != address(0)` (fees leave vault):**

```
vaultNet_i(final) = vaultNet_i(init) + Σ(amountIn_i − amountOut_i)
```

The fee is transferred to the recipient before the vault deposit, so the vault sees
only the post-fee `amountIn`. In this case, the vault accumulator and the reserve
accumulator have the same delta — they differ only by the initial snapshot.

In both cases, `fee = amountInFull − amountIn` from the Swap event.

**3. Fee identity (per-asset):**

When `feeRecipient == address(0)`:

```
vaultNetGrowth_i − reserveGrowth_i = totalFee_i
```

The vault accumulates gross flows; reserves accumulate post-fee flows. The difference
is exactly the fees, per asset.

When `feeRecipient != address(0)`, both vault and reserves accumulate post-fee flows,
so `vaultNetGrowth = reserveGrowth` and fees are observable only in the recipient's
balance.

**4. NAV and price impact:**

```
NAV_growth = Σ(fees) + Σ(price_impact)
```

where `price_impact = postFeeIn − curveOut` per swap. This identity is exact only when
both sides are valued in the same unit — either the assets are fungible (stablecoins),
or all amounts are converted to a common numeraire at a consistent price. For non-
stablecoin pairs, the "NAV growth" is path-dependent on the price used for conversion
(see Step 2e on oracle dependency).

For **constant-sum** curves (c = 1e18): `curveOut = postFeeIn` (no price impact), so
`NAV_growth = Σ(fees)` exactly. Verified at zero difference in the test.

For curves with **curvature** (c < 1e18): each swap pays slightly more than it receives
due to the AMM's bid-ask spread. This price impact accrues to the LP as additional NAV.
However, it comes with **inventory risk** — the pool accumulates directional exposure
to one asset. Whether the curve spread constitutes real profit depends on future price
movements. This is the classic fee-revenue vs adverse-selection trade-off (LVR).

In the c=0.5 test with 100 swaps (2:1 directional bias):

| Component | Value |
|-----------|-------|
| NAV growth | 0.0524 |
| Fees | 0.0248 |
| Price impact retained | 0.0276 |

### 0e. Leverage

The ratio between virtual depth and real equity is the pool's leverage:

```
leverage = eq0 / NAV = 247,589,086 / 500 ≈ 495,000x
```

This leverage is the defining characteristic that shapes every parameter choice.
It means:
- A $1 swap moves the price by 0.000081 bps (vs ~1.6 bps on a 1x leveraged pool)
- The pool can absorb enormous flow before hitting boundaries
- But tiny price movements correspond to large absolute dollar amounts

---

## Step 1: Why Auction?

The pool is a market maker. As it processes swaps, it accumulates directional
exposure — it ends up holding more of one asset than it started with. For USDC/WETH,
if the pool ends up net long WETH and ETH drops, the LP takes a loss. The pool's
ideal state is delta-neutral: 100% in one asset (the "target asset"), 0% in the other.

Exposure is a liability. The longer the pool holds it, the greater the risk that
a price move turns it into a realised loss. The auction's objective is to **clear
that accumulated exposure** — to get the pool back toward delta-neutral.

The question is *how*. The alternative would be to go to Uniswap and swap directly,
but that costs the oracle pool's fee plus slippage. Instead, the auction shifts the
pool's own pricing to make it attractive for arbitrageurs to trade in the clearing
direction. The pool essentially says "I'll offer a better price on the side that
reduces my exposure" and lets external traders come to it.

The auction exists because exposure is a liability, and attracting flow through
mispricing is cheaper than going out and trading externally.

---

## Step 2: Measuring Exposure

### 2a. What is exposure?

Exposure is the **price-sensitive position** held in the vaults. It lives entirely
in the vault layer — deposits and debts — and has nothing to do with where reserves
sit on the curve. Each asset has its own exposure:

```
exposure_i = deposits_i − debts_i    (in asset i units)
```

Positive exposure = the pool is long that asset (net deposits). Negative = short
(net debt). Both create price risk: if the asset moves, NAV changes.

The two exposures are linked. When expressed in a **common numeraire** (using an
oracle price to convert):

```
value(exposure_0) + value(exposure_1) = NAV
```

So measuring one determines the other. For stablecoin pairs where both assets ≈ $1,
this simplifies to `exposure_0 + exposure_1 ≈ NAV` in native units. For non-stablecoin
pairs, the conversion requires a price — making NAV itself oracle-dependent (see 2e).

The relevant exposure is in the **non-target asset**: the one the LP doesn't want to
hold. For a delta-neutral pool targeting 100% asset0, the exposure that matters is
`deposits1 − debts1`. For a pool targeting 100% asset1, it's `deposits0 − debts0`.
The choice of which is "exposed" is symmetric.

**Reserves don't tell you exposure.** Two pools at identical reserve positions —
same point on the same curve — can have completely different vault exposures depending
on their history (initial deposits, accumulated fees, prior recenters). The curve
defines pricing and trade capacity; the vaults hold the real positions.

This is why the accumulator identities from Step 0 matter: they let us track vault
positions cheaply via swap deltas, without reading vault state on every swap.

### 2b. The target vault state

The LP's strategy defines a **relative target** — a desired composition like "100%
in one asset" or "50:50 by value." This is a parameter fixed at deploy time. There
is nothing special about asset0 vs asset1 — either can be the target asset for any
given pool. The choice is a strategy decision, not a protocol constraint.

| Strategy | Relative target |
|----------|----------------|
| Delta-neutral | 100% in target asset, 0% in the other |
| 50:50 balanced | Equal value in both assets |
| 2x long one asset | 2:1 value ratio in favour of that asset |

To turn this into an **absolute target** — specific token amounts for deposits and
debts — we need:

- **Current NAV**: total deposits minus total debts (the pool's equity)
- **Oracle price**: to convert between assets (needed for any target involving both,
  or for expressing positions in a common unit)

For a delta-neutral target where the target asset is asset `T` (and the exposed
asset is `E`):

```
target_deposits_T = NAV    (all equity in the target asset)
target_deposits_E = 0
target_debts_T    = 0
target_debts_E    = 0
```

For a 50:50 target:

```
target_deposits_0 = NAV / 2
target_deposits_1 = (NAV / 2) / oraclePrice
target_debts      = 0
```

Note: the target is about vault **composition**, not about virtual reserves. Even
without leverage or debt, swap flow changes the vault's asset mix — one side's
deposits grow while the other's shrink. The auction rebalances this composition.

**Not all relative targets are reachable.** The cross-LTVs on the borrow vaults
define a feasibility envelope — the maximum leverage the pool can take in either
direction:

- **LTV(asset0 → asset1)**: how much asset1 can be borrowed against asset0
  collateral. Bounds how far the pool can go long asset0.
- **LTV(asset1 → asset0)**: the reverse. Bounds how far long asset1.

The maximum leverage in each direction is `1 / (1 − LTV)`:

| Cross-LTV | Max leverage | Example target |
|-----------|-------------|----------------|
| 50% | 2x | 2x long (deposit 2×NAV, borrow 1×NAV) |
| 90% | 10x | — |
| 96% | 25x | USDC/USDT pool |

The deploy-time target must sit within this envelope. A 2x long target requires
LTV ≥ 50%. Delta-neutral (100% in one asset, 0 debts) requires no borrowing at
the target state, so it's always within the envelope. But the intermediate states
during clearing involve debt — the LTV must support those too.

### 2c. The clearing swap

The clearing swap is the trade that moves the vault from its current exposure back
to the target. It is the *response* to exposure, not the measure of it.

The direction depends on which side has excess relative to the target:

| Current situation | Clearing direction | What happens |
|---|---|---|
| Excess deposits1 (no debts) | Asset0 in → asset1 out | Drains deposits1, grows deposits0 |
| Excess deposits0 (no debts) | Asset1 in → asset0 out | Drains deposits0, grows deposits1 |
| Debts0 + excess deposits1 | Asset0 in → asset1 out | Incoming asset0 repays debts0 (FundsLib), outgoing drains deposits1 |
| Debts1 + excess deposits0 | Asset1 in → asset0 out | Incoming asset1 repays debts1, outgoing drains deposits0 |

The clearing swap naturally incorporates:
- **Where we are on the curve** (the curve constrains the `amountIn → amountOut` mapping)
- **Fees** (the swap pays fees, which affect both vault positions and reserves)
- **FundsLib routing** (repay-before-deposit on the input side; withdraw-before-borrow
  on the output side)

For pools with concentrated liquidity (tight range, high leverage), the vault positions
are small relative to virtual reserves. The clearing swap is a small perturbation on
the curve — well within its capacity.

The clearing swap size is computed using `computeQuote` in **exactOut** mode: given the
amount of the unwanted asset to drain (e.g., `deposits1`), compute how much of the
other asset must be sent in. The cost has two components:

- **Fee**: `grossIn = postFeeIn / (1 − feeRate)`
- **Curve spread**: with curvature (c < 1), the trader pays slightly more than 1:1.
  With constant-sum (c = 1), there is zero spread and `grossIn = clearingAmount / (1 − fee)` exactly.

The curve spread accrues to the LP as NAV. Fees go to the fee recipient (or stay in
the vault if `feeRecipient == address(0)`). Both are verified by
`test/ClearingSwap.t.sol`.

### 2d. Fee residual (feeRecipient = address(0))

When `feeRecipient == address(0)`, LP fees are deposited into the vault but excluded
from reserves (see Step 0d). This means vault deposits exceed reserves by the
accumulated fee amount. The clearing swap can drain vault positions up to the reserve
amount, but the **fee residual** stays in the vault — it is not accessible via swaps
without recentering (which resets eq = current reserves, expanding the curve's reach).

This is verified by `test_fee_residual_with_zero_recipient`.

### 2e. Expressing exposure in value terms and the oracle dependency

Exposure is denominated in native units of the non-target asset, but comparing across
pools, triggering auctions, or computing value-ratio targets requires converting to
a common unit. This requires a **price oracle** — and the oracle choice is a critical
design decision that should be abstracted, not hardcoded.

**The pool's marginal price is not trustworthy for this purpose.** It can be stale
(no swaps for many blocks) or manipulated (anyone can move it by swapping). Exposure
measurement must be robust against these failure modes.

The oracle requirement depends on the strategy:

| Strategy | Oracle role | Trust requirement |
|----------|-----------|-------------------|
| Delta-neutral | Optional — exposure is just `deposits_E − debts_E` in the non-target asset, nonzero or not. Oracle only needed to express in value terms / compare to NAV. Trigger can use native units. | Low |
| Value-ratio (50:50, 2x) | Essential — the absolute target depends on the exchange rate. Can't compute target without price. | High |

Candidate oracle sources, with different trust profiles:

- **No oracle**: sufficient for delta-neutral targets where the trigger threshold
  is denominated in asset1 units directly.
- **Vault oracle** (Euler's pricing oracle): external, harder to manipulate in the
  same transaction, but may be stale or have its own trust assumptions.
- **Uniswap V3/V4 TWAP**: time-weighted average smooths manipulation, but adds
  latency and has its own manipulation cost curve.
- **Hook-internal TWAP**: the hook accumulates its own price observations from
  swap flow. Self-contained, no external dependency, but needs careful design
  (minimum observation period, manipulation resistance).
- **Curve marginal price**: always fresh and self-consistent, but endogenous —
  manipulable by anyone who can swap. May be acceptable for stablecoin pairs
  where the price is inherently bounded.

The oracle should be an **injected dependency**: the exposure measurement takes vault
positions + a price, and the hook decides where the price comes from. Different pools
can use different oracle strategies without changing the core exposure logic.

In value terms:

```
absoluteExposure = (deposits_E − debts_E) × oraclePrice   (in target asset terms)
relativeExposure = absoluteExposure / NAV                  (fraction of equity)
```

where `E` is the non-target (exposed) asset. A 50% relative exposure means half the
pool's equity is in the exposed asset. Positive = long, negative = short. The
clearing swap then asks: what trade moves `relativeExposure` to the target ratio?

### 2f. Vault interest and accumulator drift

The accumulators from Step 0 track swap deltas exactly. But vault interest —
supply APY on deposits and borrow APY on debts — accrues silently between swaps,
outside of any delta the accumulator can observe. Over time, the accumulator's view
of vault positions drifts from reality:

```
accumulator: deposits_E = snapshot + Σ(grossIn_E) − Σ(out_E)
reality:     deposits_E = accumulator + accrued_supply_interest
```

Debt exposure drifts too: borrow interest grows `debts_E` independently of swap
flow.

For short timescales (minutes to hours), this drift is negligible relative to
swap-driven exposure changes. But for stablecoin pairs with significant carry
(supply APY 5–10%, borrow APY 8–15%), positions held for days can accumulate
material interest — affecting both exposure accuracy and LP profitability.

**Interest does not trigger auctions.** Interest-driven exposure drift is slow and
predictable. The trigger decision uses the (slightly stale) accumulator estimate,
and the inaccuracy from ignoring interest is accepted as noise — it won't flip a
threshold over the timescales between auctions.

**Auctions reset the baseline.** When an auction starts (or ends), the hook reads
the true vault state — a full snapshot of deposits and debts from the actual vaults.
This absorbs all interest accrued since the last snapshot and resets the accumulator
to ground truth. The auction then works from accurate positions.

The design principle: **cheap estimation between swaps, expensive ground truth at
checkpoints.** The accumulator (or potentially something even cheaper) handles the
hot path. Full vault reads happen only at natural checkpoints — auction start,
auction end / recenter — where the gas cost is already non-trivial and accuracy
matters most.

---

## Step 3: When to Trigger an Auction

### 3a. The trigger trade-off

Auctions have a cost: they shift the pool's pricing off-market to attract clearing
flow, meaning the pool offers worse terms during the auction. The trigger decision
balances two costs:

- **Cost of not clearing**: continued exposure to price risk. Over a long enough
  timescale without clearing, the pool risks liquidation or unbounded loss.
- **Cost of clearing**: the auction itself — the pricing shift, the fees foregone
  or paid, and the curve spread consumed by the clearing trade.

Clearing after every swap is maximally safe but prohibitively expensive. Never
clearing is free until it isn't. The optimal frequency is somewhere in between,
and it depends on asset volatility, pool leverage, and LP risk tolerance.

### 3b. Trigger conditions

The trigger fires when **either** of two conditions is met:

1. **Reserve-coordinate threshold**: current reserves have crossed a precomputed
   boundary that corresponds to the exposure threshold.

   At each snapshot (post-recenter or initialization), the hook knows the full
   state: vault positions, reserves (= eq after recenter), NAV, and oracle price.
   From these, it precomputes the reserve coordinates at which exposure would cross
   the threshold:

   ```
   // At snapshot time (reserves = eq, full vault state known):
   thresholdAmount = threshold × NAV / oraclePrice    // in exposed asset units
   triggerHigh = eq_E + thresholdAmount                // long exposure boundary
   triggerLow  = eq_E − thresholdAmount                // short exposure boundary
   ```

   In `afterSwap`, the check is trivially cheap — two `uint256` comparisons:

   ```
   if reserve_E > triggerHigh → long exposure → auction to sell asset E
   if reserve_E < triggerLow  → short exposure → auction to buy asset E
   ```

   No oracle read, no vault read, no accumulator math in the hot path.

   **Why this works**: reserves and vault positions move together via swap deltas.
   A reserve displacement of Δ from equilibrium corresponds to approximately Δ of
   vault position change.

   **Fee-induced discrepancy**: when `feeRecipient == address(0)`, fees are deposited
   into the vault but excluded from reserves (see Step 0d). On the input side, vault
   exposure grows by `grossIn` while reserves grow by `postFeeIn`. This means the
   trigger fires **late**: vault exposure already exceeds the threshold before reserve
   displacement crosses the trigger coordinate. The error is proportional to
   accumulated input fees since the last snapshot — small for low-fee pools, but
   systematic.

   When `feeRecipient != address(0)` (as in production pools where the hook is the
   fee recipient), vault and reserve deltas match exactly. The trigger is exact
   (within share-rate rounding). For pools with an external feeRecipient, this
   discrepancy does not arise.

   **For delta-neutral targets**, the threshold can be denominated directly in
   native units of the exposed asset (a deploy-time parameter), eliminating the
   oracle dependency at snapshot time entirely. The trigger becomes: "have reserves
   moved more than X units from equilibrium?"

   **Oracle guard at auction start**: when the trigger fires, the hook reads the
   oracle and compares it to the pool's marginal price before committing to the
   auction. The guard threshold scales with the pair's volatility and the time
   elapsed since the last snapshot:

   ```
   guardThreshold = g × D × √(blocksSinceSnapshot)
   ```

   where `D` ≈ σ₁ (per-block volatility, a deploy-time parameter — see Step 4b),
   `g` is a confidence multiplier (e.g., g = 3 for ~99.7% of normal price paths),
   and the √(blocks) term accounts for random-walk drift since the snapshot.

   | Pair | D (σ₁) | Blocks | g=3 threshold |
   |------|--------|--------|---------------|
   | USDC/WETH | 4.3 bps | 25 (~5 min) | 64.5 bps |
   | USDC/WETH | 4.3 bps | 100 (~20 min) | 129 bps |
   | USDC/USDT | 0.001 bps | 25 (~5 min) | 0.015 bps |
   | USDC/USDT | 0.001 bps | 500 (~100 min) | 0.067 bps |

   If `|marginalPrice − oraclePrice| > guardThreshold`: the prices have diverged
   beyond what normal drift explains. The auction is **aborted** — instead of
   proceeding with potentially stale or manipulated data, the hook takes a fresh
   snapshot (full vault read, recompute trigger coordinates from current oracle
   price) and returns to normal mode. The next swap re-evaluates the trigger
   against the fresh coordinates.

   If the prices agree within the threshold: the auction proceeds. The marginal
   price is used as the auction anchor (per Step 4e — manipulation-resistant
   because manipulation = clearing).

   This scales correctly: tight for stablecoins (0.015 bps after 5 minutes),
   generous for volatile pairs (64.5 bps), and widens over time as more drift is
   expected. The multiplier `g` and the volatility parameter `D` are both set at
   deploy time — no runtime oracle needed for the guard threshold itself.

   The threshold is calibrated per pool at deploy time. A volatile pair (USDC/WETH)
   needs a tighter threshold than a stablecoin pair (USDC/USDT) because the cost
   of holding exposure scales with volatility.

2. **Time-based** (with nonzero displacement): a maximum interval since the last
   snapshot has elapsed **and** reserves are displaced from equilibrium.

   ```
   blocksSinceLastSnapshot > maxSnapshotInterval AND reserve_E != eq_E
   ```

   This ensures the accumulator baseline is periodically refreshed (absorbing
   interest drift from Step 2f) when reserves indicate activity since the last
   snapshot. If reserves are at equilibrium, the time trigger is skipped — there is
   nothing to clear, and snapshotting would be wasted gas.

   This matters for pools that go idle (no swaps for extended periods). An idle
   pool at equilibrium should not trigger pointless auctions. An idle pool with
   displaced reserves should eventually trigger to correct stale state.

Both conditions are checked in `afterSwap` using only cheap stored state — two
stored `uint256` trigger coordinates, the current reserves (already available in
the swap context), and the last snapshot block number. Zero external calls.

**Limitation: interest-driven exposure is invisible to this trigger.** Vault
interest (supply APY, borrow APY) changes deposits and debts without moving
reserves. An idle pool accumulating interest-driven exposure will never cross
the reserve-coordinate trigger, because reserves haven't moved. The time-based
trigger also misses this — it checks `reserve_E != eq_E`, which fails for idle
pools.

For pools with significant carry (stablecoins with 5-15% APY), interest drift
can be material over days or weeks (1-5% of NAV per week on stablecoin pools
with $7-8k positions and $500 NAV). This exposure requires periodic external
intervention — an agent or keeper that reads vault state directly and triggers
a reconfigure if interest-driven exposure exceeds a threshold. The reserve-
coordinate trigger is optimized for **swap-driven** exposure, which dominates
in active pools.

### 3c. Cooldown

After an auction ends (whether by successful clearing or timeout), without a
cooldown the very next swap could trigger another auction immediately. After
successful clearing, this would make every swap an auction — defeating the purpose
of batching. After timeout, rapid-fire failed auctions would burn gas on repeated
vault reads and reconfigurations with no progress.

A **minimum interval** between auctions prevents this:

```
blocksSinceLastAuction > minAuctionInterval
```

The min and max intervals define a frequency band:

| Parameter | Role | Example |
|-----------|------|---------|
| `minAuctionInterval` | Floor — no auction can fire sooner than this | 25 blocks (~5 min) |
| `maxAuctionInterval` | Ceiling — forces auction even without exposure | 500 blocks (~100 min) |
| `exposureThreshold` | Exposure level that triggers within the band | 50% of NAV |

All three are deploy-time parameters, calibrated per pool.

### 3d. Asymmetric thresholds (future exploration)

The cost of positive exposure (long the non-target asset via deposits) vs negative
exposure (short via debt) may be asymmetric: debt accrues borrow interest, deposits
earn supply interest. The carry cost differs by direction.

For now, a single symmetric threshold keeps things simple. Separate thresholds for
positive and negative exposure deviation is a natural extension worth exploring —
particularly for pools where the borrow/supply rate spread is large.

### 3e. Gas price considerations

Gas price at trigger time affects auction profitability. The auction attracts
arbitrageurs who must pay gas to execute the clearing trade. If gas is high, the
clearing trade needs a larger edge to be profitable, which means the auction must
offer a larger pricing shift — a cost ultimately borne by the LP.

Gas price is observable in `afterSwap` (`tx.gasprice`). How it should influence
the trigger decision or auction parameters is an **open design question**:

- Should the starting fee increase when gas is high (to give arbers a larger
  eventual edge, compensating for gas costs)?
- Should the trigger defer when gas is extreme (delaying the auction until
  conditions are more favourable)?
- Or should gas price be left to the arber to price in, with no hook adjustment?

The current design leaves gas to the arber: the fee decays at a fixed rate, and
the arber fills when edge > gas cost. Higher gas means later fill (more fee
decay), which costs the LP more. A gas-aware starting fee could reduce this cost
but adds complexity and a new attack surface (gas price manipulation).

---

## Step 4: The Auction Mechanism

### 4a. Core concept: a Dutch auction on a fixed-size order

The auction is conceptually simple — simpler than the curve it runs on top of:

> **"I will sell X units of asset A for asset B at price P. The fee starts high
> and decays until someone takes the offer."**

This is a Dutch auction on a fixed-size limit order. In practice, the auction is
executed by reconfiguring the pool to constant-sum and routing through the existing
swap infrastructure (see 4c).

The key parameters, all computed at auction start:

| Parameter | Description | Source |
|-----------|-------------|--------|
| **Direction** | Which asset to sell, which to buy | Determined by exposure sign |
| **Amount** | How much of the exposed asset to clear | From exposure measurement (Step 2) |
| **Price** | The exchange rate offered | Grounded in oracle / marginal price |
| **Starting fee** | Initial fee that makes the trade unprofitable | Set so `price − fee < marketPrice` |
| **Fee decay** | Rate at which fee decreases per block | Deploy-time parameter |

### 4b. How the Dutch auction works

At auction start:

1. The hook snapshots the true vault state (full vault read — the expensive
   operation deferred from the hot path) and computes the clearing amount and
   direction. For non-stablecoin pairs, computing NAV from vault positions requires
   a price to convert between assets — the same oracle used for the auction price
   anchor (see 4e). This means the clearing amount is oracle-dependent: a stale or
   manipulated oracle affects both the auction price and the size of the order.
2. The auction price is set, grounded in the current price (marginal, oracle, or
   other source — see 4e below).
3. The starting fee is set high enough that `auctionPrice − startingFee` is
   unprofitable for arbitrageurs vs the external market.

Each block, the fee decays (linearly):

```
currentFee = max(0, startingFee − decayPerBlock × blocksSinceStart)
```

At some block, the effective price crosses the profitability threshold:

```
effective = auctionPrice − currentFee
```

When `effective` exceeds the external market rate (minus the arber's gas cost),
the arber profits by buying from the auction and selling externally.

**Worked example.** Pool is long WETH, wants to sell WETH for USDC. Auction price =
2000 USDC/WETH (marginal price at trigger). External market = 2000 USDC/WETH.

| Block | Fee (bps) | Effective (USDC/WETH) | Arber profit per WETH | Action |
|-------|-----------|----------------------|----------------------|--------|
| 0 | 50 bps | 2000 − 10 = 1990 | 1990 − 2000 = −$10 | No fill |
| 5 | 28.5 bps | 2000 − 5.7 = 1994.3 | −$5.70 | No fill |
| 10 | 7 bps | 2000 − 1.4 = 1998.6 | −$1.40 | No fill (< gas) |
| 12 | 0 bps | 2000 | $0 − gas | Fill (if gas ≈ 0) |

The fee reduces the USDC the arber receives per WETH purchased. High fee = bad deal
for arber = no fill. As the fee decays, the effective rate rises toward (and
eventually beyond) the external market rate.

#### Starting fee

In a perfectly balanced world with no gas costs, the starting fee should equal the
premium: `startingFee = auctionPrice − marketPrice`. At block 0, the effective
price exactly equals market — barely unprofitable. But this means the auction is
immediately snipeable — any arber watching takes it at block 0 and the LP captures
zero fee.

The fix is to add a margin of `k × D` (where D = `decayPerBlock`):

```
startingFee = premium + k × D
```

The auction becomes profitable at block k. The parameter k controls how long the
auction runs before clearing — effectively a time budget. A reasonable range is
k = 10–25, corresponding to 2–5 minutes at 12-second blocks.

| k (blocks) | Time | Margin (ETH, D ≈ 4.3 bps) |
|------------|------|---------------------------|
| 10 | 2 min | ~43 bps |
| 15 | 3 min | ~65 bps |
| 25 | 5 min | ~108 bps |

The margin is the LP's *maximum* cost if the fee decays all the way to the
profitability point. In practice, the arber fills before full decay, so actual
cost is lower. Competition among arbers pushes the fill toward the earliest
profitable block.

k should be a deploy-time parameter, tunable based on observed auction performance
— in particular, how often the marginal price at trigger time turns out to be
stale or inaccurate. A larger k provides more buffer against price uncertainty
at the cost of longer auctions.

#### Decay rate calibration

The fee decays in discrete steps of `decayPerBlock = D` per block. This creates a
three-way tension:

| Want | Requires | Costs |
|------|----------|-------|
| Fine fee granularity | Small D (slow decay, more blocks) | Longer exposure to price moves |
| Fast clearing | Large D (fast decay, fewer blocks) | Coarse granularity, leak more per unit |
| Low price risk | Fewer blocks exposed | Coarser decay |

The key parameter is **σ₁: per-block price volatility.** For ETH (annualized vol
≈ 70%, 12-second blocks, 2,628,000 blocks/year):

```
σ₁ = 0.70 / √2,628,000 ≈ 4.3 bps per block
E[|ΔP/P|] ≈ 0.8 × σ₁ ≈ 3.4 bps per block
```

D is a deploy-time parameter set by the LP. It is fundamentally an asset-pair
property (not a pool property) — two pools on the same pair should use roughly the
same D. The calibration script (`scripts/calibrate-hook-params.ts`) can recommend a
value from historical volatility data, but the LP can override based on their own
risk assessment.

The optimal decay rate is **D ≈ σ₁** (see `docs/rebalance-auction-design.md` §8):

- **D >> σ₁**: coarse fee steps — giving away value through granularity. The arber
  gets a price up to D better than the minimum they'd accept.
- **D << σ₁**: fine granularity but price moves dominate. Waiting longer gains
  nothing because the underlying price is moving faster than the fee is decaying.
- **D ≈ σ₁ ≈ 4.3 bps/block**: arber edge ≈ 2σ₁ ≈ 8.6 bps — the irreducible
  minimum given 12-second blocks.

Over N blocks of auction duration, the LP is exposed to ~σ₁ × √N bps of adverse
price movement (random walk). This is a cost on top of the auction mechanics and
sets a budget for how long the auction should run.

For stablecoins, σ₁ is orders of magnitude smaller (USDC/USDT vol ≈ 0.01–0.1%
annualized), so the decay can be much finer and the auction can take many more
blocks without material price risk.

### 4c. Constant-sum reconfiguration

During auction mode, the hook reconfigures the pool to **constant-sum** (c = 1e18)
and uses the existing swap infrastructure. This is a reconfiguration, not a separate
code path:

- **Normal mode**: swaps evaluated against the curved pool with oracle-reactive fees.
- **Auction mode**: pool reconfigured to constant-sum. Swaps routed through the
  same `swap()` → `FundsLib` → vault path, but with constant-sum pricing and
  hook-controlled decaying fee.

Why constant-sum reconfiguration rather than a separate code path:

1. **FundsLib reuse**: the existing swap mechanism handles all vault operations —
   deposit, withdraw, borrow, repay — correctly. Reimplementing this in a separate
   auction path would be error-prone and duplicative.
2. **Leveraged targets**: if the target state involves borrowing (e.g., 2x long),
   the clearing swap must be able to borrow. FundsLib already handles this via
   withdraw-before-borrow on the output side and repay-before-deposit on the input.
3. **Predictable cost**: constant-sum has zero curve spread. The LP's cost is
   entirely determined by the fee, which the hook controls precisely.
4. **Battle-tested path**: the swap → FundsLib → vault pipeline has been tested
   with 42k+ mainnet swaps. A new code path would be fresh attack surface.

At auction start, the hook calls `reconfigure()` with new DynamicParams and
InitialState. The pool must start ON the new curve (`CurveLib.verify` is called
on the InitialState with the new params). For constant-sum, the curve is
`reserve0 × px + reserve1 × py = eq0 × px + eq1 × py`. Setting eq = current
reserves ensures the pool starts at equilibrium and verify passes.

The clearing capacity comes from the gap between eq and min reserves:

```
// DynamicParams:
concentrationX = concentrationY = 1e18    // constant-sum
equilibriumReserve0 = reserve0            // pool starts at eq
equilibriumReserve1 = reserve1
priceX, priceY = auction price            // from marginal price at snapshot
fee = controlled by hook (startingFee, decays per block)

// Min reserves define clearing capacity:
// Example: clearing direction is asset0 in → asset1 out
minReserve0 = 0                           // asset0 can grow (input side)
minReserve1 = reserve1 - clearingAmount   // asset1 can drain by clearingAmount

// InitialState:
reserve0 = current_reserve0               // no change
reserve1 = current_reserve1
```

Only the clearing direction is tradeable — the hook sets a prohibitive fee (or
reverts) on the wrong direction. At auction end, the hook reconfigures back to
normal curve parameters.

The risk is parameter misconfiguration during reconfigure. Mitigations:
- `reconfigure()` validates new params via `CurveLib.verify()`
- The hook can validate the constant-sum params before calling reconfigure
- Post-recenter surcharge (4h) protects against errors in the restore step
- The reconfigure is atomic within `afterSwap` — no window for external interference

### 4d. Partial fills

Arbers cannot be expected to fill the entire auction in one trade. In practice:

- The arber optimises for profit given current gas costs, not for complete clearing.
  They may take 95% of the offer if that's the profit-maximising size.
- The remaining 5% may not be worth a separate transaction given gas costs.
- Arbers use heuristics and may not know the exact auction amount.

The auction therefore supports **partial fills**: it tracks the remaining amount
to clear, and any subsequent swap can chip away at it. The fee continues decaying,
making the residual progressively more attractive.

If the residual becomes too small to justify gas costs, it will be swept up in the
next auction cycle (after timeout and re-trigger).

**Partial fills and the atomic invariant.** Step 4e establishes that the price
snapshot and exposure measurement must be atomic — taken in the same operation. After
a partial fill, the remaining auction amount was set at the original snapshot, but
subsequent swaps (including the partial fill itself) have moved the marginal price.
The residual amount and the current price are no longer from the same snapshot.

This is acceptable because: (a) the residual is smaller than the original amount, so
the manipulation surface shrinks with each fill; (b) the clearing threshold (4f)
means we don't try to fill the last few percent; and (c) the auction price is fixed
at snapshot time — it doesn't update with the marginal price during the auction. The
fee decay provides the only moving part, which is deterministic and manipulation-free.

### 4e. Auction price: grounding and manipulation resistance

The auction price determines the LP's cost. Setting it requires a reference for
the current market price:

- **Too far above market** (generous to arbers): the LP overpays. If the fee is
  misconfigured or decays too fast, the LP takes an unnecessary loss.
- **Too close to market** (stingy): the auction may not clear, or clears very
  slowly as the fee must decay a long time before the trade becomes profitable.

The premium above market is effectively the LP's maximum willingness to pay for
clearing. It should be a calibrated parameter — not arbitrary, but derived from
the pool's risk profile (volatility, leverage, NAV).

#### Why the marginal price is the right anchor

The pool's own marginal price is the natural choice for grounding the auction price.
Counter-intuitively, the marginal price is **more manipulation-resistant** for this
purpose than an external oracle — precisely because it's endogenous.

**Attack 1: depress the price to buy cheaply from the auction.**

An attacker wants the auction to sell asset E cheaply. To lower E's marginal price,
they sell E into the pool (send E in, receive T out). This increases reserve_E and
decreases E's price. But it also **increases** the pool's E exposure — the vault
receives more E deposits (or repays E debt). The attacker is pushing the pool further
from its target, not closer.

The manipulation has two effects:
- The auction price drops (depressed marginal price)
- The auction amount grows (more E exposure to clear)

Is this profitable? The attacker sells X of E at the depressed price (bad for them),
then buys from the auction at that same depressed price. On the round-trip of X units,
they break even minus fees. On the original clearing amount, they buy at the depressed
price — below the pre-manipulation market. The profit is:

```
profit ≈ priceDepression × originalClearingAmount
cost   ≈ priceDepression × X + fees
```

where `priceDepression ≈ 2X / eq0` for a c=0 curve. For leveraged pools, eq0 is
enormous relative to X, so the price depression is negligible per dollar of
manipulation. The profit on the original amount is proportionally tiny.

**Example**: USDC/USDT pool (eq0 = 247M). Attacker sells $1000 USDT into pool.
Price depression ≈ 2×1000 / 247M ≈ 0.0008 bps. Original clearing = $250. Profit ≈
0.0008 bps × $250 ≈ $0.000002. Not worth the gas.

For less-leveraged pools the attack surface is larger, which is why the **oracle
guard** (3b) matters — it catches cases where the marginal price has been moved
significantly from the oracle price and aborts the auction.

**Attack 2: inflate the price, then clear at the generous auction price.**

An attacker buys E from the pool (sends T in, receives E out), pushing E's marginal
price up. But buying E **decreases** the pool's E exposure — the vault withdraws E
deposits (or borrows E). The attacker is actually performing the clearing trade.

- The pool's E exposure shrinks. The auction amount, if it triggers, is smaller.
- The attacker paid the (rising) price during their purchase. The auction price is
  set to the now-high marginal price. For the attacker to profit from filling the
  (smaller) remaining auction, they'd need an edge beyond fees — but they already
  moved the price up against themselves.
- The LP benefits: the attacker's purchase cleared some exposure at an increasingly
  favourable price (E sold at higher and higher rates as the price rose).

This attack is directly self-defeating: the attacker does the pool's job for it.

**Why marginal price works as an anchor:**

The marginal price and exposure are linked through the same reserves — they move
together via the curve. Any trade that changes the price also changes the exposure in
a correlated way. An external oracle, by contrast, can be manipulated independently
(e.g., push the Uniswap price without touching the EulerSwap pool), creating a
dangerous divergence between the oracle price and the pool's actual state.

**Critical invariant: the auction amount must match the price snapshot.**

The self-defeating argument only holds if the auction sells no more than the exposure
that existed when the price was observed. If an attacker:

1. Sells X of asset E into the pool (depressing the marginal price)
2. The auction triggers with amount > X (because prior exposure already existed)
3. Buys back X + extra at the depressed auction price

...then they profit on the extra. The manipulation cost (selling X at a bad price)
is fixed, but the auction returns more than X at the cheap price.

The defence is that **the price snapshot and the exposure measurement must be
atomic** — taken from the same pool state. If the auction amount is computed from
the exposure at the moment the marginal price is read, the two are consistent: any
trade that moves the price also moves the exposure by the same amount. The attacker
can't inflate the auction amount without also moving the price back up.

In practice, this means the auction start must snapshot both the marginal price and
the clearing amount in the same operation (same `afterSwap` call). If they could be
decoupled — price set in one block, exposure measured in another — an attacker could
manipulate between the two snapshots.

**Open questions requiring thorough testing and formal analysis:**

- Multi-block attacks where the attacker manipulates in one block and the auction
  triggers in a subsequent block (MEV / cross-block strategies)
- Interactions with the fee decay — can an attacker time their manipulation to
  coincide with low fees?
- Pools where the marginal price is very stale (no swaps for many blocks) — does
  the price still reflect a reasonable market?
- Sandwich attacks wrapping the auction trigger transaction itself
- Whether partial fills change the invariant — after a partial fill, the remaining
  amount and the current marginal price may no longer be consistent if other swaps
  have occurred between fills

### 4f. Clearing threshold

The auction does not need to clear 100% of the exposure. A clearing threshold
(e.g., 90% of the original amount) defines "good enough." Once the remaining
amount drops below this threshold, the auction ends — the residual carries over
and will be handled by the next auction cycle if it grows back above the trigger.

This avoids the tail problem where the last few percent are too small to justify
gas costs and the auction stalls waiting for a fill that never comes.

### 4g. Auction lifecycle

```
[normal mode]
    │
    ├── afterSwap: reserve_E outside [triggerLow, triggerHigh]
    │              OR (time > maxInterval AND reserve_E != eq_E)
    │   (and cooldown elapsed: time > minInterval)
    │
    ▼
[auction start]
    ├── Oracle guard: |marginal − oracle| < g × D × √(blocksSinceSnapshot)?
    │   If NO → abort, re-snapshot, return to normal mode
    │   If YES → proceed:
    ├── Full vault read (snapshot true deposits/debts)
    ├── Compute clearing amount and direction
    ├── Reconfigure pool to constant-sum (c = 1e18)
    │   eq = current reserves, min reserves allow clearing, price = marginal
    ├── Set starting fee (premium + k×D), enter auction mode
    │
    ▼
[auction active]
    ├── Each swap: routed through constant-sum pool via normal swap path
    │   ├── Clearing direction: fill (partial or full), fee decays per block
    │   └── Wrong direction: blocked (prohibitive fee or revert)
    ├── Fee decays linearly (D per block)
    │
    ├── If sufficiently cleared (remaining < clearingThreshold):
    │   └── → [auction end: successful clearing → recenter]
    │
    ├── If timed out (blocks > auctionTimeout):
    │   └── → [auction end: timeout → snapshot only]
    │
    ▼
[auction end: successful clearing → recenter]
    ├── Full vault read (snapshot true deposits/debts)
    ├── Reconfigure back to curved pool:
    │   ├── Recenter: set eq = current reserves
    │   ├── Set eq price from oracle (slot0 / TWAP)
    │   ├── Restore concentration (c) to normal curve shape
    │   ├── Recalculate range (min reserves) from new snapshot + range parameter
    ├── Recompute trigger coordinates from fresh snapshot
    ├── Apply surcharge (see 4h)
    ├── Resume normal mode

[auction end: timeout → snapshot only]
    ├── Full vault read (snapshot true deposits/debts)
    ├── Reconfigure back to curved pool (restore pre-auction params)
    ├── Recompute trigger coordinates from fresh snapshot
    ├── Resume normal mode (no surcharge — no recenter occurred)
    ├── Cooldown applies (minAuctionInterval before next auction)
    │
    ▼
[normal mode]  (after successful clearing, includes surcharge)
    ├── If post-recenter: surcharge decays exponentially (halves each block)
    ├── Oracle-reactive fee handles ongoing price tracking
    └── After ~5 blocks, surcharge is negligible → steady state
```

The timeout and clearing threshold are both checked in `afterSwap` — no keeper
or external transaction required.

### 4h. Post-recenter surcharge

Recentering sets the curve's eq price from an oracle (e.g., Uniswap slot0). But
the oracle may be stale, or the market may have moved during the auction. If the
new eq price is wrong, the recenter itself creates a fresh arbitrage opportunity.

Worse, an attacker could try to profit atomically: manipulate the oracle, trigger
an auction, wait for recenter, and arb the freshly mispriced pool.

The **surcharge** is a blunt, fast-decaying fee added on top of the normal fee
immediately after any recenter. It makes post-recenter arbs extremely expensive
for the first few blocks, giving the oracle-reactive fee time to take over for
ongoing price tracking.

**Exponential decay** is the right shape for the surcharge:

```
surcharge = baseSurcharge × 2^(halvingBlocks − blocksSinceRecenter)
```

For example, with `baseSurcharge = 1 bps` and `halvingBlocks = 5`:

| Block after recenter | Surcharge |
|---------------------|-----------|
| 0 | 32 bps |
| 1 | 16 bps |
| 2 | 8 bps |
| 3 | 4 bps |
| 4 | 2 bps |
| 5 | 1 bps |
| 6+ | 0 (or baseFee takes over) |

Properties:

- **Enormous initial deterrent**: 32× makes any immediate arb prohibitively
  expensive. If someone pays it, the pool was catastrophically mispriced and the
  surcharge saved the LP from something much worse.
- **Fast decay**: back to normal in ~1 minute (5 blocks). The pool is competitive
  again quickly.
- **No precision needed**: unlike the auction fee (where granularity matters for
  cost minimisation), the surcharge is a safety net. The jumps between blocks are
  large, but that's fine — it's protecting against tail risk, not optimising cost.
- **Complements the oracle-reactive fee**: the surcharge handles the first minute
  post-recenter. The normal oracle-reactive fee handles ongoing small price
  differences. They operate at different timescales.

The surcharge parameters (`baseSurcharge`, `halvingBlocks`) are deploy-time
settings. `baseSurcharge` should reflect the maximum plausible recenter error —
if the oracle could be off by 50 bps, the initial surcharge should be well above
that.

### 4i. Auction cost analysis

The LP's cost per auction has several components:

- **Price premium**: the difference between auction price and true market price.
  This is the maximum cost — only fully incurred if the fee decays to zero.
- **Fee captured**: the decayed fee at the time of fill, which offsets the premium.
  The LP's net cost is `premium − fee_at_fill`.
- **Curve spread**: zero. The pool is reconfigured to constant-sum (c = 1e18)
  during auction, so there is no bid-ask spread from curvature.

The Dutch auction mechanism naturally minimises cost: the first arber to find the
trade profitable executes it, which means the fee at fill is the minimum discount
the market requires. Competition among arbers pushes the fill toward the highest
viable fee (lowest LP cost).

```
LP cost per unit = premium − feeAtFill
                 = (auctionPrice − marketPrice) − feeAtFill
```

Note: `premium > 0` in the normal case because the starting fee includes a `k × D`
margin above break-even (see 4b), which means `auctionPrice > marketPrice` by the
time the fee has decayed to the fill point. The premium is the LP's maximum cost;
the fee recaptures part of it.

In the ideal case, `feeAtFill ≈ premium − gasCost`, and the LP's cost approaches
just the arber's gas cost — the minimum possible.
