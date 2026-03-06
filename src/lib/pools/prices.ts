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
