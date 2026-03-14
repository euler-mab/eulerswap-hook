# 1inch Fusion Resolver for EulerSwap

Fill 1inch Fusion intent orders by routing through EulerSwap's USDC/WETH pool.

## Architecture

```
1inch Fusion API (active orders)
        ↓
  Filler bot (TypeScript)
  - Poll for USDC/WETH orders
  - Evaluate profitability vs EulerSwap quote
  - Build LOP fillOrderArgs calldata
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
2. **Resolver status**: Must be a registered 1inch Fusion resolver (requires staking + KYC). See [resolver docs](https://docs.1inch.io/docs/fusion-swap/becoming-a-resolver/how-to-become-resolver/).
3. **Deployed resolver contract**: `OneInchFusionResolver.sol` from `contracts/src/`

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

- **OneInchFusionResolver.sol** (`contracts/src/`): Resolver contract that implements `ITakerInteraction`. Receives maker tokens from LOP, swaps on EulerSwap, LOP pulls taker tokens.
- **LOP V4**: `0x111111125421cA6dc452d289314280a0f8842A65`
- **Settlement**: `0xfb2809a5314473e1165f6b58018e20ed8f07b840`

## Limitations

- **Resolver registration required**: Must stake 1INCH and complete KYC to fill Fusion orders. A governance proposal may lower the staking threshold.
- **TakerTraits encoding**: The `fill.ts` uses a simplified TakerTraits construction. Production fills may require the Fusion SDK for proper encoding of extension/interaction offsets.
- **Single-order fills**: Each order is filled individually (no batching like UniswapX). The LOP's fill function processes one order at a time.
