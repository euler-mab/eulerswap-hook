# Rebalance Auction Design Notes

Working document capturing the analysis and design reasoning for the autonomous rebalancing mechanism shipped in [`DynamicFeeAuctionHook.sol`](../contracts/src/DynamicFeeAuctionHook.sol).

> **Historical note:** earlier sections (≤21) discuss an "off-chain agent" that tunes parameters in real time. In the final V7 design (section 22), the full rebalance cycle — fee modulation, shift, auction, recenter, surcharge decay — runs **autonomously on-chain** from inside `afterSwap`. The pool owner can still update fee/auction/recenter/surcharge parameters at any time via `setFeeParams()` / `setAuctionParams()` / `setRecenterParams()` / `setSurchargeParams()`, but no off-chain loop is required for the core mechanism.

### Document structure

| Sections | Topic |
|----------|-------|
| 1 | EulerSwap primitives available for building solutions |
| 2-6 | Theory: price movement, arb profitability, fee mechanics, LP economics |
| 7-9 | Auction mechanics: rebalance = shift + auction + recenter, decay rates, batching |
| 10-13 | Practical constraints: second-order effects, oracle strategy, retail routing, health/leverage |
| 14-15 | Implementation philosophy and V2 bug reference |
| 16 | Lessons from the AMM fee challenge competition |
| 17 | Competitive landscape: Uniswap pool data (March 2026) |
| 18 | Empirical validation experiments |
| 19 | Design principles summary |
| 20-21 | **Hook designs:** V1-V3 recap, V4 design |
| 22 | **V7 design:** continuous recenter, curvature-aware surcharge, exposure-sized auctions |
| 23 | Open questions |
| 24 | **Variance drain:** the fundamental cost of rebalancing leveraged pools |

## 1. EulerSwap Building Blocks

Before the design analysis, a summary of the tools EulerSwap gives us. These are the primitives any solution must be built from.

### Pool curve

Each pool has an equilibrium point (x₀, y₀), a price ratio (priceX/priceY), and per-side range parameters (rx, ry) that define upper and lower price boundaries. The curve is a concentration-weighted blend of constant-product and constant-sum, controlled by (cx, cy). At cx=cy=0, it's standard xy=k; at cx=cy=1, it's constant-sum (infinite depth, linear). The piecewise structure means the X branch (price above eq) and Y branch (price below eq) can have different concentration and range parameters.

### Reconfigurable state

All dynamic parameters can be changed without redeploying: equilibrium reserves, price, concentration, fees, range, hook address, and hook operations bitmask. This is done via `reconfigure()`, callable by the owner/manager through EVC, or by the hook directly from within `afterSwap`. This is the core mechanism for rebalancing — we can move the equilibrium price, adjust range, change fees, all in a single call.

### Hook system (three insertion points)

| Hook | When | Pool state | Primary use |
|------|------|-----------|-------------|
| `beforeSwap` | Before any swap logic | Locked | Gate/block swaps, pre-validation |
| `getFee` | During swap, before fee application | Locked (read-only reserves) | Dynamic fee computation |
| `afterSwap` | After swap completes | **Unlocked** — can call `reconfigure()` | Releverage, rebalance, state updates |

The `getFee` hook receives: direction (asset0IsInput), current reserves (reserve0, reserve1), and a readOnly flag (true when called from `computeQuote` for off-chain pricing). It returns a uint64 fee in WAD scale, or `type(uint64).max` to fall back to the static fee.

The `afterSwap` hook receives: amounts in/out, fees charged, sender, recipient, and post-swap reserves. Crucially, the pool is unlocked during this callback — the hook can call `reconfigure()` to adjust any pool parameter.

### Asymmetric fees

The hook can return different fees depending on direction (asset0IsInput). This enables:
- **Protect side** (arb direction): high fee to capture LVR
- **Attract side** (retail direction): low fee to win routing
- Direction is determined by comparing the pool's marginal price to an oracle reference

### Leverage via Euler vaults

The pool deposits into and borrows from Euler lending vaults. Equilibrium reserves can be set much larger than actual deposits (the "boost"). The pool borrows the difference as price moves reserves away from equilibrium. This creates leveraged liquidity from small equity — but also health constraints (liquidation if collateral × LTV < debt).

### On-chain readable state

Available to the hook at execution time:
- **Own reserves:** reserve0, reserve1 (passed to getFee/afterSwap)
- **Own parameters:** all DynamicParams via `getDynamicParams()`
- **Uniswap V3 price:** `slot0()` on any configured pool (spot price, tick)
- **Uniswap V3 TWAP:** `observe()` for historical price accumulators
- **Gas price:** `tx.gasprice` (for gas-aware fee thresholds)
- **Block number:** `block.number` (for time-based decay)
- **Vault state:** deposit balances, debt balances, health factor via Euler lens contracts

### Hook storage

The hook contract can maintain arbitrary storage. Current hooks use this for:
- Fee parameters (baseFee, maxFee, gasCoeff, externalFee, captureRate, attractRate)
- Auction state (auctionActive, auctionStartBlock, startingFee, preAuctionParams)
- Owner and pool address

Storage is cheap to read (warm SLOAD = 100 gas) but expensive to write (SSTORE = 5000-20000 gas). Designs should minimize writes per swap.

### Off-chain agent

An EOA (the pool owner) can call `setFeeParams`, `setAuctionParams`, and trigger `reconfigure()` via EVC at any time. This enables:
- Periodic parameter updates based on off-chain analysis
- Emergency interventions (pause via maxFee, force rebalance)
- Sophisticated computation that would be too expensive on-chain

### What we DON'T have

- **No access to pending mempool** — can't see other transactions in the block
- **No cross-block state in getFee** — getFee is view-like; writes happen in afterSwap
- **No direct Chainlink reads** (would need additional oracle adapter)
- **No control over swap ordering within a block** — MEV/builder determines this
- **No way to force swaps** — can only incentivize via fees; the pool is passive

## 2. The Problem

The pool targets a delta-neutral position (100% USDC equity). Any non-zero ETH equity or debt means the LP has directional exposure that should be cleared. A rebalance recenters the equilibrium price and range to current market. But recentering creates a mispricing between old reserves and the new curve — if left unprotected, an arber extracts the full value in one block. An auction controls this leakage.

## 3. Per-Block Price Movement

ETH annualized volatility ≈ 70%. With 12-second blocks (2,628,000 blocks/year):

```
σ_block = 0.70 / √2,628,000 ≈ 4.3 bps
E[|ΔP/P|] = 0.8 × σ ≈ 3.4 bps per block
```

Over n blocks, mismatch grows as √n (random walk):

| Blocks | Time | σ (bps) | E[\|δ\|] (bps) |
|--------|------|---------|----------------|
| 1      | 12s  | 4.3     | 3.4            |
| 5      | 1m   | 9.6     | 7.7            |
| 10     | 2m   | 13.6    | 10.9           |
| 25     | 5m   | 21.5    | 17.2           |
| 50     | 10m  | 30.4    | 24.3           |
| 300    | 1h   | 74.5    | 59.5           |

## 4. Arb Profitability Threshold

For a pool with effective liquidity L, a price move δ gives arb profit ≈ δ² × L / 2. An arb is profitable when this exceeds gas cost.

```
L_needed = 2 × gas_cost / σ²_block
```

At current gas (0.43 gwei) with 350k gas per EulerSwap swap:

```
gas_cost = 350,000 × 0.43e-9 × $2,000 = $0.30
L_needed ≈ $3.2M effective liquidity
```

EulerSwap's concentration boost is 200x+ on the WETH/USDC pool (5% range, cx=cy=0, LTVs 0.84/0.85). With $16k deposited at 200x boost, effective liquidity = $3.2M — enough for arbs on nearly every block.

**Implication:** at current gas prices, arbers are already rebalancing the pool continuously. The fee is the only variable — it determines how much of the LVR the LP captures vs gives away.

## 5. Fee as Arb Filter

A fee f means arbers only trade when |δ| > f. Expected blocks until breach:

```
n ≈ (f / σ₁)²
```

| Fee (bps) | Blocks to breach | Time  |
|-----------|-----------------|-------|
| 3.4       | ~1              | 12s   |
| 10        | ~5.4            | 65s   |
| 20        | ~22             | 4.4m  |
| 50        | ~135            | 27m   |

In the continuous limit, total LVR per unit time is σ₁² × L / 2 regardless of fee — the fee just changes whether you get many small arbs or fewer large ones. In practice with discrete blocks, a higher fee does reduce realized LVR: some mismatches never breach f due to mean reversion (price walks to +7 bps then back to 0 without ever being arbed at f = 10 bps). The fee also captures revenue from non-arb flow (retail, rebalancers) that trades when |δ| < f.

## 6. LP Economics Per Arb Event

When mismatch is δ and fee is f (with δ > f), for the constant-product approximation:

| Metric | Formula |
|--------|---------|
| Trade size | ∝ (δ - f) × L |
| Fee revenue to LP | f × (δ - f) × L |
| Adverse selection (value given up) | (δ² - f²) × L / 2 |
| Net LP cost per arb | (δ - f)² × L / 2 |

The net LP cost per arb event is always non-negative: each individual arb extracts more in adverse selection than it pays in fees. But the fee drastically reduces the cost compared to zero-fee: savings = f(2δ - f) × L / 2.

**Note on fee model:** The exact economics depend on how fees are applied (on input, output, or notional) and the curve shape. In some models, there exists a threshold (around δ ≈ 2-3f) below which arbs are net positive for the LP — this can happen when the fee structure means the arber pays more in fees than they extract in adverse selection. The qualitative insight matters more than the exact multiplier: small-mismatch arbs are cheap or free for the LP; large-mismatch arbs are expensive.

**Key implication:** the LP's goal is not to prevent arbs but to keep δ close to f when arbs happen. This is what batching (section 9) and fee calibration achieve. However, as section 16 will show, optimizing arb-side fees is only ~3% of the total opportunity — the dominant value comes from the attract side (retail fee optimization).

## 7. Rebalance = Shift + Auction + Recenter

A rebalance restores delta-neutrality and recenters the pool. Three steps:

1. **Shift** the curve to create an arb opportunity in the clearing direction
2. **Auction** via fee decay so arbers clear the exposure at minimum cost
3. **Recenter** the curve at market price once the marginal price converges to oracle

### Why shift first?

With concentrated pools (high boost), reserves can drift significantly with little marginal price change. The pool could have 50% NAV exposure with only 10 bps of natural mispricing — not enough headroom for a fee auction to work. The shift creates a controlled, large mispricing that the auction can extract at high fees.

The shift alone would be catastrophically expensive — arbers would extract it in one block. The fee starts at the mispricing level and recaptures the value. Net cost per arb = arber's minimum edge only (section 8).

### Equity rebalancing vs recentering

These are distinct operations:

- **Equity rebalancing** = actually trading to clear accumulated directional exposure (ETH equity or ETH debt). The pool shifts the curve + runs a fee-decay auction. Arbers bring liquidity to the pool — the LP pays no slippage.
- **Recentering** = reconfiguring the curve to reflect current market price. After equity clearing, the pool is near-neutral, so the recenter displacement is small. A decaying surcharge protects against any residual arb from recentering error.

### In-pool auction vs external swap

- **In-pool auction (shift + fee decay):** arbers bring liquidity TO the pool. No slippage for the LP. Autonomous, atomic, gas-efficient. The fee decay discovers the market-clearing price for rebalancing.
- **External swap (CowSwap / orderflow router):** the LP goes out to external venues. Non-atomic, timing risk. **Critically, the LP pays slippage** — empirically this dominates the cost, far exceeding gas and swap fees. For leveraged pools with large equilibrium reserves, the rebalance amounts are substantial and external venue depth is often insufficient.

The in-pool auction is strongly preferred. External swaps are reserved for emergencies only.

## 8. Discrete Auction Mechanics

Auction starts at fee s, decays by d per block. Arb triggers at the first block k where |δ(k)| > f(k) = s - k × d.

### Arber surplus at trigger

In a continuous auction, the arber triggers at exactly δ = f and extracts zero surplus. But blocks are discrete, so the arber gets a windfall from two sources: fee granularity (dropped by d since last block) and price randomness (moved by ~σ₁). Arber's edge ≈ d + σ₁, giving profit ≈ (d + σ₁)² × L / 2.

### Optimal decay rate

- d >> σ₁: coarse fee steps, giving away value through granularity
- d << σ₁: fine granularity but price moves dominate — waiting longer for no benefit
- **d ≈ σ₁ ≈ 4.3 bps/block:** arber edge ≈ 2σ₁ ≈ 8.6 bps — the irreducible minimum given 12s blocks

### Expected waiting time (d = σ₁)

