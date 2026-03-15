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

**Callback fill** — EOA calls `executor.execute()` → executor calls `reactor.executeWithCallback()` → reactor callbacks the executor. The executor receives input tokens from the reactor, decodes `callbackData` for pool address and min profit threshold, swaps through EulerSwap in the `reactorCallback`, and the reactor pulls output tokens via `transferFrom`. No inventory needed — capital-efficient but higher gas.

**Batch fill** — Fills multiple orders atomically via `executor.executeBatch()`. Amortizes gas across orders.

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
| `contracts/test/UniswapXFiller.t.sol` | Unit tests — access control, callback logic, multi-output, withdraw (19 tests) |
| `contracts/test/UniswapXFiller.fork.t.sol` | Fork tests — realistic fills, batches, profit cycle, pool limits (11 tests) |
| `contracts/script/DeployUniswapXFiller.s.sol` | Deploy script — deploys executor, approves tokens, verifies state |

## Contracts

### UniswapXFiller.sol

Minimal executor contract. Constructor takes only `reactor` address. Pool is passed dynamically via `callbackData` — no redeployment needed to switch pools.

Token flow during a callback fill:

1. EOA calls `executor.execute(signedOrder, callbackData)` (owner-gated)
2. Executor calls `reactor.executeWithCallback(signedOrder, callbackData)`
3. Reactor pulls swapper's input via Permit2, sends to executor (msg.sender)
4. Reactor calls `executor.reactorCallback(resolvedOrders, callbackData)`
5. Executor decodes `callbackData` as `(address pool, uint256 minProfit)`
6. Executor transfers input tokens to EulerSwap pool
7. Executor calls `pool.swap()` (no callback — pool reads its balance)
8. Executor verifies `outputBalance >= requiredOutput + minProfit` (reverts with `InsufficientProfit()` otherwise)
9. Reactor pulls output tokens from executor via `transferFrom`
10. Excess output beyond what reactor needs = filler profit, stays in contract

Setup after deployment:
```solidity
filler.approveToken(USDC);  // one-time per token
filler.approveToken(WETH);
```

Owner can call `withdraw()` / `withdrawAll()` to extract accumulated profit.

### Deploying the executor

```bash
cd contracts
PRIVATE_KEY=0x... forge script script/DeployUniswapXFiller.s.sol:DeployUniswapXFiller \
  --rpc-url $NEXT_PUBLIC_RPC_URL --broadcast --slow -vvvv
```

The script outputs `EXECUTOR_ADDRESS=0x...` — add this to `.env.local` for live mode.

### Running tests

```bash
cd contracts

# Unit tests (no fork needed)
forge test --match-contract "UniswapXFillerTest$" -vv

# Fork tests (mainnet state)
forge test --match-contract UniswapXFillerForkTest --fork-url $NEXT_PUBLIC_RPC_URL -vv

# All UniswapX tests
forge test --match-path "test/UniswapXFiller*" --fork-url $NEXT_PUBLIC_RPC_URL -vv
```

## Addresses (Ethereum mainnet)

| Contract | Address |
|----------|---------|
| EulerSwap Pool (USDC/WETH) | `0x4311031739918Aba578C3C667DA3028A12Ce28A8` |
| V2DutchOrderReactor | `0x00000011F84B9aa48e5f8aA8B9897600006289Be` |
| Permit2 | `0x000000000022d473030f116ddee9f6b43ac78ba3` |
| USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` |
| UniswapXFiller (executor) | `0x2126177546c135a0Ef310005090A833a75586C67` |

## Design notes

- **No SDK dependency.** The `@uniswap/uniswapx-sdk` uses `workspace:*` deps that break `npm install`. Instead, orders are decoded directly using viem's `decodeAbiParameters` with the V2DutchOrder ABI tuple.
- **Adaptive gas estimation.** Starts with a conservative 250k gas estimate. After each successful simulation, the actual gas is fed into an EMA (α=0.3) with a 20% safety margin. The estimate self-corrects over time — no manual tuning needed.
- **Simulate before fill.** Every fill is preceded by `estimateContractGas` which both validates the call and returns the gas estimate — single RPC round-trip, no redundant simulation.
- **Batch fills.** Multiple profitable orders in the same poll cycle are filled atomically via `executor.executeBatch()`, amortizing gas. Gas estimates from batch fills are normalized per-order before feeding into the EMA.
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
- **Multi-pool routing.** Routes fills through all enabled pools in `CHAIN_CONFIGS`. If all pools are unavailable, the bot logs `ALL POOLS UNAVAILABLE` and waits until the next cycle.
- **ABI decode verification.** After decoding each order, the reactor address in the decoded struct is compared against the expected V2DutchOrderReactor address. A mismatch indicates the ABI tuple layout is wrong and all decoded fields are garbage — the order is rejected with a clear error.
- **Fill serialization.** Fill submissions from poll and webhook are serialized through a promise chain to prevent nonce collisions. Without this, concurrent `prepareTransactionRequest` calls would fetch the same pending nonce.
- **Transaction confirmation.** Non-bundle fills wait for on-chain confirmation (2 minute timeout) and log success/revert status with gas details. Bundle fills are fire-and-forget (zero gas on failure).
- **Exponential backoff.** Consecutive poll errors trigger exponential backoff (2s, 4s, 8s, ... capped at 30s) to avoid hammering a rate-limited or failing RPC.
- **Deadline pre-check.** Orders expiring within 30 seconds are skipped before any RPC calls. Avoids wasting gas estimation on orders that will likely expire before the fill transaction lands.
- **Webhook IP validation.** Exact IP match (not substring) with IPv6-mapped address support (`::ffff:x.x.x.x`).
