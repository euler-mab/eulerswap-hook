# Unified Simulation Validation

This document validates the unified simulation framework (`sim-engine.ts`) against known theoretical results for constant-product AMMs, then discusses the EulerSwap results.

---

## 1. Theoretical Background

### Impermanent Loss (IL)

For a constant-product (xy=k) AMM, given price ratio r = P_final / P_initial:

```
IL = 2√r / (1 + r) − 1
```

IL is always non-positive. Symmetric in log-price: IL(r) = IL(1/r).

Under GBM with zero drift, the **expected** IL as a fraction of pool value:

```
E[IL] = 2·exp(−σ²T/8) − 2   ≈  −σ²T/8   (for small σ²T)
```

### Loss-Versus-Rebalancing (LVR)

LVR isolates the adverse selection cost, separating it from market risk (Milionis et al., 2022).

For xy=k with pool value V under GBM:

```
instantaneous LVR rate = σ²V / 8
E[LVR over T] = σ²T/8 × V
```

This is the "Black-Scholes formula for AMMs." Doubling volatility quadruples LVR.

### Fee Revenue vs LVR

An arb-only pool (no organic flow) collects fees < LVR by construction — the arber only trades when profit exceeds the fee. Break-even requires organic volume:

```
daily volume needed = (σ²/8) / fee_rate × TVL
```

At 60% vol, 30bps fee: need ~4.1% of TVL in daily volume.

---

## 2. xy=k Baseline Validation

Configuration: $1M pool, 50/50 USDC/WETH, 30bps fee, 30 days, seed=42, zero drift GBM.

### Edge vs σ²T/8 Formula

| Ann. Vol | Predicted (σ²T/8 × $1M) | Sim Edge | Error |
|----------|--------------------------|----------|-------|
| 30%      | $925                     | −$901    | 2.6%  |
| 45%      | $2,082                   | −$2,039  | 2.1%  |
| 60%      | $3,699                   | −$3,718  | 0.5%  |
| 90%      | $8,322                   | −$8,445  | 1.5%  |

The simulation's edge metric matches the LVR formula within 3%. This validates:
- GBM price path generation (`generatePricePath`)
- Arb solver (`solveForPrice` + fee-adjusted target pricing)
- Edge computation (`Σ(inputs − outputs)` at fair price)

### Quadratic Scaling

3× volatility (30% → 90%) produces 9.4× edge ($901 → $8,445), close to the theoretical 9×.

### Fees < |Edge| (Arb-Only)

| Vol | Arb Fees | Edge    | Fee/LVR Ratio |
|-----|----------|---------|---------------|
| 30% | $595     | −$901   | 66%           |
| 45% | $947     | −$2,039 | 46%           |
| 60% | $1,323   | −$3,718 | 36%           |
| 90% | ~$2,000  | −$8,445 | ~24%          |

Fees recapture a declining fraction of LVR as vol increases — expected, since larger price moves overshoot the fee band by more.

### NAV Tracks HODL

xy=k NAV loss vs initial ≈ HODL loss ± 0.5%. This is correct for a single price path: the LP's residual IL from the endpoint price is small relative to the market return.

---

## 3. EulerSwap Results

### Full Stack (Oracle Fee + Continuous Recenter + Auction Backstop)

60% vol, $1M equity, rx=0.05, 30 days:

| Metric | Value |
|--------|-------|
| NAV | $625,960 (−37.4%) |
| Edge | −$926,633 |
| Arb Fees | $712,498 |
| Retail Fees | $5,168 |
| Auction Cost | $151,202 |
| Net Fees | $566,464 |
| Recenters | 431 |
| Min Health | 2.07 |

**Interpretation**: The ~250× leverage amplifies LVR by ~250× compared to xy=k ($927K vs $3.7K). Oracle fees recapture ~77% of the arb edge ($713K / $927K), but the residual 23% plus auction costs produce a net loss.

### Leverage Effect on LVR

EulerSwap edge / xy=k edge ≈ $927K / $3.7K ≈ 250×, which matches the equilibrium reserve boost factor. LVR scales linearly with pool depth (virtual reserves), confirming the σ²V/8 relationship holds for leveraged pools.

### Hook Comparison (60% vol)

| Strategy | NAV Δ | Fee Capture | Min H |
|----------|-------|-------------|-------|
| Static 30bps (no recenter) | +26.7% | 41% of edge | 1.00 |
| Oracle fees (no recenter) | +202.7% | 284% of edge | 1.00 |
| Full stack | −37.4% | 77% of edge | 2.07 |
| xy=k 30bps | −2.0% | 36% of edge | — |

The no-recenter strategies show `minH=1.00` (at liquidation boundary) and wildly path-dependent NAV. These are unrealistic — they would be liquidated on-chain. The full stack with recentering maintains healthy positions (minH=2.07).

The oracle-only strategy's >100% "fee capture" means fee revenue exceeds edge, which is possible because the pool also profits from its leveraged position on this specific price path. This is not sustainable in expectation.

---

## 4. Known Limitations

1. **Single price path**: All results above are seed=42. Expected values require Monte Carlo over many seeds.
2. **Discrete time**: Hourly steps (24/day) vs continuous-time theory. The 1–3% error in edge vs σ²T/8 is partly from discretization.
3. **cx=0 only**: The EulerSwap curve functions in `executeSwap` hardcode cx=0 (constant-product) formulas. Results for concentrated pools (cx > 0) would require fixing these.
4. **Auction params**: The auction backstop uses fixed params across all pairs. Low-vol pairs (USDC/USDT, wstETH/WETH) show disproportionate auction costs from miscalibrated thresholds.

---

## References

- Milionis, Moallemi, Roughgarden, Zhang. "Automated Market Making and Loss-Versus-Rebalancing." 2022. [arXiv:2208.06046](https://arxiv.org/abs/2208.06046)
- a16z Crypto. "LVR: Quantifying the Cost of Providing Liquidity." [Blog](https://a16zcrypto.com/posts/article/lvr-quantifying-the-cost-of-providing-liquidity-to-automated-market-makers/)
- Uniswap V2 Docs. "Understanding Returns." [Docs](https://docs.uniswap.org/contracts/v2/concepts/advanced-topics/understanding-returns)
