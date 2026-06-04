# Build your own active single-LP AMM on EulerSwap

End-to-end walkthrough for launching a credit-backed, single-LP active AMM with the hook in this repo.

This guide assumes you've read the [README](../README.md) and want to actually deploy something. By the end you'll have:

- An Euler sub-account holding your LP equity
- A configured EulerSwap pool with virtual reserves orders of magnitude bigger than your equity
- A [DynamicFeeAuctionHook](../contracts/src/DynamicFeeAuctionHook.sol) instance running autonomous fee modulation + Dutch auctions
- Your pool registered with Euler's orderflow router (with a pointer at the separate [`eulerswap-integrations`](https://github.com/euler-mab/eulerswap-integrations) repo for additional channels: CoW, 1inch Fusion, UniswapX, Tycho)

---

## Mental model first

There are five moving parts. Worth getting them straight before touching code.

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
              │  curve: f(reserve0, reserve1)       │
              │    eq0, eq1, minReserve0/1          │
              │    priceX, priceY, concentrationX/Y │
              │  on swap: deposits in, borrows out  │
              │           (against the sub-account) │
              └──────────────────┬──────────────────┘
                                 │ getFee / afterSwap
                                 ▼
              ┌─────────────────────────────────────┐
              │  DynamicFeeAuctionHook              │
              │  reads Uniswap spot, modulates fee, │
              │  triggers Dutch auctions on         │
              │  rebalance, calls reconfigure() to  │
              │  recenter                           │
              └──────────────────┬──────────────────┘
                                 │ extsload / slot0
                                 ▼
              ┌─────────────────────────────────────┐
              │  Uniswap V3 pool or V4 PoolManager  │
              │  (fee compass only)                 │
              └─────────────────────────────────────┘
```

Key relationships:

- **Reserves are virtual.** A pool with `eq0 = $247M` USDC and only $382 in real deposits is normal — the curve sees the virtual amount, the vault sees the real one. The virtual reserves are an upper bound on what you could be borrowed against.
- **Each swap moves debt.** A swap that takes USDC out of the pool actually *borrows* USDC from your sub-account's borrow vault. The opposite-direction trade repays it. Only one side typically has debt at a time.
- **The hook can call `reconfigure()`.** From inside `afterSwap`, the pool is unlocked. The hook owns rebalancing without an off-chain bot.

---

## Step 0 — Prerequisites

| Tool | Why |
|---|---|
| [Foundry](https://getfoundry.sh/) | Compile and deploy |
| [Node.js 20+](https://nodejs.org/) | Calibration scripts |
| RPC URL (Alchemy / Infura / etc.) | Mainnet reads + broadcasts |
| Funded EOA | ~0.05 ETH for deploys + initial deposits |

```bash
git clone <this-repo> eulerswap-hook
cd eulerswap-hook
git submodule update --init --recursive
cd contracts && forge build && cd ..
```

---

## Step 1 — Pick your pair and gather inputs

Before calibrating anything, write down:

| Input | How to get it | Example (USDC/USDT) |
|---|---|---|
| Token addresses | Etherscan | `0xA0b8...` USDC, `0xdAC1...` USDT |
| Their **EVK supply vaults** | [Euler app](https://app.euler.finance/) → vaults | `0x797D...` USDC, `0x3136...` USDT |
| Their EVK borrow vaults | Same as supply unless you've split them | (often identical to supply) |
| Cross-LTV | Vault governance config (`liquidationLTV`) | 96% (USDC↔USDT) |
| Oracle source | Deepest Uniswap V3 or V4 pool for the pair | V4 PoolManager + pool ID |
| Annualized σ | Historical vol of the pair | 0.05% (stable/stable) |
| Initial equity | How much LP capital you want to commit | $500 |

The calibration is **strictly per-pool**. Never copy parameters from a different pool — see [calibration-guide.md](calibration-guide.md) for why.

---

## Step 2 — Set up an Euler sub-account

Euler accounts are 20-byte addresses where the first 19 bytes are an EOA and the last byte selects sub-account 0–255. Sub-account 0 is the EOA itself; you'll use sub-account 1 for the pool.

```
EOA:           0x2909bCc87c17d8Be263621bF087bC806BA313BFe
Pool account:  0x2909BCc87c17D8be263621bf087Bc806ba313BFf  // last byte XOR 0x01
```

Using a sub-account isolates the pool's risk from your main account.

**Enable collaterals** for the sub-account via the EVC (`enableCollateral`), and **enable the controller** (the borrow vault you'll borrow from). Both are batched into one EVC `batch()` call by [`EnableCollateral.s.sol`](../contracts/script/EnableCollateral.s.sol):

```bash
PRIVATE_KEY=0x... \
EULER_ACCOUNT=0x2909BCc87c17D8be263621bf087Bc806ba313BFf \
COLLATERAL_VAULTS=0xSupplyVaultToken0,0xSupplyVaultToken1 \
CONTROLLER_VAULT=0xBorrowVaultUsedForDebt \
  forge script script/EnableCollateral.s.sol:EnableCollateral \
  --rpc-url $RPC_URL --broadcast --slow -vvvv
