# V7 Hook Parameters: USDC/USDT Pool

Conservative first deployment. Strategy: lean on continuous recenter + dynamic fee to stay in range. Auctions are rare emergency backstop, not primary mechanism.

## Key Assumptions

- Equity: $5K USDC deposited
- Leverage: ~12x (conservative vs 16.7x max at 94% LTV)
- Virtual depth: ~$60K per side
- Gas cost: $0.37 (350K gas × 0.43 gwei)
- Competing with: Uniswap V4 at 0.08 bps, $1.35M/tick
- Oracle: Uniswap V3 USDC/USDT 0.01% (V4 preferred but needs code change)
- Tick range: 98.8% of V4 swaps occur within ticks -10 to +20 (~30 bps)

## Pool Reconfigure (EulerSwap params, not hook)

- equilibriumReserve0: ~60,000e6 (USDC, 6 decimals)
- equilibriumReserve1: ~60,000e6 (USDT, 6 decimals)
- concentration: high (TBD — needs curve math for target range)
- fee0, fee1: 0 (hook controls fees)
- priceX/priceY: set from oracle at deploy time

## FeeConfig

| Parameter | Value | Human | Notes |
|-----------|-------|-------|-------|
| baseFee | 5e12 | 0.05 bps | Undercuts V4's 0.08 bps. Revenue per $60K traversal = $3.00 |
| maxFee | 5e15 | 50 bps | Generous cap. Only hit during auction or extreme arb |
| gasCoeff | 0 | — | Gas negligible at current base fees |
| externalFee | 8e12 | 0.08 bps | V4 fee — reference for oracle-reactive calculation |
| captureRate | 0.8e18 | 80% | Standard arb capture |
| attractRate | 0.5e18 | 50% | Moderate retail discount. Conservative — can increase later |

### Fee economics
- At 0.05 bps, $60K traversal yields $3.00 fee, $0.37 gas = $2.63 net per traversal
- Standalone arb breakeven: $7.4K at 0.05 bps fee
- Estimated 20-40 traversals/day = $53-$105/day fee income (on good days)

## AuctionConfig

| Parameter | Value | Human | Notes |
|-----------|-------|-------|-------|
| decayPerBlock | 5e12 | 0.05 bps/block | Each block step = $3.00 on $60K - $0.37 gas = $2.63 arb profit. Moderate. |
| auctionTriggerThreshold | 0.5e18 | 50% exposure | High — let continuous recenter handle normal drift. Only auction on sustained directional flow. At 12x leverage, 50% exposure = significant but not critical for stablecoins. |
| clearThreshold | 5e15 | 0.5% | Not too tight — avoids oscillating near threshold. Pool converges when marginal price is within 50 bps of oracle. |
| maxShiftMagnitude | 3e15 | 0.3% (30 bps) | Small shift per cycle. Limits arb extraction per auction to ~0.25 × 30bps × $60K = $4.50 net loss. |
| minAuctionBlocks | 25 | ~5 minutes | Enough blocks for fee to decay meaningfully. At 0.05 bps/block, 25 blocks = 1.25 bps of decay. |

### Auction economics (worst case)
- Shift = 30 bps, starting fee = 45 bps (1.5x)
- Duration: 45 bps / 0.05 bps/block = 900 blocks to reach baseFee (~3 hours)
- But clears much earlier via price convergence (minAuctionBlocks = 25 = 5 min)
- Net loss per auction: ~$4.50
- At 50% trigger threshold, auctions should be rare (maybe 1-2/week during normal conditions)

## RecenterConfig

| Parameter | Value | Human | Notes |
|-----------|-------|-------|-------|
| recenterRange | 3e15 | 0.3% (30 bps) | Pool covers ~30 bps of price movement before running out of reserves. Conservative — 98.8% of V4 activity is within 30 bps of center. |
| maxRecenterDrift | 2e15 | 0.2% (20 bps) | Cap on how far recenter can move eq price per swap. Prevents large jumps from oracle noise. |
| minRecenterDelta | 5e14 | 0.05% (5 bps) | Ignore noise — only recenter when exposure has meaningfully decreased. Prevents unnecessary reconfigures (which cost gas and trigger surcharge). |

## SurchargeConfig

| Parameter | Value | Human | Notes |
|-----------|-------|-------|-------|
| surchargeDecayPerBlock | 5e12 | 0.05 bps/block | Matches decay rate. Post-recenter surcharge clears in baseFee/decay = 0.05/0.05 = 1 block for tiny recenters. Larger recenters take more blocks proportionally. |
| surchargeMultiplier | 1.5e18 | 1.5x | Slightly above WETH's 1.25x. More conservative — at sub-bps margins, curvature extraction is proportionally more dangerous. |

## Deployment surcharge
V7 hardcodes 500 bps initial surcharge decaying at surchargeDecayPerBlock. At 0.05 bps/block that takes 10,000 blocks (~33 hours) to clear. This is too slow for stablecoins. Consider modifying the constructor to use a smaller initial surcharge (e.g. 5 bps) or accept the 33-hour warm-up.

## Risk Assessment

**What could drain the pool:**
1. Sustained directional flow exceeding auction capacity → mitigated by high trigger threshold + small shifts
2. Oracle manipulation → mitigated by V3 oracle depth ($4.85M/tick). V4 oracle would be better (needs code change)
3. Rate spread (carry drag) → at 12x leverage, 1% rate differential = 12% APY drag. Current USDC-USDT spread is ~1% (5.72% vs 4.80%). This is ~$600/year on $5K = $1.64/day. Manageable vs estimated fee income.
4. Depeg event → 0.75% of V4 swaps are >50 bps from peg. Pool would go out of range and auction. At small pool size, max loss is limited by equity.

**What we're optimizing for:**
- Win aggregator routing at sub-0.08 bps pricing
- Stay in range through continuous recenter, not auctions
- Survive carry drag from rate differential
- Learn empirically before adding complexity

## Open Items

1. **V4 oracle integration**: Need to modify `_getUniswapPrice()` to read V4 PoolManager state instead of V3 slot0. Higher priority — V4 is the primary price reference.
2. **Naming cleanup**: `lastNetLongWeth` → `lastNetLongAsset1`, etc.
3. **Deployment surcharge**: Constructor uses 500 bps — too large for stablecoin. Needs code change or accept warm-up period.
4. **Concentration parameter**: Need curve math to determine optimal concentration for 30 bps range at 12x leverage. TBD.
5. **Second V4 pool** (`0x8aa4...`): Not yet indexed. May be a competing USDC/USDT pool with different parameters worth analyzing.
