# Bayesian-Informed Dynamic Fee Model

## Problem

The original fee model used a linear `mismatchScale` multiplier:

```
fee = baseFee + mismatchScale × mismatch
```

With `mismatchScale = 5`, even small mismatches produced outsized fees:

| Mismatch | Fee added | Total fee |
|----------|-----------|-----------|
| 0.01%    | 0.5 bps   | 5.5 bps   |
| 0.1%     | 50 bps    | 55 bps    |
| 0.3%     | 150 bps   | 155 bps   |
| 1.0%     | 500 bps   | 505 bps   |

This penalizes retail traders who arrive when there's any mismatch between Uniswap and EulerSwap — even if the mismatch is too small for arb to be profitable.

## Insight: The No-Arb Zone

Uniswap V3's spot price (slot0) is a censored observation of the true market price. The censoring comes from the **gas band**: an arber won't trade on Uniswap unless the profit exceeds gas costs. This creates a zone around the true price where:

- Uniswap's price may lag the true price by up to `gasThreshold`
- Trades within this zone are **not arb** — they're retail or informed flow
- Only trades above `gasThreshold` are likely arb

## New Formula

```
mismatch = |uniswapPrice − marginalPrice| / uniswapPrice

fee = baseFee + captureRate × max(mismatch − gasThreshold, 0)
```

- **Below gasThreshold**: all swaps pay `baseFee` (likely retail)
- **Above gasThreshold, arb direction**: `baseFee + captureRate × excess`
- **Above gasThreshold, counter-direction**: always `baseFee`
- Clamped to `[baseFee, maxFee]`

## Parameters

### `gasThreshold` (uint64, WAD-scaled)

Minimum mismatch for profitable arb. Estimated from:

```
gasThreshold ≈ swapGasCost_ETH / (poolDepth_ETH × 2)
```

- A 150k gas swap at 5 gwei = 0.00075 ETH
- A $900 pool = ~0.45 ETH depth → gasThreshold ≈ 0.00075 / 0.9 ≈ 8 bps
- For larger pools ($100K), gasThreshold is much smaller (~0.1 bps)

**Typical values**:
- Volatile pairs (USDC/WETH): 20-50 bps (accounts for Uniswap lag + gas)
- Stable pairs (USDC/USDT): 3-10 bps (tight pricing, small gas band)

### `captureRate` (uint256, WAD-scaled)

Fraction of arb profit above threshold to capture. Default: 0.8e18 (80%).

- 80% capture leaves 20% for the arber as incentive to execute
- Higher values extract more LVR but reduce arb flow (worse price tracking)
- Lower values are more competitive but leave more LVR on the table

### `baseFee` (uint64, WAD-scaled)

Resting fee for all swaps. Set competitively vs aggregator spreads.

### `maxFee` (uint64, WAD-scaled)

Hard ceiling. Prevents extreme fees during volatility spikes.

## Example: USDC/WETH Pool

With `baseFee = 5 bps`, `gasThreshold = 30 bps`, `captureRate = 0.8`:

| Mismatch | Type          | Fee    |
|----------|---------------|--------|
| 0.01%    | Retail        | 5 bps  |
| 0.1%     | Retail        | 5 bps  |
| 0.3%     | Borderline    | 5 bps  |
| 0.5%     | Arb direction | 21 bps |
| 1.0%     | Arb direction | 61 bps |
| 2.0%     | Arb direction | 141 bps|
| Counter  | Any mismatch  | 5 bps  |

## Comparison to Old Model

The old model with `mismatchScale = 5` vs new with `gasThreshold = 30bps, captureRate = 0.8`:

| Mismatch | Old fee | New fee | Difference |
|----------|---------|---------|------------|
| 0.1%     | 55 bps  | 5 bps   | Retail now pays 11x less |
| 0.3%     | 155 bps | 5 bps   | Retail within gas band |
| 0.5%     | 255 bps | 21 bps  | Arb, but much more competitive |
| 1.0%     | 505 bps | 61 bps  | Captures arb profit, not volume |

## Implementation

See `LPAgentHook.sol`. The hook reads Uniswap V3 `slot0` for the market reference price, computes the curve's marginal price from the pool's dynamic params, and applies the threshold + capture formula on the arb direction only.
