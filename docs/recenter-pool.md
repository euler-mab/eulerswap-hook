# RecenterPool — Pool Parameter Reset

> **Script:** `contracts/script/RecenterPool.s.sol`

## What it does

Recenters an EulerSwap pool by updating its stored parameters to match
current reality. No trading happens — it's a single `reconfigure()` call
that overwrites the pool's equilibrium point, oracle price, and range
floors.

Specifically:

1. **equilibriumReserve0/1 = current reserves** — the pool's "center" is
   moved to where reserves actually sit, eliminating any accumulated drift.
2. **priceY = market price** — read from a Uniswap V3 pool's `slot0()`
   sqrtPriceX96, so the pool's internal price oracle matches the market.
3. **minReserve0/1 = reserves × 0.9759** — range floors reset to give a
   ±5% price range from the new center (the factor is `1 − 1/√1.05`).

The pool's actual token balances, vaults, hook, fees, and concentration
are all untouched. Only the curve shape parameters change.

## When to use

- **Periodic maintenance** — price drifts over time, making the pool's
  stored priceY stale. Recentering restores accurate fee computation and
  range boundaries.
- **After manual intervention** — if something left the pool in a weird
  state (failed restore, stale eq from a bug), this cleans it up.
- **Before deploying a new hook** — ensure the pool starts from a clean
  centered state.

## Usage

```bash
POOL=0x4311031739918Aba578C3C667DA3028A12Ce28A8 \
UNI_POOL=0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640 \
PRIVATE_KEY=0x... \
  forge script script/RecenterPool.s.sol:RecenterPool \
    --rpc-url $RPC_URL --broadcast --slow -vvvv
```

**Env vars:**

| Var | Required | Description |
|-----|----------|-------------|
| `POOL` | Yes | EulerSwap pool address |
| `UNI_POOL` | Yes | Uniswap V3 pool for market price |
| `PRIVATE_KEY` | Yes | Key for pool's eulerAccount |
| `UPDATE_NAV` | No | Set to `"true"` to also update V3 hook NAV |

### Updating hook NAV

With `UPDATE_NAV=true`, the script also:
- Computes NAV from vault state: `(supply0 − debt0) + (supply1 − debt1) × px/py`
- Calls `hook.setAuctionParams(newNav, ...)` keeping all other auction params unchanged

This is only needed for V3 hooks that use exposure-based auction triggers.

## Known pools

| Pool | POOL | UNI_POOL |
|------|------|----------|
| USDC/WETH | `0x4311031739918Aba578C3C667DA3028A12Ce28A8` | `0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640` |
| USDC/USDT | `0x719529e99b7b272c5ef4CE07C30d15BC57CD68A8` | `0x3416cF6C708Da44DB2624D63ea0AAef7113527C6` |