```

`CONTROLLER_VAULT` is optional — omit it if you only need collateral enablement. The `PRIVATE_KEY` must control the EOA that owns the sub-account (i.e. shares the upper 19 bytes with `EULER_ACCOUNT`).

---

## Step 3 — Deposit your LP equity

Deposit your starting capital into the supply vaults, credited to the sub-account:

```solidity
IERC20(USDC).approve(supplyVaultUSDC, equityAmount);
IEVault(supplyVaultUSDC).deposit(equityAmount, poolSubAccount);
```

For the live USDC/USDT pool this was $382 USDC + $119 USDT.

You don't need to split symmetrically — the hook's calibration handles asymmetric initial deposits. But starting close to the eventual equilibrium reduces the first recenter's surcharge.

---

## Step 4 — Calibrate hook parameters

This is the heart of the deployment. Each pool's parameters live as a small JSON profile in [`scripts/profiles/`](../scripts/profiles) — there's one already for USDC/WETH and one for USDC/USDT that you can copy as a template. The `PoolProfile` interface at the top of [`calibrate-hook-params.ts`](../scripts/calibrate-hook-params.ts) lists every field, and the script's runtime checks reject profiles that are missing fields, have the wrong type, or carry out-of-range values.

To produce a paste-ready env-var block matching the names that the deploy scripts read, use the `--env` output mode and pipe it into a per-pool dotenv file:

```bash
cd scripts
npx tsx calibrate-hook-params.ts profiles/usdc-weth.json --env > .env.hook
```

`.env.hook` will contain entries like:

```
BASE_FEE=...
MAX_FEE=...
GAS_COEFF=...
EXTERNAL_FEE=...
CAPTURE_RATE=...
ATTRACT_RATE=...
DECAY_PER_BLOCK=...
AUCTION_TRIGGER_THRESHOLD=...
CLEAR_THRESHOLD=...
MAX_SHIFT_MAGNITUDE=...
MIN_AUCTION_BLOCKS=...
RECENTER_RANGE=...
MAX_RECENTER_DRIFT=...
MIN_RECENTER_DELTA=...
SURCHARGE_DECAY_PER_BLOCK=...
SURCHARGE_MULTIPLIER=...
DEPLOY_SURCHARGE=...
```

You'll `source .env.hook` in step 6 before invoking the hook deploy. The pool deploy in step 5 also needs `EQ0`, `EQ1`, `MIN0`, `MIN1`, `PRICE_X`, `PRICE_Y` — these come from your profile's `eq0` / `eq1` plus a separate boost / oracle calculation, not from `--env`. The step 5 invocation below shows where to set them.

Drop the `--env` flag to see the human-readable breakdown of every derivation, or drop the profile path to run all profiles at once.

Read [calibration-guide.md](calibration-guide.md) for the derivation of each parameter. The short version is that you'd never set these by feel — every value is a function of equity, LTV, range, oracle reference fee, and gas.

---

## Step 5 — Deploy the EulerSwap pool via the factory

EulerSwap's factory is already deployed on each chain (see the [`euler-swap` README](https://github.com/euler-xyz/euler-swap) for current addresses, and [addresses.md](addresses.md) for what this repo is currently pinned against). Use [`DeployPool.s.sol`](../contracts/script/DeployPool.s.sol) — a generic env-driven wrapper around `factory.deployPool` that consumes the same env vars `.env.hook` already contains:

```bash
PRIVATE_KEY=0x... \
FACTORY=0xEulerSwapFactory \
EULER_ACCOUNT=0x2909BCc87c17D8be263621bf087Bc806ba313BFf \
SUPPLY_VAULT_0=0xSupplyVaultToken0 SUPPLY_VAULT_1=0xSupplyVaultToken1 \
BORROW_VAULT_0=0xBorrowVaultToken0 BORROW_VAULT_1=0xBorrowVaultToken1 \
EQ0=247596387000000 EQ1=242338099000000 \
MIN0=... MIN1=... \
PRICE_X=... PRICE_Y=... \
  forge script script/DeployPool.s.sol:DeployPool \
  --rpc-url $RPC_URL --broadcast --slow -vvvv
