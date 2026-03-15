// 1inch Fusion fill transaction construction
// Constructs LOP fillOrderArgs calldata and submits via the resolver contract
//
// Key reference: TakerTraitsLib.sol from 1inch/limit-order-protocol-contract
// Args layout: [extension_bytes][interaction_bytes]
// Interaction: [20-byte resolver address][extraData for takerInteraction]
// TakerTraits packs: flags | extension_length | interaction_length | threshold

import type { Address, Hex, WalletClient, PublicClient } from "viem";
import { encodeAbiParameters, encodeFunctionData, concat, toHex, toBytes } from "viem";
import type { FusionApiOrder } from "./types";
import { resolverAbi, lopFillOrderArgsAbi } from "./types";

// ---- TakerTraits bit layout (from TakerTraitsLib.sol) ----

const MAKER_AMOUNT_FLAG = 1n << 255n;
// const UNWRAP_WETH_FLAG = 1n << 254n;
// const SKIP_ORDER_PERMIT_FLAG = 1n << 253n;
// const USE_PERMIT2_FLAG = 1n << 252n;
// const ARGS_HAS_TARGET = 1n << 251n;

const ARGS_EXTENSION_LENGTH_OFFSET = 224n;
const ARGS_INTERACTION_LENGTH_OFFSET = 200n;

// Threshold occupies bits 0-184
const AMOUNT_MASK = (1n << 185n) - 1n;

/**
 * Pack TakerTraits uint256 from components.
 *
 * Bit layout:
 *   255:     maker amount flag (1 = amount param is making amount)
 *   254:     unwrap WETH
 *   253:     skip order permit
 *   252:     use permit2
 *   251:     args has target (first 20 bytes of args = delivery address)
 *   224-247: extension length (24 bits)
 *   200-223: interaction length (24 bits)
 *   0-184:   threshold amount
 */
function packTakerTraits(opts: {
  makerAmountMode: boolean;
  extensionLength: number;
  interactionLength: number;
  threshold: bigint;
}): bigint {
  let traits = 0n;

  if (opts.makerAmountMode) {
    traits |= MAKER_AMOUNT_FLAG;
  }

  // Extension length in bits 224-247
  traits |= BigInt(opts.extensionLength) << ARGS_EXTENSION_LENGTH_OFFSET;

  // Interaction length in bits 200-223
  traits |= BigInt(opts.interactionLength) << ARGS_INTERACTION_LENGTH_OFFSET;

  // Threshold in bits 0-184
  traits |= opts.threshold & AMOUNT_MASK;

  return traits;
}

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
 * Build interaction bytes: [20-byte resolver address][extraData]
 *
 * The LOP splits interaction as:
 *   target = address(bytes20(interaction))
 *   extraData = interaction[20:]
 * Then calls target.takerInteraction(..., extraData)
 */
function buildInteractionBytes(
  resolverAddress: Address,
  extraData: Hex,
): Hex {
  // Resolver address as raw 20 bytes (no padding)
  const addrBytes = resolverAddress.toLowerCase() as Hex;
  // extraData is already hex-encoded, strip 0x prefix for concat
  return concat([addrBytes, extraData]);
}

/**
 * Split a 65-byte signature into r, vs (EIP-2098 compact format).
 * LOP V4 expects (bytes32 r, bytes32 vs).
 */
function splitSignature(sig: Hex): { r: Hex; vs: Hex } {
  const r = `0x${sig.slice(2, 66)}` as Hex;
  const sRaw = BigInt(`0x${sig.slice(66, 130)}`);
  const v = parseInt(sig.slice(130, 132), 16);
  // vs = s | (v - 27) << 255
  const vs = v >= 27 ? sRaw | (BigInt(v - 27) << 255n) : sRaw;
  return {
    r,
    vs: `0x${vs.toString(16).padStart(64, "0")}` as Hex,
  };
}

/**
 * Build the raw calldata for LOP.fillOrderArgs that will be forwarded
 * via resolver.settleOrders(data).
 *
 * This constructs the exact args layout the LOP expects:
 *   args = [extension_bytes][interaction_bytes]
 *
 * Where interaction_bytes = [20-byte resolver address][extraData]
 * And TakerTraits encodes the lengths of each section.
 *
 * The LOP's _parseArgs function reads:
 *   1. Optional target (20 bytes if ARGS_HAS_TARGET set) — we don't use this
 *   2. extension[0:extensionLength]
 *   3. interaction[0:interactionLength]
 */
export function buildFillCalldata(
  order: FusionApiOrder,
  resolverAddress: Address,
  poolAddress: Address,
  minProfit: bigint = 0n,
): Hex {
  const { r, vs } = splitSignature(order.signature);

  // Build interaction: [resolver_address (20 bytes)][extraData]
  const extraData = encodeExtraData(
    poolAddress,
    order.order.makerAsset,
    order.order.takerAsset,
    minProfit,
  );
  const interactionBytes = buildInteractionBytes(resolverAddress, extraData);
  const interactionLength = toBytes(interactionBytes).length;

  // Extension bytes from the order (contains Settlement callbacks, auction data, etc.)
  const extensionBytes = order.extension;
  const extensionLength = toBytes(extensionBytes).length;

  // Concatenate: [extension][interaction] — raw bytes, not ABI-encoded
  const args = concat([extensionBytes, interactionBytes]);

  // Pack TakerTraits with correct lengths and flags
  // Use maker amount mode: fill `amount` is a making amount,
  // threshold is the max taking amount we'll accept
  const takerTraits = packTakerTraits({
    makerAmountMode: true,
    extensionLength,
    interactionLength,
    // Threshold: max taking amount (0 = no rate check, let the contract's
    // own InsufficientProfit check handle it)
    threshold: 0n,
  });

  // Amount to fill (remaining making amount)
  // Use ?? with explicit check — || would treat "0" as falsy and use full amount
  const fillAmount = BigInt(
    order.remainingMakerAmount != null && order.remainingMakerAmount !== ""
      ? order.remainingMakerAmount
      : order.order.makingAmount,
  );

  // Encode the LOP fillOrderArgs call
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
      fillAmount,
      takerTraits,
      toHex(toBytes(args)),
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
