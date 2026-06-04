# FAQ

Common confusion points for newcomers to this repo. If you're getting started, read the [README](../README.md) and [case-study-usdc-usdt.md](case-study-usdc-usdt.md) first — many answers reference them.

---

## How do I compute a sub-account address from my EOA?

Each EVC account is your EOA with its **last byte XOR'd** with the sub-account number (0–255, hex `0x00`–`0xFF`). The EOA itself is sub-account `0x00`. For example, the deployer EOA `0x2909bCc87c17d8Be263621bF087bC806BA313BFE` (last byte `0xBE`) becomes `0x2909BCc87c17D8be263621bf087Bc806ba313BFf` for sub-account `0x01` (`0xBE ^ 0x01 = 0xBF`), and `0x2909bCc87c17d8Be263621bF087bC806BA313B41` for sub-account `0xFF` (`0xBE ^ 0xFF = 0x41`). The EVC treats each as a separate logical account — they share the same owner, but vault positions, collateral, and debt are isolated per sub-account. See [addresses.md](addresses.md) for the live pool's accounts and [the EVC docs](https://evc.wtf) for the full account model.

## Why use a sub-account vs the main EOA?

**Isolation.** An active-LP pool borrows aggressively against its own collateral — if its parameters are mistuned or the market gaps badly, liquidation risk on that sub-account should not touch the rest of your Euler activity (savings vaults, other pools, leveraged positions). Putting the pool on its own sub-account walls off that risk. It also makes accounting much cleaner: NAV, debt, and PnL for the pool are exactly what's in that one sub-account. The deploy scripts in [contracts/script/](../contracts/script) all assume the pool lives on a dedicated sub-account.

## How much equity do I need to start?

There's no protocol-enforced minimum — virtual reserves scale linearly with equity, so a $50 pool quotes the same shape as a $50M pool, just with proportionally shallower depth. In practice, **~$500** is enough for a proof-of-concept (this is what the [live USDC/USDT pool](case-study-usdc-usdt.md) runs on), and you'll start seeing meaningful daily fee income around **$5k–$10k+** of NAV depending on the pair's flow. Gas costs for deploy and reconfigure are fixed, so below ~$500 they start to dominate. See [case-study-usdc-usdt.md](case-study-usdc-usdt.md) for the live numbers at the low end.

## What if my pair doesn't have a deep Uniswap V3 pool?

You have three options. **(1)** If the pair has a Uniswap **V4** pool, read its `slot0` via `extsload` on the V4 PoolManager — this is the pattern used for USDC/USDT (no liquid V3 pool exists, but V4 has one). See [uniswap-fee-compass.md](uniswap-fee-compass.md) and [DeployHookUSDCUSDT.s.sol](../contracts/script/DeployHookUSDCUSDT.s.sol) for a worked example. **(2)** Use a different oracle source by writing a small adapter (Chainlink, Pyth, TWAP from a less-liquid pool) and matching the `IOracle` shape the hook expects. **(3)** Operate **without** an oracle entirely via `MinimalHook` — you lose the dynamic-fee modulation and autonomous rebalancing, and you'll need an off-chain bot for recenters, but the underlying EulerSwap curve still works.

## How do I use the V4 oracle instead of V3?

Set the `v4PoolId` field in `OracleConfig` to a non-zero pool ID — the hook detects this and switches to the V4 extsload path automatically (V3 `slot0()` calls are skipped). See [DeployHookUSDCUSDT.s.sol](../contracts/script/DeployHookUSDCUSDT.s.sol) for the full call: pool manager `0x000000000004444c5dc75cB358380D2e3dE08A90`, pool ID `0x395f91b34aa34a477ce3bc6505639a821b286a62b1a164fc1887fa3a5ef713a5`. Read [uniswap-fee-compass.md](uniswap-fee-compass.md) for the rationale and the slot-derivation math. Token ordering inside the V4 pool may differ from your EulerSwap pool — handle the inversion in the deploy script, not inside the hook.

## Can I run multiple pools from the same EOA?

Yes — and you should put each one on its own sub-account for the isolation reasons above. The EVC allows up to 256 sub-accounts per EOA (`0x00`–`0xFF`), so a single owner can run dozens of pools. Each sub-account needs to be enabled as a collateral and have its own EulerSwap pool deployed with that sub-account as `eulerAccount` in the static params. The [RegisterPools.s.sol](../contracts/script/RegisterPools.s.sol) script demonstrates registering multiple pools from a single deployer.

## What happens if the Uniswap oracle pool gets paused?

The hook wraps the oracle read in `try/catch` and falls back to `baseFee` (no oracle-driven adjustment) — **no swap is blocked**. You lose the dynamic-fee component until oracle reads recover, which means arbs against the pool aren't captured and you may quote slightly worse than competitors, but the pool keeps quoting and retail flow keeps going through. Same fallback applies to malformed slot data or any other revert in the oracle call. See the `_getOraclePrice` implementation in [DynamicFeeAuctionHook.sol](../contracts/src/DynamicFeeAuctionHook.sol).

## Do I need to run an off-chain bot?

**No** — `DynamicFeeAuctionHook` is autonomous. Recenters fire from inside `afterSwap` when exposure or surcharge conditions are met, and fee dynamics are computed on-chain per swap. The owner can still call `setFeeParams`, `setAuctionParams`, etc. to retune for slow-timescale changes (volatility regime shifts, fee competition, NAV growth requiring recalibration via [scripts/calibrate-hook-params.ts](../scripts/calibrate-hook-params.ts)), but those are optional and operator-paced, not part of the core loop. The `MinimalHook` variant **does** need a bot for rebalancing — pick the right hook for your operating model.

## What if my initial deploy parameters are wrong?

The constructor sets a **deploy surcharge** — an additive fee on top of baseFee that decays to zero over a configurable horizon (~hours). This gives you a window to inspect the live pool, recenter if the initial eq price was off, or update params without an arb extracting the mispricing immediately. The [live USDC/USDT case study](case-study-usdc-usdt.md) walks through exactly this: an initial deploy with slightly stale eq was protected by the surcharge until the operator could reconfigure. If you realise the issue *after* the surcharge has decayed, you can still recenter — you'll just eat one cycle of arb cost from whoever notices first.

## Is this audited?

**The EulerSwap protocol itself is audited** ([audit reports here](https://github.com/euler-xyz/euler-swap/tree/master/audits)). **This hook is not.** It's a personal-research reference implementation, battle-tested in production by its author only on a single ~$500 NAV pool. See the [substrate-vs-hook framing in the README](../README.md#about-the-substrate) — do not deploy unmodified code with significant capital without an independent security review of the hook contract and the exact deploy script you'll run.

## How do I find which Euler vault corresponds to my asset?

Look it up on [app.euler.finance](https://app.euler.finance) — pick a cluster and the supply/borrow vault addresses are shown for each asset. Alternatively, query the EVK factory directly with `cast` (the factory exposes `getProxyListSlice` and similar enumeration methods), or grep the Euler interfaces in [contracts/euler-interfaces/](../contracts/euler-interfaces). For the live pools, vault addresses are recorded in the relevant deploy script under `contracts/script/`. Vaults are not 1:1 with assets — there are multiple clusters with different risk parameters, so make sure you're picking vaults whose LTVs match your calibration assumptions ([calibration-guide.md](calibration-guide.md)).
