# UniswapX Filler for EulerSwap

Fill UniswapX intent orders by routing them through the EulerSwap USDC/WETH pool. Users sign off-chain swap intents that enter a Dutch auction — fill prices decay over time until a filler finds it profitable to execute. This integration monitors those orders, compares decay prices against EulerSwap quotes, and (optionally) fills profitable ones.

## How it works

```
User signs intent  →  UniswapX API  →  Filler bot polls for open orders
                              ↑                     ↓
                    Webhook server (optional)    Filter USDC/WETH orders
                                                    ↓
                                          Resolve decay at current time
                                                    ↓
                                    Call pool.computeQuote() for EulerSwap price
                                                    ↓
                                Compute gas cost, convert to output token units
                                                    ↓
                            netProfit = eulerSwapOutput - requiredOutput - gasCost
                                                    ↓
                          Profitable? → Simulate (eth_call) → Submit fill tx
```

### Fill modes

**Direct fill** — The filler wallet holds output tokens (inventory) and calls `reactor.execute()`. Lower gas, simpler, but requires capital.

**Callback fill** — Calls `reactor.executeWithCallback()` through the on-chain executor contract (`UniswapXFiller.sol`). The executor receives input tokens from the reactor, decodes `callbackData` for pool address and min profit threshold, swaps through EulerSwap in the `reactorCallback`, and the reactor pulls output tokens via `transferFrom`. No inventory needed — capital-efficient but higher gas.

**Batch fill** — Fills multiple orders atomically via `executeBatchWithCallback()`. Amortizes gas across orders.

## Quick start

```bash
# Monitor mode (read-only, no private key needed)
NEXT_PUBLIC_RPC_URL=https://eth.llamarpc.com npx tsx integrations/uniswapx/filler.ts

# Live fill mode (requires funded wallet + deployed executor)
NEXT_PUBLIC_RPC_URL=... PRIVATE_KEY=0x... EXECUTOR_ADDRESS=0x... npx tsx integrations/uniswapx/filler.ts --live
```

The bot loads `.env.local` from the working directory if present.

### Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEXT_PUBLIC_RPC_URL` | Yes | — | Ethereum RPC endpoint |
| `PRIVATE_KEY` | For `--live` | — | Filler wallet private key |
| `EXECUTOR_ADDRESS` | For `--live` | — | Deployed UniswapXFiller contract address |
| `FLASHBOTS_AUTH_KEY` | No | — | Throwaway private key for Flashbots relay auth |
| `FLASHBOTS_RPC_URL` | No | — | Flashbots Protect RPC (fallback to normal RPC) |
| `MIN_PROFIT_BPS` | No | `5` | Minimum net profit threshold in basis points |
| `MAX_GAS_GWEI` | No | `50` | Skip fills when base fee exceeds this |
| `POLL_INTERVAL_MS` | No | `200` | API polling interval in milliseconds |
| `WEBHOOK_PORT` | No | — | If set, start HTTP server for push-based order sourcing |

## Files

| File | Description |
|------|-------------|
| `filler.ts` | Main bot — rate-limited poll loop, evaluate-and-fill pipeline, webhook startup |
| `api.ts` | UniswapX API polling, V2DutchOrder ABI decoding, Dutch auction decay math |
| `quote.ts` | Gas-aware profitability — calls `computeQuote()`, `getLimits()`, `getGasPrice()` |
| `fill.ts` | Transaction construction: direct, callback, batch fills + eth_call simulation |
| `flashbots.ts` | Flashbots bundle submission via relay (zero gas on failure) |
| `webhook.ts` | HTTP server for receiving order notifications from UniswapX |
| `types.ts` | TypeScript types for API responses, decoded orders, config; contract addresses |

Solidity contracts (under `contracts/` for Foundry compatibility):

| File | Description |
|------|-------------|
| `contracts/src/UniswapXFiller.sol` | On-chain executor — dynamic pool via callbackData, min profit check |
| `contracts/test/UniswapXFiller.t.sol` | Fork tests against mainnet pool and reactor (12 tests) |