```

The script reads `EQ0`, `EQ1`, `MIN0`, `MIN1`, `PRICE_X`, `PRICE_Y` (uint112 raw token amounts / uint80 prices) from the environment, and optionally `CONCENTRATION_X`, `CONCENTRATION_Y`, `FEE_0`, `FEE_1`, `FEE_RECIPIENT` (all default to zero). It deploys with `swapHook = address(0)` and `swapHookedOperations = 0` — the hook is installed in Step 6.

`EQ0`/`EQ1` come from your profile (`eq0`/`eq1` × token decimals). `MIN0`/`MIN1` are derived from `eq` and `recenterRange` via `min = eq / sqrt(1 + recenterRange)` — see [calibration-guide.md](calibration-guide.md) and the worked computation in [`DeployHookUSDCUSDT.s.sol`](../contracts/script/DeployHookUSDCUSDT.s.sol). `PRICE_X` / `PRICE_Y` come from the oracle at deploy time: read sqrtPriceX96 from the Uniswap V3/V4 pool, convert to WAD, account for token-decimal mismatch.

The call must come from `eulerAccount` (your sub-account), and the sub-account must have already authorized the pool address as an EVC operator — done by [`EnableCollateral.s.sol`](../contracts/script/EnableCollateral.s.sol) in Step 2.

The deploy logs a `POOL=0x...` line at the end. Copy it into your environment for Step 6.

---

## Step 6 — Deploy the hook and bind it to the pool

Use [`DeployHook.s.sol`](../contracts/script/DeployHook.s.sol) — a generic env-driven script that deploys a `DynamicFeeAuctionHook` and installs it on the pool in one broadcast. It consumes the env-var block produced in Step 4 plus a small set of pool/oracle addresses:

```bash
source .env.hook         # the BASE_FEE/.../DEPLOY_SURCHARGE block from Step 4

PRIVATE_KEY=0x... \
POOL=0xPoolFromStep5 \
EULER_ACCOUNT=0x2909BCc87c17D8be263621bf087Bc806ba313BFf \
ORACLE_TARGET=0x000000000004444c5dc75cB358380D2e3dE08A90 \
ORACLE_V4_POOL_ID=0x395f91b34aa34a477ce3bc6505639a821b286a62b1a164fc1887fa3a5ef713a5 \
ORACLE_TOKEN0=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  forge script script/DeployHook.s.sol:DeployHook \
  --rpc-url $RPC_URL --broadcast --slow -vvvv
```

For a Uniswap V3 oracle, set `ORACLE_TARGET` to the V3 pool address and `ORACLE_V4_POOL_ID=0x0` (or omit it). For a V4 oracle, set `ORACLE_TARGET` to the V4 PoolManager and `ORACLE_V4_POOL_ID` to the pool ID. `ORACLE_TOKEN0` is whichever token is token0 inside the oracle pool — it may not match token0 of your EulerSwap pool.

The script does two things atomically:

1. Deploys the hook with the supplied config.
2. Calls `pool.reconfigure(...)` via the EVC to bind `swapHook = address(hook)` and `swapHookedOperations = EULER_SWAP_HOOK_GET_FEE | EULER_SWAP_HOOK_AFTER_SWAP` (`0x06`).

Once the broadcast confirms, the hook is live: every swap now goes through `getFee()` (returning the dynamic fee) and `afterSwap()` (which may start/clear an auction or recenter).

The two existing scripts [`DeployHookUSDCWETH.s.sol`](../contracts/script/DeployHookUSDCWETH.s.sol) and [`DeployHookUSDCUSDT.s.sol`](../contracts/script/DeployHookUSDCUSDT.s.sol) are **author's worked examples** showing the exact parameter values for the live pools. Use them as reference, not as a starting point for your own deploy.

> **Before broadcasting on mainnet:** dry-run this exact command against a forked node first. See the [anvil-fork dry-run section in `scripts/README.md`](../scripts/README.md#dry-run-deploys-against-a-forked-mainnet) — costs nothing, catches misconfigurations.

---

## Step 7 — Verify it's working

Three things to check:

```bash
cast call $POOL "getReserves()(uint112,uint112,uint32)" --rpc-url $RPC_URL
# → returns (reserve0, reserve1, status). status=1 means active.

cast call $POOL "getDynamicParams()((uint112,uint112,uint112,uint112,uint80,uint80,uint64,uint64,uint64,uint64,uint40,uint8,address))" --rpc-url $RPC_URL
# → swapHook should be your hook address, swapHookedOperations = 6

