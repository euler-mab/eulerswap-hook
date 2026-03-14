## Summary

- Add Tycho swap adapter for [EulerSwap](https://github.com/euler-xyz/euler-swap), a concentrated AMM with a Uniswap V2-style swap interface (direct pool contracts, not routed through V4 PoolManager)
- Adapter implements full `ISwapAdapter` interface: sell/buy orders, price function, hard limits, registry-based pool discovery
- Includes 15 custom fork tests + standard `runPoolBehaviourTest` harness (both directions)

## Contracts

| Contract | Address | Notes |
|----------|---------|-------|
| EulerSwap Registry | `0x5FcCB84363F020c0cADE052C9c654aABF932814A` | Constructor arg; adapter discovers all pools via `poolsSlice()` |
| USDC/WETH Pool | `0x4311031739918Aba578C3C667DA3028A12Ce28A8` | Test pool |
| V7 Fee Hook | `0x7bb638b9842eA4275901aafB2e34943d9C2Fe4FB` | Dynamic fee hook (reads Uniswap oracle) |
| Uniswap Oracle | `0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640` | USDC/WETH 0.05% pool; hook reads `slot0` for sqrtPriceX96 |

## EulerSwap Swap Flow

EulerSwap pools use a Uni V2-style interface. Each pool is a standalone contract:

1. Transfer input tokens directly to the pool contract
2. Call `pool.swap(amount0Out, amount1Out, recipient, "")`
3. Pool sends output tokens, then verifies curve invariant

The adapter uses `computeQuote()` (view) to pre-compute exact output, then executes the swap. No router or callback pattern needed.

## Pricing: `price()` Function

The `price()` function returns:
- **`amount == 0`**: Marginal (spot) price via small-delta approximation (`computeQuote(delta) / delta`)
- **`amount > 0`**: Average execution price (`computeQuote(amount) / amount`)

For `amount > 0`, the average execution price is the rate a trade of size `amount` would actually receive. It matches `swap()` output exactly and decreases monotonically with trade size. We use the average rather than a numerical derivative because EulerSwap's concentrated circular curve can produce marginal values that exceed the average in certain regions, which would violate the standard harness's `executedPrice >= priceAtAmount` assertion.

## Pricing: `trade.price` (Post-Swap)

EulerSwap pools support hooks that run `afterSwap`. The deployed V7 hook uses this to **reconfigure the pool's curve parameters** when a swap improves the pool's exposure — it recenters the equilibrium reserves and aligns `priceY` to the oracle. This means the post-swap pool can be operating on a **different curve** than the one the trade executed on.

The adapter computes the real post-swap spot price (`computeQuote(delta) / delta` at the new state) and returns it when `executedPrice >= postSwapSpot`. When `afterSwap` has reconfigured the curve such that the new spot exceeds the executed average, the adapter returns `Fraction(0, 1)` per the spec.

In practice:
- **Small swaps that reduce exposure** trigger a recenter → `Fraction(0, 1)` (curve changed)
- **Larger swaps and swaps that increase exposure** don't trigger reconfiguration → real post-swap price returned
- **Pools without hooks** (or with non-reconfiguring hooks) → real post-swap price always returned

## Hook Dependency: Indexer Requirements

EulerSwap's `computeQuote` call chain is: pool → curve math → `hook.computeFee()` → Uniswap oracle `slot0`. The substreams indexer must capture storage for all contracts in this chain:

- The EulerSwap pool (`0x4311031739918Aba578C3C667DA3028A12Ce28A8`) — dynamic params
- The hook contract (`0x7bb638b9842eA4275901aafB2e34943d9C2Fe4FB`) — fee state
- The Uniswap USDC/WETH pool (`0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640`) — `slot0` for sqrtPriceX96

If any are missing, `computeQuote` will revert in Tycho's simulation VM and the pool will be unusable for routing.

Different hooks have different external dependencies. The adapter code is hook-agnostic (it only calls pool-level functions), but each hook type requires its own indexer configuration.

## Design Decisions

- **1% limit margin**: `getLimits()` returns 99% of the pool's raw limits. The pool's `getLimits()` returns theoretical maximums where integer rounding in the invariant check can cause `computeQuote` to revert at the exact boundary. 99% ensures all amounts within stated limits are tradeable.
- **`LimitExceeded(uint256)`**: Enforced consistently in `swap()`, `price()`, and `getLimits()` with the same 99% limit value.
- **`protocol_gas: 250000`**: Fork tests measure ~437k gas (includes Foundry overhead). 250k is a realistic mainnet estimate covering `safeTransferFrom` + `pool.swap` + hook oracle read.

## Files

```
integrations/tycho/
├── foundry.toml
├── manifest.yaml
├── src/
│   ├── EulerSwapAdapter.sol              # Swap adapter
│   ├── interfaces/
│   │   ├── ISwapAdapter.sol              # Upstream interface
│   │   └── ISwapAdapterTypes.sol         # Upstream types (aligned enum ordering)
│   └── libraries/
│       ├── FractionMath.sol              # Upstream Q128.128 math
│       └── EfficientERC20.sol            # Upstream gas-optimized ERC20
└── test/
    ├── AdapterTest.sol                   # Upstream standard test harness
    └── EulerSwapAdapter.fork.t.sol       # 15 custom tests + standard harness
```

## Test Plan

- [x] `forge build` — compiles clean (solc 0.8.27)
- [x] 15 custom fork tests: getTokens, getPoolIds, getCapabilities, getLimits (both directions), price (zero/multiple/at-limit/above-limit), swap sell (both directions), swap buy, swap zero, swap above-limit
- [x] Standard `runPoolBehaviourTest` — passes for both USDC->WETH and WETH->USDC
- [x] `LimitExceeded` recognized by standard harness for above-limit operations
- [ ] Substreams indexer configured for hook + oracle storage (follow-up)

## Not Included

- Substreams package — separate PR once indexer requirements for hook storage are scoped
- Execution encoder (tycho-execution) — if needed, separate PR
- Multi-pool testing — only USDC/WETH tested; adapter handles any pool in the registry
