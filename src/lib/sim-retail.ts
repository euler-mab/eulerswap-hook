/**
 * Retail order generation and quote-based routing.
 *
 * Poisson arrivals with lognormal sizes, routed to the venue
 * offering the best effective price (marginal price × fee).
 */

import { boxMuller } from "./simulate";

// ─── Order Generation ────────────────────────────────────────────────

/** Knuth's Poisson sampling for small lambda. */
export function poissonSample(rng: () => number, lambda: number): number {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L);
  return k - 1;
}

/** Lognormal sample with given mean and log-space sigma. */
export function lognormalSample(rng: () => number, mean: number, sigma: number): number {
  const mu = Math.log(mean) - 0.5 * sigma * sigma;
  return Math.exp(mu + sigma * boxMuller(rng));
}

// ─── Retail Config ───────────────────────────────────────────────────

export interface RetailConfig {
  arrivalRate: number;    // orders per step (e.g. 3.0 = 3/hour for hourly steps)
  meanSize: number;       // mean order size in USDC
  sizeSigma: number;      // lognormal sigma (typical: 1.2)
  buyProb: number;        // probability of buy-X order (0.5 = balanced)
  /** Fraction of orders that are toxic (informed). Default 0. */
  toxicFraction?: number;
  /** Correlation strength for toxic orders (0=random, 1=perfect). Default 1.0. */
  toxicCorrelation?: number;
}

export const DEFAULT_RETAIL: RetailConfig = {
  arrivalRate: 3.0,
  meanSize: 5000,
  sizeSigma: 1.2,
  buyProb: 0.5,
};

// ─── Quote-Based Router ─────────────────────────────────────────────

export interface QuoteVenue {
  /** Effective output per unit input for the trader, after fee. Higher = better. */
  effectivePrice: number;
  /** Is this venue available for this trade? */
  available: boolean;
}

/**
 * Route a retail order to the venue with the best effective price.
 *
 * The router picks the venue giving the trader the best deal (most output per
 * unit input). marginalPrice is Y per X (e.g. WETH/USDC ≈ 0.0005).
 *
 * For buy-X: trader sends Y (WETH), wants max X (USDC) output.
 *   effectivePrice = (1 - fee) / marginalPrice  [X per Y, after fee]
 *   Higher = better for trader → route there.
 *
 * For sell-X: trader sends X (USDC), wants max Y (WETH) output.
 *   effectivePrice = marginalPrice × (1 - fee)  [Y per X, after fee]
 *   Higher = better for trader → route there.
 *
 * Returns index of best venue, or -1 if none available.
 */
export function routeBestVenue(venues: QuoteVenue[]): number {
  let bestIdx = -1;
  let bestPrice = -Infinity;

  for (let i = 0; i < venues.length; i++) {
    if (!venues[i].available) continue;
    if (venues[i].effectivePrice > bestPrice) {
      bestPrice = venues[i].effectivePrice;
      bestIdx = i;
    }
  }

  return bestIdx;
}
