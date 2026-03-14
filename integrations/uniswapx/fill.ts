// UniswapX fill transaction construction
// Supports direct fill (from wallet inventory) and callback fill (via executor contract)

import type { Address, Hex, WalletClient, PublicClient } from "viem";
import { encodeAbiParameters, encodeFunctionData } from "viem";
import type { UniswapXApiOrder } from "./types";
import { ADDRESSES } from "./types";

// Reactor ABI — execute, executeWithCallback, and batch variants
const reactorAbi = [
  {
    name: "execute",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          { name: "order", type: "bytes" },
          { name: "sig", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
  {
    name: "executeWithCallback",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          { name: "order", type: "bytes" },
          { name: "sig", type: "bytes" },
        ],
      },
      { name: "callbackData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "executeBatch",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "orders",
        type: "tuple[]",
        components: [
          { name: "order", type: "bytes" },
          { name: "sig", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
  {
    name: "executeBatchWithCallback",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "orders",
        type: "tuple[]",
        components: [
          { name: "order", type: "bytes" },
          { name: "sig", type: "bytes" },
        ],
      },
      { name: "callbackData", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

// ERC20 approve ABI
const erc20Abi = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Encode callbackData for the executor contract: (address pool, uint256 minProfit) */
export function encodeCallbackData(
  poolAddress: Address,
  minProfit: bigint = 0n,
): Hex {
  return encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [poolAddress, minProfit],
  );
}

/**
 * Direct fill: filler wallet has output tokens, calls reactor.execute().
 * Requires the filler to have pre-approved output tokens to the reactor.
 */
export async function directFill(
  walletClient: WalletClient,
  publicClient: PublicClient,
  apiOrder: UniswapXApiOrder,
  reactorAddress: Address = ADDRESSES.reactorV2,
): Promise<Hex> {
  const account = walletClient.account;
  if (!account) throw new Error("WalletClient has no account");

  return walletClient.writeContract({
    address: reactorAddress,
    abi: reactorAbi,
    functionName: "execute",
    args: [{ order: apiOrder.encodedOrder, sig: apiOrder.signature }],
    chain: walletClient.chain,
    account,
  });
}

/**
 * Callback fill: calls reactor.executeWithCallback() which triggers the executor contract.
 * The executor decodes callbackData to get pool address and min profit threshold.
 */
export async function callbackFill(
  walletClient: WalletClient,
  publicClient: PublicClient,
  apiOrder: UniswapXApiOrder,
  executorAddress: Address,
  poolAddress: Address = ADDRESSES.pool,
  minProfit: bigint = 0n,
  reactorAddress: Address = ADDRESSES.reactorV2,
): Promise<Hex> {
  const account = walletClient.account;
  if (!account) throw new Error("WalletClient has no account");

  return walletClient.writeContract({
    address: reactorAddress,
    abi: reactorAbi,
    functionName: "executeWithCallback",
    args: [
      { order: apiOrder.encodedOrder, sig: apiOrder.signature },
      encodeCallbackData(poolAddress, minProfit),
    ],
    chain: walletClient.chain,
    account,
  });
}

/**
 * Batch callback fill: fills multiple orders atomically via executeBatchWithCallback.
 * Amortizes gas across orders. The executor's reactorCallback loops over all resolved orders.
 */
export async function batchCallbackFill(
  walletClient: WalletClient,
  publicClient: PublicClient,
  apiOrders: UniswapXApiOrder[],
  executorAddress: Address,
  poolAddress: Address = ADDRESSES.pool,
  minProfit: bigint = 0n,
  reactorAddress: Address = ADDRESSES.reactorV2,
): Promise<Hex> {
  const account = walletClient.account;
  if (!account) throw new Error("WalletClient has no account");

  const signedOrders = apiOrders.map((o) => ({
    order: o.encodedOrder,
    sig: o.signature,
  }));

  return walletClient.writeContract({
    address: reactorAddress,
    abi: reactorAbi,
    functionName: "executeBatchWithCallback",
    args: [signedOrders, encodeCallbackData(poolAddress, minProfit)],
    chain: walletClient.chain,
    account,
  });
}

/**
 * Simulate a callback fill via eth_call. Returns success/failure and gas estimate.
 */
export async function simulateFill(
  publicClient: PublicClient,
  apiOrder: UniswapXApiOrder,
  executorAddress: Address,
  poolAddress: Address = ADDRESSES.pool,
  minProfit: bigint = 0n,
  reactorAddress: Address = ADDRESSES.reactorV2,
  fromAddress: Address,
): Promise<{ success: boolean; error?: string; gasEstimate?: bigint }> {
  try {
    await publicClient.simulateContract({
      address: reactorAddress,
      abi: reactorAbi,
      functionName: "executeWithCallback",
      args: [
        { order: apiOrder.encodedOrder, sig: apiOrder.signature },
        encodeCallbackData(poolAddress, minProfit),
      ],
      account: fromAddress,
    });

    // Get gas estimate
    const gasEstimate = await publicClient
      .estimateContractGas({
        address: reactorAddress,
        abi: reactorAbi,
        functionName: "executeWithCallback",
        args: [
          { order: apiOrder.encodedOrder, sig: apiOrder.signature },
          encodeCallbackData(poolAddress, minProfit),
        ],
        account: fromAddress,
      })
      .catch(() => undefined);

    return { success: true, gasEstimate };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * Simulate a batch callback fill via eth_call.
 */
export async function simulateBatchFill(
  publicClient: PublicClient,
  apiOrders: UniswapXApiOrder[],
  executorAddress: Address,
  poolAddress: Address = ADDRESSES.pool,
  minProfit: bigint = 0n,
  reactorAddress: Address = ADDRESSES.reactorV2,
  fromAddress: Address,
): Promise<{ success: boolean; error?: string; gasEstimate?: bigint }> {
  const signedOrders = apiOrders.map((o) => ({
    order: o.encodedOrder,
    sig: o.signature,
  }));

  try {
    await publicClient.simulateContract({
      address: reactorAddress,
      abi: reactorAbi,
      functionName: "executeBatchWithCallback",
      args: [signedOrders, encodeCallbackData(poolAddress, minProfit)],
      account: fromAddress,
    });

    const gasEstimate = await publicClient
      .estimateContractGas({
        address: reactorAddress,
        abi: reactorAbi,
        functionName: "executeBatchWithCallback",
        args: [signedOrders, encodeCallbackData(poolAddress, minProfit)],
        account: fromAddress,
      })
      .catch(() => undefined);

    return { success: true, gasEstimate };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * Build and sign a raw fill transaction for Flashbots bundle submission.
 * Uses encodeFunctionData + prepareTransactionRequest + signTransaction
 * to produce a signed EIP-1559 transaction hex without broadcasting.
 */
export async function buildSignedFillTx(
  walletClient: WalletClient,
  publicClient: PublicClient,
  apiOrder: UniswapXApiOrder,
  executorAddress: Address,
  poolAddress: Address = ADDRESSES.pool,
  minProfit: bigint = 0n,
  reactorAddress: Address = ADDRESSES.reactorV2,
): Promise<Hex> {
  const account = walletClient.account;
  if (!account) throw new Error("WalletClient has no account");

  const data = encodeFunctionData({
    abi: reactorAbi,
    functionName: "executeWithCallback",
    args: [
      { order: apiOrder.encodedOrder, sig: apiOrder.signature },
      encodeCallbackData(poolAddress, minProfit),
    ],
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- viem's strict generics
  const prepared = await walletClient.prepareTransactionRequest({
    to: reactorAddress,
    data,
    account,
    chain: walletClient.chain,
  } as any);

  return walletClient.signTransaction({ ...prepared, account } as any);
}

/**
 * Build and sign a raw batch fill transaction for Flashbots bundle submission.
 */
export async function buildSignedBatchFillTx(
  walletClient: WalletClient,
  publicClient: PublicClient,
  apiOrders: UniswapXApiOrder[],
  executorAddress: Address,
  poolAddress: Address = ADDRESSES.pool,
  minProfit: bigint = 0n,
  reactorAddress: Address = ADDRESSES.reactorV2,
): Promise<Hex> {
  const account = walletClient.account;
  if (!account) throw new Error("WalletClient has no account");

  const signedOrders = apiOrders.map((o) => ({
    order: o.encodedOrder,
    sig: o.signature,
  }));

  const data = encodeFunctionData({
    abi: reactorAbi,
    functionName: "executeBatchWithCallback",
    args: [signedOrders, encodeCallbackData(poolAddress, minProfit)],
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- viem's strict generics
  const prepared = await walletClient.prepareTransactionRequest({
    to: reactorAddress,
    data,
    account,
    chain: walletClient.chain,
  } as any);

  return walletClient.signTransaction({ ...prepared, account } as any);
}

/**
 * Ensure output tokens are approved to the reactor (for direct fills).
 * Returns true if approval was already sufficient, false if a new approval tx was sent.
 */
export async function ensureApproval(
  walletClient: WalletClient,
  publicClient: PublicClient,
  token: Address,
  spender: Address,
  amount: bigint,
): Promise<boolean> {
  const account = walletClient.account;
  if (!account) throw new Error("WalletClient has no account");

  const allowance = (await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, spender],
  })) as bigint;

  if (allowance >= amount) return true;

  await walletClient.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [
      spender,
      BigInt(
        "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      ),
    ],
    chain: walletClient.chain,
    account,
  });

  return false;
}
