/**
 * Delta-neutral rebalance: sell all WETH → USDC via Euler orderflow router,
 * repay USDC debt, recompute equilibrium, reconfigure pool.
 *
 * Uses EVC batch with deferred checks — single atomic transaction:
 *   1. Withdraw all WETH from vault to Swapper (check deferred)
 *   2. Swapper swaps WETH→USDC, repays debt, deposits remainder
 *   3. SwapVerifier validates output
 *   → end of batch: account healthy (USDC deposit, no WETH, no debt)
 *
 * Usage: cd agent && npx tsx src/rebalance.ts
 */
import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  encodeAbiParameters,
  formatUnits,
  type Address,
  type Hash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { eulerSwapAbi, evcAbi, evaultAbi } from "./abi.js";

// --- Inlined boost math (from src/lib/math.ts, can't import across rootDir) ---

interface BoostParams {
  px: number; py: number;
  vyx: number; vxy: number;
  rx: number; ry: number;
  cx: number; cy: number;
  xr: number; yr: number;
  xd: number; yd: number;
}

function computeSx(rx: number, cx: number): number {
  return Math.sqrt((1 + rx - cx) / (1 - cx));
}
function computeSy(ry: number, cy: number): number {
  return Math.sqrt((1 + ry - cy) / (1 - cy));
}
function computePX(cx: number, sx: number): number { return cx + (1 - cx) * sx; }
function computePY(cy: number, sy: number): number { return cy + (1 - cy) * sy; }
function computeXb(v: number, rx: number, cx: number): number {
  return v / computeSx(rx, cx);
}
function computeYb(v: number, ry: number, cy: number): number {
  return v / computeSy(ry, cy);
}

function computeX0Additive(p: BoostParams): number {
  const { px, py, xr, yr, xd, yd, vyx, rx, cx } = p;
  const sx = computeSx(rx, cx);
  const PX = computePX(cx, sx);
  const R = 1 + rx;
  const pXyxb = (py / px) / R;
  const pxy = px / py;

  const denom = (sx - 1) * (R - vyx * PX);
  if (Math.abs(denom) < 1e-30) return xr;

  const num = vyx * (yr - yd) * pXyxb * sx * R
    + xr * (vyx * (sx - 1) * PX + R)
    + (0 - xd) * sx * R;
  const BX = num / denom;

  const x0 = xr + BX;
  const yXdelta = pxy * x0 * (sx - 1) * PX / sx;
  if (BX > xr / (sx - 1) && yXdelta > yd) {
    return Math.max(0, x0);
  }
  return Math.max(0, xr);
}

function computeY0Additive(p: BoostParams): number {
  const { px, py, xr, yr, xd, yd, vxy, ry, cy } = p;
  const sy = computeSy(ry, cy);
  const PY = computePY(cy, sy);
  const Ry = 1 + ry;
  const pYxyb = (px / py) / Ry;
  const pyx = py / px;

  const denom = (sy - 1) * (Ry - vxy * PY);
  if (Math.abs(denom) < 1e-30) return yr;

  const num = vxy * (xr - xd) * pYxyb * sy * Ry
    + yr * (vxy * (sy - 1) * PY + Ry)
    + (0 - yd) * sy * Ry;
  const BY = num / denom;

  const y0 = yr + BY;
  const xYdelta = pyx * y0 * (sy - 1) * PY / sy;
  if (BY > yr / (sy - 1) && xYdelta > xd) {
    return Math.max(0, y0);
  }
  return Math.max(0, yr);
}

// --- Config from env ---
const RPC_URL = process.env["RPC_URL"]!;
const PRIVATE_KEY = process.env["PRIVATE_KEY"]! as `0x${string}`;
const POOL_ADDRESS = process.env["POOL_ADDRESS"]! as Address;
const EVC_ADDRESS = process.env["EVC_ADDRESS"]! as Address;

// Uniswap V3 USDC/WETH 0.05% pool (for market price)
const UNI_POOL = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640" as Address;

// Pool range params (±5%, c=0)
const RX = 0.05;
const RY = 0.05;
const CX = 0;
const CY = 0;