cast call $HOOK "getExposureState()(uint64,bool,uint128)" --rpc-url $RPC_URL
# → (lastExposure, lastNetLongBase, cachedNav). After deploy, exposure=0, NAV ≈ your equity.
```

And do a tiny test swap (e.g. $1) through Euler's swap UI ([app.euler.finance](https://app.euler.finance)), or via the [`EulerSwapPeriphery`](../contracts/eulerswap/src/EulerSwapPeriphery.sol) contract:

```bash
# Send a tiny amount of asset0 to the pool, then call pool.swap to receive asset1.
# See contracts/eulerswap/test/Basic.t.sol for the exact call pattern, or use
# Euler's app UI which builds the call for you.
```

---

## Step 8 — Get retail flow

An active-LP pool with no flow is just an arb magnet. Plug into the orderflow layer:

### Euler's own orderflow router (easiest)

[`RegisterPools.s.sol`](../contracts/script/RegisterPools.s.sol) is env-driven — pass comma-separated `POOLS` and `EULER_ACCOUNTS` lists of equal length, plus an optional `BOND_WEI` (defaults to 0.001 ether). If env vars are omitted, the script falls back to the author's mainnet defaults (the live USDC/WETH and USDC/USDT pools).

```bash
PRIVATE_KEY=0x... \
POOLS=0xYourPool1,0xYourPool2 \
EULER_ACCOUNTS=0xAccountForPool1,0xAccountForPool2 \
BOND_WEI=1000000000000000 \
  forge script script/RegisterPools.s.sol:RegisterPools \
  --rpc-url $RPC_URL --broadcast -vvvv
```

### Other channels

UniswapX, CoW Protocol, 1inch Fusion, and Tycho integrations are pool-level (any EulerSwap pool, any hook) and live in the separate [`eulerswap-integrations`](https://github.com/euler-mab/eulerswap-integrations) repo. That repo has filler/resolver contracts, off-chain bots, and the per-channel onboarding guides.

---

## Step 9 — Monitor and tune

After deploy, watch:

- **Exposure**: how often does relative exposure hit the auction trigger?
- **Auction clear time**: are auctions clearing in seconds or stuck for blocks?
- **Fee capture**: is `captureRate` actually recapturing the arb, or is too much leaking to MEV?
- **Borrow carry vs fees**: are you net-earning, or paying the vault more than you collect?

Helpful scripts:

```bash
# Lifetime PnL + per-block oracle pricing for any deployed hook
RPC_URL=https://... \
POOL_ADDRESS=0xYourPool \
  npx tsx scripts/analyze-hook.ts

# 5-way PnL decomposition (fees, swap rebal, ext rebal, interest, mark-to-market)
RPC_URL=https://... \
POOL_ADDRESS=0xYourPool \
  npx tsx scripts/verify-pnl.ts
```

`analyze-hook.ts` and `verify-pnl.ts` default to the live USDC/WETH pool — override the pool/oracle env vars to point at your own. See [scripts/README.md](../scripts/README.md) for the full env-var list.

All parameters except oracle target are owner-updatable — re-tune as your understanding of the pair's flow improves.

---

## Common pitfalls

| Problem | Cause | Fix |
|---|---|---|
| Pool deploys but never quotes | Hook isn't bound, or `swapHookedOperations != 0x06` | Reconfigure with `GET_FEE \| AFTER_SWAP` |
| `getFee` reverts | Oracle pool ID wrong, or `token0` doesn't match | Re-verify oracle config |
| Every swap reverts with health failure | Range too tight for cross-LTV — `h < 1` at boundary | Widen `recenterRange` or use higher-LTV vault |
| Auction starts but never clears | `clearThreshold > maxShiftMagnitude` | Set `clearThreshold < maxShiftMagnitude` (calibrator enforces this) |
| Fees collected ≪ borrow carry | Pair too quiet, or fee too low for vol | Widen `baseFee`, or pick a higher-volume pair |
| Mis-priced deploy gets arbed instantly | Initial `priceY` wrong, deploy surcharge too low | Read oracle in deploy script; raise `deploySurcharge` |

---

## Where to go next

- [docs/auction-walkthrough.md](auction-walkthrough.md) — step-by-step trace of one auction cycle
- [docs/calibration-guide.md](calibration-guide.md) — derivation of every parameter
- [docs/dynamic-fee-model.md](dynamic-fee-model.md) — full fee formula spec
- [docs/parameter-strategy-guide.md](parameter-strategy-guide.md) — tuning guidance for different pair archetypes
- [contracts/test/walkthrough/](../contracts/test/walkthrough/) — executable walkthrough tests
- [contracts/src/DynamicFeeAuctionHook.sol](../contracts/src/DynamicFeeAuctionHook.sol) — the hook itself, top-to-bottom

If something is unclear, the [live pool's source of truth](https://etherscan.io/address/0x99b97FD05b4F943899358F90855C0BEE34584e41) is on chain — it's running this exact code with these exact parameters.
