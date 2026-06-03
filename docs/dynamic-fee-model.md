# Dynamic Fee Model

A deterministic cost model for EulerSwap's `getFee` hook. Despite an earlier "Bayesian" working title, there is no probabilistic inference here — the hook observes Uniswap V3 spot price (a noisy but deterministic signal), computes the arber's cost structure, and sets the fee to capture a fixed fraction of the surplus. The gas threshold adapts to `tx.gasprice`, but that's arithmetic, not Bayesian updating.

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

Additionally, the counter-direction (attract side) always paid baseFee, leaving routing-advantage revenue on the table.

## Insight: The No-Arb Zone + Routing Advantage

**No-arb zone**: Uniswap V3's spot price (slot0) is a censored observation of the true market price. An arber won't trade unless profit exceeds gas costs. This creates a zone where trades are retail, not arb.

**Routing advantage**: When our price diverges from Uniswap's, traders wanting to trade in the counter-direction get a *better* price from us. We can charge more on this "attract" side and still win routing.

## Why Net Edge, Not Gross Mismatch

The hook must set fees so that arbers *want* to trade. Arb is the only mechanism that rebalances the pool back to market price. If the fee makes arb unprofitable, the pool stays mispriced indefinitely.

An arber's P&L for a mismatch trade:

```
revenue:  mismatch                     (price difference they capture)
costs:    gas + baseFee + externalFee  (gas, our fee floor, Uni fee on other leg)
          + hookSurcharge              (the dynamic component we control)

profit = mismatch − gas − baseFee − externalFee − hookSurcharge
```

If `hookSurcharge = captureRate × (mismatch − gas)` (the old gross formula), the arber's profit becomes:

```
profit = mismatch − gas − baseFee − externalFee − captureRate × (mismatch − gas)
       = (1 − captureRate)(mismatch − gas) − baseFee − externalFee
```

At captureRate=0.8, baseFee=5bps, externalFee=5bps: arber needs `mismatch − gas > 50 bps` just to break even. A 33 bps mismatch at low gas yields **negative** arber profit — no one trades, pool doesn't rebalance.

The fix: subtract *all* arber costs before applying captureRate:

```
netEdge = mismatch − gas − baseFee − externalFee
hookSurcharge = captureRate × netEdge

profit = netEdge − captureRate × netEdge = (1 − captureRate) × netEdge
```

Now the arber is profitable whenever `netEdge > 0`, regardless of captureRate. The LP captures `captureRate` of the exploitable edge; the arber keeps the rest as incentive. Both sides win.

## Formula

```
effectiveThreshold = gasCoeff × √(tx.gasprice)
mismatch = |uniswapPrice − marginalPrice| / uniswapPrice

Arb direction:
  netEdge = max(mismatch − effectiveThreshold − baseFee − externalFee, 0)
  fee = baseFee + captureRate × netEdge
  Arber keeps exactly (1 − captureRate) × netEdge as profit.

Attract direction:
  excess = max(mismatch − effectiveThreshold, 0)
  fee = baseFee + attractRate × excess

Both clamped to [baseFee, maxFee]
```

- **Below cost floor**: all swaps pay `baseFee` (likely retail)
- **Above cost floor, arb direction**: elevated fee captures LVR while ensuring arbers keep (1−captureRate) of net edge
- **Above threshold, attract direction**: modest fee captures routing advantage
- Gas threshold adapts automatically to current gas prices
- `externalFee` accounts for the arber's Uni swap fee (e.g. 5 bps for 0.05% pool)

## Parameters

### `gasCoeff` (uint64)

Controls the dynamic gas threshold: `threshold = gasCoeff × √(tx.gasprice)`.

On a c=0 EulerSwap curve, arb profit is **quadratic** in mismatch:

```
trade ≈ eq × m/2,  profit ≈ eq × m² / 4
```

Break-even: `eq × m² / 4 = gasCost` → `m = 2 × √(gasCost / eq)`

Factoring out `√(tx.gasprice)`:

```
gasCoeff = 2e18 × √(swapGasUnits × 2 / eqReserveWei)
```

**USDC/WETH (eq ≈ 80 WETH):** gasCoeff ≈ 1.22e11
- At 0.4 gwei → threshold ≈ 24 bps
- At 10 gwei → threshold ≈ 122 bps
- At 100 gwei → threshold ≈ 386 bps

**USDC/USDT (eq ≈ 1.26 ETH, $2514 pool):** gasCoeff ≈ 9.74e11
- At 0.4 gwei → threshold ≈ 195 bps (small pool, arb rarely profitable)

The owner updates `gasCoeff` via `setFeeParams()` when pool depth changes materially. Gas price variations are handled automatically by the formula at quote time.

