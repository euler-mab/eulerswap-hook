# DynamicFeeAuctionHook for EulerSwap

[![ci](https://github.com/euler-mab/eulerswap-hook/actions/workflows/ci.yml/badge.svg)](https://github.com/euler-mab/eulerswap-hook/actions/workflows/ci.yml)

A reference hook for **active single-LP liquidity provision** on [EulerSwap](https://github.com/euler-xyz/euler-swap) — one operator per pool, dynamic fees set against a Uniswap-spot oracle, Dutch fee-decay auctions for autonomous rebalancing. All on-chain. No off-chain bot for the core loop.

The "active" framing means concrete things: **single operator per pool** (one Euler account owns the position, not a shared LP curve), **fee-oracle-driven asymmetric fees** (quote higher for arb direction, lower for retail), and **autonomous Dutch-auction rebalancing** (when inventory drifts, the hook offers a known arb that decays in price until someone takes it). All in public Solidity, runnable inside `getFee` and `afterSwap`. No off-chain quoter, no private orderflow, no builder integration required.

This repo contains the [DynamicFeeAuctionHook](contracts/src/DynamicFeeAuctionHook.sol) contract, calibration tooling, and deploy scripts needed to launch your own pool. For routing your pool through aggregators and intent systems, see the separate [`eulerswap-integrations`](https://github.com/euler-mab/eulerswap-integrations) repo. Narrative-style overview in [`docs/blog-post.md`](docs/blog-post.md).

> ⚠️ **The hook in this repo is experimental and unaudited.** The Euler substrate underneath (EulerSwap, EVK, EVC) is audited and battle-tested — this isn't. Fork it, learn from it, **get a security review before deploying with real capital**. No warranty.

---

## What the hook does

[DynamicFeeAuctionHook.sol](contracts/src/DynamicFeeAuctionHook.sol) is autonomous — once deployed, it runs without any off-chain bot. **Five mechanisms** compound inside the hook, each solving a specific failure mode of naïve constant-product LPing:

### 1. Uniswap-spot-as-fee-oracle — *direction signal*

The hook reads spot from the deepest Uniswap pool for the pair (V3 `slot0()` or V4 `extsload`). Spot is unsafe as a *collateral* oracle but **safe for fee bumping**: the hook only ever raises the fee above `baseFee`, never lowers it. A manipulator pays the inflated fee on their own swap. Full analysis: [docs/uniswap-oracle-pattern.md](docs/uniswap-oracle-pattern.md).

### 2. Routing-aware asymmetric fees — *price-discriminate by direction*

When the AMM is offering an arb against itself: **capture** (`baseFee + captureRate × oracleDelta`). When it's competing for retail flow against a deeper venue: **attract** (`baseFee − attractRate × externalFee`, never below `baseFee`). Solves the "every LP is equally exposed to toxic flow" problem of passive AMMs.

### 3. Dutch fee auctions — *rebalance without external slippage*

When net base-asset exposure exceeds a configurable share of NAV, the hook shifts `priceY` to expose a profitable arb, then decays the fee block-by-block until a swap clears it. Solves the "rebalance by selling on Uniswap and eating slippage" problem of passive credit-backed designs. Clears on **price convergence** to the oracle (not reserve-based); `minAuctionBlocks` keeps the auction open long enough for the fee to decay.

### 4. Curvature-aware recenter surcharge — *anti-round-trip*

Recentering can be round-tripped by an attacker who anticipates it. The hook adds an additive surcharge sized to the curvature bonus the recenter creates, decaying to zero over a configurable horizon. Plus a one-shot **deploy surcharge** so a mispriced initial deploy is expensive to arb before the operator notices.

### 5. Builder-fee bump — *opportunistic top-up* &nbsp;<sup>(optional, off on the live pool)</sup>

Permissionless `setBuilderFee(fee)` lets any party — in practice the block builder — raise the quoted fee for the current block above the public floor. `getFee` returns `max(publicFee, builderFee)`. A configurable share of the bumped delta is accrued to the bumper as revenue split. Solves "the public formula leaves the builder's information edge on the table" — a builder with a private CEX-DEX signal can bid just above floor on swaps they predict will still go through, capturing some of the spread for the LP. **Disabled by default** (`builderFeeShareBps = 0`); not enabled on the live USDC/USDT pool. Design: [docs/builder-fee-design.md](docs/builder-fee-design.md).

Mechanisms 1–4 are autonomous; #5 is a permissionless add-on a pool operator can opt into. All five are derived from first principles in [docs/rebalance-auction-design.md](docs/rebalance-auction-design.md) (and the new #5 in [docs/builder-fee-design.md](docs/builder-fee-design.md)).

---

## Live proof of principle

A single deployed pool on Ethereum mainnet, running mechanisms 1–4 (`builderFee` not enabled):

| | USDC/USDT |
|---|---|
| Pool | [`0x719529e99b7b272c5ef4ce07c30d15bc57cd68a8`](https://etherscan.io/address/0x719529e99b7b272c5ef4ce07c30d15bc57cd68a8) |
| Hook | [`0x99b97FD05b4F943899358F90855C0BEE34584e41`](https://etherscan.io/address/0x99b97FD05b4F943899358F90855C0BEE34584e41) |
| LP equity (NAV) | **~$489** |
| Volume (7d avg) | **~$46k/day** (bursty: $0 – $100k) |
| Daily turnover (7d avg) | **~95×** |
| Lifetime volume | ~$810k (187 swaps over ~90 days) |

Per-trade capacity is order $10k (bounded by collateral × LTV); the curve's virtual reserves of $247M / $242M tighten slippage *within* that capacity to near-1:1. The interesting number isn't depth — it's turnover: ~95× equity per day on average, because the auction mechanic recycles inventory many times when flow is active. Volume is **bursty** — heavy days ($100k+) when aggregators route through, quiet days near zero when they don't. P&L runs slightly negative in quiet stretches (borrow carry exceeds fees) and recovers on busy days; current snapshot is -$12 over ~90 days. Full breakdown in [docs/case-study-usdc-usdt.md](docs/case-study-usdc-usdt.md).

---

## Where this sits in the design space

Active LP designs sit between two extremes:

- **Passive multi-LP AMMs** (Uniswap V2/V3, Curve) — shared liquidity, public curve, no operator discretion. Anyone can LP; nobody manages quotes.
- **Off-chain quoters / builder-coordinated AMMs** (the "propAMM" family — Titan, Sorella Angstrom, Arrakis HOT, Solana pAMMs) — a single operator runs an off-chain price model and streams signed quotes to a block builder, who sequences taker flow against the freshest quote inside the block. High execution quality, but private signal, builder-gated, and off-chain by design.

A few approaches sit in between, each making different trade-offs:

| Design | What it does | Substrate |
|---|---|---|
| **Uniswap V3 JIT** | Single-block LP positions around big swaps | Uniswap V3 |
| **Fluid DEX** | Lending-vault assets double as DEX liquidity (shared LP) | Instadapp Smart Vaults |
| **Yield Basis** (Egorov, 2025) | 2× leveraged CFMM eliminates IL drag — position tracks underlying | Curve infra |
| **Active single-LP, rule-based** (this repo) | Single-LP curve + dynamic fees + autonomous Dutch auctions | EulerSwap |

**EulerSwap is the primitive that makes these accessible.** Each Euler account becomes its own AMM. Collateral and debt across the account define a single pool. The curve, fee schedule, and rebalancing strategy are all yours to choose. What makes it work:

1. **Each Euler account is its own AMM.** Collateral and debt across the account define one pool. No factory subscription, no shared LP shares.
2. **Credit-backed liquidity.** The pool borrows against its own collateral to source inventory for each swap. With LTVs up to ~96% on stables, per-trade capacity is ~25× equity via vault credit. The position underneath stays small and directional, but the auction mechanic recycles it many times per day.
3. **Any curve, any range.** A `concentration` parameter interpolates between constant-product (Uniswap V2), constant-sum (Curve-style for stables), and range-bound liquidity (Uniswap V3). Set per-side and per-pool.
4. **Hooks.** EulerSwap exposes `getFee` and `afterSwap` hook points. The hook controls fee dynamics and can call `reconfigure()` from inside `afterSwap` to rebalance — no off-chain bot required for the core loop.

This repo implements **one configuration**: a single-LP, credit-backed AMM with autonomous fee modulation and Dutch fee auctions for rebalancing. "Proprietary" in the limited sense that one Euler account owns the position and tunes the fee schedule via a public oracle — not in the off-chain-quoter, private-orderflow sense some readers will hear in "propAMM". Fees and shifts are public formulas a swapper can simulate before they trade; the right shape for an on-chain venue (gas, transparency, manipulation resistance).

### Other configurations the same substrate supports

If you're exploring the broader space, EulerSwap can host other designs too:

- **Yield-basis-style IL elimination.** Configure the LP's net position to track the base asset (WETH-neutral instead of USDC-neutral) by borrowing against the deposited base to short the IL exposure. The math and Monte Carlo trade-offs are in [docs/yield-basis-analysis.md](docs/yield-basis-analysis.md) and [docs/yield-basis-comparison.md](docs/yield-basis-comparison.md) — both honest about where it works and where it doesn't.
- **Fluid-style shared yield-and-liquidity.** Skip the single-LP framing — multiple parties can share Euler vaults and the borrowing capacity. Not implemented in this repo, but the primitive supports it.
- **Pure JIT.** A `MinimalHook` deployment with very tight `recenterRange` and active off-chain monitoring approximates Uniswap-V3-style JIT, with credit substituting for cash inventory.

The hook in this repo is one waypoint in that broader exploration — not the only thing the substrate can do.

---

## Why this matters

The textbook "AMM LP is unprofitable vs HODL" critique assumes a passive constant-product LP getting picked off by arbs. An active LP flips the model: you quote fees that price in the toxicity of each direction, you use credit to deepen liquidity without locking up capital, and you participate in the routing layer that retail actually uses.

The live USDC/USDT pool at ~$500 NAV doing tens of $k/day on busy days is what that looks like in practice. EulerSwap was built to make this approach accessible to any account on Euler. This repo is one way to operate one.

---

## Quickstart

```bash
git clone https://github.com/euler-mab/eulerswap-hook.git
cd eulerswap-hook
make setup       # submodules + npm install + forge build
make test        # 167 unit tests, no RPC required
make doctor      # verify toolchain + env
```

For a forked-mainnet dry-run of the full deploy (no real ETH spent):

```bash
cp .env.example .env
# fill in MAINNET_RPC_URL in .env, then:
source .env && make demo
```

Mainnet deployment (calibrate → deploy pool → deploy hook → register orderflow) is documented end-to-end in [**docs/build-your-own-active-lp.md**](docs/build-your-own-active-lp.md). The commands stay explicit `forge script ... --broadcast` invocations — never wrapped in `make` — so you never accidentally broadcast.

Generate calibration env vars for a pool profile:

```bash
make calibrate profile=usdc-weth     # writes paste-ready vars to stdout
```

Available AI-agent prompts: [PROMPTS.md](PROMPTS.md).

---

## Repo layout

```
contracts/
  src/
    DynamicFeeAuctionHook.sol         # The hook (~1000 lines, single contract)
    MinimalHook.sol                   # 50-line pedagogical starter
  test/
    DynamicFeeAuctionHook.t.sol       # 77 unit tests
    DynamicFeeAuctionHook.fork.t.sol  # 16 mainnet fork tests
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
assets/                               # Diagrams for the blog post (SVG + PNG)

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
| [docs/build-your-own-active-lp.md](docs/build-your-own-active-lp.md) | Walk through deploying your own active-LP pool end-to-end |
| [ARCHITECTURE.md](ARCHITECTURE.md) | See how account + pool + hook + oracle + orderflow fit together |
| [docs/blog-post.md](docs/blog-post.md) | Read the narrative version of the design (Medium-style post, with diagrams) |
| [docs/case-study-usdc-usdt.md](docs/case-study-usdc-usdt.md) | See the live ~$500-NAV pool with actual on-chain numbers (volume, P&L, auctions) |
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
| [docs/builder-fee-design.md](docs/builder-fee-design.md) | See the optional 5th mechanism — opportunistic builder-side fee bump |
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
git submodule update --init --recursive    # or: make setup
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

## Ecosystem resources

The wider Euler stack this repo sits on. **Audited substrates** the reference implementation depends on:

| Repo | What it is |
|---|---|
| [euler-vault-kit (EVK)](https://github.com/euler-xyz/euler-vault-kit) | The vault framework that backs Euler lending |
| [ethereum-vault-connector (EVC)](https://github.com/euler-xyz/ethereum-vault-connector) | Account-abstraction layer for cross-vault collateral and operators |
| [euler-price-oracle](https://github.com/euler-xyz/euler-price-oracle) | Composable price-oracle adapters for collateral pricing |
| [euler-swap](https://github.com/euler-xyz/euler-swap) | Single-LP AMM with vault-backed liquidity and a hook interface |
| [evk-periphery](https://github.com/euler-xyz/evk-periphery) | Factories, swappers, and utilities wrapping EVK |
| [euler-interfaces](https://github.com/euler-xyz/euler-interfaces) | Canonical addresses + interface definitions per chain |
| [euler-audits](https://github.com/euler-xyz/euler-audits) | Audit reports for the substrates above |

**Tooling and libraries:**

| Repo | What it is |
|---|---|
| [euler-sdk](https://github.com/euler-xyz/euler-sdk) | TypeScript SDK — vaults, swap, exec, markets, liquidation |
| [euler-swap-jslib](https://github.com/euler-xyz/euler-swap-jslib) | Lightweight JS library with EulerSwap curve math (viem-based) |
| [euler-orderflow-router](https://github.com/euler-xyz/euler-orderflow-router) | Orderflow routing API for EulerSwap pools |

**UIs to fork:**

| Repo | What it is |
|---|---|
| [euler-lite](https://github.com/euler-xyz/euler-lite) | Vue-based minimal UI for interacting with Euler |
| [euler-maglev](https://github.com/euler-xyz/euler-maglev) | Minimal experimental interface for EulerSwap instances |

**Docs:**

- [docs.euler.finance](https://docs.euler.finance) — official user-facing docs
- [euler-docs](https://github.com/euler-xyz/euler-docs) — source for the official docs

---

## License

MIT.
