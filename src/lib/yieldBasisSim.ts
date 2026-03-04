/**
 * Comparison simulation: Static EulerSwap vs Releverage strategies.
 *
 * Runs three strategies on the same GBM price path:
 *   1. Static EulerSwap — fixed curve, standard IL
 *   2. Discrete releverage — afterSwap hook re-centers with L=2 simple leverage
 *   3. Ideal releverage — Yield Basis compounding leverage (IL=0 theoretical limit)
 *
 * Key difference between discrete and ideal:
 *   - Discrete: equity per step = equity × (L√r − (L−1)) = equity × (2√r − 1)
 *     Swap happens on the unlevered curve, then hook rebalances. Residual IL ≈ σ²T/4.
 *   - Ideal: equity per step = equity × r = equity × (√r)²
 *     Yield Basis invariant integrates leverage INTO the swap. IL = 0 exactly.
 *
 * Both releverage strategies earn more fees than static because they always provide
 * liquidity at equilibrium (maximum depth), while the static pool's liquidity
 * diminishes as price moves away from equilibrium.
 */

import {
  Params,
  computeSx, computeBxc,
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
}

export const defaultComparisonConfig: ComparisonConfig = {
  ...defaultSimConfig,
  borrowRateAnnual: 0.05,
  dynamicFee: false,
  feeMaxBps: 500,
  feeDecaySeconds: 60,
};

/** Per-timestep snapshot for all strategies. All monetary values in Y units. */
export interface ComparisonStep {
  t: number;           // time in days
  extPrice: number;    // external price (Y per X)

  // Baselines
  hodl: number;        // HODL initial portfolio (50/50)
  hodlX: number;       // HODL 100% X exposure (what releverage tracks)

  // Strategy 1: Static EulerSwap
  staticNav: number;   // LP NAV (no fees)
  staticFees: number;  // cumulative fees
  staticTotal: number; // nav + fees

  // Strategy 2: Discrete releverage (afterSwap hook, cx=0, L=2)
  discEquity: number;  // equity = pool_value − debt
  discFees: number;    // cumulative fees
  discDebt: number;    // cumulative borrow cost
  discTotal: number;   // equity + fees − debtCost

  // Strategy 3: Ideal releverage (Yield Basis, cx=0, L=2)
  idealEquity: number; // equity (tracks hodlX exactly)
  idealFees: number;   // cumulative fees
  idealDebt: number;   // cumulative borrow cost
  idealTotal: number;  // equity + fees − debtCost
}

export interface ComparisonSummary {
  // Net return (total_value / initial − 1)
  staticReturn: number;
  discReturn: number;
  idealReturn: number;

  // Fees earned
  staticFees: number;
  discFees: number;
  idealFees: number;

  // IL = equity − matching HODL
  // Static: lpNav − hodl5050
  // Discrete: discEquity − hodlX
  // Ideal: idealEquity − hodlX (should be ~0)
  staticIL: number;
  discIL: number;
  idealIL: number;

  // Leverage costs
  discDebtCost: number;
  idealDebtCost: number;
}

export interface ComparisonResult {
  steps: ComparisonStep[];
  summary: ComparisonSummary;
}

// ─── Simulation ────────────────────────────────────────────────────

/**
 * Run comparison of static vs releverage strategies on the same price path.
 *
 * Uses params.rx for concentration in the releverage sims (at cx=0).
 * Uses full params for the static sim (whatever cx, leverage the user configured).
 */
export function runComparison(params: Params, config: ComparisonConfig): ComparisonResult {
  const { px, py, rx, xr, yr } = params;
  const p0 = px / py;
  const L = 2;
  const E0 = xr * p0 + yr; // initial equity in Y units

  // Concentration boost at cx=0 for releverage strategies
  const sx = computeSx(rx, 0);
  const bXC = computeBxc(sx);

  // Run static simulation (reuses existing engine, same seed → same price path)
  const staticResult = runSimulation(params, config);

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

  const steps: ComparisonStep[] = [];

  for (let i = 0; i <= n; i++) {
    const t = i / config.stepsPerDay;
    const p = pricePath[i];
    const staticStep = staticResult.steps[i];

    if (i > 0) {
      const pPrev = pricePath[i - 1];
      const r = p / pPrev;
      const sqrtR = Math.sqrt(Math.abs(r)); // abs for safety

      // --- Discrete releverage (afterSwap hook) ---
      if (!discLiquidated) {
        // Debt cost accrues on existing debt (= equity at start of step)
        const discDebtStep = discEquity * config.borrowRateAnnual * dt;
        discDebtCum += discDebtStep;

        // Virtual liquidity: x₀ = equity × bXC / pPrev
        const discVirtualX0 = discEquity * bXC / pPrev;
        const discDeltaX = discVirtualX0 * Math.abs(1 - 1 / sqrtR);
        discFeesCum += discDeltaX * p * releverageFeeBps / 10000;

        // Simple leverage: equity × (L√r − (L−1))
        // At L=2: equity × (2√r − 1)
        discEquity = discEquity * (L * sqrtR - (L - 1));
        if (discEquity <= 0) {
          discEquity = 0;
          discLiquidated = true;
        }
      }

      // --- Ideal releverage (Yield Basis) ---
      {
        // Debt cost accrues on existing debt (= equity at start of step)
        const idealDebtStep = idealEquity * config.borrowRateAnnual * dt;
        idealDebtCum += idealDebtStep;

        // Virtual liquidity: x₀ = equity × bXC / pPrev
        const idealVirtualX0 = idealEquity * bXC / pPrev;
        const idealDeltaX = idealVirtualX0 * Math.abs(1 - 1 / sqrtR);
        idealFeesCum += idealDeltaX * p * releverageFeeBps / 10000;

        // Compounding leverage: [V(r)/V(1)]^L = (√r)² = r
        idealEquity = idealEquity * r;
      }
    }

    const hodl = xr * p + yr;
    const hodlX = E0 * p / p0;

    steps.push({
      t,
      extPrice: p,
      hodl,
      hodlX,
      staticNav: staticStep.lpNav,
      staticFees: staticStep.feesCum,
      staticTotal: staticStep.lpNav + staticStep.feesCum,
      discEquity,
      discFees: discFeesCum,
      discDebt: discDebtCum,
      discTotal: discEquity + discFeesCum - discDebtCum,
      idealEquity,
      idealFees: idealFeesCum,
      idealDebt: idealDebtCum,
      idealTotal: idealEquity + idealFeesCum - idealDebtCum,
    });
  }

  const f = steps[steps.length - 1]; // final step

  return {
    steps,
    summary: {
      staticReturn: E0 > 0 ? f.staticTotal / E0 - 1 : 0,
      discReturn: E0 > 0 ? f.discTotal / E0 - 1 : 0,
      idealReturn: E0 > 0 ? f.idealTotal / E0 - 1 : 0,
      staticFees: f.staticFees,
      discFees: f.discFees,
      idealFees: f.idealFees,
      staticIL: f.staticNav - f.hodl,
      discIL: f.discEquity - f.hodlX,
      idealIL: f.idealEquity - f.hodlX,
      discDebtCost: f.discDebt,
      idealDebtCost: f.idealDebt,
    },
  };
}
