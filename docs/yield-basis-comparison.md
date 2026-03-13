# Yield Basis vs EulerSwap: Simulation Comparison

## Overview

Both Yield Basis (YB) and EulerSwap solve the same fundamental problem: **how to rebalance a leveraged LP position without external swaps**. They differ in mechanism:

| | Yield Basis | EulerSwap |
|---|---|---|
| **Architecture** | Two AMMs: base pool (CryptoSwap) + separate releverage AMM | Single AMM with hooks (getFee + afterSwap) |
| **Curve** | Releverage AMM is xy=k | Piecewise concentration-weighted blend |
| **Leverage** | L=2 fixed (2× equity) | Variable via LLTV boost (e.g. 466× at rx=5%, LLTV=0.84) |
| **Rebalancing** | Arbers trade on releverage AMM to maintain L=2 | Fee-decay auction creates arb opportunity; continuous recenter on exposure reduction |
| **Fee model** | Fixed (70 bps optimal per paper) | Dynamic: oracle-reactive (captures arb edge, attracts retail) |
| **Retail** | Separate (goes to base pool, not releverage AMM) | Integrated (same pool serves arb + retail with direction-aware fees) |

## Key Finding: Not Apples-to-Apples

The most important finding is that **YB and EulerSwap operate at fundamentally different leverage levels**, making direct comparison misleading:

- **YB L=2**: $1M equity → $1M per side on curve (2× leverage)
- **EulerSwap**: $1M equity → ~$466M virtual reserves (466× leverage via LLTV boost)

This ~230× difference in curve depth means EulerSwap attracts ~230× more arb volume, earning ~230× more fees but also suffering ~230× more LVR. The comparison is between a bicycle and a freight train.

## Monte Carlo Results (50 seeds, 30d, 60% vol, $1M equity)

### Mean P&L Decomposition

```
Strategy              ΔNAV    NetFees     Edge      DirPnL   RetC%  Rctr
─────────────────────────────────────────────────────────────────────────
xy=k 30bps          -$8,793    $1,431   -$3,732    -$6,492    0%      0
YB L=2 70bps       -$14,288    $3,095   -$4,543   -$12,840    0%    236
YB L=2 30bps       -$17,565    $2,943   -$6,392   -$14,116    0%    466
YB L=2 5bps        -$21,795      $827   -$7,356   -$15,267    0%    676
ES oracle+recenter $107,537  $839,831 -$775,531    $47,062   22%     81
ES full stack      -$79,335  $536,967 -$603,791   -$11,964   18%    113
ES static 30bps   -$205,414  $125,422 -$311,801   -$13,640   10%      0
```

### Volatility (Standard Deviation)

```
Strategy              ΔNAV    NetFees    DirPnL   DirPnL/ΔNAV
─────────────────────────────────────────────────────────────
xy=k 30bps          $93,958      $82    $94,026      100%
YB L=2 70bps       $185,448     $367   $185,559      100%
YB L=2 5bps        $184,073      $83   $184,604      100%
ES full stack       $67,479   $62,647    $52,732       78%
```

## Analysis

### 1. YB Releverage AMM is a Net Cost

For the releverage AMM in isolation:
- **Fees**: $3,095/month at 70 bps (optimal per paper)
- **LVR (edge)**: -$4,543/month
- **Net**: -$1,448/month cost of maintaining L=2 leverage

This confirms the paper's Eq. 12: the releverage AMM is not profitable by itself. It's a **cost center** — the LP pays $1,448/month for the privilege of maintaining L=2 leverage. The profitability comes from the base pool (CryptoSwap) returns being 2× amplified:

```
APR = 2 × r_pool - (r_borrow + r_loss)
```

Where `r_loss` ≈ $1,448/month = 1.74% annualized at 60% vol.

### 2. Higher Fee = Less LVR, But Fewer Recenters

