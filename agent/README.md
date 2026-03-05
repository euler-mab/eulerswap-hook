# EulerSwap LP Agent

Autonomous agent that manages an EulerSwap pool position: sets dynamic fees based on oracle mismatch, adjusts pool parameters, and uses Claude API for periodic strategy review.

For the strategic rationale behind this design, see [DYNAMIC_FEES.md](../src/lib/DYNAMIC_FEES.md).

## Architecture

Three layers, matching the framework from DYNAMIC_FEES.md:

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1: getFee hook (gas-free, swapper pays)           │
│   LPAgentHook.sol reads oracle, computes mismatch vs    │
│   pool marginal price, returns asymmetric fee —         │
│   higher on the mispriced side, lower on the other.     │
├─────────────────────────────────────────────────────────┤
│ Layer 2: afterSwap hook (gas-free, swapper pays)        │
│   LPAgentHook.sol tracks trade count, volume,           │
│   direction, and size for monitoring.                   │
├─────────────────────────────────────────────────────────┤
│ Layer 3: offchain agent (this service, pays gas)        │
│   Polls on-chain state, evaluates rules, submits        │
│   reconfigure txs through EVC, runs Claude reviews.     │
└─────────────────────────────────────────────────────────┘
```

Layers 1+2 are in `contracts/src/LPAgentHook.sol`. Layer 3 is this directory.

## Module Overview

| Module | Purpose |
|--------|---------|
| `index.ts` | Main loop: poll every 30s, Claude review every 1h |
| `config.ts` | Loads env vars, defines safety bounds |
| `monitor.ts` | Reads on-chain state (reserves, params, real oracle price via Euler vaults) |
| `oracle.ts` | CowSwap aggregator quotes — bid/ask/spread for market context |
| `rules.ts` | Rule engine: emergency pause, price recentering, gas budget, rate limiting |
| `executor.ts` | Submits txs — reconfigure routes through EVC, hook params are direct |
| `claude.ts` | Hourly Claude API review with structured prompt/response |
| `journal.ts` | Daily markdown files in `journal/` |
| `metrics.ts` | In-memory P&L, gas, action history (last 1000 entries) |
| `types.ts` | Shared types and constants (WAD, BPS) |
| `abi.ts` | ABI fragments for EulerSwap pool, EVC, hook, Euler vaults, and price oracle |

## Execution Flow

```
Poll loop (every POLL_INTERVAL seconds):
  1. Read pool snapshot (reserves, dynamic params, oracle price)
  2. Read hook stats (trade count, volume, last trade)
  3. Read hook fee params (baseFee, mismatchScale, paused)
  4. Evaluate rules:
     - emergencyPause: if oracle returns 0 (stale/broken) → pause hook
     - priceRecenter: if oracle drifted >5% from equilibrium → reconfigure
     - gasBudget: if daily spend exceeded → block all actions
     - rateLimit: if >12 actions this hour → block actions
  5. Execute triggered actions (if not blocked by gas/rate limits)
  6. Log snapshot to journal every 10th poll

Claude loop (every CLAUDE_REVIEW_INTERVAL seconds):
  1. Build context: snapshot, P&L, recent trades, current params
  2. Fetch CowSwap aggregator quote (bid/ask/spread — null is OK)
  3. Call Claude API for strategy recommendations
  4. Validate each recommendation against safety bounds
  5. Execute safe recommendations, log rejected ones
  6. Write review to journal
```

## EVC Routing

The agent EOA is registered as a pool manager (`pool.setManager(agentEOA, true)`), but manager calls to `reconfigure()` must go through the EVC:

```
evc.call(poolAddress, eulerAccount, 0, reconfigureCalldata)
```

Direct calls revert with `EVC_NotAuthorized`. Only the swapHook can call `reconfigure()` directly (from within afterSwap, when the pool is unlocked). See the [EulerSwap skill doc](../.claude/skills/eulerswap/SKILL.md) for details.

Hook parameter updates (`setFeeParams`, `setPaused`) are direct calls to the hook contract — no EVC needed.

## Safety Bounds

Hardcoded in `config.ts`, not adjustable by Claude:

| Param | Min | Max | Rationale |
|-------|-----|-----|-----------|
| baseFee | 1 bp | 100 bp | Below 1bp loses money to gas; above 100bp drives away all flow |
| maxFee | — | 100% | Contract also enforces this; prevents total lockout |
| mismatchScale | — | 100x | Prevents extreme fee sensitivity to small mismatch |
| fee ordering | min ≤ base ≤ max | — | Contract reverts on violation; agent validates first |
| concentration | 0.01 | 0.95 | Near-zero is useless; near-1 is constant-sum (infinite IL risk) |
| equilibrium reserves | >0 | — | Zero reserves would brick the pool |
| actions/hour | — | 12 | Rate limit covers both reconfigure and setFeeParams |
| daily gas budget | — | configurable | Hard stop on total spend |
| tx timeout | — | 2 min | Prevents stuck txs from blocking the agent loop |

Claude cannot pause/unpause the pool — only the rules engine (emergency) or the owner.

## Setup

```bash
cp .env.example .env
# Fill in RPC_URL, PRIVATE_KEY, POOL_ADDRESS, HOOK_ADDRESS,
# EVC_ADDRESS, EULER_ACCOUNT, ANTHROPIC_API_KEY

npm install
npm start
```

## Fork Testing

Automated script deploys a USDC/WETH pool with LPAgentHook on an Anvil mainnet fork:

```bash
# Requires: anvil, forge, cast (foundry), and a mainnet RPC
RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY ./fork-test.sh
```

This will:
1. Start an Anvil fork of mainnet
2. Fund the deployer with USDC (from a whale) and WETH (wrapped ETH)
3. Deposit into Euler USDC and WETH vaults
4. Deploy a pool via the EulerSwap factory
5. Deploy and install `LPAgentHook`
6. Write `agent/.env.fork` with all addresses

Then run the agent against the fork:

```bash
cp .env.fork .env
# Add your ANTHROPIC_API_KEY to .env
npm start
```

The fork test uses short intervals (10s poll, 5min Claude review) for faster feedback.

## Deployment Pipeline

1. **Anvil fork**: `./fork-test.sh` — test full flow locally
2. **Testnet**: Deploy to Sepolia, run for 48h+
3. **Mainnet**: Deploy hook → create pool → reconfigure to install hook → register in registry → set agent as manager → start agent with conservative params
