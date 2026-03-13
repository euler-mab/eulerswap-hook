# Yield Basis vs EulerSwap: Simulation Comparison

## Overview

Both Yield Basis (YB) and EulerSwap solve the same fundamental problem: **how to rebalance a leveraged LP position without external swaps**. They use the same core mechanism (arb-driven rebalancing) but package it differently — and target different users:

- **YB**: BTC holders deposit BTC → protocol borrows USD, LPs at 2× leverage → position tracks BTC 1:1 (neutral in BTC terms). The depositor earns yield on BTC without IL.
- **EulerSwap**: Stablecoin holders deposit USDC → pool borrows ETH via Euler vaults → hook recenters to minimize exposure (neutral in USD terms). The LP earns fees without directional risk.

The neutrality direction (BTC vs USD) is a product decision. The mechanism question — how efficiently each system recaptures LVR during rebalancing — is what this analysis measures.

| | Yield Basis | EulerSwap |
|---|---|---|
| **Product** | Vault: deposit BTC, receive ybBTC, earn yield | Pool: LP configures params, hook manages exposure |
| **Neutrality** | BTC-neutral (IL eliminated via 2× leverage) | USD-neutral (exposure minimized via recentering) |
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
YB L=2 70bps       -$17,000    $3,090   -$4,537   -$15,553    0%    236
YB L=2 30bps       -$18,989    $2,941   -$6,388   -$15,542    0%    466
YB L=2 5bps        -$22,039      $827   -$7,355   -$15,512    0%    676
ES oracle+recenter $107,537  $839,831 -$775,531    $47,062   22%     81
ES full stack      -$79,335  $536,967 -$603,791   -$11,964   18%    113
ES static 30bps   -$205,414  $125,422 -$311,801   -$13,640   10%      0
ES unlev orc+rctr   -$5,652    $3,022   -$2,515    -$6,159    1%     91
ES unlev 30bps      -$6,862      $552   -$1,394    -$6,021    0%      0
```

### Mechanism Comparison (Capture Rate)

The capture rate (arbFees / |edge|) is a ratio independent of curve depth, so it isolates the fee mechanism even across different leverage levels:

```
Strategy               NetFees   |Edge|   Arb Capture
──────────────────────────────────────────────────────
xy=k 30bps              $1,431   $3,732        38%
YB L=2 70bps            $3,090   $4,537        68%
ES unlev orc+rctr       $3,022   $2,515        92%
ES unlev 30bps            $552   $1,394        38%
```

The unleveraged ES rows (vyx=vxy=0, ~50/50 equity split, no borrowing) are included for reference but note this is not a true equal-leverage comparison: YB at L=2 has 2× curve depth from borrowed USDC, while ES unlev has 1× (no borrowing). The ΔNAV figures (-$17,000 vs -$5,652) are **not comparable** across these leverage levels — YB's 2× leverage amplifies directional PnL variance ($185K std vs $93K), which dominates the ΔNAV difference.

What IS comparable: the capture rate. Oracle-reactive fees capture 92% of arb edge vs fixed 70bps capturing 68%. This holds regardless of leverage because it's a ratio — deeper curves attract proportionally more arb volume and LVR, but the fraction recaptured depends on the fee mechanism.

### Volatility (Standard Deviation)

```
Strategy              ΔNAV    NetFees    DirPnL   DirPnL/ΔNAV
─────────────────────────────────────────────────────────────
xy=k 30bps          $93,958      $82    $94,026      100%
YB L=2 70bps       $184,931     $367   $185,042      100%
YB L=2 5bps        $184,031      $83   $184,562      100%
ES full stack       $67,479   $62,647    $52,732       78%
ES unlev orc+rctr   $92,525   $1,293    $92,510      100%
```

## Analysis

### 1. YB Releverage AMM is a Net Cost

For the releverage AMM in isolation:
- **Fees**: $3,090/month at 70 bps (optimal per paper)
- **LVR (edge)**: -$4,537/month
- **Net**: -$1,447/month cost of maintaining L=2 leverage

This confirms the paper's Eq. 12: the releverage AMM is not profitable by itself. It's a **cost center** — the LP pays ~$1,450/month for the privilege of maintaining L=2 leverage. The profitability comes from the base pool (CryptoSwap) returns being 2× amplified:

```
APR = 2 × r_pool - (r_borrow + r_loss)
```

Where `r_loss` ≈ $1,450/month = 1.74% annualized at 60% vol.

### 2. Higher Fee = Less LVR, But Fewer Recenters

| Fee | Net Fees | LVR | Recenters | Net Cost |
|-----|----------|-----|-----------|----------|
| 70 bps | $3,090 | $4,537 | 236 | $1,447 |
| 30 bps | $2,941 | $6,388 | 466 | $3,447 |
| 5 bps | $827 | $7,355 | 676 | $6,528 |

The 70 bps fee is indeed optimal: it minimizes net cost. Higher fees mean fewer arbs can profitably trade (wider no-arb band), so fewer recenters occur. But fewer recenters means the pool accumulates more exposure between updates, leading to more LVR when arbs finally do trade.

### 3. YB's Fixed Fee Eliminates Retail

All YB variants show **0% retail capture**. At 70 bps, the YB pool is 140× more expensive than the 5 bps reference venue. No rational retail trader would use it.

This is by design — the releverage AMM isn't meant to serve retail. That's the base pool's job. But it means:
- **YB**: revenue = arb fees only (releverage AMM) + base pool fees (not simulated)
- **EulerSwap**: revenue = arb fees + retail fees (both from same pool)

### 4. EulerSwap's Dynamic Fees Create a Different Tradeoff

ES full stack charges high fees on arbs (capturing LVR) and low fees on exposure-reducing flow (attracting retail). This gives:
- **$536,967** net fees (173× more than YB)
- But **$603,791** edge (133× more LVR)
- **18% retail capture** (vs 0% for YB)

The ratio that matters: **fee capture rate** = how much LVR the pool recovers. Two ways to measure:

**Arb-only capture rate** (arbFees / |edge|) — isolates the fee mechanism:

| Strategy | ArbFees | |Edge| | Arb Capture |
|----------|---------|--------|-------------|
| xy=k 30bps | $1,403 | $3,732 | 38% |
| YB L=2 70bps | $3,093 | $4,543 | 68% |
| ES full stack | $579,117 | $603,791 | 96% |

**Net capture rate** (netFees / |edge|) — includes retail revenue and auction costs:

| Strategy | NetFees | |Edge| | Net Capture |
|----------|---------|--------|-------------|
| xy=k 30bps | $1,431 | $3,732 | 38% |
| YB L=2 70bps | $3,090 | $4,537 | 68% |
| ES full stack | $536,967 | $603,791 | 89% |
| ES oracle+recenter | $839,831 | $775,531 | 108% (!) |
| ES unlev orc+rctr | $3,022 | $2,515 | 92% |

For ES full stack, the gap between 96% arb capture and 89% net capture is the auction cost ($53,557). Retail adds $11,407 but auctions cost $53,557 — the auction mechanism is a net cost but enables the continuous recentering that keeps exposure low.

**At equal leverage** (ES unlev vs YB), the mechanism advantage is clear: 92% vs 68% arb capture, with comparable fee revenue ($3,022 vs $3,090) but much less LVR ($2,515 vs $4,537). The leverage boost amplifies both fees and LVR proportionally.

### 5. Directional PnL Dominance

For YB, directional PnL std ($185K) accounts for 100% of ΔNAV variance. The 2× leverage amplifies price exposure — YB tracks ETH price with 100% average exposure.

ES full stack achieves 78% DirPnL/ΔNAV ratio and much lower DirPnL std ($52K), because the auction mechanism actively neutralizes exposure (30% avg exposure vs 100%).

### 6. Discrete IL Validation

The paper predicts discrete releverage IL ≈ Lσ²T/8 per period:
- Theoretical: 2 × 0.6² × (30/365) / 8 × $1M = **$7,397**
- Actual |edge|: **$4,537**

The actual is ~61% of theoretical. The difference is because:
1. Fee creates a no-arb band (not every step triggers a trade)
2. The theoretical formula assumes continuous observation of IL

## What YB Would Need to Beat EulerSwap

For the releverage mechanism alone:
1. **Higher leverage**: L=2 is modest. EulerSwap's ~466× boost via LLTV is the key advantage.
2. **Integrated retail**: YB's two-AMM split means retail goes to the base pool. EulerSwap serves both from one pool, earning retail fees on the same capital.
3. **Dynamic fees**: YB's fixed fee can't adapt to market conditions. EulerSwap's oracle-reactive fees capture more LVR (92% vs 68% at equal leverage) and attract retail (1% vs 0% even without leverage boost).

The YB paper's value proposition is about the base pool (CryptoSwap) returns amplified by leverage, minus the releverage cost. EulerSwap achieves something similar but with:
- Much higher leverage (vault-backed)
- Integrated retail flow
- Dynamic fee optimization
- Auction-based rebalancing (less frequent but capital-efficient)

## The Two-AMM Architecture

Both YB and EulerSwap solve the identical rebalancing problem with the identical mechanism:

1. Price moves → pool is mispriced relative to market
2. Arber notices → trades to correct the mispricing
3. Pool pays the arber (via LVR) but recaptures some via fees
4. Pool resets to neutral leverage

The difference is packaging. EulerSwap does this in one pool with explicit cost tracking (`auctionCost` in the P&L decomposition). YB does it in a separate releverage AMM.

### The releverage cost

The YB paper is upfront about this: the releverage AMM is a cost center, not a profit center. It earns $3,090/month in fees but leaks $4,537/month in LVR, for a net cost of ~$1,450/month. The paper's Eq. 12 explicitly models this as the price of maintaining leverage:

```
Net APR = 2 × base_pool_APR − borrow_cost − releverage_loss
        = 2 × 15%           − 5%           − 1.7%
        = 23.3% (if base pool earns 15%)
