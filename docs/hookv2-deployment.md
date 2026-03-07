# LPAgentHookV2 Mainnet Deployment — 2026-03-07

## Summary

Deployed LPAgentHookV2 on the USDC/WETH pool. The hook adds autonomous debt auctions
via `afterSwap` on top of the existing Mode 2 mismatch-based dynamic fees from `getFee`.

The first auction triggered immediately and **fully repaid all WETH vault debt** (0.7117 WETH → 0),
but the **pre-auction param restore failed** — the pool is currently running with stale auction
parameters (priceY=1995 instead of 1976, minReserves=0).

## Deployment

| Field | Value |
|-------|-------|
| Hook contract | `0xC3755af9b0B9F992e72C016d9554bdb97483d280` |
| Pool | `0x4311031739918Aba578C3C667DA3028A12Ce28A8` |
| Deploy block | 24602607 |
| Deploy tx | `0x793bd1e71f73f72915ceae4827a0ae998d54162f8386e51e30af8a7830d3e6e3` |
| Script | `contracts/script/UpgradeHookV2.s.sol` |

### Constructor Parameters

```
baseFee:      5e14        (5 bps)
maxFee:       3500e14     (3500 bps)
gasCoeff:     6.54e10     (from BoostReconfigure)
externalFee:  5e14        (5 bps, Uni V3 0.05%)
captureRate:  0.8e18      (80%)
attractRate:  0.3e18      (30%)
```

### Auction Parameters

```
threshold0:      0                        (disabled — USDC not depleted)
threshold1:      321,500,000,000,000,000,000  (321.5 WETH — just above reserve1)
delta:           100 bps                  (off-market priceY shift)
startFee:        200 bps                  (initial auction fee)
decayPerSecond:  1 bps/sec                (12 bps per block)
```

## Pre-Deployment Pool State

| Field | Value |
|-------|-------|
| reserve0 | 635,021 USDC |
| reserve1 | 320.52 WETH |
| eq0 | 634,245 USDC |
| eq1 | 320.91 WETH |
| min0 | 618,960 USDC |
| min1 | 313.18 WETH |
| priceY | 1976 |
| WETH vault debt | 0.7117 WETH |
| USDC vault debt | 0 |
| swapHookedOperations | 2 (GET_FEE only) |
| swapHook | `0x6f8aB798441b14b281540215774c2b3e1b3577f5` (V1) |

## Auction Execution

### Timeline

The first swap after V2 installation (block 24602608) triggered the auction. `afterSwap`
detected reserve1 (320.52) < threshold1 (321.5) and called `_triggerAuction`:

1. Saved pre-auction params (priceY=1976, eq, minReserves)
2. Set `priceY = 1976 × 1.01 = 1995` (+100 bps, attracting WETH)
3. Set `eq = current reserves`, `minReserves = 0`
4. Set `auctionActive = true`

### Swap-by-Swap

All 12 auction swaps were WETH→USDC (arbers selling WETH into the overpriced pool):

| Swap | Block | WETH in | USDC out | Fee | Reserve1 | vs 321.5 |
|------|-------|---------|----------|-----|----------|----------|
| 20 | +0 | 0.1514 | 299.71 | 13.8bp* | 320.67 | -0.83 |
| 21 | +10 | 0.1504 | 299.85 | 80.6bp | 320.82 | -0.68 |
| 22 | +12 | 0.1507 | 300.29 | 56.3bp | 320.97 | -0.53 |
| 23 | +12 | 0.1507 | 300.01 | 56.3bp | 321.12 | -0.38 |
| 24 | +12 | 0.1507 | 299.72 | 56.3bp | 321.28 | -0.22 |
| 25 | +14 | 0.1513 | 300.16 | 32.1bp | 321.43 | -0.07 |
| **26** | **+14** | **0.1513** | **299.88** | **32.1bp** | **321.58** | **+0.08** |
| 27 | +14 | 0.1513 | 299.78 | 25.8bp† | 321.58 | +0.08 |
| 28 | +14 | 0.1513 | 299.67 | 10.7bp† | 322.03 | +0.53 |
| 29 | +14 | 0.1514 | 299.67 | 10.7bp† | 322.03 | +0.53 |
| 30 | +15 | 0.0796 | 157.47 | 5.0bp† | 322.11 | +0.61 |
| 31 | +37 | 0.1515 | 299.35 | 6.8bp† | 322.26 | +0.76 |

\* Swap 20 was the trigger swap — fee was Mode 2 (auction not yet active for `getFee`)
† Swaps 27-31 are post-clearing — fees are Mode 2 (with stale priceY=1995)

**Auction cleared at swap 26** (block +14 = 168 seconds after trigger).

### Fee Decay Validation

The fee decay matched the expected `startFee - elapsed × decayPerSecond` precisely:

| Elapsed | Expected | Actual | Match |
|---------|----------|--------|-------|
| 120s (+10 blocks) | 80 bps | 80.6 bps | ✓ |
| 144s (+12 blocks) | 56 bps | 56.3 bps | ✓ |
| 168s (+14 blocks) | 32 bps | 32.1 bps | ✓ |

