# EulerSwap Settlement Encoding Specification

How to encode EulerSwap swaps as CoW Protocol settlement interactions.

## Swap Pattern

EulerSwap uses the **Uniswap V2 swap pattern**: transfer input tokens to the pool contract, then call `swap()`. The pool reads its own balance to determine how much was deposited.

## Settlement Interactions

Each EulerSwap swap requires **two interactions** in the CoW settlement:

### Interaction 1: Transfer Input Tokens to Pool

```
target:   inputToken (ERC20 contract)
value:    0
calldata: transfer(pool, amountIn)
```

ABI encoding:
```
selector: 0xa9059cbb  (ERC20.transfer)
params:   (address pool, uint256 amountIn)
```

The CoW settlement contract holds the input tokens (collected from user orders). It transfers them directly to the pool.

### Interaction 2: Execute Swap

```
target:   pool (EulerSwap contract)
value:    0
calldata: swap(amount0Out, amount1Out, settlement, "")
```

ABI encoding:
```
selector: 0x022c0d9f  (same as Uniswap V2)
params:   (uint256 amount0Out, uint256 amount1Out, address to, bytes data)
```

Where:
- If input is asset0: `amount0Out = 0`, `amount1Out = outputAmount`
- If input is asset1: `amount0Out = outputAmount`, `amount1Out = 0`
- `to` = settlement contract address (receives output tokens)
- `data` = `""` (empty bytes, no flash-swap callback)

## Interaction Placement

These interactions go in the settlement's **intra-settlement interactions** (index 1):

```solidity
GPv2Settlement.settle(
    tokens,
    clearingPrices,
    trades,
    [
        preInteractions,      // [0] — pre-settlement
        intraInteractions,    // [1] — EulerSwap interactions go here
        postInteractions      // [2] — post-settlement
    ]
);
```

## Gas Estimation

Estimated gas per EulerSwap swap: **~150,000 gas**

This includes:
- ERC20 transfer to pool
- Pool's swap logic (curve verification, vault deposit/withdrawal)
- Hook execution (getFee + afterSwap if enabled)
- Vault operations on the Euler lending layer

The actual gas varies based on:
- Whether the swap creates new debt or repays existing debt
- Whether the hook triggers a recenter or auction
- ERC20 token implementation (some are more gas-intensive)

Recommend measuring empirically with `cast estimate` or from historical swap transactions.

## Example: Swap 1 WETH for USDC

Pool: `0x4311031739918Aba578C3C667DA3028A12Ce28A8`
- asset0 = USDC (`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`)
- asset1 = WETH (`0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`)

Input: 1 WETH (asset1), Output: ~2500 USDC (asset0)
Since input is asset1 → `amount0Out = 2500e6`, `amount1Out = 0`

```
Interaction 1:
  target:   0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 (WETH)
  calldata: transfer(0x4311...28A8, 1000000000000000000)

Interaction 2:
  target:   0x4311031739918Aba578C3C667DA3028A12Ce28A8 (pool)
  calldata: swap(2500000000, 0, 0x9008D19f58AAbD9eD0D60971565AA8510560ab41, "")
                 ^ USDC out   ^ no WETH out  ^ settlement contract
```

## Token Ordering

EulerSwap pools always have `asset0 < asset1` (sorted by address). Check with `pool.getAssets()` to confirm which token is asset0 vs asset1 before encoding the swap.

## Error Handling

The swap will revert if:
- Insufficient input tokens transferred
- Output exceeds available reserves
- Pool is expired
- Pool operator is not installed
- Curve invariant would be violated
- Fee is 100% (swap rejected by hook)

The driver should pre-validate using `computeQuote()` or native curve math before including the interaction in a solution.

## No Approval Needed

The settlement contract does NOT need to approve the pool. Tokens are sent via `transfer()`, not pulled via `transferFrom()`. The pool reads its own balance change.
