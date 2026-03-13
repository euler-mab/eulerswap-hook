# LPAgentHookV3 Design — Exposure-Based Rebalancing

> **Previous:** [debt-management.md](debt-management.md) (V2 design),
> [hookv2-deployment.md](hookv2-deployment.md) (V2 deployment history)

## Motivation

V2's auction mechanism triggers on **absolute reserve thresholds** — fixed
reserve levels below which vault debt is assumed. This works for the common
case (reserve drops → debt appears → auction clears debt), but has two
fundamental limitations:

1. **Only targets debt.** When the pool is long ETH (WETH deposits + USDC
   debt), V2 only tries to clear the USDC debt. It doesn't swap out the
   WETH deposits. The LP remains directionally exposed even after the
   auction clears.

2. **Threshold is absolute.** The agent must manually update threshold
   values whenever the pool is reconfigured. After each auction, eq
   changes, and the "zero debt" reserve level shifts. Stale thresholds
   either never trigger or trigger immediately.

V3 replaces absolute thresholds with **exposure relative to equilibrium**,
measured as a fraction of the LP's real NAV. The target is always **100%
USDC deposits** — any directional exposure (ETH-long or ETH-short) triggers
a rebalancing auction that returns the pool to neutral.

## Key Concepts

### Real NAV vs Virtual Reserves

The pool's virtual reserves (~$1.28M for our USDC/WETH pool) are the
leveraged position. The LP's real NAV is the vault equity:

```
NAV = vault_deposits - vault_debts ≈ $3k
```

The pool operates at ~430x leverage. A tiny reserve shift creates massive
exposure relative to real capital. This is why exposure must be measured
against NAV, not against virtual reserves.

### Exposure from Reserves

After each reconfigure (where vault exposure is cleared to zero), the hook
knows the "neutral" state. Subsequent reserve shifts map 1:1 to vault
position changes:

```
USDC vault change = reserve0 - eq0    (negative = USDC moved out)
WETH vault change = reserve1 - eq1    (positive = WETH moved in)
```

No vault queries needed. The deviation from eq IS the exposure.

### Two Directions of Exposure

Both directions are equally bad — both represent directional risk away from
the 100% USDC target:

**ETH-long (reserve0 < eq0):** Pool sold USDC, accumulated WETH.
- USDC vault: deposits decreased → eventually debt
- WETH vault: deposits increased
- Risk: ETH drops → WETH deposits lose value, USDC debt unchanged

**ETH-short (reserve1 < eq1):** Pool sold WETH, accumulated USDC.
- WETH vault: deposits decreased → eventually debt
- USDC vault: deposits increased
- Risk: ETH rises → WETH debt revalues upward

V2 only handles the case where reserves cross a fixed threshold (typically
detecting debt on one side). V3 handles both directions symmetrically by
measuring the total deviation from eq.

## Design

### Trigger: 50% of NAV Exposure

The pool's price range spans 5% in each direction from equilibrium. At
either boundary, the LP is at **maximum leverage** — fully exposed to one
asset. The exposure scales approximately linearly with the distance from eq
to the boundary:

```
At eq:          0% exposure (neutral, all USDC)
At 50% to boundary:  ~50% of max exposure
At boundary:    100% of max exposure (fully directional)
```

**Trigger at halfway to the boundary (50% of max leverage = 50% of NAV).**
This balances cost vs risk:

- **Higher threshold** (say 80%): fewer auctions, cheaper, but more capital
  at risk for longer. Pool may hit the boundary before the auction can clear.
- **Lower threshold** (say 20%): more frequent auctions, higher gas/fee
  costs, but less directional risk at any point.

50% is the starting point. We can tune based on observed auction costs and
price volatility.

### How Exposure Maps to Reserve Shifts

With ~430x leverage and a 5% price range:

```
Max exposure at boundary = NAV = ~$3k
50% trigger = $1.5k exposure
Reserve shift for $1.5k exposure ≈ 1,500 USDC outflow
                                 = 1,500 / 629,000 ≈ 0.24% of eq0
Price move for 0.24% reserve shift ≈ 0.48% (c=0: price ~ 1/x²)
```

So the auction triggers after roughly a **0.5% ETH price move** from the
last recenter. On a 5% range, this is 1/10th of the way to the boundary.

### Clearing Condition: Reserve Returns to Eq

V2 clears when `reserve >= threshold` (partial reversal). V3 clears when
the **attracted reserve returns to eq** — full exposure reversal:

```
ETH-long case:  clear when reserve0 >= eq0  (USDC fully restored)
ETH-short case: clear when reserve1 >= eq1  (WETH fully restored)
```

When reserve0 returns to eq0, the cumulative vault changes since the last
reconfigure are zero. Both USDC debt AND WETH deposits are unwound because
the arb flow that pushes reserve0 back simultaneously drains reserve1.

This is strictly more aggressive than V2's clearing — the auction runs
longer, attracting more flow, until the pool is fully neutral.

### Post-Auction Boundary Placement

