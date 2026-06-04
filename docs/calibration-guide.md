# Hook Parameter Calibration Guide

Every parameter in [DynamicFeeAuctionHook](../contracts/src/DynamicFeeAuctionHook.sol) is derived from first principles — equity, LTV, volatility, oracle source, and gas cost. Never copy parameters from another pool.

Run `scripts/calibrate-hook-params.ts` before every deployment or parameter update.

---

## Table of Contents

1. [Inputs Required](#1-inputs-required)
2. [Pool Shape](#2-pool-shape)
3. [Fee Parameters](#3-fee-parameters)
4. [Auction Parameters](#4-auction-parameters)
5. [Trigger Parameters](#5-trigger-parameters)
6. [Surcharge Parameters](#6-surcharge-parameters)
7. [Recenter Parameters](#7-recenter-parameters)
8. [Strategy Guide](#8-strategy-guide)
9. [Pre-Deployment Checklist](#9-pre-deployment-checklist)
10. [Parameter Quick Reference](#10-parameter-quick-reference)

---

## 1. Inputs Required

### 1.1 Cluster Selection

An Euler **cluster** is a set of EVK vaults that share a single `governorAdmin` address. The governor controls per-vault risk parameters (LTVs, oracle, caps, interest-rate model) for every vault in the cluster, so vaults inside the same cluster are designed to interoperate — you can borrow one against another at the LTV the governor has set.

A hook only borrows from the vaults named in its `StaticParams` (`borrowVault0`, `borrowVault1`), but both legs of an EulerSwap pool must live in the **same cluster** — otherwise the cross-LTV the calibration relies on does not exist and the vault wiring will not authorise the borrow.

**Find a vault's cluster.** Call `governorAdmin()` on the vault. The returned address is the cluster governor. Two vaults are in the same cluster iff they return the same `governorAdmin`.

```bash
cast call $VAULT "governorAdmin()(address)" --rpc-url $MAINNET_RPC_URL
```

**Find other vaults in the same cluster.** Use the helper script with the cluster governor address:

```bash
CLUSTER_GOV=0x... npx tsx scripts/find-vaults.ts
```

This enumerates every vault whose `governorAdmin()` matches `CLUSTER_GOV`, prints the underlying asset, current LTVs, and the supply/borrow caps — exactly the inputs you need for calibration.

**Live deployments.** Both production pools (USDC/USDT and USDC/WETH) use the Euler **Prime** cluster. See [addresses.md](addresses.md) for the current live pool, hook, and vault addresses — this guide intentionally does not pin them so it remains stable across redeployments.

### 1.2 Required Inputs

Before calibrating, gather:

| Input | Where to find it | Example |
|-------|------------------|---------|
| LP equity ($) | Vault deposits - debts | \$8,000 |
| Cross-LTV | EVK governor config | 0.86 (WETH), 0.96 (USDT) |
| σ_annual | Historical annualized vol | 70% (ETH), 0.05% (USDC/USDT) |
| Oracle source | Uniswap V3 pool or V4 PoolManager | V3 0.05% USDC/WETH |
| Oracle fee tier | Pool fee | 5 bps (V3), 0.08 bps (V4) |
| Concentration (c) | Pool's curve shape | 0 (range-based), 0.5, etc. |
| Gas cost | Current gas × swap gas × ETH price | ~\$0.30 at 0.4 gwei |

### 1.3 Volatility Classes

`σ_annual` drives `decayPerBlock`, `kMarginBlocks`, surcharge sizing, and the recenter range. Use the historical realised vol for the pair (or the dominant asset against USD for pegged pairs). The classes below cover the assets the hook currently targets:

| Class | Examples | σ_annual | Daily 1σ | Suggested `recenterRange` | Suggested `auctionTriggerThreshold` |
|-------|----------|----------|----------|---------------------------|-------------------------------------|
| Stable | USDC/USDT, USDC/DAI | 0.0005 – 0.002 | ~0.3 bps | 1 bps (1e14) | 50% of NAV |
| ETH-class | WETH/USDC, stETH/USDC | 0.60 – 0.80 | ~3 – 4% | 5% (0.05e18) | 50% of NAV |
| BTC-class | WBTC/USDC, cbBTC/USDC | 0.50 – 0.65 | ~3 – 4% | 5 – 10% (0.05 – 0.10e18) | 50% of NAV |

BTC's daily realised vol sits a touch below ETH, so the ETH-class recenterRange (5%) is a safe starting point. Widen toward 10% if the pool's cross-LTV is lower (e.g. 0.80 vs 0.86) and you want extra solvency headroom, or tighten toward 5% if you want recenter cadence closer to the ETH pool.

---

## 2. Pool Shape

### 2.1 Range Parameter (r)

The range controls leverage, trading capacity, and health at the boundary.

```
minReserve = eq / sqrt(1 + r / (1 - c))
```

**Calibration rule**: Set `r` against a safety-factored multiple of σ_daily, not at the naive h=1 boundary. The naive boundary formula `r = 1/(1-LTV)² - 1` gives a range that is orders of magnitude too wide for any volatile pair (5000% for LTV = 0.86). See [§7 recenterRange](#recenterrange) for the full derivation, safety factor, and worked numbers.

| Pool | Cross-LTV | r | Leverage |
|------|-----------|---|----------|
| USDC/WETH | 0.86 | 0.05e18 (5%) | ~78x |
| USDC/USDT | 0.96 | 1e14 (1 bps) | ~500x |

### 2.2 Equilibrium Reserves

**Delta-neutral pools** (e.g. USDC/WETH): `eq = current reserves` at deployment. Recentered to market on every recenter event.

**50:50 pools** (e.g. USDC/USDT): Use the additive boost formula to derive eq reserves from equity such that h=1 at the boundary:

```
BX = [v*yr*sx + xr*(v*(sx-1)*sx + R)] / [(sx-1)*(R - v*sx)]
eq0 = xr + BX
```

where `sx = sqrt(1 + r/(1-c))`, `R = 1 + r/(1-c)`, `v = cross-LTV`.

See [`DeployHookUSDCUSDT.s.sol:_computeEquilibrium()`](../contracts/script/DeployHookUSDCUSDT.s.sol) for the full implementation.

### 2.3 Variance Drain Viability

Before deploying, verify the pool can survive its holding period:

```
NAV(T) = NAV(0) × exp(-L × σ² × T / 8)
half-life = ln(2) × 8 / (L × σ²)
```

| L | σ (annual) | Half-life |
|---|------------|-----------|
| 78x | 70% | ~150 days |
| 500x | 0.05% | centuries |

The pool is viable if fee revenue exceeds variance drain: `volume × fee_rate > L × σ² × NAV / 8`.

---

## 3. Fee Parameters

### baseFee

Minimum fee on all swaps. Also serves as the auction fee floor.

**Rule**: Undercut the oracle pool's fee tier while remaining nonzero.

| Pool | baseFee | Oracle fee |
|------|---------|------------|
| USDC/WETH | 5 bps (5e14) | 5 bps |
| USDC/USDT | 0.05 bps (5e12) | 0.08 bps |

### maxFee

Safety cap on total fee (normal + surcharge + capture).

| Pool | maxFee |
|------|--------|
| USDC/WETH | 3500 bps (3500e14) |
| USDC/USDT | 50 bps (5e15) |

### externalFee

The oracle pool's actual fee tier. Used in arb capture and attract fee formulas.

### gasCoeff

Gas-price scaling for arb detection. The arb-side fee formula uses:

```
gasThreshold = gasCoeff × sqrt(tx.gasprice)
```

**Derivation**: At reference gas price, `gasThreshold` should equal the typical gas cost as a fraction of trade value:

```
gas_cost_usd = swap_gas_units × gas_price_eth × eth_price
gasCoeff = 2 × sqrt(gas_cost_usd / (eq_reserve_usd × gas_price_wei))
```

| Pool | gasCoeff | Reasoning |
|------|----------|-----------|
| USDC/WETH | 6.54e10 | ~25 bps at 0.4 gwei |
| USDC/USDT | 0 | Gas negligible vs sub-bps fees |

### captureRate

Fraction of arb edge captured on arb-direction swaps.

```
fee = baseFee + captureRate × (mismatch - effectiveThreshold)
```

The remaining `(1 - captureRate)` is the arber's profit margin. Set to 70–80%.

### attractRate

Fraction of routing headroom captured on retail-direction swaps.

```
headroom = mismatch + externalFee
fee = baseFee + attractRate × headroom
```

At 50%, the pool takes half the advantage while offering traders a 50% discount vs the external venue. Set to 30–50%.

---

## 4. Auction Parameters

### decayPerBlock (D)

The per-block fee decay rate during auctions. **This is a pair property, not a pool property.**

```
σ₁ = σ_annual / sqrt(blocks_per_year)
D ≈ σ₁
```

| Pair | σ_annual | blocks/year | D |
|------|----------|-------------|---|
| ETH/USDC | 70% | 2,628,000 | 4.3 bps (4.3e14) |
| USDC/USDT | 0.05% | 2,628,000 | 0.003 bps (3e11) |

**Why D = σ₁**: At D >> σ₁, coarse fee steps waste value. At D << σ₁, price moves dominate — waiting gains nothing. D ≈ σ₁ is the sweet spot.

### kMarginBlocks (k)

Time margin in blocks for the starting fee formula:

```
startingFee = premium + k × D
```

where `premium = |marginalPrice - oraclePrice|` at auction start.

`k` is the number of blocks of fee budget above break-even. Each block costs ~σ₁ in expected adverse movement.

| Pool | k | Extra margin | Reasoning |
|------|---|-------------|-----------|
| USDC/WETH | 15 | ~65 bps | Volatile: 3 min buffer |
| USDC/USDT | 250 | ~0.75 bps | Stable: blocks are cheap |

### clearThreshold

Fraction of clearing amount remaining to declare auction cleared:

```
remaining = (reserve_out - minReserve_out) / clearingAmount
if remaining < clearThreshold → auction ends
```

Set to 10% (0.1e18). This means the auction ends when 90% of the target exposure has been cleared.

### minAuctionBlocks

Minimum blocks before the clearing check runs. Prevents premature clearing before the fee has time to decay.

**Rule**: `minAuctionBlocks ≈ startingFee / D / 2` — fee decays ~50% before clearing is allowed.

| Pool | minAuctionBlocks |
|------|-----------------|
| USDC/WETH | 12 |
| USDC/USDT | 25 |

### auctionTimeout

Maximum blocks before the auction ends forcefully (restore to normal mode, no surcharge).

**Rule**: `timeout ≈ 3 × startingFee / D`. Generous upper bound.

| Pool | auctionTimeout | Duration |
|------|---------------|----------|
| USDC/WETH | 500 | ~100 min |
| USDC/USDT | 1500 | ~5 hours |

### minAuctionInterval

Cooldown blocks after auction end before the next trigger is allowed.

**Rule**: `minAuctionInterval ≈ 2 × minAuctionBlocks`.

| Pool | minAuctionInterval |
|------|-------------------|
| USDC/WETH | 25 |
| USDC/USDT | 50 |

### auctionTriggerThreshold

Relative exposure (% of NAV) that triggers an auction via trigger coordinates.

```
thresholdAmount = threshold × NAV / oraclePrice
triggerHigh = eq1 + thresholdAmount - baseNetAsset1
triggerLow  = eq1 - thresholdAmount - baseNetAsset1
```

Set to 50% (0.5e18) as a starting point.

---

## 5. Trigger Parameters

### oracleGuardMultiplier (g)

At auction start, the guard checks:

```
|marginalPrice - oraclePrice| < g × D × sqrt(blocksSinceSnapshot)
```

If the guard fails, the auction is aborted and the snapshot is refreshed. This prevents auction starts triggered by oracle manipulation.

`g = 3` gives a 99.7% confidence interval (3-sigma). False positive rate < 0.3%.

| Pair | D | 25 blocks | 100 blocks |
|------|---|-----------|------------|
| ETH/USDC | 4.3 bps | guard = 64.5 bps | guard = 129 bps |
| USDC/USDT | 0.003 bps | guard = 0.045 bps | guard = 0.09 bps |

### maxSnapshotInterval

Time-based trigger fallback. If `blocksSinceSnapshot > maxSnapshotInterval AND reserve != eq`, trigger an auction regardless of trigger coordinates. Absorbs interest drift.

| Pool | maxSnapshotInterval | Duration |
|------|-------------------|----------|
| USDC/WETH | 7200 | ~24 hours |
| USDC/USDT | 21600 | ~72 hours |

---

## 6. Surcharge Parameters

### surchargeMultiplier

Safety margin on the exact curvature formula:

```
curvatureComponent = (1 - c) × [(eq/reserve)² - 1]
priceComponent = |oraclePrice - poolPrice| / max(oraclePrice, poolPrice)
surchargeInitial = (curvatureComponent + priceComponent) × surchargeMultiplier
```

Any value ≥ 1.0 provides mathematical coverage. Recommended: 1.25e18 (25% margin).

For stablecoin pools with extreme leverage: 2.5e18 (accounts for the curvature bonus amplification).

### surchargeDecayPerBlock

Linear decay rate. Surcharge reaches zero in `surchargeInitial / surchargeDecayPerBlock` blocks.

**Why linear**: Exponential decay creates large per-block windfalls early (arbers time for a 50% discount at block N+1). Linear decay gives uniform small windfalls with no timing advantage.

| Pool | surchargeDecayPerBlock |
|------|----------------------|
| USDC/WETH | 10 bps/block (10e14) |
| USDC/USDT | 0.05 bps/block (5e12) |

### deploySurcharge

One-time protection fee at hook deployment. Target: decays to zero in ~100 blocks (~20 minutes).

```
deploySurcharge = surchargeDecayPerBlock × 100
```

| Pool | deploySurcharge |
|------|----------------|
| USDC/WETH | 500 bps (500e14) |
| USDC/USDT | 5 bps (5e14) |

---

## 7. Recenter Parameters

### recenterRange

Same as the range parameter `r`. Controls min reserves after recenter.

**The naive h=1 derivation is far too wide.** Setting health = 1 exactly at the boundary gives

```
r = 1 / (1 - LTV)² - 1
```

which for LTV = 0.86 yields `r ≈ 50` (5000%) — five orders of magnitude wider than the 5% the live USDC/WETH pool actually uses. A pool that wide would carry unbounded directional inventory before recentering and would liquidate on the first sharp move.

**Use a safety factor instead.** The live pools pull the boundary well inside the h=1 limit by sizing `r` against the realised volatility of the pair, not against the LTV. Pick `r` so that a worst-case price excursion of `N × σ_daily` still leaves the LP comfortably solvent (typically health ≥ ~1.5–2.0). For ETH-class pools this lands ~**100× tighter than the naive h=1 range**; for stable pairs the gap is wider still because LTVs are higher and σ is tiny.

**Working numbers:**

| Pool | σ_annual | σ_daily (1σ) | recenterRange | r / σ_daily | h=1 range | Safety factor |
|------|----------|--------------|---------------|-------------|-----------|---------------|
| USDC/USDT | 0.05% | ~0.3 bps | 1 bps (1e14) | ~5× | ~600% (LTV 0.96) | ~6000× |
| USDC/WETH | 70% | ~3.7% | 5% (0.05e18) | ~1.4× | ~5000% (LTV 0.86) | ~100× |

For USDC/USDT, `r = 1 bps` is roughly 5× the daily 1σ move — small but multiple sigmas of headroom given how thin stable-pair vol is.
For USDC/WETH, `r = 5%` is roughly 1.4× the daily 1σ move; the recenter-on-every-swap loop and the surcharge between recenters provide the rest of the safety margin.

For a new pool, start from the [volatility class table](#13-volatility-classes) and verify with the calibration script before deploying.

### maxRecenterDrift

Maximum price change accepted during a single recenter. Bounds damage from oracle manipulation.

```
newPriceY = clamp(oraclePriceY, priceY / (1 + drift), priceY × (1 + drift))
```

| Pool | maxRecenterDrift |
|------|-----------------|
| USDC/WETH | 3% (0.03e18) |
| USDC/USDT | 1 bps (1e14) |

### minRecenterDelta

Minimum exposure decrease (WAD-scaled) to trigger a continuous recenter. Prevents gas waste on dust-sized recenters.

| Pool | minRecenterDelta |
|------|-----------------|
| USDC/WETH | 0 |
| USDC/USDT | 0.5 bps (5e13) |

---

## 8. Strategy Guide

### Delta-Neutral (USDC/WETH)

Target: 0% WETH exposure. All value in USDC.

- Trigger coordinates centered around eq1
- `baseNetAsset1` tracks net WETH at last snapshot
- Clearing auction removes WETH exposure via arb flow
- Continuous recenter fires whenever exposure-reducing swaps occur

### 50:50 (USDC/USDT)

Target: equal value in both assets.

- Uses additive boost formula for eq reserves (h=1 at boundary)
- Trigger coordinates offset by existing vault exposure
- Auction trigger threshold still 50% of NAV — but NAV is tiny relative to virtual depth
- The `targetNetAsset1` extension (Option A from plan) allows configuring nonzero target exposure

### How Strategy Affects Parameters

| Parameter | Delta-Neutral | 50:50 |
|-----------|--------------|-------|
| eq reserves | = current reserves | additive boost from equity |
| concentration | pool-specific | typically 0 |
| recenterRange | wider (5%) | tight (1 bps) |
| decayPerBlock | σ₁ of the pair | σ₁ of the pair |
| triggerThreshold | 50% NAV | 50% NAV |
| surchargeMultiplier | 1.25× | 2.5× |

---

## 9. Pre-Deployment Checklist

1. **Vault setup**: Supply vault, borrow vault, and EVC permissions configured for the euler account
2. **Cross-LTV verified**: Check both directions. Use the lower LTV for range calibration
3. **Range derived**: safety-factored against σ_daily (see [§7](#7-recenter-parameters)), not naive h=1 at boundary
4. **Eq reserves computed**: From equity + boost formula (50:50) or current reserves (delta-neutral)
5. **Min reserves computed**: From eq + range + concentration formula
6. **σ₁ derived**: From historical annual vol and blocks/year
7. **All fee params set**: baseFee, maxFee, gasCoeff, externalFee, captureRate, attractRate
8. **All auction params set**: D, k, clearThreshold, minAuctionBlocks, timeout, cooldown, trigger
9. **Run calibration script**: `npx tsx scripts/calibrate-hook-params.ts` — all checks must pass
10. **Dry-run deploy**: `forge script --fork-url $RPC_URL` — verify final state logging

---

## 10. Parameter Quick Reference

### AuctionConfig Struct

| Field | Type | Derivation | Volatile | Stable |
|-------|------|-----------|----------|--------|
| decayPerBlock | uint64 | σ_annual / √(2.628M) | 4.3e14 | 5e12 |
| auctionTriggerThreshold | uint64 | 50% of NAV | 0.5e18 | 0.5e18 |
| clearThreshold | uint64 | 10% remaining | 0.1e18 | 0.1e18 |
| minAuctionBlocks | uint64 | startingFee / D / 2 | 12 | 25 |
| minAuctionInterval | uint64 | 2 × minAuctionBlocks | 25 | 50 |
| auctionTimeout | uint64 | 3 × startingFee / D | 500 | 1500 |
| kMarginBlocks | uint64 | 15 (volatile), 250 (stable) | 15 | 250 |
| oracleGuardMultiplier | uint64 | 3σ confidence | 3e18 | 3e18 |
| maxSnapshotInterval | uint64 | 24h (volatile), 72h (stable) | 7200 | 21600 |
| recenterRange | uint64 | safety factor on σ_daily (see §7) | 0.05e18 | 1e14 |
| maxRecenterDrift | uint64 | conservative clamp | 0.03e18 | 1e14 |
| minRecenterDelta | uint64 | dust prevention | 0 | 5e13 |
| surchargeDecayPerBlock | uint64 | deploySurcharge / 100 | 10e14 | 5e12 |
| surchargeMultiplier | uint64 | 1.25× or 2.5× | 1.25e18 | 2.5e18 |
| deploySurcharge | uint64 | surchargeDecay × 100 | 500e14 | 5e14 |

### FeeConfig Struct

| Field | Type | Derivation | Volatile | Stable |
|-------|------|-----------|----------|--------|
| baseFee | uint64 | Undercut oracle | 5e14 | 5e12 |
| maxFee | uint64 | Safety cap | 3500e14 | 5e15 |
| gasCoeff | uint64 | Gas cost scaling | 6.54e10 | 0 |
| externalFee | uint64 | Oracle pool fee | 5e14 | 8e12 |
| captureRate | uint256 | 70–80% | 0.8e18 | 0.8e18 |
| attractRate | uint256 | 30–50% | 0.3e18 | 0.5e18 |

### Key Formulas

| Formula | Expression |
|---------|-----------|
| Per-block vol | σ₁ = σ_annual / √(2,628,000) |
| Starting fee | premium + k × D |
| Min reserve | eq / √(1 + r/(1-c)) |
| Guard threshold | g × D × √(blocksSinceSnapshot) |
| Trigger high | eq₁ + thresholdAmt - baseNetAsset1 |
| Variance drain | NAV(T) = NAV(0) × exp(-L × σ² × T / 8) |
| Surcharge | max(0, initial - decay × blocks) |
