/**
 * Hook performance analysis — swaps since hook deployment, per-block Uniswap
 * pricing for exact valuation.
 *
 * Usage:
 *   MAINNET_RPC_URL=...  npx tsx scripts/analyze-hook.ts
 *   MAINNET_RPC_URL=... POOL_ADDRESS=0x... npx tsx scripts/analyze-hook.ts
 *
 * Everything except the RPC URL is auto-detected from the on-chain pool:
 *   - asset0 / asset1 and their decimals
 *   - hook contract + oracle pool address
 *   - approximate hook deploy block (first Swap event on the pool)
 *
 * Supports Uniswap V3 oracle pools (slot0). V4-mode oracles (extsload via the
 * PoolManager) are detected and the script exits with a clear error — pricing
 * the historical V4 sqrtPrice from extsload at past blocks isn't implemented yet.
 */
import { createPublicClient, http, formatUnits, parseAbiItem, type Address } from "viem";
import { mainnet } from "viem/chains";

// Defaults to the live USDC/WETH pool with its V3 oracle. When overriding
// POOL_ADDRESS, also set UNI_POOL_ADDRESS to the matching V3 pool — the script
// errors out clearly if you don't, rather than silently producing nonsense.
const DEFAULT_POOL = "0x4311031739918Aba578C3C667DA3028A12Ce28A8" as Address;
const DEFAULT_UNI_POOL = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640" as Address; // USDC/WETH 0.05%
const POOL = (process.env.POOL_ADDRESS ?? DEFAULT_POOL) as Address;
const POOL_OVERRIDDEN = process.env.POOL_ADDRESS !== undefined
  && process.env.POOL_ADDRESS.toLowerCase() !== DEFAULT_POOL.toLowerCase();
const UNI_POOL = (process.env.UNI_POOL_ADDRESS ?? DEFAULT_UNI_POOL) as Address;
if (POOL_OVERRIDDEN && !process.env.UNI_POOL_ADDRESS) {
  console.error(
    "POOL_ADDRESS overridden without UNI_POOL_ADDRESS — the script defaults to the\n" +
    "USDC/WETH V3 oracle, which would produce nonsense prices for any other pair.\n" +
    "Set UNI_POOL_ADDRESS to the deepest Uniswap V3 pool for your token pair, OR\n" +
    "leave POOL_ADDRESS unset to analyze the default USDC/WETH pool."
  );
  process.exit(1);
}

const RPC_URL = process.env.MAINNET_RPC_URL ?? process.env.RPC_URL;
if (!RPC_URL) {
  console.error("MAINNET_RPC_URL is not set. Copy .env.example to .env and source it.");
  process.exit(1);
}

const client = createPublicClient({
  chain: mainnet,
  transport: http(RPC_URL),
  batch: { multicall: true },
});

// --- ABIs ---
const swapAbi = parseAbiItem(
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, uint256 fee0, uint256 fee1, uint112 reserve0, uint112 reserve1, address indexed to)"
);

const erc20Abi = [
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
] as const;

const eVaultAbi = [
  { name: "asset", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;

const poolAbi = [
  {
    name: "getStaticParams", type: "function", stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "tuple", components: [
      { name: "supplyVault0", type: "address" }, { name: "supplyVault1", type: "address" },
      { name: "borrowVault0", type: "address" }, { name: "borrowVault1", type: "address" },
      { name: "eulerAccount", type: "address" }, { name: "feeRecipient", type: "address" },
    ]}],
  },
  {
    name: "getDynamicParams", type: "function", stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "tuple", components: [
      { name: "equilibriumReserve0", type: "uint112" }, { name: "equilibriumReserve1", type: "uint112" },
      { name: "minReserve0", type: "uint112" }, { name: "minReserve1", type: "uint112" },
      { name: "priceX", type: "uint80" }, { name: "priceY", type: "uint80" },
      { name: "concentrationX", type: "uint64" }, { name: "concentrationY", type: "uint64" },
      { name: "fee0", type: "uint64" }, { name: "fee1", type: "uint64" },
      { name: "expiration", type: "uint40" }, { name: "swapHookedOperations", type: "uint8" },
      { name: "swapHook", type: "address" },
    ]}],
  },
] as const;

