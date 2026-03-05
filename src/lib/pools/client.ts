import { createPublicClient, http, type PublicClient } from "viem";
import { mainnet } from "viem/chains";

let _client: PublicClient | null = null;

export function getClient(): PublicClient {
  if (_client) return _client;
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;
  if (!rpcUrl) throw new Error("NEXT_PUBLIC_RPC_URL not set — add it to .env.local");
  _client = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
    batch: { multicall: true },
  });
  return _client;
}
