/**
 * Hook performance analysis — swaps since hook deployment only.
 * Uses per-block Uniswap prices for exact valuation.
 *
 * Usage: npx tsx scripts/analyze-hook.ts
 */
import { createPublicClient, http, formatUnits, parseAbiItem, type Address } from "viem";
import { mainnet } from "viem/chains";

// Defaults to the live USDC/WETH pool the author runs. Override via env vars
// to analyze a different pool: POOL_ADDRESS, UNI_POOL_ADDRESS, HOOK_DEPLOY_BLOCK,
// DECIMALS_0, DECIMALS_1.
const POOL = (process.env.POOL_ADDRESS ?? "0x4311031739918Aba578C3C667DA3028A12Ce28A8") as Address;
const UNI_POOL = (process.env.UNI_POOL_ADDRESS ?? "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640") as Address;
const HOOK_DEPLOY = BigInt(process.env.HOOK_DEPLOY_BLOCK ?? "24651832");
const DEC0 = Number(process.env.DECIMALS_0 ?? 6);
const DEC1 = Number(process.env.DECIMALS_1 ?? 18);

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) { console.error("Set RPC_URL"); process.exit(1); }

const client = createPublicClient({
  chain: mainnet, transport: http(RPC_URL),
  batch: { multicall: true },
});

const swapAbi = parseAbiItem(
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, uint256 fee0, uint256 fee1, uint112 reserve0, uint112 reserve1, address indexed to)"
);