| Starting fee s | Blocks | Time  | Fee at trigger |
|----------------|--------|-------|----------------|
| 10 bps         | ~2     | 24s   | ~1 bps         |
| 20 bps         | ~5     | 1m    | ~1 bps         |
| 50 bps         | ~11    | 2.2m  | ~3 bps         |
| 100 bps        | ~20    | 4m    | ~14 bps        |
| 200 bps        | ~35    | 7m    | ~50 bps        |

### Cost per auction

With d = σ₁ and L = $5M, arber profit ≈ 8 × σ₁² × L / 2 ≈ $3.70 — roughly equal to gas cost. The auction is nearly efficient.

### Auction fee floor

The auction fee must never decay below baseFee. If no arber shows up and the fee reaches zero, the pool is left with full mispricing and zero protection — this is exactly V2's bug (section 15, item 5). The decay should be: `f(k) = max(baseFee, s - k × d)`. Once the floor is hit, the auction effectively becomes a fixed-fee regime, which is safe (the pool just waits for δ to accumulate enough to breach baseFee).

### Multi-arb sequences

The analysis above models a single arb resolving the auction. But if the price keeps moving in the same direction after the first arb, the auction may trigger multiple arbs in sequence. Each arb pays the current decaying fee, and each leaks ~(d + σ₁)² × L / 2 in surplus. This is actually fine for the LP — multiple smaller arbs at moderate fees are better than one large arb, and the fee revenue accumulates across fills. The auction should continue decaying after each arb (not reset), since the remaining mispricing is smaller.

**Implementation note:** the decay clock must be set once at auction start and not touched by intermediate arbs. In the contract, `afterSwap` must NOT reset the auction start timestamp when an arb fills during an active auction. This is easy to accidentally break — store `auctionStartBlock` once and compute `f(k) = max(baseFee, s - (block.number - auctionStartBlock) × d)` purely from the original timestamp.

### High residual fee is LP-favorable

The "fee at trigger" column in the table shows substantial residual fees for high starting fees (e.g. 50 bps at s=200). This is good: the LP captures f × (δ - f) × L in fee revenue at each trigger. The arber's edge is still only ~(d + σ₁) ≈ 8.6 bps regardless of f, because the arber's profit depends on (δ - f)², which is small when δ ≈ f + d + σ₁. The high fee extracts revenue from the large trade volume, not from a large per-unit edge.

### Key result

With d ≈ σ₁, the auction leaks roughly one block's worth of LVR regardless of s. The starting fee s controls waiting time, not leakage. Therefore: s should be calibrated to the known mispricing after a recenter — start just above it.

## 9. Interblock Mismatch Variability

### The problem with per-block arbs

The absolute price move per block follows a half-normal distribution with high variance:

```
E[|δ|] = σ × √(2/π) ≈ 3.4 bps
Std[|δ|] = σ × √(1 - 2/π) ≈ 2.6 bps    (CV = 76%)
```

A fixed fee at the mean means ~50% of blocks get arbed. But arber profit (δ - f)² is convex in δ — large-mismatch blocks cost the LP disproportionately more than small-mismatch blocks save (Jensen's inequality).

### Accumulation reduces variance

Over n blocks, the CV shrinks as 1/√n:

| Blocks | E[\|δ\|] | Std of \|δ\| | CV   |
|--------|----------|--------------|------|
| 1      | 3.4 bps  | 2.6 bps      | 76%  |
| 5      | 7.7 bps  | 3.4 bps      | 44%  |
| 10     | 10.9 bps | 4.0 bps      | 37%  |
| 25     | 17.2 bps | 5.1 bps      | 30%  |

### Benefits of batching

1. **Reduces variance of arber surplus.** Accumulated mismatch is more predictable, so fee is better calibrated — arber triggers close to δ ≈ f.
2. **Reduces the convexity penalty.** Total LVR over n blocks is the same, but collected in one event where the fee is better matched.

This argues for starting the fee above σ₁: arbs every few blocks, not every block.

## 10. Model Assumptions and Second-Order Effects

### Fat tails
Real price moves have excess kurtosis. Tail events cost more than Gaussian predicts. Strengthens the batching argument (CLT normalizes over n blocks).

### Volatility is not constant
Realized vol ranges from ~40% to 120%+. Since σ₁ drives optimal decay rate, fee calibration, and arb frequency, these parameters must be dynamic. The hook should track recent realized vol (off-chain agent or on-chain TWAP-derived estimate).

### Gas-volatility correlation
Gas and price vol are positively correlated (high activity = big moves = high gas). This is a natural hedge: when LVR is highest, arbs are most expensive. The current hook captures this via `gasCoeff × √(tx.gasprice)`. Dangerous exception: CEX-driven moves with normal gas.

### Two-leg arb cost
The arber needs a second leg (Uniswap swap: ~150k gas + Uni fee + builder tip). The true arb threshold is higher than single-leg gas cost. The `externalFee` parameter accounts for this.

### Builder/MEV dynamics
Arbers compete via priority fees to builders. This doesn't change LP loss but means the arber's *net* profit is much less than gross. The threshold for "will an arb happen" is gross profit > gas + tip.

### Strategic arber timing
With a decaying fee, a rational arber might wait for a lower fee. Competition pushes toward immediate execution, but with few arbers the timing could be adversarial.

### Residual mispricing
After an arb with fee f, the pool is ~f stale. Next block's mismatch is f_residual + δ_new, growing slightly faster than a pure random walk.

### Curve shape and concentration

Effective liquidity L changes as reserves move from equilibrium. For cx=cy=0, liquidity drops away from eq — second-order for small δ, material for large accumulations. All numerical analysis in this document assumes cx=cy=0 (constant-product). With non-zero concentration (cx, cy > 0), the curve is flatter near equilibrium → higher effective liquidity → more fee revenue but also more adverse selection per arb. The qualitative framework generalizes, but the specific numbers (arb thresholds, fee revenue, etc.) shift. For high-concentration pools (cx → 1), the arb profit per unit mismatch is larger, favoring higher fees and more frequent rebalancing.

### Calibration TODO
For parameter calibration, pull real data from an archive node (mid-2025 onward) — see also experiments 1-2 in section 17, which collect much of this data from our own pool:
- Base fee distribution and spike magnitudes
- ETH per-block price move distribution
- Joint distribution of gas and price volatility
- Realized vol regime dynamics
- Arb frequency on comparable pools (Uniswap V3 USDC/WETH 0.05%)

## 11. Oracle Strategy: Asymmetric Safety

### The core insight

Oracle errors are asymmetric in risk:
- **Overstated mismatch → higher fee:** worst case = no trade. LP safe.
- **Understated mismatch → lower fee:** worst case = value extraction. Dangerous.

### Safe oracle usage

```
f = max(f_theoretical, f_from_oracle_mismatch)
```

- `f_theoretical`: statistical floor (σ₁, gas, vol). Cannot be manipulated.
- `f_from_oracle_mismatch`: reactive, based on Uniswap slot0. Can only push fee *up*.

A manipulated slot0 overstates mismatch → increases fee → protects LP. The attacker cannot lower the fee below the oracle-independent floor.

### slot0 vs TWAP

**Reactive fee component (raising fees):** slot0 is preferable — more responsive, manipulation is safe-direction only, cheaper to read.

**Floor calibration (estimating realized vol):** TWAP is more useful — smoothed, less noisy, good for vol estimation.

### Relationship to current hook

The current hook already approximates this: `baseFee` is the floor, mismatch components only add to it. The audit finding C1 ("slot0 is manipulable") doesn't apply here because the oracle can only raise fees, never lower them below the floor.

## 12. Retail Flow and the Fee-Staleness Tradeoff

### The three-way tension

The fee level creates a tradeoff between LVR capture, retail competitiveness, and price freshness:

- **Fee too high (arbs every ~25+ blocks):** pool stale by 15-20+ bps. Uncompetitive even on the good side. Aggregators route around. Zero retail volume.
- **Fee too low (arbs every block):** fresh pricing, competitive for retail. But arbers extract full LVR. LP subsidizes arbers.
- **Sweet spot (arbs every ~5-10 blocks):** staleness ~8-14 bps. Retail on attract side gets a good deal (stale price in their favor + moderate fee). Arbs frequent enough for freshness, infrequent enough for fee capture.

### Staleness creates attract-side advantage

When the pool is 10 bps stale, a retail trader going opposite to the arb direction gets 10 bps of free price improvement. With a 5 bps fee they're 5 bps ahead of a perfectly-priced pool. Moderate staleness + low attract fee makes the pool the best price for one direction.

### Routing headroom: the bigger opportunity

Evidence from the AMM challenge (a fee strategy competition against a 30 bps normalizer AMM) revealed that **97% of the gap between actual and oracle-optimal performance came from undercharging retail, not from arb losses.** When the competing pool (analogous to Uniswap) is stale, there's substantial "routing headroom" — the maximum fee we can charge while still winning the routing. In the competition, 40% of retail trades had >20 bps of headroom above what was actually charged.

This reframes the optimization priority: **the attract-side fee should not simply be "low" — it should be as high as possible while still winning the routing.** The headroom depends on the competitor's staleness, which varies per block.

**Implementation:** the hook already reads Uniswap slot0 for mismatch detection. To estimate routing headroom, it also needs the competitor's fee tier — this is the existing `externalFee` parameter (e.g. 5e14 = 5 bps for the Uni 0.05% pool). The headroom is approximately: `headroom = |uniPrice - poolPrice| + externalFee` on the attract side (our stale price is in the trader's favor, plus they'd pay Uni's fee elsewhere). The attract fee can be raised up to this headroom while still winning the routing. This is a natural extension of the existing mismatch calculation, not a new oracle dependency.

### Routing is nonlinear in fees

Aggregator order splitting equalizes marginal prices across pools post-trade. For two constant-product AMMs, the flow allocation to pool i is proportional to `A_i = √(x_i × (1 - f_i) × y_i)`. This means:
- Small fee differences shift large fractions of volume (nonlinear sensitivity)
- A pool with fresher prices AND lower fees captures disproportionately more flow
- Even 1-2 bps of fee advantage matters for volume capture
- But the relationship is continuous, not winner-take-all: a slightly more expensive pool with better price still gets partial flow

**Generalization caveat:** this formula is for two constant-product pools. Real aggregators route across many venues with different curve shapes (Uni V3 concentrated liquidity, Curve stableswap, etc.). The qualitative point — nonlinear fee sensitivity and partial flow allocation — holds generally, but the exact formula changes. With n venues, the pool competes against the best available alternative at each price point, not a single normalizer. This makes the headroom calculation harder but the principle the same: charge up to but not above the point where the marginal trader routes elsewhere.

### Aggregator routing

The pool doesn't need to be competitive on both sides — only on the attract side. Aggregators naturally route attract-side flow here and arb-side flow elsewhere. For this to work:
1. Pool must be registered and indexed by routing APIs
2. `computeQuote` (which calls `getFee`) must reflect the attract-side discount
3. Aggregators compare net price including fee and staleness

## 13. Boundary Conditions and Structural Constraints

The fee optimization operates within hard constraints from the pool's leverage and structure.

### Health and exposure are the same problem

The pool is leveraged. Health = collateral × LTV / debt. If health < 1, the position is liquidated. Health degrades as reserves move toward the boundary — which is exactly when directional exposure is highest. Solving delta-neutrality (keeping exposure near zero) keeps reserves near equilibrium, which keeps health near its initial value. They are close to being the same problem.

The only divergence is from external factors: vault interest rate spikes or oracle price changes affecting collateral valuation independently of pool reserves. But for the pool's own dynamics, maintaining neutrality maintains health.

This simplifies monitoring: the agent doesn't need separate health and exposure tracking. It monitors exposure and rebalances. Health follows.

### Directional exposure is asymmetrically dangerous

For GBM, directional exposure has symmetric expected returns — wins and losses are equally likely, and in expectation the exposure is neutral. Being temporarily exposed isn't a problem per se.

But consequences are asymmetric:
- **Large loss → liquidation.** Catastrophic: forced unwind with penalties, permanent capital reduction, reduced future fee-earning capacity.
- **Large gain → excess reserves.** Upside is capped: excess sits idle until rebalanced, doesn't compound.

This is gambler's ruin: the downside is absorbing (out of the game), the upside is bounded. **The goal of rebalancing is not to maximize expected returns but to avoid tail losses that take you out of the game.**

### Sustained losses erode earning capacity

Even short of liquidation, losses create a negative feedback loop: less equity → lower boost → less liquidity → less fee revenue → slower recovery. The rebalancing mechanism must prevent this spiral.

### Fee-to-rebalance handoff

Two mechanisms handle different scales:

- **Continuous fee (getFee):** routine block-to-block arbs, small mismatches (< ~50 bps). Steady-state regime.
- **Discrete rebalance (reconfigure):** sustained directional moves pushing reserves toward boundary. State change: new eq price, new range.