const hookAbi = [
  { name: "oracleTarget", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { name: "oracleV4PoolId", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bytes32" }] },
] as const;

const uniV3Abi = [
  { name: "slot0", type: "function", stateMutability: "view", inputs: [], outputs: [
    { name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" },
    { name: "observationIndex", type: "uint16" }, { name: "observationCardinality", type: "uint16" },
    { name: "observationCardinalityNext", type: "uint16" }, { name: "feeProtocol", type: "uint8" },
    { name: "unlocked", type: "bool" },
  ]},
] as const;

interface SwapData {
  blockNumber: bigint;
  sender: Address;
  amount0In: bigint; amount1In: bigint;
  amount0Out: bigint; amount1Out: bigint;
  fee0: bigint; fee1: bigint;
}

async function autoDetectPool() {
  const sp = await client.readContract({ address: POOL, abi: poolAbi, functionName: "getStaticParams" });
  const dp = await client.readContract({ address: POOL, abi: poolAbi, functionName: "getDynamicParams" });

  const [asset0, asset1] = await Promise.all([
    client.readContract({ address: sp.supplyVault0, abi: eVaultAbi, functionName: "asset" }),
    client.readContract({ address: sp.supplyVault1, abi: eVaultAbi, functionName: "asset" }),
  ]);

  const [dec0, dec1, sym0, sym1] = await Promise.all([
    client.readContract({ address: asset0, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: asset1, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: asset0, abi: erc20Abi, functionName: "symbol" }).catch(() => "asset0"),
    client.readContract({ address: asset1, abi: erc20Abi, functionName: "symbol" }).catch(() => "asset1"),
  ]);

  const hook = dp.swapHook;
  if (hook === "0x0000000000000000000000000000000000000000") {
    throw new Error("Pool has no hook installed (swapHook is zero). Cannot analyze.");
  }

  // Sanity-check that the V3 oracle exists by calling slot0 once. If this
  // reverts, the user pointed at a non-V3 pool (or the wrong address).
  try {
    await client.readContract({ address: UNI_POOL, abi: uniV3Abi, functionName: "slot0" });
  } catch (e: any) {
    throw new Error(
      `UNI_POOL_ADDRESS (${UNI_POOL}) does not look like a Uniswap V3 pool — slot0() ` +
      `reverted. If your hook uses a V4 oracle (via PoolManager extsload), this ` +
      `script does not yet support that mode.`
    );
  }

  return {
    pool: POOL,
    asset0, asset1,
    dec0: Number(dec0), dec1: Number(dec1),
    sym0, sym1,
    hook,
    uniPool: UNI_POOL,
  };
}

async function findHookDeployBlock(currentBlock: bigint): Promise<bigint> {
  // Scan backward in 100k-block chunks until we find no swaps; the earliest
  // swap is the closest proxy to "hook installed" we can get from event logs.
  let earliest: bigint | undefined;
  let cursor = currentBlock;
  const chunkSize = 100_000n;
  while (cursor > 0n) {
    const from = cursor > chunkSize ? cursor - chunkSize : 0n;
    const logs = await client.getLogs({ address: POOL, event: swapAbi, fromBlock: from, toBlock: cursor });
    if (logs.length === 0 && earliest !== undefined) break;
    if (logs.length > 0) {
      earliest = logs[0].blockNumber;
    }
    if (from === 0n) break;
    cursor = from - 1n;
  }
  if (earliest === undefined) {
    throw new Error(`No Swap events found on pool ${POOL}. Wrong address?`);
  }
  return earliest;
}

async function main() {
  const detected = await autoDetectPool();
  const currentBlock = await client.getBlockNumber();

  console.log("Auto-detected pool config:");
  console.log("  Pool:       " + detected.pool);
  console.log("  Hook:       " + detected.hook);
  console.log("  asset0:     " + detected.asset0 + "  (" + detected.sym0 + ", " + detected.dec0 + " decimals)");
  console.log("  asset1:     " + detected.asset1 + "  (" + detected.sym1 + ", " + detected.dec1 + " decimals)");
  console.log("  Oracle:     " + detected.uniPool + "  (Uniswap V3)");
  console.log();

  const hookDeploy = process.env.HOOK_DEPLOY_BLOCK
    ? BigInt(process.env.HOOK_DEPLOY_BLOCK)
    : await findHookDeployBlock(currentBlock);

  console.log("Scanning from block " + hookDeploy + " to " + currentBlock + " (" + Number(currentBlock - hookDeploy) + " blocks)...");
  console.log();

  // Fetch all swaps in the hook's era
  const swaps: SwapData[] = [];
  let cursor = hookDeploy;
  while (cursor <= currentBlock) {
    const end = cursor + 10000n > currentBlock ? currentBlock : cursor + 10000n;
    const logs = await client.getLogs({ address: POOL, event: swapAbi, fromBlock: cursor, toBlock: end });
    for (const log of logs) {
      swaps.push({
        blockNumber: log.blockNumber, sender: log.args.sender!,
        amount0In: log.args.amount0In!, amount1In: log.args.amount1In!,
        amount0Out: log.args.amount0Out!, amount1Out: log.args.amount1Out!,
        fee0: log.args.fee0!, fee1: log.args.fee1!,
      });
    }
    cursor = end + 1n;
  }
  console.log("Found " + swaps.length + " swaps in this hook's era.");
  if (swaps.length === 0) return;
  console.log();

  // Fetch Uniswap V3 prices at each unique block. Price is denominated as
  // "asset0 per asset1" — i.e. for USDC/WETH this is "USDC per WETH".
  const blocks = [...new Set(swaps.map(s => s.blockNumber))];
  const prices = new Map<bigint, number>();
  for (let i = 0; i < blocks.length; i += 20) {
    const batch = blocks.slice(i, i + 20);
    const results = await Promise.all(
      batch.map(bn => client.readContract({
        address: detected.uniPool, abi: uniV3Abi, functionName: "slot0", blockNumber: bn,
      }))
    );
    for (let j = 0; j < batch.length; j++) {
      const sqrtX96 = Number(results[j][0]) / 2 ** 96;
      const raw = sqrtX96 * sqrtX96; // asset1 per asset0 in token units (before decimals)
      const uni = raw * Math.pow(10, detected.dec0 - detected.dec1);
      prices.set(batch[j], 1 / uni); // asset0 per asset1
    }
  }

  // Compute per-swap metrics. All amounts converted to asset0 terms (USD-like
  // for USDC-paired pools, but really "asset0 units" generically).
  let totalFees = 0, totalIL = 0, totalVol = 0;
  let swapsBuyingAsset1 = 0, swapsSellingAsset1 = 0;
  let feesBuy = 0, feesSel = 0, ilBuy = 0, ilSel = 0, volBuy = 0, volSel = 0;
  const perSwap: { fee: number; il: number; vol: number; feeBps: number; netBps: number; dir: string; block: bigint }[] = [];

  for (const s of swaps) {
    const p1 = prices.get(s.blockNumber) ?? 0;
    const f0 = Number(formatUnits(s.fee0, detected.dec0));
    const f1 = Number(formatUnits(s.fee1, detected.dec1));
    const in0 = Number(formatUnits(s.amount0In, detected.dec0));
    const out0 = Number(formatUnits(s.amount0Out, detected.dec0));
    const in1 = Number(formatUnits(s.amount1In, detected.dec1));
    const out1 = Number(formatUnits(s.amount1Out, detected.dec1));

    const fee = f0 + f1 * p1;
    const il = (in0 - out0) + (in1 - out1) * p1;
    const vol = in0 + in1 * p1;
    const feeBps = vol > 0 ? fee / vol * 10000 : 0;
    const netBps = vol > 0 ? (fee + il) / vol * 10000 : 0;
    const dir = in1 > 0 ? `pool_buys_${detected.sym1}` : `pool_sells_${detected.sym1}`;

    totalFees += fee;
    totalIL += il;
    totalVol += vol;
    perSwap.push({ fee, il, vol, feeBps, netBps, dir, block: s.blockNumber });

    if (in1 > 0) { swapsBuyingAsset1++; feesBuy += fee; ilBuy += il; volBuy += vol; }
    else        { swapsSellingAsset1++; feesSel += fee; ilSel += il; volSel += vol; }
  }

  const days = Number(currentBlock - hookDeploy) * 12 / 86400;
  const netSwap = totalFees + totalIL;
  const capturePct = Math.abs(totalIL) > 0 ? totalFees / Math.abs(totalIL) * 100 : 0;
  const netBps = totalVol > 0 ? netSwap / totalVol * 10000 : 0;
  const denom = detected.sym0; // P&L denominated in asset0 (usually a stable)

  console.log("=".repeat(60));
  console.log("  Hook Performance (per-block " + detected.sym0 + "/" + detected.sym1 + " Uniswap pricing, P&L in " + denom + ")");
  console.log("=".repeat(60));
  console.log("  Period:        ~" + days.toFixed(1) + " days");
  console.log("  Swaps:          " + swaps.length);
  console.log("  Volume:         " + denom + " " + totalVol.toFixed(0));
  console.log("-".repeat(60));
  console.log("  Fees:           " + denom + " " + totalFees.toFixed(2));
  console.log("  IL:             " + denom + " " + totalIL.toFixed(2));
  console.log("  Net swap P&L:   " + denom + " " + netSwap.toFixed(2));
  console.log("  Fee capture:     " + capturePct.toFixed(1) + "%");
  console.log("  Net cost:        " + netBps.toFixed(2) + " bps");
  console.log("-".repeat(60));
  console.log("  By direction (pool perspective):");
  console.log("    Pool buys " + detected.sym1 + ": " + swapsBuyingAsset1 + " swaps, vol " + denom + " " + volBuy.toFixed(0));
  console.log("      fees " + denom + " " + feesBuy.toFixed(2) + ", IL " + denom + " " + ilBuy.toFixed(2) + ", net " + denom + " " + (feesBuy + ilBuy).toFixed(2));
  if (volBuy > 0) {
    console.log("      fee " + (feesBuy / volBuy * 10000).toFixed(1) + " bps, net " + ((feesBuy + ilBuy) / volBuy * 10000).toFixed(2) + " bps");
  }
  console.log("    Pool sells " + detected.sym1 + ": " + swapsSellingAsset1 + " swaps, vol " + denom + " " + volSel.toFixed(0));
  console.log("      fees " + denom + " " + feesSel.toFixed(2) + ", IL " + denom + " " + ilSel.toFixed(2) + ", net " + denom + " " + (feesSel + ilSel).toFixed(2));
  if (volSel > 0) {
    console.log("      fee " + (feesSel / volSel * 10000).toFixed(1) + " bps, net " + ((feesSel + ilSel) / volSel * 10000).toFixed(2) + " bps");
  }

  // Fee distribution
  console.log("-".repeat(60));
  console.log("  Fee distribution (bps):");
  const feeBpsArr = perSwap.map(s => s.feeBps).sort((a, b) => a - b);
  console.log("    Min:     " + feeBpsArr[0].toFixed(1));
  console.log("    P10:     " + feeBpsArr[Math.floor(feeBpsArr.length * 0.1)].toFixed(1));
  console.log("    Median:  " + feeBpsArr[Math.floor(feeBpsArr.length * 0.5)].toFixed(1));
  console.log("    Mean:    " + (feeBpsArr.reduce((a, b) => a + b, 0) / feeBpsArr.length).toFixed(1));
  console.log("    P90:     " + feeBpsArr[Math.floor(feeBpsArr.length * 0.9)].toFixed(1));
  console.log("    Max:     " + feeBpsArr[feeBpsArr.length - 1].toFixed(1));

  console.log("  Net P&L distribution per swap (bps):");
  const netBpsArr = perSwap.map(s => s.netBps).sort((a, b) => a - b);
  console.log("    Min:     " + netBpsArr[0].toFixed(1));
  console.log("    P10:     " + netBpsArr[Math.floor(netBpsArr.length * 0.1)].toFixed(1));
  console.log("    Median:  " + netBpsArr[Math.floor(netBpsArr.length * 0.5)].toFixed(1));
  console.log("    Mean:    " + (netBpsArr.reduce((a, b) => a + b, 0) / netBpsArr.length).toFixed(1));
  console.log("    P90:     " + netBpsArr[Math.floor(netBpsArr.length * 0.9)].toFixed(1));
  console.log("    Max:     " + netBpsArr[netBpsArr.length - 1].toFixed(1));

  // Worst / best
  console.log("-".repeat(60));
  console.log("  Worst 5 swaps (by net P&L " + denom + "):");
  const byNet = [...perSwap].sort((a, b) => (a.fee + a.il) - (b.fee + b.il));
  for (let i = 0; i < Math.min(5, byNet.length); i++) {
    const s = byNet[i];
    console.log("    net " + denom + " " + (s.fee + s.il).toFixed(2) + " (fee " + s.fee.toFixed(2) + ", IL " + s.il.toFixed(2) + ", vol " + s.vol.toFixed(0) + ", " + s.feeBps.toFixed(0) + " bps fee, " + s.dir + ", block " + s.block + ")");
  }
  console.log("  Best 5 swaps (by net P&L " + denom + "):");
  for (let i = byNet.length - 1; i >= Math.max(0, byNet.length - 5); i--) {
    const s = byNet[i];
    console.log("    net " + denom + " " + (s.fee + s.il).toFixed(2) + " (fee " + s.fee.toFixed(2) + ", IL " + s.il.toFixed(2) + ", vol " + s.vol.toFixed(0) + ", " + s.feeBps.toFixed(0) + " bps fee, " + s.dir + ", block " + s.block + ")");
  }
  console.log("=".repeat(60));
}

main().catch(e => { console.error(e.message ?? e); process.exit(1); });
