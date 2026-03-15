# USDC/USDT EulerSwap Pool Analysis

Analysis of Uniswap V3 USDC/USDT 0.01% pool swap data to inform EulerSwap pool design.

**Data source**: Uniswap V3 pool `0x3416cF6C708Da44DB2624D63ea0AAef7113527C6` (USDC/USDT 0.01%), indexed via ponder-uniswap on EC2.

**Period**: ~6 weeks ending 2026-03-15 (blocks 24,152,065 – 24,665,346), 83,831 swaps, $1.48B total volume.

## 1. Market Structure

### Volume & Size Distribution

| Bucket | % of Swaps | % of Volume |
|--------|-----------|-------------|
| <$100 | 28.2% | 0.0% |
| $100–1K | 28.7% | 0.7% |
| $1K–10K | 27.5% | 5.8% |
| $10K–100K | 12.4% | 22.9% |
| $100K–1M | 3.0% | 44.3% |
| >$1M | 0.2% | 26.3% |

- Median swap: $600, mean: $17.7K (heavily whale-skewed)
- 70.6% of volume from swaps >$100K (3.2% of count)
- Daily volume: $3.5M–$52M, averaging ~$15–20M

### Direction

Nearly balanced: 48.6% buy USDT / 51.4% sell USDT.

### Activity Pattern (UTC)

Peak hours 15:00–18:00 (US market open), 2–3x overnight volume. Swap counts more evenly distributed than volume.

### Top Routers

| Router | Volume Share |
|--------|------------|
| Uniswap SwapRouter (old) `0xe592...` | 22.8% |
| `0x66a9...` (likely 1inch) | 10.0% |
| `0x6324...` | 7.4% |
| `0x1f2f...` | 6.8% |
| `0xfbd4...` | 6.1% |

Top 5 routers handle ~53% of volume.

## 2. Price Behavior

### Tick Distribution

The pool spends almost all its time within ticks -3 to 13 (~1.7 bps range around peg). Tick -1 is the single most active tick (10.35% of swaps).

**98.3% of swaps do not change the tick.** The pool sits at the same tick for days at a time. Tick changes happen 0–19 times per day, with large jumps (>50 ticks) only during stress events (Mar 9–10, Feb 24–25).

### Intra-tick Price Movement

Despite tick stability, the continuous price (`sqrtPriceX96`) moves on virtually every swap:

| Metric | Value (bps) |
|--------|-------------|
| Median move per swap | 0.0003 |
| P75 | 0.002 |
| P95 | 0.04 |
| Max (within tick) | ~1.0 |

### Daily Price Travel (Cumulative Absolute Movement)

| Regime | Total Travel (bps) | Days |
|--------|-------------------|------|
| Quiet (weekends, low vol) | 0.7–1.3 | ~8/30 |
| Normal | 2–5 | ~14/30 |
| Active | 5–10 | ~6/30 |
| Peak | 10.7 (Feb 25) | ~2/30 |

**Average: ~4 bps/day of total intra-tick price travel.**

### Oscillation vs Trending

42.8% of consecutive moves are reversals, 57.2% continuations. Mildly trending rather than pure mean-reversion — consistent with directional retail flow within sessions.

### Current Liquidity Depth

Active liquidity `L ≈ 9.7e16`, giving ~$4.85M per tick (1 bps). To move the price 0.01 bps requires ~$485K of flow.

## 3. Key Differences from USDC/WETH

| Factor | USDC/WETH | USDC/USDT |
|--------|-----------|-----------|
| Directional exposure | Primary concern | Negligible |
| Price volatility | High | Near-zero |
| Recentering cost | Significant | Trivial |
| Oracle dependency | Critical | Unnecessary |
| Arb impact | Creates exposure (bad) | Shuffles stablecoins (neutral) |
| Hook complexity needed | High (V7) | Minimal |
| LP value proposition | Fee capture + exposure mgmt | Lending yield + fee capture |

## 4. Intra-tick Arb Hypothesis

### The Idea

Deploy a small EulerSwap pool ($10K equity, 20x leverage = $200K virtual reserves) concentrated within a single Uniswap tick. Because EulerSwap uses a continuous curve with much less depth than Uniswap, its marginal price is far more sensitive to flow:

- **Uniswap**: $4.85M to move 1 bps → $485K to move 0.1 bps
- **EulerSwap** (at 0.1 bps range): $200K to traverse the full range

EulerSwap reprices **24x faster** than Uniswap per dollar of flow. When the "true" rate moves by a fraction of a basis point:

- Uniswap: mispriced, but correcting it requires massive capital relative to the profit. Gas often exceeds arb profit.
- EulerSwap: mispriced, but correctable with much less capital. Arb is gas-efficient.

This means EulerSwap captures micro-arb flow that Uniswap is too deep to service profitably.

### Volume Estimate

With ~4 bps of daily intra-tick travel and a 0.1 bps EulerSwap range:

- **Traversals per day**: 7–13 (quiet) to 50–107 (active), average ~40
- **Theoretical max**: 40 × $200K = $8M/day
- **Realistic estimate**: $1–3M/day accounting for partial traversals and the 42.8% reversal rate
- **Fee income at 0.5 bps**: $500–$1,500/day on $10K equity

### Caveats

1. Most individual moves are 0.0003 bps — 300x smaller than a 0.1 bps range. Most swaps would only partially traverse the range.
2. Volume capture depends on aggregator routing. The pool must be integrated with routing APIs (1inch, CowSwap, etc.) to receive flow.
3. The 42.8% reversal rate means some volume is "round-trip" within a session, but 57.2% trends directionally — the pool will accumulate inventory on one side during trending periods.
4. For stablecoins the inventory risk is minimal, but recentering mechanics still needed to reset the curve after directional flow.

## 5. Open Questions

- Do aggregators already split USDC/USDT swaps across venues at sub-$200K sizes? If so, EulerSwap could capture routing share immediately.
- What fee level wins routing? Uniswap charges 1 bps. Can EulerSwap charge 0.5 bps and still beat on net execution?
- Is a hook needed at all for a stablecoin pair, or is a vanilla EulerSwap pool sufficient?
- What's the optimal concentration parameter? Tighter range = more sensitive pricing = more arb traversals, but also faster inventory accumulation.
- How does Euler vault lending yield on USDC and USDT compare to the fee income? The yield may dominate.
