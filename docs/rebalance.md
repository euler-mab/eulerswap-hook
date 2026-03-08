# Rebalance — Delta-Neutral via CowSwap

> **Script:** `agent/src/rebalance.ts`

## What it does

Makes the pool position delta-neutral by selling the overweight asset via
CowSwap, repaying any debt, and reconfiguring the pool to match the new
state. The end result is all equity in USDC with zero WETH exposure — the
pool borrows WETH on demand from the Euler vault when needed for swaps.

## Steps

1. **Read vault state** — deposits and debts for both assets via
   `convertToAssets(shares)` and `debtOf()`
2. **Compute sell amount** — all WETH deposit (the pool doesn't need WETH
   in the supply vault; EulerSwap borrows it on demand)
3. **Confirm** — prints position summary (deposits, debts, NAV, sell
   amount in USD) and waits for Y/N
4. **Withdraw WETH** from supply vault to agent EOA via EVC batch
5. **CowSwap** — approve vault relayer, get quote, EIP-712 sign, submit,
   poll for fill (~30s–5min)
6. **Repay USDC debt** — `vault.repay(debtAmount, eulerAccount)`
7. **Deposit remaining USDC** — `vault.deposit(remainder, eulerAccount)`
8. **Recompute equilibrium** — additive boost formula with `yr=0`,
   `xr=newUsdcDeposit`, `xd=0`, `yd=0` at market price
9. **Reconfigure pool** — `reconfigure(newParams, newInitialState)` via EVC
10. **Verify** — prints final vault state

### Error recovery

If CowSwap fails (quote error, order expires, price too low), the script
redeposits WETH back to the supply vault. Tokens stay in the agent EOA
only if recovery also fails (logged as warning).

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
| `EULER_ACCOUNT` | Yes | Euler sub-account address |

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
| Moves tokens | No | Yes (CowSwap) |
| Fixes exposure | No | Yes |
| MEV risk | Leaks value if pool is mispriced | MEV-protected (CowSwap batch auction) |
| Use case | Stale params, no exposure to fix | Accumulated directional risk |

RecenterPool is a subset — `rebalance.ts` calls `reconfigure()` at the end
after trading.
