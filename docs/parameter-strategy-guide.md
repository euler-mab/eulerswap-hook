# EulerSwap Pool Parameter Strategy Guide

A practical playbook for choosing optimal parameters when deploying a new EulerSwap pool or diagnosing an underperforming one.

**Pre-requisites:** Basic familiarity with AMMs, Euler vaults, and the EVC.

**Related docs** (referenced throughout, not duplicated):
- [`docs/dynamic-fee-model.md`](dynamic-fee-model.md) -- Full fee formula spec
- [`docs/additive-boost-derivation.md`](additive-boost-derivation.md) -- Boost math (BX/BY formulas)
- [`docs/auction-walkthrough.md`](auction-walkthrough.md) -- Auction mechanism, step by step
- [`docs/calibration-guide.md`](calibration-guide.md) -- Per-parameter derivation
- [`docs/per-lp-architecture.md`](per-lp-architecture.md) -- Why each Euler account is its own AMM

---

## 1. Overview -- The Parameter Lifecycle

EulerSwap pool parameters split into three tiers with different mutability:

| Tier | What | Set when | Changed by |
|------|------|----------|------------|
| **Immutable** (`StaticParams`) | Vaults, euler account, fee recipient | Pool deployment | Cannot change (redeploy required) |
| **Reconfigurable** (`DynamicParams`) | Equilibrium reserves, min reserves, prices, concentration, fees, hook | Deployment + ongoing | Owner calls `reconfigure()` (must pass `CurveLib.verify`) |
| **Hook-managed** (hook storage) | baseFee, gasCoeff, captureRate, attractRate, auction params | Hook deployment + ongoing | Owner calls `setFeeParams()` / `setAuctionParams()` on the hook |

The lifecycle:

```
Market analysis  -->  Choose static params (deploy once)
                 -->  Compute dynamic params (boost, prices, range)
                 -->  Configure hook fees
                 -->  Monitor + tune (recenter, rebalance, reboost)
```

---

## 2. Market Analysis Checklist

### 2.1 Pair Classification

| Type | Examples | Key characteristic |
|------|----------|--------------------|
| **Stablecoin** | USDC/USDT, DAI/USDC | Price stays within ~5 bps of peg. Fee is the bottleneck, not IL. |
| **Volatile** | USDC/WETH, USDC/WBTC | Daily moves of 1-5%. IL and LVR dominate. |
| **Cross-volatile** | WETH/WBTC | Both assets move. Correlation reduces IL but complicates pricing. |

The classification drives every downstream parameter choice -- especially fee levels, range width, and the relative importance of IL vs interest rate risk.

### 2.2 Data to Gather

Before choosing any parameters, collect:

1. **Current market price** -- Source: Uniswap V3 `slot0` or aggregator API. Needed for `priceX`/`priceY`.

