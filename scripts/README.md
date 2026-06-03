# scripts/

On-chain analysis and calibration scripts for the propAMM hook.

## Setup

```bash
cd scripts
npm install
```

## Usage

| Script | What it does |
|---|---|
| `npx tsx calibrate-hook-params.ts` | Derive `FeeConfig` and `AuctionConfig` from equity, LTV, oracle source, volatility, and gas. Run before every hook deployment or parameter update. |
| `RPC_URL=... npx tsx analyze-hook.ts` | Pull per-swap pricing, reconstruct per-block Uniswap prices, and compute LP P&L over the hook's lifetime. |
| `RPC_URL=... npx tsx verify-pnl.ts` | 5-way P&L decomposition: fees + swapRebal + extRebal + interest + markToMarket against on-chain vault events. |

### Calibrating a new pool

Pool inputs live as JSON in [`profiles/`](./profiles). Each file matches the
`PoolProfile` interface at the top of `calibrate-hook-params.ts`. To add a new
pool, drop a JSON file in that directory — for example
`profiles/usdc-dai.json`:

```json
{
  "name": "USDC/DAI",
  "equity": 1000,
  "eq0": 500000000,
  "eq1": 500000000,
  "cx": 0,
  "cy": 0,
  "oracle": "v4",
  "oracleFeeBps": 0.1,
  "volatility": "stablecoin",
  "annualVol": 0.0005,
  "auctionTriggerThreshold": 0.5,
  "recenterRange": 0.0001
}
```

Then:

```bash
# Run all profiles
npx tsx calibrate-hook-params.ts

# Run a single profile
npx tsx calibrate-hook-params.ts profiles/usdc-dai.json
```

Runtime checks reject profiles that are missing fields, have wrong types, or
have out-of-range values (negative equity, `cx`/`cy` outside `[0, 1]`, unknown
`oracle`/`volatility` enum, etc.).

### Bridging to `DeployHook.s.sol`

Re-run with `--env` to print a paste-ready env-var block (one profile at a
time) using the exact names the deploy script reads:

```bash
npx tsx calibrate-hook-params.ts profiles/usdc-dai.json --env
```

Output ends with a block like:

```
# ─── Paste into your shell, then run DeployHook.s.sol ──────────────
# Profile: USDC/DAI
BASE_FEE=...
MAX_FEE=...
GAS_COEFF=...
EXTERNAL_FEE=...
CAPTURE_RATE=...
ATTRACT_RATE=...
DECAY_PER_BLOCK=...
AUCTION_TRIGGER_THRESHOLD=...
CLEAR_THRESHOLD=...
MAX_SHIFT_MAGNITUDE=...
MIN_AUCTION_BLOCKS=...
RECENTER_RANGE=...
MAX_RECENTER_DRIFT=...
MIN_RECENTER_DELTA=...
SURCHARGE_DECAY_PER_BLOCK=...
SURCHARGE_MULTIPLIER=...
DEPLOY_SURCHARGE=...
```

Paste it into your shell, then run `forge script contracts/script/DeployHook.s.sol`.

Both `analyze-hook.ts` and `verify-pnl.ts` default to the live USDC/WETH pool. To analyze a different pool, override via env vars:

```bash
RPC_URL=https://... \
POOL_ADDRESS=0x... \
UNI_POOL_ADDRESS=0x... \
HOOK_DEPLOY_BLOCK=12345678 \
POOL_DEPLOY_BLOCK=12345600 \
EULER_ACCOUNT=0x... \
DECIMALS_0=6 DECIMALS_1=18 \
  npx tsx analyze-hook.ts
```

## Dry-run deploys against a forked mainnet

Before broadcasting a deploy on real mainnet, run the same forge script against a local anvil fork. State is real, your transactions are not.

In one terminal, fork the current mainnet head into a local node:

```bash
anvil --fork-url $RPC_URL
```

In another, use Anvil's well-known first test account and point the script at the local RPC:

```bash
export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

forge script script/DeployHook.s.sol:DeployHook \
  --rpc-url http://localhost:8545 \
  --broadcast
```

Why this is worth doing:

- **No real ETH at risk** — Anvil pre-funds that key with 10000 ETH on the fork.
- **Fast iteration** — every run takes seconds, so you can tweak env vars, rerun, inspect logs, and keep going.
- **Re-runnable** — kill the script halfway through, restart anvil, and you're back to the mainnet head.

Caveat: **state resets when you restart anvil.** If you deploy a pool, restart, then try to deploy a hook on it, the pool no longer exists. Either keep anvil running across the full sequence, or use `anvil --dump-state state.json` / `--load-state state.json` to checkpoint.

## Adding new scripts

Drop a new `.ts` file in this directory, import from `viem` and standard libs. The repo intentionally keeps the scripts directory dependency-light.