After the auction clears, the pool is recentered (eq = reserves, priceY =
market). But the reserves are at an "off-centre" point: more of the
attracted asset, less of the shed asset, compared to where a fresh pool at
this price would sit.

**Boundaries must be 5% in price terms from the off-centre reserves, not
from eq.**

When eq = reserves (as we set during restore), these are the same point.
But the key insight is that the boundary calculation must account for the
pool's position on the curve:

For c=0, a 5% price increase from the marginal price at position x
corresponds to:

```
x_boundary = x / sqrt(1.05) ≈ x * 0.9759
```

So `minReserve = reserve * 0.9759` gives exactly 5% of price range
headroom from the current position.

The **closest boundary** (the direction the pool was drifting before the
auction — likely to drift again) should be 5% away. The **furthest
boundary** (opposite direction) can be wider, providing more room before
the next auction would trigger on that side. This is the asymmetric
boundary concept from V2.2, refined with the correct calculation.

### Auction Mechanics (Unchanged from V2)

The auction mechanism itself works well and doesn't need changes:

1. **Trigger**: afterSwap detects exposure > threshold
2. **Reconfigure**: eq = reserves, priceY shifted by delta (100bps)
3. **Fee**: time-decaying from startFee (200bps) to 0
4. **Arb flow**: arbers send the needed asset, take the excess asset
5. **Clear**: afterSwap detects reserves back at eq
6. **Restore**: eq = reserves, priceY = market, asymmetric boundaries

## V2 → V3 Changes

### Storage Changes

```solidity
// REMOVED
uint112 public auctionThreshold0;    // absolute reserve thresholds
uint112 public auctionThreshold1;

// ADDED
uint112 public nav;                   // LP real equity in USDC terms
uint64  public triggerBps;            // exposure threshold (BPS of NAV)
                                      // e.g. 5000 = 50%
```

### afterSwap Trigger Logic

```solidity
// V2: absolute threshold comparison
bool yDebt = t1 > 0 && reserve1 < t1;
bool xDebt = t0 > 0 && reserve0 < t0;

// V3: exposure relative to eq and NAV
IEulerSwap.DynamicParams memory dp = IEulerSwap(pool).getDynamicParams();
uint256 eq0 = dp.equilibriumReserve0;
uint256 eq1 = dp.equilibriumReserve1;

uint256 exposure;
bool attractAsset0;

if (reserve0 < eq0) {
    // ETH-long: USDC outflow
    exposure = eq0 - reserve0;
    attractAsset0 = true;   // attract USDC back
} else if (reserve1 < eq1) {
    // ETH-short: WETH outflow, convert to USDC terms
    exposure = uint256(eq1 - reserve1) * uint256(dp.priceX) / uint256(dp.priceY);
    attractAsset0 = false;  // attract WETH back
}

// Trigger when exposure exceeds threshold % of NAV
if (exposure > uint256(nav) * uint256(triggerBps) / 10000) {
    _triggerAuction(reserve0, reserve1, !attractAsset0);
}
```

### afterSwap Clearing Logic

```solidity
// V2: reserves above absolute thresholds
if (reserve0 >= t0 && reserve1 >= t1) { clear(); }

// V3: attracted reserve returns to eq (full exposure reversal)
IEulerSwap.DynamicParams memory dp = IEulerSwap(pool).getDynamicParams();
if (auctionAttractAsset1) {
    // Was attracting WETH → clear when reserve1 >= eq1
    if (reserve1 >= dp.equilibriumReserve1) { clear(); }
} else {
    // Was attracting USDC → clear when reserve0 >= eq0
    if (reserve0 >= dp.equilibriumReserve0) { clear(); }
}
```

**Important subtlety:** `eq` here is the equilibrium that was set when the
auction TRIGGERED (eq = reserves at trigger time). As the auction runs,
reserves shift: the attracted reserve increases back toward this eq. When
it reaches eq, the vault position changes since the last neutral state are
fully reversed.

### _restorePreAuctionParams Changes

```solidity
// V2.2: asymmetric minReserves with fixed 2*delta buffer
uint112 wideMin = uint112(reserve * (WAD - 2 * delta) / WAD);

// V3: 5% price range from off-centre reserves
// For c=0: 5% price change = reserve * (1 - 1/sqrt(1.05))
//        ≈ reserve * 0.0241 → minReserve ≈ reserve * 0.9759
uint112 min0 = uint112(uint256(reserve0) * BOUNDARY_FACTOR / WAD);
uint112 min1 = uint112(uint256(reserve1) * BOUNDARY_FACTOR / WAD);

// Both boundaries at 5% — the asymmetry comes from the off-centre
// position itself, not from different boundary distances
dp.minReserve0 = min0;
dp.minReserve1 = min1;
```

Where `BOUNDARY_FACTOR = 0.9759e18` (derived from `1 - 1/sqrt(1.05)`).

Note: the asymmetry is inherent in the off-centre position. Setting both
boundaries at the same distance from reserves means the boundary on the
side we just moved from is further from the "natural" center than the one
we moved toward. No explicit asymmetric logic needed.

