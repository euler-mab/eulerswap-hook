# EulerSwap CoW Protocol Driver Integration

Standalone Rust implementation of EulerSwap as a liquidity source for the
[CoW Protocol](https://github.com/cowprotocol/services) solver driver. This
crate handles pool discovery, quoting, and settlement encoding so that CoW
batches can route through EulerSwap pools on Ethereum mainnet.

## Architecture — Phase 1 (eth_call MVP)

All quoting delegates to the on-chain `computeQuote()` view function via
`eth_call`. No curve math is implemented in Rust. This approach:

- Guarantees quote parity with the contract (no reimplementation bugs).
- Automatically handles dynamic fees from hooks (`getFee()` is called
  internally by `computeQuote()`).
- Adds one RPC round-trip per quote (~10-50 ms depending on node).

## Crate Structure

```
rust/
  Cargo.toml                  # workspace root
  crates/
    euler-swap/               # library crate — all production logic
      src/
        lib.rs
        abi.rs
        types.rs
        pool_fetching.rs
        quoting.rs
        settlement.rs
    euler-swap-tests/          # integration tests (requires archive RPC)
      tests/
```

## Module Overview

| Module | Purpose |
|--------|---------|
| `abi.rs` | Contract ABI bindings via alloy `sol!` macro. Covers `IEulerSwap` (pool), `IEulerSwapRegistry` (discovery), `IEulerSwapHookTarget` (dynamic fees), and `IERC20` (transfer). |
| `types.rs` | Domain types: `EulerSwapPool`, `Reserves`, `CurveParams`, `Fees`, `Limits`, `HookInfo`, `StaticParams`, `TokenPair`. Includes active-pool filtering and ABI-to-domain conversions. |
| `pool_fetching.rs` | `PoolFetcher` — enumerates pools from the on-chain registry, caches immutable metadata, and refreshes per-block state (reserves, dynamic params, limits). Maintains a token-pair index for efficient lookup. |
| `quoting.rs` | `EthCallQuoter` — wraps `computeQuote()` eth_call for exact-input and exact-output quotes. Returns `None` for reverts and overflow sentinels. |
| `settlement.rs` | `encode_swap()` — produces two CoW settlement interactions per swap: (1) ERC20 transfer of input tokens to the pool, (2) `pool.swap()` call. Direct pool interaction, no router needed. |

## Build

```
cargo build
```

## Test

Integration tests run against a forked mainnet state and require an archive
node RPC URL:

```
FORK_URL=<archive_rpc_url> cargo test
```

The tests pin block **24,655,259** so the RPC must serve archive state at that
height.

## Upstream Integration Status

The solver-side integration into `cowprotocol/services` is complete on
`feature/euler-swap-integration` branch. The following files were added or
modified:

### New Files
| File | Purpose |
|------|---------|
| `crates/contracts/artifacts/EulerSwap.json` | Pool ABI (computeQuote, swap, getAssets, getReserves) |
| `crates/contracts/artifacts/EulerSwapRegistry.json` | Registry ABI (pools, poolsLength, poolsSlice) |
| `crates/solvers/src/domain/liquidity/euler_swap.rs` | Domain pool type (tokens, asset0, asset1) |
| `crates/solvers/src/boundary/liquidity/euler_swap.rs` | BaselineSolvable impl via computeQuote() eth_call |

### Modified Files
| File | Change |
|------|--------|
| `crates/contracts/build.rs` | Register EulerSwap + EulerSwapRegistry contracts |
| `crates/solvers/src/domain/liquidity/mod.rs` | Add `EulerSwap` variant to `State` enum |
| `crates/solvers/src/boundary/liquidity/mod.rs` | Add `euler_swap` module |
| `crates/solvers/src/boundary/baseline.rs` | Add EulerSwap dispatch (6 match arms) |
| `crates/solvers-dto/src/auction.rs` | Add `EulerSwap` DTO variant + `EulerSwapPool` struct |
| `crates/solvers/src/api/routes/solve/dto/auction.rs` | Add DTO-to-domain conversion |
| `crates/solvers/src/domain/solver/baseline.rs` | Add `euler_swap_node_url` config + provider init |
| `crates/solvers/src/infra/config/baseline.rs` | Add `euler-swap-node-url` TOML field |

### Remaining (driver-side, not yet implemented)
- Pool discovery via registry (driver infra)
- Settlement interaction encoding (driver boundary)
- Driver config for EulerSwap liquidity source

## cowprotocol/services Mapping

When porting this code into the upstream CoW solver, each file maps to a
specific location in the `cowprotocol/services` monorepo:

| This repo | Target in cowprotocol/services |
|-----------|-------------------------------|
| `euler-swap/src/abi.rs` | `crates/liquidity-sources/src/euler_swap/` (contract bindings) |
| `euler-swap/src/types.rs` | `crates/liquidity-sources/` + `crates/driver/src/domain/liquidity/euler_swap.rs` |
| `euler-swap/src/pool_fetching.rs` | `crates/liquidity-sources/src/euler_swap/pool_fetching.rs` |
| `euler-swap/src/quoting.rs` | `BaselineSolvable` impl in `crates/liquidity-sources/src/euler_swap/mod.rs` |
| `euler-swap/src/settlement.rs` | `SettlementHandling` impl in `crates/driver/src/boundary/liquidity/euler_swap.rs` |

## Contract Addresses (Mainnet)

| Contract | Address |
|----------|---------|
| EulerSwap Registry | `0x5FcCB84363F020c0cADE052C9c654aABF932814A` |
| CoW Settlement | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` |

## Upstream PR Guide: cowprotocol/services Integration

This section documents the specific adaptations needed to port this standalone
crate into a pull request against `cowprotocol/services`. The architecture
differs from our standalone workspace — this is the gap analysis.

### Traits to Implement

The upstream repo requires three trait implementations:

**1. `BaselineSolvable`** (in `crates/liquidity-sources/src/baseline_solvable.rs`)

```rust
// Phase 1: delegate to computeQuote() via eth_call (same pattern as UniV3)
// See: crates/solvers/src/boundary/liquidity/concentrated.rs
fn get_amount_out(&self, out_token: Address, input: (U256, Address)) -> Option<U256>;
fn get_amount_in(&self, in_token: Address, output: (U256, Address)) -> Option<U256>;
fn gas_cost(&self) -> usize;
```

Our `EthCallQuoter` provides the logic. For Phase 1, the impl is async
(eth_call per quote), matching the UniV3 Concentrated Liquidity precedent
from PR #3468.

**2. `SettlementHandling<EulerSwapOrder>`** (in `crates/solver/src/liquidity/`)

```rust
fn encode(&self, execution: AmmOrderExecution, encoder: &mut SettlementEncoder) -> Result<()>;
```

Our `encode_swap()` produces the correct interactions. The adaptation is
wrapping them in upstream's `EncodedInteraction` type and pushing them
into the `SettlementEncoder`.

**3. `LiquidityCollecting`** (in `crates/solver/src/liquidity_collector.rs`)

```rust
async fn get_liquidity(&self, pairs: HashSet<TokenPair>, at_block: Block) -> Result<Vec<Liquidity>>;
```

Our `PoolFetcher` provides the data. Wrap in `BackgroundInitLiquiditySource`
for retry-safe async initialization.

### Files to Create in cowprotocol/services

| New file | Based on | Purpose |
|----------|----------|---------|
| `crates/liquidity-sources/src/euler_swap/mod.rs` | `abi.rs` + `types.rs` + `quoting.rs` | Pool type + `BaselineSolvable` impl |
| `crates/liquidity-sources/src/euler_swap/pool_fetching.rs` | `pool_fetching.rs` | Registry discovery + state refresh |
| `crates/driver/src/domain/liquidity/euler_swap.rs` | `types.rs` | Domain types |
| `crates/driver/src/boundary/liquidity/euler_swap.rs` | `settlement.rs` | `SettlementHandling` impl |
| `crates/driver/src/infra/liquidity/config.rs` | (modify) | Add `EulerSwapConfig { registry }` |
| `crates/solvers-dto/src/auction.rs` | (modify) | Add `EulerSwap` variant to `Liquidity` DTO |
| `crates/solvers/src/boundary/baseline.rs` | (modify) | Add `EulerSwap` variant to `LiquiditySource` enum |

### Key Adaptations

- **Contract bindings**: Upstream generates bindings in `crates/contracts/` from ABIs, not inline `sol!`. Add our ABI JSONs there.
- **Error handling**: Replace `eyre::Result` with `anyhow::Result`.
- **Token pairs**: Replace our `TokenPair` with upstream's `model::TokenPair` (has ordering guarantees).
- **Caching**: Integrate with `RecentBlockCache` for per-block state refresh.
- **Provider type**: Replace generic `P: Provider` with upstream's concrete `Web3` / `ethrpc` types.

### Precedent PRs

- **UniV3 Baseline** (PR #3468): Added async eth_call quoting to the baseline solver. Closest pattern to our Phase 1 approach.
- **Swapr**: UniV2 fork with dynamic fees. Shows how to add a source that reuses `ConstantProductOrder` with extra fee data.

### Config

```toml
# In the driver TOML config:
[[liquidity.euler-swap]]
registry = "0x5FcCB84363F020c0cADE052C9c654aABF932814A"
```

## Phase 2 Roadmap (deferred)

Phase 2 would replace `eth_call` quoting with native Rust curve math for
sub-ms quote latency. The curve math specification is in `../spec/curve-math.md`
with 31 test vectors in `../spec/test-vectors.json`.

**Status: not needed.** Phase 1 `eth_call` latency (~10-50ms) has not been a
bottleneck in practice. Building a native Rust port would create ongoing
maintenance burden — the Solidity `CurveLib` has careful rounding (direction-
dependent `mulDivUp`, citardauq formula, dynamic bit-shifting) that would need
exact replication, and dynamic fees from hooks (`getFee()`) would still require
an `eth_call` or separate reimplementation. The spec and test vectors are
maintained as a starting point if this changes.

## Specification

Detailed design documents live in [`../spec/`](../spec/):

- `architecture-primer.md` — overall integration architecture
- `cow-pr-guide.md` — guide for the upstream PR
- `curve-math.md` — EulerSwap curve math specification
- `pool-fetching.md` — pool discovery and state refresh design
- `settlement-encoding.md` — settlement interaction encoding
- `test-vectors.json` — pinned test vectors for quote validation
