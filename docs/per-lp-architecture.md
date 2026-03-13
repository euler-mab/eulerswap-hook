# Why EulerSwap Uses a Per-LP Architecture

## The two models

DeFi AMMs that manage leveraged LP positions fall into two broad architectures:

**Pooled vaults**: Many depositors share one position. The protocol chooses the strategy — leverage ratio, curve shape, fee policy, rebalancing rules. Depositors get a receipt token (e.g. ybBTC) and trust the protocol to manage everything. Examples: Yield Basis, Tokemak, yield aggregators.

**Per-LP pools**: Each LP deploys their own pool with their own parameters. The LP chooses their leverage, range, fee strategy, and hook logic. Their PnL is theirs alone. Examples: EulerSwap, Uniswap V3 positions (partially — no leverage), proprietary market makers.

EulerSwap is a per-LP architecture. This is a deliberate choice with clear tradeoffs.

## What the per-LP model gives up

**No easy bootstrapping via token emissions.** A pooled vault can offer "deposit BTC, stake for rewards" — depositors don't need to understand the strategy. Per-LP pools require each LP to understand their configuration. You can't spray emissions at a receipt token to attract passive capital.

**No gas amortization across depositors.** In a pooled model, one rebalancing transaction serves all depositors. In per-LP, each pool pays its own gas for hook execution, recentering, and auction clearing. At current L1 gas costs this is material for small pools.

**Higher UX bar.** "Deposit and forget" is a better product for most users than "configure equilibrium reserves, concentration, range, hook parameters, and leverage ratio." The pooled model is a product; the per-LP model is infrastructure.

## What the per-LP model gains

### Strategy diversity

A pooled vault commits everyone to one strategy. If the protocol chooses 2x leverage with xy=k and 70 bps releverage fees, every depositor shares that bet. If the strategy underperforms in certain market conditions, everyone loses together.

Per-LP pools allow strategy diversity:
- Conservative LPs can run low leverage with wide ranges
- Aggressive LPs can run high leverage with tight ranges and dynamic fees
- Different asset pairs can use different hook configurations
- New strategies can be deployed without governance votes or protocol upgrades

The protocol doesn't need to be right about the optimal strategy for everyone. It only needs to provide good enough infrastructure that some LPs find profitable configurations.

### Contained blast radius

In a pooled model, a bug in the share accounting or a bad strategy decision affects all depositors simultaneously. The Yield Basis Statemind audit found 5 critical bugs in the share accounting (token_reduction formula, interest nullification, admin fee mismatch, precision errors, unbounded share minting) — all of which would have affected every depositor. These bugs existed specifically because multi-depositor accounting for leveraged positions is inherently complex.

In per-LP, a bad configuration or a hook bug affects one pool. Other LPs are unaffected. The failure mode is a single LP losing money on their own pool, not a protocol-wide event.

### No share price accounting

Pooled vaults need machinery to handle:
- Share price calculation under leverage (virtual reserves vs real deposits)
- Loss socialization across staked/unstaked depositors
- High watermark tracking and recovery mode (waiving fees until losses are recovered)
- Token reduction (burning shares to keep staker value constant during positive yield)
- Admin fee splits that interact with all of the above

Each of these is a source of bugs. Per-LP pools have none of this — the LP's equity is their vault deposits minus their vault debts, computed by Euler's existing vault infrastructure. No custom share math required.

### Permissionless innovation

Anyone can write a new hook contract and deploy a pool that uses it. The hook interface is small (beforeSwap, getFee, afterSwap) and the pool's reconfigure() function is callable from the hook during afterSwap. This means:

- Fee strategies can evolve without protocol changes
- Recentering logic can be customized per pool
- New ideas (auction mechanisms, oracle integrations, MEV capture) can be tested in production with real capital on a single pool before wider adoption
- Failed experiments don't affect other pools

In a pooled model, strategy changes require governance, affect all depositors, and can't easily be A/B tested.

### Capital efficiency at the individual level

Each LP controls their own leverage ratio via Euler vault LTVs. A sophisticated LP can run very high leverage on a tight range because they understand the liquidation risk. A conservative LP can run lower leverage with a wider range. The protocol doesn't need to pick one leverage ratio that's safe enough for the least sophisticated depositor.

## When to use a pooled model instead

The per-LP model is worse when:

- **The target user is passive.** If users want "deposit BTC, earn yield," a pooled vault with a receipt token is the right product. Not everyone wants to configure pool parameters.
- **Scale matters for profitability.** If the strategy only works at $100M+ TVL (e.g. because it needs deep liquidity to attract volume), pooling capital is necessary. An individual LP may not have enough capital alone.
- **Gas costs dominate.** If rebalancing is frequent and expensive, amortizing across depositors is significant. At $50k pool depth, paying $5 per recenter is 1 bps per event — it adds up.
- **Token distribution is a goal.** Pooled vaults can bootstrap network effects via emissions. Receipt tokens are composable (stake ybBTC in gauges, use as collateral elsewhere). Per-LP positions are less composable.

## EulerSwap's position

EulerSwap sits at the infrastructure layer. It provides the pool contracts, the hook interface, and the integration with Euler's lending vaults. It does not take an opinionated stance on what strategy LPs should run.

This means EulerSwap can support multiple strategy types simultaneously:
- Static fee pools (no hooks, simple xy=k-like behavior)
- Oracle-reactive fee pools (dynamic fees based on price mismatch)
- Autonomous recentering pools (continuous exposure management)
- Auction-based clearing pools (fee-decay auctions for equity rebalancing)
- Any combination via composable hooks

The cost is that EulerSwap needs sophisticated LPs or LP agents — not passive depositors. Over time, the gap can be closed by building vault-like wrappers on top (a pooled product that deploys into EulerSwap pools), but the base layer is per-LP by design.

This is the same architectural pattern as "exchange vs fund": an exchange provides the venue and doesn't take positions; a fund pools capital and runs a strategy. EulerSwap is the exchange. Someone else can build the fund on top.