```

This is not a hidden cost — the paper treats it as known overhead justified by the 2× amplification of base pool returns. The question is whether 1.7% annualized drag (at 60% vol) is acceptable given the base pool APR. At BTC's ~40% vol, the drag drops to ~0.75% annualized.

### The dependency chain

The LP's position is only profitable if `2 × base_pool_APR > borrow_cost + releverage_loss`. This requires two separate mechanisms to jointly work: the CryptoSwap base pool must generate sufficient returns, AND the releverage AMM must keep costs reasonable.

EulerSwap also has dependencies (Euler vaults, oracle accuracy, arber participation), but its profitability doesn't hinge on a separate base pool's performance.

### Architectural comparison

**EulerSwap advantages:**

1. **Higher arb capture rate** — dynamic fees recover 92% of arb LVR vs YB's 68%, because fees adapt per-swap rather than using a fixed rate
2. **Integrated retail** — the same pool serves both arb and retail with direction-aware fees. YB's releverage AMM serves only arb; retail goes to the separate base pool
3. **Single-pool profitability** — revenue and costs are in the same pool, so the LP can evaluate performance directly without needing a separate mechanism to justify the cost

**YB advantages:**

1. **Proven at scale** — $200M TVL, $1.63B volume, operating for a year on mainnet. EulerSwap's hook-based approach is newer and less battle-tested
2. **Simpler on-chain mechanism** — the releverage AMM is a standard xy=k curve with a fixed fee. No oracle dependency in the fee path, no auction state machine
3. **Base pool returns** — the 2× amplification of CryptoSwap returns is the actual value proposition. If the base pool earns well, the releverage cost is justified overhead. We don't simulate this benefit, so our analysis structurally undervalues YB
4. **Lower smart contract risk** — fewer moving parts (no oracle-reactive fees, no auction backstop, no surcharge decay) means a smaller attack surface

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

### Fee Split

YB's fee split is **50/50**: 50% to LPs, 50% to veYB holders (DAO governance revenue). This is a governance revenue extraction, not a direct "rebalancing subsidy" — the rebalancing cost is borne implicitly through LVR (arbers extracting value from the releverage AMM), not through explicit fee allocation.

However, the magnitude is suggestive. If the releverage AMM is a net cost center (fees < LVR), then LP revenue is reduced by that gap. The DAO taking 50% on top further dilutes LP returns, making the organic yield even more dependent on the base pool.

### Scaling to Real Numbers

Our simulation predicted the releverage AMM nets −$1,448/month per $1M equity at 60% vol (WETH). Scaling to YB's reality:

- **$200M TVL, BTC vol ~40%**: releverage drag scales with σ², so at 40% vs 60% vol the cost is ~(40/60)² = 44% as much per dollar. Roughly −$128K/month drag at $200M.
- **Actual fee revenue**: $3.8M/year total, $1.9M after 50/50 split to LPs
- **DAO take**: $1.9M/year ($158K/month) to veYB holders — comparable in magnitude to the estimated releverage drag
- Our sim-predicted releverage drag: ~$128K/month. **Same order of magnitude**, though the two are not the same thing (DAO revenue vs LVR cost).

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

2. **Organic yield is modest but real** — 1.9% in real BTC terms, without impermanent loss, is competitive with many BTC yield sources. The headline 20-30% APY includes token emissions, which is standard DeFi bootstrapping — not unique to YB.

3. **The DAO take is comparable to the releverage drag** — $158K/month DAO revenue vs $128K/month estimated LVR drag. These are different costs (governance extraction vs arb leakage), but their similar magnitude means the LP bears roughly 2× the releverage drag: once from LVR, once from the DAO fee split.

4. **The dependency chain is real** — 72% crvUSD concentration, $1B credit line dependency, governance risk, and arber availability all represent failure modes. EulerSwap has its own dependencies (Euler vaults, oracles), but avoids the two-AMM revenue split.

5. **Scale matters** — $200M TVL is significant, proving market demand for "BTC yield without IL." But the sustainable yield (post-emissions) is the real test.

## Fair Assessment

**What this analysis proves:**
- Oracle-reactive dynamic fees capture more arb edge than fixed fees (92% vs 68%). This is a clean, leverage-independent result.
- Integrating retail into the rebalancing pool is strictly better than a separate AMM that can't serve retail.

**What this analysis does NOT prove:**
- That EulerSwap is a better product for LPs. YB's full value proposition is `2× base_pool_APR − costs`. We only simulate the cost side (the releverage AMM). If Curve CryptoSwap earns 8-15% APY on concentrated BTC liquidity, the 0.75-1.7% releverage drag may be acceptable. We never estimate this benefit.
- That ΔNAV comparisons across leverage levels are meaningful. YB at L=2 vs ES unlev conflates mechanism quality with leverage choice.
- That the 466× leveraged ES strategies are practical at the simulated scale. In production, the EulerSwap pool operates at much more modest depth.

**Where this analysis is biased toward EulerSwap:**
- We simulate YB's cost center in isolation but not its revenue center (base pool returns).
- The "hidden cost" framing in earlier versions was unfair — the YB paper explicitly models the releverage cost and treats it as known overhead. It is not hidden.
- The emissions criticism (1.9% organic vs 20-30% headline) applies to most DeFi protocols at scale, not specifically to YB.
- YB has operated at $200M TVL for a year. EulerSwap's hook architecture is newer, with less production validation.

**Bottom line:** EulerSwap has a genuinely better fee mechanism (higher capture rate, integrated retail). Whether that translates to a better LP product depends on whether the integrated approach outperforms YB's `2× base_pool − costs` at comparable scale — a question this simulation cannot answer.

## Simulation Details

- **Script**: `scripts/yb-comparison.ts`
- **Strategy impl**: `yieldBasisReleverageStrategy()` in `src/lib/sim-strategy.ts`
- **Price model**: GBM, 60% annualized vol, 0% drift
- **Retail**: Poisson arrivals (3/hour), lognormal sizes (mean $5K), 5 bps reference venue
- **Borrow rate**: 5% annual (tracked inside YB hook; engine Phase 3 for EulerSwap)
- **Seeds**: 50, decomposition residuals all < $1

### Known Limitations

1. **YB interest tracking**: Interest on structural debt is tracked inside the afterSwap hook (deducted from equity on recenter), not the engine's Phase 3. The hook tracks elapsed steps since last accrual so interest is correct even when steps have no swap. Interest shows as $0 in the Interest column and gets folded into DirPnL. The NAV impact is correct.

2. **Base pool not simulated**: YB's full value proposition requires the base CryptoSwap pool returns. We only simulate the releverage AMM component, which is intentionally a net cost. The comparison is: "cost of re-leveraging via YB" vs "integrated fee capture via EulerSwap". This structurally makes YB look worse than a complete picture would — the LP earns 2× base pool returns minus releverage cost, but we only measure the cost side.

3. **Leverage not comparable**: EulerSwap's LLTV boost (~466×) vs YB L=2 means the leveraged strategies operate at wildly different scales. The equal-leverage comparison (ES unlev vs YB) controls for this, showing the mechanism advantage persists: 92% vs 68% arb capture, $2,515 vs $4,537 LVR.

4. **On-chain data from secondary sources**: YB metrics (TVL, yield, fee split) were sourced from Valueverse, Apollo Crypto, and similar — not primary on-chain queries. Figures may be outdated or imprecise.
