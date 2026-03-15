# 1inch Fusion Resolver for EulerSwap

Fill 1inch Fusion intent orders by routing through EulerSwap pools.

## Architecture

```
1inch Fusion API (active orders)
        ↓
  Filler bot (TypeScript)
  - Poll for target pair orders (configurable per chain)
  - Piecewise linear auction decay resolution
  - Evaluate profitability vs EulerSwap quote
  - Build LOP fillOrderArgs calldata with correct TakerTraits
  - Pool lifecycle checks (expired, locked, uninstalled, fee >= 100%)
        ↓
  OneInchFusionResolver contract (settleOrders)
        ↓
  1inch Limit Order Protocol V4
  - Transfers maker tokens to resolver
  - Calls takerInteraction()
        ↓
  Resolver swaps on EulerSwap pool
  - Receives maker tokens
  - Swaps through EulerSwap (with amountOut > 0 guard)
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
# Monitor mode (read-only, evaluates profitability) — defaults to mainnet
ONEINCH_API_KEY=xxx npx tsx integrations/1inch-fusion/filler.ts

# Live mode (fills profitable orders)
ONEINCH_API_KEY=xxx PRIVATE_KEY=0x... RESOLVER_ADDRESS=0x... npx tsx integrations/1inch-fusion/filler.ts --live

# Different chain
CHAIN_ID=42161 ONEINCH_API_KEY=xxx npx tsx integrations/1inch-fusion/filler.ts
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_RPC_URL` | Yes | RPC endpoint |
| `ONEINCH_API_KEY` | Yes | 1inch Developer Portal API key |
| `CHAIN_ID` | No | Chain ID (default: 1 = Ethereum mainnet) |
| `PRIVATE_KEY` | --live | Resolver owner wallet private key |
| `RESOLVER_ADDRESS` | --live | Deployed OneInchFusionResolver address |
| `FLASHBOTS_AUTH_KEY` | No | Throwaway key for Flashbots bundle mode (mainnet only) |
| `MIN_PROFIT_BPS` | No | Minimum profit threshold (default: 5) |
| `MAX_GAS_GWEI` | No | Skip fills above this gas price (default: 50) |
| `POLL_INTERVAL_MS` | No | Polling interval in ms (default: 2000) |

## Multichain Support

The integration uses a chain config registry (`types.ts`) that maps chain IDs to pool
addresses, token pairs, and decimals. To add a new chain:

1. Add the chain config to `CHAIN_CONFIGS` in `types.ts`
2. Deploy `OneInchFusionResolver` on that chain (constructor takes LOP address)
3. Approve both tokens to the LOP via `resolver.approveToken()`
4. Set `CHAIN_ID`, `RESOLVER_ADDRESS`, and chain-specific `NEXT_PUBLIC_RPC_URL`

LOP V4 is at the same address (`0x111111125421cA6dc452d289314280a0f8842A65`) on all
EVM chains except zkSync. The 1inch Fusion API uses the chain ID as a path parameter.

**Flashbots**: Only available on Ethereum mainnet. On other chains, transactions are
submitted directly to the mempool.

## Pool Lifecycle

The bot checks pool status before evaluating orders each cycle:

- **Not installed**: Pool uninstalled from EVC — skip all orders
- **Expired**: Pool past its expiration timestamp — skip all orders
- **Locked**: Pool in locked state (e.g. mid-swap) — skip this cycle
- **Fee >= 100%**: Hook has set fee to reject swaps — skip all orders
- **computeQuote reverts**: Pool can't quote (e.g. insufficient liquidity) — order scored as unprofitable

When a pool is decommissioned (hook reinstalled = new pool address), update the
`CHAIN_CONFIGS` entry in `types.ts` and restart the bot.

## Contracts

- **OneInchFusionResolver.sol** (`contracts/src/`): Implements `ITakerInteraction`. Receives maker tokens from LOP, swaps on EulerSwap, LOP pulls taker tokens.
- **LOP V4**: `0x111111125421cA6dc452d289314280a0f8842A65` (same on all EVM chains)

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

### LOP V4 ABI: UDVT Address Types

The LOP V4 Order struct uses `type Address is uint256` (Solidity UDVT). UDVTs compile
to their underlying type in the ABI, so all Order fields are `uint256` in the canonical
function signature — NOT `address`. Using `address` would produce the wrong 4-byte
selector and every call would revert.

### EIP-712 Domain

The LOP V4 uses EIP-5267 `eip712Domain()` to expose its domain separator. The actual
domain name is `"1inch Aggregation Router"` version `"6"` — not the protocol name.

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

Note: `remainingMakerAmount` is checked with explicit null/empty checks (not `||`)
to correctly handle the `"0"` case for fully-filled orders.

## Operational Notes

- **Error backoff**: Consecutive poll errors trigger exponential backoff (1s, 2s, 4s, ... up to 30s)
- **Tx confirmation**: Live mode waits up to 60s for transaction receipt after submission
- **Fetch timeout**: API requests timeout after 10s (configurable)
- **Rate limiting**: Built-in 3 req/s rate limiter for the 1inch API
- **Gas price check**: In live mode, skips fills when base fee exceeds `MAX_GAS_GWEI`
- **Pool asset validation**: On startup, verifies pool assets match the chain config
