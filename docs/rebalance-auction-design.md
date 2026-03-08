# Rebalance Auction Design Notes

Working document capturing the analysis and design reasoning for the next-generation rebalancing mechanism. Intended as a reference for developers and agents implementing the design.

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

## 7. Rebalance = Recenter + Auction

A rebalance does two things:
1. **Recenter:** reset the equilibrium price and range to current market
2. **Auction:** controlled delivery of the recenter, preventing value leakage

Without an auction, the recenter creates an instant mispricing that gets arbed in one block — full value leaked as MEV. The auction spreads this over time via a decaying fee.

### Mispricing magnitude after recenter

The mispricing depends on how far reserves have moved from equilibrium. For a pool with range r and reserves at fraction α of the range (0 = at equilibrium, 1 = at boundary):

- At α = 0.5 (mid-range): mispricing ≈ r/2 (e.g. 250 bps for 5% range)
- At α = 1.0 (boundary): mispricing ≈ r (e.g. 500 bps for 5% range)

In practice, rebalances should trigger well before the boundary (see section 13). A health-triggered rebalance at α ≈ 0.3-0.5 creates mispricings of 150-250 bps, determining the auction's starting fee s.

### In-pool auction vs external swap

Two complementary strategies for clearing exposure:

- **In-pool auction (fee decay):** best for small-to-moderate imbalances. The pool sells the excess gradually to arbers at decreasing fees. No external dependencies, atomic, gas-efficient per unit traded.
- **External swap (CowSwap / orderflow router):** better for large imbalances where the pool's own liquidity is insufficient or where batch auctions give better execution. Non-atomic (withdraw → swap → redeposit), introduces trust assumptions and timing risk, but accesses deep external liquidity.

The handoff: use in-pool auctions for routine rebalances (most of the time). Reserve external swaps for large sustained moves where the pool is near boundary and needs to clear significant exposure quickly.

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

### Health constraint

The pool is leveraged. Health = collateral × LTV / debt. If health < 1, the position is liquidated. This creates an absolute upper bound on mismatch accumulation. Higher boost = more fee revenue but thinner health margin. Fee parameters must be calibrated jointly with leverage.

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

