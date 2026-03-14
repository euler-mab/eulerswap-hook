# EulerSwap Pool Fetching Specification

How to discover and cache EulerSwap pool state for the CoW Protocol driver.

## Pool Discovery

EulerSwap pools are registered on-chain via `EulerSwapRegistry` at `0x5FcCB84363F020c0cADE052C9c654aABF932814A`.

### Registry Interface

```solidity
// Total pool count
function poolsLength() external view returns (uint256);

// Paginated pool list
function poolsSlice(uint256 start, uint256 end) external view returns (address[] memory);

// All pools (gas-intensive, use poolsSlice for large registries)
function pools() external view returns (address[] memory);

// Pools for a specific token pair
function poolsByPair(address asset0, address asset1) external view returns (address[] memory);
function poolsByPairLength(address asset0, address asset1) external view returns (uint256);

// Pool by Euler account
function poolByEulerAccount(address eulerAccount) external view returns (address);
```

### Discovery Algorithm

```
1. Call registry.poolsLength() to get total count
2. Call registry.poolsSlice(0, count) to get all pool addresses
   (or paginate in batches of 100 if count is large)
3. For each pool:
   a. Call pool.getAssets() → (asset0, asset1)
   b. Call pool.getStaticParams() → StaticParams (immutable, cache forever)
   c. Call pool.isInstalled() → bool (skip if false)
4. Build index: token_pair → [pool_address, ...]
```

**Refresh frequency:** Every 5-10 minutes. New pools are deployed infrequently.

## State Fetching (Per Block)

For each relevant pool (matching requested token pairs), fetch:

### 1. Current Reserves

```solidity
function getReserves() external view returns (
    uint112 reserve0,
    uint112 reserve1,
    uint32 status     // 0=unactivated, 1=unlocked, 2=locked
);
```

Skip pools with `status != 1`.

### 2. Dynamic Parameters

```solidity
function getDynamicParams() external view returns (DynamicParams memory);

struct DynamicParams {
    uint112 equilibriumReserve0;
    uint112 equilibriumReserve1;
    uint112 minReserve0;
    uint112 minReserve1;
    uint80 priceX;
    uint80 priceY;
    uint64 concentrationX;
    uint64 concentrationY;
    uint64 fee0;
    uint64 fee1;
    uint40 expiration;
    uint8 swapHookedOperations;
    address swapHook;
}
```

**Filter out:**
- Expired pools: `expiration != 0 && expiration <= block.timestamp`
- Uninstalled pools: `isInstalled() == false`
- Pools with 100% fee: `fee0 >= 1e18 || fee1 >= 1e18`

### 3. Swap Limits (optional, for accuracy)

```solidity
function getLimits(address tokenIn, address tokenOut)
    external view returns (uint256 limitIn, uint256 limitOut);
```

Limits account for vault supply caps, borrow caps, and available cash. More accurate than just using `reserve - minReserve` but requires extra RPC calls.

### Multicall Strategy

Batch all pool state reads into a single multicall per block:

```
For each pool:
  - getReserves()
  - getDynamicParams()
  - (optional) getLimits(asset0, asset1) + getLimits(asset1, asset0)
```

This minimizes RPC round trips. Each pool needs 2-4 calls, totaling ~6-8 calls per pool.

## Pool State Struct (Rust)

```rust
struct EulerSwapPool {
    address: Address,
    asset0: Address,
    asset1: Address,

    // Current reserves
    reserve0: u128,
    reserve1: u128,

    // Curve parameters
    equilibrium_reserve0: u128,
    equilibrium_reserve1: u128,
    min_reserve0: u128,
    min_reserve1: u128,
    price_x: U256,
    price_y: U256,
    concentration_x: u64,
    concentration_y: u64,

    // Fees
    fee0: u64,
    fee1: u64,

    // Limits (if fetched)
    limit_in_0to1: Option<U256>,
    limit_out_0to1: Option<U256>,
    limit_in_1to0: Option<U256>,
    limit_out_1to0: Option<U256>,

    // Metadata
    has_hook: bool,
    gas_estimate: u64,
}
```

## Initialization Pattern

Use `BackgroundInitLiquiditySource` to wrap the pool fetcher. This is a CoW driver pattern
that allows async initialization (registry discovery) without blocking the driver startup.
The first auction round may not include EulerSwap pools while discovery completes in the
background.

```rust
// In boundary/liquidity/euler_swap.rs
let fetcher = EulerSwapPoolFetcher::new(registry, web3.clone());
let source = BackgroundInitLiquiditySource::new(fetcher);
```

## Caching

### Block-based cache

EulerSwap pools with hooks (V7) can change parameters on every swap via continuous recentering. State should be refreshed every block for active pools.

```
PoolCache {
    pools: HashMap<Address, EulerSwapPool>,
    last_block: u64,

    fn fetch(&mut self, pairs: &[(Address, Address)], block: u64) {
        if block > self.last_block {
            // Refresh state for pools matching requested pairs
            self.update_state(pairs, block);
            self.last_block = block;
        }
    }
}
```

### Static params cache

`StaticParams` are immutable per pool. Cache at discovery time and never refresh:

```rust
struct StaticParams {
    supply_vault0: Address,
    supply_vault1: Address,
    borrow_vault0: Address,
    borrow_vault1: Address,
    euler_account: Address,
    fee_recipient: Address,
}
```

## Phase 1 vs Phase 2

### Phase 1 (eth_call)

Don't cache DynamicParams at all. For each quote request, call `computeQuote()` via eth_call:

```solidity
pool.computeQuote(tokenIn, tokenOut, amount, exactIn) → uint256
```

This is simple but adds ~50ms latency per quote. Suitable for initial integration.

### Phase 2 (native Rust)

Cache DynamicParams + reserves per block. Compute quotes in Rust using the curve math from `curve-math.md`. Zero latency per quote after state is cached.

For pools with hooks, `fee0`/`fee1` from DynamicParams may not reflect the actual dynamic fee. Options:
1. Call `hook.getFee()` via eth_call once per block per direction, cache the fee
2. Accept slight fee staleness (the hook fee changes based on reserves which change per swap)
3. Use `computeQuote()` via eth_call only for hooked pools

Option 1 is recommended for Phase 2.
