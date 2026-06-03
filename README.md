# DynamicFeeAuctionHook for EulerSwap

A reference hook for running a **propAMM-style strategy** on [EulerSwap](https://github.com/euler-xyz/euler-swap) — a single Euler account becomes its own AMM, borrows against its own collateral for just-in-time depth, and quotes dynamic fees against a Uniswap-spot oracle. The hook handles fee modulation, Dutch fee-decay auctions for rebalancing, and autonomous recentering. All on-chain. No off-chain bot for the core loop.

It is **not** a TradFi-style prop venue (no private fair-value model, no per-quote pricing). It's the on-chain rule-based version of that idea, sitting alongside Fluid DEX, Egorov's Yield Basis, and Uniswap V3 JIT — see [Where this sits in the design space](#where-this-sits-in-the-design-space) for the precise placement.

This repo contains the [DynamicFeeAuctionHook](contracts/src/DynamicFeeAuctionHook.sol) contract, calibration tooling, and deploy scripts needed to launch your own pool. For routing your pool through aggregators and intent systems, see the separate [`eulerswap-integrations`](https://github.com/euler-mab/eulerswap-integrations) repo.

## About the substrate

**EulerSwap is an [extensively audited](https://github.com/euler-xyz/euler-swap/tree/master/audits) AMM primitive that has processed billions in cumulative volume in production.** It's been quietly under-marketed since launch — the protocol team lost key contributors and had to prioritise other work, which slowed broader adoption — but the mechanics are battle-tested and the substrate is mature. It sits on top of the equally well-audited Euler Vault Kit (EVK) and Ethereum Vault Connector (EVC), which together back most of Euler's lending TVL. This repo is one way to put that infrastructure back to work.

> ## ⚠️ The hook in this repo is experimental and unaudited
>
> The distinction matters: **EulerSwap, EVC, and EVK are audited and battle-tested**, but the [DynamicFeeAuctionHook](contracts/src/DynamicFeeAuctionHook.sol) on top of them is not. It's a personal-research reference implementation that has been **battle-tested in production by its author only**, on a single small pool ([USDC/USDT](https://etherscan.io/address/0x719529e99b7b272c5ef4ce07c30d15bc57cd68a8), ~$500 NAV).
>
> Use it as a starting point for your own designs — fork it, learn from it, but **do not deploy unmodified code with significant capital** without an independent security review of the hook contract and the deploy script you actually run. The author makes no warranty and accepts no liability for losses arising from use of this code.

---

## Live proof of principle

A single deployed pool on Ethereum mainnet, running this exact hook:

| | USDC/USDT |
|---|---|
| Pool | [`0x719529e99b7b272c5ef4ce07c30d15bc57cd68a8`](https://etherscan.io/address/0x719529e99b7b272c5ef4ce07c30d15bc57cd68a8) |
| Hook | [`0x99b97FD05b4F943899358F90855C0BEE34584e41`](https://etherscan.io/address/0x99b97FD05b4F943899358F90855C0BEE34584e41) |
| LP equity (NAV) | **~$500** |
| Daily volume | **~$98k** |
| Daily turnover | **~196×** |
| Lifetime volume | ~$810k (187 swaps) |

The pool quotes from virtual reserves of **~$247M / $242M** — orders of magnitude deeper than its real equity — by borrowing against itself via Euler's vaults. Fees collected roughly equal borrow carry on the directional leg, so the position runs ~flat while doing real volume. Full breakdown in [docs/case-study-usdc-usdt.md](docs/case-study-usdc-usdt.md).

---

## Where this sits in the design space

"propAMM" is a loose, evolving DeFi term — not a strict TradFi import. It points at the space of liquidity-provision designs that sit between two extremes:

- **Passive multi-LP AMMs** (Uniswap V2/V3, Curve) — shared liquidity, public curve, no operator discretion. Anyone can LP; nobody manages quotes.
- **TradFi prop market makers** (Citadel, Wintermute) — private fair-value models, per-quote pricing, opaque inventory management. Nothing public; nothing rule-based.

DeFi has been filling in the middle ground. Active LP designs in this space:

| Design | What it does | Substrate |
|---|---|---|
| **Uniswap V3 JIT** | Single-block LP positions around big swaps | Uniswap V3 |
| **Fluid DEX** | Lending-vault assets double as DEX liquidity (shared LP) | Instadapp Smart Vaults |
| **Yield Basis** (Egorov, 2025) | 2× leveraged CFMM eliminates IL drag — position tracks underlying | Curve infra |
| **Active single-LP, propAMM-style** (this repo) | Single-LP curve + dynamic fees + autonomous rebalancing | EulerSwap |

**EulerSwap is the primitive that makes these accessible.** Each Euler account becomes its own AMM. Collateral and debt across the account define a single pool. The curve, fee schedule, and rebalancing strategy are all yours to choose. What makes it work:

1. **Each Euler account is its own AMM.** Collateral and debt across the account define one pool. No factory subscription, no shared LP shares.
2. **Credit-backed liquidity.** The pool borrows against its own collateral to provide quotes. With LTVs up to ~96% on stables, virtual reserves are amplified ~50× over real equity. The position underneath stays small and directional.
3. **Any curve, any range.** A `concentration` parameter interpolates between constant-product (Uniswap V2), constant-sum (Curve-style for stables), and range-bound liquidity (Uniswap V3). Set per-side and per-pool.
4. **Hooks.** EulerSwap exposes `getFee` and `afterSwap` hook points. The hook controls fee dynamics and can call `reconfigure()` from inside `afterSwap` to rebalance — no off-chain bot required for the core loop.

This repo implements **one configuration**: a single-LP, credit-backed AMM with autonomous fee modulation and Dutch fee auctions for rebalancing. It's propAMM-flavored (single operator, dynamic fees, active rebalancing) but **rule-based, not model-based** — fees and shifts are public formulas, not private signals. That's the right choice for an on-chain venue (gas, transparency, manipulation resistance) but it's a distinction worth naming.

### Other configurations the same substrate supports

If you're exploring the broader space, EulerSwap can host other designs too:

- **Yield-basis-style IL elimination.** Configure the LP's net position to track the base asset (WETH-neutral instead of USDC-neutral) by borrowing against the deposited base to short the IL exposure. The math and Monte Carlo trade-offs are in [docs/yield-basis-analysis.md](docs/yield-basis-analysis.md) and [docs/yield-basis-comparison.md](docs/yield-basis-comparison.md) — both honest about where it works and where it doesn't.
- **Fluid-style shared yield-and-liquidity.** Skip the single-LP framing — multiple parties can share Euler vaults and the borrowing capacity. Not implemented in this repo, but the primitive supports it.
- **Pure JIT.** A `MinimalHook` deployment with very tight `recenterRange` and active off-chain monitoring approximates Uniswap-V3-style JIT, with credit substituting for cash inventory.

The hook in this repo is one waypoint in that broader exploration — not the only thing the substrate can do.

---

## What this hook does

[DynamicFeeAuctionHook.sol](contracts/src/DynamicFeeAuctionHook.sol) is autonomous — once deployed, it runs without any off-chain bot. Four mechanisms, all inside the hook:

### 1. Uniswap-spot-as-fee-oracle

The hook reads spot price from the deepest Uniswap pool for the pair:

- **Uniswap V3**: `slot0()` returns `sqrtPriceX96` directly.
- **Uniswap V4**: `extsload` on the PoolManager's state slot, keyed by pool ID.

Spot is unsafe as a *collateral* oracle but **safe for fee bumping**: the hook only ever raises the fee above `baseFee`, never lowers it. Manipulating the oracle can cost the attacker more on their own swap, but never benefit them. Full analysis: [docs/uniswap-oracle-pattern.md](docs/uniswap-oracle-pattern.md).

### 2. Routing-aware fee modulation

When the AMM is offering an arb against itself, the hook *captures* the arb (`baseFee + captureRate × oracleDelta`). When it's competing for retail flow against a deeper venue, it *attracts* flow by quoting tighter than the reference Uniswap pool (`baseFee − attractRate × externalFee`). Asymmetric by design.

### 3. Dutch fee auctions for rebalancing

When net base-asset exposure exceeds a configurable share of NAV, the hook starts an auction: shift `priceY` to expose a profitable arb, then decay the fee block-by-block until a swap clears it. This converts the rebalancing cost into a competitive bid instead of paying slippage on an external venue.

Auction clears on **price convergence** to the oracle (within `clearThreshold`) — a direct read on whether the arb has been consumed. `minAuctionBlocks` keeps the auction open long enough for the fee to decay.

### 4. Curvature-aware surcharge on recenter

Recentering can be round-tripped by an attacker who anticipates it. The hook adds an additive surcharge sized to the curvature bonus the recenter creates, decaying to zero over a configurable horizon. Plus a one-shot **deploy surcharge** so a mispriced initial deploy is expensive to arb before the operator notices.

All four mechanisms are derived from first principles in [docs/rebalance-auction-design.md](docs/rebalance-auction-design.md).

---

## Why this matters

The textbook "AMM LP is unprofitable vs HODL" critique assumes a passive constant-product LP getting picked off by arbs. A propAMM flips the model: you actively quote fees that price in the toxicity of each direction, you use credit to deepen liquidity without locking up capital, and you participate in the routing layer that retail actually uses.

The live USDC/USDT pool at $500 NAV doing $100k/day is what that looks like in practice. EulerSwap was built to make this approach accessible to any account on Euler. This repo is one way to operate one.

---

## Quickstart

Full walkthrough — including the prerequisite EulerSwap factory deploy and sub-account setup — in [**docs/build-your-own-propamm.md**](docs/build-your-own-propamm.md).

```bash
# 1. Clone + init submodules
git clone <this-repo> eulerswap-propamm
cd eulerswap-propamm
git submodule update --init --recursive

# 2. Build + test
cd contracts
forge build
forge test --no-match-path "test/*.fork.t.sol"     # 143 unit tests

# 3. Calibrate parameters for your pool. Copy/edit a profile in scripts/profiles/
#    then write a paste-ready env-var block:
cd ../scripts && npm install
npx tsx calibrate-hook-params.ts profiles/usdc-weth.json --env > .env.hook

# 4. Deploy the EulerSwap pool via the factory (env-driven)
source .env.hook
cd ../contracts
PRIVATE_KEY=0x... \
FACTORY=0xEulerSwapFactory EULER_ACCOUNT=0x... \
SUPPLY_VAULT_0=0x... SUPPLY_VAULT_1=0x... \
BORROW_VAULT_0=0x... BORROW_VAULT_1=0x... \
  forge script script/DeployPool.s.sol:DeployPool \
  --rpc-url $RPC_URL --broadcast --slow -vvvv

# 5. Deploy the hook against the new pool and bind it (env-driven, same .env.hook)
PRIVATE_KEY=0x... \
POOL=0xPoolFromStep4 EULER_ACCOUNT=0x... \
ORACLE_TARGET=0x... ORACLE_TOKEN0=0x... \
  forge script script/DeployHook.s.sol:DeployHook \
  --rpc-url $RPC_URL --broadcast --slow -vvvv

# 6. Register for orderflow routing
PRIVATE_KEY=0x... POOLS=0xPool EULER_ACCOUNTS=0xAccount \
  forge script script/RegisterPools.s.sol --rpc-url $RPC_URL --broadcast
```

---

## Repo layout

```
contracts/
  src/
    DynamicFeeAuctionHook.sol         # The hook (~1000 lines, single contract)
    MinimalHook.sol                   # 50-line pedagogical starter
  test/
    DynamicFeeAuctionHook.t.sol       # 45 unit tests
    DynamicFeeAuctionHook.fork.t.sol  # 14 mainnet fork tests
    MinimalHook.t.sol                 # 4 tests
    walkthrough/                      # Step-by-step auction walkthroughs
    *.fork.t.sol                      # Mainnet-fork integration tests
  script/
    DeployHook.s.sol                  # Generic env-driven hook deploy + install
    DeployPool.s.sol                  # Generic env-driven EulerSwap pool factory deploy
    EnableCollateral.s.sol            # EVC batch: enable collaterals + controller on a sub-account
    DeployHookUSDCWETH.s.sol          # Author's worked example (USDC/WETH, V3 oracle)
    DeployHookUSDCUSDT.s.sol          # Author's worked example (USDC/USDT, V4 oracle)
    DeployMinimalHook.s.sol           # Deploy the starter hook
    AddCapital.s.sol                  # Deposit collateral into pool sub-account
    BoostPool.s.sol                   # Recompute and apply additive boost
    RegisterPools.s.sol               # Register for Euler orderflow routing
  eulerswap/                          # git submodule: euler-xyz/euler-swap

docs/                                 # See "Documentation map" below

scripts/
  calibrate-hook-params.ts            # Derive params from a JSON profile; --env mode for deploy scripts
  profiles/                           # Per-pool JSON profiles (usdc-weth.json, usdc-usdt.json)
  analyze-hook.ts                     # Lifetime PnL + per-block oracle pricing
  verify-pnl.ts                       # Reconcile fees collected vs NAV change
  package.json                        # viem + tsx, run `npm install` first
```

---

## Documentation map

### Getting started
| Doc | Read it when you want to… |
|---|---|
| [docs/build-your-own-propamm.md](docs/build-your-own-propamm.md) | Walk through deploying your own propAMM end-to-end |
| [ARCHITECTURE.md](ARCHITECTURE.md) | See how account + pool + hook + oracle + orderflow fit together |
| [docs/case-study-usdc-usdt.md](docs/case-study-usdc-usdt.md) | See the live $500-NAV / $100k-day pool with actual on-chain numbers |
| [docs/faq.md](docs/faq.md) | Get quick answers to common newcomer questions (sub-accounts, minimum equity, oracle choice, …) |
| [docs/addresses.md](docs/addresses.md) | Look up canonical contract addresses per chain (EVC, registry, vaults, oracles, live pools) |

### Design space
| Doc | Read it when you want to… |
|---|---|
| [docs/yield-basis-analysis.md](docs/yield-basis-analysis.md) | Map Egorov's Yield Basis design (2× leveraged CFMM for IL elimination) onto EulerSwap, including formal proofs and feasibility analysis |
| [docs/yield-basis-comparison.md](docs/yield-basis-comparison.md) | Compare Yield Basis vs this hook with Monte Carlo simulation — honest about where each wins |
| [docs/per-lp-architecture.md](docs/per-lp-architecture.md) | Understand why each Euler account is its own AMM (vs. shared-LP pools) |

### Mechanisms
| Doc | Read it when you want to… |
|---|---|
| [docs/uniswap-oracle-pattern.md](docs/uniswap-oracle-pattern.md) | Understand the spot-as-fee-oracle pattern and why it's safe |
| [docs/dynamic-fee-model.md](docs/dynamic-fee-model.md) | See the full dynamic-fee formula with derivations |
| [docs/auction-walkthrough.md](docs/auction-walkthrough.md) | Trace a single auction cycle step by step |
| [docs/additive-boost-derivation.md](docs/additive-boost-derivation.md) | Read the math behind h=1-at-boundary boost calibration |

### Tuning
| Doc | Read it when you want to… |
|---|---|
| [docs/calibration-guide.md](docs/calibration-guide.md) | Derive every hook parameter from first principles |
| [docs/parameter-strategy-guide.md](docs/parameter-strategy-guide.md) | Tune parameters for stablecoins, volatile pairs, narrow ranges, etc. |
| [docs/rebalance-auction-design.md](docs/rebalance-auction-design.md) | Read the full design rationale (~1560 lines, historical doc) |

---

## Submodules

```bash
git submodule update --init --recursive
```

| Submodule | Repo |
|---|---|
| `contracts/eulerswap` | [euler-xyz/euler-swap](https://github.com/euler-xyz/euler-swap) |
| `contracts/euler-vault-kit` | [euler-xyz/euler-vault-kit](https://github.com/euler-xyz/euler-vault-kit) |
| `contracts/ethereum-vault-connector` | [euler-xyz/ethereum-vault-connector](https://github.com/euler-xyz/ethereum-vault-connector) |
| `contracts/euler-price-oracle` | [euler-xyz/euler-price-oracle](https://github.com/euler-xyz/euler-price-oracle) |
| `contracts/evk-periphery` | [euler-xyz/evk-periphery](https://github.com/euler-xyz/evk-periphery) |
| `contracts/euler-orderflow-router` | [euler-xyz/euler-orderflow-router](https://github.com/euler-xyz/euler-orderflow-router) |
| `contracts/euler-interfaces` | [euler-xyz/euler-interfaces](https://github.com/euler-xyz/euler-interfaces) |

---

## License

MIT.
