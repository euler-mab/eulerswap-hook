# Rebalance — Delta-Neutral via Euler Orderflow Router

> **Script:** `agent/src/rebalance.ts`

## What it does

Makes the pool position delta-neutral by selling the overweight asset via
the Euler orderflow router (on-chain DEX aggregator), repaying any debt, and
reconfiguring the pool to match the new state. The end result is all equity
in USDC with zero WETH exposure — the pool borrows WETH on demand from the
Euler vault when needed for swaps.

## How it works

The script uses an **EVC batch with deferred account status checks** — a
single atomic transaction that temporarily violates health factor:

1. Withdraw all WETH from supply vault to Swapper (health check deferred)
2. Swapper swaps WETH→USDC via DEX, repays debt, deposits remainder
3. SwapVerifier validates output
4. → end of batch: account healthy (USDC deposit, no WETH, no debt)

This solves the chicken-and-egg problem: you can't withdraw WETH while it's
needed as collateral for USDC debt, but you need to sell WETH to get USDC to
repay the debt. Deferred checks allow the temporary violation as long as the
final state is healthy.

## Steps

1. **Read vault state** — deposits and debts for both assets via
   `convertToAssets(shares)` and `debtOf()`
2. **Compute sell amount** — all WETH deposit (the pool doesn't need WETH
   in the supply vault; EulerSwap borrows it on demand)
3. **Confirm** — prints position summary (deposits, debts, NAV, sell
   amount in USD) and waits for Y/N
4. **Get quote** from Euler orderflow router API (`swap.euler.finance/swap`)
   — returns DEX route, Swapper multicall data, and SwapVerifier data
5. **Fix multicall** — replaces the API's `repayAndDeposit(maxUint256-1)`
   with `repayAndDeposit(maxUint256)` so vault.repay() auto-caps to exact
   debt (avoids `E_RepayTooMuch`)
6. **Simulate** — `eth_call` the full EVC batch before sending. Retries
   with a fresh quote up to 3 times if simulation fails (DEX routes can
   go stale)
7. **Submit** EVC batch: withdraw → Swapper multicall → SwapVerifier
8. **Recompute equilibrium** — additive boost formula with `yr=0`,
   `xr=newUsdcDeposit`, `xd=0`, `yd=0` at market price
9. **Reconfigure pool** — `reconfigure(newParams, newInitialState)` via EVC
10. **Verify** — prints final vault state

### Key contracts

| Contract | Address | Role |
|----------|---------|------|
| Swapper | `0x2Bba09866b6F1025258542478C39720A09B728bF` | Stateless swap executor |
| SwapVerifier | `0xae26485ACDDeFd486Fe9ad7C2b34169d360737c7` | Validates swap results |

## Usage

```bash
cd agent && npx tsx src/rebalance.ts
```

Uses the same `.env` as the agent:

| Var | Required | Description |
|-----|----------|-------------|
| `RPC_URL` | Yes | Ethereum RPC endpoint |
| `PRIVATE_KEY` | Yes | Agent EOA key (pool's eulerAccount) |
| `POOL_ADDRESS` | Yes | EulerSwap pool address |
| `EVC_ADDRESS` | Yes | EVC address |

## When to use

- **Position has accumulated directional exposure** — e.g. after sustained
  ETH price movement, the pool holds mostly WETH with USDC debt. Running
  this sells the WETH and repays debt, returning to a clean USDC-only
  position.
- **Before deploying a new hook** — ensures the pool starts from a known
  delta-neutral state.

## Compared to RecenterPool

| | RecenterPool | rebalance.ts |
|--|---|---|
| Moves tokens | No | Yes (on-chain swap) |
| Fixes exposure | No | Yes |
| Atomic | Yes | Yes (single EVC batch) |
| Use case | Stale params, no exposure to fix | Accumulated directional risk |

RecenterPool is a subset — `rebalance.ts` calls `reconfigure()` at the end
after trading.
