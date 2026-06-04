# Architecture

How the pieces fit together when you run an active single-LP AMM on EulerSwap.

## The five components

```
            ┌─────────────────────────────────────┐
            │  Euler sub-account (your LP equity) │
            │  collateral in supplyVaults         │
            │  debt in borrowVaults               │
            └──────────────────┬──────────────────┘
                               │ collateral / debt
                               ▼
            ┌─────────────────────────────────────┐
            │  EulerSwap pool                     │
            │  constant-function curve interpola- │
            │  ting V2 ↔ V3 ↔ Curve via the       │
            │  concentration parameter            │
            │  on swap: deposits in / borrows out │
            └──────────────────┬──────────────────┘
                               │ getFee / afterSwap
                               ▼
            ┌─────────────────────────────────────┐
            │  DynamicFeeAuctionHook              │
            │  reads spot, sets fee, runs         │
            │  auctions, calls reconfigure()      │
            │  from afterSwap to recenter         │
            └────┬───────────────────────┬────────┘
                 │ extsload / slot0      │ reconfigure
                 ▼                       ▼
            ┌──────────────┐  ┌─────────────────┐
            │ Uniswap V3   │  │ EulerSwap pool  │
            │ pool or V4   │  │ (same pool —    │
            │ PoolManager  │  │ writes back)    │
            │ (fee compass)│  │                 │
            └──────────────┘  └─────────────────┘

            ┌─────────────────────────────────────┐
            │  Aggregators / routers / intent     │
            │  systems — bring retail flow to     │
            │  the pool                           │
            └─────────────────────────────────────┘
```

## Why each piece exists

### 1. Euler sub-account

Holds your LP equity as collateral, takes on debt as the pool swaps. Lives inside Euler's [EVC](https://github.com/euler-xyz/ethereum-vault-connector) (Ethereum Vault Connector), which lets one account span multiple vaults and lets approved operators act on its behalf.

The pool itself is one of those operators — `pool.swap()` triggers EVC-authorized debits and credits against your sub-account.

