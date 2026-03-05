import type { AgentConfig } from "./types.js";

export interface AggregatorQuote {
  midPrice: number; // asset1 per asset0
  bidPrice: number; // best bid
  askPrice: number; // best ask
  spread: number; // ask - bid (in bps)
  timestamp: number;
}

/// Query aggregator for market price data.
/// In production, this would call 1inch or CowSwap API.
/// For now, returns a placeholder that the agent can build on.
export async function getAggregatorQuote(
  _config: AgentConfig
): Promise<AggregatorQuote | null> {
  // TODO: Implement actual aggregator queries
  // Example 1inch API call:
  //   GET https://api.1inch.dev/swap/v6.0/1/quote?src=TOKEN0&dst=TOKEN1&amount=1000000000000000000
  // Example CowSwap API:
  //   POST https://api.cow.fi/mainnet/api/v1/quote
  //
  // For now return null to indicate no quote available.
  // The rules engine handles this gracefully.
  return null;
}

/// Parse a raw aggregator response into our quote format.
/// Separate function so it's easy to swap aggregator backends.
export function parseQuoteResponse(
  _raw: unknown,
  _asset0Decimals: number,
  _asset1Decimals: number
): AggregatorQuote {
  // Placeholder — implement when connecting to real aggregator
  throw new Error("Not implemented: connect to 1inch or CowSwap API");
}
