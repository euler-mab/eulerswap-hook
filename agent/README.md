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
| `monitor.ts` | Reads on-chain state (reserves, params, hook stats) |
| `oracle.ts` | Aggregator quote interface (stub — implement 1inch or CowSwap) |
| `rules.ts` | Rule engine: price recentering (>5% drift), gas budget, rate limiting |
| `executor.ts` | Submits txs — reconfigure routes through EVC, hook params are direct |
| `claude.ts` | Hourly Claude API review with structured prompt/response |
| `journal.ts` | Daily markdown files in `journal/` |
| `metrics.ts` | In-memory P&L, gas, action history (last 1000 entries) |
| `types.ts` | Shared types and constants (WAD, BPS) |
| `abi.ts` | ABI fragments for EulerSwap pool, EVC, and hook |

## Execution Flow

```
Poll loop (every POLL_INTERVAL seconds):
  1. Read pool snapshot (reserves, dynamic params, oracle price)
  2. Read hook stats (trade count, volume, last trade)
  3. Read hook fee params (baseFee, mismatchScale, paused)
  4. Evaluate rules:
     - priceRecenter: if oracle drifted >5% from equilibrium → reconfigure
     - gasBudget: if daily spend exceeded → block all actions
     - rateLimit: if >12 reconfigs this hour → block actions
  5. Execute triggered actions (if not blocked by gas/rate limits)
  6. Log snapshot to journal every 10th poll

Claude loop (every CLAUDE_REVIEW_INTERVAL seconds):
  1. Build context: snapshot, P&L, recent trades, current params
  2. Call Claude API for strategy recommendations
  3. Validate each recommendation against safety bounds
  4. Execute safe recommendations, log rejected ones
  5. Write review to journal
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
| concentration | 0.01 | 0.95 | Near-zero is useless; near-1 is constant-sum (infinite IL risk) |
| reconfigs/hour | — | 12 | Rate limit to prevent gas drain from feedback loops |
| daily gas budget | — | configurable | Hard stop on total spend |

Claude cannot pause/unpause the pool — only the rules engine (emergency) or the owner.

## Setup

```bash
cp .env.example .env
# Fill in RPC_URL, PRIVATE_KEY, POOL_ADDRESS, HOOK_ADDRESS,
# EVC_ADDRESS, EULER_ACCOUNT, ANTHROPIC_API_KEY

npm install
npm start
```

## Deployment Pipeline

1. **Anvil fork**: `anvil --fork-url $RPC_URL` — test full flow locally
2. **Testnet**: Deploy to Sepolia, run for 48h+
3. **Mainnet**: Deploy hook → create pool → reconfigure to install hook → register in registry → set agent as manager → start agent with conservative params