Using a sub-account (last byte XOR'd from your EOA) isolates pool risk from the rest of your Euler activity.

### 2. EulerSwap pool

A constant-function AMM with a **single LP** (your sub-account). Curve parameters:

| Param | Role |
|---|---|
| `equilibriumReserve0/1` | Virtual reserves at equilibrium price — sets pool depth |
| `minReserve0/1` | Lower bound on virtual reserves (sets range boundary) |
| `priceX, priceY` | The reference price the curve is centered around |
| `concentrationX/Y` | 0 = constant-product, 1 = constant-sum, intermediate values interpolate |

Concentration set to 0 with a wide range gives Uniswap-V2-style behavior; high concentration with a narrow range gives Curve/V3-style behavior. Same contract, same swap path.

Pool storage is locked during `swap()` to prevent reentrancy, then **unlocked during the `afterSwap` hook callback**. That's the window where the hook can call `reconfigure()` and recenter the pool.

### 3. The hook (DynamicFeeAuctionHook)

Implements `IEulerSwapHookTarget` — three optional callbacks:

| Callback | Flag | When called | What the hook does |
|---|---|---|---|
| `beforeSwap` | `0x01` | Before the curve math | Not used |
| `getFee` | `0x02` | When quoting the swap fee | Reads Uniswap spot, returns dynamic fee |
| `afterSwap` | `0x04` | After the swap settles, pool unlocked | Updates exposure, runs auction state machine, recenters |

The pool's `swapHookedOperations` byte selects which subset is active. The hook uses `0x06` (`GET_FEE | AFTER_SWAP`).

The hook's state machine has **two modes** for the autonomous fee/rebalance loop:

- **Normal**: oracle-reactive fee (capture arbs / attract retail) plus a decaying surcharge from the last recenter.
- **Auction**: when relative exposure exceeds a threshold, shift the equilibrium price to create a profitable arb, decay the fee block-by-block until the arb is taken, then recenter and exit the auction.

Layered on top, an **optional builder-fee mechanism** lets any party call `setBuilderFee(fee)` to raise the quoted fee above the public floor for the current block, with a configurable share of the bumped delta accrued to the bumper. `getFee` returns `max(publicFee, builderFee)` so the floor is preserved. Disabled by default (`builderFeeShareBps = 0`); not enabled on the deployed example pool. Full design: [docs/builder-fee-design.md](docs/builder-fee-design.md).

State the hook tracks across swaps (all read/written from within `afterSwap`):
- `lastExposure`, `baseNetAsset1`, `cachedNav` — for exposure measurement vs NAV
- `surchargeStartBlock`, `surchargeInitialAmount` — for the recenter surcharge
- `auctionActive`, `auctionStartBlock`, `auctionStartingFee`, `auctionClearAsset0`, `preShiftPriceY` — for the auction state machine
- `builderFeeSlot`, `builderFeeShareBps`, `builderShareAccrued` — for the optional builder-fee mechanism

### 4. The fee compass (Uniswap V3 or V4)

The hook reads the **current spot price** from the deepest Uniswap pool for the pair:

- **V3**: a `staticcall` to `slot0()` returns `(sqrtPriceX96, tick, ...)`. The hook converts `sqrtPriceX96² >> 192` to a WAD price.
- **V4**: PoolManager exposes `extsload(slot)` — the hook computes `keccak256(poolId, slot 6)` and reads the same `sqrtPriceX96` directly.

Spot is unsafe as a price oracle in general (single-block manipulation is cheap) but **safe for fee bumping**:

- The hook never returns a fee below `baseFee`.
- An attacker who manipulates spot to inflate the AMM's quoted fee pays that fee themselves on the same swap.

If the oracle call reverts (paused pool, removed PoolManager state, anything), the hook falls back to `baseFee` — no swap is blocked by oracle failure.

### 5. Orderflow

An active-LP pool with no order flow is just an arb magnet. Register your pool with Euler's orderflow router (one tx via [`RegisterPools.s.sol`](contracts/script/RegisterPools.s.sol)) and every aggregator that integrates with Euler will see it. Additional channels — UniswapX, CoW Protocol, 1inch Fusion, Tycho — are generic EulerSwap-level integrations and live in [`eulerswap-integrations`](https://github.com/euler-mab/eulerswap-integrations).

## A swap, end to end

For concreteness, here's what happens when a swap from `asset0` for `asset1` lands on your pool (whether it comes from an aggregator, an intent filler, a direct user, or an arb):

1. **Pool entry.** EulerSwap's `swap()` locks the pool, then calls `hook.getFee(...)`.
2. **Hook reads oracle.** `getFee` reads the Uniswap reference pool — V3 `slot0` or V4 PoolManager `extsload` — decodes `sqrtPriceX96`, and computes whether the AMM is offering an arb. Returns either the attract fee or the capture fee, plus any active surcharge or auction-decayed fee.
3. **Swap settles.** EulerSwap applies the fee, computes the output, withdraws `asset1` from the supply vault into the pool, and credits the recipient. If the pool needed to borrow `asset1` to source the output, it borrows from the borrow vault — your sub-account takes on the debt.
4. **`afterSwap` runs.** The pool unlocks itself for hooks and calls `hook.afterSwap(...)`. The hook:
   - Recomputes NAV and net base-asset position from the new reserves and the swap delta.
   - If relative exposure has *decreased* beyond `minRecenterDelta`, calls `pool.reconfigure()` to recenter: new `priceY`, `eq = current reserves`, fresh curvature surcharge.
   - If relative exposure has *increased* past `auctionTriggerThreshold` and no auction is active, starts one: shifts `priceY` to expose an arb, marks `auctionActive = true`.
   - If an auction is active and the current marginal price has converged to the oracle within `clearThreshold` (and `minAuctionBlocks` have passed), recenters and clears the auction.
5. **`swap()` returns.** Caller gets their output, your pool sub-account has a slightly different reserve mix and possibly some new debt.

Every step in (2)–(4) is the hook running on-chain, no off-chain bot.

## What's *not* in this picture

A few things people ask about:

- **No LP token.** Liquidity isn't shared — there's no ERC20 representing pool shares. The single LP is your Euler sub-account.
- **No rewards program.** There's no emissions logic anywhere in the pool or hook. Fees go straight to the LP via the vault balance growth.
- **No off-chain bot is required.** `DynamicFeeAuctionHook` is fully autonomous. You *can* run a bot for parameter retuning, but the core loop (fees, recenters, auctions) runs purely in `afterSwap`.
- **The fee compass is not a price oracle for collateral.** Vault collateral pricing uses Euler's [price-oracle](contracts/euler-price-oracle/) system. The Uniswap spot read is *only* for fee modulation — it tells the hook which direction to charge more, never how to value anything.

## Operational considerations

### Stuck-auction recovery

If `pool.reconfigure()` reverts during a clearing attempt (e.g. transient EVC unhealth, oracle returning zero), the hook keeps `auctionActive = true` so the next swap retries the clear. In practice the live pool has self-healed on every stuck auction observed. But there's a worst case: a configuration that *keeps* failing `reconfigure()`. The escape hatch is `endAuction()` — which is `onlyOwner`. **If the owner key is unavailable, an auction that can't self-clear has no permissionless recovery path.** Plan accordingly: keep the owner key recoverable, or accept the operator-trust dependency.

### `builderFee` griefing (when enabled)

The optional `setBuilderFee` mechanism is permissionless. A griefer can call `setBuilderFee(maxFee)` every block to keep the quoted fee at max, blocking swaps regardless of whether `builderFeeShareBps` is zero. The defensive properties of the design still hold — the floor is preserved, the griefer earns no share, the LP doesn't lose funds — but the *liveness* property weakens: swaps may be priced out of routing during the attack. Two mitigations the operator can use: (1) keep `builderFeeShareBps = 0` so there's no incentive for anyone to bump in the first place (the default and current live setting), or (2) if you ever enable share, monitor for griefing patterns and disable via `setBuilderFeeShareBps(0)` if needed (instant — no timelock). The hook can't be configured to make the mechanism mandatory.

### Reentrancy surface

EulerSwap's `swap()` holds the pool's internal lock during the swap and releases it across the `afterSwap` callback specifically so the hook can call back into `reconfigure()`. The pool's own `nonReentrant` protects against same-tx re-entry into `swap()`. The hook adds a separate `nonReentrantBuilderFee` guard on `withdrawBuilderShare()` and `batchSettleBuilderShare()` for the ERC-20 callback case (e.g., ERC-777 receive hooks). The fee compass read is a `staticcall` so it cannot mutate state. There is no known reentrancy path across these layers; if you find one, please open an issue.

## Where to read more

See the **Documentation map** in [README.md](README.md) — every doc, one-line description, organized by what you're trying to do. The two source files most worth reading top-to-bottom are [`DynamicFeeAuctionHook.sol`](contracts/src/DynamicFeeAuctionHook.sol) (the hook) and [`MinimalHook.sol`](contracts/src/MinimalHook.sol) (the ~50-line starter you can fork).
