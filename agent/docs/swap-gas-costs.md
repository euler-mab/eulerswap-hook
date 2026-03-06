# Swap Gas Cost Analysis

## How to Re-run This Analysis

### 1. Get current gas price
Visit https://etherscan.io/gastracker or:
```bash
curl -s https://api.etherscan.io/api?module=gastracker&action=gasoracle | python3 -c "
import sys, json
d = json.load(sys.stdin)['result']
print(f'Low: {d[\"SafeGasPrice\"]} gwei')
print(f'Avg: {d[\"ProposeGasPrice\"]} gwei')
print(f'High: {d[\"FastGasPrice\"]} gwei')
"
```

### 2. Get EulerSwap gas from forge tests
```bash
cd contracts && forge test --match-contract LPAgentHookTest --gas-report 2>&1 | \
  grep -E "^\| (getFee|afterSwap|swap |computeQuote|getDynamic|slot0|deposit|withdraw)"
```

Key rows to look at:
- `swap`: Total gas for EulerSwap swap (includes all sub-calls)
- `getFee`: Hook fee computation
- `slot0`: Uniswap oracle read (only when mismatchScale > 0)
- `getDynamicParams`: Pool curve params read (only when mismatchScale > 0)
- `deposit` / `withdraw`: Euler vault operations

### 3. Compute USD cost
```
cost_usd = gas_used × gas_price_gwei × 1e-9 × eth_price_usd
```

Example at 0.209 gwei, ETH = $2,080:
```
388,000 × 0.209 × 1e-9 × 2,080 = $0.169
```

---

## Results (March 2026)

**Gas price: 0.209 gwei | ETH: ~$2,080**

### Summary

| Protocol | Gas | Cost (USD) |
|---|---|---|
| Uniswap V3 (direct pool.swap) | ~130k | $0.056 |
| Uniswap V3 (SwapRouter) | ~185k | $0.080 |
| EulerSwap (no mismatch, flat fee) | ~301k | $0.131 |
| EulerSwap (with hook mismatch) | ~474k | $0.206 |

### EulerSwap Swap Gas Breakdown

Total swap gas with hook active: **~474k gas**

| Component | Gas | % of Total | Notes |
|---|---|---|---|
| **Euler vault deposit** (input token) | ~82k-152k | 17-32% | Deposit input token into supply vault. Range depends on cold/warm storage. |
| **Euler vault withdraw** (output token) | ~72k-75k | 15-16% | Withdraw output token from supply vault (or borrow). |
| **ERC20 transfers** | ~50k-60k | 11-13% | Two token transfers (in + out). |
| **EVC call overhead** | ~5k | 1% | Account status checks, operator auth. |
| **Curve computation** | ~5k-10k | 1-2% | `findCurvePoint` — the actual AMM math. |
| **Reserve/state updates** | ~20k | 4% | Writing new reserves to storage. |
| **Hook: getFee()** | **7k-38k** | **2-8%** | See breakdown below. |
| **Hook: afterSwap()** | **~40k** | **8%** | 7 storage writes + event emission. |

### Hook getFee() Breakdown

| Mode | Gas | What it does |
|---|---|---|
| **Flat fee** (mismatchScale=0) | **7,155** | Just reads `baseFee` from storage, returns it. |
| **With mismatch** (mismatchScale>0) | **~37,600** | Full oracle + marginal computation. |

Mismatch mode sub-costs:
| Sub-component | Gas | Notes |
|---|---|---|
| Uniswap V3 `slot0()` | ~4,800 (cold) / ~500 (warm) | Arb txs that already touched Uniswap get warm rate. |
| `pool.getDynamicParams()` | ~12,600 (cold) / ~2,600 (warm) | Reads curve params (px, py, x0, y0). |
| Marginal price math | ~13,000 | Two `mulDiv` calls with 512-bit intermediates. |
| Mismatch + fee logic | ~200 | Trivial arithmetic. |

### Hook afterSwap() Breakdown (~40k gas)

| Sub-component | Gas | Notes |
|---|---|---|
| 7 storage writes | ~35,000 | tradeCount, volume0, volume1, lastTradeAsset0In, lastTradeSize, lastTradeBlock, lastTradeTimestamp. Each SSTORE ~5k warm. |
| Event emission | ~1,500 | `TradeRecorded` event with 5 fields. |
| Call overhead | ~3,500 | Cross-contract call + onlyPool check. |

### Why EulerSwap is 2-3x More Gas Than Uniswap V3

EulerSwap swaps go through the Euler vault system:
1. Input token is **deposited** into an Euler vault (not just transferred to a pool)
2. Output token is **withdrawn** (or borrowed) from another Euler vault
3. The **EVC** (Ethereum Vault Connector) mediates all calls with auth checks
4. Hook callbacks add getFee + afterSwap overhead

Uniswap V3 is simpler: two ERC20 transfers + curve math + state update.

The extra gas buys:
- Leveraged liquidity (vault deposits earn yield)
- Hook-based dynamic fees
- EVC-based account management

### Cost at Various Gas Prices

| Gas Price (gwei) | EulerSwap (474k) | Uniswap V3 (130k) | Difference |
|---|---|---|---|
| 0.2 | $0.20 | $0.05 | $0.15 |
| 1.0 | $0.99 | $0.27 | $0.72 |
| 5.0 | $4.93 | $1.35 | $3.58 |
| 10.0 | $9.86 | $2.70 | $7.15 |
| 30.0 | $29.57 | $8.11 | $21.46 |

*(Assumes ETH = $2,080. Scale linearly with ETH price.)*

At current gas prices (0.2 gwei), the difference is negligible ($0.15).
At 30 gwei (congested network), EulerSwap costs $21 more per swap.
