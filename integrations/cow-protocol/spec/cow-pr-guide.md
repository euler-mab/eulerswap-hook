# CoW Protocol Services PR Guide

Step-by-step guide for adding EulerSwap as a liquidity source in `cowprotocol/services`.

## Overview

The PR touches 4 crates across 3 architectural layers:

1. **`liquidity-sources`** — pool discovery, state fetching, curve math
2. **`driver`** — boundary (conversion + interaction encoding) and domain (canonical types)
3. **`solvers-dto`** — JSON types for solver communication

## Files to Create

### 1. `crates/liquidity-sources/src/euler_swap/mod.rs`

Pool struct and `BaselineSolvable` implementation.

```rust
pub mod pool_fetching;

use {
    ethcontract::Address,
    primitive_types::U256,
};

/// EulerSwap pool with all state needed for quoting
pub struct Pool {
    pub address: Address,
    pub tokens: TokenPair,
    pub reserves: Reserves,
    pub params: CurveParams,
    pub fees: Fees,
    pub limits: Limits,
}

pub struct Reserves {
    pub reserve0: u128,
    pub reserve1: u128,
}

pub struct CurveParams {
    pub equilibrium_reserve0: u128,
    pub equilibrium_reserve1: u128,
    pub min_reserve0: u128,
    pub min_reserve1: u128,
    pub price_x: U256,
    pub price_y: U256,
    pub concentration_x: u64,
    pub concentration_y: u64,
}

pub struct Fees {
    pub fee0: u64,  // scale: 1e18
    pub fee1: u64,
}

pub struct Limits {
    pub limit_in_0to1: U256,
    pub limit_out_0to1: U256,
    pub limit_in_1to0: U256,
    pub limit_out_1to0: U256,
}

impl BaselineSolvable for Pool {
    fn get_amount_out(&self, out_token: Address, input: (Address, U256)) -> Option<U256> {
        // Phase 1: call computeQuote via eth_call
        // Phase 2: native curve math (see curve-math.md)
    }

    fn get_amount_in(&self, in_token: Address, output: (Address, U256)) -> Option<U256> {
        // Phase 1: call computeQuote via eth_call (exactIn=false)
        // Phase 2: native curve math
    }

    fn gas_cost(&self) -> usize {
        150_000
    }
}
```

### 2. `crates/liquidity-sources/src/euler_swap/pool_fetching.rs`

Registry-based pool discovery and per-block state caching.

Key components:
- `EulerSwapPoolFetcher` — implements `PoolFetching` trait
- Registry contract binding (from ABI in `abi/IEulerSwapRegistry.json`)
- Pool contract binding (from ABI in `abi/IEulerSwap.json`)
- Multicall batching for `getReserves()` + `getDynamicParams()`

See `pool-fetching.md` for the full discovery and caching algorithm.

Reference: `crates/liquidity-sources/src/uniswap_v2/pool_fetching.rs`

### 3. `crates/liquidity-sources/src/euler_swap/curve_math.rs` (Phase 2 only)

Rust port of CurveLib.f() and CurveLib.fInverse(). See `curve-math.md` for the full specification.

Required dependencies:
- `ruint` or `ethnum` for U256 arithmetic
- Custom `mul_div` / `mul_div_up` for 512-bit intermediates
- `isqrt` / `isqrt_up` for integer square root

### 4. `crates/driver/src/boundary/liquidity/euler_swap.rs`

Boundary layer: converts liquidity-sources types to domain types and encodes settlement interactions.

```rust
/// Creates the EulerSwap liquidity collector
pub fn collector(config: &EulerSwapConfig, web3: &Web3) -> Box<dyn LiquidityCollecting> {
    // Initialize registry contract
    // Create pool fetcher with caching
    // Return collector that implements LiquidityCollecting
}

/// Converts a liquidity-sources Pool to a domain Liquidity
pub fn to_domain(pool: &euler_swap::Pool) -> Liquidity {
    Liquidity {
        id: Id::next(),
        gas: eth::Gas(150_000.into()),
        kind: Kind::EulerSwap(domain::euler_swap::Pool {
            address: pool.address,
            tokens: pool.tokens,
            reserves: pool.reserves,
            params: pool.params,
            fees: pool.fees,
            limits: pool.limits,
        }),
    }
}

/// Encodes a swap as settlement interactions
pub fn to_interaction(
    pool: &domain::euler_swap::Pool,
    input: &eth::Asset,
    output: &eth::Asset,
    settlement: Address,
) -> Vec<Interaction> {
    // See settlement-encoding.md for exact encoding
    vec![
        // 1. Transfer input tokens to pool
        Interaction {
            target: input.token,
            value: 0.into(),
            calldata: erc20_transfer(pool.address, input.amount),
        },
        // 2. Call pool.swap()
        Interaction {
            target: pool.address,
            value: 0.into(),
            calldata: euler_swap_call(pool, input, output, settlement),
        },
    ]
}
```

