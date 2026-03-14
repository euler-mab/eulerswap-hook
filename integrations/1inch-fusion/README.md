# 1inch Fusion Resolver for EulerSwap

Fill 1inch Fusion intent orders by routing through EulerSwap's USDC/WETH pool.

## Architecture

```
1inch Fusion API (active orders)
        ↓
  Filler bot (TypeScript)
  - Poll for USDC/WETH orders
  - Piecewise linear auction decay resolution
  - Evaluate profitability vs EulerSwap quote
  - Build LOP fillOrderArgs calldata with correct TakerTraits
        ↓
  OneInchFusionResolver contract (settleOrders)
        ↓
  1inch Limit Order Protocol V4
  - Transfers maker tokens to resolver
  - Calls takerInteraction()
        ↓
  Resolver swaps on EulerSwap pool
  - Receives maker tokens
  - Swaps through EulerSwap
  - LOP pulls taker tokens via transferFrom
```

## Prerequisites

1. **1inch API key**: Get one at [portal.1inch.dev](https://portal.1inch.dev)
2. **Resolver status**: Must be a registered 1inch Fusion resolver. See [resolver docs](https://docs.1inch.io/docs/fusion-swap/becoming-a-resolver/how-to-become-resolver/). Requires either:
   - Being in the order's whitelist (the `allowFrom` timestamp controls eligibility), OR
   - Holding the 1inch Access Token (`0xAccE550000863572B867E661647CD7D97b72C507`)
3. **Deployed resolver contract**: `OneInchFusionResolver.sol` from `contracts/src/`

## Fee Model

The current Settlement extension (V2/V3) does **not** use a Fee Bank. Fees are carved
automatically from the `takingAmount` as a percentage (integrator fee + protocol fee +
surplus fee). The resolver does not need to pre-deposit anything.

This is different from the V1 Settlement which required 1INCH deposits to a Fee Bank contract.

## Usage

```bash
# Monitor mode (read-only, evaluates profitability)
ONEINCH_API_KEY=xxx npx tsx integrations/1inch-fusion/filler.ts

# Live mode (fills profitable orders)
ONEINCH_API_KEY=xxx PRIVATE_KEY=0x... RESOLVER_ADDRESS=0x... npx tsx integrations/1inch-fusion/filler.ts --live
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_RPC_URL` | Yes | Ethereum RPC endpoint |
| `ONEINCH_API_KEY` | Yes | 1inch Developer Portal API key |
| `PRIVATE_KEY` | --live | Resolver owner wallet private key |
| `RESOLVER_ADDRESS` | --live | Deployed OneInchFusionResolver address |
| `FLASHBOTS_AUTH_KEY` | No | Throwaway key for Flashbots bundle mode |
| `MIN_PROFIT_BPS` | No | Minimum profit threshold (default: 5) |
| `MAX_GAS_GWEI` | No | Skip fills above this gas price (default: 50) |
| `POLL_INTERVAL_MS` | No | Polling interval in ms (default: 2000) |

## Contracts

- **OneInchFusionResolver.sol** (`contracts/src/`): Implements `ITakerInteraction`. Receives maker tokens from LOP, swaps on EulerSwap, LOP pulls taker tokens.
- **LOP V4**: `0x111111125421cA6dc452d289314280a0f8842A65`
- **Settlement (current)**: `0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5`
- **Settlement (previous)**: `0xfb2809a5314473e1165f6b58018e20ed8f07b840`

## Key Implementation Details

### TakerTraits Encoding

The `fill.ts` constructs `TakerTraits` matching the LOP V4's exact bit layout
(from `TakerTraitsLib.sol`):

| Bits | Field |
|------|-------|
| 255 | Maker amount flag (1 = fill amount is making amount) |
| 254 | Unwrap WETH flag |
| 253 | Skip order permit flag |
| 252 | Use permit2 flag |
| 251 | Args has target (first 20 bytes = delivery address) |
| 224-247 | Extension length (24 bits) |
| 200-223 | Interaction length (24 bits) |
| 0-184 | Threshold amount |

The `args` bytes are raw concatenation: `[extension][interaction]`,
where interaction = `[20-byte resolver address][extraData]`.

### Auction Decay

Uses piecewise linear interpolation matching the 1inch Fusion SDK's
`AuctionCalculator`. The rate bump decays through configurable points:

```
resolvedTakingAmount = baseTakingAmount * (rateBump + 10_000_000) / 10_000_000
```

Where `rateBump` is interpolated between auction points and decays to 0 at
auction end. Points define `(delay, coefficient)` pairs for the piecewise curve.

### Partial Fills

When `remainingMakerAmount < makingAmount`, the `takingAmount` is scaled
proportionally: `takingAmount * remaining / total`.