The handoff trigger is exposure-based: when directional exposure exceeds a threshold, rebalance. Exposure = `(eq - reserve) / (eq - min)` for the deficit side (formal definition in section 21). Since health and exposure track together (see above), this is equivalent to a health-based trigger without requiring expensive vault state reads on-chain. Not absolute reserves (V2's mistake) or NAV percentage (V3, better but still imperfect) — exposure as fraction of the range consumed.

**Rough heuristic:** trigger when reserves have moved past ~30-50% of the range (α = 0.3-0.5). At α = 0.5 with a 5% range, the pool has ~250 bps of mispricing and health margin is roughly half consumed. This leaves buffer for the rebalance to complete. The trigger should be tighter (lower α) for higher-leverage pools and looser for lower leverage. The agent tunes based on observed rebalance costs and frequency.

### Boundary behavior

At `minReserves`, the pool is one-sided. This is the worst time to rebalance: maximum exposure, least flexibility, highest cost. Rebalancing earlier is cheaper but leaves potential fee revenue on the table. The trigger balances cost vs risk.

### Interest cost

For net profitability: `fee_revenue + attract_revenue > LVR_cost + interest_cost + rebalance_cost`. Interest accrues on leveraged debt. Clearing exposure via rebalance reduces interest costs directly.

### Range width

Tighter range = higher boost = more fees, but faster boundary hits and more frequent rebalancing. Wider range = lower boost = less fees, but more health margin and less rebalancing. Optimal range jointly minimizes total costs minus total revenue. Should be re-evaluated as market conditions change.

### Fee-mismatch feedback loop

Larger mismatch → higher fee → arber needs bigger mismatch → more accumulation. During fast directional moves, this feedback can overwhelm the continuous fee mechanism, requiring a discrete rebalance — which is the handoff trigger.

**Stability analysis:** with a fixed baseFee, the loop is self-limiting — mismatch grows as √n but the fee is constant, so eventually δ > f and an arb fires. With dynamic fees that increase with mismatch (like the oracle-reactive component), the question is whether fee growth outpaces mismatch growth. Since mismatch grows as √n and the oracle-reactive fee tracks the oracle's mismatch reading (also √n-like), they grow at the same rate → stable equilibrium where arbs happen at roughly constant intervals. The system only becomes unstable if the fee formula amplifies mismatch super-linearly, which the `max(baseFee, ...)` floor prevents.

### Steady-state fee: dynamic or fixed?

Between agent interventions, should the on-chain fee be static (fixed baseFee) or self-adjusting?

- **Fixed baseFee** (current approach): simple, predictable. Agent updates baseFee periodically based on realized vol. Between updates, the fee may be stale if vol regime shifts.
- **Dynamic baseFee** (self-adjusting): the hook could track recent arb frequency or price deviation and adjust baseFee on-chain. More responsive but adds complexity, state, and gas cost. Risk of adversarial manipulation of the adjustment mechanism.

The "simple on-chain" principle favors fixed baseFee with agent updates. The oracle-reactive component already provides real-time responsiveness for fee increases. The main gap is fee decreases after vol drops — the agent handles this on a slower timescale, which is acceptable since a too-high fee is safe (just less competitive).

## 14. Complexity and Implementation Strategy

### The complexity tradeoff

Every line of Solidity in the hook costs: gas per swap (reduces competitiveness), audit surface (V2's simple auction already had multiple high-severity bugs), parameters to tune (more ways to misconfigure), and cognitive overhead for maintenance.

### Simple on-chain, sophisticated off-chain

**On-chain (hook) — robust primitives:**
- baseFee floor (manipulation-proof)
- Oracle-boosted fee (slot0, can only raise above floor)
- Time-based linear decay (one storage slot)
- afterSwap exposure check (reconfigure when health margin consumed)

**Off-chain (agent) — complex optimization:**
- Adjust fee params based on realized vol, gas, interest rates
- Monitor health, trigger rebalance as backup
- Backtest and grid-search parameter space
- Handle edge cases (stuck auctions, failed reconfigures)

If the agent is wrong, on-chain primitives still protect the LP. If the agent is down, the pool operates safely but suboptimally.

### Finding optimal parameters

The surface is high-dimensional and nonlinear. Not analytically solvable. Approach:

1. **Theory** (this document) defines structure and rules out bad regions
2. **Simulation** against historical block data identifies promising parameter regions
3. **Deploy conservatively** (higher fees, wider margins)
4. **Monitor** actual performance (fee revenue, LVR, arb frequency, health)
5. **Agent adjusts** parameters toward observed optimum
6. **Re-evaluate** as market conditions change

Parameters must be hot-swappable without redeployment (already the case via `setFeeParams` / `setAuctionParams`).

### Contract design principles

- Minimal state (fewer inconsistency risks)
- Hot-swappable parameters
- Clean separation: fee logic (getFee) vs rebalance logic (afterSwap)
- Events on every state change (for off-chain monitoring)
- Prefer 90% optimal + simple + auditable over 99% optimal + complex + fragile

## 15. V2 Auction Issues (Reference)

Problems with the current V2 hook auction, for reference when designing the replacement:

1. **Double incentive:** priceY shift + decaying fee. Arber gets both — LP double-pays.
2. **Absolute thresholds:** fixed uint112 values don't scale with NAV.
3. **Clearing = trigger threshold:** auction runs until fully restored, not "good enough."
4. **eq = currentReserves hack:** distorts curve shape during auction.
5. **Fee decays to zero:** no floor on auction fee.
6. **Silent reconfigure failure:** can leave pool in inconsistent state.

## 16. Lessons from AMM Fee Challenge

The AMM challenge (ammchallenge.com) was a fee strategy competition for a constant-product AMM. Participants designed dynamic fee strategies to maximize "edge" (fair-price-marked P&L) against a 30 bps normalizer AMM with optimal order routing between them. Key constraints: no external oracle, no beforeSwap hook, 32 storage slots, fee-on-input. Despite these limitations, the findings generalize.

### Winning strategy structure

The best strategies all converged on: **Bayesian fair price estimation → soft arb probability → confidence-scaled asymmetric fees.** Hard classification (arb vs retail thresholds) always lost to soft probability estimates. The winning formula:
1. Maintain a posterior distribution over the fair price (log-normal)
2. Update on each trade using truncated normal likelihood (the fee constrains where the fair price can be)
3. Compute arb probability from likelihood ratio
4. Set asymmetric fees: high on protect side (arb direction), low on attract side, scaled by confidence

This maps to our design, but with a critical placement distinction: the Bayesian posterior is an **off-chain agent** concern, not on-chain. Maintaining a log-normal posterior with truncated normal likelihood updates in Solidity would be prohibitively expensive in gas and complexity. Instead, the agent maintains the posterior off-chain and pushes updated fee parameters (baseFee, attractRate, captureRate) to the hook periodically. The on-chain hook uses the simpler oracle-reactive formula, which the agent's Bayesian estimates help calibrate. We also have oracle access (Uniswap slot0) which the competition lacked — our fair price estimate should be strictly better.

### The retail fee optimization insight

Oracle analysis showed the gap between actual and perfect-information performance broke down as:
- **97% from retail fee optimization** (undercharging on attract side when routing headroom existed)
- **3% from arb IL reduction** (better arb identification)

This was surprising. The dominant opportunity is not better arb protection but **charging more on retail trades when you have a routing advantage.** The competition's oracle strategy charged 200-600 bps on high-headroom trades where the normalizer was stale, vs ~35 bps actually charged.

### Confirmed dead ends

Extensive parameter sweeps (500+ experiments) confirmed these approaches hurt or didn't help:
- **Realized vol scaling** of fees on a per-trade basis: -41 edge (catastrophic). Vol estimate is too noisy to be useful for per-trade fee adjustment. This does NOT mean vol-aware fees are bad — agent-timescale updates to baseFee based on recent realized vol (e.g. hourly/daily) are still correct. The failure is specifically about adjusting fees *within* the hook based on a running vol estimate: the estimate lags, overshoots, and gets gamed.
- **Fee spike decay** (memory of recent fees): always negative. Each trade should be priced independently.
- **Attract boost after arbs** (lower attract fee right after arb): -0.2 at best. Not worth the complexity.
- **Hard classification** (binary arb/retail): always worse than soft pArb.
- **Dynamic alpha** (adaptive learning rate): no improvement. Fixed rate optimal.

### Implications for our hook design

1. **On-chain:** the hook already has asymmetric fees (captureRate vs attractRate). The key addition is **routing-aware attract fees** — charging up to the headroom allowed by competitor staleness, not a fixed low rate.
2. **Off-chain agent:** Bayesian fair price tracking is the optimal estimation approach. The agent should maintain a posterior and update fee parameters based on confidence and routing headroom.
3. **The baseFee floor is essential** — both for manipulation safety and because the competition confirmed that per-trade fee memory hurts. Each trade should face at least baseFee regardless of history.
4. **Don't over-optimize arb protection.** The fee formula for the arb side is already close to optimal (gasCoeff + captureRate). The bigger wins come from the attract side.

**Generalization caveat:** the competition used a single 30 bps normalizer AMM. In production, the pool competes against multiple venues (Uni V3 0.05%, 0.3%, Curve, 1inch routing across dozens of sources). The 97/3 split may not hold exactly — with more competitors, routing headroom shrinks as there's usually *some* venue with a fresh price. But the qualitative finding holds: attract-side optimization is the larger lever, even if the magnitude is smaller than the single-competitor case.

## 17. Competitive Landscape (March 2026)

Uniswap pool data for the pairs we care about, as context for fee calibration and target selection.

### WETH/USDC (primary target)

| Pool | Fee | TVL | 1D Vol | 30D Vol | APR | Vol/TVL |
|------|-----|-----|--------|---------|-----|---------|
| v3 0.05% | 5 bps | $46.2M | $61.1M | $3.0B | 24.2% | 1.32 |
| v3 0.3% | 30 bps | $73.2M | $47.6M | $1.9B | 71.2% | 0.65 |
| v3 0.05% (#2) | 5 bps | $12.5M | $19.2M | $959M | 28.2% | 1.54 |
| v2 0.3% | 30 bps | $4.1M | $310K | $12.3M | 8.4% | 0.08 |

The 0.05% pool dominates volume. The 0.3% pool has more TVL but less volume — it survives on the trickle of flow routed when its stale price happens to be attractive (the routing headroom effect in action). The second 0.05% pool at $12.5M TVL still gets $19M/day — confirms smaller pools can compete if they're at the right fee tier.

### WETH/USDT

| Pool | Fee | TVL | 1D Vol | 30D Vol | APR | Vol/TVL |
|------|-----|-----|--------|---------|-----|---------|
| v3 0.01% | 1 bps | $6.0M | $30.3M | $1.9B | 18.5% | 5.07 |
| v3 0.05% | 5 bps | $13.1M | $16.5M | $934.8M | 22.9% | 1.25 |
| v3 0.3% | 30 bps | $56.6M | $10.6M | $678.6M | 20.6% | 0.19 |

Striking: the 1 bps pool with only $6M TVL does 5x vol/TVL — the most capital-efficient pool on Uniswap. Lowest fee wins volume decisively. Our secondary oracle (WETH/USDT 0.01%) is this pool.

### USDC/USDT (stablecoin, different dynamics)

| Pool | Fee | TVL | 1D Vol | 30D Vol | APR | Vol/TVL |
|------|-----|-----|--------|---------|-----|---------|
| v4 0.08 bps | 0.08 bps | $12.5M | $44.3M | $5.4B | 1.03% | 3.54 |
| v4 0.1 bps | 0.1 bps | $15.3M | $56.4M | $2.5B | 1.35% | 3.69 |
| v3 0.01% | 1 bps | $22.0M | $3.7M | $528M | 0.62% | 0.17 |

v4 has completely eaten v3 for stablecoins. Sub-1 bps fees doing 3.5x+ vol/TVL. The v3 1 bps pool is dying (0.17 vol/TVL). Stablecoin LPing is razor-thin margins at massive volume — a different game from WETH/USDC.

### WBTC pairs (future expansion)

| Pair | Best pool | TVL | 1D Vol | 30D Vol | APR | Vol/TVL |
|------|-----------|-----|--------|---------|-----|---------|
| WBTC/ETH | v3 0.05% | $54.4M | $40.8M | $2.1B | 13.7% | 0.75 |
| WBTC/USDT | v3 0.05% | $16.7M | $12.9M | $750M | 14.1% | 0.77 |
| WBTC/USDC | v4 0.05% | $6.7M | $6.7M | $250M | 18.1% | 0.99 |

WBTC has lower vol/TVL than ETH pairs (less arb activity, fewer retail swaps). But APRs are solid and liquidity is meaningful. Lower vol = lower σ₁ = different fee calibration. Worth considering after WETH/USDC is proven.

### Key takeaways for our design

1. **0.05% (5 bps) is the dominant fee tier for volatile pairs.** This is our primary competitive reference. Charging 5 bps flat would make us indistinguishable from Uniswap — we need dynamic fees to differentiate.
2. **The 0.3% pool paradox.** High APR despite low volume. This is pure routing headroom extraction — when the 0.3% pool's stale price is attractive, aggregators route there and it charges 6x more per trade. Our hook can do this dynamically instead of relying on a fixed high fee.
3. **Vol/TVL > 1 is the benchmark.** Capital-efficient pools turn over their TVL daily. With 200x boost, our $16K deposit should target vol/TVL comparable to the best pools.
4. **v4 is the future for stablecoins.** If we build a USDC/USDT pool, we're competing against sub-1 bps fees. The hook would need to be extremely gas-efficient. Different strategy than volatile pairs.
5. **Multiple pools per pair coexist.** We don't need to be the biggest — aggregators split flow across venues. Even a $12.5M pool gets $19M/day in ETH/USDC. Our effective liquidity of $3.2M can capture meaningful flow if fees are competitive.
6. **Low-fee pools are capital-efficient, high-fee pools are revenue-efficient.** ETH/USDT 0.01% does 5x vol/TVL but only 18.5% APR. ETH/USDC 0.3% does 0.65x vol/TVL but 71% APR. Our dynamic fee can aim for both: routing-optimal fee on attract side (as high as headroom allows while still winning volume) + high fee on arb side (captures revenue).

### Target pools for experiments

- **WETH/USDC (active):** primary test pool. Deepest market, most arb data, well-understood oracle (Uni 0.05% as reference).
- **USDC/USDT (planned):** already have a pool deployed. Very different dynamics: near-zero vol, tight peg, sub-1 bps competition. Tests whether the hook design generalizes to stablecoins.
- **WBTC/ETH (future):** lower vol pair, different σ₁ calibration. Tests parameter sensitivity. Large Uniswap pools available as oracle.

## 18. Empirical Validation Experiments

The analysis above rests on theoretical predictions that can be tested on the live pool with minimal capital at risk.

### Experiment 1: Mismatch distribution (zero cost)

Read-only data collection. Every block, record Uniswap V3 spot price and our pool's marginal price. Over a few days this gives:
- Empirical σ₁ (per-block vol) vs the theoretical 4.3 bps
- Distribution shape: is it Gaussian? Fat tails? How much excess kurtosis?
- Autocorrelation: are big moves clustered?
- n-block averaging: does accumulated mismatch variance scale as 1/n per CLT?

### Experiment 2: Gas-volatility correlation (zero cost)

Same data collection: for each block, record base fee alongside |price change|. Compute:
- Pearson correlation between gas and |δ|
- Joint distribution during different vol regimes
- Whether the "natural hedge" (high gas when high vol) holds empirically

### Experiment 3: Fixed-fee arb frequency (small cost)

Set a known fixed fee (e.g. 3, 5, 10 bps) and log every swap for 24-48 hours at each level. Measure:
- Time between arbs (blocks) — compare to prediction: n ≈ (f/σ₁)²
- Mismatch at moment of arb — should be ~f + gas threshold
- Direction sequence: alternating or streaky?
- Arb size as fraction of equilibrium

At 5 bps with σ₁ ≈ 4.3 bps, theory predicts arbs every ~1-2 blocks. At 10 bps, every ~5 blocks.

### Experiment 4: Stepped fee ladder (small cost)

Run 3 bps for 2 days, then 5, 10, 20 bps. For each tier measure:
- Arb frequency and size
- Retail volume (non-arb swaps)
- Total fee revenue
- LP P&L vs HODL

Maps the fee-revenue curve empirically. Theory predicts a sweet spot — this finds it.

### Experiment 5: Auction decay test (moderate cost)

Trigger a manual rebalance, set a decaying fee starting at ~20 bps, decaying at ~σ₁ per block. Measure:
- Blocks until first arb
- Single arb or multiple?
- Arber surplus vs theoretical prediction ((d + σ₁)² × L / 2)

Most directly validates the auction design, but most complex to set up.

### Experiment 6: Oracle accuracy (zero cost)

For each block, record Uniswap V3 slot0 price, TWAP (5m, 30m windows), and Chainlink. After the fact, compare each to the "realized" price (the price that actually got arbed to). Measures:
- Which oracle source is tightest
- How much fee headroom each gives
- TWAP lag characteristics across different vol regimes

### Current pool advantage: pure toxic flow

The USDC/WETH pool is not currently indexed by aggregators, so all swap volume is pure arb flow. This is unusually clean data — no need to classify swaps as arb vs retail, no noise from rebalancers or MEV bots doing non-directional trades. Every swap is a direct measurement of arb behavior: trigger threshold, timing, size, and surplus. This makes experiments 1-5 especially high-signal. Once the pool is registered with aggregators, this clean separation is lost.

### Recommended order

Start with experiments 1+2 (zero cost, foundational data), then experiment 3 (small cost, highest signal for fee calibration). Experiments 4-6 build on earlier findings. Much of the infrastructure already exists in the agent's swap logging.

## 19. Design Principles Summary

1. **Prevention over cure.** Calibrate fees to cover expected rebalance costs. Most imbalances should be handled by routine arb flow.
2. **The fee controls the cost.** The eq price shift creates the clearing arb opportunity; the fee — starting at the mispricing level — recaptures the value. The shift is the mechanism, the fee is the cost control.
3. **Optimal decay rate = σ₁.** ≈ 4.3 bps/block. Faster wastes through granularity, slower gains nothing.
4. **Batch blocks to reduce variance.** Arbs every ~5-10 blocks, not every block. Accumulated mismatch is more predictable, fee is better calibrated.
5. **Starting fee = known mispricing.** After recenter, start just above the mispricing so arbers take a minimal cut.
6. **Oracle can only raise fees.** f = max(floor, oracle_mismatch). Manipulation-safe by design.
7. **Rebalance trigger = exposure-based.** Handoff from continuous fees to discrete rebalance when directional exposure grows. Health and exposure track together — solving neutrality solves health.
8. **Directional exposure is a risk management problem.** Rebalance to avoid tail losses (liquidation, capital erosion), not to optimize expected returns.
9. **Autonomous on-chain, tuning off-chain.** The hook handles the full rebalance cycle (shift + auction + recenter) autonomously. The agent only tunes parameters on a slow timescale.
10. **Attract-side fees are the bigger opportunity.** Most LP value comes from charging up to routing headroom on retail, not from arb protection refinements. Charge as much as the routing allows, not a fixed low rate.
11. **Price each trade independently.** Fee memory (spike decay, attract boost after arbs) always hurts. baseFee floor + oracle-reactive component, no history dependence.
12. **Design for iteration.** Hot-swappable parameters, minimal state, comprehensive events. Theory narrows the search space, empirical search finds the optimum.

## 20. V1-V3 Recap and Lessons

Before proposing new designs, a summary of what was built and what we learned.

### V1: Oracle-Reactive Asymmetric Fees (getFee only)

The baseline. Reads Uniswap V3 slot0, computes mismatch vs pool marginal price, returns asymmetric fees (high on arb side via captureRate, moderate on attract side via attractRate). Gas-aware threshold via gasCoeff × √(tx.gasprice). No afterSwap — purely passive fee adjustment.

**What worked:** the fee formula is sound. Oracle-can-only-raise-fees is safe. Gas threshold adapts to network conditions. Asymmetric fees are the right structure.

**What was missing:** no autonomous rebalancing. The agent must intervene manually when the pool drifts. Fine for learning, insufficient for production.

### V2: Absolute Reserve Thresholds + Debt Auction

Added afterSwap with auction: when reserves drop below absolute thresholds, the hook triggers an auction mode. Shifts priceY off-market by auctionDelta, decays fee from auctionStartFee toward zero, restores pool when reserves return above thresholds.

**Bugs identified (section 15):**
1. Double incentive: priceY shift + decaying fee → LP double-pays
2. Absolute thresholds don't scale with reconfiguration
3. Clearing requires full return to threshold (too strict)
4. Sets eq = currentReserves (distorts curve shape)
5. Fee decays to zero (no floor)
6. Silent reconfigure failures

### V3: Exposure-Based Triggers

Fixed V2's threshold problem: triggers based on exposure as % of NAV instead of absolute reserve levels. Better boundary placement with asymmetric factors. Clearing requires return to pre-auction equilibrium.

**What V3 fixed:** threshold scaling (#2). **What V3 didn't fix:** #1, #4, #5 remain. The priceY shift and eq=reserves hack are still present. Fee still decays to zero.

### Key takeaway

The fee logic (V1 getFee) is good. The auction logic (V2/V3 afterSwap) has fundamental design issues. The new designs preserve the fee formula and rethink the auction from scratch.

## 21. V4 Hook Design

Fully autonomous hook. Two modes: normal and equity clearing. No agent needed for the core loop — the hook handles exposure detection, equity clearing via fee-decay auction, and recentering. The agent only tunes parameters on a slow timescale.

Pool sets `swapHookedOperations = GET_FEE | AFTER_SWAP` (0x06).

### Overview

**Normal mode.** Oracle-reactive asymmetric fees with routing-aware attract pricing, plus a decaying surcharge that protects against recentering errors. The surcharge activates after any reconfigure (equity clearing completion, initial deployment, agent parameter updates) and decays to zero over a few blocks. Most of the time the surcharge is zero and the fee is purely oracle-reactive.

**Equity clearing mode.** When directional exposure — ETH equity or ETH debt — crosses a threshold, the hook reconfigures the curve to create a large arb in the clearing direction and runs a fee-decay auction. Arbers trade to clear the exposure at minimum cost. Once the marginal price converges back to the oracle price (within `clearThreshold`), the hook recenters at market and returns to normal mode.

### Exposure metric (trigger)

The hook measures directional exposure as the fraction of range consumed on each side:

```
exposure0 = (eq0 - reserve0) / (eq0 - min0)    if reserve0 < eq0
exposure1 = (eq1 - reserve1) / (eq1 - min1)    if reserve1 < eq1
exposure = max(exposure0, exposure1)
```

At equilibrium (reserve = eq): exposure = 0. At boundary (reserve = min): exposure = 1.0 (100% of range consumed, pool is one-sided). The deficit side is whichever has higher exposure.

This metric is used **only in normal mode** to trigger auctions. It is NOT used during auction mode — clearing uses price convergence instead (see Step 3). The metric directly tracks health: at the boundary, debt = eq - min, which is the maximum borrowing. So exposure = fraction of max debt consumed. Triggering at 15% means the pool has used 15% of its max borrowing capacity on the deficit side.

**Why range-based, not reserve-based.** Using `reserve / eq` (as a percentage of virtual reserves) is meaningless for boosted pools — virtual reserves are orders of magnitude larger than real equity. A 1% reserve change could represent 100% of the equity. The range `(eq - min)` captures the actual tradeable depth where health degrades.

### afterSwap logic (both modes)

```
function afterSwap(... reserve0, reserve1):
    if !auctionActive:
        // Normal mode: check if exposure warrants equity clearing
        d = pool.getDynamicParams()
        (exposure, asset0Deficit) = computeExposure(reserve0, reserve1, d)
        if exposure > equityTriggerThreshold:
            startEquityClearing(reserve0, reserve1, asset0Deficit, d)

    else:
        // Auction mode: check if arb has been consumed (price convergence)
        if block.number >= auctionStartBlock + minAuctionBlocks:
            uniPrice = getUniswapPrice()
            marginalPrice = getMarginalPrice(reserve0, reserve1)
            priceDiff = |marginalPrice - uniPrice| / uniPrice
            if priceDiff < clearThreshold:
                endAuctionAndRecenter(reserve0, reserve1)
```

### Normal mode getFee

```
uniPrice = getUniswapPrice()         // Uniswap V3 slot0
poolPrice = getMarginalPrice(reserve0, reserve1)
mismatch = |uniPrice - poolPrice| / uniPrice

if isArbDirection:
    gasThreshold = gasCoeff × √(tx.gasprice)
    netEdge = mismatch - gasThreshold - baseFee - externalFee
    fee = baseFee + captureRate × max(0, netEdge)

if isAttractDirection:
    headroom = mismatch + externalFee
    fee = baseFee + attractRate × headroom

// Surcharge: decays to zero after any reconfigure
fee += currentSurcharge()

return min(fee, maxFee)
```

**Attract-side formula** (key improvement over V1). In V1, attract fee was `baseFee + attractRate × max(0, mismatch - gasThreshold)` — often just baseFee, because gasThreshold ate the mismatch. The new formula:
- Removes gasThreshold subtraction (gas is the arber's problem, not the trader's)
- Adds externalFee (the trader would pay this at Uniswap)
- attractRate controls what fraction of routing headroom the LP captures (0.5 = take half, leave half as trader incentive)

**Numerical example:**
- Pool is 15 bps stale, externalFee = 5 bps, baseFee = 3 bps, attractRate = 0.5
- V1 attract fee: `3 + 0.3 × max(0, 15 - 6) = 5.7 bps`
- V4 attract fee: `3 + 0.5 × (15 + 5) = 13 bps`
- Trader's alternative: Uniswap at 5 bps fee + 15 bps worse price = 20 bps total cost
- Our 13 bps is 7 bps cheaper. Trader happy. LP earns 7.3 bps more per trade.

**computeQuote compatibility:** `computeQuote` calls `getFee(readOnly=true)`, which returns the attract-side fee. Aggregators see the real net-of-fee quote and route accordingly. No special integration needed.

**Surcharge.** An additive fee component that decays to zero over a configurable number of blocks after any reconfigure. Protects against arb leakage from recentering errors — whether from equity clearing completion, initial hook deployment, or agent parameter updates that change the curve. If the recenter was clean (marginal price ≈ market), no arb arrives and the surcharge decays harmlessly. If the recenter was slightly off, an arb trades and the surcharge captures most of the error. The surcharge decays to zero (not to baseFee) because it's additive to the already-floored normal fee.

### Equity clearing mode

Triggered when directional exposure crosses a threshold. Works symmetrically for both directions.

#### Shift direction logic

The EulerSwap curve has a natural mispricing when reserves drift from equilibrium. For c=0:
- Branch 1 (reserve0 ≤ eq0): marginalPrice = px × eq0² / (py × reserve0²)
- At equilibrium: marginalPrice = px/py = eq price

When **asset0 is deficit** (reserve0 < eq0), marginalPrice > eq price > market. The pool already overprices asset0 — arbers are already incentivized to sell asset0 to us. The shift must **amplify** this by making marginalPrice even higher, which means **decreasing py** (increasing px/py).

When **asset1 is deficit** (reserve1 < eq1), marginalPrice < market. The shift must amplify this by **increasing py** (decreasing px/py).

**Key insight:** the shift amplifies existing mispricing, not creates new mispricing in a different direction. The natural mispricing is always in the correct direction for clearing — it's just too small in concentrated pools. The shift makes it large enough for a fee-decay auction.

Summary:
- **Asset0 deficit** (short asset0): decrease py → amplify asset0 overpricing → arbers sell asset0 to us
- **Asset1 deficit** (short asset1): increase py → amplify asset0 underpricing → arbers sell asset1 to us

This matches V3's direction (V3 line 371-379). Verified against the curve math: decreasing py when reserve0 < eq0 increases px × eq0² / (py × reserve0²).

#### Step 1: Shift curve to create clearing arb

When `afterSwap` detects exposure exceeds the equity or debt trigger threshold, it starts the auction:

```
// Already inside: if !auctionActive && (equityExposure > threshold || debtExposure > threshold)
    // Snapshot pre-shift price for recenter safety clamping
    preShiftPriceY = currentPriceY

    // Shift eq price to AMPLIFY existing mispricing in clearing direction
    if isAsset0Deficit:
        priceY *= WAD / (WAD + shiftMagnitude)    // decrease py → increase marginal price
    else:
        priceY *= (WAD + shiftMagnitude) / WAD    // increase py → decrease marginal price

    // Set eq reserves = current reserves so curve invariant holds at shifted price
    eqReserves = currentReserves
    minReserves = (0, 0)     // relax boundaries during auction

    pool.reconfigure(
        dynamicParams with shifted priceY, eqReserves, minReserves,
        InitialState(reserve0, reserve1)    // vault positions unchanged
    )

    // Start fee auction at the mispricing level
    auctionActive = true
    auctionStartBlock = block.number
    auctionStartingFee ≈ shiftMagnitude   // first-order approximation
    auctionClearAsset0 = isAsset0Deficit   // want the deficit asset IN
    emit AuctionStarted(auctionStartingFee, block.number, auctionClearAsset0)
```

The shift amplifies the existing arb opportunity. The fee starts at the mispricing level, recapturing the value. Without the fee, arbers would extract the full mispricing in one block. With the fee matching the mispricing, arbers have zero edge on block 1. Each subsequent block the fee decays by d ≈ σ₁, and arbers trade at minimum viable edge ≈ d + σ₁. Net cost per arb ≈ (d + σ₁)² × L / 2 — the theoretical minimum (section 8).

**Why the shift is needed.** With concentrated pools (high boost), reserves can drift significantly with little marginal price change. The pool could have 50% NAV exposure with only 10 bps of natural mispricing — not enough headroom for a fee auction. The shift creates a controlled, large mispricing that the auction can work with.

**Why this avoids V2's double-incentive bug.** V2 shifted the price AND started the fee low — both giving value to arbers, LP double-paid. Here the shift creates the opportunity but the fee starts at the mispricing level and recaptures it. Net cost = arber's minimum edge only.

#### Step 2: Fee-decay auction

getFee in equity clearing mode:

```
if auctionActive:
    elapsed = block.number - auctionStartBlock
    auctionFee = max(baseFee, startingFee - elapsed × decayPerBlock)

    if swap is clearing direction:
        return auctionFee
    else:
        // Allow non-clearing trades at elevated fee.
        // Blocking them loses revenue during auction windows.
        return max(auctionFee, normalFee())
```

Arbers gradually clear the exposure as the fee decays. Non-clearing trades are allowed at the higher of the auction fee or normal oracle-reactive fee — preserving retail revenue without undercutting the clearing side.

#### Step 3: Recenter and return to normal

afterSwap detects price convergence (marginal price ≈ oracle price):

```
if auctionActive && block.number >= auctionStartBlock + minAuctionBlocks:
    marginalPrice = getMarginalPrice(reserve0, reserve1)
    oraclePrice = getUniswapPrice()
    priceDiff = |marginalPrice - oraclePrice| / oraclePrice
    if priceDiff < clearThreshold:
    auctionActive = false

    // Recenter: eq price to current market, clamped for safety
    oraclePrice = getUniswapPrice()
    newPriceY = priceX * WAD / oraclePrice

    // Safety: clamp to within maxRecenterDrift of pre-shift price
    maxPY = preShiftPriceY × (1 + maxRecenterDrift)
    minPY = preShiftPriceY / (1 + maxRecenterDrift)
    newPriceY = clamp(newPriceY, minPY, maxPY)

    // Compute min reserves from recenterRange using curve math:
    //   minReserve = eq / sqrt(1 + r/(1-c))
    // where r = recenterRange, c = concentration
    // This defines the price range the pool supports after recenter.
    // Calibrate r so that h=1 at the boundary for the pool's leverage/LTV.
    minReserve0 = reserve0 * sqrt(WAD) / sqrt(WAD + r * WAD / (WAD - cx))
    minReserve1 = reserve1 * sqrt(WAD) / sqrt(WAD + r * WAD / (WAD - cy))

    pool.reconfigure(
        dynamicParams with newPriceY, eqReserves = currentReserves,
        minReserves from range formula,
        InitialState(reserve0, reserve1)
    )

    // Activate surcharge to protect the recenter
    surchargeStart = block.number
    emit AuctionEnded(block.number)
```

The `minAuctionBlocks` guard prevents premature clearing. Without this guard, a single arb swap could immediately converge the marginal price to within `clearThreshold` of the oracle — the fee hasn't had time to decay, so the arber pays the full starting fee. The minimum duration ensures the fee decays before clearing is checked, giving arbers time to compete and discover the market-clearing price.

The `recenterRange` parameter defines the pool's supported price range after recentering. Min reserves are derived from this range using the EulerSwap curve formula, accounting for concentration:

| recenterRange (r) | c=0 min/eq | c=0.5 min/eq | Price range |
|---|---|---|---|
| 0.01e18 (1%) | 99.5% | 99.0% | ±1% |
| 0.05e18 (5%) | 97.6% | 95.2% | ±5% |
| 0.50e18 (50%) | 81.6% | 57.7% | ±50% |
| 1.00e18 (100%) | 70.7% | 40.8% | ±100% |

**Calibration:** set `recenterRange` so that h=1 at the boundary, i.e., max debt at min reserves equals the health limit for the pool's cross-LTV. For a boosted pool with LTV L, target health H, and range r:

```
maxDebt per side = eq × (1 - 1/sqrt(1 + r/(1-c)))
health at boundary = collateral × L / maxDebt = H
```

Solve for r given L, H, c. The range is absolute — the same formula is used at deployment, after recentering, and if the agent reconfigures.

Since the marginal price has converged to within `clearThreshold` of the oracle, the pool is already near market price — the recenter displacement is small. The `maxRecenterDrift` clamp prevents oracle manipulation from causing a wildly wrong recenter. The surcharge protects against any residual error within the clamp range, then decays to zero. Normal mode resumes.

### Price-convergence clearing

The auction clears when the pool's marginal price converges to the oracle price within `clearThreshold`. This directly measures whether the arb created by the shift has been consumed — the marginal price returns to market when arbers have traded enough to close the mispricing.

**Why price-convergence, not reserve-based exposure:** After the shift sets eq = current reserves, reserve-based exposure (`(eq - reserve) / (eq - min)`) is always near zero — by construction. The shift changes the curve, not the reserves. Reserve displacement from the shifted curve is a poor signal of clearing progress. Price convergence is the natural metric: the shift creates a marginal-to-oracle gap, arbers close it, and when the gap is within `clearThreshold` the arb is consumed.

**Validation constraint:** `clearThreshold < shiftMagnitude`. If the clearing threshold were >= the shift magnitude, the auction could clear immediately after the shift (the initial mispricing is approximately equal to the shift magnitude). This ensures the arb must actually be partially consumed before clearing.

**How it works:**

1. Shift creates mispricing: marginal price diverges from oracle by ~`shiftMagnitude`
2. Arbers trade to close the gap, paying decaying fees
3. `minAuctionBlocks` ensures the fee has time to decay before clearing is checked
4. When `|marginalPrice - oraclePrice| / oraclePrice < clearThreshold`, the auction clears

Each clearing cycle clears an amount proportional to `shiftMagnitude × pool_depth`, not the full directional exposure. The total clearing trade equals the reserve displacement needed to move marginal price from shifted back to market.

For **boosted pools** (the target use case), the effective liquidity is enormous, so a 108 bps shift causes substantial reserve flow — potentially clearing >50% of exposure per cycle. For un-boosted pools, each cycle clears a small fraction, but un-boosted pools have large natural mispricing and may not need this mechanism.

The design converges iteratively: multiple clearing cycles progressively reduce exposure. After each recenter, normal mode resumes, arb flow accumulates new exposure, and the next cycle triggers when threshold is reached. Each cycle has minimum-cost clearing per section 8.

### Concentration effects on auction dynamics

The starting fee (= shiftMagnitude) is exact for all c — at equilibrium, marginalPrice = px/py regardless of concentration (the (x₀/x)² term is 1). But concentration significantly affects auction behavior *during* clearing:

**Flatter curve → more volume to clear.** At c=0 (constant-product), marginal price changes as (x₀/x)². At c=0.5, it changes as `0.5 + 0.5 × (x₀/x)²` — half the price impact per unit of reserve displacement. At c=0.9, only 10% of the price impact remains. This means arbers must trade proportionally more volume to close the same mispricing gap.

**Implications for stablecoin pools (high c):**

| Parameter | Low c (volatile pairs) | High c (stablecoins) |
|-----------|----------------------|---------------------|
| Volume to clear | Lower | Higher (1/(1-c) scaling) |
| Blocks to clear | ~25 | May need more |
| shiftMagnitude | ~108 bps | Could use smaller shifts |
| decayPerBlock | ~4.3 bps | May need slower decay |
| Fee revenue per cycle | shift × volume | Higher volume → more revenue |
| equityTriggerThreshold | 15% of NAV | Tighter ranges → more sensitive |

**Calibration for high c:** the key relationship is `shiftMagnitude ≈ targetBlocks × decayPerBlock`. For stablecoin pools with high c, the same mispricing takes more blocks to clear (more volume needed), so either:
- Accept more blocks in clearing mode (increase targetBlocks, keep same shift/decay)
- Use smaller shifts with proportionally slower decay (same ratio, longer auction)
- Accept that each cycle clears less exposure, requiring more iterations

The choice depends on whether the pool earns more from normal-mode attract fees or from clearing-mode fee revenue. High-c pools may actually earn *more* per clearing cycle (more volume), making longer auctions acceptable.

### The full cycle

```
Normal mode (surcharge = 0)
    → pool earns fees on arb and attract flow
    → exposure accumulates (ETH equity or ETH debt grows)
    ↓ exposure crosses trigger threshold

Equity clearing mode
    → afterSwap: shift eq price (amplify mispricing) + start fee auction
    → getFee: decaying fee on clearing direction, elevated fee on non-clearing
    → arbers arbitrage the shift, clearing proportional to shift × pool depth
    ↓ marginal price converges to oracle price within clear threshold

Normal mode (surcharge > 0, decaying)
    → afterSwap: recenter to market + activate surcharge
    → getFee: normal fees + decaying surcharge
    → surcharge decays to zero
    → remaining exposure may trigger another clearing cycle
    ↓ back to steady state
```

### Why the auction is essential

External swaps (orderflow router, CowSwap) are prohibitively costly for equity rebalancing. **Slippage dominates the cost**, far exceeding gas and swap fees. For leveraged pools with large equilibrium reserves, the rebalance amounts are substantial and external venue depth is often insufficient.

The in-pool auction lets arbers bring liquidity TO the pool. The LP pays no slippage — the fee decay discovers the market-clearing price for rebalancing.

### Key differences from V2/V3

- **Fee starts at mispricing, not low.** Shift creates the arb, fee recaptures it. No double incentive (fixing bug #1).
- **eq = currentReserves is deliberate, not a hack.** V4 sets eq = currentReserves to satisfy the curve invariant after shifting the price. This is required: the shift changes the price, so the curve needs to be re-anchored. Unlike V2/V3 bug #4 where eq = currentReserves was used to "declare equilibrium" with no price change, here the price is deliberately shifted to amplify existing mispricing.
- **Fee floor = baseFee.** Auction fee decays to baseFee, never zero (fixing bug #5). Surcharge decays to zero but is additive to the already-floored normal fee.
- **Decay per block.** d ≈ σ₁ ≈ 4.3 bps/block (section 8).
- **Exposure-based trigger.** Directional exposure (ETH equity or debt) as fraction of range. Works for both long and short exposure. Tracks health since both degrade together at the boundary (fixing bugs #2, #3).
- **Separate trigger/clear thresholds.** Trigger at ~15% exposure, clear at price convergence (marginal ≈ oracle within 0.5%). Prevents oscillation.
- **Non-clearing trades allowed during auction.** Floor = auction fee, so they never undercut clearing-side price. Preserves retail revenue during auction windows.
- **Autonomous recentering.** Hook recenters after clearing, protected by surcharge. No agent intervention needed.

### Storage

Fee params (baseFee, maxFee, gasCoeff, externalFee, captureRate, attractRate) + auction params (decayPerBlock, clearThreshold, shiftMagnitude, maxRecenterDrift, minAuctionBlocks, recenterRange) + trigger params (debtTriggerThreshold, approxNav) + surcharge params (surchargeDecayPerBlock, surchargeInitialAmount) + auction state (auctionActive, auctionStartBlock, auctionStartingFee, auctionClearAsset0, preShiftPriceY) + surcharge state (surchargeStartBlock). ~15 slots.

### Agent role

The agent is not needed for the core loop. Its only job is parameter tuning on a slow timescale:

- Adjust baseFee, attractRate, captureRate, gasCoeff based on realized vol, observed arb frequency, and routing data
- Tune clearThreshold, shiftMagnitude, decayPerBlock, minAuctionBlocks, debtTriggerThreshold
- Calibrate recenterRange to maintain h=1 at boundary given current LTVs and boost level
- Monitor pool health as a safety backstop (emergency intervention via maxFee or manual reconfigure)

### Risks

- **Eq price shift magnitude.** Too small = insufficient clearing arb, auction takes too long. Too large = auction takes many blocks, pool sits in clearing mode longer. The cost per arb is independent of shift magnitude (section 8) — the trade-off is purely auction duration vs. time spent in clearing mode. **Calibration rule:** `shiftMagnitude ≈ targetBlocks × decayPerBlock`. For ~25 blocks (~5 min) at d ≈ 4.3 bps/block: `shiftMagnitude ≈ 108 bps ≈ 0.0108e18`. This keeps the shift a fixed parameter rather than computed — simple and predictable.
- **Correlated oracle risk (clearing + recenter).** The same slot0 read both triggers clearing (marginal ≈ oracle) and sets the recenter price. An attacker could manipulate slot0 to match the pool's still-shifted marginal price, causing premature clearing when the arb isn't actually consumed, and simultaneously recentering at the manipulated price. Example: pool marginal is 1.01 after a 1% shift, true market is 1.0. Attacker pushes slot0 to 1.01 → clearing triggers (|1.01 - 1.01| < 0.5%), recenter sets eq price to 1.01 (within drift clamp). The arb wasn't consumed — the pool just accepted a wrong price. **Mitigations:** (1) **maxRecenterDrift** bounds the damage — the recenter is clamped to within x% of pre-shift price, so the worst-case error is bounded. (2) **minAuctionBlocks** narrows the manipulation window — attacker must sustain the manipulation or time it precisely. (3) **surcharge** captures residual arb from the wrong recenter. (4) The next clearing cycle corrects the error. (5) Manipulating Uniswap V3 slot0 requires substantial capital and is typically unprofitable after accounting for the arb cost. **Possible hardening:** use TWAP instead of slot0 for the clearing check (harder to manipulate, latency is acceptable during auction mode). Or require price convergence for N consecutive blocks. Both add complexity — slot0 + drift clamp + surcharge is the simpler starting point.
- **Oracle risk during recenter (independent of clearing).** Even without the correlated attack above, if slot0 is manipulated at the exact clearing block, the recenter price is wrong. The same mitigations apply: maxRecenterDrift clamp, surcharge, and next-cycle correction. TWAP could replace slot0 for recentering, but adds a dependency on Uniswap observation cardinality.
- **Clearing threshold tuning.** Too tight = never clears (marginal price never exactly matches oracle). Too loose = clears before arb is fully consumed. The `clearThreshold` is a price-convergence metric: `|marginalPrice - oraclePrice| / oraclePrice`. Must be < `shiftMagnitude` to prevent immediate clearing. Starting value: 0.5% (50 bps). The `minAuctionBlocks` guard ensures the fee-decay mechanism has time to work before clearing is checked. Set to roughly `shiftMagnitude / decayPerBlock / 2` so the fee decays ~50% before clearing is permitted. **Interaction to verify:** at minAuctionBlocks ≈ 12, the remaining fee is ~54 bps (108 - 12 × 4.3). The clearing swap that triggers the recenter pays this fee. Is ~54 bps adequate LP protection on the final clearing trade? If the pool has converged most of the way, the remaining edge is small and ~54 bps is likely sufficient. Empirical testing should confirm.
- **recenterRange calibration.** Defines the pool's tradeable range after recenter. Too tight = pool hits SwapLimitExceeded quickly and re-triggers rapidly. Too wide = pool is under-leveraged, lower capital efficiency. Must satisfy h=1 at the boundary for the pool's cross-LTV. Recalibrate if LTVs change.
- **Reconfigure gas cost.** afterSwap calls `pool.reconfigure()` at mode transitions (~50k extra gas). Two reconfigures per cycle: shift (Step 1) and recenter (Step 3). Only happen on the triggering swap and the clearing swap — not every swap during the auction. Vault accounting (interest accrual, share prices) between the two reconfigures is negligible over ~25 blocks (~5 min).

### Switching hooks

All hooks share the same pool — only the hook contract changes:
1. Deploy new hook contract
2. Reconfigure pool via EVC: set `swapHook = newHook`, update `swapHookedOperations`
3. Old hook is abandoned (no state migration needed)

Pool's static params (vaults, assets, euler account) stay the same.

## 22. V7 Hook Design

Clean rebuild with three key improvements over V4: (1) continuous recentering on every exposure-reducing swap, (2) curvature-aware smart surcharge that provably prevents round-trip extraction through recenters, (3) exposure-sized auction shifts instead of fixed magnitudes. The NAV (deposits − debts) replaces gross deposits as the exposure denominator, fixing V6's ratio invariance problem.

Contract: `contracts/src/DynamicFeeAuctionHook.sol`. Tests: `contracts/test/DynamicFeeAuctionHook.t.sol` (40 tests, 256-run fuzz tests).

Pool sets `swapHookedOperations = GET_FEE | AFTER_SWAP` (0x06).

### Two mechanisms

**Mechanism 1: Continuous recenter + smart surcharge.** After every swap, if range-based exposure decreased compared to the previous swap, recenter immediately — free rebalancing from natural flow. A smart surcharge protects the recenter by covering both curvature bonus (from curve displacement) and oracle price change.

**Mechanism 2: Clearing auction (fallback).** When exposure keeps growing and relative exposure (`|netWeth| × ethPrice / NAV`) exceeds the trigger threshold, start a fee-decay auction. The shift magnitude is computed from actual absolute exposure, not a fixed parameter. Price-convergence clearing ends the auction.

### Key differences from V4

| Aspect | V4 | V7 |
|--------|-----|-----|
| Recentering | Only after auction clears | After every exposure-reducing swap |
| Surcharge | Fixed initial amount (param) | Computed per-recenter from exposure + price change |
| Surcharge theory | Heuristic protection | Provably covers curvature bonus (see derivation below) |
| Exposure denominator | Gross deposits (approxNav) | NAV = deposits − debts (cachedNav) |
| Auction shift | Fixed shiftMagnitude param | Computed from absolute exposure, capped at maxShiftMagnitude |
| Auction starting fee | = shiftMagnitude | = shift × 1.5 (exposure-dependent) |
| Exposure metric (trigger) | Range-based only | Range-based for recenter; vault-inferred relative exposure for auction trigger |
| Marginal price | c=0 approximation: (px/py) × (x₀/x)² | Concentration-aware: (px/py) × [cx + (1-cx) × (x₀/x)²] |

### afterSwap flow

```
function afterSwap(... reserve0, reserve1):
    if !auctionActive:
        d = pool.getDynamicParams()
        (exposure, asset0Deficit) = computeExposure(reserve0, reserve1, d)

        if exposure < lastExposure:
            // Exposure decreased → recenter immediately
            recenterMag = recenterAtMarket(reserve0, reserve1, d)
            initSurcharge(recenterMag, lastExposure, d)    // smart surcharge
            cacheVaultState()                               // refresh baseNetAsset1 + cachedNav
            postExposure = measure post-recenter exposure
            lastExposure = postExposure
        else:
            lastExposure = exposure
            // Check vault-inferred relative exposure for auction trigger
            relExposure = computeRelativeExposure(reserve1, d)
            if relExposure > auctionTriggerThreshold:
                absExposure = computeAbsoluteExposureWeth(reserve1, d)
                startAuction(reserve0, reserve1, asset0Deficit, d, absExposure)

    else:
        // Auction mode: check price convergence after minimum blocks
        if block.number >= auctionStartBlock + minAuctionBlocks:
            if checkPriceConvergence(reserve0, reserve1):
                endAuctionAndRecenter(reserve0, reserve1)
```

### Exposure metrics (three levels)

V7 uses three distinct exposure metrics for different purposes:

**1. Range-based exposure** (for continuous recenter trigger):
```
exposure = (eq - reserve) / (eq - min)    on deficit side
```
At equilibrium: 0. At boundary: 1.0. Same as V4. Used to detect whether a swap improved exposure (compare to `lastExposure`). Monotonically non-decreasing between recenters — each recenter resets it.

**2. Relative exposure** (for auction trigger):
```
relativeExposure = |netWeth| × ethPrice / cachedNav
```
Where `netWeth = baseNetAsset1 + (reserve1 − eq1)` — the actual WETH position inferred from vault state at last recenter plus swap displacement since. `cachedNav` is NAV at last recenter. This metric can exceed 100% (exposure exceeding equity). Used only to decide whether to start an auction.

**Why NAV, not gross deposits:** V6 used gross deposits as denominator. When exposure grows, debt grows, so gross deposits (which include borrowed amounts) grow proportionally. The ratio stays approximately constant — the auction can never reduce it because both numerator and denominator shrink together. NAV (deposits − debts) fixes this: as debt grows, NAV shrinks, making the ratio grow faster and triggering correctly.

**3. Absolute exposure** (for auction shift sizing):
```
absoluteExposureWeth = |baseNetAsset1 + (reserve1 − eq1)|
```
Raw WETH amount of directional exposure. The auction shift is sized proportionally:
```
shift = absoluteExposureWeth × WAD / eq1    (capped at maxShiftMagnitude)
```
This ensures the arb opportunity matches the exposure to clear.

### Smart surcharge: curvature bonus + price change

The surcharge must cover two sources of arb value created by recentering:

#### Source 1: Curvature bonus (displacement-dependent)

When the pool is displaced from eq (say `x < x₀` on the X branch), the marginal price is steep:
```
price(x) = (px/py) × [cx + (1-cx) × (x₀/x)²]
```

A trader selling token0 at this displaced position gets the steep price (more token1 per unit). Recentering flattens the curve — the new eq is at the current reserves, so marginal price resets to px/py. The trader can buy token0 back at the flat price.

**Per-unit curvature bonus** (see Appendix below for full derivation):
```
bonus/Δ ≈ (px/py) × (1-cx) × [(x₀/(x₀-δ))² − 1]
        ≈ (px/py) × 2(1-cx) × δ/x₀          for small displacements
```

In WAD fee terms (dividing by px/py): `curvature_rate ≈ 2(1-cx) × exposure_fraction`.

The factor of 2 appears in the small-displacement approximation. V7 uses the **exact** formula `(1-c) × [(eq/reserve)² - 1]` directly, avoiding this approximation entirely.

#### Source 2: Price change (oracle-dependent)

The recenter aligns pool price to oracle. If the oracle moved since the last recenter:
```
priceComponent = |oraclePrice − poolPrice| / max(oraclePrice, poolPrice)
```

This is `recenterMagnitude` returned by `_recenterAtMarket()`.

#### Combined formula

```solidity
function _initSurcharge(recenterMagnitude, reserve0, reserve1, preEq0, preEq1, d) {
    // Exact curvature bonus: (1-c) × [(eq/reserve)² - 1]
    if (reserve0 < preEq0) {
        ratioSq = preEq0² × WAD / reserve0²;
        curvatureComponent = (WAD - d.concentrationX) × (ratioSq - WAD) / WAD;
    } else if (reserve1 < preEq1) {
        ratioSq = preEq1² × WAD / reserve1²;
        curvatureComponent = (WAD - d.concentrationY) × (ratioSq - WAD) / WAD;
    }
    priceComponent = recenterMagnitude;
    amount = (curvatureComponent + priceComponent) × surchargeMultiplier / WAD;
    floor = baseFee / 2;    // prevents micro-recenters from being free
    surchargeInitialAmount = max(amount, floor);
    surchargeStartBlock = block.number;
}
```

- Uses the **exact** curvature bonus formula `(1-c) × [(eq₀/r₀)² - 1]`, not a linear approximation. Works correctly for all parameter combinations including high concentration and wide ranges.
- `preEq0/preEq1` are the equilibrium reserves **before** `_recenterAtMarket` mutates the params struct. Must be cached at the call site.
- `surchargeMultiplier` (param, e.g. 1.25e18): pure safety margin on the exact formula. Any value ≥ 1e18 provides coverage.
- The surcharge decays linearly via `surchargeDecayPerBlock` (same mechanism as V4).

**Key difference from V4:** In V4, `surchargeInitialAmount` was a fixed param. In V7, it's mutable state computed from actual displacement and price change at each recenter. Small recenters get small surcharges; large recenters get large ones.

### Appendix: Curvature bonus derivation

**Setup.** EulerSwap X branch (`x ≤ x₀`):
```
y(x) = y₀ + (px/py) × (x₀ - x) × [cx + (1-cx) × x₀/x]
```

Pool displaced by δ: current position at `x = x₀ − δ`.

**Attack sequence:**
1. **Leg 1** (sell Δ token0 at displaced position): x increases from `x₀−δ` to `x₀−δ+Δ`. Revenue ≈ `(px/py) × Δ × [cx + (1-cx) × (x₀/(x₀-δ))²]` for small Δ.
2. **Recenter**: new eq = `(x₀−δ+Δ, y_new)`, price updated to oracle ≈ px/py.
3. **Leg 2** (buy Δ token0 from new flat eq): Cost ≈ `(px/py) × Δ` (at eq, curvature term = 1).

**Per-unit bonus:**
```
bonus/Δ = (px/py) × (1-cx) × [(x₀/(x₀-δ))² − 1]
```

For small ε = δ/x₀:
```
bonus/Δ ≈ (px/py) × 2(1-cx) × ε
```

**Surcharge coverage.** The surcharge must exceed `bonus/Δ` in WAD fee terms:
```
surcharge ≥ (1-cx) × [(x₀/(x₀-δ))² - 1]
```

V7 uses this **exact** formula directly: `curvatureComponent = (1-c) × [(eq₀/r₀)² - 1]`, where `eq₀` and `r₀` are the pre-recenter equilibrium and current reserve. The `surchargeMultiplier` provides pure safety margin — any value ≥ 1e18 covers the theoretical bound. Unlike a linear approximation, this works correctly for all parameter combinations including high concentration and wide ranges.

**Important implementation detail:** `_recenterAtMarket()` mutates the `DynamicParams` struct in memory (setting `equilibriumReserve0 = reserve0`). The caller must cache `preEq0/preEq1` before calling `_recenterAtMarket`, then pass them to `_initSurcharge`.

**Fuzz verification:** `test_fuzz_surchargeCoversRoundTrip` (256 runs) creates pools with random concentration (0.1–0.9), performs swaps creating displacement, and verifies the computed surcharge exceeds the theoretical curvature bonus for all tested `(δ, c)` combinations.

### Exposure-sized auctions

V4 used a fixed `shiftMagnitude` param (e.g. 108 bps). This creates the same-sized arb regardless of actual exposure — too small when exposure is large, wastefully large when exposure is small.

V7 computes the shift from actual absolute exposure:

```solidity
function _computeAuctionShift(absExposureWeth, eq1) {
    shift = absExposureWeth × WAD / eq1;       // exposure as fraction of eq
    shift = min(shift, maxShiftMagnitude);      // cap
    shift = max(shift, clearThreshold × 2);     // floor: must exceed clear threshold
    return shift;
}
```

The starting fee is `shift × 1.5` (capped at maxFee, floored at baseFee). The 1.5x ensures the LP captures value from the clearing arb — the fee starts above the mispricing, decaying through it.

### Concentration-aware marginal price

V4 used a c=0 approximation for marginal price: `(px/py) × (x₀/x)²`. This is wrong for concentrated pools:
- At c=0.5, the formula overestimates displacement from eq price
- The convergence check reports a larger deviation than actually exists
- Auctions can never clear because the check thinks the price hasn't converged

V7 uses the full formula:
```
X branch: price = (px/py) × [cx + (1-cx) × (x₀/x)²]
Y branch: price = (px/py) / [cy + (1-cy) × (y₀/y)²]
```

This is critical for both convergence checks (auction clearing) and fee computation (arb vs attract direction detection).

### Storage layout

```
// Immutables (10)
pool, owner, supplyVault0, supplyVault1, borrowVault0, borrowVault1,
eulerAccount, asset0, asset1, uniswapPool, uniswapToken0IsAsset0

// Fee params
baseFee, maxFee, gasCoeff, externalFee (uint64 each)
captureRate, attractRate (uint256 each)

// Surcharge params
surchargeDecayPerBlock (uint64)
surchargeMultiplier (uint64)     — NEW: replaces fixed surchargeInitialAmount param

// Auction params
decayPerBlock, auctionTriggerThreshold, clearThreshold, maxShiftMagnitude (uint64 each)
minAuctionBlocks (uint64)        — renamed from V4's shiftMagnitude → maxShiftMagnitude

// Recenter params
recenterRange, maxRecenterDrift (uint64 each)

// Mutable: exposure tracking
lastExposure (uint64)            — range-fraction after previous swap
baseNetAsset1 (int128)           — net WETH at last recenter
cachedNav (uint128)              — NEW: NAV in asset0 terms (replaces approxGrossDeposits)

// Mutable: surcharge
surchargeStartBlock (uint64)
surchargeInitialAmount (uint64)  — NOW MUTABLE STATE: computed per-recenter

// Mutable: auction
auctionActive (bool), auctionStartBlock (uint64), auctionStartingFee (uint64)
auctionClearAsset0 (bool), preShiftPriceY (uint80)
```

### Admin functions

Same as V4, plus:
- `setSurchargeParams(surchargeDecayPerBlock, surchargeMultiplier)` — new multiplier param
- `refreshVaultState()` — owner can re-read vaults to fix drift from interest accrual
- `endAuction()` — owner can force-end a stuck auction (emergency)

### Risks (V7-specific)

- **surchargeMultiplier too low.** If < 1e18, the surcharge doesn't cover the curvature bonus. V7 uses the exact formula `(1-c) × [(eq/r)² - 1]` so the multiplier is a pure safety margin (no 2x approximation factor needed). Recommended ≥ 1.25e18.
- **cachedNav staleness.** NAV is cached at each recenter. Between recenters, interest accrual changes real deposits/debts but cachedNav is stale. If interest accrual is significant between recenters (unlikely over minutes, possible over hours), the relative exposure trigger may fire early or late. `refreshVaultState()` is the escape valve.
- **Continuous recenter frequency.** Every exposure-reducing swap triggers a reconfigure (~50k extra gas). In normal mode with balanced flow, this could fire on every other swap. Gas cost is borne by the swapper. For pools with high swap frequency, this may be a concern.
- **Curvature bonus bound validity.** The derivation assumes small trades (Δ ≪ δ). For large trades that significantly change the displacement, the actual bonus diverges from the marginal approximation. Since V7 uses the exact formula rather than a linear bound, the multiplier can be tighter (1.25e18 recommended).

### Resolved open questions from V4

Several questions from section 23 are resolved by V7:

- **Q5 (Surcharge calibration):** Resolved. Surcharge uses the exact curvature formula `(1-c) × [(eq/r)² - 1]` plus oracle price change. The multiplier is a pure safety margin (≥ 1e18 covers; 1.25e18 recommended).
- **Q6 (Reconfigure mechanics):** Resolved. Implementation in `_recenterAtMarket()` and `_startAuction()` handles priceX/priceY encoding, eq reserve setting, and min reserve computation.
- **Q7 (Iterative vs single-cycle):** Resolved. V7's exposure-sized shifts mean larger exposure → larger shift → more clearing per cycle. Still iterative (capped at maxShiftMagnitude), but each cycle clears proportional to actual exposure rather than a fixed amount.

## 23. Open Questions

1. **Clearing threshold calibration.** The `clearThreshold` is a price-convergence metric (`|marginalPrice - oraclePrice| / oraclePrice`). Must be < `shiftMagnitude`. Starting value: 0.5% (50 bps). What values minimize total cost? Too tight = never clears (marginal price has noise). Too loose = clears before arb is fully consumed. With `minAuctionBlocks`, the convergence check is deferred — the threshold now gates clearing only after the minimum duration, not immediately after the shift.

2. **Shift magnitude.** Calibration rule: `shiftMagnitude ≈ targetBlocks × decayPerBlock`. For ~25 blocks at σ₁ ≈ 4.3 bps/block → ~108 bps. Remaining question: is ~25 blocks the right target? Shorter = less time in clearing mode but fewer arbers see the opportunity. Longer = more competition but pool earns no attract-side revenue during auction.

3. ~~**Starting fee from shift.**~~ **Resolved.** The starting fee = shiftMagnitude is exact for all c, not an approximation. At equilibrium (where eq = reserves after the shift), marginalPrice = px/py regardless of concentration — the concentration terms cancel when x = x₀. The shift changes py by factor (1 ± s), so mispricing = s exactly. The second-order term (s²/2 ≈ 0.6 bps at 108 bps shift) is from the asymmetry of the py adjustment formula, not from concentration.

4. **attractRate optimal value.** Section 16 suggests high values (0.5-0.8) based on the AMM challenge. But that was single-competitor. With multi-venue routing, is the optimal attractRate lower?

5. **Surcharge calibration.** How high should the initial surcharge be after recentering? Too high = blocks legitimate trades for a few blocks. Too low = doesn't capture recentering errors. How many blocks should the decay take?

6. **Reconfigure mechanics.** The hook calls `pool.reconfigure()` in afterSwap. What exactly should the new DynamicParams contain? The eq price and eq reserves need to be computed from: the shift direction, shift magnitude, current reserves, and (for recentering) the oracle price. Getting the priceX/priceY encoding right with decimal adjustment is critical.

7. **Iterative vs single-cycle clearing.** The current design clears exposure proportional to `shiftMagnitude × pool_depth` per cycle, not the full exposure. For boosted pools this may clear >50% per cycle; for un-boosted pools much less. Should we store pre-shift equilibrium and measure clearing against it for full single-cycle clearing? Or is iterative clearing acceptable? What's the expected number of cycles to clear 90% of exposure for a typical boosted pool?

8. **Multi-pool coordination.** If we run WETH/USDC and USDC/USDT pools simultaneously, should equity clearing auctions be coordinated? E.g., a USDC surplus in one pool could be routed to the other.

9. **Vol regime detection.** The agent should adjust baseFee based on realized vol. What's the right lookback window? Too short = noisy. Too long = stale. The AMM challenge found fixed parameters beat adaptive ones — does this hold for the agent's slower timescale?

10. **Correlated oracle hardening.** The clearing check and recenter both read slot0 in the same afterSwap call. A single-block manipulation could trigger premature clearing at a wrong price (see Risks). Two hardening options: (a) use TWAP for the clearing check (slot0 for recenter is bounded by drift clamp), or (b) require price convergence across N consecutive blocks (add a `convergenceBlocks` counter). Both reduce the attack surface at the cost of complexity and latency. Is the current mitigation stack (drift clamp + minAuctionBlocks + surcharge) sufficient for launch, or does the correlated vector warrant hardening before deployment?

11. **Stablecoin pool calibration.** High-c pools (c ≥ 0.8) need 5-10x more arb volume to clear the same mispricing. Should shiftMagnitude and decayPerBlock be parameterized per pool type, or can a single calibration work across volatile and stable pairs? Empirical testing with realistic stablecoin pool parameters would resolve this.

## 24. Variance Drain: The Fundamental Cost of Rebalancing Leveraged Pools

Rebalancing is not free. Each recenter crystallizes the pool's impermanent loss into a permanent NAV reduction. For leveraged pools, this loss is amplified by the leverage factor and compounds multiplicatively across recenters. This section derives the cost analytically and validates against simulation.

### The crystallization problem

Consider the pool's lifecycle between recenters:

1. Pool is at equilibrium after a recenter. LP NAV = V₀.
2. Price moves. The pool's reserves shift, creating directional exposure and impermanent loss.
3. An auction clears the exposure. The pool recenters at the new market price.
4. LP NAV is now V₁ < V₀. This is the new starting point — the loss is permanent.

Without recentering, the IL is unrealized: if price reverts, the pool recovers. With recentering, the loss is locked in and the LP starts the next cycle from a reduced base. Over many cycles, these losses compound multiplicatively.

The competing risk: without recentering, exposure grows unbounded and the pool approaches liquidation. The LP must recenter to survive — but each recenter costs them.

### Impermanent loss for constant-product (c = 0)

For a standard constant-product AMM, the IL for a price change by factor k = p_new/p_old is:

```
IL(k) = 2√k / (1 + k) − 1
```

This is the fractional loss of pool value relative to holding the pool's assets. For small moves ε = k − 1:

```
IL ≈ −ε² / 8    (valid to ~1% for |ε| < 1%, ~5% for |ε| < 5%)
```

Note: IL is always non-positive. The pool always underperforms a hold strategy, regardless of price direction.

### Leverage amplification

The pool has virtual reserves x₀, y₀ with total pool value V_pool = x₀ + y₀p₀. The LP's equity is E = xr + yr·p₀ − xd − yd·p₀. The LP targets 100% quote (USDC) — at the ideal equilibrium after a recenter, yr = yd = 0 and E = xr.

The effective leverage is:

```
L = V_pool / E
```

For this pool: V_pool = 831,287 + 358.24 × 1,986 = 1,542,755. E = 3,611. So L = 427×.

Note: L ≠ x₀/xr (= 230×). The leverage is pool_value/equity, not single-side reserve/deposit, because the pool has reserves on both sides. For a balanced constant-product pool (y₀p₀ = x₀), L ≈ 2 · x₀/xr. The factor of 2 matters.

The LP bears the pool's entire IL on their equity. The exact NAV change for a price move by factor k = 1 + ε:

```
ΔNAV = (√k − 1) · (x₀ − y₀ · p · √k)
```

For a balanced pool (x₀ = y₀p₀) this simplifies to −x₀(√k − 1)² ≈ −(V_pool/2)·ε²/4. For an unbalanced pool (the one-sided USDC LP has x₀ > y₀p₀), there is an additional first-order directional term:

```
ΔNAV ≈ (ε/2)(x₀ − y₀p₀) − (ε²/8)(x₀ + y₀p₀)
```

The first term is directional exposure from the imbalance — positive when ETH rises (LP was long USDC), negative when ETH falls. It has zero expectation under GBM. The second term is the IL, always negative. The expected loss per recenter as a fraction of LP equity:

```
E[ΔV/V] = −L · ε² / 8     (same for balanced and unbalanced pools)
```

Verified via Monte Carlo (1000 sims × 100 recenters): simulated E[ln(V/V₀)] = −0.2210, predicted = −0.2195. Match within 0.7%.

A 1% price move with L = 427 costs the LP 427 × 0.01² / 8 = 0.53% of their equity in expectation. Small in isolation; devastating when compounded.

### One-sided deposit and clearing conditions

The LP targets 100% USDC equity. In the hook, the recenter (`_endAuctionAndRecenter`) sets equilibrium reserves to the current reserves and adjusts priceY to market. It does not trade the vault back to single-asset. Whether the LP achieves its USDC target depends on the clearing condition:

- **equity_zero:** non-quote (ETH) net equity reaches zero → LP is at ~100% USDC. This is the ideal outcome.
- **debt_zero:** clearing-side debt reaches zero → LP has reduced but not eliminated exposure.
- **price_convergence:** marginal price matches oracle within threshold → no guarantee on vault composition. The LP may retain residual ETH exposure.

In simulation, price_convergence is the dominant clearing condition (100% of auctions). This means the LP gradually drifts from the 100% USDC target, accumulating directional exposure across recenters. The first-order directional term adds noise to individual cycles but does not change the expected drain rate.

However, residual exposure creates **asymmetric liquidation risk**: a USDC-targeting LP with accumulated long-ETH exposure is disproportionately harmed by ETH drops. The variance drain formula captures the expected cost; the asymmetric tail risk is a separate concern that equity_zero clearing would address.

### Variance drain formula

Over N recenters with independent price moves ε₁, ε₂, ..., εₙ:

```
V_final = V₀ · ∏(1 − L·εᵢ²/8)
```

Taking logarithms and using E[εᵢ²] = σ²·Δt where Δt is the time between recenters:

```
E[ln(V_final/V₀)] = −(L·σ²/8) · N·Δt = −L·σ²·T/8
```

Therefore:

```
V_final ≈ V₀ · exp(−L · σ² · T / 8)
```

where T is total time in years, σ is annualized volatility, and L is the effective leverage.

This is the **variance drain** — the systematic NAV erosion from rebalancing a leveraged position in a volatile market. It depends only on L, σ², and T. The rebalancing frequency cancels: more frequent recenters mean smaller per-recenter losses but more of them.

### Validation against simulation

Predictions from V₀ · exp(−L·σ²·T/8) with L = 427, T = 30/365:

| σ (annual) | Exponent | Predicted NAV | Simulated V5 NAV | Auction cost | Predicted − cost |
|-----------|----------|--------------|-----------------|-------------|-----------------|
| 30% | 0.39 | $2,434 | $2,138 | $279 | $2,155 |
| 60% | 1.58 | $744 | $509 | $457 | — |
| 90% | 3.55 | $104 | $53 | $425 | — |

At 30% vol, the formula minus auction costs ($2,155) closely matches the simulation ($2,138). At higher vol, the simple subtraction breaks down because auction costs are incurred throughout the simulation on declining NAV, not as a lump sum. The formula captures the dominant effect; auction costs are a secondary correction.

### Implications for pool design

**1. The leverage-volatility product Lσ² determines viability.**

The decay rate is L·σ²/8 per year. For the pool to retain meaningful NAV over a holding period T:

```
L · σ² · T / 8 ≲ 1    →    L ≲ 8 / (σ² · T)
```

| σ (annual) | Max L for 50% survival (30d) | Max L for 50% survival (1yr) |
|-----------|--------------------------|--------------------------|
| 30% | 749× | 62× |
| 60% | 187× | 15× |
| 90% | 83× | 7× |

This pool (L = 427×) is viable only at σ ≲ 25% for 30-day horizons. At the 60-90% realized vol typical of ETH, the leverage is 2-5× too high.

**2. Lower leverage does not change the fee-to-drain ratio.**

Fee revenue scales with pool depth (proportional to L). Variance drain also scales with L. The ratio:

```
fee_revenue / drain ∝ (L · volume · fee_rate) / (L · σ²) = volume · fee_rate / σ²
```

The L cancels. Reducing leverage proportionally reduces both fees and drain. The profitability question — whether fees exceed drain — depends on volume × fee_rate vs σ², which is independent of leverage.

What lower leverage does: it slows down both the earning and the bleeding, giving the LP more time to observe whether the fee/drain ratio is favorable before being wiped out. High leverage is a bet that fees exceed drain, amplified to maximum. If that bet is wrong, you lose everything fast.

**3. Rebalancing frequency is irrelevant in the continuous limit.**

The formula shows V = V₀ · exp(−Lσ²T/8) regardless of how many recenters occur. This is because the NΔt product is fixed at T. In theory, rebalancing every block or once a month gives the same expected drain.

In practice, discrete effects break this symmetry:
- **Very frequent recentering** (every block): each recenter has a fixed cost (auction net cost, gas). These costs don't scale with the move size, creating a floor cost per recenter. At high frequency, fixed costs dominate.
- **Very infrequent recentering** (monthly): the ε²/8 approximation breaks down for large moves. At 60% vol, a 30-day move can be 20%+, where the approximation error is >20%. More importantly, health factor may breach 1.0 before the next recenter.

The optimal frequency balances: fixed costs per recenter (favors less frequent) vs health floor violations (favors more frequent) vs higher-order IL terms (favors more frequent). Simulation results (section below) suggest the optimal frequency is surprisingly low for this pool — a few dozen recenters per month, not hundreds.

**4. The real constraint is health, not drain.**

The variance drain formula treats all rebalancing frequencies as equivalent. The reason to rebalance at all is health: without recentering, a sustained directional move pushes health below 1.0, triggering liquidation.

The minimum rebalancing frequency is set by: how much can price move before health breaches the safety floor?

For this pool with rx = ry = 0.05 (5% range), a ~4.5% price move exhausts the range on one side. The health factor at the boundary depends on the cross-LTV:

```
h_boundary = 1.0    (by construction — the range is calibrated so h = 1 at the boundary)
```

The pool's range parameters (rx, ry) are chosen precisely so that the health factor equals 1.0 at the reserve boundary. This is the design constraint from section 21 (recenterRange). Any trigger threshold that lets reserves reach the boundary risks liquidation. For rx = 0.05, the 50% trigger means health is ~1.3 at trigger time — reasonable margin, but a fast move can overshoot.

Wider range (higher rx) simultaneously:
- Increases the distance to liquidation (more health margin)
- Reduces leverage (L ∝ 1/rx approximately)
- Reduces variance drain (∝ L)
- Allows less frequent rebalancing

All four effects work in the same direction. **Range width is the single most important parameter for pool viability.**

### Simulation evidence: trigger threshold sweep

Varying the equity trigger threshold at 60% vol (same price path, 30 days):

| Threshold | Auctions | Final NAV | Avg exposure | Min health |
|-----------|----------|-----------|-------------|------------|
| 25% | 571 | $509 (−86%) | 66% | 1.21 |
| 50% | 438 | $498 (−86%) | 68% | 1.21 |
| 100% | 217 | $510 (−86%) | 76% | 1.15 |
| 500% | 44 | $562 (−84%) | 153% | 1.06 |
| Static (daily) | 30 | $3,684 (+2%) | 385% | 1.00 |

The threshold barely matters: 571 vs 44 auctions produce nearly identical NAV (−86% vs −84%). This confirms the variance drain formula — total drain depends on Lσ²T, not on rebalancing frequency. The equity trigger fires frequently at high leverage regardless of threshold setting.

The static strategy's +2% return at 30 daily recenters vs −84% at 44 auctions appears to contradict the theory. It doesn't: the static strategy's "NAV" includes massive unrealized directional exposure (385% average, 845% peak) that would crystallize as loss if the pool ever needed to close. It also sits at min health 1.00 — a single adverse tick triggers liquidation. The static result is a leveraged directional bet that happened to win on this seed, not a viable LP strategy.

### Summary

The core tension of leveraged AMM rebalancing:

- **If you rebalance:** you crystallize IL at rate L·σ²/8 per year. At L = 427× and σ = 60%, the exponent is 19.2/year — half-life of 13 days. The pool bleeds out in weeks.
- **If you don't rebalance:** directional exposure grows and the pool is liquidated on the first sustained move.

The hook's auction mechanism (shift + fee decay + recenter) is efficient at executing individual recenters — 100% clearing rate, 2-4 minute clearing time, fee revenue recaptures ~60% of LP cost. But it cannot change the fundamental cost of rebalancing. The variance drain is a property of the pool's leverage and market volatility, not the rebalancing mechanism.

The actionable conclusion: **reduce leverage.** Computed leverage and survival for different range widths (60% vol, 30 days):

| rx = ry | L_eff | 30d survival | Half-life |
|---------|-------|-------------|-----------|
| 0.05 | 427× | 20.6% | 13 days |
| 0.10 | 196× | 48.5% | 29 days |
| 0.25 | 65× | 78.6% | 87 days |
| 0.50 | 27× | 90.3% | 209 days |
| 1.00 | 12× | 95.6% | 1.3 years |

At rx = 0.25 (L = 65×), the pool retains ~79% of NAV over 30 days — aggressive but survivable, giving fee revenue time to accumulate. At rx = 1.00 (L = 12×), drain is modest (half-life 1.3 years) and plausibly offset by fee revenue. The tradeoff: lower leverage means less pool depth and less fee revenue per unit of volume.
