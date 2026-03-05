/**
 * Perp funding rate feed — reads from Binance and Hyperliquid.
 *
 * Funding rates tell us the cost of holding directional exposure on perp exchanges.
 * When funding is positive, longs pay shorts → being short is profitable.
 * When funding is negative, shorts pay longs → being long is profitable.
 *
 * The agent uses this to orient fee asymmetry: attract flow that pushes the LP's
 * delta toward the funding-profitable direction, then hedge on perps.
 */

const FETCH_TIMEOUT_MS = 10_000;

// Binance: funding is per 8h. Hyperliquid: per 1h.
const BINANCE_PERIODS_PER_YEAR = 3 * 365.25; // 8h periods
const HYPERLIQUID_PERIODS_PER_YEAR = 24 * 365.25; // 1h periods

export interface FundingSnapshot {
  symbol: string;             // e.g. "ETH"
  // Current rate per period (raw decimal, e.g. 0.0001 = 1 bps)
  binanceRate: number | null;
  hyperliquidRate: number | null;
  // Annualized rates (%)
  binanceApr: number | null;
  hyperliquidApr: number | null;
  // Best available annualized rate (average of available sources)
  apr: number;
  // Direction: positive = longs pay shorts, negative = shorts pay longs
  direction: "longs-pay" | "shorts-pay" | "neutral";
  timestamp: number;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** Fetch latest funding rate from Binance USDT-M futures */
async function getBinanceFunding(symbol: string): Promise<number | null> {
  try {
    const ticker = `${symbol.toUpperCase()}USDT`;
    const res = await fetchWithTimeout(
      `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${ticker}&limit=1`,
      { method: "GET" },
    );
    if (!res.ok) return null;

    const data = (await res.json()) as Array<{
      fundingRate: string;
      fundingTime: number;
    }>;
    if (!data.length) return null;

    return parseFloat(data[0]!.fundingRate);
  } catch {
    return null;
  }
}

/** Fetch current funding rate from Hyperliquid */
async function getHyperliquidFunding(symbol: string): Promise<number | null> {
  try {
    const res = await fetchWithTimeout(
      "https://api.hyperliquid.xyz/info",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      },
    );
    if (!res.ok) return null;

    const data = (await res.json()) as [
      { universe: Array<{ name: string }> },
      Array<{ funding: string }>,
    ];

    const [meta, ctxs] = data;
    const idx = meta.universe.findIndex(
      (u) => u.name.toUpperCase() === symbol.toUpperCase(),
    );
    if (idx === -1 || !ctxs[idx]) return null;

    return parseFloat(ctxs[idx]!.funding);
  } catch {
    return null;
  }
}

/**
 * Get funding rate snapshot for a symbol.
 * Queries Binance and Hyperliquid in parallel, returns normalized data.
 */
export async function getFundingRate(symbol: string): Promise<FundingSnapshot> {
  const [binanceRate, hyperliquidRate] = await Promise.all([
    getBinanceFunding(symbol),
    getHyperliquidFunding(symbol),
  ]);

  const binanceApr = binanceRate !== null
    ? binanceRate * BINANCE_PERIODS_PER_YEAR * 100
    : null;
  const hyperliquidApr = hyperliquidRate !== null
    ? hyperliquidRate * HYPERLIQUID_PERIODS_PER_YEAR * 100
    : null;

  // Average available sources
  const rates = [binanceApr, hyperliquidApr].filter((r): r is number => r !== null);
  const apr = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;

  const direction: FundingSnapshot["direction"] =
    Math.abs(apr) < 1 ? "neutral" : apr > 0 ? "longs-pay" : "shorts-pay";

  return {
    symbol,
    binanceRate,
    hyperliquidRate,
    binanceApr,
    hyperliquidApr,
    apr,
    direction,
    timestamp: Math.floor(Date.now() / 1000),
  };
}
