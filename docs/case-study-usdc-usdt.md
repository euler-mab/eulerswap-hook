# Case study: $500-NAV USDC/USDT pool

> **Pool**: [`0x719529e99b7b272c5ef4ce07c30d15bc57cd68a8`](https://etherscan.io/address/0x719529e99b7b272c5ef4ce07c30d15bc57cd68a8)
> **Hook**: [`0x99b97FD05b4F943899358F90855C0BEE34584e41`](https://etherscan.io/address/0x99b97FD05b4F943899358F90855C0BEE34584e41) ([DynamicFeeAuctionHook](../contracts/src/DynamicFeeAuctionHook.sol))
> **Deploy script**: [`DeployHookUSDCUSDT.s.sol`](../contracts/script/DeployHookUSDCUSDT.s.sol)
> **Live since**: 2026-03-15 (~80 days at time of writing)

A live mainnet pool with $500 of equity quoting $100k of daily volume. Numbers below are on-chain at the time of writing — re-run [`scripts/analyze-hook.ts`](../scripts/analyze-hook.ts) for current state.

---

## At a glance

| Metric | Value |
|---|---|
| Real LP equity (NAV) | **~$499** |
| Virtual reserves | **~$247M USDC / $242M USDT** |
| Effective depth multiplier | **~490,000×** |
| Daily volume (rolling 24h) | **~$98k** |
| Daily turnover | **~196× NAV** |
| Lifetime volume | ~$810k (187 swaps) |
| Lifetime fees collected | $24.27 |
| P&L since live | ~flat (-$1.70 = -0.34%) |

The pool is making roughly as much in fees as it pays in borrow carry on its directional leg. That's the design: low base fees to win flow, the LP earns when arbs hit the capture-fee multiplier or when the deploy/recenter surcharge is active.

---

## Initial deploy

- **Equity at deploy**: $382 USDC + $119 USDT = $501 total
- **Curve shape**: `concentration = 0` on both sides (range-bound), `range = 1 bps` (a single tick)
- **Cross-LTV**: 96% USDC↔USDT (the Euler pair has symmetric high LTVs because the assets correlate ~1:1)
- **Equilibrium reserves** (computed by [`_computeEquilibrium`](../contracts/script/DeployHookUSDCUSDT.s.sol) for `h=1` at the boundary): `eq0 ≈ $247.6M`, `eq1 ≈ $242.3M`. With LTV that high and concentration that aggressive, additive boost pushes the virtual reserves to nine figures off ~$500 of real collateral.

The trade-off: a tighter range and higher LTV give you deeper virtual reserves, but the boundary is closer to the equilibrium price. For a USDC/USDT pair where spot moves ~5 bps over a typical week, a 1-bps range is fine; for ETH/USDC you'd want orders of magnitude wider.

---

## Hook parameters

Full list lives in [`DeployHookUSDCUSDT.s.sol`](../contracts/script/DeployHookUSDCUSDT.s.sol). The notable values:

| Parameter | Value | Why |
|---|---|---|
| `baseFee` | **0.05 bps** | Undercut the V4 USDC/USDT pool's 0.08 bps to win retail routing |
| `externalFee` | 0.08 bps | The V4 reference fee — used in attract/capture math |
| `captureRate` | 80% | Take 80% of any arb surplus, leave 20% as MEV incentive |
| `attractRate` | 50% | Quote at half the discount-to-V4 needed for routing parity |
| `gasCoeff` | 0 | Mainnet gas at ~0.4 gwei is negligible vs the tight quotes |
| `maxFee` | 50 bps | Hard ceiling — far above anything the formulas would ever produce |
| **Auction** | | |
| `auctionTriggerThreshold` | 50% of NAV | If net base-asset exposure exceeds half of NAV, trigger an auction |
| `decayPerBlock` | 0.05 bps/block | Auction fee decays one base-fee per block |
| `maxShiftMagnitude` | 1 bps | Cap on how far the equilibrium can be shifted in a single auction |
| `clearThreshold` | 0.5 bps | Auction clears when marginal price is within 0.5 bps of oracle |
| `minAuctionBlocks` | 25 | Auction must run at least 5 minutes before being eligible to clear |
| **Recenter** | | |
| `recenterRange` | 1 bps | Same as the curve range |
| `maxRecenterDrift` | 1 bps | Cap on how far `priceY` can move in a single recenter |
| `minRecenterDelta` | 0.5 bps | Only recenter when exposure has actually improved by 0.5 bps |
| **Surcharge** | | |
| `surchargeDecayPerBlock` | 0.05 bps/block | Recenter surcharge decays at the same rate as the auction |
| `surchargeMultiplier` | 2.5× | Surcharge = 2.5 × curvature bonus the recenter just exposed |
| `deploySurcharge` | **5 bps** | One-shot surcharge at deploy — 100× base — to deter mispriced-deploy arbs |

The deploy surcharge of 5 bps is huge relative to the 0.05 bps base. That's intentional: if my initial `priceY` is off by even a few bps, an arber can round-trip and extract value the first block. The surcharge gives the deployer 100 blocks of cover (5 bps / 0.05 bps per block) to either let it decay naturally or detect a problem and recenter.

---

## What the data says

Re-running [`scripts/analyze-hook.ts`](../scripts/analyze-hook.ts) at time of writing:

```
USDT supplied: 7,349.45
USDC borrowed: 6,850.15
NAV (both ≈ $1): ~$499.30
```

So the LP currently holds ~$7,350 USDT and owes ~$6,850 USDC against ~$500 of net equity — a directional position that the auction system is trying to clear back to delta-neutral on each large swap.

**Volume distribution over the 80-day life:**

```
days 0–60:   ~52 swaps total (mostly probing trades, ~$13k volume)
days 60–80:  ~135 swaps    ($795k+ volume) — pool started getting routed
```

Pool was dormant for the first ~60 days, then orderflow picked up sharply once retail aggregators started routing through it. The recent rate is ~$98k/day with no signs of slowing.

**Fees collected**: $24.27 lifetime, mostly from the recent active period. Annualized, that's roughly $110/year on $500 of capital — a 22% APY in absolute fee terms.

**P&L**: NAV today $499.30 vs $501 at deploy. The ~$1.70 gap is borrow carry on the USDC leg (the pool has ~$6,850 borrowed for an extended period; at the EVK's borrow APY that's a real annual cost). Fees collected over the period roughly offset it — call it net flat with the recent uptick in flow pushing it toward positive.

---

## What's working

- **Routing wins**: undercutting the V4 reference by 60% on base fee gets the pool quoted in aggregator paths it otherwise wouldn't be.
- **Recenters are quiet**: with 1-bps range and minRecenterDelta = 0.5 bps, most swaps don't trigger reconfigures; the surcharge stays at zero except briefly after auctions.
- **No auctions triggered yet** (as of writing). The 50% NAV trigger is conservative; in 80 days no single direction has accumulated enough exposure to hit it. Either we're underutilizing the rebalancing machinery, or the trigger is well-tuned for this pair's flow profile — hard to say without more data.
- **Spot oracle has been rock solid**: V4 PoolManager `extsload` reads have never failed (~190 successful reads to date). No fallback-to-baseFee events observed.

## What's not (yet)

- **$500 NAV is too small to be profitable in absolute terms.** $24 of fees over 80 days is a proof-of-concept number, not a business. The same hook + same routing on $50k of equity would be doing $10M/day at $2k/day in fees.
- **Recent flow is bursty.** The last 11 days dominate lifetime stats. A few weeks of sustained data would tell us more about expected steady-state turnover.
- **No active rebalancing has been needed**, so the auction system is unproven on this pool. Other deployments (or a scale-up of this one) would exercise it.

---

## Reproducing this deploy

If you want to copy the setup with your own capital:

1. Read [docs/build-your-own-propamm.md](build-your-own-propamm.md) end to end.
2. Open [`DeployHookUSDCUSDT.s.sol`](../contracts/script/DeployHookUSDCUSDT.s.sol) — the constants block at the top is the full parameter set.
3. Re-run [`scripts/calibrate-hook-params.ts`](../scripts/calibrate-hook-params.ts) with your equity figure. **Do not copy the eq reserves directly** — they're a function of equity, LTV, and range. The calibration script will give you the right numbers.
4. Deploy:
   ```bash
   PRIVATE_KEY=0x... forge script script/DeployHookUSDCUSDT.s.sol \
     --rpc-url $RPC_URL --broadcast --slow -vvvv
   ```

For a different pair (USDC/WETH, ETH/BTC, etc.), copy the script as a template and update:
- vault addresses
- oracle target (V3 pool or V4 PoolManager + pool ID)
- LTV (per-asset, asymmetric is fine)
- `recenterRange` (wider for volatile pairs)
- `gasCoeff` (relevant for L1, near-zero for L2s)
- `baseFee` / `externalFee` (informed by the deepest competing venue)

---

## Reproduce these numbers

Every figure in the tables above can be read directly from chain — nothing here is computed off a private database. The recipes below assume `RPC_URL` is set to a mainnet endpoint and that you've installed `cast` (Foundry) and Python 3 with `pip install web3`.

### 1. Live virtual reserves

```bash
cast call 0x719529e99b7b272c5ef4CE07C30d15BC57CD68A8 \
  "getReserves()(uint112,uint112,uint32)" \
  --rpc-url $RPC_URL
```

Returns `(reserve0, reserve1, status)`. `reserve0` is USDC (6 decimals), `reserve1` is USDT (6 decimals), `status=1` means the pool is active. Divide each by `10^6` to get the USD amounts shown in the "Virtual reserves" row.

### 2. Full lifetime analysis

The same script that produced the lifetime volume, fee, P&L, and exposure numbers in this case study lives at [`scripts/analyze-hook.ts`](../scripts/analyze-hook.ts):

```bash
RPC_URL=https://... \
POOL_ADDRESS=0x719529e99b7b272c5ef4CE07C30d15BC57CD68A8 \
  npx tsx scripts/analyze-hook.ts
```

This reconstructs per-block Uniswap prices, walks every `Swap` event since the hook went live, computes realised fees, captures the recenter cadence, and prints the 5-way P&L decomposition. Defaults target the USDC/WETH pool — explicit env vars switch it to USDC/USDT (you can also override `UNI_POOL_ADDRESS`, `HOOK_DEPLOY_BLOCK`, `POOL_DEPLOY_BLOCK`, `EULER_ACCOUNT`, `DECIMALS_0`, `DECIMALS_1`; see [scripts/README.md](../scripts/README.md)).

### 3. Read NAV from the vaults

NAV is `supplyVault.convertToAssets(supplyVault.balanceOf(account))` summed across the supply vaults, minus `borrowVault.debtOf(account)` summed across the borrow vaults. The same `scripts/analyze-hook.ts` does this read for both legs of the pair and is the source of the "Real LP equity (NAV)" row. For a one-shot check via `cast`:

```bash
ACCOUNT=0x2909BCc87c17D8be263621bf087Bc806ba313BFf  # USDC/USDT sub-account
SUPPLY_USDC=0xVaultAddressFromAddressesDoc
BORROW_USDC=0xVaultAddressFromAddressesDoc

# supply side (shares -> assets)
SHARES=$(cast call $SUPPLY_USDC "balanceOf(address)(uint256)" $ACCOUNT --rpc-url $RPC_URL)
cast call $SUPPLY_USDC "convertToAssets(uint256)(uint256)" $SHARES --rpc-url $RPC_URL

# borrow side
cast call $BORROW_USDC "debtOf(address)(uint256)" $ACCOUNT --rpc-url $RPC_URL
```

Repeat for the USDT supply and borrow vaults. Sum the assets, subtract the debts, divide by `10^6`. The vault addresses come from [addresses.md](addresses.md) (or any past deploy script).

### 4. Daily volume from `Swap` events

The "~$98k/day" figure is `sum(|amount0In| + |amount0Out|)` over the last 24 hours, in token0 units, divided by `10^6` for USDC. A quick Python recipe using `web3`:

```bash
python - <<'PY'
import os
from web3 import Web3

w3 = Web3(Web3.HTTPProvider(os.environ["RPC_URL"]))
POOL = Web3.to_checksum_address("0x719529e99b7b272c5ef4CE07C30d15BC57CD68A8")

# EulerSwap Swap event topic — keccak256("Swap(address,uint256,uint256,uint256,uint256,uint112,uint112,address)")
SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822"

head = w3.eth.block_number
ONE_DAY_BLOCKS = 7200      # ~12s blocks on Ethereum
logs = w3.eth.get_logs({
    "address": POOL,
    "topics": [SWAP_TOPIC],
    "fromBlock": head - ONE_DAY_BLOCKS,
    "toBlock": head,
})

vol_usdc = 0
for log in logs:
    data = bytes.fromhex(log["data"][2:])
    # amount0In, amount1In, amount0Out, amount1Out at offsets 0..3 (32 bytes each)
    a0in  = int.from_bytes(data[0:32],   "big")
    a0out = int.from_bytes(data[64:96],  "big")
    vol_usdc += a0in + a0out

print(f"24h volume: ${vol_usdc / 1e6:,.2f}")
PY
```

A pure Bash variant (no Python) uses `cast logs` with the same topic filter — set `--from-block`, `--to-block`, and decode the data field with `cast --to-dec`. The Python recipe is more readable for an audit trail.

Combine these four reads and you can reconstruct every row of the "At a glance" table from scratch.
