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

## Phase 2 Roadmap

Phase 2 replaces `eth_call` quoting with native Rust curve math for sub-ms
quote latency. This eliminates the RPC round-trip and enables the solver to
evaluate EulerSwap pools at the same speed as Uniswap V2/V3 sources. The
curve math specification is documented in `../spec/curve-math.md`.

## Specification

Detailed design documents live in [`../spec/`](../spec/):

- `architecture-primer.md` — overall integration architecture
- `cow-pr-guide.md` — guide for the upstream PR
- `curve-math.md` — EulerSwap curve math specification
- `pool-fetching.md` — pool discovery and state refresh design
- `settlement-encoding.md` — settlement interaction encoding
- `test-vectors.json` — pinned test vectors for quote validation