### 5. `crates/driver/src/domain/liquidity/euler_swap.rs`

Domain types:

```rust
pub struct Pool {
    pub address: Address,
    pub tokens: TokenPair,
    pub reserves: Reserves,
    pub params: CurveParams,
    pub fees: Fees,
    pub limits: Limits,
}
```

## Files to Modify

### 1. `crates/liquidity-sources/src/lib.rs`

```rust
pub mod euler_swap;  // Add this line
```

### 2. `crates/driver/src/domain/liquidity/mod.rs`

Add variant to the `Kind` enum:

```rust
pub enum Kind {
    UniswapV2(uniswap::v2::Pool),
    UniswapV3(uniswap::v3::Pool),
    BalancerV2Stable(balancer::v2::stable::Pool),
    BalancerV2Weighted(balancer::v2::weighted::Pool),
    Swapr(swapr::Pool),
    ZeroEx(zeroex::LimitOrder),
    EulerSwap(euler_swap::Pool),  // Add this
}
```

### 3. `crates/solvers-dto/src/auction.rs`

Add DTO variant for solver communication:

```rust
#[serde(rename_all = "camelCase")]
pub enum Liquidity {
    ConstantProduct(ConstantProductPool),
    WeightedProduct(WeightedProductPool),
    Stable(StablePool),
    ConcentratedLiquidity(ConcentratedLiquidityPool),
    ForeignLimitOrder(ForeignLimitOrder),
    EulerSwap(EulerSwapPool),  // Add this
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EulerSwapPool {
    pub id: String,
    pub address: Address,
    pub tokens: TokenPair,
    pub reserves: Reserves,
    pub equilibrium_reserves: Reserves,
    pub min_reserves: Reserves,
    pub price_x: U256,
    pub price_y: U256,
    pub concentration_x: U256,
    pub concentration_y: U256,
    pub fee0: U256,
    pub fee1: U256,
    pub gas_estimate: U256,
}
```

### 4. `crates/driver/src/infra/liquidity/config.rs`

Add TOML config:

```rust
#[derive(Deserialize)]
pub struct EulerSwapConfig {
    pub registry: Address,
    #[serde(default = "default_gas")]
    pub gas_estimate: u64,
}

fn default_gas() -> u64 { 150_000 }
```

### 5. `crates/driver/src/boundary/liquidity/mod.rs`

Wire EulerSwap into the liquidity fetcher:

```rust
pub mod euler_swap;  // Add module

// In Fetcher::new() or equivalent:
if let Some(euler_config) = &config.euler_swap {
    sources.push(euler_swap::collector(euler_config, &web3));
}
```

### 6. Driver TOML config

```toml
[[liquidity.euler-swap]]
registry = "0x5FcCB84363F020c0cADE052C9c654aABF932814A"
```

## PR Structure

### Recommended commit order:

1. **Add ABI bindings** — generate Rust contract bindings from ABIs
2. **Add pool fetching** — registry discovery + state caching
3. **Add domain types** — Pool struct, Kind::EulerSwap variant
4. **Add boundary layer** — collector, to_domain, to_interaction
5. **Add DTO** — EulerSwapPool for solver communication
6. **Add config** — TOML parsing, wire into driver
7. **Add tests** — unit tests with test vectors, integration test with mainnet fork

### Testing approach:

- **Unit tests:** Validate curve math against test vectors (see `test-vectors.json`)
- **Integration test:** Fork mainnet, discover pools from registry, compare quotes with on-chain `computeQuote()`
- **Settlement test:** Simulate a CoW settlement with EulerSwap interaction on a fork

## Reference Implementations

Study these existing liquidity sources in the repo:

| Source | Complexity | Pattern |
|--------|-----------|---------|
| Uniswap V2 | Low | Simplest reference — constant-product, `BaselineSolvable`, ERC20 transfer + swap |
| Uniswap V3 | Medium | Concentrated liquidity, tick-based, more complex state |
| Balancer V2 | Medium | Multiple pool types, vault-based settlement |

EulerSwap is closest to **Uniswap V2** in settlement pattern (transfer + swap) but closer to **Uniswap V3** in curve complexity (concentrated liquidity with specialized math).

## Error Handling

### Pool Discovery Errors

| Error | Action |
|-------|--------|
| Registry call fails | Log warning, return empty pool list. Retry next cycle. |
| `getAssets()` reverts for a pool | Skip that pool, log warning. |
| `isInstalled()` returns false | Exclude pool from active set. |
| Pool has `expiration != 0 && expiration <= now` | Exclude from active set. |

### State Fetching Errors

| Error | Action |
|-------|--------|
| `getReserves()` fails in multicall | Skip pool for this block. Use last known state if available. |
| `getDynamicParams()` fails | Skip pool for this block. |
| `status != 1` (locked or unactivated) | Temporarily exclude pool. |
| `fee >= 1e18` | Pool is rejecting swaps. Exclude from liquidity. |

