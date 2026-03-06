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

/** A single price data point from the DeFiLlama chart endpoint */
export interface PriceChartPoint {
  timestamp: number;
  price: number;
}

/**
 * Fetch historical price chart for a token via DeFiLlama /chart endpoint.
 * Returns hourly prices from startTimestamp to now.
 */
export async function fetchPriceChart(
  token: Address,
  startTimestamp: number,
): Promise<PriceChartPoint[]> {
  const coin = llamaId(token);
  // Compute span in hours from start to now, capped at 8760 (1 year)
  const hoursElapsed = Math.ceil((Date.now() / 1000 - startTimestamp) / 3600);
  const span = Math.min(hoursElapsed, 8760);
  const url = `https://coins.llama.fi/chart/${coin}?start=${startTimestamp}&span=${span}&period=1h`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`DeFiLlama chart API error: ${res.status}`);

  const data = await res.json();
  const entry = data.coins?.[coin];
  if (!entry?.prices?.length) {
    throw new Error(`DeFiLlama chart: no data for ${token}`);
  }

  return entry.prices.map((p: { timestamp: number; price: number }) => ({
    timestamp: p.timestamp,
    price: p.price,
  }));
}

/**
 * Linearly interpolate a price at a given timestamp from a sorted price chart.
 * Returns the nearest price if timestamp is outside the chart range.
 */
export function interpolatePrice(chart: PriceChartPoint[], timestamp: number): number {
  if (chart.length === 0) throw new Error("Empty price chart");
  if (chart.length === 1 || timestamp <= chart[0].timestamp) return chart[0].price;
  if (timestamp >= chart[chart.length - 1].timestamp) return chart[chart.length - 1].price;

  // Binary search for the surrounding points
  let lo = 0;
  let hi = chart.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (chart[mid].timestamp <= timestamp) lo = mid;
    else hi = mid;
  }

  const t0 = chart[lo].timestamp;
  const t1 = chart[hi].timestamp;
  const frac = (timestamp - t0) / (t1 - t0);
  return chart[lo].price + frac * (chart[hi].price - chart[lo].price);
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
