# EulerSwap Tycho Substreams Indexer

Substreams package that indexes EulerSwap pools for the Tycho Protocol SDK. Enables Propeller solvers to route through EulerSwap pools by maintaining a real-time storage mirror of all contracts in the `computeQuote` call chain.

## Architecture

EulerSwap uses a **VM integration** (`ImplementationType::Vm`). The Tycho simulation VM mirrors contract storage and runs `computeQuote` directly on the pool contract. This means the indexer must capture **every storage slot change** for all contracts in the simulation call chain, not just high-level entity attributes.

### computeQuote Call Chain

```
pool.computeQuote(tokenIn, tokenOut, amount, exactIn)
  ├── reads pool State:       reserve0, reserve1                    [pool storage]
  ├── reads pool DynamicParams: eqReserve0/1, price, concentration  [pool storage]
  ├── calls hook.getFee()                                           [hook storage]
  │     ├── reads fee/auction/surcharge state                       [hook storage]
  │     ├── reads pool.getDynamicParams()                           [pool storage]
  │     └── reads uniswapPool.slot0() → sqrtPriceX96               [oracle storage]
  └── CurveLib pure math (no storage reads)
```

### Contracts Tracked Per Pool

| Contract | Why | Storage Changes |
|----------|-----|-----------------|
| Pool (e.g. `0x4311...`) | Reserves change every swap; DynamicParams change on reconfigure | Every block with a swap or reconfigure |
| Hook (e.g. `0x7bb6...`) | Fee/auction state read by `getFee()` | Every block with a swap (fee params) or auction event |
| Oracle (e.g. `0x88e6...`) | Uniswap V3 `slot0` read for `sqrtPriceX96` | Every block with a Uniswap swap (very frequent) |

### Contract Tracking Design

**Key constraint**: `ProtocolComponent.contracts` is **immutable** after creation — you cannot add or remove contracts from a component later.

**Design**: The `contracts` field contains **only the pool address**. Hook and oracle contracts are tracked for storage changes via:
- **Deployment params** (fallback): `hook_contracts` and `oracle_contracts` in substreams params
- **DCI (Dynamic Contract Indexer)** (production): Auto-discovers dependency contracts via entrypoint tracing of `computeQuote`

This design handles **hook reinstallation** cleanly: when a pool's `swapHook` changes via `reconfigure()`, the immutable `contracts` field doesn't need updating. DCI automatically traces the new hook's storage reads; params-based tracking just needs the new hook address added.

### manual_updates + update_marker

All components are created with `manual_updates=true`. This prevents the Uniswap oracle's frequent `slot0` changes (every Uniswap swap) from triggering unnecessary re-simulation of EulerSwap pools.

Instead, re-simulation is triggered **explicitly** via `update_marker` EntityChanges when `EulerSwapConfigured` events fire (pool activation, reconfigure, hook change).

### Pool Lifecycle

| Event | Action | Effect |
|-------|--------|--------|
| `PoolRegistered` | `ProtocolComponent` with `ChangeType::Creation` | Pool becomes routable |
| `EulerSwapConfigured` | EntityChanges: `update_marker` → `[1]` | Triggers re-simulation (curve params, fees, or hook changed) |
| `PoolUnregistered` | `ProtocolComponent` with `ChangeType::Deletion` | Pool removed from routing |

Pool unregistration does **not** destroy the on-chain contract. If a pool is re-registered later, the indexer emits a fresh `ProtocolComponent` Creation with the same component ID, re-initializing it for routing.

### 5-Module Pipeline

```
Block → map_protocol_components ─┬─→ store_protocol_tokens
                                 │
Block → map_relative_component_balance ─→ store_component_balances
                                 │
Block ──────────────────────────→ map_protocol_changes → BlockChanges
```

1. **`map_protocol_components`** — Watches `PoolRegistered` / `PoolUnregistered` events on the EulerSwap registry. Emits `ProtocolComponent` with the pool's tokens, pool contract address, and immutable `StaticParams` as static attributes.

2. **`store_protocol_tokens`** — Stores pool existence flags and token addresses for downstream event filtering.

3. **`map_relative_component_balance`** — Parses `Swap` events from tracked pools. Emits signed `BalanceDelta` per token (`amountIn - amountOut`).

4. **`store_component_balances`** — Accumulates deltas into absolute reserve balances.

5. **`map_protocol_changes`** — Aggregates component creation/deletion, `update_marker` EntityChanges, absolute `BalanceChange` values, and `ContractChange` storage slot writes for all tracked contracts. Filters reverted calls.

## Hook Dependency Problem

EulerSwap pools support configurable swap hooks. Different hooks have different external dependencies:

| Hook | External Dependency | Storage to Track |
|------|-------------------|-----------------|
| V7 (LPAgentHookV7) | Uniswap V3 pool `slot0` | ~15 hook state vars + oracle slot0 |
| No hook | None | Pool storage only |
| Future hooks | Unknown | Varies |

**Substreams cannot make external calls**, so we can't read `DynamicParams.swapHook` or `hook.uniswapPool()` at indexing time. Two approaches:

### Deployment params (current)

Hook and oracle contracts passed as params:

```yaml
params:
  map_protocol_changes: "registry_address=5FcCB84...&hook_contracts=7bb638b...&oracle_contracts=88e6A0c..."
```

Adding a new hook type requires updating the params. Pool discovery itself (via registry events) is fully automatic.

### DCI — Dynamic Contract Indexer (production path)