The handoff trigger should be health-based: if health has deteriorated by more than X% of the safety margin, recenter. Not absolute reserves (V2's mistake) or NAV percentage (V3, better but still imperfect).

**Rough heuristic for X:** the safety margin is (health_factor - 1.0). If health starts at 1.05 (5% margin), triggering at X = 50% means rebalancing when health drops to 1.025. This leaves a 2.5% buffer for the rebalance auction to complete before liquidation risk. The trigger should be tighter (lower X) for higher-leverage pools and looser for lower leverage. A conservative starting point: trigger when health drops below `1 + 0.5 × (initial_health - 1)`, i.e., 50% of the margin consumed. This is a parameter the agent can tune based on observed rebalance costs and frequency.

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
2. **The fee is the single lever.** Control value leakage through fees, not priceY shifts or curve distortions.
3. **Optimal decay rate = σ₁.** ≈ 4.3 bps/block. Faster wastes through granularity, slower gains nothing.
4. **Batch blocks to reduce variance.** Arbs every ~5-10 blocks, not every block. Accumulated mismatch is more predictable, fee is better calibrated.
5. **Starting fee = known mispricing.** After recenter, start just above the mispricing so arbers take a minimal cut.
6. **Oracle can only raise fees.** f = max(floor, oracle_mismatch). Manipulation-safe by design.
7. **Rebalance trigger = health-based.** Handoff from continuous fees to discrete rebalance when health margin is consumed.
8. **Directional exposure is a risk management problem.** Rebalance to avoid tail losses (liquidation, capital erosion), not to optimize expected returns.
9. **Simple on-chain, sophisticated off-chain.** Contract guarantees safety via robust primitives. Agent optimizes performance via parameter tuning.
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

## 21. Hook Design Candidates

Four designs ordered by complexity. Each builds on the previous. Deploy them sequentially — start simple, add capability as data confirms value.

All designs share the V1 getFee core (oracle-reactive asymmetric fees). They differ in afterSwap behavior and what the on-chain hook vs off-chain agent handles.

### Design V4a: "Agent-Managed" (getFee only, no afterSwap)

The simplest possible hook. Remove all auction logic. The hook only computes fees. The agent handles all rebalancing externally.

**getFee:** identical to V1 — oracle-reactive asymmetric fees with gasCoeff, captureRate, attractRate, baseFee floor.

**afterSwap:** emit an event with post-swap state, then return. No state changes, no reconfigure.

```solidity
function afterSwap(
    uint256 amount0In, uint256 amount1In,
    uint256 amount0Out, uint256 amount1Out,
    uint256 fee0, uint256 fee1,
    address msgSender, address to,
    uint112 reserve0, uint112 reserve1
) external {
    emit SwapObserved(
        reserve0, reserve1,
        amount0In, amount1In, amount0Out, amount1Out,
        fee0, fee1, block.number, tx.gasprice
    );
}
```

**Storage:** fee params only (baseFee, maxFee, gasCoeff, externalFee, captureRate, attractRate). ~6 slots. No auction state.

**Agent responsibility:**
- Monitor health and exposure continuously
- Trigger reconfigure via EVC when health threshold breached
- Adjust fee params based on realized vol, arb frequency
- Handle all rebalancing (in-pool reconfigure or external swap)

**What it tests:**
- Is the fee formula alone sufficient for steady-state operation?
- How responsive does the agent need to be? (Latency budget)
- What fraction of value is lost to agent response delay vs on-chain auction?
- Baseline P&L for comparison with more complex designs

**Strengths:**
- Minimal audit surface (~100 LOC)
- No V2/V3 bugs possible (no auction code)
- Gas-efficient (no state writes in afterSwap beyond event)
- Maximum flexibility — agent can implement any rebalance strategy off-chain

**Risks:**
- Agent downtime = no rebalance = liquidation risk
- Agent latency means pool sits exposed between trigger and response
- Every rebalance requires an agent transaction (gas cost, timing risk)

**Recommended duration:** 1-2 weeks. Collect baseline data.

---

### Design V4b: "Fee-Only Auction" (fee lever only, no curve distortion)

Adds autonomous on-chain auction, but fixes all V2/V3 bugs. The auction is purely a fee change — no priceY shift, no eq=reserves hack. Arbers rebalance the pool naturally by trading through the decaying fee.

**Core insight:** the pool doesn't need to be reconfigured to create an arb opportunity. A mispricing already exists (reserves have drifted from equilibrium). The auction just needs to lower the fee enough for arbers to profitably clear it.

**getFee (auction mode):**

```
if auctionActive:
    elapsed = block.number - auctionStartBlock
    auctionFee = max(baseFee, startingFee - elapsed × decayPerBlock)

    if swap is arb direction (clearing exposure):
        return auctionFee
    else:
        return maxFee    // block flow that worsens exposure

else:
    return normal oracle-reactive fee (same as V4a)
```

**afterSwap (trigger + monitor):**

```
// 1. Compute health or exposure
exposure = computeExposure(reserve0, reserve1)

// 2. Check if auction should START
if !auctionActive && exposure > triggerThreshold:
    auctionActive = true
    auctionStartBlock = block.number
    startingFee = estimateMispricing(reserve0, reserve1)  // ≈ α × r
    emit AuctionStarted(startingFee, block.number)

// 3. Check if auction should END
if auctionActive:
    if exposure < clearThreshold:
        auctionActive = false
        emit AuctionEnded(block.number)

// 4. Always emit state
emit SwapObserved(reserve0, reserve1, ...)
```

**Key differences from V2/V3:**
- **No priceY shift.** The fee is the only lever (principle #2). The curve stays undistorted.
- **No eq = currentReserves hack.** Equilibrium doesn't change during auction. The existing mispricing IS the arb opportunity.
- **Fee floor = baseFee.** Decay stops at baseFee (principle, section 8). Never zero.
- **Decay per block, not per second.** Aligns with the σ₁ analysis. d ≈ σ₁ ≈ 4.3 bps/block.
- **Health-based trigger.** Not absolute reserves or NAV percentage. Uses exposure relative to safety margin.
- **Separate clear vs trigger thresholds.** Trigger at 50% margin consumed, clear when exposure drops below 20%. Prevents oscillation.

**Storage:** fee params + auction state (auctionActive, auctionStartBlock, startingFee, triggerThreshold, clearThreshold, decayPerBlock). ~10 slots.

**Starting fee computation:**

The starting fee should match the known mispricing. For reserves at fraction α of range r:
```
startingFee ≈ α × r / 2
```
This can be computed from reserves and equilibrium:
```
α = (eq0 - reserve0) / (eq0 - minReserve0)    // for ETH-long exposure
mispricing ≈ α × range / 2                      // approximate
startingFee = mispricing + margin                // small buffer above mispricing
```

**What it tests:**
- Does the fee-only auction work as well as the priceY-shift auction?
- Is the arber surplus close to the theoretical (d + σ₁)² × L / 2?
- How many blocks does a typical auction take?
- Does multi-arb sequencing work (section 8)?

**Strengths:**
- Fixes all six V2/V3 bugs
- Autonomous (no agent needed for routine rebalances)
- Simple — only adds ~50 LOC over V4a
- Preserves curve shape throughout auction
- baseFee floor guarantees safe degradation

**Risks:**
- If mispricing estimate is wrong, starting fee is miscalibrated → slow auction or excessive leakage
- No reconfigure means the pool stays at its old equilibrium after the auction clears. The agent should reconfigure afterward to reset. Between auction end and agent reconfigure, the pool may re-drift.
- Clearing threshold needs tuning — too tight = never clears, too loose = clears prematurely

**Agent responsibility (reduced vs V4a):**
- Monitor auction events, reconfigure after auction completes
- Tune triggerThreshold, clearThreshold, decayPerBlock
- Still handles large-scale rebalances (external swaps)
- Adjusts fee params for vol regime changes

**Recommended duration:** 2-4 weeks after V4a baseline.

---

### Design V4c: "Routing-Aware Fees" (attract-side optimization)

V4b plus the routing headroom insight from section 12/16. The attract-side fee is no longer a fixed `baseFee + attractRate × excess` — it charges up to the routing headroom.

**getFee modification (attract side only):**

```
// Normal mode (no auction):
uniPrice = getUniswapPrice()
poolPrice = getMarginalPrice(reserve0, reserve1)
mismatch = |uniPrice - poolPrice| / uniPrice

if isAttractDirection:
    // How much better is our price than Uniswap's for this trader?
    // Our stale price is in their favor by `mismatch`
    // They'd also pay externalFee at Uniswap
    headroom = mismatch + externalFee

    // Charge up to headroom, scaled by attractRate
    attractFee = baseFee + attractRate × headroom
    return min(attractFee, maxFee)

else:  // arb direction (unchanged)
    netEdge = mismatch - gasThreshold - baseFee - externalFee
    return min(baseFee + captureRate × max(0, netEdge), maxFee)
```

**The change is small but the impact is large.** In V4a/V4b, the attract fee formula is:
```
fee = baseFee + attractRate × max(0, mismatch - gasThreshold)
```
The gasThreshold subtraction makes the attract fee very low (often just baseFee) when mismatch is moderate. The new formula replaces this with headroom-aware pricing:
```
fee = baseFee + attractRate × (mismatch + externalFee)
```
No gasThreshold subtraction on attract side — gas cost is the arber's problem, not the retail trader's. And externalFee is *added* (the trader would pay this elsewhere).

**Numerical example:**
- Pool is 15 bps stale, externalFee = 5 bps, baseFee = 3 bps, attractRate = 0.5
- V4a/V4b attract fee: `3 + 0.3 × max(0, 15 - 6) = 3 + 2.7 = 5.7 bps`
- V4c attract fee: `3 + 0.5 × (15 + 5) = 3 + 10 = 13 bps`
- Trader's alternative: Uniswap at 5 bps fee, but their price is 15 bps worse → net cost 20 bps
- Our 13 bps is still 7 bps cheaper than Uniswap. Trader happy. LP earns 7.3 bps more per trade.

**attractRate semantics change:** in V4a/V4b, attractRate scales a penalty. In V4c, it controls what fraction of the routing headroom we capture. attractRate = 0.5 means we take half the headroom and leave half for the trader as incentive. This is closer to the AMM challenge insight — charge as much as routing allows.

**What it tests:**
- Does routing-aware pricing actually capture more retail revenue?
- What attractRate maximizes revenue? (Theory says the optimum is high — 0.5-0.8)
- Does higher attract-side fee reduce volume or increase revenue faster?
- Is the 97/3 split from the AMM challenge reflected in real routing?

**Strengths:**
- Targets the dominant value opportunity (section 16)
- Minimal code change from V4b (~10 lines in getFee)
- Uses existing parameters (no new storage)
- Self-calibrating: as mismatch grows, headroom grows, attract fee grows proportionally

**Risks:**
- Aggregators may not route to us if our fee is too high relative to alternatives
- The headroom formula assumes a single competitor (Uniswap). Real routing involves many venues — actual headroom may be smaller
- Higher attract fees could reduce volume enough to lose on total revenue (need to find the elasticity)

**Recommended duration:** run V4b and V4c simultaneously on different fee params (A/B test via agent param updates).

---

### Design V4d: "Full Autonomous" (auction + reconfigure)

V4c plus afterSwap reconfigure after auction completion. The hook does everything: detects exposure, runs fee-decay auction, then recenters the pool at the new market price. No agent intervention needed for routine rebalances.

**afterSwap (extended):**

```
if auctionActive && exposure < clearThreshold:
    auctionActive = false

    // Recenter the pool at current market price
    DynamicParams memory dp = pool.getDynamicParams();

    // New equilibrium price from Uniswap oracle
    uint256 newPrice = getUniswapPrice();
    (dp.priceX, dp.priceY) = encodePriceRatio(newPrice);

    // New equilibrium reserves: preserve total value at new price
    // eq0_new × price + eq1_new = total_value
    // Use symmetric allocation: eq0 × price = eq1
    uint256 totalValue = reserve0 × newPrice + reserve1;
    dp.equilibriumReserve0 = totalValue / (2 × newPrice);
    dp.equilibriumReserve1 = totalValue / 2;

    // Recompute min reserves for new equilibrium
    dp.minReserve0 = dp.equilibriumReserve0 × BOUNDARY_FACTOR / WAD;
    dp.minReserve1 = dp.equilibriumReserve1 × BOUNDARY_FACTOR / WAD;

    pool.reconfigure(dp, InitialState(reserve0, reserve1));
    emit Recentered(dp.priceX, dp.priceY, dp.equilibriumReserve0, dp.equilibriumReserve1);
```

**Why this is the hardest design:**
- Reconfigure during afterSwap changes the curve. If the new params are wrong, the pool could be in a worse state.
- Price encoding (priceX/priceY with decimal adjustment) is fiddly — off-by-one in decimals = catastrophic mispricing.
- Equilibrium computation must account for leverage, boost, and the actual vault balances (not just reserves).
- The "preserve total value" calculation above is simplified — real implementation needs to account for debt, interest, and vault share prices.

**What it tests:**
- Can the hook autonomously maintain a delta-neutral position?
- How does on-chain reconfigure compare to agent-managed reconfigure?
- Does immediate reconfigure after auction reduce subsequent exposure accumulation?
- Is the gas cost of reconfigure-in-afterSwap acceptable? (~50k additional gas)

**Strengths:**
- Fully autonomous — agent only tunes parameters
- Minimizes time between auction completion and recenter (zero blocks)
- Reduces agent transaction costs (no separate reconfigure tx)

**Risks:**
- Most complex design — largest audit surface
- Oracle dependency for recenter: if Uniswap price is manipulated at the moment of recenter, the new equilibrium is wrong. Unlike getFee (where manipulation is safe-direction), reconfigure with a manipulated price can be permanently damaging.
- Reconfigure failure in afterSwap could leave the hook in inconsistent state (V2 bug #6 revisited)
- The "preserve total value" math is a simplification. Real equity computation requires vault state (deposit shares, debt shares, interest accrual). Getting this wrong means the pool is misconfigured.

**Mitigation for oracle risk:**
- Use TWAP (not slot0) for recenter price. TWAP is harder to manipulate and the latency is acceptable (we're setting a new equilibrium, not pricing a trade).
- Sanity-check: require new price to be within X% of the pre-auction price. If the move is too large, emit an event and let the agent handle it.
- Separate the "end auction" from "reconfigure" — end the auction (fee returns to normal), but don't reconfigure until the agent confirms.

**Recommendation:** defer V4d until V4b/V4c are battle-tested. The oracle risk during reconfigure is fundamentally different from the oracle risk in getFee, and deserves careful analysis. The agent-managed approach (V4a-V4c where agent reconfigures after auction) is safer and only slightly less responsive.

## 22. Design Comparison

| Property | V4a Agent-Managed | V4b Fee Auction | V4c Routing-Aware | V4d Full Auto |
|----------|------------------|-----------------|-------------------|---------------|
| getFee complexity | Low | Medium | Medium | Medium |
| afterSwap complexity | None | Low | Low | High |
| Storage slots | ~6 | ~10 | ~10 | ~12 |
| Auction on-chain | No | Yes (fee only) | Yes (fee only) | Yes (fee + reconfigure) |
| Agent latency tolerance | Low (must respond fast) | High (auction buys time) | High | Very high |
| V2 bugs fixed | All (by removal) | All | All | All (but new risks) |
| Rebalance mechanism | Agent tx | Fee decay → agent reconfigure | Fee decay → agent reconfigure | Fee decay → auto reconfigure |
| Gas per swap | ~0 extra | ~5k (auction check) | ~5k | ~5k normal, ~55k on reconfigure |
| Retail revenue | Baseline | Baseline | Higher (headroom) | Higher (headroom) |
| Audit surface | Minimal | Small | Small | Large |
| Oracle risk | None (getFee is safe-direction) | None | None | Yes (reconfigure uses oracle) |

### Recommended deployment order

1. **V4a** (1-2 weeks): establish baseline. Collect experiments 1-3 data. Confirm fee formula works. Measure agent latency requirements.
2. **V4b** (2-4 weeks): add autonomous auction. Compare auction P&L vs agent-managed. Validate auction mechanics (decay rate, trigger, clearing).
3. **V4c** (concurrent with V4b): A/B test routing-aware attract fees. Measure revenue impact. Find optimal attractRate.
4. **V4d** (only if needed): add auto-reconfigure. Only justified if agent latency is proven insufficient and V4b/V4c auction-then-reconfigure is too slow.

### Switching between designs

All designs share the same pool — only the hook contract changes. To switch:
1. Deploy new hook contract
2. Reconfigure pool via EVC: set `swapHook = newHook`, update `swapHookedOperations`
3. Old hook is abandoned (no state migration needed — each hook initializes fresh)

This means we can run experiments on each design without redeploying the pool. The pool's static params (vaults, assets, euler account) stay the same. Only the dynamic params change.

## 23. Open Questions

1. **Clearing threshold calibration.** V4b uses separate trigger (50% margin consumed) and clear (20%) thresholds. What values minimize total cost? Too tight = oscillating auctions, too loose = exposure lingers.

2. **Starting fee accuracy.** The formula `startingFee ≈ α × r / 2` is approximate. How sensitive is auction performance to starting fee errors? If s is 20% too high, how much time (gas, staleness) is wasted? If 20% too low, how much leakage?

3. **attractRate optimal value.** Section 16 suggests high values (0.5-0.8) based on the AMM challenge. But that was single-competitor. With multi-venue routing, is the optimal attractRate lower?

4. **Interaction between auction and attract fees.** During an auction, should attract-side routing optimization be active? Or should the auction mode override everything (only arb-direction trades allowed)?

5. **Multi-pool agent strategy.** If we run WETH/USDC and USDC/USDT pools simultaneously, should the agent coordinate rebalances? E.g., a USDC surplus in one pool could be routed to the other.

6. **Reconfigure-after-auction timing.** In V4b/V4c, the agent reconfigures after the auction clears. What's the optimal delay? Immediate reconfigure may be suboptimal if the price is still moving. Waiting too long means re-accumulating exposure.

7. **Vol regime detection.** The agent should adjust baseFee based on realized vol. What's the right lookback window? Too short = noisy. Too long = stale. The AMM challenge found fixed parameters beat adaptive ones — does this hold for the agent's slower timescale?