### Quote Computation Errors

| Error | Action |
|-------|--------|
| `computeQuote()` reverts (Phase 1) | Return `None` from `get_amount_out()`. |
| Curve math overflow (Phase 2) | Return `None`. The Solidity returns `type(uint256).max` as overflow sentinel. |
| Amount exceeds limits | Return `None`. Driver should pre-check against cached limits. |
| `hook.getFee()` reverts (Phase 2) | Fall back to `fee0`/`fee1` from DynamicParams. |

### Settlement Errors

| Error | Action |
|-------|--------|
| Settlement reverts on-chain | CoW Protocol handles this — solver loses the auction but no user funds are at risk. |
| State changed between quote and settle | Expected. Settlement validates on-chain. The solver should include a margin. |

**General principle:** Never crash or block the auction loop. Skip individual pools that fail and continue with remaining liquidity. Log all errors for debugging.

## Detecting Pool Properties

### Hook detection

```rust
fn has_hook(params: &DynamicParams) -> bool {
    params.swap_hook != Address::zero()
}

fn has_dynamic_fees(params: &DynamicParams) -> bool {
    params.swap_hooked_operations & 0x02 != 0  // EULER_SWAP_HOOK_GET_FEE
}

fn has_after_swap(params: &DynamicParams) -> bool {
    params.swap_hooked_operations & 0x04 != 0  // EULER_SWAP_HOOK_AFTER_SWAP
}
```

### Fee resolution

```rust
fn resolve_fee(params: &DynamicParams, asset0_is_input: bool) -> u64 {
    // If hook provides dynamic fees, fee0/fee1 in DynamicParams will be 0.
    // The actual fee comes from hook.getFee() which must be called via eth_call.
    // For pools without hooks, use fee0/fee1 directly.
    if has_dynamic_fees(params) {
        // Must call hook.getFee(asset0_is_input, reserve0, reserve1, true) via eth_call
        // Cache result per block per direction
        unimplemented!("call hook via eth_call")
    } else {
        if asset0_is_input { params.fee0 } else { params.fee1 }
    }
}
```

### Pool filtering

```rust
fn is_active(pool: &Pool, now: u64) -> bool {
    let not_expired = pool.params.expiration == 0 || pool.params.expiration > now;
    let is_unlocked = pool.reserves.status == 1;
    not_expired && is_unlocked
}
```

## Config Details

### Full TOML schema

```toml
[[liquidity.euler-swap]]
# Required: registry contract address for pool discovery
registry = "0x5FcCB84363F020c0cADE052C9c654aABF932814A"

# Optional: gas estimate per swap (default: 150000)
gas-estimate = 150000

# Optional: how often to refresh pool list from registry, in seconds (default: 300)
discovery-interval = 300

# Optional: specific pool addresses to always include (skip registry discovery)
# pools = ["0x4311031739918Aba578C3C667DA3028A12Ce28A8"]
```

### Multi-chain support

Use the canonical addresses from `euler-xyz/euler-interfaces`:

```toml
# Mainnet
[[liquidity.euler-swap]]
registry = "0x5FcCB84363F020c0cADE052C9c654aABF932814A"

# Base (if deployed)
# [[liquidity.euler-swap]]
# registry = "0x..."
```

## Testing Guide

### Unit tests (curve math, Phase 2)

Use test vectors from `test-vectors.json`. For each pool:

```rust
#[test]
fn test_usdc_weth_exact_in() {
    let pool = load_pool_state("pool_usdc_weth");  // from test-vectors.json

    // 1 WETH -> ~2055 USDC
    let out = pool.get_amount_out(
        USDC,
        (WETH, U256::from(1_000_000_000_000_000_000u128)),
    );
    assert_eq!(out, Some(U256::from(2_055_313_102u64)));
}
```

### Integration test (mainnet fork)

```rust
#[tokio::test]
async fn test_pool_discovery_and_quotes() {
    // Fork mainnet at block 24655259
    let web3 = fork_mainnet(24655259);

    // Discover pools
    let registry = EulerSwapRegistry::new(REGISTRY_ADDR, &web3);
    let pools = registry.pools().await.unwrap();
    assert_eq!(pools.len(), 4);

    // Compare native quotes with on-chain computeQuote
    for pool in &pools {
        let on_chain = pool.compute_quote(WETH, USDC, 1e18, true).await;
        let native = curve_math::compute_quote(&pool.state, WETH, USDC, 1e18, true);
        assert_eq!(on_chain, native);
    }
}
```

### Settlement simulation

```rust
#[tokio::test]
async fn test_settlement_with_euler_swap() {
    let web3 = fork_mainnet(24655259);

    // Fund settlement contract with 1 WETH
    // Encode interactions: transfer + swap
    // Execute settlement
    // Verify USDC received matches quote
}
```

Test framework: `tokio::test` with `ethcontract`'s forking support or Foundry's `anvil --fork-url`.