**Caveat — `tx.gasprice` is the bid, not the cost (L-02):** the formula reads `tx.gasprice`, which is the transaction's bid gas price, not the gas the arber actually pays. In MEV-aware contexts (Flashbots bundles, private orderflow, builder side-payments), the bid can be set independently of true execution cost and is manipulable by sophisticated searchers — e.g. a low `tx.gasprice` paired with a coinbase tip can lower `effectiveThreshold` and raise the captured edge in their favour, or vice versa. This is working as designed for normal mempool flow, where `tx.gasprice` is a reasonable proxy for the marginal cost of inclusion; sophisticated arbers are expected to optimise around it.

**Caveat — zero-gasprice contexts (I-04):** on L2s with sequencer-priced gas, or in account-abstraction / sponsored-transaction flows where `tx.gasprice` can be `0`, `effectiveThreshold` collapses to `0` and the arb-side fee formula reduces to capturing the full mismatch above `baseFee + externalFee`. This is generally the desired behaviour (gas isn't really a barrier in those contexts), but operators deploying on such venues should review `captureRate` accordingly.

### `captureRate` (uint256, WAD-scaled)

Fraction of **net exploitable edge** to capture on the **arb side**. Default: 0.8e18 (80%).

Net edge = mismatch − gasThreshold − baseFee − externalFee. This is the arber's actual profit margin after all costs. `captureRate` captures a fraction of this net edge, leaving the rest as arber incentive.

- 80% capture leaves 20% of net edge for the arber as incentive to execute
- Higher values extract more LVR but reduce arb flow (worse price tracking)
- Lower values are more competitive but leave more LVR on the table

### `externalFee` (uint64, WAD-scaled)

The arber's external cost floor — typically the Uni V3 swap fee tier they must pay on the other leg. E.g., `5e14` = 5 bps for the 0.05% USDC/WETH pool, `1e14` = 1 bps for the 0.01% USDC/USDT pool.

This is subtracted (along with gasThreshold and baseFee) before applying captureRate, ensuring the arber's net profit remains positive.

### `attractRate` (uint256, WAD-scaled)

Fraction of excess mismatch to capture on the **attract side**. Default: 0.3e18 (30%).

When mismatch is large, our price on the attract side is better than competitors by ~mismatch. We can charge more and still win routing. `attractRate` captures a fraction of this advantage.

**Example**: mismatch = 50 bps, threshold = 25 bps, attractRate = 0.3:
- Attract fee = 5 + 0.3 × 25 = 12.5 bps
- Trader saves 50 − 12.5 = 37.5 bps vs market → still massively better
- We earn 7.5 bps more per attract-side trade than flat baseFee

### `baseFee` (uint64, WAD-scaled)

Resting fee for all swaps. Set competitively vs aggregator spreads.

### `maxFee` (uint64, WAD-scaled)

Hard ceiling. Prevents extreme fees during volatility spikes.

## Example: USDC/WETH Pool

With `baseFee = 5 bps`, `gasCoeff = 1.22e11` (≈24 bps at 0.4 gwei), `captureRate = 0.8`, `attractRate = 0.3`, `externalFee = 5 bps`:

Arb side: `fee = 5 + 0.8 × max(0, mismatch − 24 − 5 − 5)` = `5 + 0.8 × max(0, mismatch − 34)`
Attract side: `fee = 5 + 0.3 × max(0, mismatch − 24)`

| Mismatch | Arb fee  | Attract fee | Type |
|----------|----------|-------------|------|
| 0.01%    | 5 bps    | 5 bps       | Below threshold |
| 0.1%     | 5 bps    | 5 bps       | Below threshold |
| 0.25%    | 5 bps    | 5 bps       | Borderline |
| 0.5%     | 17.8 bps | 12.8 bps    | Above threshold |
| 1.0%     | 57.8 bps | 27.8 bps    | Above threshold |
| 2.0%     | 138 bps  | 57.8 bps    | Above threshold |

At 10 gwei (threshold ≈ 124 bps), even 1% mismatch falls below threshold → all pay baseFee.

## Implementation

See [`DynamicFeeAuctionHook.sol`](../contracts/src/DynamicFeeAuctionHook.sol). The hook:
1. Reads Uniswap V3 `slot0` for the market reference price
2. Computes `effectiveThreshold = gasCoeff × √(tx.gasprice)` — adapts to gas costs
3. Computes mismatch between Uniswap and the curve's marginal price
4. **Arb direction**: subtracts all arber costs (gasThreshold + baseFee + externalFee) to get net edge, then applies `captureRate`
5. **Attract direction**: subtracts gasThreshold to get excess, then applies `attractRate`
6. Clamps result to `[baseFee, maxFee]`
