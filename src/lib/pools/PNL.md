# P&L Attribution System

## Overview

The pool dashboard computes real-time P&L by scanning on-chain vault events to determine total capital deployed, then comparing against current NAV. All values are denominated in USD via DeFiLlama prices.

## Architecture

```
PoolDetail
  └─ usePoolPnl(pool, state, swaps, swapsLoading)
       ├─ fetchVaultFlows()       ← scans vault Deposit/Withdraw events (once, cached)
       │    ├─ filters by owner = eulerAccount
       │    └─ excludes swap-transaction events (cross-ref with swap tx hashes)
       ├─ buildCapitalSnapshot()  ← nets deposits - withdrawals per asset
       └─ computePnl()            ← called on each 30s state poll
            └─ DeFiLlama: /prices/current/{tokens}
```

### Files

| File | Role |
|---|---|
| `src/lib/pools/prices.ts` | DeFiLlama API wrapper (`fetchCurrentPrices`) |
| `src/lib/pools/pnl.ts` | P&L engine (`CapitalSnapshot`, `PnlAttribution`, `computePnl`) |
| `src/hooks/usePoolPnl.ts` | React hook — scans vault flows once, re-computes P&L on state updates |
| `src/lib/pools/reads.ts` | `fetchVaultFlows()` — scans ERC4626 events on supply vaults |
| `src/components/pools/PoolOverview.tsx` | Renders NAV, P&L, breakdown |

## Capital Flow Tracking

External capital flows are detected by scanning ERC4626 `Deposit` and `Withdraw` events on both supply vaults, filtered by `owner = eulerAccount`.

**Filtering swap-induced events**: When a swap occurs, the pool contract deposits/withdraws from vaults as part of settlement. These fire the same ERC4626 events. We exclude them by cross-referencing transaction hashes with known Swap events — any vault event in the same transaction as a Swap is internal, not an external capital flow.

The remaining events represent real LP capital movements: initial deposits, top-ups, and withdrawals.

## P&L Math

```
netInvested = Σ(external deposits) - Σ(external withdrawals)    [per asset, in human units]
netInvestedUsd = netDeposit0 × currentPrice0 + netDeposit1 × currentPrice1

currentNav  = (vaultDep0 - vaultDebt0) × currentPrice0
            + (vaultDep1 - vaultDebt1) × currentPrice1

totalPnl    = currentNav - netInvestedUsd
returnPct   = totalPnl / netInvestedUsd

fees        = Σ(swap.fee0) × currentPrice0 + Σ(swap.fee1) × currentPrice1
lpCost      = totalPnl - fees              (residual: IL + net interest)
```

### Two-way decomposition

| Component | Meaning | Typically |
|---|---|---|
| **fees** | Swap fees earned by the pool | Positive (revenue) |
| **lpCost** | IL + net vault interest | Negative (cost of providing liquidity) |

Identity: `totalPnl = fees + lpCost`

Note: `netInvestedUsd` is valued at *current* prices, not historical. This means P&L captures the pool's actual performance (fees - IL - interest) without being confounded by asset price changes. If ETH goes up 10%, both NAV and netInvested go up proportionally, so the P&L reflects only what the pool operations gained or lost.

## DeFiLlama API

Free, no API key, CORS-enabled.

```
Current:    GET https://coins.llama.fi/prices/current/{chain}:{addr},...
Historical: GET https://coins.llama.fi/prices/historical/{unix_ts}/{chain}:{addr},...
```

Token format: `ethereum:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`

Throws on missing prices (no silent fallbacks).

## Caching Strategy

The `usePoolPnl` hook caches a `CapitalSnapshot` in a React ref:
- **Vault flows** — scanned once from deploy block to current block
- **Net deposits per asset** — computed once from flows

On each 30s state poll, only `computePnl` runs: fetches current DeFiLlama prices and recomputes NAV/P&L against the cached capital snapshot.

The ref resets when `pool.address` changes.

## Display

| Row | Content |
|---|---|
| **NAV** | `$905.71 +$2.31 (+0.26%) (invested $903.40, 5 flows)` |
| **P&L breakdown** | `fees +$3.15 · IL + interest -$0.84` |

Fallback while loading: simple NAV from vault positions using on-chain oracle/marginal prices.

## Future Work

1. **Time-weighted return (TWR)** — chain returns across deposit/withdrawal periods for timing-independent performance
2. **Per-asset attribution** — track returns in native token terms
3. **NAV time series** — use DeFiLlama `/chart` endpoint for historical prices, show performance chart
4. **Borrow flow tracking** — currently only tracks supply vault events; could also track borrow events for more granular interest attribution
