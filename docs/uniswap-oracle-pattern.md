# Uniswap spot as a fee oracle

A pattern that's "unsafe" for collateral pricing but **safe and useful for fee modulation**, exploited throughout [DynamicFeeAuctionHook](../contracts/src/DynamicFeeAuctionHook.sol).

This doc explains what the pattern is, why it works, when it breaks, and how to use it in your own hook.

---

## TL;DR

```
Hook reads Uniswap spot → if AMM is offering an arb, raise the fee.
Hook never lowers the fee below baseFee.
→ Manipulating the oracle can only cost the attacker more on their own swap.
```

The cheapest, freshest, most-manipulable price feed in DeFi is exactly what you want for fee bumping. The same feed is *not* what you want for liquidations.

---

## Why people say spot is unsafe

A standard concern about using Uniswap's `slot0` as an oracle:

- `slot0` returns the **instantaneous** price after the most recent swap.
- Anyone can move `slot0` in a single block by trading the pool in either direction.
- A small Uniswap pool can be pushed 10%+ off true price for ~$50 in capital.
- A protocol that reads `slot0` and lets you borrow against an inflated collateral value can be drained instantly.

This is the [Aave / Compound spot-vs-TWAP debate](https://blog.uniswap.org/uniswap-v3-oracles). For pricing **collateral**, you want TWAP, Chainlink, Euler's price oracle stack — anything but spot.

---

## Why spot is safe for fee bumping

The hook only uses spot to answer one question:

> "Is the AMM currently offering an arbitrage against itself, relative to Uniswap?"

If yes, raise the fee. If no, leave it at base.

Crucially, **the hook never returns a fee below `baseFee`**. Look at [`DynamicFeeAuctionHook._dynamicFee()`](../contracts/src/DynamicFeeAuctionHook.sol):

```solidity
// In attract mode (AMM is competing for retail flow):
//   fee = baseFee + (something that can only push fee up)
// In capture mode (AMM is offering an arb):
//   fee = baseFee + captureRate × oracleDelta
// If oracle reverts:
//   fee = baseFee   (full fallback)
```

Now imagine an attacker manipulates the Uniswap pool to push spot in either direction:

| Attacker pushes spot... | Hook reaction | Effect on attacker |
|---|---|---|
| Up | Sees larger arb in capture direction → raises capture fee | Higher fee paid on the swap they want to do |
| Down | Mirror — opposite direction's capture fee rises | Same |
| Toward AMM's eq price | Sees zero arb → fee stays at base | No change, no benefit |

**There's no direction the attacker can push the oracle that lowers the fee.** Manipulation costs Uniswap-pool fees (their swap to move spot) and increases the fee on the AMM swap they ultimately want to do. It's strictly losing.

The closest thing to a "fee oracle attack" is: push spot toward what the attacker would have to pay normally, making them pay an unjustified extra capture fee. But this requires *first* moving spot, *then* swapping — and the first move requires paying Uniswap fees on a meaningful trade. It's never net-positive.

---

## How the hook reads spot

Two source flavors, both via a single `staticcall`:

### Uniswap V3

```solidity
interface IUniswapV3Pool {
    function slot0() external view returns (
        uint160 sqrtPriceX96, int24, uint16, uint16, uint16, uint8, bool
    );
}

function _readV3SqrtPrice() internal view returns (uint160) {
    try IUniswapV3Pool(oracleTarget).slot0() returns (
        uint160 sqrtPriceX96, int24, uint16, uint16, uint16, uint8, bool
    ) {
        return sqrtPriceX96;
    } catch {
        return 0;  // fall back to baseFee
    }
}
```

`oracleTarget` is set at deploy time to the deepest V3 pool for the pair. For USDC/WETH that's `0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640` (the 0.05% pool).

### Uniswap V4

V4's PoolManager is a singleton — no per-pool address. State is keyed by pool ID. To read spot you'd normally have to import PoolManager's view library, but V4 also exposes `extsload(slot)` which lets you read any storage slot directly:

```solidity
interface IExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

function _readV4SqrtPrice() internal view returns (uint160) {
    // PoolManager's _pools mapping is at storage slot 6.
    // Slot for a given poolId: keccak256(abi.encode(poolId, bytes32(uint256(6))))
    // First word of that struct holds slot0, low 160 bits = sqrtPriceX96.
    bytes32 stateSlot = keccak256(abi.encode(oracleV4PoolId, bytes32(uint256(6))));
    try IExtsload(oracleTarget).extsload(stateSlot) returns (bytes32 packed) {
        return uint160(uint256(packed));
    } catch {
        return 0;
    }
}
```

This is shorter and cheaper than importing PoolManager's full ABI — one `staticcall`, one storage slot, one cast. Just be aware that you're now coupled to the layout of `_pools` (slot 6 in the current PoolManager). If PoolManager is ever redeployed with different storage, you'd need to update.

### Converting sqrtPriceX96 to a WAD price

Same for both V3 and V4. Uniswap stores `sqrt(price) × 2^96` to maintain precision; convert to WAD-scaled price:

```solidity
uint256 sqrtPrice = uint256(sqrtPriceX96);
uint256 priceWad;
if (sqrtPrice <= type(uint128).max) {
    priceWad = (sqrtPrice * sqrtPrice).mulDiv(WAD, Q192);
} else {
    // sqrtPrice² overflows 256 bits — split the multiply
    priceWad = sqrtPrice.mulDiv(sqrtPrice, Q64).mulDiv(WAD, Q128);
}
```

`Q192 = 2**192`, `Q128 = 2**128`, `Q64 = 2**64`.

Then if Uniswap's `token0` doesn't match your pool's `asset0`, invert: `priceWad = WAD * WAD / priceWad`. The hook decides which path at deploy time and stores the flag as `oracleToken0IsAsset0`.

---

## Safety guarantees in the hook

The hook codifies the "fees only, never below base" property in three places:

1. **`getFee` clamps below `baseFee`** — even during an auction the fee is `max(baseFee, decayedAuctionFee)`.
2. **`_computeNormalFee` adds positive contributions only** — capture and attract terms are both `baseFee + something ≥ 0`.
3. **Oracle failure → `baseFee`** — `try/catch` around `slot0` and `extsload`. If the oracle reverts (paused, removed, anything), the hook falls back, not blocks.

If you're forking DynamicFeeAuctionHook or writing a new hook from [`MinimalHook.sol`](../contracts/src/MinimalHook.sol), keep these three invariants. Any deviation needs careful analysis.

---

## When this pattern *doesn't* work

You can't use this pattern if:

- **Your hook needs to lower fees on oracle signals.** "Refund part of the fee when spot says we got picked off" is exactly the manipulable case.
- **The fee response is non-monotonic in oracle price.** If pushing oracle one way *or the other* benefits the attacker, manipulation pays.
- **No deep Uniswap pool exists for the pair.** A thin V3/V4 pool is cheap to move and may not be a useful spot reference anyway. Pick a pair where Uniswap has real depth.
- **You're depending on the oracle for collateral or liquidation logic.** Use TWAP or Euler's [price-oracle](../contracts/euler-price-oracle/) for that — never spot.

---

## Recipe: adding this to your own hook

Starting from [`MinimalHook.sol`](../contracts/src/MinimalHook.sol):

1. Add `oracleTarget`, `oracleV4PoolId`, `oracleToken0IsAsset0` immutables and an `OracleConfig` struct in the constructor.
2. Add `_readV3SqrtPrice` / `_readV4SqrtPrice` / `_getUniswapPrice` (copy from DynamicFeeAuctionHook, ~50 lines total).
3. In `getFee`, compute the AMM's marginal price from `reserve0, reserve1` (use [`_getMarginalPrice`](../contracts/src/DynamicFeeAuctionHook.sol) as reference).
4. Compare `marginalPrice` vs `uniPrice`. Return `baseFee + f(delta)` where `f ≥ 0`.
5. `try/catch` the oracle read and fall back to `baseFee` on failure.
6. Update the pool's `swapHookedOperations` to include `EULER_SWAP_HOOK_GET_FEE` (the bit is already set on the `MinimalHook` deploy).

That's an oracle-reactive hook in ~150 lines. Add auctions, surcharges, recenters, etc. as separate layers when you need them.

---

## Prior art

- [Uniswap V3 oracle docs](https://docs.uniswap.org/concepts/protocol/oracle) — TWAP design, why spot is generally unsafe
- [Uniswap V4 PoolManager](https://github.com/Uniswap/v4-core/blob/main/src/PoolManager.sol) — `extsload` exposure
- [EulerSwap whitepaper](https://github.com/euler-xyz/euler-swap) — hook interface design
- [DynamicFeeAuctionHook](../contracts/src/DynamicFeeAuctionHook.sol) — production implementation of this pattern
