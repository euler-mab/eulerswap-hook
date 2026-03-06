import type { Address } from "viem";

/** Token identifiers for DeFiLlama (chain:address format) */
function llamaId(token: Address): string {
  return `ethereum:${token}`;
}

export interface HistoricalPrice {
  /** USD price */
  price: number;
  /** Actual timestamp returned (may differ slightly from requested) */
  timestamp: number;
  /** Confidence score 0-1 */
  confidence: number;
}

/**
 * Fetch USD prices for tokens at a specific timestamp via DeFiLlama.
 * Returns a map of lowercase address → price.
 */
export async function fetchPricesAt(
  tokens: Address[],
  timestamp: number,
): Promise<Map<string, HistoricalPrice>> {
  const coins = tokens.map(llamaId).join(",");
  const url = `https://coins.llama.fi/prices/historical/${timestamp}/${coins}?searchWidth=3600`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`DeFiLlama API error: ${res.status}`);

  const data = await res.json();
  const result = new Map<string, HistoricalPrice>();

  for (const token of tokens) {
    const key = llamaId(token);
    const entry = data.coins?.[key];
    if (entry) {
      result.set(token.toLowerCase(), {
        price: entry.price,
        timestamp: entry.timestamp,
        confidence: entry.confidence ?? 1,
      });
    }
  }
  return result;
}

/**
 * Fetch current USD prices for tokens via DeFiLlama.
 */
export async function fetchCurrentPrices(
  tokens: Address[],
): Promise<Map<string, HistoricalPrice>> {
  const coins = tokens.map(llamaId).join(",");
  const url = `https://coins.llama.fi/prices/current/${coins}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`DeFiLlama API error: ${res.status}`);

  const data = await res.json();
  const result = new Map<string, HistoricalPrice>();

  for (const token of tokens) {
    const key = llamaId(token);
    const entry = data.coins?.[key];
    if (entry) {
      result.set(token.toLowerCase(), {
        price: entry.price,
        timestamp: entry.timestamp,
        confidence: entry.confidence ?? 1,
      });
    }
  }
  return result;
}

/**
 * Fetch USD prices at multiple timestamps for a set of tokens.
 * Batches requests to avoid rate limiting.
 */
export async function fetchPriceTimeline(
  tokens: Address[],
  timestamps: number[],
): Promise<Map<number, Map<string, number>>> {
  const result = new Map<number, Map<string, number>>();

  // Batch in groups of 5 timestamps to be nice to the API
  for (let i = 0; i < timestamps.length; i += 5) {
    const batch = timestamps.slice(i, i + 5);
    const promises = batch.map(ts => fetchPricesAt(tokens, ts));
    const results = await Promise.all(promises);

    for (let j = 0; j < batch.length; j++) {
      const priceMap = new Map<string, number>();
      for (const [addr, hp] of results[j]) {
        priceMap.set(addr, hp.price);
      }
      result.set(batch[j], priceMap);
    }
  }

  return result;
}