// Borrow LTVs
const VYX_BORROW = 0.84;
const VXY_BORROW = 0.85;

const WAD = 10n ** 18n;
const Q192 = 2n ** 192n;
const TX_TIMEOUT_MS = 120_000;
const SLIPPAGE_PCT = 0.5; // 0.5%

const EULER_SWAP_API = "https://swap.euler.finance";

// Uniswap V3 slot0 ABI
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
] as const;

// EVC batch ABI (not in abi.ts)
const evcBatchAbi = [
  {
    name: "batch",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "items",
        type: "tuple[]",
        components: [
          { name: "targetContract", type: "address" },
          { name: "onBehalfOfAccount", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

// Swapper ABI fragments (for rebuilding multicall)
const swapperAbi = [
  {
    name: "repayAndDeposit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "vault", type: "address" },
      { name: "repayAmount", type: "uint256" },
      { name: "account", type: "address" },
    ],
    outputs: [],
  },
  {
    name: "multicall",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "calls", type: "bytes[]" }],
    outputs: [],
  },
] as const;

const MAX_UINT256 = 2n ** 256n - 1n;

// --- Euler orderflow router API types ---
interface SwapApiResponse {
  amountIn: string;
  amountOut: string;
  amountOutMin: string;
  swap: {
    swapperAddress: string;
    swapperData: string;
    multicallItems: Array<{ functionName: string; data: string }>;
  };
  verify: {
    verifierAddress: string;
    verifierData: string;
    type: string;
  };
  route: Array<{ providerName: string }>;
}

async function main() {
  const account = privateKeyToAccount(PRIVATE_KEY);
  const publicClient = createPublicClient({ chain: mainnet, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, chain: mainnet, transport: http(RPC_URL) });

  // --- Step 1: Read pool and vault state ---
  console.log("=== Rebalance USDC/WETH Pool ===\n");

  const [staticParams, dynamicParams] = await Promise.all([
    publicClient.readContract({ address: POOL_ADDRESS, abi: eulerSwapAbi, functionName: "getStaticParams" }),
    publicClient.readContract({ address: POOL_ADDRESS, abi: eulerSwapAbi, functionName: "getDynamicParams" }),
  ]);

  const eulerAccount = staticParams.eulerAccount as Address;
  const supplyVault0 = staticParams.supplyVault0 as Address;
  const supplyVault1 = staticParams.supplyVault1 as Address;
  const borrowVault0 = staticParams.borrowVault0 as Address;

  // Read vault state
  const [shares0, shares1, debt0, debt1] = await Promise.all([
    publicClient.readContract({ address: supplyVault0, abi: evaultAbi, functionName: "balanceOf", args: [eulerAccount] }),
    publicClient.readContract({ address: supplyVault1, abi: evaultAbi, functionName: "balanceOf", args: [eulerAccount] }),
    publicClient.readContract({ address: borrowVault0, abi: evaultAbi, functionName: "debtOf", args: [eulerAccount] }),
    publicClient.readContract({ address: supplyVault1, abi: evaultAbi, functionName: "debtOf", args: [eulerAccount] }),
  ]);

  const [deposit0, deposit1, asset0, asset1] = await Promise.all([
    shares0 > 0n
      ? publicClient.readContract({ address: supplyVault0, abi: evaultAbi, functionName: "convertToAssets", args: [shares0] })
      : Promise.resolve(0n),
    shares1 > 0n
      ? publicClient.readContract({ address: supplyVault1, abi: evaultAbi, functionName: "convertToAssets", args: [shares1] })
      : Promise.resolve(0n),
    publicClient.readContract({ address: supplyVault0, abi: evaultAbi, functionName: "asset" }),
    publicClient.readContract({ address: supplyVault1, abi: evaultAbi, functionName: "asset" }),
  ]);

  // Get market price from Uniswap
  const slot0 = await publicClient.readContract({ address: UNI_POOL, abi: uniV3Abi, functionName: "slot0" });
  const sqrtP = slot0[0];
  const priceWad = (sqrtP * sqrtP * WAD) / Q192;
  const ethPriceUsd = 1e30 / Number(priceWad);

  // Display position
  const dep0Usd = Number(deposit0) / 1e6;
  const dep1Eth = Number(deposit1) / 1e18;
  const debt0Usd = Number(debt0) / 1e6;
  const debt1Eth = Number(debt1) / 1e18;
  const nav = dep0Usd + dep1Eth * ethPriceUsd - debt0Usd - debt1Eth * ethPriceUsd;

  console.log(`ETH price: $${ethPriceUsd.toFixed(2)}`);
  console.log(`USDC deposit: ${dep0Usd.toFixed(2)}     USDC debt: ${debt0Usd.toFixed(2)}`);
  console.log(`WETH deposit: ${dep1Eth.toFixed(4)}    WETH debt: ${debt1Eth.toFixed(4)}`);
  console.log(`NAV: $${nav.toFixed(2)}`);
  console.log(`Net WETH: ${dep1Eth.toFixed(4)} (~$${(dep1Eth * ethPriceUsd).toFixed(0)})`);

  // --- Step 2: Compute sell amount ---
  const sellAmount = deposit1; // all WETH
  if (sellAmount <= 0n) {
    console.log("\nNo WETH to sell. Position is already USDC-only.");
    return;
  }

  console.log(`\nSell ${formatUnits(sellAmount, 18)} WETH → USDC via Euler orderflow router`);

  // Y/N confirmation
  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const confirm = await new Promise<string>((resolve) => rl.question("Proceed? [y/N] ", resolve));
  rl.close();
  if (confirm.toLowerCase() !== "y") {
    console.log("Aborted.");
    return;
  }

  // Helper: wait for tx
  async function waitTx(hash: Hash, label: string): Promise<void> {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: TX_TIMEOUT_MS });
    if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    console.log(`  ${label}: ${hash}`);
  }

  // --- Step 3: Get swap quote, simulate, and submit ---
  const MAX_ATTEMPTS = 3;

  async function getQuoteAndBuildBatch() {
    const deadline = Math.floor(Date.now() / 1000) + 300; // 5 min

    const swapParams = new URLSearchParams({
      chainId: "1",
      tokenIn: asset1 as string,                // WETH
      tokenOut: asset0 as string,               // USDC
      amount: sellAmount.toString(),
      receiver: supplyVault0 as string,         // USDC vault (repay + deposit)
      vaultIn: supplyVault1 as string,          // WETH vault (for unused input)
      origin: account.address,
      accountIn: eulerAccount as string,
      accountOut: eulerAccount as string,
      swapperMode: "0",                         // exact input
      slippage: SLIPPAGE_PCT.toString(),
      deadline: deadline.toString(),
      isRepay: "true",
      currentDebt: debt0.toString(),
      targetDebt: "0",
    });

    const swapRes = await fetch(`${EULER_SWAP_API}/swap?${swapParams}`);
    if (!swapRes.ok) {
      const err = await swapRes.text();
      throw new Error(`Euler swap API error: ${swapRes.status} ${err}`);
    }

    const swapData = (await swapRes.json()) as { data: SwapApiResponse };
    const quote = swapData.data;

    const providers = quote.route.map(r => r.providerName).join(", ");
    console.log(`  Route: ${providers}`);
    console.log(`  Quote: ${formatUnits(BigInt(quote.amountIn), 18)} WETH → ${formatUnits(BigInt(quote.amountOut), 6)} USDC`);
    console.log(`  Min out: ${formatUnits(BigInt(quote.amountOutMin), 6)} USDC (${SLIPPAGE_PCT}% slippage)`);

    // Post-process the API multicall: replace repay/repayAndDeposit with our own
    // using type(uint256).max so vault.repay() auto-caps to exact debt amount.
    // The API generates maxUint256-1 which _capRepayToBalance caps to balance,
    // causing E_RepayTooMuch when swap output > debt.
    const fixedMulticallItems: `0x${string}`[] = [];
    for (const item of quote.swap.multicallItems) {
      if (item.functionName === "repay" || item.functionName === "repayAndDeposit") {
        const fixed = encodeFunctionData({
          abi: swapperAbi,
          functionName: "repayAndDeposit",
          args: [asset0, supplyVault0, MAX_UINT256, eulerAccount],
        });
        fixedMulticallItems.push(fixed);
        console.log(`  Fixed: ${item.functionName} → repayAndDeposit(maxUint256)`);
      } else {
        fixedMulticallItems.push(item.data as `0x${string}`);
      }
    }

    // Re-encode as multicall(bytes[])
    const fixedSwapperData = encodeFunctionData({
      abi: swapperAbi,
      functionName: "multicall",
      args: [fixedMulticallItems],
    });

    // Build EVC batch items
    const withdrawData = encodeFunctionData({
      abi: evaultAbi,
      functionName: "withdraw",
      args: [sellAmount, quote.swap.swapperAddress as Address, eulerAccount],
    });

    const batchItems = [
      {
        targetContract: supplyVault1,
        onBehalfOfAccount: eulerAccount,
        value: 0n,
        data: withdrawData,
      },
      {
        targetContract: quote.swap.swapperAddress as Address,
        onBehalfOfAccount: eulerAccount,
        value: 0n,
        data: fixedSwapperData,
      },
      {
        targetContract: quote.verify.verifierAddress as Address,
        onBehalfOfAccount: eulerAccount,
        value: 0n,
        data: quote.verify.verifierData as `0x${string}`,
      },
    ];

    return batchItems;
  }

  let batchHash: Hash | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`\nAttempt ${attempt}/${MAX_ATTEMPTS}: Getting quote...`);
    const batchItems = await getQuoteAndBuildBatch();

    // Simulate with eth_call before sending
    const batchCalldata = encodeFunctionData({
      abi: evcBatchAbi,
      functionName: "batch",
      args: [batchItems],
    });

    try {
      await publicClient.call({
        to: EVC_ADDRESS,
        data: batchCalldata,
        account: account.address,
      });
      console.log("  Simulation OK, submitting tx...");
    } catch (simErr: any) {
      const reason = simErr?.cause?.data || simErr?.message?.slice(0, 200) || String(simErr);
      console.log(`  Simulation failed: ${reason}`);
      if (attempt < MAX_ATTEMPTS) continue;
      throw new Error(`All ${MAX_ATTEMPTS} attempts failed (last: ${reason})`);
    }

    batchHash = await walletClient.writeContract({
      address: EVC_ADDRESS,
      abi: evcBatchAbi,
      functionName: "batch",
      args: [batchItems],
      account,
      chain: mainnet,
    });
    await waitTx(batchHash, "EVC batch (withdraw + swap + verify)");
    break;
  }

  // --- Step 5: Recompute equilibrium and reconfigure ---
  console.log("\nStep 3/3: Reconfiguring pool...");

  // Read final vault state
  const [finalShares0, finalDebt0] = await Promise.all([
    publicClient.readContract({ address: supplyVault0, abi: evaultAbi, functionName: "balanceOf", args: [eulerAccount] }),
    publicClient.readContract({ address: borrowVault0, abi: evaultAbi, functionName: "debtOf", args: [eulerAccount] }),
  ]);
  const finalDeposit0 = finalShares0 > 0n
    ? await publicClient.readContract({ address: supplyVault0, abi: evaultAbi, functionName: "convertToAssets", args: [finalShares0] })
    : 0n;

  const xr = Number(finalDeposit0) / 1e6;
  const xd = Number(finalDebt0) / 1e6;

  // Market price (re-read for freshness)
  const slot0Fresh = await publicClient.readContract({ address: UNI_POOL, abi: uniV3Abi, functionName: "slot0" });
  const sqrtPFresh = slot0Fresh[0];
  const priceWadFresh = (sqrtPFresh * sqrtPFresh * WAD) / Q192;
  const marketPrice = 1e30 / Number(priceWadFresh);

  console.log(`  USDC deposit: ${xr.toFixed(2)}, USDC debt: ${xd.toFixed(2)}, ETH price: $${marketPrice.toFixed(2)}`);

  const params: BoostParams = {
    px: 1,
    py: marketPrice,
    vyx: VYX_BORROW,
    vxy: VXY_BORROW,
    rx: RX, ry: RY,
    cx: CX, cy: CY,
    xr,
    yr: 0,
    xd,
    yd: 0,
  };

  const eq0 = computeX0Additive(params);
  const eq1 = computeY0Additive(params);
  const min0 = computeXb(eq0, RX, CX);
  const min1 = computeYb(eq1, RY, CY);

  console.log(`  eq0: ${eq0.toFixed(0)} USDC, eq1: ${eq1.toFixed(4)} WETH`);
  console.log(`  min0: ${min0.toFixed(0)} USDC, min1: ${min1.toFixed(4)} WETH`);

  // Convert to raw
  const eq0Raw = BigInt(Math.round(eq0 * 1e6));
  const eq1Raw = BigInt(Math.round(eq1 * 1e18));
  const min0Raw = BigInt(Math.round(min0 * 1e6));
  const min1Raw = BigInt(Math.round(min1 * 1e18));

  // Market priceY
  const priceX = dynamicParams.priceX;
  const marketPriceY = (BigInt(priceX) * WAD) / priceWadFresh;

  console.log(`  priceY: ${dynamicParams.priceY} → ${marketPriceY}`);

  // Reconfigure
  const newDParams = {
    ...dynamicParams,
    equilibriumReserve0: eq0Raw,
    equilibriumReserve1: eq1Raw,
    minReserve0: min0Raw,
    minReserve1: min1Raw,
    priceY: marketPriceY,
  };

  const reconfigData = encodeFunctionData({
    abi: eulerSwapAbi,
    functionName: "reconfigure",
    args: [newDParams, { reserve0: eq0Raw, reserve1: eq1Raw }],
  });

  const reconfigHash = await walletClient.writeContract({
    address: EVC_ADDRESS,
    abi: evcAbi,
    functionName: "call",
    args: [POOL_ADDRESS, eulerAccount, 0n, reconfigData],
    account,
    chain: mainnet,
  });
  await waitTx(reconfigHash, "Reconfigure pool");

  // --- Verify ---
  console.log("\n=== Final State ===");
  const [fShares0, fShares1, fDebt0, fDebt1] = await Promise.all([
    publicClient.readContract({ address: supplyVault0, abi: evaultAbi, functionName: "balanceOf", args: [eulerAccount] }),
    publicClient.readContract({ address: supplyVault1, abi: evaultAbi, functionName: "balanceOf", args: [eulerAccount] }),
    publicClient.readContract({ address: borrowVault0, abi: evaultAbi, functionName: "debtOf", args: [eulerAccount] }),
    publicClient.readContract({ address: supplyVault1, abi: evaultAbi, functionName: "debtOf", args: [eulerAccount] }),
  ]);
  const fDep0 = fShares0 > 0n
    ? await publicClient.readContract({ address: supplyVault0, abi: evaultAbi, functionName: "convertToAssets", args: [fShares0] })
    : 0n;
  const fDep1 = fShares1 > 0n
    ? await publicClient.readContract({ address: supplyVault1, abi: evaultAbi, functionName: "convertToAssets", args: [fShares1] })
    : 0n;

  const finalDp = await publicClient.readContract({ address: POOL_ADDRESS, abi: eulerSwapAbi, functionName: "getDynamicParams" });

  console.log(`USDC deposit: ${(Number(fDep0) / 1e6).toFixed(2)}  debt: ${(Number(fDebt0) / 1e6).toFixed(2)}`);
  console.log(`WETH deposit: ${(Number(fDep1) / 1e18).toFixed(4)}  debt: ${(Number(fDebt1) / 1e18).toFixed(4)}`);
  console.log(`eq0: ${finalDp.equilibriumReserve0}  eq1: ${finalDp.equilibriumReserve1}`);
  console.log(`priceY: ${finalDp.priceY}`);
  console.log(`Done.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
