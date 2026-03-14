# UniswapX Filler for EulerSwap

Fill UniswapX intent orders by routing them through the EulerSwap USDC/WETH pool. Users sign off-chain swap intents that enter a Dutch auction — fill prices decay over time until a filler finds it profitable to execute. This integration monitors those orders, compares decay prices against EulerSwap quotes, and (optionally) fills profitable ones.

## How it works

```
User signs intent  →  UniswapX API  →  Filler bot polls for open orders
                                              ↓
                                    Filter USDC/WETH orders
                                              ↓
                                    Resolve decay at current time
                                              ↓
                              Call pool.computeQuote() for EulerSwap price
                                              ↓
                          Compare: eulerSwapOutput > requiredOutput + costs?
                                              ↓
                              YES → submit fill tx  |  NO → skip
```

### Fill modes

**Direct fill** — The filler wallet holds output tokens (inventory) and calls `reactor.execute()`. Lower gas, simpler, but requires capital.

**Callback fill** — Calls `reactor.executeWithCallback()` through the on-chain executor contract (`UniswapXFiller.sol`). The executor receives input tokens from the reactor, swaps through EulerSwap in the `reactorCallback`, and the reactor pulls output tokens via `transferFrom`. No inventory needed — capital-efficient but higher gas.

## Quick start

```bash
# Monitor mode (read-only, no private key needed)
NEXT_PUBLIC_RPC_URL=https://eth.llamarpc.com npx tsx integrations/uniswapx/filler.ts

# Live fill mode (requires funded wallet)
NEXT_PUBLIC_RPC_URL=... PRIVATE_KEY=0x... npx tsx integrations/uniswapx/filler.ts --live
```

The bot loads `.env.local` from the working directory if present.

### Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEXT_PUBLIC_RPC_URL` | Yes | — | Ethereum RPC endpoint |
| `PRIVATE_KEY` | For `--live` | — | Filler wallet private key |
| `FLASHBOTS_RPC_URL` | No | — | Flashbots Protect RPC for MEV-safe submission |
| `MIN_PROFIT_BPS` | No | `5` | Minimum profit threshold in basis points |
| `MAX_GAS_GWEI` | No | `50` | Skip fills when base fee exceeds this |
| `POLL_INTERVAL_MS` | No | `2000` | API polling interval in milliseconds |

## Files

| File | Description |
|------|-------------|
| `filler.ts` | Main bot entry point — poll loop, logging, CLI flags |
| `api.ts` | UniswapX API polling, V2DutchOrder ABI decoding, Dutch auction decay math |
| `quote.ts` | EulerSwap quote comparison — calls `computeQuote()` and `getLimits()`, computes profitability |
| `fill.ts` | Transaction construction for direct and callback fills, approval management |
| `types.ts` | TypeScript types for API responses, decoded orders, config; contract addresses |

Solidity contracts (under `contracts/` for Foundry compatibility):

| File | Description |
|------|-------------|
| `contracts/src/UniswapXFiller.sol` | On-chain executor implementing `reactorCallback` — swaps through EulerSwap |
| `contracts/test/UniswapXFiller.t.sol` | Fork tests against mainnet pool and reactor (8 tests) |

## Contracts

### UniswapXFiller.sol

Minimal executor contract. Token flow during a callback fill:

1. Reactor pulls swapper's input via Permit2, sends to executor
2. Reactor calls `executor.reactorCallback(resolvedOrders, callbackData)`
3. Executor transfers input tokens to EulerSwap pool
4. Executor calls `pool.swap()` (no callback — periphery pattern, pool reads its balance)
5. Reactor pulls output tokens from executor via `transferFrom` (max approvals set in constructor)
6. Excess output beyond what reactor needs = filler profit, stays in contract

Owner can call `withdraw()` / `withdrawAll()` to extract accumulated profit.

### Running fork tests

```bash
cd contracts
forge test --match-contract UniswapXFillerTest --fork-url $NEXT_PUBLIC_RPC_URL -vv
```

## Addresses (Ethereum mainnet)

| Contract | Address |
|----------|---------|
| EulerSwap Pool (USDC/WETH) | `0x4311031739918Aba578C3C667DA3028A12Ce28A8` |
| V2DutchOrderReactor | `0x00000011F84B9aa48e5f8aA8B9897600006289Be` |
| Permit2 | `0x000000000022d473030f116ddee9f6b43ac78ba3` |
| USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` |

## Status

- **Phase 1 (monitoring)**: Complete. Bot polls, filters, decodes, and evaluates profitability.
- **Phase 2 (direct fills)**: `fill.ts` has `directFill()` and `callbackFill()` — not yet wired into the bot's live path.
- **Phase 3 (executor contract)**: `UniswapXFiller.sol` deployed and tested (fork tests pass). Not yet deployed to mainnet.

## Design notes

- **No SDK dependency.** The `@uniswap/uniswapx-sdk` uses `workspace:*` deps that break `npm install`. Instead, orders are decoded directly using viem's `decodeAbiParameters` with the V2DutchOrder ABI tuple.
- **Exclusivity window.** Orders with a non-zero `exclusiveFiller` before `decayStartTime` are flagged but not filled — only the designated filler can fill during that window.
- **Pool limits.** `getLimits()` is checked to ensure the order size doesn't exceed what the pool can handle.
