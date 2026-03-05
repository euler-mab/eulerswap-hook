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
| `monitor.ts` | Reads on-chain state (reserves, params, oracle price, vault debt/utilization) |
| `oracle.ts` | CowSwap aggregator quotes — bid/ask/spread for market context |
| `rules.ts` | Rule engine: emergency pause, price recentering, interest rebalancing, gas budget, rate limiting |
| `executor.ts` | Submits txs — reconfigure routes through EVC, hook params direct, CowSwap swaps |
| `cowswap.ts` | CowSwap order flow: quote, EIP-712 sign, submit, poll for fill |
| `claude.ts` | Hourly Claude API review with structured prompt/response |
| `journal.ts` | Daily markdown files in `journal/`, namespaced by pool address |
| `metrics.ts` | In-memory P&L, gas, action history (last 1000 entries) |
| `types.ts` | Shared types and constants (WAD, BPS) |
| `abi.ts` | ABI fragments for EulerSwap pool, EVC, hook, Euler vaults, and price oracle |

## Execution Flow

```
Poll loop (every POLL_INTERVAL seconds):
  1. Read pool snapshot (reserves, dynamic params, oracle price)
  2. Read hook stats (trade count, volume, last trade)
  3. Read hook fee params (baseFee, mismatchScale, paused)
  4. Read vault debt info (pool debt, utilization, borrow rates)
  5. Fetch CowSwap aggregator quote (primary price source for recentering)
  6. Evaluate rules:
     - emergencyPause: if on-chain oracle returns 0 (stale/broken) → pause hook
     - priceRecenter: if CowSwap mid drifted >5% from equilibrium → reconfigure
     - interestRebalance: if vault utilization >70% with pool debt → widen fee spread
     - gasBudget: if daily spend exceeded → block all actions
     - rateLimit: if >12 actions this hour → block actions
  7. Execute triggered actions (if not blocked by gas/rate limits)
  8. Log snapshot to journal every 10th poll

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

## Interest Rate Rebalancing

When the pool has leverage (borrow vaults), sustained one-directional flow can spike vault utilization and push borrow rates above the IRM kink. The agent monitors vault debt and adjusts fees automatically.

**Rule: `interestRebalance`** — evaluates every poll cycle:

| Utilization | Severity | Action |
|-------------|----------|--------|
| < 70% | None | Normal fees |
| 70-85% | MILD | Widen min/max spread by 2 bps |
| 85-95% | HIGH | minFee=1bps, maxFee=3×baseFee (≥100bps) |
| > 95% | CRITICAL | minFee=1bps, maxFee=500bps |

The rule reads vault state via `monitor.getVaultDebtInfo()`: pool debt, vault utilization, borrow rates, and daily interest cost. It adjusts `setFeeParams` to make the rebalancing direction cheap and the worsening direction expensive, encouraging arbers to restore balance.

Claude also receives vault debt data in its review context and can recommend further action (concentration reduction, equilibrium shift, or external swap) per the strategy in [REBALANCING_STRATEGY.md](./REBALANCING_STRATEGY.md).

## External Swap (Last Resort)

When fee adjustments aren't rebalancing fast enough, Claude can recommend an `externalSwap` — the agent withdraws the excess asset from its supply vault, swaps it on CowSwap for the depleted asset, and deposits the proceeds back.

**Flow** (5 on-chain txs + 1 off-chain order):
1. Withdraw sell tokens from supply vault via EVC
2. Approve CowSwap GPv2VaultRelayer
3. Get CowSwap quote, validate against `minBuyAmount`
4. Sign order (EIP-712) and submit to CowSwap API
5. Poll for fill (up to 5 min timeout)
6. Deposit received tokens into the other supply vault

**Recovery**: if the quote fails or order expires unfilled, tokens are automatically deposited back into the original vault.

**Safety bounds**: swap size is capped at `maxSwapPct` (default 10%) of the sell-side reserve. Slippage is controlled by `swapSlippageBps` (default 50 = 0.5%).

## Claude Review Strategy

The Claude review (`claude.ts`) sends a system message explaining the pool's fee mechanism and strategic principles, then a user message with current pool state. Claude responds with JSON recommendations.

**System prompt includes:**
- Fee formula: `fee = baseFee ± (mismatchScale × mismatch)`, clamped to `[minFee, maxFee]`
- What each parameter controls (baseFee, minFee, maxFee, mismatchScale) with typical ranges
- 6 strategic principles from DYNAMIC_FEES.md:
  1. Profitability = fees − IL (fees linear, IL quadratic)
  2. Undercut the market (baseFee ≈ market_spread/2 − ε)
  3. Don't change what's working (low mismatch + volume = no action)
  4. Concentration is a risk dial (higher = more efficiency but more IL)
  5. Equilibrium recentering only for structural reasons (rules engine handles oracle drift)
  6. Conservative by default (empty recommendations is valid)
- Safety bounds from config.ts
- Parameter encoding (WAD-scaled fees vs raw reserve amounts)

**Context provided per review:**
- Reserves, equilibrium, oracle/marginal price, mismatch, concentration
- Hook fee params (baseFee, minFee, maxFee, mismatchScale, paused)
- Trade stats (count, volume, last trade direction/size)
- Gas spent today, recent actions
- CowSwap aggregator quote (bid/ask/spread) when available

**Allowed recommendation types:**
- `setFeeParams`: update baseFee, minFee, maxFee, mismatchScale (all 4 required)
- `reconfigure`: adjust concentration and/or equilibrium reserves
- `externalSwap`: sell excess asset on CowSwap, deposit depleted asset back (last resort)

**Safety validation** (`rules.isSafe()`): every recommendation is checked before execution. Forbidden fields (priceX, priceY, swapHook, etc.) are blocked, fee ordering enforced, equilibrium changes capped at 3x, swap size capped at configurable % of reserves.

## Setup

```bash
cp .env.example .env
# Fill in RPC_URL, PRIVATE_KEY, POOL_ADDRESS, HOOK_ADDRESS,
# EVC_ADDRESS, EULER_ACCOUNT, ANTHROPIC_API_KEY

