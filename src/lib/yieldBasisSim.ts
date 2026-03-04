/**
 * Comparison simulation: Static EulerSwap vs Releverage strategies.
 *
 * Runs five strategies on the same GBM price path:
 *   1–3. Static EulerSwap at cx=0, 0.5, 0.9 — fair comparison (no LLTV boost)
 *   4.   Discrete releverage — afterSwap hook re-centers with L=2 simple leverage
 *   5.   Ideal releverage — Yield Basis compounding leverage (IL=0 theoretical limit)
 *
 * Key difference between discrete and ideal:
 *   - Discrete: equity per step = equity × (L√r − (L−1)) = equity × (2√r − 1)
 *     Swap happens on the unlevered curve, then hook rebalances. Residual IL ≈ σ²T/4.
 *   - Ideal: equity per step = equity × r = equity × (√r)²
 *     Yield Basis invariant integrates leverage INTO the swap. IL = 0 exactly.
 *
 * All strategies use the same capital (xr, yr), range (rx, ry), and fee (feeBps).
 * Static strategies use zero LLTVs for fair comparison — no implicit bXL boost.
 * Releverage strategies use cx=0 (required for IL elimination) with the user's rx.
 */

import {
  Params,
  computeSx, computeBxc,
  computeX0, computeY0,
} from "./math";
import {
  SimConfig, defaultSimConfig,
  generatePricePath,
  runSimulation,
} from "./simulate";

// ─── Config & Result Types ──────────────────────────────────────────

export interface ComparisonConfig extends SimConfig {
  borrowRateAnnual: number;  // annualized borrow cost for L=2 leverage (e.g. 0.05 = 5%)
  dynamicFee: boolean;       // enable time-decay fee for releverage strategies
  feeMaxBps: number;         // max fee right after re-centering (e.g. 500 = 5%)
  feeDecaySeconds: number;   // τ decay time constant (e.g. 60)
  retailEnabled: boolean;    // enable depth-proportional retail flow model
  retailVolPerStep: number;  // retail volume (Y/step) hitting a reference-depth pool
}

export const defaultComparisonConfig: ComparisonConfig = {
  ...defaultSimConfig,
  borrowRateAnnual: 0.05,
  dynamicFee: false,
  feeMaxBps: 500,
  feeDecaySeconds: 60,
  retailEnabled: false,
  retailVolPerStep: 10,
};

/** Per-timestep snapshot for all strategies. All monetary values in Y units. */
export interface ComparisonStep {
  t: number;           // time in days
  extPrice: number;    // external price (Y per X)

  // Baselines
  hodl: number;        // HODL initial portfolio (50/50)
  hodlX: number;       // HODL 100% X exposure (what releverage tracks)

  // Static EulerSwap at cx=0, 0.5, 0.9 (fair: no LLTV boost)
  s0Nav: number; s0Fees: number; s0Total: number;
  s50Nav: number; s50Fees: number; s50Total: number;
  s90Nav: number; s90Fees: number; s90Total: number;

  // Discrete releverage (afterSwap hook, cx=0, L=2)
  discEquity: number;
  discFees: number;
  discDebt: number;
  discTotal: number;

  // Ideal releverage (Yield Basis, cx=0, L=2)
  idealEquity: number;
  idealFees: number;
  idealDebt: number;
  idealTotal: number;
}

/** Summary for a single static strategy. */
export interface StaticSummary {
  cx: number;
  return_: number;
  fees: number;
  il: number;
}

export interface ComparisonSummary {
  // Static strategies at different cx
  statics: [StaticSummary, StaticSummary, StaticSummary]; // cx=0, 0.5, 0.9

  // Releverage strategies
  discReturn: number;
  discFees: number;
  discIL: number;
  discDebtCost: number;

  idealReturn: number;
  idealFees: number;
  idealIL: number;
  idealDebtCost: number;
}