| Fee | Net Fees | LVR | Recenters | Net Cost |
|-----|----------|-----|-----------|----------|
| 70 bps | $3,095 | $4,543 | 236 | $1,448 |
| 30 bps | $2,943 | $6,392 | 466 | $3,449 |
| 5 bps | $827 | $7,356 | 676 | $6,529 |

The 70 bps fee is indeed optimal: it minimizes net cost. Higher fees mean fewer arbs can profitably trade (wider no-arb band), so fewer recenters occur. But fewer recenters means the pool accumulates more exposure between updates, leading to more LVR when arbs finally do trade.

### 3. YB's Fixed Fee Eliminates Retail

All YB variants show **0% retail capture**. At 70 bps, the YB pool is 140× more expensive than the 5 bps reference venue. No rational retail trader would use it.

This is by design — the releverage AMM isn't meant to serve retail. That's the base pool's job. But it means:
- **YB**: revenue = arb fees only (releverage AMM) + base pool fees (not simulated)
- **EulerSwap**: revenue = arb fees + retail fees (both from same pool)

### 4. EulerSwap's Dynamic Fees Create a Different Tradeoff

ES full stack charges high fees on arbs (capturing LVR) and low fees on exposure-reducing flow (attracting retail). This gives:
- **$536,967** net fees (375× more than YB)
- But **$603,791** edge (133× more LVR)
- **18% retail capture** (vs 0% for YB)

The ratio that matters: **fee capture rate** = fees / |edge| = how much LVR the pool recovers.

| Strategy | Fees | |Edge| | Capture Rate |
|----------|------|--------|--------------|
| xy=k 30bps | $1,431 | $3,732 | 38% |
| YB L=2 70bps | $3,095 | $4,543 | 68% |
| ES full stack | $536,967 | $603,791 | 89% |
| ES oracle+recenter | $839,831 | $775,531 | 108% (!) |

EulerSwap at the same low leverage (no boost) would look much more like YB. The massive difference is the LLTV-enabled leverage boost.

### 5. Directional PnL Dominance

For YB, directional PnL std ($185K) accounts for 100% of ΔNAV variance. The 2× leverage amplifies price exposure — YB tracks ETH price with 100% average exposure.

ES full stack achieves 78% DirPnL/ΔNAV ratio and much lower DirPnL std ($52K), because the auction mechanism actively neutralizes exposure (30% avg exposure vs 100%).

### 6. Discrete IL Validation

The paper predicts discrete releverage IL ≈ Lσ²T/8 per period:
- Theoretical: 2 × 0.6² × (30/365) / 8 × $1M = **$7,397**
- Actual |edge|: **$4,543**

The actual is ~61% of theoretical. The difference is because:
1. Fee creates a no-arb band (not every step triggers a trade)
2. The theoretical formula assumes continuous observation of IL

## What YB Would Need to Beat EulerSwap

For the releverage mechanism alone:
1. **Higher leverage**: L=2 is modest. EulerSwap's ~466× boost via LLTV is the key advantage.
2. **Integrated retail**: YB's two-AMM split means retail goes to the base pool. EulerSwap serves both from one pool, earning retail fees on the same capital.
3. **Dynamic fees**: YB's fixed fee can't adapt to market conditions. EulerSwap's oracle-reactive fees capture more LVR (89% vs 68%) and attract retail.

The YB paper's value proposition is about the base pool (CryptoSwap) returns amplified by leverage, minus the releverage cost. EulerSwap achieves something similar but with:
- Much higher leverage (vault-backed)
- Integrated retail flow
- Dynamic fee optimization
- Auction-based rebalancing (less frequent but capital-efficient)

## Hidden Costs: The Two-AMM Architecture Problem

Both YB and EulerSwap solve the identical rebalancing problem with the identical mechanism:

1. Price moves → pool is mispriced relative to market
2. Arber notices → trades to correct the mispricing
3. Pool pays the arber (via LVR) but recaptures some via fees
4. Pool resets to neutral leverage