npm install
npm start
```

## Price Sources

The agent uses **two** price sources for different purposes:

| Source | Used for | Module |
|--------|----------|--------|
| CowSwap aggregator | Recentering decisions (primary), Claude market context | `oracle.ts`, `rules.ts` |
| On-chain oracle (Chainlink via Euler vault) | priceX param (USDC stable), emergency pause (oracle=0), safety fallback | `monitor.ts` |

CowSwap quotes use 10,000 units ($10K for USDC) to ensure fixed fees are negligible (<0.01%). At $1 the fee is ~61%, giving unusable prices.

When CowSwap is unavailable, the rules engine falls back to the on-chain oracle for recentering. Emergency pause always uses the on-chain oracle (detects oracle=0 regardless of CowSwap).

## Journal Organization

Journal files are namespaced by pool address to prevent fork/mainnet entries from mixing:

```
journal/2026-03-05-0x4311.md   ← pool 0x4311...
journal/2026-03-05-0xa1b2.md   ← different pool
```

The prefix is set automatically via `journal.setPool(config.poolAddress)` at startup. Each pool gets its own daily file.

## On-Chain Oracle Price Chain

The agent reads on-chain oracle prices through the Euler vault's oracle adapter:

```
pool.getStaticParams().supplyVault0
  → vault.oracle()         → IPriceOracle address
  → vault.unitOfAccount()  → e.g. USD
  → vault.asset()          → e.g. USDC

getQuote(WAD, asset0, uoa) → price0  (value of 1e18 raw units of asset0)
getQuote(WAD, asset1, uoa) → price1  (value of 1e18 raw units of asset1)