export interface ComparisonResult {
  steps: ComparisonStep[];
  summary: ComparisonSummary;
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Build fair params: zero LLTVs, zero debt, override cx. */
function fairParams(params: Params, cx: number): Params {
  return {
    ...params,
    cx, cy: cx,
    vyx: 0, vxy: 0, vxz: 0, vyz: 0, vzx: 0, vzy: 0,
    xd: 0, yd: 0, zdebt: 0, zr: 0,
    rXX: 0, rXY: 0, rXZ: 0, rYX: 0, rYY: 0, rYZ: 0,
    eXC: 0, eXD: 0, eYC: 0, eYD: 0,
  };
}

// ─── Simulation ────────────────────────────────────────────────────

/**
 * Run comparison of static vs releverage strategies on the same price path.
 *
 * Runs three static strategies (cx=0, 0.5, 0.9) with zeroed LLTVs for fair comparison.
 * Releverage strategies use cx=0 with the user's rx for concentration.
 */
export function runComparison(params: Params, config: ComparisonConfig): ComparisonResult {
  const { px, py, rx, xr, yr } = params;
  const p0 = px / py;
  const L = 2;
  const E0 = xr * p0 + yr; // initial equity in Y units

  // Concentration boost at cx=0 for releverage strategies
  const sx = computeSx(rx, 0);
  const bXC = computeBxc(sx);
  const sy = computeSx(params.ry, 0); // same formula, ry instead of rx
  const bYC = computeBxc(sy);

  // Run three static simulations at different cx, all with fair params
  const s0Params = fairParams(params, 0);
  const s50Params = fairParams(params, 0.5);
  const s90Params = fairParams(params, 0.9);
  const s0Result = runSimulation(s0Params, config);
  const s50Result = runSimulation(s50Params, config);
  const s90Result = runSimulation(s90Params, config);

  // Equilibrium depths for retail flow model.
  // EulerSwap effective liquidity ∝ x0/(1-cx): the curve flatness (cx) reduces
  // price impact, so a cx=0.9 pool is ~10× deeper than its virtual reserves suggest.
  // depth = sqrt(x0 * y0) / (1 - cx) captures both virtual reserve size and curve shape.
  const s0Depth = Math.sqrt(computeX0(s0Params) * computeY0(s0Params));  // cx=0: 1-cx=1
  const s50Depth = Math.sqrt(computeX0(s50Params) * computeY0(s50Params)) / (1 - 0.5);
  const s90Depth = Math.sqrt(computeX0(s90Params) * computeY0(s90Params)) / (1 - 0.9);
  const refDepth = s0Depth; // cx=0 pool as reference (1-cx=1, no division needed)

  // Generate same price path for releverage sims
  const pricePath = generatePricePath(p0, config);
  const n = config.durationDays * config.stepsPerDay;
  const dt = 1 / (365 * config.stepsPerDay); // step size in years

  // Dynamic fee: compute effective fee for releverage strategies
  const elapsedSeconds = 86400 / config.stepsPerDay;
  let releverageFeeBps = config.feeBps;
  if (config.dynamicFee) {
    const tFrac = Math.min(elapsedSeconds / config.feeDecaySeconds, 1);
    const decayFactor = Math.sqrt(Math.max(0, 1 - tFrac));
    releverageFeeBps = config.feeBps + (config.feeMaxBps - config.feeBps) * decayFactor;
  }

  // Releverage state
  let discEquity = E0;
  let discFeesCum = 0;
  let discDebtCum = 0;
  let discLiquidated = false;

  let idealEquity = E0;
  let idealFeesCum = 0;
  let idealDebtCum = 0;

  // Retail fee accumulators (added on top of arb fees)
  let s0RetailCum = 0, s50RetailCum = 0, s90RetailCum = 0;
  let discRetailCum = 0, idealRetailCum = 0;

  const steps: ComparisonStep[] = [];

  for (let i = 0; i <= n; i++) {
    const t = i / config.stepsPerDay;
    const p = pricePath[i];
    const s0 = s0Result.steps[i];
    const s50 = s50Result.steps[i];
    const s90 = s90Result.steps[i];

    if (i > 0) {
      const pPrev = pricePath[i - 1];
      const r = p / pPrev;
      const sqrtR = Math.sqrt(Math.abs(r)); // abs for safety

      // --- Discrete releverage (afterSwap hook) ---
      if (!discLiquidated) {
        const discDebtStep = discEquity * config.borrowRateAnnual * dt;
        discDebtCum += discDebtStep;

        const discVirtualX0 = discEquity * bXC / pPrev;
        const discDeltaX = discVirtualX0 * Math.abs(1 - 1 / sqrtR);
        discFeesCum += discDeltaX * p * releverageFeeBps / 10000;

        discEquity = discEquity * (L * sqrtR - (L - 1));
        if (discEquity <= 0) {
          discEquity = 0;
          discLiquidated = true;
        }
      }

      // --- Ideal releverage (Yield Basis) ---
      {
        const idealDebtStep = idealEquity * config.borrowRateAnnual * dt;
        idealDebtCum += idealDebtStep;

        const idealVirtualX0 = idealEquity * bXC / pPrev;
        const idealDeltaX = idealVirtualX0 * Math.abs(1 - 1 / sqrtR);
        idealFeesCum += idealDeltaX * p * releverageFeeBps / 10000;

        idealEquity = idealEquity * r;
      }
    }

    // --- Retail fees (depth-proportional) ---
    if (config.retailEnabled && i > 0 && refDepth > 0) {
      const feeFrac = config.feeBps / 10000;
      const rvol = config.retailVolPerStep;

      // Static: earn retail only when in range, proportional to equilibrium depth
      if (s0.inRange) s0RetailCum += rvol * (s0Depth / refDepth) * feeFrac;
      if (s50.inRange) s50RetailCum += rvol * (s50Depth / refDepth) * feeFrac;
      if (s90.inRange) s90RetailCum += rvol * (s90Depth / refDepth) * feeFrac;

      // Releverage: depth scales with equity (re-centered each step)
      if (!discLiquidated) {
        const discDepth = (discEquity / 2) * Math.sqrt(bXC * bYC / p);
        discRetailCum += rvol * (discDepth / refDepth) * feeFrac;
      }
      {
        const idealDepth = (idealEquity / 2) * Math.sqrt(bXC * bYC / p);
        idealRetailCum += rvol * (idealDepth / refDepth) * feeFrac;
      }
    }

    const hodl = xr * p + yr;
    const hodlX = E0 * p / p0;

    steps.push({
      t,
      extPrice: p,
      hodl,
      hodlX,
      s0Nav: s0.lpNav, s0Fees: s0.feesCum + s0RetailCum, s0Total: s0.lpNav + s0.feesCum + s0RetailCum,
      s50Nav: s50.lpNav, s50Fees: s50.feesCum + s50RetailCum, s50Total: s50.lpNav + s50.feesCum + s50RetailCum,
      s90Nav: s90.lpNav, s90Fees: s90.feesCum + s90RetailCum, s90Total: s90.lpNav + s90.feesCum + s90RetailCum,
      discEquity,
      discFees: discFeesCum + discRetailCum,
      discDebt: discDebtCum,
      discTotal: discEquity + discFeesCum + discRetailCum - discDebtCum,
      idealEquity,
      idealFees: idealFeesCum + idealRetailCum,
      idealDebt: idealDebtCum,
      idealTotal: idealEquity + idealFeesCum + idealRetailCum - idealDebtCum,
    });
  }

  const f = steps[steps.length - 1]; // final step

  const mkStatic = (nav: number, fees: number, cx: number): StaticSummary => ({
    cx,
    return_: E0 > 0 ? (nav + fees) / E0 - 1 : 0,
    fees,
    il: nav - f.hodl,
  });

  return {
    steps,
    summary: {
      statics: [
        mkStatic(f.s0Nav, f.s0Fees, 0),
        mkStatic(f.s50Nav, f.s50Fees, 0.5),
        mkStatic(f.s90Nav, f.s90Fees, 0.9),
      ],
      discReturn: E0 > 0 ? f.discTotal / E0 - 1 : 0,
      discFees: f.discFees,
      discIL: f.discEquity - f.hodlX,
      discDebtCost: f.discDebt,
      idealReturn: E0 > 0 ? f.idealTotal / E0 - 1 : 0,
      idealFees: f.idealFees,
      idealIL: f.idealEquity - f.hodlX,
      idealDebtCost: f.idealDebt,
    },
  };
}
