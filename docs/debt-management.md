# Debt Management in Leveraged EulerSwap Pools

> **Related docs:**
> - [`contracts/src/TWAP_RECENTERING.md`](../contracts/src/TWAP_RECENTERING.md) —
>   TWAP-based onchain recentering analysis. Covers oracle choice (slot0 vs TWAP),
>   manipulation costs, recentering design options (afterSwap drift, permissionless
>   keeper, hybrid), and an independent dutch auction analysis that reaches the same
>   conclusions we validate in simulation below.
> - [`scripts/sim-recenter.ts`](../scripts/sim-recenter.ts) — Simulation code with
>   bidirectional dutch auction implementation. Run with `npx tsx scripts/sim-recenter.ts`.
>
> **Status (2026-03-07):** Dutch auction abandoned at current scale. Agent-triggered
> direct swap is the near-term debt repayment mechanism. See [Simulation Findings](#simulation-findings-2026-03-07)
> and [Decision](#decision).

## Motivation

A leveraged EulerSwap pool creates depth by borrowing from Euler vaults. When
price moves, one side's real deposits get consumed and the pool borrows more.
This debt represents **unhedged directional exposure**:

- WETH debt = short ETH. If ETH rises, debt value rises, NAV falls.
- USDC debt = long ETH (relative). If ETH falls, you owe more valuable USDC.

The ideal resting state is: **USDC deposits only, no existing debt.** In this
state the pool is delta-neutral. ETH liquidity comes from *potential* future
borrowing, not from existing obligations. The pool only takes on directional
exposure when price moves — and removing that exposure on each recenter
restores neutrality.

This matters at scale. A pool with $10M depth and $500k WETH debt has
meaningful short ETH exposure. A 10% ETH rally costs ~$50k in debt revaluation.
Periodic debt removal is a risk management tool, not just an efficiency play.

## Why Debt Accumulates

With additive boost `x0 = xr + BX`:
- At equilibrium (x = x0), real deposits = xr, borrowed = BX
- As price moves (x decreases), more X consumed then borrowed
- X debt appears when `x < x0 - xr = BX`
- Maximum potential debt on each side = the boost amount

More depth = more potential debt. No way around this at H=1. But the debt
should be periodically cleared to return to neutral.

## Direct Swap vs Dutch Auction: When Does Scale Matter?

Debt accumulated per recenter cycle depends on price movement between
recenters. For c=0 with recenter threshold m (e.g. 5%):

```
debt_per_cycle ≈ x0 * m / 2     (in USDC terms)
```

Uni V3 USDC/WETH 0.05% pool (~$300-500M TVL) approximate price impact:

| Swap size | Uni slippage | Total cost (5bps fee + slippage) |
|-----------|-------------|----------------------------------|
| $100k     | ~1 bps      | ~6 bps                           |
| $1M       | ~5-10 bps   | ~10-15 bps                       |
| $10M      | ~50-100 bps | ~55-105 bps                      |

At 5% recenter threshold, debt per cycle vs pool scale:

| Real deposits | Virtual depth (x0) | Debt/cycle | Uni slippage | Dutch auction helps? |
|---------------|---------------------|------------|-------------|----------------------|
| $3k (now)     | $635k              | ~$16k      | < 1 bps     | No                   |
| $50k          | ~$7M               | ~$175k     | ~2 bps      | Marginal             |
| $275k         | ~$40M              | ~$1M       | ~5-10 bps   | Yes                  |
| $2.75M        | ~$400M             | ~$10M      | ~50-100 bps | Significant          |

**Slippage becomes material around $50k-275k real deposits** ($7-40M virtual).
Below that, direct swap is simpler and equivalent. Above that, splitting
execution across multiple arbers via dutch auction saves real money.

For near-term: direct swap is fine. Build the dutch auction mechanism now so
it's ready when the pool scales.

## Two-Mode Hook Design

The hook operates in two modes, each optimized for a distinct purpose.

### Mode 2: Normal Operation (default)

The current mismatch-based fee formula. Arb direction captures LVR, attract
direction offers competitive pricing for routing:

```
netEdge = mismatch - gasThreshold - baseFee - externalFee
arbFee  = baseFee + captureRate * max(netEdge, 0)
attrFee = baseFee + attractRate * max(mismatch - gasThreshold, 0)
```

This is the steady-state mode. Pool is at or near market price, handling
normal swap flow.

### Mode 1: Debt Repayment (Dutch Auction)

Activated when debt exceeds a threshold. The pool price is set off-market
to create an arb opportunity, but the fee starts too high for anyone to
take it. The fee then decays over time until an arber finds it profitable.

**Activation sequence:**
1. Agent detects debt > threshold (e.g. debt-to-NAV > X%)
2. Agent calls reconfigure: set `py_off = py_market * (1 + delta)`
3. Agent activates Mode 1 on the hook (sets start time, decay params)

**Fee in Mode 1:**
```
elapsed = block.timestamp - auctionStart
fee = startFee - decayRate * elapsed
fee = max(fee, 0)                        // floor at zero
```

`startFee` is set high enough that no arb is profitable initially (e.g.
maxFee or higher). As fee decays, at some point:

```
fee < priceImprovement - externalFee - gas/notional
```

...and the first arber trades.

**Key properties:**
- **Price discovery**: the settling fee is the market-clearing cost for the
  rebalancing service. The LP pays exactly the minimum needed.
- **Partial fills**: small arbers can trade early (small trades have higher
  average price improvement ≈ delta, vs delta/2 for a full-depth trade).
  Multiple arbers can chip away at the offset progressively.
- **Natural completion**: as arb flow brings the pool toward market price,
  the remaining offset shrinks, reducing the available edge. The auction
  self-terminates when the offset is consumed.

**Completion detection:**
After each swap in Mode 1, the hook (via afterSwap) or agent checks whether
sufficient debt has been repaid:
- If debt repaid to target → switch to Mode 2, reconfigure at market price,
  recompute boost from clean vault state
- If debt remains → Mode 1 continues, fee keeps decaying, next arber trades

**Fallback:** If the fee decays to 0 and debt is still not fully repaid
(no arbers took the trade), the agent can fall back to a direct swap.

### Mode Transition Diagram

```
                    debt > threshold
    Mode 2 ─────────────────────────────> Mode 1
  (normal)                              (dutch auction)
      ^                                      │
      │          debt repaid                 │
      └──────────────────────────────────────┘
                 or fee → 0 (fallback)
```

## Off-Market Pricing Math (c=0)

### Delta for target debt repayment

To repay `yd` WETH of debt, set pool off-market by delta:
```
delta ≈ 2 * yd * py_market / x0
```

Example: yd=0.7116 WETH, py=1986, x0=635000 USDC → delta = 44.5 bps

### WETH inflow from equilibrium to fair price
```
x_end = x0 / sqrt(1 + delta)
dy = (x0 / py_off) * (sqrt(1 + delta) - 1)
   ≈ x0 * delta / (2 * py_market)    for small delta
```

### LP cost (price improvement given, ignoring fees)
```
cost = x0 * delta^2 / 4
```

Quadratic in delta — small offsets are very cheap.

### Why the dutch auction solves the fee problem

With Mode 2's mismatch-based fee, the fee is computed from the ENTRY mismatch
(= full delta), but the arber's AVERAGE improvement is only delta/2. At high
captureRate, the fee exceeds the arber's edge and they won't trade.

The dutch auction sidesteps this entirely: the fee is time-based, not
mismatch-based. It starts high and drops until someone trades. The settling
fee is whatever the market will bear — automatically accounting for the
arber's true economics (average improvement, Uni fee, gas, profit margin).

### Partial trades and small arbers

A small arber trading quantity q << full-depth gets average price improvement
≈ delta (not delta/2), because they only move the pool marginally from
equilibrium. So small trades are profitable at HIGHER fees than a full-depth
trade would be.

This means the dutch auction naturally attracts:
1. Small fast arbers early (at higher fees — better for LP)
2. Larger arbers later (at lower fees — filling the remainder)

The LP benefits from this price discrimination.

## The Recenter Cycle

1. **Pool at equilibrium**: USDC deposits, no debt, delta-neutral (Mode 2)
2. **Price moves**: WETH borrowed, pool has short ETH exposure
3. **Recenter triggered**: price drifts beyond threshold
4. **Debt detected**: agent sees debt > threshold
5. **Mode 1 activated**: reconfigure with off-market py, start fee auction
6. **Arb flow settles**: WETH debt repaid via progressive arb trades
7. **Mode 2 restored**: reconfigure at market price, recompute boost from
   clean state (zero debt → maximum boost)
8. **Back to step 1**: delta-neutral, fresh leverage

Note: clean state does NOT necessarily produce larger boost. Repaying WETH debt
requires spending USDC (xr decreases, yd decreases). The net effect on boost
is approximately neutral unless LTVs are very asymmetric. The benefit of debt
repayment is restoring delta-neutrality, not increasing depth.

## Triggering Mode 1

Two possible triggers (not mutually exclusive):

1. **Debt threshold**: activate when debt-to-NAV exceeds X%. Responds to
   accumulated directional risk regardless of time.

2. **Time interval**: activate on a regular schedule (e.g. every N hours).
   Ensures periodic neutrality even if debt is moderate.

### Oracle for off-market pricing

Setting py off-market requires knowing the current market price. Options:

- **Offchain (agent)**: agent reads CowSwap/DefiLlama/Chainlink, computes
  py_off, calls reconfigure. Safe (no onchain manipulation), but requires
  the agent to be online. **Current best option.**

- **Uniswap slot0**: available onchain but manipulable via flash loans.
  Risky for setting py — an attacker could skew slot0 to make the pool
  set py in the wrong direction. **Not safe for Mode 1 activation.**

- **Uniswap TWAP**: 30-minute TWAP is much harder to manipulate. Could
  enable autonomous onchain Mode 1 (hook reads TWAP, detects debt via
  vault state, activates itself). **Future option** — adds gas cost and
  complexity, but removes dependency on the agent. See
  [`TWAP_RECENTERING.md`](../contracts/src/TWAP_RECENTERING.md) for
  detailed analysis of TWAP mechanics, manipulation costs ($388k-$4M to
  shift 5 bps), and gas overhead (~23k cold, negligible at current prices).

## Edge Cases and Security

### Price moves during auction

The most critical edge case. The off-market offset is set relative to the
market price at activation time. If the market moves during the auction:

**Price moves favorably** (e.g. ETH drops while repaying WETH debt):
- Pool becomes MORE off-market (even better deal for WETH sellers)
- Arbers trade more aggressively, debt repaid faster
- LP may overpay (offset is now excessive relative to new market)
- Mitigation: agent monitors and can abort/adjust if offset becomes too large

**Price moves adversely** (e.g. ETH rises while repaying WETH debt):
- Pool becomes LESS off-market, may cross to wrong side
- If py_off < py_new_market: pool is now UNDERPRICED for WETH
- Arbers would buy WETH FROM us (wrong direction), increasing debt
- **This is dangerous — the auction must be aborted**

**Mitigations for adverse price moves:**

1. **Timeout**: Mode 1 automatically expires after N blocks/seconds.
   If the auction hasn't cleared, revert to Mode 2 at current market.
   The hook can enforce this: `if (block.timestamp > auctionDeadline)
   → switch to Mode 2`.

2. **Agent monitoring**: agent watches market price during Mode 1. If
   price moves adversely by > delta/2, abort the auction (reconfigure
   to current market, switch to Mode 2).

3. **Direction guard in hook**: during Mode 1, the hook could reject
   swaps in the wrong direction (swaps that would INCREASE debt rather
   than decrease it). This is a safety check: only allow the
   debt-repaying direction during the auction.

4. **Small delta**: keeping delta small limits the window where adverse
   moves can flip the offset. At delta = 44 bps, ETH would need to
   move ~0.45% in the wrong direction to flip. At delta = 10 bps,
   only ~0.1%. Smaller delta = less repayment per auction but safer.

### Sandwich / MEV attacks on Mode 1 activation

If Mode 1 activation is predictable (e.g. fixed time intervals), an
attacker could:
- Front-run the reconfigure tx to position for the off-market pricing
- Sandwich the reconfigure to extract value from the price change

Mitigations:
- Use private mempools (Flashbots Protect) for the reconfigure tx
- Make timing unpredictable (debt threshold, not fixed schedule)
- The fee starts at maxFee, so front-running the reconfigure doesn't
  give immediate arb opportunity — the attacker still has to wait for
  the fee to decay

### Auction never clears

If no arber finds the trade profitable even at fee = 0:
- Delta may be too small (not worth gas)
- Market may have moved (offset consumed by price move)
- Fallback: agent does a direct swap (CowSwap)
- The timeout ensures Mode 1 doesn't persist indefinitely

### Re-entrancy / multiple auctions

Guard against Mode 1 being activated while already active. Only one
auction should run at a time. The hook should reject setMode(1) if
already in Mode 1.

## Simulation Findings (2026-03-07)

Implemented and tested the dutch auction in `scripts/sim-recenter.ts`. The
simulation runs a 30-day GBM price path with 5% recenter threshold, triggering
the auction whenever debt exceeds $100 before each recenter.

### Setup

- Pool: $3k real deposits → $635k virtual depth (additive boost)
- Auction: startFee=200bps, decay=2bps/min, uniFee=5bps
- Bidirectional: handles both WETH debt (yd) and USDC debt (xd)
- Arber trades to marginal-profit=0 endpoint at each fee level

### Results

| Metric | Value |
|--------|-------|
| Auctions triggered | 27 / 30 recenters |
| Total debt repaid | $76k |
| Total auction net cost | $222 |
| Total direct swap cost | $39 |
| Auction cost ratio | 5.7x more expensive |

### Why the auction always loses at current scale

The fundamental issue is **quadratic vs linear cost**:

- **Auction LP cost** scales as `x0 * delta² / 4` — the arber captures the
  average price improvement (delta/2), not just the marginal edge. This is
  quadratic in delta.

- **Direct swap cost** is `debt * uniFee` — linear in debt size, with
  negligible slippage at $16k per cycle on Uni V3's $300M+ USDC/WETH pool.

At small delta (<100bps), the auction roughly breaks even. At larger delta
(>300bps), the auction significantly overpays. The fee revenue from the
decaying auction fee only partially offsets the price improvement leaked to
arbers.

The auction only becomes competitive when **Uni slippage** adds meaningful
cost on top of the flat fee — which requires swap sizes of $200k+ per cycle
(real deposits ~$50k+, virtual depth ~$7M+).

### Decision

**Dutch auction abandoned for near-term.** At current and foreseeable pool
scale ($3k-$50k real deposits), direct swap is strictly cheaper.

**Alternative approach: agent-triggered direct swap.** The agent will:
1. Detect when vault debt (yd or xd) exceeds a threshold
2. Execute a direct swap (via Euler vault or DEX aggregator) to repay debt
3. Recenter to delta-neutral state with clean vault

The dutch auction mechanism remains documented here and in the simulation
code for future reference if the pool scales to $50k+ real deposits where
Uni slippage becomes material. The TWAP recentering doc's break-even
analysis ([`TWAP_RECENTERING.md` §Break-Even](../contracts/src/TWAP_RECENTERING.md#break-even-analysis))
confirms that *paying* to eliminate directional exposure is rational — the
question is only the mechanism (direct swap vs auction), not whether to do it.

## Open Questions

1. ~~**Decay parameters**~~: Tested at 200bps start, 2bps/min linear decay.
   Works but irrelevant at current scale — auction abandoned.

2. ~~**Delta sizing**~~: Full repayment targeting works. Delta formula
   `2*debt*py/x0` validated in simulation.

3. **Agent debt detection threshold**: What debt-to-NAV ratio triggers
   manual repayment? Needs tuning based on gas costs and rebalance
   frequency.

4. **Direct swap execution**: Use Euler vault repay directly, or route
   through DEX aggregator (CowSwap)? Vault repay may be cheaper if the
   agent holds the repayment asset.

5. **Interaction with Mode 2 attract-side fee**: During normal operation,
   the attract-side fee already encourages debt-repaying flow at lower
   cost. Should manual repayment only trigger for debt beyond what
   organic flow can clear?

6. **Revisit at scale**: If real deposits reach $50k+, re-evaluate the
   dutch auction. Uni slippage becomes material at $200k+ swap sizes.