### Results

| Metric | Value |
|--------|-------|
| Total WETH inflow | 1.742 WETH |
| Total USDC outflow | 3,456 USDC |
| Total fees earned | 0.0058 WETH ($11.45) |
| WETH debt before | 0.7117 WETH |
| **WETH debt after** | **0 WETH (100% repaid)** |
| USDC debt | 0 (no new debt created) |
| Duration to clearing | 14 blocks (168 seconds) |
| Arb trades to clear | 7 (swaps 20-26) |

## Issue: Pre-Auction Param Restore Failed

### What happened

When the auction cleared at swap 26, `_restorePreAuctionParams` attempted to reconfigure
the pool back to pre-auction values:

```
priceY:      1995 → 1976
eq0:         634,721 → 634,245
eq1:         320.67 → 320.91
minReserve0: 0 → 618,960
minReserve1: 0 → 313.18
```

The reconfigure **reverted** (likely `CurveViolation`) because the post-auction reserves
(r0=632,921 / r1=321.58) don't satisfy the original curve invariant at the pre-auction
parameters. The try/catch in `_restorePreAuctionParams` swallowed the error.

### Current (stale) pool state

| Field | Current | Should be |
|-------|---------|-----------|
| priceY | 1995 | 1976 |
| eq0 | 634,721 USDC | 634,245 USDC |
| eq1 | 320.67 WETH | 320.91 WETH |
| minReserve0 | **0** | 618,960 USDC |
| minReserve1 | **0** | 313.18 WETH |

### Impact

- **priceY 1% above market**: Pool overprices ETH by ~100 bps. Mode 2 getFee detects
  this mismatch and charges elevated fees for WETH→USDC trades (~25-30 bps instead of ~5-10 bps).
  Not catastrophic but suboptimal — captures less arb value than correct pricing.

- **minReserves = 0**: No price range protection. The pool can theoretically be drained
  to zero in either direction. This is the more significant risk — a large adverse price
  move could push reserves to extreme values without the safety floor.

### Fix

The agent (or owner) must manually reconfigure the pool:
1. Read current reserves
2. Set priceY to current market price
3. Set eq0/eq1 to appropriate values (current reserves or boosted)
4. Restore minReserves based on desired range (rx, ry)

### Root Cause

The auction reconfigures the pool with `eq = current reserves` and a shifted priceY.
After 7 arb trades, the reserves moved to a new position. Restoring to the OLD curve
(pre-auction eq and priceY) with these NEW reserves violates CurveLib.verify because
the reserves no longer lie on the original curve.

### Recommended Fix for Hook Code

The `_restorePreAuctionParams` should compute the correct equilibrium for the current
reserves at the pre-auction priceY, rather than blindly restoring the old eq values.
Alternatively, set `initialState = equilibrium` instead of `initialState = reserves`.

## Other Observations

### Pre-V2 Agent Auction

Before V2 was installed, the agent (block 24600661) had already run a manual auction by:
1. Reducing priceY from 2040 → 1986 to attract USDC inflow
2. 10 USDC→WETH arb swaps followed (blocks 24600662-24600699)
3. Fee decay from 229 → 47 bps across those trades
4. Then reboost (block 24601142) and recenter (block 24601147)

V2 automates this pattern — the agent no longer needs to monitor and manually reconfigure.

### Reconfigure History (block 24598000+)

| Block | Event | Hook | priceY | eq0 | Notes |
|-------|-------|------|--------|-----|-------|
| 24598459 | Agent recenter | 0x7f93... | 2040 | 162,924 | |
| 24598895 | Hook swap | 0x0f26... | 2040 | 162,924 | Agent testing hooks |
| 24600339 | Hook swap to V1 | 0x6f8a... | 2040 | 162,924 | V1 installed |
| 24600602 | Agent recenter | V1 | 2040 | 164,972 | |
| 24600661 | Agent auction | V1 | **1986** | 164,972 | Attract USDC |
| 24601142 | BoostReconfigure | V1 | 1975 | **714,299** | Full boost |
| 24601147 | Agent recenter | V1 | 1976 | 634,246 | Post-boost recenter |
| **24602607** | **V2 install** | **V2** | 1976 | 634,246 | **hookedOps=6** |
| 24602608 | Auction trigger | V2 | **1995** | 634,721 | min=0 |

### Swap Activity Summary

31 total swaps since V2 deployment:
- 6 pre-V2 WETH→USDC swaps (normal Mode 2 operation)
- 13 USDC→WETH swaps (agent-initiated auction + aftermath)
- 12 WETH→USDC swaps (V2 autonomous auction + post-clearing)

Net flows since block 24598000:
- WETH: +1.50 net inflow (fully repaid 0.7117 debt + increased reserves)
- USDC: -3,042 net outflow (from supply vault)
- Fees: 30 USDC + 0.0175 WETH ($65 total)
