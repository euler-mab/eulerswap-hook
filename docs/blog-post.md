# How to run an active single-LP AMM on EulerSwap without a bot

## Introduction

Most AMM LPs lose to arbs. The textbook complaint — "you're just paying LVR" — assumes a passive constant-product position with one fee for every direction. Every directional move means the arber takes the spread before you can react, and you eat the inventory shift. Concentrated liquidity tightens depth but doesn't change the asymmetry.

This repo is one way out of that. It's an EulerSwap hook — a single ~1000-line Solidity contract — that runs **active single-LP liquidity provision**: one operator per pool, dynamic fees set against a Uniswap-spot oracle, Dutch fee-decay auctions for autonomous rebalancing. All on-chain, no off-chain bot for the core loop.

It's **adjacent in goal** to a propAMM — single operator captures arb economics with asymmetric fees — but the mechanism is different. Most propAMMs in 2026 are **builder-coordinated**: an off-chain market maker streams signed quotes to the block builder, who matches incoming orderflow against the freshest quote inside the block before it lands. The private fair-value signal lives with the maker; the builder provides sequencing. This hook has no builder integration and no off-chain quoter; it's rule-based, public formulas, every block, on-chain. Worth naming because the two designs share a vocabulary without sharing a machinery.

Four mechanisms compound. None is novel in isolation — what's interesting is that together they let a single LP autonomously price-discriminate by direction, source per-trade inventory ~25× their equity via credit, rebalance without an off-chain bot, and live alongside Fluid DEX and Egorov's Yield Basis in the broader space of credit-backed active LP designs on-chain.

![Passive constant-product LP vs active single-LP hook — same flow, different fee response, different P&L](../assets/1-passive-vs-active.png)

## Uniswap spot as a fee compass

The hook reads the deepest Uniswap pool's spot price on every quote — V3 `slot0()` or V4 `extsload` on the PoolManager. That gives the AMM a reference for *which direction* is profitable to arb.

You can't use spot as a **collateral** oracle — it's manipulable within a block, and the whole "Aave wouldn't take spot as a price feed" intuition is right. But you can use it as a **fee compass**, because:

- the hook never lowers the fee below `baseFee` — it only ever raises it
- an attacker who manipulates spot to inflate the AMM's quoted fee pays that fee on their own swap
- there's no direction the manipulation can profit them

