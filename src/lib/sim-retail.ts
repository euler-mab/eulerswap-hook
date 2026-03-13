/**
 * Retail order generation and N-venue optimal routing.
 *
 * Poisson arrivals with lognormal sizes, routed optimally across
 * competing AMM strategies using the ammchallenge formula.
 */

import { boxMuller } from "./simulate";
import type { StrategyState, AMMCurve } from "./sim-strategy";

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
}

export const DEFAULT_RETAIL: RetailConfig = {
  arrivalRate: 3.0,
  meanSize: 5000,
  sizeSigma: 1.2,
  buyProb: 0.5,
};

// ─── N-Venue Optimal Router ──────────────────────────────────────────

export interface RouteVenue {
  curX: number;          // current X reserves
  curY: number;          // current Y reserves
  fee: number;           // fee for this trade direction (fraction)
}

/**
 * Route a retail order across N venues to equalize post-trade marginal prices.
 *
 * For 2 venues, uses the ammchallenge closed-form formula:
 *   A_i = sqrt(x_i × γ_i × y_i)
 *   r = A_1 / A_2
 *   Δy_1 = (r × (y_2 + γ_2 × Y) − y_1) / (γ_1 + r × γ_2)
 *
 * For N>2, iterative pairwise splitting (converges in 2-3 iterations).
 *
 * Returns array of fractions [0,1] summing to 1, one per venue.
 */
export function routeOrder(
  isBuyX: boolean,
  totalSizeUSDC: number,
  venues: RouteVenue[],
  ethPrice: number,
): number[] {
  const n = venues.length;
  if (n === 0) return [];
  if (n === 1) return [1];

  // Compute effective gammas
  const gammas = venues.map(v => {
    const g = 1 - v.fee;  // fees are always >= 0
    return g > 0 ? g : 0;
  });

  if (n === 2) {
    return route2Venues(isBuyX, totalSizeUSDC, venues, gammas, ethPrice);
  }

  // N>2: iterative pairwise splitting
  // Start with equal allocation, refine
  const fracs = new Array(n).fill(1 / n);
  for (let iter = 0; iter < 5; iter++) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        // Re-split allocation between i and j
        const totalIJ = fracs[i] + fracs[j];
        if (totalIJ < 1e-10) continue;
        const subVenues: RouteVenue[] = [venues[i], venues[j]];
        const subGammas = [gammas[i], gammas[j]];
        const subFracs = route2Venues(isBuyX, totalSizeUSDC * totalIJ, subVenues, subGammas, ethPrice);
        fracs[i] = subFracs[0] * totalIJ;
        fracs[j] = subFracs[1] * totalIJ;
      }
    }
  }

  return fracs;
}

/** 2-venue optimal routing (ammchallenge formula). */
function route2Venues(
  isBuyX: boolean,
  totalSizeUSDC: number,
  venues: RouteVenue[],
  gammas: number[],
  ethPrice: number,
): number[] {
  const [v1, v2] = venues;
  const [g1, g2] = gammas;

  if (g1 <= 0 && g2 <= 0) return [0.5, 0.5];
  if (g1 <= 0) return [0, 1];
  if (g2 <= 0) return [1, 0];

  if (isBuyX) {
    // Trader buys X (USDC), sends Y (WETH). Split Y input.
    const a1 = Math.sqrt(v1.curX * g1 * v1.curY);
    const a2 = Math.sqrt(v2.curX * g2 * v2.curY);
    if (a2 === 0) return [1, 0];
    if (a1 === 0) return [0, 1];
    const r = a1 / a2;
    const totalY = totalSizeUSDC / ethPrice;
    const y1 = (r * (v2.curY + g2 * totalY) - v1.curY) / (g1 + r * g2);
    const frac1 = Math.max(0, Math.min(1, y1 / totalY));
    return [frac1, 1 - frac1];
  } else {
    // Trader sells X (USDC), receives Y (WETH). Split X input.
    const b1 = Math.sqrt(v1.curY * g1 * v1.curX);
    const b2 = Math.sqrt(v2.curY * g2 * v2.curX);
    if (b2 === 0) return [1, 0];
    if (b1 === 0) return [0, 1];
    const r = b1 / b2;
    const totalX = totalSizeUSDC;
    const x1 = (r * (v2.curX + g2 * totalX) - v1.curX) / (g1 + r * g2);
    const frac1 = Math.max(0, Math.min(1, x1 / totalX));
    return [frac1, 1 - frac1];
  }
}
