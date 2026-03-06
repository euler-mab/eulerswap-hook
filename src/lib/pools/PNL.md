# P&L Attribution System

## Overview

The pool dashboard computes real-time P&L by scanning on-chain vault events to determine total capital deployed, then comparing against current NAV. P&L is decomposed into three components: swap fees, impermanent loss, and net vault interest. A time series chart shows how these accumulate over time. All values are denominated in USD via DeFiLlama prices.

## Architecture

```
PoolDetail
  └─ usePoolPnl(pool, state, swaps, swapsLoading)
       ├─ fetchVaultFlows()         ← scans vault Deposit/Withdraw events (once, cached)
       │    ├─ filters by owner = eulerAccount
       │    └─ excludes swap-transaction events (cross-ref with swap tx hashes)
       ├─ buildCapitalSnapshot()    ← nets deposits - withdrawals per asset
       ├─ fetchPriceChart()         ← DeFiLlama /chart endpoint (once per token, cached)
       ├─ buildPnlTimeSeries()      ← P&L at each swap using historical prices
       ├─ computeTwr()              ← time-weighted return from capital flows
       └─ computePnl()              ← called on each 30s state poll
            └─ DeFiLlama: /prices/current/{tokens}
```

### Files

| File | Role |
|---|---|
| `src/lib/pools/prices.ts` | DeFiLlama API wrapper (`fetchCurrentPrices`, `fetchPriceChart`, `interpolatePrice`) |
| `src/lib/pools/pnl.ts` | P&L engine (`CapitalSnapshot`, `PnlAttribution`, `computePnl`, `buildPnlTimeSeries`, `computeTwr`) |
| `src/hooks/usePoolPnl.ts` | React hook — scans vault flows, fetches price charts, computes P&L on state updates |
| `src/lib/pools/reads.ts` | `fetchVaultFlows()` — scans ERC4626 events on supply vaults |
| `src/components/pools/PoolOverview.tsx` | Renders NAV, P&L, three-way breakdown, annualized TWR |
| `src/components/pools/PoolCharts.tsx` | P&L time series chart (fees / IL / net over time) |

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
```

### Three-way decomposition

For each swap, the pool's net position change gives the rebalancing component:

```
Per swap:
  fee_i      = swap.fee{0,1}              (charged separately, NOT included in amountIn)
  rebal_i    = (amountIn - amountOut) per asset

Accumulated (at current prices):
  fees       = Σ(fee0) × p0 + Σ(fee1) × p1                (always positive)
  rebalUsd   = Σ(rebal0) × p0 + Σ(rebal1) × p1            (positive or negative)
  interest   = totalPnl - fees - rebalUsd                   (residual: net vault interest)
```

| Component | Meaning | Sign |
|---|---|---|
| **fees** | Swap fees earned by the pool | Always positive |
| **rebal** | Net rebalancing P&L from position shifts | Positive = favorable (pool traded well), Negative = adverse selection |
| **interest** | Net vault interest (supply earned - borrow paid) | Typically positive |

Identity: `totalPnl = fees + rebal + interest`

Note: Rebalancing is derived from actual swap history — not from a constant-product IL formula. It captures the exact position-shift P&L for whatever curve the pool uses. Unlike traditional "impermanent loss" (which is always negative), rebalancing can be positive when the pool trades favorably — e.g. selling WETH before a price drop.

Note: All three components are valued at *current* prices (consistent with `netInvestedUsd`). This means rebalancing captures both the per-trade adverse selection and the mark-to-market effect of the accumulated position shift.

## P&L Time Series

Historical P&L is built from swap events + DeFiLlama price charts:

1. Fetch hourly price charts for both tokens via `/chart` endpoint (2 API calls, cached)
2. At each swap event, interpolate USD prices from the charts
3. Accumulate fees and rebalancing in USD at historical prices
4. Estimate NAV from post-swap reserves × historical prices

Displayed as a three-line chart: cumulative fees (green), cumulative rebalancing (red), net (blue).

Note: The time series uses *historical* prices (at each swap's timestamp), while the overview uses *current* prices. Small differences between the chart's final point and the overview numbers are expected.

## Time-Weighted Return (TWR)

TWR chains sub-period returns across capital flow events, removing the effect of deposit/withdrawal timing:

```
For each capital flow i:
  R_i = nav_before_flow_i / nav_after_flow_{i-1} - 1

TWR = Π(1 + R_i) - 1
Annualized = (1 + TWR) ^ (365 / days) - 1
```

NAV at each flow timestamp is estimated from the most recent swap event's reserves, valued at interpolated DeFiLlama prices.

## DeFiLlama API

Free, no API key, CORS-enabled. Rate limit: 500 requests/min.

```
Current:    GET https://coins.llama.fi/prices/current/{chain}:{addr},...
Historical: GET https://coins.llama.fi/prices/historical/{unix_ts}/{chain}:{addr},...
Chart:      GET https://coins.llama.fi/chart/{chain}:{addr}?start={ts}&span={hours}&period=1h
```

Token format: `ethereum:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`

Throws on missing prices (no silent fallbacks).

## Caching Strategy

The `usePoolPnl` hook caches a `HistoricalCache` in a React ref:
- **Vault flows** — scanned once from deploy block to current block
- **Net deposits per asset** — computed once from flows
- **Price charts** — fetched once per token from DeFiLlama /chart
- **P&L time series** — computed once from swaps + price charts
- **TWR** — computed once from flows + swaps + price charts

On each 30s state poll, only `computePnl` runs: fetches current DeFiLlama prices and recomputes NAV/P&L against the cached capital snapshot.

The cache resets when `pool.address` changes.

## Display

| Row | Content |
|---|---|
| **NAV** | `$905.71 +$2.31 (+0.26%) (invested $903.40, 5 flows) (+3.1% ann., 30d)` |
| **P&L breakdown** | `fees +$3.15 · rebal +$0.62 · interest +$0.12` |

Charts tab "P&L": cumulative fees / rebalancing / net lines over time.

Fallback while loading: simple NAV from vault positions using on-chain oracle/marginal prices.

## Future Work

1. **Per-asset attribution** — track returns in native token terms
2. **Borrow flow tracking** — currently only tracks supply vault events; could also track borrow events for more granular interest attribution
3. **NAV time series chart** — show NAV value over time (requires historical vault positions or reconstruction from events)