2. **Price range (30-day)** -- High/low over the past month. Drives `rx`/`ry` (how wide the pool's range should be).

3. **Volatility** -- Annualized vol from a price feed. Affects expected IL/LVR and thus the fee level needed to break even.

4. **Competing venues** -- Uniswap V3/V4 fee tiers, Curve pools, CEX spreads. Your baseFee must be at or below the best competitor to attract any volume.

5. **Volume at each venue** -- Daily volume by fee tier (Uniswap analytics, Dune). Tells you where the flow is and what volume you might capture.

6. **Euler vault availability** -- Which supply/borrow vaults exist for each asset. Check cross-LTVs (`vyx`, `vxy`). Higher LTV = more leverage = more virtual depth.

7. **Vault utilization and rates** -- Current borrow rates and utilization. If vaults are near the IRM kink, borrowing is expensive and the pool's carry goes negative.

8. **Gas economics** -- Current gas price range (0.03-0.10 gwei typical in 2026). Affects `gasCoeff` and arb break-even.

### 2.3 Example: Data Collection for USDC/USDT

| Item | Finding |
|------|---------|
| Market price | 1.0000-1.0002 (USDC slightly premium) |
| 30-day range | 0.9998-1.0003 (~5 bps total) |
| Volatility | Negligible (<0.1% annualized) |
| Competing venues | Uni V4 at 0.08 bps (massive volume), Uni V3 0.01% (1 bps), Curve 1-2 bps |
| Daily volume | Uni V4 pool: \$50M+/day at 0.08 bps |
| Euler vaults | USDC vault (94% cross-LTV to USDT), USDT vault (94% cross-LTV to USDC) |
| Vault rates | ~3-5% supply, ~6-8% borrow (below kink) |
| Gas | 0.03-0.10 gwei typical |

**Key insight:** With the V4 pool charging 0.08 bps and doing massive volume, our baseFee must be well under 1 bps. The initial deployment at 100 bps got zero volume because it was 1000x above the market clearing fee.

---

## 3. Static Pool Parameters

These are set at deployment and cannot be changed.

### 3.1 Vault Selection (`supplyVault0/1`, `borrowVault0/1`)

- **Supply vault** = where idle reserves earn yield. Pick the highest-yield vault for each asset.
- **Borrow vault** = where the pool borrows to create leverage. Must accept the supply vault's shares as collateral.

The standard setup: supply and borrow use the **same vault** per asset. This is simplest and is used by all current deployments.

```solidity
// DeployUsdcUsdt.s.sol
StaticParams({
    supplyVault0: USDC_VAULT,   borrowVault0: USDC_VAULT,
    supplyVault1: USDT_VAULT,   borrowVault1: USDT_VAULT,
    ...
})
```

**Key check:** Verify the cross-LTV between vaults. The cross-LTV (`vyx` = LTV of Y collateral for X debt) is the dominant factor in leverage. A vault pair with 94% cross-LTV gives ~16x more leverage than one with 70%.

### 3.2 Euler Account (`eulerAccount`)

Use a dedicated EVC sub-account for each pool. Sub-accounts are deterministic:

```
subAccount = address(uint160(owner) ^ subAccountId)
```

Do not share accounts between pools -- their vault positions would conflict.

### 3.3 Fee Recipient (`feeRecipient`)

- `address(0)` -- Fees stay in the pool (increase reserves, compound for the LP). **Default for hook-managed pools.**
- Non-zero address -- Fees sent to this address on each swap.

For hook-managed pools, use `address(0)`. The hook controls fee capture via dynamic pricing, and fees compound into reserves automatically.

---

## 4. Equilibrium Reserves and Leverage

The most important parameter decision. Equilibrium reserves determine the pool's virtual depth and maximum trade size.

### 4.1 The Additive Boost

Real deposits are amplified by borrowing capacity:

```
x0 = xr + BX    (virtual equilibrium reserves)
y0 = yr + BY
```

Where `BX` is additional virtual reserves from borrowing against cross-collateral. The boost is computed by solving the Euler vault health constraint at the boundary (H = 1.0 at the worst-case reserve position).

For the dominant case (c=0, xr>0, yd>0):
```
BX = [vyx*(yr-yd)*pyx + xr*(vyx*(sx-1)+sx) + (ZXC-xd)*sx^2] / [(sx-1)*(sx-vyx)]
```

See [`additive-boost-derivation.md`](additive-boost-derivation.md) for the full derivation.

### 4.2 What Drives Leverage

In order of importance:

1. **Cross-LTV (`vyx`)** -- Dominant factor. 94% LTV (USDC/USDT vaults) gives ~70x leverage. 84% LTV (USDC/WETH) gives ~40x. The denominator `(sx - vyx)` approaches zero as `vyx` approaches `sx`, creating explosive leverage.

2. **Real deposits (`xr`, `yr`)** -- Linear scaling. 2x deposits = 2x virtual reserves.

3. **Range width (`rx`)** -- Through `sx = sqrt(1 + rx)`. Narrower range = higher concentration = more leverage, but more frequent recentering.

4. **Existing debt (`xd`, `yd`)** -- Reduces available leverage. Clean state (no debt) = maximum boost.

### 4.3 One-Sided vs Two-Sided Deposits

**One-sided (default):** Deposit only one asset (e.g., all USDC). The pool borrows the other asset as needed. Delta-neutral at equilibrium.

**Two-sided:** Deposit both assets. Less initial leverage but a buffer before debt appears.

For volatile pairs (USDC/WETH), one-sided USDC is preferred -- it eliminates price exposure at equilibrium.

### 4.4 Worked Example: USDC/WETH

Inputs (matching the initial calibration of the USDC/WETH pool):
```
xr = 3611 USDC,  yr = 0.000394 WETH
xd = 0,          yd = 0.32 WETH
vyx = 0.84,      vxy = 0.85
rx = ry = 0.05,  cx = cy = 0
sx = sqrt(1.05) = 1.024695
```

Applying the BX formula:
```
BX = [0.84*(0.000394-0.32)*1986 + 3611*(0.84*0.0247+1.0247)] / [0.0247*(1.0247-0.84)]
   = [-533 + 3775] / 0.00456
   = 710,746 USDC

x0 = 3611 + 710,746 = 714,357 USDC  (~198x leverage)
```

Health at boundary: H_XX = 1.000 (barely solvent, by design).

Full derivation of the BX/BY boost formulas: [`docs/additive-boost-derivation.md`](additive-boost-derivation.md). The pattern for applying a boost on-chain (deposit collateral via the EVC, then `reconfigure()` with the boosted equilibrium reserves) is shown in [`AddCapital.s.sol`](../contracts/script/AddCapital.s.sol) — env-driven and generic to any pool.

---

## 5. Price Range and Min Reserves

### 5.1 Range Width (`rx`, `ry`)

The range determines how far price can move before the pool hits its min reserves (is exhausted on one side).

| `rx` | Price range (each side) | Concentration boost `sx/(sx-1)` | Recenter frequency (2% daily vol) |
|------|------------------------|-------------------------------|-----------------------------------|
| 0.001 | +/-0.05% | ~2000x | Multiple times per day |
| 0.005 | +/-0.25% | ~400x | Several times per day |
| 0.01 | +/-0.5% | ~200x | Daily |
| 0.05 | +/-2.5% | ~41x | Every few days |
| 0.10 | +/-5% | ~21x | Weekly |

**Volatile pairs (USDC/WETH):** `rx = ry = 0.05` (5% range). Wide enough to survive normal daily moves, narrow enough for ~40x concentration boost.

**Stablecoin pairs (USDC/USDT):** `rx = ry = 0.01` (1% range). Price barely moves, so a narrow range gives ~200x concentration. Could go even tighter (0.001-0.005) if recentering is automated.

### 5.2 Min Reserves from Range

```
minReserve = eq / sqrt(1 + rx)
```

This formula converts a price range boundary into a reserve floor for c=0 curves.

Examples:
- 5% range: `minReserve = eq / sqrt(1.05) = eq × 0.9759` (2.4% below eq)
- 1% range: `minReserve = eq / sqrt(1.01) = eq × 0.9950` (0.5% below eq)

The deploy scripts compute this automatically:
```solidity
// DeployUsdcUsdt.s.sol
uint112 min0 = uint112(uint256(EQ0) * SQRT101_DEN / SQRT101_NUM);  // eq0 / sqrt(1.01)
```

### 5.3 Asymmetric Min Reserves

After an auction or rebalance, the pool may not be centered. Asymmetric min reserves can give the depleted side room to recover:

- **Depleted side:** Wider range (`reserve × (1 - 2×delta)`)
- **Attracted side:** Keeps pre-auction min reserve

In the current hook, recentering after auction sets `eq = current reserves` directly — the boundary follows the new equilibrium without an explicit asymmetric step.

---

## 6. Price Parameters (`priceX`, `priceY`)

### 6.1 Initial Price Setting

`priceX` and `priceY` are integer scalars from the Euler oracle. The pool's equilibrium marginal price is `priceX / priceY` (in raw token1 per raw token0 units).

Read from the Euler oracle at deploy time:
```solidity
uint256 p0 = IPriceOracle(oracle).getQuote(1e18, USDC, unitOfAccount);
uint256 p1 = IPriceOracle(oracle).getQuote(1e18, WETH, unitOfAccount);
priceX = uint80(p0 / 1e18);  // e.g. 1 (USDC ≈ $1)
priceY = uint80(p1 / 1e18);  // e.g. 1976 (WETH ≈ $1976)
```

### 6.2 Stale Price Impact

When the pool's `priceX/priceY` drifts from market:
- The hook detects mismatch and charges elevated fees
- Arb trades move reserves away from equilibrium, creating unnecessary vault debt
- The pool becomes less competitive for retail flow

**Rule of thumb:** Recenter when `|poolPrice - marketPrice| > gasCoeff × sqrt(typicalGas)` -- i.e., when the mismatch exceeds the no-arb zone. For USDC/WETH at 0.04 gwei, this is ~13 bps.

### 6.3 Recentering

In the current hook, recentering is **autonomous** — [`DynamicFeeAuctionHook`](../contracts/src/DynamicFeeAuctionHook.sol) calls `reconfigure()` from inside `afterSwap` whenever a swap reduces exposure beyond `minRecenterDelta`. The hook updates `priceY`, sets `eq = current reserves`, and recomputes `minReserves`, then applies a curvature-aware surcharge that decays to zero.

If exposure exceeds `auctionTriggerThreshold` and no rebalancing flow appears, the hook shifts the equilibrium price to create a profitable arb and starts a Dutch fee-decay auction. The clearing trade is itself the rebalance — no external venue, no slippage cost.

`gasCoeff` is owner-updatable post-deploy; revisit it if your pool's equilibrium depth changes materially.

---

## 7. Concentration (`cx`, `cy`)

### 7.1 c=0 Is the Default

All current deployments use `cx = cy = 0`. This gives a hyperbolic curve (xy=k shape) where depth comes entirely from vault leverage and range concentration.

Advantages of c=0:
- Simple marginal price formula: `|dy/dx| = px × x0^2 / (py × x^2)`
- Arb profit is exactly quadratic in mismatch (enables clean gasCoeff derivation)
- IL elimination at leverage L=2 (Yield Basis Theorem 2)

### 7.2 When c > 0 Might Help

For stablecoin pairs where the price barely moves, `cx > 0` concentrates liquidity near the peg (approaching constant-sum). However:
- IL residual grows as `cx × epsilon^2 / (4×(1-cx))` per step
- Health model becomes more complex
- No c>0 pools are currently deployed or tested

### 7.3 Decision Framework

Use `cx = 0` unless **all** of these are true:
1. Stablecoin pair where price deviates < 10 bps
2. Competing venues use constant-sum-like curves (Curve StableSwap)
3. You can tolerate the c>0 residual IL
4. You have validated the health model at c>0

In practice, c=0 with a tight range (`rx = 0.005-0.01`) achieves similar depth concentration without the complexity.

---

## 8. Hook Fee Parameters

The core of the dynamic fee strategy. See [`dynamic-fee-model.md`](dynamic-fee-model.md) for the complete formula.

### 8.1 Overview

| Parameter | Units | Description |
|-----------|-------|-------------|
| `baseFee` | WAD (1e14 = 1 bps) | Floor fee for all swaps |
| `maxFee` | WAD | Ceiling fee |
| `gasCoeff` | raw uint64 | Gas threshold coefficient |
| `externalFee` | WAD | Arber's external cost (Uni fee tier) |
| `captureRate` | WAD (1e18 = 100%) | Fraction of net edge captured on arb side |
| `attractRate` | WAD | Fraction of excess captured on attract side |

### 8.2 baseFee -- Competitive Positioning

The baseFee is the resting fee when there's no price mismatch. It must be competitive with the best alternative venue.

| Pair type | Best competing venue | Their fee | Recommended baseFee |
|-----------|---------------------|-----------|---------------------|
| USDC/WETH | Uniswap V3 0.05% | 5 bps | 5 bps |
| USDC/USDT | Uniswap V4 0.0008% | 0.08 bps | 0.5 bps |
| WBTC/WETH | Uniswap V3 0.05% | 5 bps | 5 bps |

**For stablecoins:** The USDC/USDT pool launched at 100 bps and got zero volume. CEX spreads are 1-4 bps. Uniswap V4 charges 0.08 bps. A competitive baseFee for stablecoin pairs is **0.5 bps or less**.

### 8.3 gasCoeff -- The No-Arb Zone

On a c=0 curve, arb profit is quadratic: `profit = eq × mismatch^2 / 4`. Break-even occurs when profit equals gas cost:

```
gasCoeff = 2e18 × sqrt(swapGasUnits × 2 / eqReserveWei)
```

Where:
- `swapGasUnits` = combined gas for EulerSwap + Uniswap leg (~300k for a two-leg arb)
- `eqReserveWei` = equilibrium reserve of the sold token, in wei

The effective threshold at any gas price:
```
threshold = gasCoeff × sqrt(tx.gasprice)
```

Worked examples:

| Pool | Eq reserve (ETH terms) | gasCoeff | Threshold @ 0.04 gwei | Threshold @ 1 gwei |
|------|----------------------|----------|----------------------|-------------------|
| USDC/WETH (~\$1.4M) | ~320 WETH | 6.54e10 | ~13 bps | ~65 bps |
| USDC/USDT (~\$7k) | ~1.26 ETH equiv | 9.74e11 | ~195 bps | ~974 bps |

The USDC/USDT gasCoeff is huge because the pool is small in ETH terms -- arb is almost never profitable, so the threshold is very wide. Nearly all USDC/USDT swaps pay just baseFee.

**Important:** Update gasCoeff whenever equilibrium reserves change significantly (after boost or rebalance).

### 8.4 captureRate -- LVR Capture

Fraction of net exploitable edge captured on arb-direction swaps.

```
netEdge = max(mismatch - threshold - baseFee - externalFee, 0)
arbFee  = baseFee + captureRate × netEdge
```

The arber is profitable whenever `netEdge > 0`, regardless of captureRate value. Higher captureRate just reduces arber profit per trade.

| captureRate | Arber keeps | Trade-off |
|-------------|-------------|-----------|
| 50% | 50% of net edge | Very attractive to arbers, tight price tracking, less LP revenue |
| **80%** | **20% of net edge** | **Default. Good balance of capture and arb incentive.** |
| 95% | 5% of net edge | Maximum extraction, but arbers may skip marginal trades |

### 8.5 attractRate -- Routing Advantage

When the pool's price is better than the market on the "attract" side (counter-direction to arb), we can charge above baseFee and still win routing.

```
excess = max(mismatch - threshold, 0)
attractFee = baseFee + attractRate × excess
```

**Example:** mismatch = 50 bps, threshold = 25 bps, attractRate = 30%:
- Attract fee = 5 + 0.3 × 25 = 12.5 bps
- Trader still saves 50 - 12.5 = 37.5 bps vs market

**Default: 30%.** Higher values capture more routing revenue but may lose flow to venues that don't surcharge.

### 8.6 externalFee -- Arber's Other Leg

Set to match the fee tier of the venue arbers use for the other leg:

| Pool | Arb venue | externalFee |
|------|-----------|-------------|
| USDC/WETH | Uni V3 0.05% | 5 bps (5e14) |
| USDC/USDT | Uni V3 0.01% | 1 bps (1e14) |

If a lower-fee venue becomes the dominant arb source (e.g., Uni V4 at 0.08 bps for stablecoins), update externalFee accordingly.

### 8.7 maxFee -- Safety Ceiling

Prevents extreme fees during volatility spikes.

- **Volatile pairs:** 3500 bps (35%). Handles extreme vol events.
- **Stablecoin pairs:** 50 bps. Fees should never need to be high for stablecoins.

---

## 9. Auction Parameters

Dutch fee-decay auctions let the pool autonomously rebalance directional exposure by temporarily shifting `priceY` to expose an arb, then decaying the fee block-by-block until a swap clears it. See [`auction-walkthrough.md`](auction-walkthrough.md) for a step-by-step trace of one cycle.

### 9.1 When auctions run

Only relevant if your hook implements `afterSwap` (`swapHookedOperations` includes `EULER_SWAP_HOOK_AFTER_SWAP`, e.g. `0x06`).

- **No hook or [`MinimalHook`](../contracts/src/MinimalHook.sol)**: no auctions. Rebalancing requires an off-chain operator to call `reconfigure()` via the EVC.
- **[`DynamicFeeAuctionHook`](../contracts/src/DynamicFeeAuctionHook.sol)**: auctions run automatically. Set `auctionTriggerThreshold` to 0 to effectively disable them while keeping the continuous-recenter loop active.

### 9.2 `auctionTriggerThreshold` (WAD)

NAV-relative exposure threshold above which an auction starts. e.g. `0.5e18` = 50% of NAV.

Calibration: pick this from the equity vs. expected per-block flow trade-off. Tighter triggers rebalance more often but at higher accumulated surcharge cost; looser triggers leave more directional exposure on the book between auctions. Stablecoin pools tolerate looser triggers (low IL risk); volatile pools should be tighter.

### 9.3 `maxShiftMagnitude` (WAD)

Cap on how far `priceY` can be shifted in a single auction. Bigger shifts clear more exposure per cycle but pay more if the auction times out.

```
auction LP cost ≈ x0 × shift² / 4    (small-shift approximation)
```

The shift must be large enough for arbers to profit:
```
shift > 2 × (externalFee + gas/notional)
```

### 9.4 `decayPerBlock` and `clearThreshold`

- **`decayPerBlock`** (WAD): how fast the auction fee falls. Typical values are tied to the asset's per-block volatility (σ₁); the calibration script outputs a reasonable default.
- **`clearThreshold`** (WAD): the marginal-price-vs-oracle distance within which the auction is considered cleared. Must be strictly less than `maxShiftMagnitude` — the hook enforces this.

### 9.5 `minAuctionBlocks`

Floor on auction duration before clearing is allowed. Prevents the auction from clearing on the very first swap before the fee has had time to decay below the shift's profit ceiling.

---

## 10. Volatile Pair Playbook (USDC/WETH)

### 10.1 Current Deployment

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Real deposit | ~\$3,600 USDC (one-sided) | Delta-neutral at equilibrium |
| eq0 | 714,299 USDC | Additive boost (~198x leverage) |
| eq1 | 280.41 WETH | Additive boost |
| priceY | ~1975 | From Euler oracle at last recenter |
| rx, ry | 0.05 | 5% range each direction |
| cx, cy | 0 | Hyperbolic curve |
| baseFee | 5 bps | Matches Uni V3 0.05% tier |
| maxFee | 3500 bps | High ceiling for vol spikes |
| gasCoeff | 6.54e10 | `2e18 × sqrt(300k × 2 / 280e18)` |
| captureRate | 80% | Standard |
| attractRate | 30% | Standard |
| externalFee | 5 bps | Uni V3 0.05% fee |
| Hook | `DynamicFeeAuctionHook` | `GET_FEE \| AFTER_SWAP` (`0x06`) |

### 10.2 Scenario: ETH Drops 2%

Walk through the fee logic when price moves:

1. **Reserves shift:** USDC sold out (reserve0 drops), WETH accumulated (reserve1 rises)
2. **Uniswap slot0** diverges from pool's equilibrium price
3. **Hook detects mismatch:** `mismatch ≈ 200 bps`
4. **Gas threshold:** At 0.04 gwei, `threshold = 6.54e10 × sqrt(4e7) ≈ 13 bps`
5. **Net edge (arb direction):** `200 - 13 - 5 - 5 = 177 bps`
6. **Arb fee:** `5 + 0.8 × 177 = 147 bps`
7. **Attract fee:** `5 + 0.3 × (200 - 13) = 61 bps`
8. **Arber trades**, capturing 20% of 177 bps = 35 bps profit
9. **Reserves move** back toward equilibrium
10. **Hook recenters automatically** from `afterSwap`, with curvature-aware surcharge to prevent round-trip extraction

### 10.3 Monitoring Triggers

Most maintenance via this hook is autonomous. Owner intervention is reserved for:

| Signal | Action |
|--------|--------|
| Persistent exposure not clearing via auction | Inspect `auctionTriggerThreshold` / `maxShiftMagnitude`; update via `setAuctionParams()` |
| Gas regime change (e.g. mainnet → L2) | Update `gasCoeff` via `setFeeParams()` |
| Equity changed materially after capital add/withdraw | Re-run `calibrate-hook-params.ts`; update fee + auction params if needed |
| Vault utilization > 85% | Add capital via [`AddCapital.s.sol`](../contracts/script/AddCapital.s.sol) or reduce pool depth |

---

## 11. Stablecoin Pair Playbook (USDC/USDT)

### 11.1 The Problem: 100 bps Fee vs 4 bps Market

The USDC/USDT pool was deployed with a 100 bps fee and gets **zero volume**. The market reality:

| Venue | Fee | Daily volume |
|-------|-----|-------------|
| Binance USDC/USDT | 1-4 bps spread | Billions |
| Uniswap V4 0.0008% | 0.08 bps | \$50M+ |
| Uniswap V3 0.01% | 1 bps | \$10M+ |
| Curve 3pool | 1-2 bps | \$5M+ |
| **EulerSwap (current)** | **100 bps** | **\$0** |

The pool's fee is 100-1000x above the market clearing price. No rational trader or aggregator will route through it.

### 11.2 Proposed Parameters

| Parameter | Current | Proposed | Rationale |
|-----------|---------|----------|-----------|
| baseFee | 100 bps (static) | 0.5 bps (via hook) | Must undercut CEX spreads |
| eq price | 1.0000 | 1.0001 | USDC typically trades at slight premium |
| Range | +/-1% | +/-0.05% (0.9995-1.0005) | Price never moves beyond this |
| gasCoeff | 9.74e11 | Keep as-is | Still correct for pool size |
| captureRate | 80% | 80% | Standard |
| attractRate | 30% | 30% | Standard |
| externalFee | 1 bps | 0.08 bps | V4 is now the primary arb venue |

### 11.3 Why Stablecoin Pools Are Different

1. **Fee is the bottleneck, not IL.** Price barely moves, so IL is negligible. The entire competition is on fees.

2. **gasCoeff is huge relative to mismatch.** The pool is small in ETH terms (~\$7k virtual reserves ≈ 1.26 ETH), so the no-arb zone is massive (195 bps at 0.4 gwei). Almost every swap pays just baseFee. This makes the dynamic fee formula irrelevant -- everything is below threshold.

3. **Interest rate risk dominates.** For stablecoins, the primary risk isn't IL but the carry cost of vault borrowing. The hook addresses this in three layers:
   - **Routing-aware fee asymmetry** — attract flow that reduces directional exposure, capture flow that increases it
   - **Dutch fee auctions** — when relative exposure exceeds `auctionTriggerThreshold`, shift equilibrium to create a profitable arb and decay the fee until cleared
   - **Owner re-tuning** — `setFeeParams()` / `setAuctionParams()` to bump baseFee or thresholds when the rate environment changes

4. **Range can be very narrow.** A 5 bps range (`rx = 0.0005`) would give ~2000x concentration. But tighter ranges require more frequent recentering.

### 11.4 The Stablecoin Fee Dilemma

At 0.5 bps baseFee with \$7k virtual reserves:
- Expected daily fee revenue at \$10k daily volume: **\$0.005/day**
- Vault borrow cost at 5% APR on \$7k: **\$0.96/day**

The pool cannot be profitable at this scale. The options:

1. **Scale up:** Larger real deposit -> higher virtual reserves -> attract more volume. Need ~\$10M+ daily volume at 0.5 bps to cover interest.
2. **Lower vault rates:** Wait for market conditions where stablecoin borrow rates are lower.
3. **Accept the loss:** Run the pool as a proving ground for the hook technology, not for profit.

This is a fundamental constraint for leveraged stablecoin AMMs -- the fee revenue ceiling is set by the market (ultra-low for stablecoins), while the cost floor is set by vault interest rates.

---

## 12. Parameter Tuning Over Time

### 12.1 What Changes and When

| Parameter | Frequency | Trigger | How |
|-----------|-----------|---------|-----|
| `priceY` | Every recenter | Swap reduces exposure beyond `minRecenterDelta` | Hook's `afterSwap` calls `reconfigure()` |
| `eq0/eq1` | Every recenter | Set to current reserves at recenter | Hook's `afterSwap` calls `reconfigure()` |
| `min0/min1` | With eq changes | Always derived from eq | `eq / sqrt(1 + recenterRange)` |
| `gasCoeff` | After eq changes | Pool depth changed materially | `setFeeParams()` (owner) |
| `baseFee` | Rarely | Competing venue fees change | `setFeeParams()` (owner) |
| `captureRate / attractRate` | Rarely | Strategy change | `setFeeParams()` (owner) |
| Auction thresholds | After eq changes | Calibration drift | `setAuctionParams()` (owner) |

### 12.2 The Recenter-Rebalance-Reboost Cycle

The full maintenance cycle is autonomous in this hook:

1. **Monitor** -- The hook caches NAV and net base-asset position at every recenter and tracks deltas via swap amounts; no off-chain monitor required.
2. **Recenter** -- On every swap that reduces exposure beyond `minRecenterDelta`, the hook updates `priceY` and sets `eq = current reserves` from inside `afterSwap`.
3. **Auction-rebalance** -- When relative exposure exceeds `auctionTriggerThreshold`, the hook shifts the equilibrium price to create a profitable arb and starts a Dutch fee-decay auction; the clearing swap is the rebalance.
4. **Curvature surcharge** -- Each recenter installs an additive surcharge sized to the curvature bonus it creates, decaying block-by-block to prevent round-trip extraction.
5. **Parameter updates** -- The owner can update fee, auction, recenter, and surcharge parameters via `setFeeParams()` / `setAuctionParams()` / etc. without redeploying the hook.

---

## 13. Parameter Sensitivity Analysis

### 13.1 What Matters Most vs What Is Forgiving

| Parameter | Sensitivity | Impact of 2x error |
|-----------|-------------|---------------------|
| `baseFee` | **High** for stablecoins, low for volatile | Stablecoin: lose all volume. Volatile: lose some marginal volume. |
| `gasCoeff` | **Low** | 2x too high = wider no-arb zone, slightly less LVR capture. 2x too low = arbers charged when they can't profit, but they just skip the trade. |
| `captureRate` | **Low** | 60% vs 80% = ~20% less fee revenue from arb trades. Pool still functions. |
| `eq reserves` | **Medium** | Understated = less depth, lower max trade size. Overstated = health violation risk (liquidation). |
| `minReserves` | **High** if too loose | min=0 removes all range protection. Always derive from eq and rx. |
| `priceY` | **Medium** | Stale by 100 bps = all trades see elevated fees, pool less competitive. |

### 13.2 The gasCoeff Bug

The deploy scripts originally had gasCoeff **10x too high** (computed with wrong units). The no-arb zone was `sqrt(10) ≈ 3.16x` too wide.

Effect: the pool charged baseFee for trades that were actually arb (because their mismatch fell below the inflated threshold). The hook failed to capture LVR on these trades.

Fix: corrected the formula and updated via `setFeeParams()` on-chain.

**Lesson:** Always verify gasCoeff with the formula and sanity-check the threshold at typical gas prices:
```
threshold = gasCoeff × sqrt(typical_gas_price)
```
If the threshold seems unreasonable (>50 bps at 0.04 gwei for a large pool), double-check the calculation.

---

## 14. Quick Reference -- Parameter Cheat Sheet

### Volatile Pair Template (USDC/WETH style)

```
Static:
  supplyVault0 = USDC vault     borrowVault0 = USDC vault
  supplyVault1 = WETH vault     borrowVault1 = WETH vault
  feeRecipient = address(0)

Dynamic:
  eq0/eq1   = computed from additive boost (math.ts)
  min0      = eq0 / sqrt(1.05)          min1 = eq1 / sqrt(1.05)
  priceX    = oracle(USDC)              priceY = oracle(WETH)
  cx = 0                                cy = 0
  fee0 = 0 (hook-managed)               fee1 = 0 (hook-managed)

Hook:
  baseFee      = 5 bps   (5e14)
  maxFee       = 3500 bps (3500e14)
  gasCoeff     = 2e18 × sqrt(300k × 2 / eqReserveWei)
  externalFee  = 5 bps   (5e14, for Uni V3 0.05%)
  captureRate  = 0.8e18  (80%)
  attractRate  = 0.3e18  (30%)

Auction:
  threshold0/1     = 0 (disabled initially)
  delta            = 100 bps
  startFee         = 200 bps
  decayPerSecond   = 1 bps/sec
```

### Stablecoin Pair Template (USDC/USDT style)

```
Static:
  Same vault structure as volatile.

Dynamic:
  eq0 ≈ eq1  (approximately equal for 1:1 peg)
  min0 = eq0 / sqrt(1.01)               min1 = eq1 / sqrt(1.01)
  priceX = oracle(USDC)                 priceY = oracle(USDT)
  cx = 0                                cy = 0
  fee0 = 0 (hook-managed)               fee1 = 0 (hook-managed)

Hook:
  baseFee      = 0.5 bps  (5e13)
  maxFee       = 50 bps   (50e14)
  gasCoeff     = 2e18 × sqrt(300k × 2 / eqReserveWei)
  externalFee  = 0.08-1 bps (depends on arb venue)
  captureRate  = 0.8e18   (80%)
  attractRate  = 0.3e18   (30%)
```

---

## Appendix A: Key Formulas

| # | Formula | Description |
|---|---------|-------------|
| 1 | `x0 = xr + BX` | Additive boost (see `additive-boost-derivation.md` for BX) |
| 2 | `gasCoeff = 2e18 × sqrt(gasUnits × 2 / eqWei)` | Gas threshold coefficient |
| 3 | `threshold = gasCoeff × sqrt(tx.gasprice)` | Effective no-arb threshold |
| 4 | `netEdge = max(mismatch - threshold - baseFee - externalFee, 0)` | Arber's exploitable edge |
| 5 | `arbFee = baseFee + captureRate × netEdge` | Fee on arb-direction swaps |
| 6 | `attractFee = baseFee + attractRate × max(mismatch - threshold, 0)` | Fee on attract-direction swaps |
| 7 | `\|dy/dx\| = px × x0^2 / (py × x^2)` for `x ≤ x0` | Marginal price (c=0) |
| 8 | `minReserve = eq / sqrt(1 + rx)` | Min reserve from range |
| 9 | `bXC = sx / (sx - 1)` where `sx = sqrt(1 + rx)` | Concentration boost factor |
| 10 | `auctionCost ≈ x0 × delta^2 / 4` | LP cost of a debt auction |
| 11 | `delta = 2 × debt × py / x0` | Minimum delta to clear given debt |

---

## Appendix B: Deployed Pool Registry

Canonical authoritative addresses live in [`docs/addresses.md`](addresses.md). Snapshot of the two live pools at time of writing:

| Pool | Pool address | Hook address | Hooked ops | baseFee |
|------|--------------|--------------|------------|---------|
| USDC/WETH | `0x4311...28A8` | `0x7bb6...e4FB` | GET_FEE + AFTER_SWAP | 5 bps |
| USDC/USDT | `0x7195...68A8` | `0x99b9...4e41` | GET_FEE + AFTER_SWAP | 0.05 bps |
