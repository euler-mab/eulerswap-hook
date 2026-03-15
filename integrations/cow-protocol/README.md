# CoW Protocol Driver Integration for EulerSwap

## Overview

This directory contains specifications, ABIs, and test vectors for adding EulerSwap as a native liquidity source in the [CoW Protocol driver](https://github.com/cowprotocol/services). When integrated, **all CoW solvers** will automatically discover and route through EulerSwap pools when they offer competitive pricing.

## What is EulerSwap?

EulerSwap is a concentrated constant-product AMM built on Euler V2's lending layer. Each pool is a per-LP venue with:

- **Concentrated liquidity** via a tunable concentration parameter (0 = constant-product, 1 = constant-sum)
- **Leverage from lending** — virtual reserves are boosted by Euler vault deposits, so a pool with $8k in deposits can provide liquidity equivalent to millions in virtual reserves
- **Dynamic fees** — hook contracts adjust fees based on oracle prices, exposure, and orderflow quality
- **On-chain quoting** — `computeQuote()` view function returns exact output amounts with fees applied

The swap interface is Uniswap V2-compatible: transfer tokens to the pool, then call `swap(amount0Out, amount1Out, to, data)`.

## Why Add to the CoW Driver?

The driver is shared infrastructure used by all solvers. Adding EulerSwap here means:
- Every solver sees EulerSwap pools as available liquidity
- Solvers compete to route through EulerSwap when it offers the best price
- EulerSwap gets retail orderflow (its primary goal) without running a standalone solver

## Contract Addresses (Mainnet)

| Contract | Address |
|----------|---------|
| Registry (V2) | `0x5FcCB84363F020c0cADE052C9c654aABF932814A` |
| Factory (V2) | `0xD05213331221fAB8a3C387F2affBb605Bb04DF5F` |
| Periphery (V2) | `0xD3a349EE0A21eA0A7E9513ac236ae614b5FD513E` |
| USDC/WETH Pool | `0x4311031739918Aba578C3C667DA3028A12Ce28A8` |

Canonical addresses for all chains: [euler-xyz/euler-interfaces](https://github.com/euler-xyz/euler-interfaces/tree/master/addresses)

## Integration Approach

### Phase 1: eth_call (current)

All quoting delegates to the on-chain `computeQuote()` view function via `eth_call`.
No Rust curve math port is needed. This approach:

- Guarantees quote parity with the contract (no reimplementation bugs)
- Automatically handles dynamic fees from hooks (`getFee()` is called internally)
- Adds one RPC round-trip per quote (~10-50 ms depending on node)

In practice, this latency has not been a bottleneck — the solver batches quotes and
EulerSwap is one venue among many, so per-quote cost doesn't dominate auction timing.

### Phase 2: Native Rust Curve Math (deferred)

A specification exists in `spec/curve-math.md` with test vectors for porting the curve
math to Rust for sub-ms offline quoting. This is **not currently needed** — Phase 1
performance is sufficient. The spec and test vectors are maintained so this can be built
if latency requirements change, but implementing it now would create maintenance burden
(tracking upstream CurveLib rounding changes, dynamic fee interactions) for a performance
problem that doesn't exist.

## Directory Structure

```
integrations/cow-protocol/
  README.md                         # This file
  addresses.json                    # Deployed contract addresses
  abi/
    IEulerSwap.json                 # Pool interface ABI
    IEulerSwapRegistry.json         # Registry interface ABI
    IEulerSwapHookTarget.json       # Hook interface ABI (getFee, beforeSwap, afterSwap)
  spec/
    architecture-primer.md          # How the CoW driver works and where EulerSwap fits
    curve-math.md                   # Mathematical specification for Rust porting
    pool-fetching.md                # Pool discovery and state caching
    settlement-encoding.md          # Swap calldata encoding for CoW settlement
    cow-pr-guide.md                 # Guide for the PR to cowprotocol/services
    test-vectors.json               # Known-good quote results from 3 pools (31 vectors)
```

## Key Pool Interface

```solidity
// Quoting (view, no gas)
function computeQuote(address tokenIn, address tokenOut, uint256 amount, bool exactIn)
    external view returns (uint256);

// Swap limits
function getLimits(address tokenIn, address tokenOut)
    external view returns (uint256 limitIn, uint256 limitOut);

// Execution (Uniswap V2-style)
function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data)
    external;

// State inspection
function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 status);
function getDynamicParams() external view returns (DynamicParams memory);
function getStaticParams() external pure returns (StaticParams memory);
function getAssets() external view returns (address asset0, address asset1);
```

## Related Documentation

- [EulerSwap docs](https://docs.euler.finance/euler-swap/overview/)
- [Rebalance auction design](../../docs/rebalance-auction-design.md)
- [CoW Protocol solver docs](https://docs.cow.fi/cow-protocol/concepts/introduction/solvers)