Spot-as-fee-oracle is the cheap, lazy, completely safe choice — and almost nobody uses it because the "spot is unsafe" framing got generalised too far. Full analysis: [`docs/uniswap-oracle-pattern.md`](https://github.com/euler-mab/eulerswap-hook/blob/main/docs/uniswap-oracle-pattern.md).

## Routing-aware asymmetric fees

With a fee compass, you can quote different fees in different directions. When the pool is offering an arb against itself, the hook **captures** the arb:

```
fee = baseFee + captureRate × oracleDelta
```

When the pool is competing for retail flow against a deeper venue, it **attracts** flow by quoting tighter than the reference Uniswap pool:

```
fee = baseFee − attractRate × externalFee
```

Asymmetric by design. Toxic flow pays for itself, retail flow gets a discount, and the LP isn't relying on a private fair-value model to tell them which is which — the spot oracle is the signal.

## Credit-backed depth

EulerSwap is the substrate. Each Euler account is its own AMM, with the same collateral that's earning lending yield doubling as swap liquidity. With LTVs up to 96% on stables, the pool can source per-trade inventory ~25× its equity by looping the vault credit. The curve's "virtual reserves" (eq0/eq1) then shape the slippage *within* that capacity — large virtual reserves with concentration around a peg means near-1:1 pricing for trades inside the band. Per-trade capacity, though, is still ultimately bounded by collateral × LTV.

![Credit-backed amplification — $500 NAV supports ~$10k of per-trade inventory and tens of $k/day of cumulative throughput on busy days because the auction cycles direction many times per day](../assets/2-credit-backed-depth.png)

The live USDC/USDT example: ~$500 of equity in a sub-account ($382 USDC + $119 USDT). Per-trade capacity is order $10k. The curve has virtual reserves of $247M / $242M which give very tight pricing within that capacity — but the $247M number is a slippage-curve parameter, not a depth claim. The actually-interesting number is **daily turnover**: when flow is active, the auction recycles direction multiple times a day, taking volume well into multiples of equity. The pool's averaged ~$46k/day over the last week on $489 NAV (~95×). Flow is bursty — quiet days drop to zero, busy days exceed $100k.

Every swap that adds inventory deposits to the supply vault or repays debt; every swap that drains inventory borrows from the borrow vault or withdraws supply. The pool's "real" footprint is small and directional. Auctions are what keep it from getting stuck.

That's the next problem.

## Dutch fee-decay auctions for rebalancing

When the LP's net base-asset position drifts past a threshold (a configurable fraction of NAV), the hook starts an auction. Three things happen, all autonomously from inside `afterSwap`:

1. **Shift.** The hook reconfigures the pool to a deliberately mispriced `priceY`. The shift size is taken from actual exposure (not a fixed magnitude), capped at `maxShiftMagnitude`. After the shift, the pool's marginal price is off from the oracle by a known amount — an arb opportunity priced into the curve.
2. **Decay.** The hook quotes a high starting fee (~1.5× the shift). Block by block, that fee decays toward `baseFee`. Arbers wait for it to be cheap enough to be profitable net of gas. Eventually one takes it.
3. **Clear.** The arber's trade pushes the marginal price back toward the oracle. Once convergence is detected (price diff < `clearThreshold`), the hook recenters the pool — eq = current reserves, priceY = oracle — and exits the auction. The arb spread has paid for the rebalance.

![Auction lifecycle — shift creates a known arb, fee decays until an arber takes it, the clearing swap recenters the pool](../assets/3-auction-timeline.png)

The clever bit is that **the rebalance is paid for by the arber**, not by the LP. A traditional LP would have to sell directional inventory on an external venue — eating slippage and the bid-ask. Here the arb spread *is* the rebalance, and the LP just chooses how much to charge for capturing it. Higher startingFee = more LP capture, longer wait. Lower decay rate = same shape, faster clear.

Convergence is measured on price (marginal vs oracle), not reserves — a direct read on whether the arb has been consumed. A `minAuctionBlocks` floor prevents the auction from clearing before the fee has had time to decay; otherwise the very first swap after the shift would clear at the starting fee, defeating the auction.

## Curvature surcharge — anti-round-trip

Every recenter creates a small kink in the curve. An attacker who anticipates a recenter (and there are many — recenters happen on most swaps that reduce exposure) can round-trip across the kink: trade in, wait for the recenter, trade out. The displacement-bonus the curve had just before the recenter is now extractable for free.

The hook adds an additive surcharge to the fee, sized **exactly** to the curvature bonus the recenter exposed, decaying to zero over a configurable horizon. The first swap after a recenter pays the full surcharge; by the time the curve has settled, the surcharge is back to zero. Round-trip extraction becomes unprofitable.

Plus a one-shot **deploy surcharge** — high at deployment, decaying over the first few hours, so a mispriced initial deploy is expensive to arb before the operator notices and corrects.

## Live numbers

The author runs one of these on Ethereum mainnet:

| | USDC/USDT |
|---|---|
| Pool | [`0x71...68A8`](https://etherscan.io/address/0x719529e99b7b272c5ef4ce07c30d15bc57cd68a8) |
| Hook | [`0x99...4e41`](https://etherscan.io/address/0x99b97FD05b4F943899358F90855C0BEE34584e41) |
| LP equity (NAV) | ~$489 |
| Volume (7d avg) | ~$46k/day (bursty: $0 – $100k) |
| Daily turnover (7d avg) | ~95× |
| Lifetime volume | ~$810k (187 swaps over ~90 days) |
| Lifetime fees collected | ~$24 |
| Lifetime auctions (started / ended) | 52 / 51 |
| P&L since live (~90 days) | -$12 (-2.4%) |

The pool's running a small loss — quiet stretches accrue more borrow carry than the busy stretches' fees recover. At 10× equity the same mechanism would be net positive; at 100×, meaningful. The proof-of-principle here is that the *mechanism* works at all, not that $500 is the right size to capture the upside.

## Plug into routing for free

An EulerSwap pool is automatically a Uniswap v4 hook. The moment you register your pool with [Euler's orderflow router](https://github.com/euler-mab/eulerswap-hook/blob/main/contracts/script/RegisterPools.s.sol) — a one-tx call — every aggregator that integrates Euler sees your `computeQuote()` function and routes through it on price. UniswapX fillers, 1inch Fusion resolvers, CoW Protocol solvers, Tycho-consuming aggregators — all of them speak EulerSwap (or can via integration code at [`eulerswap-integrations`](https://github.com/euler-mab/eulerswap-integrations)).

The retail flow that makes the attract-side fee profitable comes from this routing layer. Without it, the only counterparties you'd see are arbers.

## No off-chain bot

Every mechanism above runs on-chain, inside `getFee()` and `afterSwap()`. The hook reads the oracle, computes the fee, runs the auction state machine, and calls `pool.reconfigure()` to recenter — all from within EulerSwap's `afterSwap` callback, where the pool storage is unlocked.

That means: no keeper, no bot, no off-chain process needed to operate. The owner can call `setFeeParams` / `setAuctionParams` etc. to retune from time to time as the pair's flow profile clarifies, but that's a slow-timescale operation. The core loop is the hook.

This matters because the alternative — an off-chain agent that monitors the pool and submits rebalance txs — is what early versions of this project did, and it's brittle. Every keeper-driven design has the same failure modes: bot goes down, RPC flakes, gas price spikes, MEV bots front-run the rebalance. Moving the whole loop into `afterSwap` removes the entire off-chain failure surface.

## A reference you can deploy today

The hook, deploy scripts, calibration tooling, and design docs are at:

→ **[github.com/euler-mab/eulerswap-hook](https://github.com/euler-mab/eulerswap-hook)**

The deploy flow is env-driven end-to-end. Calibration takes a JSON profile and outputs paste-ready env vars; `DeployPool.s.sol` deploys the EulerSwap pool itself; `DeployHook.s.sol` deploys the hook and binds it; `RegisterPools.s.sol` opts you into Euler's orderflow router. The walkthrough at [`docs/build-your-own-propamm.md`](https://github.com/euler-mab/eulerswap-hook/blob/main/docs/build-your-own-propamm.md) covers every step end-to-end, including an anvil dry-run recipe so you can test the whole sequence against a forked mainnet without spending real ETH.

## Be honest about the risks

This is experimental, unaudited reference code:

- **EulerSwap protocol** is [audited](https://github.com/euler-xyz/euler-swap/tree/master/audits) and has processed billions in production. **The hook on top of it is not.** Single-author research code, battle-tested only on the live $500 NAV pool above.
- **Borrow rate volatility** can flip the math: at high vault utilization the carry cost on the directional leg rises and may exceed fee income. Monitor.
- **Spot oracle safety** assumes the invariant "fee is monotonically non-decreasing in oracle delta" — i.e., the hook only ever raises the fee, never lowers it. If you fork the hook, don't add code paths that lower the quoted fee in response to oracle signals.

If you're using this as a template, fork it, read it, get a security review of the hook contract and the exact deploy script you'll run. Don't deploy unmodified code with significant capital.

---

That's the design. The individual primitives — Dutch auctions, spot oracles, asymmetric fees, additive surcharges — aren't new. What's interesting is the integration: one autonomous hook that quotes directionally, deepens via vault credit, and rebalances by selling the arb to the highest bidder. All on-chain, all rule-based, no bot.

For the broader design-space context (Fluid DEX, Yield Basis, Uniswap V3 JIT, where this hook sits), see the [README design-space section](https://github.com/euler-mab/eulerswap-hook#where-this-sits-in-the-design-space). For the full mechanism derivation, [`docs/rebalance-auction-design.md`](https://github.com/euler-mab/eulerswap-hook/blob/main/docs/rebalance-auction-design.md). For the live pool's lifetime numbers, [`docs/case-study-usdc-usdt.md`](https://github.com/euler-mab/eulerswap-hook/blob/main/docs/case-study-usdc-usdt.md).
