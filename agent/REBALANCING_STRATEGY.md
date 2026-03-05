# Interest-Rate-Aware Rebalancing Strategy

## The Problem

When a EulerSwap pool has leverage (borrow vaults enabled), sustained one-directional flow creates an imbalance:

1. Large flow in one direction (e.g., USDC→USDT) depletes one asset's supply
2. Pool borrows from the borrow vault to service further swaps
3. Vault utilization spikes → interest rate jumps above the IRM kink → LP pays 50%+ APR
4. Meanwhile the excess asset earns low deposit rates
5. Net carry (deposit yield − borrow cost) goes deeply negative

For stablecoin pairs with high concentration (near constant-sum), this is the primary risk — price barely moves so IL is negligible, but interest rate spikes can destroy profitability.

## Strategy Layers

### Layer 1: Reserve-Imbalance Fee Asymmetry (getFee hook — gas-free)

The simplest and most effective lever. When reserves are imbalanced relative to equilibrium, charge less for swaps that restore balance and more for swaps that worsen it.

**Signal**: compare current reserves to equilibrium reserves.

```
excess0 = reserve0 > equilibriumReserve0  (pool has too much asset0, short asset1)
excess1 = reserve1 > equilibriumReserve1  (pool has too much asset1, short asset0)

If excess0 and swap adds asset1:  LOW fee  (rebalancing — attract it)
If excess0 and swap adds asset0:  HIGH fee (worsening — discourage it)
```

This is distinct from oracle mismatch fees — it's a **position health** signal, not a price accuracy signal. Both can run simultaneously: oracle mismatch protects against MEV, reserve imbalance protects against interest rate risk.

**Implementation in getFee**: the hook already reads reserves and equilibrium. Add imbalance-aware fee adjustment on top of the existing mismatch-based formula:

```
fee = baseFee ± (mismatchScale × mismatch) ± (imbalanceScale × imbalance)
```

Where `imbalance = |reserve0 - eq0| / eq0` (or equivalent for asset1).

### Layer 2: Interest-Rate-Aware Fee Scaling (Agent — setFeeParams)

The agent reads vault utilization and borrow rates, then adjusts the hook's fee parameters to make the fee asymmetry proportional to the actual cost of the imbalance.

**Key insight**: the agent should be willing to give up fee revenue equal to the interest cost being avoided. If the pool is paying $137/day in borrow interest, spending up to $137/day in fee discounts to attract rebalancing flow is net-positive.

```
borrowCost = debtAmount × currentBorrowRate (annualized, per-second)
dailyBorrowCost = borrowCost × 86400

breakEvenFeeDiscount = dailyBorrowCost / expectedDailyVolumeInRebalancingDirection
```

**Severity tiers**:

| Vault Utilization | Imbalance | Action |
|-------------------|-----------|--------|
| < 70% (below kink) | Any | Normal fees — no urgency |
| 70-85% (near kink) | Mild | Mild fee asymmetry: reduce rebalancing-direction fee by 1-3 bps |
| 85-95% (above kink) | Significant | Strong fee asymmetry: rebalancing at minFee, worsening at maxFee |
| > 95% (critical) | Severe | Emergency: maximum asymmetry + reduce concentration |

**Agent actions by severity**:

1. **LOW** (utilization < kink, small imbalance):
   - No action needed. Normal mismatch-based fees handle it.

2. **MEDIUM** (utilization near kink, moderate imbalance):
   - `setFeeParams`: widen the min/max spread, increase mismatchScale
   - This amplifies the hook's per-swap asymmetry without requiring gas on every swap

3. **HIGH** (utilization above kink, large imbalance):
   - `setFeeParams`: set maxFee high (200-500 bps), minFee low (1-2 bps)
   - Consider `reconfigure`: shift equilibrium toward the excess side

4. **CRITICAL** (utilization > 95%, pool health at risk):
   - `reconfigure`: reduce concentration (makes curve more convex, naturally limits further borrowing)
   - `reconfigure`: shift equilibrium to reduce virtual exposure on the depleted side
   - Journal alert for owner review

### Layer 3: Equilibrium Shift (Agent — reconfigure)

If fee asymmetry isn't attracting enough rebalancing flow, the agent can shift the equilibrium point. This makes the pool quote a slightly better price for the rebalancing direction, which arbers will exploit.

**Mechanism**: shifting equilibrium so the pool offers the depleted asset at a slight discount relative to the market. Arbers see the opportunity and sell that asset to the pool, restoring balance.

