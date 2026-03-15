// 1inch Fusion fill transaction construction
//
// Constructs LOP fillOrderArgs calldata and submits via the resolver contract.
// Args layout: [extension_bytes][interaction_bytes]
// Interaction: [20-byte resolver address][extraData]
// TakerTraits packs: flags | extension_length | interaction_length | threshold

import type { Address, Hex, WalletClient, PublicClient } from "viem";
import { encodeAbiParameters, encodeFunctionData, concat, toHex, toBytes } from "viem";
import type { FusionApiOrder } from "./types";
import { resolverAbi, lopFillOrderArgsAbi } from "./types";

// TakerTraits bit layout (from TakerTraitsLib.sol)
const MAKER_AMOUNT_FLAG = 1n << 255n;
const ARGS_EXTENSION_LENGTH_OFFSET = 224n;
const ARGS_INTERACTION_LENGTH_OFFSET = 200n;
const AMOUNT_MASK = (1n << 185n) - 1n;

function packTakerTraits(
  extensionLength: number,
  interactionLength: number,
  threshold: bigint = 0n,
): bigint {
  return MAKER_AMOUNT_FLAG
    | (BigInt(extensionLength) << ARGS_EXTENSION_LENGTH_OFFSET)
    | (BigInt(interactionLength) << ARGS_INTERACTION_LENGTH_OFFSET)
    | (threshold & AMOUNT_MASK);
}

function encodeExtraData(
  pool: Address, makerAsset: Address, takerAsset: Address, minProfit: bigint,
): Hex {
  return encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
    [pool, makerAsset, takerAsset, minProfit],
  );
}

/** Split 65-byte signature into r, vs (EIP-2098 compact format for LOP V4) */
function splitSignature(sig: Hex): { r: Hex; vs: Hex } {
  const r = `0x${sig.slice(2, 66)}` as Hex;
  const sRaw = BigInt(`0x${sig.slice(66, 130)}`);
  const v = parseInt(sig.slice(130, 132), 16);
  const vs = v >= 27 ? sRaw | (BigInt(v - 27) << 255n) : sRaw;
  return { r, vs: `0x${vs.toString(16).padStart(64, "0")}` as Hex };
}

/** Parse remaining maker amount (explicit null check — || would treat "0" as falsy) */
function parseRemaining(order: FusionApiOrder): bigint {
  return BigInt(
    order.remainingMakerAmount != null && order.remainingMakerAmount !== ""
      ? order.remainingMakerAmount
      : order.order.makingAmount,
  );
}

/**
 * Build raw LOP.fillOrderArgs calldata forwarded via resolver.settleOrders(data).
 *
 * args = [extension][interaction], where interaction = [20-byte resolver][extraData].
 * TakerTraits encodes the lengths of each section.
 */
export function buildFillCalldata(
  order: FusionApiOrder,
  resolverAddress: Address,
  poolAddress: Address,
  minProfit: bigint = 0n,
): Hex {
  const { r, vs } = splitSignature(order.signature);

  const extraData = encodeExtraData(
    poolAddress, order.order.makerAsset, order.order.takerAsset, minProfit,
  );
  const interaction = concat([resolverAddress.toLowerCase() as Hex, extraData]);
  const interactionLength = toBytes(interaction).length;

  const extension = order.extension;
  const extensionLength = toBytes(extension).length;

  const args = concat([extension, interaction]);
  const takerTraits = packTakerTraits(extensionLength, interactionLength);

  return encodeFunctionData({
    abi: lopFillOrderArgsAbi,
    functionName: "fillOrderArgs",
    args: [
      {
        salt: BigInt(order.order.salt),
        maker: BigInt(order.order.maker),
        receiver: BigInt(order.order.receiver),
        makerAsset: BigInt(order.order.makerAsset),
        takerAsset: BigInt(order.order.takerAsset),
        makingAmount: BigInt(order.order.makingAmount),
        takingAmount: BigInt(order.order.takingAmount),
        makerTraits: BigInt(order.order.makerTraits),
      },
      r,
      vs,
      parseRemaining(order),
      takerTraits,
      toHex(toBytes(args)),
    ],
  });
}

/** Submit a fill via the resolver contract's settleOrders function */
export async function submitFill(
  walletClient: WalletClient,
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

/** Simulate a fill via eth_call to check if it would succeed */
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
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Build and sign a raw fill transaction for Flashbots bundle submission */
export async function buildSignedFillTx(
  walletClient: WalletClient,
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

  const prepared = await walletClient.prepareTransactionRequest({
    to: resolverAddress,
    data,
    account,
    chain: walletClient.chain,
  } as any);

  return walletClient.signTransaction({ ...prepared, account } as any);
}
