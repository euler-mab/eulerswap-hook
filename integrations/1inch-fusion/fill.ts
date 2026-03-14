// 1inch Fusion fill transaction construction
// Constructs LOP fillOrderArgs calldata and submits via the resolver contract

import type { Address, Hex, WalletClient, PublicClient } from "viem";
import { encodeAbiParameters, encodeFunctionData } from "viem";
import type { FusionApiOrder } from "./types";
import { ADDRESSES, resolverAbi, lopFillOrderArgsAbi } from "./types";

/**
 * Encode the takerInteraction extraData for our resolver contract.
 * Format: abi.encode(address pool, address makerAsset, address takerAsset, uint256 minProfit)
 */
export function encodeExtraData(
  poolAddress: Address,
  makerAsset: Address,
  takerAsset: Address,
  minProfit: bigint = 0n,
): Hex {
  return encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
    ],
    [poolAddress, makerAsset, takerAsset, minProfit],
  );
}

/**
 * Build the raw calldata for LOP.fillOrderArgs that will be forwarded
 * via resolver.settleOrders(data).
 *
 * This is the core of the fill: it tells the LOP to fill the order with
 * our resolver as taker, and includes the takerInteraction data that
 * triggers our EulerSwap swap.
 *
 * NOTE: The exact calldata construction depends on 1inch's order encoding.
 * The signature must be split into r, vs components for the LOP.
 * TakerTraits encode flags + threshold + extension/interaction offsets.
 * This is a simplified version — production use requires the Fusion SDK
 * or manual TakerTraits encoding matching the LOP's expectations.
 */
export function buildFillCalldata(
  order: FusionApiOrder,
  resolverAddress: Address,
  poolAddress: Address = ADDRESSES.pool,
  minProfit: bigint = 0n,
): Hex {
  // Split signature into r, vs (EIP-2098 compact)
  const sig = order.signature;
  const r = `0x${sig.slice(2, 66)}` as Hex;
  const sRaw = BigInt(`0x${sig.slice(66, 130)}`);
  const v = parseInt(sig.slice(130, 132), 16);
  // vs = s | (v - 27) << 255
  const vs = v >= 27 ? sRaw | (BigInt(v - 27) << 255n) : sRaw;
  const vsHex = `0x${vs.toString(16).padStart(64, "0")}` as Hex;

  // Build the takerInteraction extraData
  const extraData = encodeExtraData(
    poolAddress,
    order.order.makerAsset,
    order.order.takerAsset,
    minProfit,
  );

  // The args parameter for fillOrderArgs contains:
  // - The extension (for Settlement contract callbacks)
  // - The takerInteraction (our extraData, called by LOP during fill)
  // In production, this needs proper TakerTraits encoding.
  // The args bytes concatenate: extension + interaction data
  const args = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes" }],
    [order.extension, extraData],
  );

  // TakerTraits: encodes the fill amount threshold and flags
  // Bit layout (from 1inch docs):
  // - bit 255: maker amount flag (0 = taking amount, 1 = making amount)
  // - bit 254: unwrap WETH flag
  // - bit 253: skip permit flag
  // - bits 252-0: threshold amount
  // For simplicity, use taking amount mode with the order's takingAmount as threshold
  const takerTraits = BigInt(order.order.takingAmount);

  // Amount to fill (full making amount)
  const fillAmount = BigInt(order.remainingMakerAmount || order.order.makingAmount);

  // Encode the LOP fillOrderArgs call
  return encodeFunctionData({
    abi: lopFillOrderArgsAbi,
    functionName: "fillOrderArgs",
    args: [
      {
        salt: BigInt(order.order.salt),
        maker: order.order.maker,
        receiver: order.order.receiver,
        makerAsset: order.order.makerAsset,
        takerAsset: order.order.takerAsset,
        makingAmount: BigInt(order.order.makingAmount),
        takingAmount: BigInt(order.order.takingAmount),
        makerTraits: BigInt(order.order.makerTraits),
      },
      r,
      vsHex,
      fillAmount,
      takerTraits,
      args,
    ],
  });
}

/**
 * Submit a fill via the resolver contract's settleOrders function.
 */
export async function submitFill(
  walletClient: WalletClient,
  publicClient: PublicClient,
  resolverAddress: Address,
  fillCalldata: Hex,
): Promise<Hex> {
  const account = walletClient.account;
  if (!account) throw new Error("WalletClient has no account");

  return walletClient.writeContract({
    address: resolverAddress,
    abi: resolverAbi,
    functionName: "settleOrders",
    args: [fillCalldata],
    chain: walletClient.chain,
    account,
  });
}

/**
 * Simulate a fill via eth_call to check if it would succeed.
 */
export async function simulateFill(
  publicClient: PublicClient,
  resolverAddress: Address,
  fillCalldata: Hex,
  fromAddress: Address,
): Promise<{ success: boolean; error?: string }> {
  try {
    await publicClient.simulateContract({
      address: resolverAddress,
      abi: resolverAbi,
      functionName: "settleOrders",
      args: [fillCalldata],
      account: fromAddress,
    });
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * Build and sign a raw fill transaction for Flashbots bundle submission.
 */
export async function buildSignedFillTx(
  walletClient: WalletClient,
  publicClient: PublicClient,
  resolverAddress: Address,
  fillCalldata: Hex,
): Promise<Hex> {
  const account = walletClient.account;
  if (!account) throw new Error("WalletClient has no account");

  const data = encodeFunctionData({
    abi: resolverAbi,
    functionName: "settleOrders",
    args: [fillCalldata],
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prepared = await walletClient.prepareTransactionRequest({
    to: resolverAddress,
    data,
    account,
    chain: walletClient.chain,
  } as any);

  return walletClient.signTransaction({ ...prepared, account } as any);
}