In production, Tycho's DCI automatically discovers dependency contracts by tracing `computeQuote` entrypoint storage reads. This eliminates the need for manual params and handles hook reinstallation automatically:

1. DCI runs `computeQuote` in tracing mode
2. Observes storage reads to hook contract, hook reads from oracle
3. Adds those contracts to the tracked set
4. On hook change (detected via `EulerSwapConfigured` + `update_marker`), DCI re-traces and updates dependencies

The params approach serves as a fallback for non-DCI environments (local testing, early deployment).

## Setup

### Prerequisites

- [Rust](https://rustup.rs/) with `wasm32-unknown-unknown` target
- [Substreams CLI](https://substreams.streamingfast.io/getting-started/installing-the-cli)
- [buf](https://buf.build/docs/installation) for protobuf code generation
- Access to the [Tycho Protocol SDK](https://github.com/propeller-heads/tycho-protocol-sdk) repo (for shared proto files and `tycho-substreams` crate)

### Build

```bash
# From the tycho-protocol-sdk repo root (this package lives at substreams/ethereum-eulerswap/)
cd substreams/ethereum-eulerswap

# Generate protobuf bindings
buf generate ../../proto

# Build WASM module
cargo build --target wasm32-unknown-unknown --release

# Pack substreams
substreams pack substreams.yaml
```

### Test

```bash
# Stream from a specific block range (e.g. around pool registration)
substreams run substreams.yaml map_protocol_changes \
  --start-block 19000000 \
  --stop-block +100 \
  -e mainnet.eth.streamingfast.io:443

# Integration test (from protocol-testing directory)
cd ../../protocol-testing
cargo run -- ../substreams/ethereum-eulerswap
```

## Params Reference

| Param | Required | Description |
|-------|----------|-------------|
| `registry_address` | Yes | EulerSwap registry contract (no 0x prefix) |
| `hook_contracts` | No | Comma-separated hook addresses to track storage for |
| `oracle_contracts` | No | Comma-separated oracle addresses (e.g. Uniswap V3 pools) |

### Mainnet Configuration

```
registry_address=5FcCB84363F020c0cADE052C9c654aABF932814A
hook_contracts=7bb638b9842eA4275901aafB2e34943d9C2Fe4FB
oracle_contracts=88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640
```

## Contract Addresses (Mainnet)

| Contract | Address | Role |
|----------|---------|------|
| EulerSwap Registry | `0x5FcCB84363F020c0cADE052C9c654aABF932814A` | Pool discovery |
| USDC/WETH Pool | `0x4311031739918Aba578C3C667DA3028A12Ce28A8` | Primary pool |
| V7 Fee Hook | `0x7bb638b9842eA4275901aafB2e34943d9C2Fe4FB` | Dynamic fees, auctions, recentering |
| Uniswap V3 Oracle | `0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640` | USDC/WETH 0.05%, `slot0.sqrtPriceX96` |

## Multichain Deployment

The indexer is multichain-ready by design:
- Pool discovery is fully event-driven (no hardcoded addresses)
- All chain-specific values are in `substreams.yaml` params
- To deploy on a new chain: copy `substreams.yaml`, update `network` and `params`
- No code changes needed

## Known Limitations

1. **Hook/oracle discovery is param-based**: New hook types require param updates (or DCI in production). See "Hook Dependency Problem" above.

2. **Balance tracking for pre-existing pools**: Pools registered before the substreams start block won't have initial reserves captured. The balance store starts at 0 and accumulates swap deltas, so the absolute value will be off by the initial reserves. This doesn't affect simulation (which uses storage directly) but may affect TVL reporting.

3. **Fee exclusion from balance deltas**: Balance deltas are computed as `amountIn - amountOut` from Swap events. If fees are sent to a separate `feeRecipient` (not retained in reserves), the accumulated balance will drift from the true reserves by the cumulative fee amount. For Tycho's purposes this is acceptable — the VM simulation uses actual storage for pricing, and balances are only used for TVL heuristics.

4. **Oracle storage volume**: The Uniswap V3 oracle pool has frequent `slot0` updates (every Uniswap swap). This produces a high volume of `ContractSlot` entries in the output. This is expected and necessary for correct fee computation. The `manual_updates` flag prevents this from triggering excessive re-simulation.

5. **Proto codegen not self-contained**: The protobuf definitions (`common.proto`, `utils.proto`) live in the Tycho SDK repo at `proto/tycho/evm/v1/`. This package must be built within the SDK repo context, or the proto files must be copied locally. The `substreams.yaml` import path (`../../proto`) assumes the SDK repo layout.

## File Structure

```
integrations/tycho-substreams/
├── Cargo.toml                      # Rust crate config (cdylib for WASM)
├── substreams.yaml                 # Module manifest (5-module pipeline)
├── build.rs                        # ABI codegen via substreams_ethereum::Abigen
├── buf.gen.yaml                    # Protobuf codegen config
├── rust-toolchain.toml             # Rust 1.82 + wasm32 target
├── integration_test.tycho.yaml     # Tycho protocol-testing config
├── abi/
│   ├── EulerSwapRegistry.json      # PoolRegistered, PoolUnregistered events
│   └── EulerSwapPool.json          # Swap, EulerSwapConfigured events
├── src/
│   ├── lib.rs                      # Module declarations
│   ├── modules.rs                  # 5 substreams handlers
│   ├── pool_factories.rs           # ProtocolComponent creation
│   ├── abi/
│   │   └── mod.rs                  # Generated ABI bindings (build.rs)
│   └── pb/
│       └── mod.rs                  # Generated protobuf bindings (buf)
└── README.md
```
