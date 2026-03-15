// Flashbots bundle submission for MEV-safe fill transactions
// Failed bundles cost zero gas — unlike Flashbots Protect RPC

import type { Hex, PublicClient } from "viem";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface BundleResult {
  bundleHash: string;
}

/**
 * Submit a signed transaction as a Flashbots bundle targeting a specific block.
 * The auth key is a throwaway private key used only to identify the filler to the relay.
 */
export async function submitBundle(
  signedTx: Hex,
  targetBlock: bigint,
  authKey: Hex,
  relayUrl: string,
): Promise<BundleResult> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_sendBundle",
    params: [
      {
        txs: [signedTx],
        blockNumber: `0x${targetBlock.toString(16)}`,
      },
    ],
  });

  const authSigner = privateKeyToAccount(authKey);
  const bodyHash = keccak256(toBytes(body));
  const signature = await authSigner.signMessage({ message: { raw: bodyHash } });

  const res = await fetch(relayUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Flashbots-Signature": `${authSigner.address}:${signature}`,
    },
    body,
  });

  const result = await res.json();
  if (result.error) {
    throw new Error(`Flashbots relay: ${result.error.message}`);
  }
  if (!result.result?.bundleHash) {
    throw new Error(`Flashbots relay: unexpected response — missing bundleHash`);
  }
  return result.result as BundleResult;
}

/**
 * Submit a bundle targeting both block+1 and block+2 for redundancy.
 * Returns the bundle hash from the first successful submission.
 */
export async function submitBundleWithRedundancy(
  signedTx: Hex,
  currentBlock: bigint,
  authKey: Hex,
  relayUrl: string,
): Promise<BundleResult> {
  const [result1, result2] = await Promise.allSettled([
    submitBundle(signedTx, currentBlock + 1n, authKey, relayUrl),
    submitBundle(signedTx, currentBlock + 2n, authKey, relayUrl),
  ]);

  if (result1.status === "fulfilled") return result1.value;
  if (result2.status === "fulfilled") return result2.value;
  throw (result1 as PromiseRejectedResult).reason;
}

/**
 * Get the current block number for bundle targeting.
 */
export async function getCurrentBlock(
  client: PublicClient,
): Promise<bigint> {
  return client.getBlockNumber();
}