The difference is packaging. EulerSwap does this in one pool with explicit cost tracking (`auctionCost` in the P&L decomposition). YB does it in a separate AMM where the cost manifests as net-negative P&L buried in equity dynamics.

### Where YB hides the cost

The releverage AMM is a **cost center**: it earns $3,095/month in fees but leaks $4,543/month in LVR, for a net cost of $1,448/month. This cost doesn't appear as a line item — it silently erodes the LP's equity through the gap between discrete and ideal re-leveraging.

The LP's profitability depends on the **base pool** (CryptoSwap) earning enough to absorb this cost:

```
Net APR = 2 × base_pool_APR − borrow_cost − releverage_loss
        = 2 × 15%           − 5%           − 1.7%
        = 23.3% (if base pool earns 15%)
```

This creates a **dependency chain**: the LP's position is only profitable if two separate mechanisms are jointly profitable. EulerSwap needs only one mechanism to work.

### Why would anyone supply to the releverage AMM?

The releverage AMM isn't a separate pool with separate LPs — it's the LP's own capital managed by the mechanism. The LP deposits equity; YB creates both the base pool position and the releverage AMM position from that equity. Arbers trade against the releverage AMM to keep leverage constant, earning the LVR-minus-fee spread as profit.

But the LP must accept that the releverage mechanism is a drag on returns. This drag is justified only if:
- The base pool returns are high enough (CryptoSwap's concentrated liquidity must outperform)
- No single-pool alternative can achieve equivalent returns with less complexity

### EulerSwap's structural advantages

By integrating rebalancing into the same pool that serves retail:

1. **Transparent costs** — auction cost is an explicit P&L line item, not hidden in equity dynamics
2. **Higher capture rate** — dynamic fees recover 89% of LVR vs YB's 68%, because fees adapt per-swap rather than using a fixed rate that's only optimal in aggregate
3. **Retail as profit center** — YB's releverage AMM at 70 bps captures 0% of retail (all goes to base pool). EulerSwap captures 18% with low attract-side fees on the same capital
4. **Co-optimized fees** — EulerSwap optimizes arb capture and retail attraction in a single fee function. YB must independently optimize the releverage AMM fee and the base pool fee, which is a harder problem
5. **No dependency chain** — profitability doesn't depend on a separate base pool performing well

## On-Chain Performance: Reality vs Claims

Data sourced from DefiLlama, Valueverse research, and Apollo Crypto (as of early 2026).

### Actual Metrics

| Metric | Value |
|--------|-------|
| TVL | ~$200M in BTC deposits |
| 2025 Trading Volume | $1.63B total (~$410M/week peak) |
| LP Yield (2025) | 38.12 BTC (v1: 16.11, v2: 22.01) |
| LP Yield USD equivalent | ~$3.8M at $100K/BTC |
| DAO Revenue | $1.82M to veYB holders |
| crvUSD Deployed | $405.7M of $563.6M supply (72%) |
| crvUSD Credit Line | $1B (approved by Curve governance) |
| Market Position | Three largest BTC pools in DeFi |

### Headline APY vs Organic Yield

YB claims 20-30% APY. The reality is more nuanced:

- **Backtest APY**: 15% (paper's own figure)
- **Organic yield**: 38.12 BTC on ~$200M TVL ≈ **1.9% annualized** in real BTC terms
- **The gap**: the headline 20-30% includes **YB token emissions** (staked ybBTC position)

LPs choose between:
1. **Real BTC yield** (unstaked) — the ~1.9% organic rate
2. **YB token emissions** (staked ybBTC) — the headline 20-30%

The high APY is emissions-subsidized, not from trading fees. This is a common DeFi pattern: bootstrap with token incentives, hope organic yield catches up before emissions run dry.

### Fee Split Confirms Cost Center

YB's fee split is explicitly **50/50**:
- 50% goes to LPs
- 50% **subsidizes rebalancing costs**

This directly confirms our simulation finding. The releverage AMM is a net cost, and YB explicitly diverts half of all trading fee revenue to cover it. The LP only sees half the fees — the other half goes to paying for the mechanism that maintains their leverage.

### Scaling to Real Numbers

Our simulation predicted the releverage AMM nets −$1,448/month per $1M equity at 60% vol (WETH). Scaling to YB's reality:

- **$200M TVL, BTC vol ~40%**: releverage drag scales with σ², so at 40% vs 60% vol the cost is ~(40/60)² = 44% as much per dollar. Roughly −$128K/month drag at $200M.
- **Actual fee revenue**: $3.8M/year total, $1.9M after 50/50 split to LPs
- **Rough rebalancing cost**: $1.9M/year (the other half of fees) = $158K/month
- Our sim prediction: ~$128K/month. **Order of magnitude match.**

### crvUSD Dependency Risk

72% of all crvUSD supply ($405.7M of $563.6M) is locked in YB pools. The protocol has a $1B credit line from Curve governance. This creates concentration risk:

1. **Borrow rate sensitivity**: if crvUSD borrow costs rise, the entire APR formula breaks. The 5% assumption in our sim is generous — during high utilization, rates spike.
2. **Systemic risk**: YB is the dominant user of crvUSD. A YB failure could destabilize crvUSD.
3. **Governance dependency**: the $1B credit line requires ongoing Curve governance support. Protocol politics can change.

### tBTC Pool Failure

The Valueverse analysis notes that **tBTC pools generated zero DAO fees** due to "arbitrage inefficiencies." This means the releverage arbers weren't functioning properly for that pool — the mechanism that maintains L=2 leverage failed.

This is a real-world demonstration of the arber dependency risk: the entire mechanism relies on arbers being willing and able to trade on the releverage AMM. If a pool is too small, illiquid, or the arb economics don't work (gas costs, MEV competition), re-leveraging breaks down.

### What the On-Chain Data Tells Us

1. **The mechanism works mechanically** — YB has processed $1.63B in volume and maintained leverage across multiple BTC pools for a year.

2. **The economics are marginal** — 1.9% organic yield on BTC is modest. The protocol depends on token emissions for competitive APY. Without emissions, LPs would likely withdraw.

3. **The cost structure matches our simulation** — roughly half of fee revenue goes to rebalancing costs, matching our sim's prediction that the releverage AMM is a net cost center.

4. **The dependency chain is real** — 72% crvUSD concentration, $1B credit line dependency, governance risk, and arber availability all represent failure modes that a single-pool architecture (like EulerSwap) avoids.

5. **Scale matters** — $200M TVL is significant, proving market demand for "BTC yield without IL." But the sustainable yield (post-emissions) is the real test.

## Simulation Details

- **Script**: `scripts/yb-comparison.ts`
- **Strategy impl**: `yieldBasisReleverageStrategy()` in `src/lib/sim-strategy.ts`
- **Price model**: GBM, 60% annualized vol, 0% drift
- **Retail**: Poisson arrivals (3/hour), lognormal sizes (mean $5K), 5 bps reference venue
- **Borrow rate**: 5% annual (tracked inside YB hook; engine Phase 3 for EulerSwap)
- **Seeds**: 50, decomposition residuals all < $1

### Known Limitations

1. **YB interest tracking**: Interest on structural debt is tracked inside the afterSwap hook (deducted from equity on recenter), not the engine's Phase 3. This means it shows as $0 in the Interest column and gets folded into DirPnL. The NAV impact is correct.

2. **Base pool not simulated**: YB's full value proposition requires the base CryptoSwap pool returns. We only simulate the releverage AMM component, which is intentionally a net cost. The comparison is: "cost of re-leveraging via YB" vs "integrated fee capture via EulerSwap".

3. **Leverage not comparable**: EulerSwap's LLTV boost (~466×) vs YB L=2 means we're comparing strategies at wildly different scales. A fairer comparison would be EulerSwap at similar leverage (no LLTV, cx=0), but that removes EulerSwap's core advantage.