const uniAbi = [{ name: "slot0", type: "function", stateMutability: "view", inputs: [], outputs: [
  { name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" },
  { name: "observationIndex", type: "uint16" }, { name: "observationCardinality", type: "uint16" },
  { name: "observationCardinalityNext", type: "uint16" }, { name: "feeProtocol", type: "uint8" },
  { name: "unlocked", type: "bool" },
]}] as const;

interface SwapData {
  blockNumber: bigint;
  sender: Address;
  amount0In: bigint; amount1In: bigint;
  amount0Out: bigint; amount1Out: bigint;
  fee0: bigint; fee1: bigint;
}

async function main() {
  const currentBlock = await client.getBlockNumber();
  console.log("Hook deployed at block " + HOOK_DEPLOY + ", current block " + currentBlock);
  console.log("Scanning " + Number(currentBlock - HOOK_DEPLOY) + " blocks...\n");

  // Fetch hook-era swaps
  const swaps: SwapData[] = [];
  let cursor = HOOK_DEPLOY;
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
  console.log("Found " + swaps.length + " swaps since hook deploy\n");

  if (swaps.length === 0) {
    console.log("No swaps to analyze.");
    return;
  }

  // Get unique blocks and fetch Uniswap prices
  const blocks = [...new Set(swaps.map(s => s.blockNumber))];
  const prices = new Map<bigint, number>();
  for (let i = 0; i < blocks.length; i += 20) {
    const batch = blocks.slice(i, i + 20);
    const results = await Promise.all(
      batch.map(bn => client.readContract({
        address: UNI_POOL, abi: uniAbi, functionName: "slot0", blockNumber: bn,
      }))
    );
    for (let j = 0; j < batch.length; j++) {
      const num = Number(results[j][0]) / 2 ** 96;
      const raw = num * num;
      const uni = raw * Math.pow(10, DEC0 - DEC1);
      prices.set(batch[j], 1 / uni);
    }
  }

  // Compute per-swap metrics
  let totalFees = 0, totalIL = 0, totalVol = 0;
  let swapsBuyingEth = 0, swapsSellingEth = 0;
  let feesBuyEth = 0, feesSelEth = 0;
  let ilBuyEth = 0, ilSelEth = 0;
  let volBuyEth = 0, volSelEth = 0;

  const perSwap: { fee: number; il: number; vol: number; feeBps: number; netBps: number; dir: string; block: bigint }[] = [];

  for (const s of swaps) {
    const p1 = prices.get(s.blockNumber) ?? 0;
    const f0 = Number(formatUnits(s.fee0, DEC0));
    const f1 = Number(formatUnits(s.fee1, DEC1));
    const in0 = Number(formatUnits(s.amount0In, DEC0));
    const out0 = Number(formatUnits(s.amount0Out, DEC0));
    const in1 = Number(formatUnits(s.amount1In, DEC1));
    const out1 = Number(formatUnits(s.amount1Out, DEC1));

    const fee = f0 + f1 * p1;
    const il = (in0 - out0) + (in1 - out1) * p1;
    const vol = in0 + in1 * p1;
    const feeBps = vol > 0 ? fee / vol * 10000 : 0;
    const netBps = vol > 0 ? (fee + il) / vol * 10000 : 0;
    const dir = in1 > 0 ? "pool_buys_eth" : "pool_sells_eth";

    totalFees += fee;
    totalIL += il;
    totalVol += vol;

    perSwap.push({ fee, il, vol, feeBps, netBps, dir, block: s.blockNumber });

    if (in1 > 0) {
      swapsBuyingEth++;
      feesBuyEth += fee;
      ilBuyEth += il;
      volBuyEth += vol;
    } else {
      swapsSellingEth++;
      feesSelEth += fee;
      ilSelEth += il;
      volSelEth += vol;
    }
  }

  const days = Number(currentBlock - HOOK_DEPLOY) * 12 / 86400;
  const netSwap = totalFees + totalIL;
  const capturePct = Math.abs(totalIL) > 0 ? totalFees / Math.abs(totalIL) * 100 : 0;
  const netBps = totalVol > 0 ? netSwap / totalVol * 10000 : 0;

  console.log("=".repeat(60));
  console.log("  Hook Performance (per-block Uniswap pricing)");
  console.log("=".repeat(60));
  console.log("  Period:        ~" + days.toFixed(1) + " days");
  console.log("  Swaps:          " + swaps.length);
  console.log("  Volume:         $" + totalVol.toFixed(0));
  console.log("-".repeat(60));
  console.log("  Fees:           $" + totalFees.toFixed(2));
  console.log("  IL:             $" + totalIL.toFixed(2));
  console.log("  Net swap P&L:   $" + netSwap.toFixed(2));
  console.log("  Fee capture:     " + capturePct.toFixed(1) + "%");
  console.log("  Net cost:        " + netBps.toFixed(2) + " bps");
  console.log("-".repeat(60));
  console.log("  By direction (pool perspective):");
  console.log("    Pool buys ETH:  " + swapsBuyingEth + " swaps, vol $" + volBuyEth.toFixed(0));
  console.log("      fees $" + feesBuyEth.toFixed(2) + ", IL $" + ilBuyEth.toFixed(2) + ", net $" + (feesBuyEth + ilBuyEth).toFixed(2));
  if (volBuyEth > 0) {
    console.log("      fee " + (feesBuyEth / volBuyEth * 10000).toFixed(1) + " bps, net " + ((feesBuyEth + ilBuyEth) / volBuyEth * 10000).toFixed(2) + " bps");
  }
  console.log("    Pool sells ETH: " + swapsSellingEth + " swaps, vol $" + volSelEth.toFixed(0));
  console.log("      fees $" + feesSelEth.toFixed(2) + ", IL $" + ilSelEth.toFixed(2) + ", net $" + (feesSelEth + ilSelEth).toFixed(2));
  if (volSelEth > 0) {
    console.log("      fee " + (feesSelEth / volSelEth * 10000).toFixed(1) + " bps, net " + ((feesSelEth + ilSelEth) / volSelEth * 10000).toFixed(2) + " bps");
  }

  // Fee distribution
  console.log("-".repeat(60));
  console.log("  Fee distribution (bps):");
  const feeBps = perSwap.map(s => s.feeBps).sort((a, b) => a - b);
  console.log("    Min:     " + feeBps[0].toFixed(1));
  console.log("    P10:     " + feeBps[Math.floor(feeBps.length * 0.1)].toFixed(1));
  console.log("    Median:  " + feeBps[Math.floor(feeBps.length * 0.5)].toFixed(1));
  console.log("    Mean:    " + (feeBps.reduce((a, b) => a + b, 0) / feeBps.length).toFixed(1));
  console.log("    P90:     " + feeBps[Math.floor(feeBps.length * 0.9)].toFixed(1));
  console.log("    Max:     " + feeBps[feeBps.length - 1].toFixed(1));

  // Net bps distribution
  console.log("  Net P&L distribution per swap (bps):");
  const netBpsArr = perSwap.map(s => s.netBps).sort((a, b) => a - b);
  console.log("    Min:     " + netBpsArr[0].toFixed(1));
  console.log("    P10:     " + netBpsArr[Math.floor(netBpsArr.length * 0.1)].toFixed(1));
  console.log("    Median:  " + netBpsArr[Math.floor(netBpsArr.length * 0.5)].toFixed(1));
  console.log("    Mean:    " + (netBpsArr.reduce((a, b) => a + b, 0) / netBpsArr.length).toFixed(1));
  console.log("    P90:     " + netBpsArr[Math.floor(netBpsArr.length * 0.9)].toFixed(1));
  console.log("    Max:     " + netBpsArr[netBpsArr.length - 1].toFixed(1));

  // Worst swaps
  console.log("-".repeat(60));
  console.log("  Worst 5 swaps (by net P&L USD):");
  const byNetUsd = [...perSwap].sort((a, b) => (a.fee + a.il) - (b.fee + b.il));
  for (let i = 0; i < Math.min(5, byNetUsd.length); i++) {
    const s = byNetUsd[i];
    console.log("    net $" + (s.fee + s.il).toFixed(2) + " (fee $" + s.fee.toFixed(2) + ", IL $" + s.il.toFixed(2) + ", vol $" + s.vol.toFixed(0) + ", " + s.feeBps.toFixed(0) + " bps fee, " + s.dir + ", block " + s.block + ")");
  }

  // Best swaps
  console.log("  Best 5 swaps (by net P&L USD):");
  for (let i = byNetUsd.length - 1; i >= Math.max(0, byNetUsd.length - 5); i--) {
    const s = byNetUsd[i];
    console.log("    net $" + (s.fee + s.il).toFixed(2) + " (fee $" + s.fee.toFixed(2) + ", IL $" + s.il.toFixed(2) + ", vol $" + s.vol.toFixed(0) + ", " + s.feeBps.toFixed(0) + " bps fee, " + s.dir + ", block " + s.block + ")");
  }

  // V4 comparison: swaps before the hook
  console.log("\n" + "=".repeat(60));
  console.log("  For comparison — V4 metrics (same pool, pre-hook):");
  // These are from the full attribution run
  const v4Fees = 1712.08 - totalFees;
  const v4IL = -2250.78 - totalIL;
  const v4Vol = 482459 - totalVol;
  if (v4Vol > 0) {
    console.log("  V4 fees:    $" + v4Fees.toFixed(2));
    console.log("  V4 IL:      $" + v4IL.toFixed(2));
    console.log("  V4 net:     $" + (v4Fees + v4IL).toFixed(2));
    console.log("  V4 capture: " + (v4Fees / Math.abs(v4IL) * 100).toFixed(1) + "%");
    console.log("  V4 net bps: " + ((v4Fees + v4IL) / v4Vol * 10000).toFixed(2) + " bps");
  }
  console.log("=".repeat(60));
}

main().catch(e => { console.error(e); process.exit(1); });