### setAuctionParams Changes

```solidity
// V2
function setAuctionParams(
    uint112 _threshold0,    // REMOVED
    uint112 _threshold1,    // REMOVED
    uint64 _delta,
    uint64 _startFee,
    uint64 _decayPerSecond
) external onlyOwner;

// V3
function setAuctionParams(
    uint112 _nav,           // NEW: LP real equity in USDC terms
    uint64 _triggerBps,     // NEW: exposure threshold (BPS of NAV)
    uint64 _delta,
    uint64 _startFee,
    uint64 _decayPerSecond
) external onlyOwner;
```

## NAV Computation

NAV is set by the owner (agent) and stored in the hook. The agent computes
it from vault state:

```
NAV = USDC_deposits - USDC_debt + (WETH_deposits - WETH_debt) * ETH_price
```

At the "all USDC" neutral state:
```
NAV = USDC_deposits    (WETH = 0, no debts)
```

NAV changes slowly (vault yield, trading fees, IL). The agent updates it
at each reconfiguration. Between updates, a stale NAV is fine — the trigger
is approximate (50% is already a rough target).

For the current pool: `nav ≈ 2,980 USDC = 2,980,000,000` (raw uint112).

## Worked Example

### Current Pool State

```
eq0:      629,095 USDC        (virtual)
eq1:      323.49 WETH         (virtual)
reserve0: 628,354 USDC
reserve1: 323.86 WETH
NAV:      $2,980 (real)
```

**Exposure (ETH-long):**
```
USDC outflow = eq0 - reserve0 = 741 USDC
Exposure/NAV = 741 / 2,980 = 24.9%
```

24.9% < 50% → no auction triggered.

### Trigger Scenario

If ETH drops another ~0.5% and the pool buys more WETH:
```
reserve0 drops to ~627,600 USDC
USDC outflow = 629,095 - 627,600 = 1,495 USDC
Exposure/NAV = 1,495 / 2,980 = 50.2% → TRIGGER
```

Auction activates:
- priceY shifted down by delta (100bps): pool overprices WETH
- Arbers sell USDC, buy cheap WETH
- reserve0 increases, reserve1 decreases
- Clears when reserve0 >= 629,095 (eq0)

### Post-Auction State

After clearing:
```
reserve0 ≈ 629,100 USDC  (slightly above eq, due to arb overshoot)
reserve1 ≈ 323.10 WETH   (decreased — WETH sent to arbers)
```

Vault state: ~$2,980 in USDC deposits, ~0 WETH deposits, ~0 debt.

New boundaries (5% price range from reserves):
```
min0 = 629,100 * 0.9759 = 613,928 USDC
min1 = 323.10 * 0.9759 = 315.32 WETH
```

New eq = (629,100, 323.10). Pool recentered with 5% headroom from current
position in both directions.

## Risk Considerations

### Auction Frequency

With 50% NAV trigger and ~430x leverage, the auction fires after ~0.5% ETH
price moves. With ETH daily vol ~2-3%, expect **1-3 auctions per day**
under normal conditions.

Each auction costs roughly `uniFee + gas ≈ 5-6 bps` of the rebalanced
amount (~$1.5k), so **~$1-2 per auction**. At 2 auctions/day: ~$3-4/day.

### Manipulation

To force-trigger an auction, an attacker must move the pool's reserves by
~$1.5k (50% of $3k NAV). With Mode 2 capture fees (~80% of mismatch), the
attacker pays significant fees on this trade. The arb profit from the
subsequent auction is bounded by delta (~100bps on a small trade size).
Attack cost >> profit at current scale.

### Price Moves During Auction

Same as V2 (see debt-management.md §Price moves during auction). The
time-decaying fee provides natural protection: if the market moves against
the auction direction, the offset shrinks, and arbers won't trade (no
profit). The auction self-terminates when the fee decays to 0.

### NAV Staleness

If NAV is stale (not updated after vault yield or IL), the trigger
sensitivity shifts slightly. A stale-low NAV makes the trigger more
sensitive (fires sooner). A stale-high NAV makes it less sensitive. Since
NAV changes slowly and 50% is approximate, this is acceptable. The agent
updates NAV at each reconfiguration.

## Future Considerations

1. **Dynamic boundary width.** The 5% price range is fixed. At larger
   scales, wider ranges may be desirable (more depth, fewer auctions).
   Could be a parameter (`boundaryBps`).

2. **NAV computation onchain.** Currently owner-set. Could be computed from
   vault positions if the hook has access to vault state. Adds gas but
   removes dependency on the agent.

3. **Asymmetric triggers.** The 50% trigger treats both directions equally.
   If the LP has a directional preference (e.g. prefers USDC debt to WETH
   deposits), different thresholds per direction could be useful.

4. **Multi-pool.** If the same LP runs multiple pools (USDC/WETH,
   USDC/USDT), the NAV and exposure management could be coordinated across
   pools via a shared agent strategy.