oraclePrice = (price0 * WAD) / price1   ← matches hook's _getOraclePrice()
priceX = price0 / WAD                   ← AMM curve param (value per 1 raw unit)
priceY = price1 / WAD                   ← AMM curve param (value per 1 raw unit)
```

For USDC/WETH at $2500:
- `price0 = 1e30` (1e18 raw USDC = 1e12 actual USDC = $1e12)
- `price1 = 2500e18` (1e18 raw WETH = 1 WETH = $2500)
- `oraclePrice = 4e26` (raw WETH per raw USDC, WAD-scaled)
- `priceX = 1e12`, `priceY = 2500`

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

## Simulation Harness

The simulation harness (`sim-harness.sh`) adds oracle price movements and swap activity to the fork, so the agent can exercise its full strategy loop.

```
Terminal 1: RPC_URL=... ./fork-test.sh         # Deploy pool + hook, Anvil stays alive
Terminal 2: ./sim-harness.sh                   # Replace oracle, start swaps
Terminal 3: cp .env.fork .env && npm start     # Start agent
```

**Order matters**: start sim-harness BEFORE the agent. The harness replaces the real on-chain oracle (frozen at fork block) with a `SimPriceOracle` whose prices match the pool's initial reserves. If the agent polls first, it sees the stale oracle price, detects a huge mismatch, and recenters to garbage.

Modes: `--default` (sinusoidal ±5%), `--drift` (steady +0.5%/step), `--volatile` (random ±5%).

The fork test uses short intervals (10s poll, 5min Claude review) for faster feedback.

## Deployment Pipeline

### 1. Local fork testing

```bash
RPC_URL=https://eth-mainnet.g.alchemy.com/v2/KEY ./fork-test.sh
./sim-harness.sh --volatile
cp .env.fork .env && npm start
```

### 2. Mainnet deployment

**Pre-requisites:** deployer wallet with ETH (for WETH wrap + gas) and USDC.

```bash
cd ../contracts

# Dry run (simulation only — no gas spent):
PRIVATE_KEY=0x... forge script script/DeployMainnet.s.sol:DeployMainnet \
  --rpc-url https://eth-mainnet.g.alchemy.com/v2/KEY -vvvv

# Live deployment:
PRIVATE_KEY=0x... forge script script/DeployMainnet.s.sol:DeployMainnet \
  --rpc-url https://eth-mainnet.g.alchemy.com/v2/KEY --broadcast --slow -vvvv
```

The script auto-wraps ETH to WETH, deposits into Euler vaults, deploys the pool via the factory (with HookMiner salt), deploys `LPAgentHook`, and installs the hook via EVC reconfigure.

**Configurable env vars** (all optional):

| Variable | Default | Description |
|----------|---------|-------------|
| `WETH_AMOUNT` | 0.2 ether | WETH deposit for pool |
| `USDC_AMOUNT` | 500e6 | USDC deposit for pool |
| `CONCENTRATION` | 0.3e18 | AMM curve concentration (0-1) |
| `EXPIRATION_DAYS` | 30 | Pool auto-expires after N days (0=never) |

**Output:** the script prints `POOL_ADDRESS`, `HOOK_ADDRESS`, `EVC_ADDRESS`, `EULER_ACCOUNT` — copy these to `agent/.env.mainnet`.

### 3. Start the agent

```bash
cd ../agent
cp .env.mainnet .env
npm start
```

### 4. Post-deployment verification

```bash
# Pool reserves
cast call $POOL_ADDRESS "getReserves()(uint112,uint112,uint32)" --rpc-url $RPC_URL

# Hook fee params
cast call $HOOK_ADDRESS "getFeeParams()(uint64,uint64,uint64,uint256,bool)" --rpc-url $RPC_URL

# Test a small quote (sell 1 USDC for WETH)
cast call $POOL_ADDRESS "computeQuote(address,address,uint256,bool)(uint256)" \
  0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 \
  1000000 true --rpc-url $RPC_URL
```

### Emergency shutdown

```bash
# Pause hook (all swaps charged maxFee)
cast send $HOOK_ADDRESS "setPaused(bool)" true --private-key $PRIVATE_KEY --rpc-url $RPC_URL

# Or revoke pool operator (fully disables swaps)
cast send 0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383 \
  "setAccountOperator(address,address,bool)" $EULER_ACCOUNT $POOL_ADDRESS false \
  --private-key $PRIVATE_KEY --rpc-url $RPC_URL
```
