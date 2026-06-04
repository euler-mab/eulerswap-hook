/**
 * Derive PRICE_X / PRICE_Y env vars for DeployPool.s.sol from a Uniswap V3 oracle.
 *
 * The EulerSwap curve's marginal price at equilibrium is `priceX / priceY`,
 * interpreted as the **raw token1-per-token0 ratio** (i.e. the same units a
 * Uniswap V3 `sqrtPriceX96^2 / 2^192` produces, before any decimal correction).
 * The hook's `_getUniswapPrice` reads exactly that ratio (WAD-scaled) and
 * recenter logic computes `priceY = priceX * WAD / uniPriceWad`.
 *
 * For an initial deploy we want the same alignment, so this script picks:
 *
 *     priceX = 1e18                          (WAD)
 *     priceY = WAD * WAD / uniPriceWad       (raw token0-per-token1, WAD-scaled)
 *
 * Both must fit in uint80 (max 1.2e24 ≈ 1.2 * WAD). If the natural choice
 * would overflow, the script flips the convention (priceY = WAD, priceX scaled
 * down) so the ratio is preserved with both legs in range.
 *
 * ── Address-ordering convention ──────────────────────────────────────────
 * EulerSwap orders the pool's tokens by ADDRESS: the smaller address is
 * asset0, the larger is asset1. The Uniswap V3 pool you point at probably
 * uses the SAME ordering by coincidence (V3 also sorts by address), but not
 * always for unusual factory wrappers. The script reads `token0()` on the
 * Uniswap pool and inverts the price if it disagrees with `ASSET0`, so you
 * can paste either ordering into ASSET0 / ASSET1 as long as you keep them
 * consistent with how DeployPool.s.sol assigns SUPPLY_VAULT_0 / SUPPLY_VAULT_1.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *   MAINNET_RPC_URL=... \
 *   UNI_POOL_ADDRESS=0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640 \
 *   ASSET0=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
 *   ASSET1=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 \
 *     npx tsx scripts/compute-pool-prices.ts
 *
 * ── Output ───────────────────────────────────────────────────────────────
 *   # USDC (6dp) per WETH (18dp): 1748.04 (oracle 0x88e6...5640 @ block 23146311)
 *   PRICE_X=1000000000000000000
 *   PRICE_Y=1748039438
 *
 * Paste the two env-var lines directly into the shell before running
 * `forge script script/DeployPool.s.sol:DeployPool`.
 */

import { createPublicClient, http, type Address } from "viem";
import { mainnet } from "viem/chains";

// ── Config ─────────────────────────────────────────────────────────────

const RPC_URL = process.env.MAINNET_RPC_URL ?? process.env.RPC_URL;
if (!RPC_URL) {
  console.error("MAINNET_RPC_URL is not set. Export it (or RPC_URL) before running.");
  process.exit(1);
}

const UNI_POOL_ADDRESS = process.env.UNI_POOL_ADDRESS as Address | undefined;
const ASSET0 = process.env.ASSET0 as Address | undefined;
const ASSET1 = process.env.ASSET1 as Address | undefined;

if (!UNI_POOL_ADDRESS || !ASSET0 || !ASSET1) {
  console.error(
    "Required env vars not set. Need:\n" +
      "  UNI_POOL_ADDRESS  Uniswap V3 oracle pool to read spot from\n" +
      "  ASSET0            EulerSwap asset0 (smaller address)\n" +
      "  ASSET1            EulerSwap asset1 (larger address)",
  );
  process.exit(1);
}

// EulerSwap requires asset0 < asset1 (lexicographic on raw address bytes). If
// the caller has them backwards, the resulting priceX/priceY would still match
// the Uniswap oracle but DeployPool would reject the vault ordering at runtime
// — catch it here with a clearer message.
if (ASSET0.toLowerCase() >= ASSET1.toLowerCase()) {
  console.error(
    `ASSET0 (${ASSET0}) must be lexicographically less than ASSET1 (${ASSET1}). ` +
      `EulerSwap orders pool tokens by address — flip them.`,
  );
  process.exit(1);
}

const client = createPublicClient({
  chain: mainnet,
  transport: http(RPC_URL),
});