## Contracts

### UniswapXFiller.sol

Minimal executor contract. Constructor takes only `reactor` address. Pool is passed dynamically via `callbackData` — no redeployment needed to switch pools.

Token flow during a callback fill:

1. Reactor pulls swapper's input via Permit2, sends to executor
2. Reactor calls `executor.reactorCallback(resolvedOrders, callbackData)`
3. Executor decodes `callbackData` as `(address pool, uint256 minProfit)`
4. Executor transfers input tokens to EulerSwap pool
5. Executor calls `pool.swap()` (no callback — pool reads its balance)
6. Executor verifies `outputBalance >= requiredOutput + minProfit` (reverts with `InsufficientProfit()` otherwise)
7. Reactor pulls output tokens from executor via `transferFrom`
8. Excess output beyond what reactor needs = filler profit, stays in contract

Setup after deployment:
```solidity
filler.approveToken(USDC);  // one-time per token
filler.approveToken(WETH);
```

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

## Design notes

- **No SDK dependency.** The `@uniswap/uniswapx-sdk` uses `workspace:*` deps that break `npm install`. Instead, orders are decoded directly using viem's `decodeAbiParameters` with the V2DutchOrder ABI tuple.
- **Adaptive gas estimation.** Starts with a conservative 250k gas estimate. After each successful simulation, the actual gas is fed into an EMA (α=0.3) with a 20% safety margin. The estimate self-corrects over time — no manual tuning needed.
- **Simulate before fill.** Every fill is preceded by `eth_call` simulation to avoid wasting gas on reverts.
- **Batch fills.** Multiple profitable orders in the same poll cycle are filled atomically via `executeBatchWithCallback`, amortizing gas.
- **Rate limiting.** Token bucket limiter (6 req/s) prevents exceeding UniswapX API limits at the default 200ms poll interval.
- **Webhook sourcing.** Optional HTTP server receives order push notifications from UniswapX (register at Uniswap filler onboarding, whitelist IP `3.14.56.90`). Runs alongside polling as complementary source.
- **Flashbots bundles.** Two MEV protection modes:
  - **Bundle mode** (`FLASHBOTS_AUTH_KEY` set): Builds a raw signed transaction, submits it as a Flashbots bundle to `relay.flashbots.net` targeting block+1 and block+2. Failed bundles cost **zero gas** — the tx is never on-chain if it would revert. The auth key is a throwaway private key (not your filler key) used to identify you to the relay.
  - **Protect RPC** (`FLASHBOTS_RPC_URL` set, no auth key): Routes transactions through Flashbots Protect RPC, which hides them from the public mempool. Simpler setup but **reverts still cost gas**.
  - **Standard** (neither set): Submits directly via your RPC. No MEV protection.
- **Exclusivity handling.** Orders with strict exclusivity (`exclusivityOverrideBps = 0`) during the exclusivity window are skipped. Orders with a non-zero override BPS are evaluated with the penalty applied (outputs scaled up by override percentage). A 24-second buffer on the exclusivity check accounts for the delay between evaluation and on-chain execution.
- **Order type filtering.** Only V2 Dutch orders are fetched (`orderType=Dutch_V2`). V1, Priority, Limit, and other order types use different reactors and encoding formats.
- **Multi-output support.** The executor contract handles orders with multiple outputs (swapper + fee recipients). All outputs must be the same token; the total required amount is summed across recipients.
- **Pool status check.** Before evaluating orders, the bot checks pool availability via multicall: status must be unlocked (1), pool must be installed in EVC, not expired, and fees must be < 100%. Mirrors the CoW driver's pool filtering pattern.
- **Pool limits.** `getLimits()` is checked to ensure the order size doesn't exceed what the pool can handle.
- **Single pool.** Currently routes all fills through one EulerSwap pool (configurable via `ADDRESSES.pool`). No multi-pool routing or fallback liquidity source. If the pool is unavailable, the bot logs `POOL UNAVAILABLE` and waits until the next cycle.
