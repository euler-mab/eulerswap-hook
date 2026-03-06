# EulerSwap Dynamic Fee Strategy — Design Notes

## Context

These notes synthesize insights from:
- The AMM Challenge competition (constant-product AMM fee optimization under constraints)
- EulerSwap's concentrated-liquidity curve math and simulation tests
- Discussion of how EulerSwap's architecture (oracle access, afterSwap hooks, offchain agents) enables strategies impossible in the competition

## The Core Problem

Every AMM LP faces: **profitability = fees − IL**. Fees grow linearly with volatility (more trades). IL grows quadratically (each trade at a worse price). There's a crossover volatility where fees = IL. Below it, LPs profit. Above it, they lose.

The LP's only levers are:
1. **Fee level** — how much to charge per trade
2. **Concentration (cx)** — how capital-efficient the curve is (amplifies both fees AND IL)
3. **Range (rx)** — how far price can deviate before the pool stops trading

## What the Competition Proved

### The constraint: no beforeSwap, no oracle, no offchain compute
Strategies only see `afterSwap(TradeInfo)` — trade direction, size, reserves, timestamp. No fair price. Fees set for the *next* trade, not the current one.

### Strategy evolution (ranked by sophistication)

1. **Fixed fee sweep**: Optimal fixed fee is ~25-28bps, below the 30bps competitor. Undercutting captures more retail volume than the extra per-trade income from higher fees.

2. **Timestamp switch**: Arb fires first each step. After seeing arb (new timestamp), set low fee for retail. After retail, set high fee for next arb. Simple but effective.

3. **Direction asymmetric (DA)**: After arb pushes price up, protect bid (high fee), compete on ask (low fee). After arb pushes price down, the reverse. The insight: arbs tend to continue in the same direction (price trending), while retail is balanced.

4. **Size-scaled DA**: Large trades (>25 Y) → extreme asymmetry (60/0 bps). Small trades → narrow gap (26/24 bps). Large trades are disproportionately arbs.

5. **Deviation-scaled**: EMA of spot as fair price proxy. Fee gap proportional to |spot − EMA|. Captures cumulative mispricing that size-only heuristics miss.

6. **Confidence-scaled (optimal_fee_v2)**: Only go asymmetric when confident about direction. When mismatch is small (uncertain), charge symmetric moderate fees. Being fully asymmetric on the wrong side is worse than symmetric.

7. **Bayesian fair price tracker**: Full probabilistic model. Posterior N(μ, σ²) in log-space. Three likelihood signals for P(arb): trade direction vs expected, consistency of inferred price with posterior, trade size distribution. Mixture updates, truncation to no-arb band.

8. **Routing-aware (double_or_quits)**: Shadow the competitor's reserve state. Detect per-side routing advantage. Charge more on advantaged sides, less on disadvantaged. This is the ceiling — it requires accurate fair price estimation.

### Key finding
~80% of the alpha comes from principles 1-3 (undercut + asymmetric fees + direction signal). The Bayesian inference stack adds ~5 edge. Most complexity has diminishing returns.

## How EulerSwap Changes the Game

EulerSwap has what every competition strategy was trying to reconstruct: **the oracle price**.

### Three execution layers

#### Layer 1: In-swap (gas-free, swapper pays)
Read the Euler oracle price during the swap itself. Compute the optimal fee for *this* trade, not the next one.
- `fee = f(|oracle_price − pool_marginal_price|)`
- Asymmetric bid/ask based on which side the mismatch is on
- The arber pays gas to compute the fee that protects the LP

This alone eliminates the competition's core problem (one-trade delay, no fair price).

#### Layer 2: afterSwap hooks (gas-free, swapper pays)
Update persistent state that enriches Layer 1 on the next trade:
- Track trade direction, size, block number (arb detection heuristics)
- Maintain EMA of realized volatility → adapt base fee level
- Count consecutive directional flow → widen fees during momentum
- All the competition's techniques, running for free

#### Layer 3: Offchain agent (pays gas, infrequent)
Monitor aggregator quotes (CowSwap, 1inch) for signals beyond what the oracle provides:
- **Full depth profile** — not just fair price, but liquidity at each price level
- **Effective market spread** — what fee level the market will bear
- **Your routing position** — how much flow you'd get at various fee levels

Trigger structural param updates when conditions warrant:
- **Concentration (cx)** — increase in low-vol regimes for more fee capture, decrease in high-vol to reduce IL exposure
- **Range (rx)** — widen when vol spikes to stay in range, tighten when calm for capital efficiency
- **Equilibrium rebalancing** — re-center the pool when oracle has drifted far from pool's px/py

### Gas economics for Layer 3
Only submit updates when: `expected_IL_saved > gas_cost`. Practical threshold: mismatch > max(5bps, gas_cost_in_bps).

### Manipulation defenses
- **Time-weighted quotes** — average across several blocks to filter single-block manipulation
- **Private mempools** (Flashbots Protect) for param update txs
- **Asymmetric response speed** — widen fees fast (1 block), narrow slow (several blocks)
- **Rate limiting** — at most 1 structural update per N blocks

## Connection to Curve Math

### Concentration as a fee/IL dial
From strategy hypothesis H4: at the same price deviation, higher cx → more IL. But also more fee capture (capital efficiency). The optimal cx depends on expected vol:
- `IL ∝ σ² × f(cx)` where f is increasing in cx
- `fees ∝ σ × g(cx)` where g is also increasing in cx
- Breakeven: `σ* = g(cx) / f(cx)` — higher cx lowers the breakeven vol

This means aggressive concentration is only profitable if you can keep fees above the IL threshold. Dynamic fees (Layer 1) make this more achievable by charging arbs more.

### Range as a stop-loss
From simulation tests: wider rx → more time in range → more fee capture. But wider range also means more IL exposure at the boundary. The LLTV floor (H8) guarantees NAV ≥ Debt × (1/vyx − 1) at boundary.

### Convexity protects LPs (H5)
f''X(x) > 0 everywhere. Large trades pay disproportionately more. This is automatic protection against informed traders (who want large positions). Dynamic fees add a second layer on top of this convexity.

## Aggregator Quotes as a Signal

Querying an aggregator (with your pool excluded) gives:
1. **Market mid price** — fair price for fee computation
2. **Bid-ask spread** — the fee floor (below this, you're subsidizing the market)
3. **Depth profile** — where to concentrate liquidity (match the market's depth)
4. **Your routing share** — difference between "with you" and "without you" quotes shows your competitive position

The optimal fee converges to: `fee ≈ market_spread/2 − ε` — just enough to undercut the marginal competing venue. The concentration parameter cx should match the market's depth profile: high cx to compete where volume is (near mid), let the tail go.

## Summary

The competition proved dynamic asymmetric fees indexed to mismatch are the right framework. EulerSwap can implement it optimally across three layers: in-swap oracle reads (gas-free, handles 90% of the value), afterSwap state tracking (gas-free, incremental heuristics), and offchain agent (pays gas, structural updates). The concentration parameter cx adds a dimension the competition never had — matching curve shape to the volatility regime and market depth profile.