**Cost**: the equilibrium shift means the pool pays a small spread on the rebalancing trades. This cost is bounded and predictable — the shift amount determines the maximum spread.

**When to use**: only when fee asymmetry alone isn't working (e.g., no volume, or volume is all in the wrong direction). The break-even is:

```
costOfShift = shiftAmount × spreadPaid
benefit = reducedInterestOverTimeToRebalance

Use shift when: costOfShift < expectedInterestSaved
```

### Layer 4: Concentration Reduction (Emergency)

Reducing concentration makes the curve more convex (closer to xy=k):
- Larger price impact per swap → naturally discourages further imbalance
- Less virtual liquidity = less potential new borrowing
- Pool quotes worse prices in the worsening direction automatically

**Trade-off**: also reduces capital efficiency and fee income from the good direction. Use only when the interest cost exceeds the lost fee income.

## Vault Data the Agent Needs

Each poll cycle, the agent should read:

```
For each borrow vault (borrowVault0, borrowVault1):
  totalBorrows:    vault.totalBorrows()     — total debt in the vault
  totalAssets:     vault.totalAssets()       — total supply + interest
  utilization:     totalBorrows / totalAssets
  borrowRate:      vault.interestRate()      — current per-second rate (scaled 1e27 ray)
  poolDebt:        vault.debtOf(eulerAccount) — this pool's specific debt

For each supply vault (supplyVault0, supplyVault1):
  poolDeposit:     vault.balanceOf(eulerAccount) — this pool's deposit (shares)
                   vault.convertToAssets(shares)  — convert to underlying amount
```

**Derived metrics**:
```
netCarry0 = depositYield0 - borrowCost0  (positive = earning, negative = paying)
netCarry1 = depositYield1 - borrowCost1

imbalanceRatio0 = (reserve0 - equilibriumReserve0) / equilibriumReserve0
imbalanceRatio1 = (reserve1 - equilibriumReserve1) / equilibriumReserve1

dailyInterestCost0 = poolDebt0 × borrowRate0 × 86400 / 1e27
dailyInterestCost1 = poolDebt1 × borrowRate1 × 86400 / 1e27
```

## Decision Framework

```
Every poll cycle:
  1. Read vault utilization + pool debt for both assets
  2. Compute net carry for each asset
  3. Identify which side is imbalanced (if any)

  If both net carries positive → no action (fees cover interest)

  If net carry negative on asset X:
    severity = dailyInterestCost / dailyFeeRevenue

    severity < 0.5 (interest < half of fees):
      → Mild fee asymmetry via setFeeParams
      → Widen min/max spread by ~2 bps each direction

    severity 0.5-1.0 (interest approaching fee revenue):
      → Strong fee asymmetry
      → Set minFee = 1 bps for rebalancing direction
      → Set maxFee = 3× baseFee for worsening direction
      → Consider equilibrium shift toward excess side

    severity > 1.0 (interest exceeds fee revenue):
      → Maximum fee asymmetry (minFee=1bps, maxFee=500bps)
      → Reduce concentration by 10-20%
      → Shift equilibrium
      → Journal alert

    severity > 2.0 (interest is 2× fee revenue — emergency):
      → Everything above
      → Reduce concentration to 0.3 or below
      → Strongly shift equilibrium
      → Consider pause recommendation to owner
```

## Integration with Existing Oracle Mismatch Fees

The reserve-imbalance signal and the oracle-mismatch signal are independent and additive:

- **Oracle mismatch**: protects against MEV/arb (informed traders). High fee on the mispriced side.
- **Reserve imbalance**: protects against interest rate risk. High fee on the direction that worsens debt.

When both signals agree (e.g., arb pushes price AND worsens imbalance), the fees compound — maximum protection. When they disagree (e.g., a rebalancing trade that also happens to move price toward oracle), the signals partially cancel — appropriate, since the trade is beneficial on one axis.

## Stablecoin-Specific Considerations

For USDC/USDT and similar pegged pairs:
- Oracle mismatch is usually tiny (< 5 bps) — the mismatch fee mechanism has little work to do
- Reserve imbalance is the primary risk factor
- Concentration should be high (0.8-0.95) for capital efficiency, but this amplifies the interest rate problem
- The agent should be more aggressive about rebalancing fees for stablecoin pairs since the cost of being wrong (paying a small fee discount) is much less than the cost of sustained high-rate borrowing
