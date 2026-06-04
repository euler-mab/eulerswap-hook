# AGENTS.md

Coding-agent quickstart for this repo. Humans should start at [README.md](README.md).

## What this repo is

A single Solidity hook contract for [EulerSwap](https://github.com/euler-xyz/euler-swap) (`DynamicFeeAuctionHook`), plus calibration tooling and deploy scripts. The hook does dynamic fee modulation against a Uniswap-spot oracle, Dutch fee-decay auctions for rebalancing, and autonomous recentering — all on-chain. Single-LP design: one Euler account owns the position; the hook reads a public price reference and runs the whole loop inside `getFee` / `afterSwap`. No off-chain quoter, no private orderflow. See [ARCHITECTURE.md](ARCHITECTURE.md) for the mental model.

## First-time setup

```bash
git submodule update --init --recursive    # pulls 7 Euler submodules
cd contracts && forge build                 # compiles ~167 files
cd ../scripts && npm install                # viem + tsx for the TS scripts
```

## Build, test, lint

```bash
# Solidity build
cd contracts && forge build

# Unit tests (no RPC required) — 135 tests, 10 suites
forge test --no-match-path "test/*.fork.t.sol"

# Fork tests (mainnet fork, RPC required)
RPC_URL=https://... forge test --match-path "test/*.fork.t.sol"

# Single test contract
forge test --match-contract DynamicFeeAuctionHookTest -vv

# Calibration (no RPC required)
cd scripts && npx tsx calibrate-hook-params.ts profiles/usdc-weth.json
npx tsx calibrate-hook-params.ts profiles/usdc-weth.json --env  # paste-ready env block

# On-chain analysis (RPC required)
RPC_URL=... POOL_ADDRESS=0x... npx tsx scripts/analyze-hook.ts
```

## Repo layout (essentials)

| Path | What lives here |
|---|---|
| `contracts/src/DynamicFeeAuctionHook.sol` | The production hook (~1000 lines, single contract) |
| `contracts/src/MinimalHook.sol` | 50-line pedagogical starter — fork from here |
| `contracts/test/DynamicFeeAuctionHook.t.sol` | 45 unit tests (mocked V3 oracle) |
| `contracts/test/DynamicFeeAuctionHook.fork.t.sol` | 14 fork tests against the mainnet pool |
| `contracts/test/walkthrough/` | Step-by-step auction walkthrough tests |
| `contracts/script/DeployHook.s.sol` | Generic env-driven hook deploy + install |
| `contracts/script/DeployPool.s.sol` | Env-driven EulerSwap factory deploy |
| `contracts/script/EnableCollateral.s.sol` | EVC sub-account setup helper |
| `scripts/calibrate-hook-params.ts` | Param calibration with `--env` output mode |
| `scripts/profiles/` | Per-pool JSON profiles (add new ones here) |
| `docs/build-your-own-active-lp.md` | Full deploy walkthrough (operating manual) |
| `docs/rebalance-auction-design.md` | Long design rationale (~1560 lines, historical) |

## Conventions

- **Single-LP per pool.** Each EulerSwap pool has exactly one LP (the `eulerAccount`). The hook is single-LP only — no LP tokens, no shared liquidity.
- **Env-driven scripts.** Deploy and calibration scripts read env vars; calibration `--env` mode emits paste-ready blocks. Don't hardcode addresses in new scripts; mirror the pattern in `DeployHook.s.sol` / `DeployMinimalHook.s.sol`.
- **`.fork.t.sol` for RPC-dependent tests.** Any test that needs an RPC must be `*.fork.t.sol` so `--no-match-path "test/*.fork.t.sol"` cleanly skips them in unit runs.
- **Submodule remappings.** `contracts/eulerswap` is the top-level submodule and brings forge-std, openzeppelin, EVC, EVK via its own `lib/`. Don't add direct deps — extend remappings in `contracts/foundry.toml`.
- **Author-example deploys.** `DeployHookUSDCWETH.s.sol` and `DeployHookUSDCUSDT.s.sol` hardcode the author's pool addresses on purpose — they're worked examples. For new pools, use the generic `DeployHook.s.sol`.

## Invariants — do not break

- **`clearThreshold < maxShiftMagnitude`.** Enforced in the hook; calibration script enforces it too. Breaking this means auctions never clear and the hook bricks rebalancing.
- **Fee response is monotone in oracle delta.** The hook only ever *raises* the fee above `baseFee`, never lowers it. This is what makes the Uniswap-spot fee oracle safe under manipulation — see [docs/uniswap-oracle-pattern.md](docs/uniswap-oracle-pattern.md). Don't add code paths that lower the quoted fee.
- **Oracle mode select.** `OracleConfig.v4PoolId == bytes32(0)` selects V3 mode (slot0); any non-zero value selects V4 mode (extsload). Don't add a third "auto-detect" path.
- **Sub-account auth.** `DeployPool.s.sol` wraps `factory.deployPool` in `evc.call(factory, eulerAccount, ...)` because the factory's `_msgSender()` resolves through EVCUtil. Don't bypass — it'll revert with `Unauthorized()` for any pool whose `eulerAccount` isn't the broadcasting EOA.

## Common tasks

- **Add a pool profile**: drop a JSON file in `scripts/profiles/`. Required fields are the `PoolProfile` interface at the top of `scripts/calibrate-hook-params.ts`. Runtime validation rejects malformed profiles with a clear error.
- **Deploy on a new pair**: see [docs/build-your-own-active-lp.md](docs/build-your-own-active-lp.md). Order: EnableCollateral → deposit equity → calibrate → DeployPool → DeployHook → RegisterPools.
- **Bind hook to an existing pool**: `forge script script/DeployHook.s.sol` with all 22 env vars. Use `npx tsx calibrate-hook-params.ts <profile> --env > .env.hook && source .env.hook` to populate them.
- **Anvil dry-run**: see "Dry-run deploys against a forked mainnet" in [scripts/README.md](scripts/README.md). Anvil pre-funds the well-known test key; iterate against real mainnet state without spending real ETH.

## What's *not* in this repo (and where it is)

| Looking for | It lives in |
|---|---|
| `UniswapXFiller.sol`, `OneInchFusionResolver.sol`, `Arbitrageur.sol`, off-chain filler/resolver bots | [`euler-mab/eulerswap-integrations`](https://github.com/euler-mab/eulerswap-integrations) |
| EulerSwap protocol, EVC, EVK source | [`euler-xyz/euler-swap`](https://github.com/euler-xyz/euler-swap) (brought in via `contracts/eulerswap/lib/`) |
| Older hook versions (V1–V8 lineage), Next.js UI, off-chain agent loop | Deleted before the public release. Reachable via earlier git history if you need them. |

## Where to read more, in order

1. [README.md](README.md) — design-space framing + live pool numbers + experimental/unaudited disclaimer
2. [ARCHITECTURE.md](ARCHITECTURE.md) — five-component diagram + end-to-end swap walkthrough
3. [docs/build-your-own-active-lp.md](docs/build-your-own-active-lp.md) — operating procedure
4. [docs/faq.md](docs/faq.md) — common newcomer questions
5. [contracts/src/DynamicFeeAuctionHook.sol](contracts/src/DynamicFeeAuctionHook.sol) — the hook source, top-to-bottom
6. [docs/rebalance-auction-design.md](docs/rebalance-auction-design.md) — long-form design rationale (historical doc with a note at the top)

## Pitfalls

- **`forge build` errors with "stack too deep" on `DeployHookUSDCUSDT.s.sol`**: should be fixed (struct + helper refactor). If it returns, the deploy script still builds under `--via-ir`.
- **Fork tests fail without `RPC_URL`**: expected. Use `--no-match-path "test/*.fork.t.sol"` for unit-only runs.
- **`npx tsx` not found**: run `npm install` in `scripts/` first.
- **`DeployPool` reverts with `Unauthorized()`**: the factory requires `_msgSender() == eulerAccount`. The script wraps in `evc.call` so sub-account deploys work. Don't bypass.
- **Calibration `--env` output missing `EQ0`/`EQ1`/`MIN0`/`MIN1`/`PRICE_X`/`PRICE_Y`**: by design — these are deploy-time inputs (boost math + oracle read), not calibration outputs. The walkthrough Step 5 shows where to supply them.