const erc20Abi = [
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
] as const;

const uniV3Abi = [
  {
    name: "slot0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
  { name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { name: "token1", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { name: "fee", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint24" }] },
] as const;

// ── Constants ──────────────────────────────────────────────────────────

const WAD = 10n ** 18n;
const Q192 = 1n << 192n;
const UINT80_MAX = (1n << 80n) - 1n;
// EulerSwap's EulerSwapManagement caps both price legs at 1e24.
const PRICE_CAP = 10n ** 24n;

// ── Helpers ────────────────────────────────────────────────────────────

function mulDiv(a: bigint, b: bigint, denom: bigint): bigint {
  // BigInt arithmetic is exact and unbounded — no need for full-precision tricks.
  return (a * b) / denom;
}

async function main(): Promise<void> {
  // Detect Uniswap pool's native ordering vs our requested ASSET0.
  const [uniToken0, uniToken1, slot0] = await Promise.all([
    client.readContract({ address: UNI_POOL_ADDRESS!, abi: uniV3Abi, functionName: "token0" }),
    client.readContract({ address: UNI_POOL_ADDRESS!, abi: uniV3Abi, functionName: "token1" }),
    client.readContract({ address: UNI_POOL_ADDRESS!, abi: uniV3Abi, functionName: "slot0" }),
  ]);

  const uniToken0Lower = uniToken0.toLowerCase();
  const uniToken1Lower = uniToken1.toLowerCase();
  const asset0Lower = ASSET0!.toLowerCase();
  const asset1Lower = ASSET1!.toLowerCase();

  let oracleToken0IsAsset0: boolean;
  if (uniToken0Lower === asset0Lower && uniToken1Lower === asset1Lower) {
    oracleToken0IsAsset0 = true;
  } else if (uniToken0Lower === asset1Lower && uniToken1Lower === asset0Lower) {
    oracleToken0IsAsset0 = false;
  } else {
    console.error(
      `Uniswap pool ${UNI_POOL_ADDRESS} has token0=${uniToken0}, token1=${uniToken1},\n` +
        `but ASSET0=${ASSET0}, ASSET1=${ASSET1}. The Uniswap pool must reference the\n` +
        `same pair of tokens (in either order) as the EulerSwap pool you're deploying.`,
    );
    process.exit(1);
  }

  // Fetch decimals + symbols for the explanatory comment.
  const [dec0, dec1, sym0, sym1] = await Promise.all([
    client.readContract({ address: ASSET0!, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: ASSET1!, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: ASSET0!, abi: erc20Abi, functionName: "symbol" }).catch(() => "asset0"),
    client.readContract({ address: ASSET1!, abi: erc20Abi, functionName: "symbol" }).catch(() => "asset1"),
  ]);

  const blockNumber = await client.getBlockNumber();

  // Compute uniPriceWad = raw asset1-per-asset0 ratio, WAD-scaled. This matches
  // _getUniswapPrice() in DynamicFeeAuctionHook: the marginal price the curve
  // produces (priceX/priceY) is compared directly to this value.
  const sqrtPriceX96: bigint = slot0[0];
  if (sqrtPriceX96 === 0n) {
    console.error("Uniswap pool returned sqrtPriceX96 = 0 — pool is uninitialised?");
    process.exit(1);
  }

  // priceWad_raw = sqrtPriceX96^2 * WAD / 2^192  → raw uniToken1 / raw uniToken0
  let uniPriceWad = mulDiv(sqrtPriceX96 * sqrtPriceX96, WAD, Q192);
  if (!oracleToken0IsAsset0) {
    if (uniPriceWad === 0n) {
      console.error("Inverted uniPriceWad would be infinite (oracle ratio underflowed to 0).");
      process.exit(1);
    }
    uniPriceWad = mulDiv(WAD, WAD, uniPriceWad);
  }

  if (uniPriceWad === 0n) {
    console.error("Computed uniPriceWad = 0 — oracle price too small to represent.");
    process.exit(1);
  }

  // Pick priceX / priceY so the curve's marginal price matches the oracle.
  //
  //   priceX / priceY  ==  uniPriceWad / WAD   (== raw asset1/asset0 ratio)
  //
  // Default: priceX = WAD, priceY = WAD * WAD / uniPriceWad. If priceY would
  // exceed uint80 (or the EulerSwap 1e24 sanity cap), flip and set priceY=WAD,
  // priceX=uniPriceWad. We only need to handle both directions because the
  // ratio can be > 1 or < 1 depending on the decimal gap between the assets.
  let priceX: bigint;
  let priceY: bigint;
  let convention: string;
  if (uniPriceWad >= WAD) {
    // ratio >= 1 → priceY <= WAD, safely in range.
    priceX = WAD;
    priceY = mulDiv(WAD, WAD, uniPriceWad);
    convention = "priceX = WAD, priceY = WAD*WAD / uniPriceWad";
  } else {
    // ratio < 1 → flip so priceX <= WAD and priceY = WAD.
    priceX = uniPriceWad;
    priceY = WAD;
    convention = "priceX = uniPriceWad, priceY = WAD";
  }

  // Both must satisfy 1 <= price <= 1e24 (EulerSwapManagement.sol L43-44).
  if (priceX === 0n || priceY === 0n) {
    console.error(`Computed priceX=${priceX}, priceY=${priceY} — one rounded to 0. Pool oracle out of range?`);
    process.exit(1);
  }
  if (priceX > PRICE_CAP || priceY > PRICE_CAP) {
    console.error(
      `Computed priceX=${priceX}, priceY=${priceY} exceeds EulerSwap cap (1e24). ` +
        `This pair's decimal gap is too extreme for the default convention.`,
    );
    process.exit(1);
  }
  if (priceX > UINT80_MAX || priceY > UINT80_MAX) {
    console.error(
      `Computed priceX=${priceX}, priceY=${priceY} exceeds uint80 (${UINT80_MAX}). ` +
        `DeployPool would revert on cast.`,
    );
    process.exit(1);
  }

  // Decimal-adjusted human price for the sanity comment. The curve's marginal
  // price is in raw units; humans usually want "quote per base" in token units.
  // asset1_value_per_asset0_value = (priceX / priceY) * 10^(dec0 - dec1)
  //                               = (uniPriceWad / WAD) * 10^(dec0 - dec1)
  const decGap = Number(dec0) - Number(dec1);
  const numericRawRatio = Number(uniPriceWad) / Number(WAD);
  const humanPrice1per0 = numericRawRatio * Math.pow(10, decGap);
  const humanPrice0per1 = humanPrice1per0 > 0 ? 1 / humanPrice1per0 : 0;

  // Format quote naturally — "X asset1 per asset0" when asset1 is the smaller-
  // valued unit (e.g. WETH per USDC = 0.00057), or "X asset0 per asset1"
  // otherwise (e.g. USDC per WETH = 1748). Pick whichever is >= 1 to display.
  let priceLabel: string;
  if (humanPrice1per0 >= 1) {
    priceLabel = `${humanPrice1per0.toFixed(humanPrice1per0 >= 100 ? 2 : 6)} ${sym1} per ${sym0}`;
  } else if (humanPrice0per1 >= 1) {
    priceLabel = `${humanPrice0per1.toFixed(humanPrice0per1 >= 100 ? 2 : 6)} ${sym0} per ${sym1}`;
  } else {
    priceLabel = `${humanPrice1per0.toExponential(4)} ${sym1} per ${sym0}`;
  }

  // ── Output ───────────────────────────────────────────────────────────
  // The leading "# ..." comment lines are valid env-file syntax (shells
  // ignore them), so the whole block can be pasted as-is.
  console.log(`# ${sym0} (${dec0}dp) / ${sym1} (${dec1}dp): ${priceLabel}`);
  console.log(
    `# oracle ${UNI_POOL_ADDRESS} @ block ${blockNumber}` +
      `${oracleToken0IsAsset0 ? "" : " (inverted: uniswap token0 = asset1)"}`,
  );
  console.log(`# uniPriceWad = ${uniPriceWad}  (raw asset1/asset0 ratio, WAD-scaled)`);
  console.log(`# convention: ${convention}`);
  console.log(`PRICE_X=${priceX}`);
  console.log(`PRICE_Y=${priceY}`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
