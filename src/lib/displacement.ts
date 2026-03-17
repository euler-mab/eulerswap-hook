/**
 * Displacement mechanism for V8 hook.
 *
 * Strategy-agnostic displacement computation and trigger logic.
 * See docs/displacement-mechanism.md for the full spec.
 */

import { solveXForPrice, solveYForPrice, mulberry32, boxMuller } from "./simulate";
import {
  type Params,
  computeX0, computeY0, computeXb, computeYb,
  fX, gY, pXxy, pYxy,
} from "./math";

// ─── Types ──────────────────────────────────────────────────────────

/** Target weight vector. w0 + w1 = 1 always. */
export interface WeightVector {
  w0: number;
  w1: number;
}

/** Vault state: real deposits and debts for both assets. */
export interface VaultState {
  deposit0: number;  // real deposit of asset0
  deposit1: number;  // real deposit of asset1
  debt0: number;     // real debt of asset0
  debt1: number;     // real debt of asset1
}

/** Displacement result from computeDisplacement. */
export interface DisplacementResult {
  nav: number;           // net asset value in asset0 terms
  value0: number;        // net value of asset0 position (deposit0 - debt0) in asset0 terms
  value1: number;        // net value of asset1 position (deposit1 - debt1) in asset0 terms
  target0: number;       // target value of asset0 in asset0 terms (w0 * nav)
  target1: number;       // target value of asset1 in asset0 terms (w1 * nav)
  displacement0: number; // value0 - target0
  displacement1: number; // value1 - target1
  relativeDisplacement: number; // |displacement0| / nav (as fraction)
}

/** Trigger coordinates precomputed at snapshot time. */
export interface TriggerCoordinates {
  trigger0: number;  // min reserve_0 before trigger fires (X branch)
  trigger1: number;  // min reserve_1 before trigger fires (Y branch)
  eqPrice: number;   // equilibrium price at snapshot time (px/py)
}

/** Clearing result from computeClearing. */
export interface ClearingResult {
  direction: "asset0_in" | "asset1_in" | "none";
  clearingAmount0: number;  // amount in asset0 terms
  clearingAmount1: number;  // amount in asset1 terms
}

// ─── Displacement Math (§3) ─────────────────────────────────────────

/**
 * Compute displacement for a given vault state, price, and weight vector.
 * All values are expressed in asset0 terms (the "numeraire").
 *
 * @param vault - current vault deposits and debts
 * @param price - current price of asset1 in asset0 terms (how many asset0 per asset1)
 * @param weights - target weight vector [w0, w1] where w0 + w1 = 1
 */
export function computeDisplacement(
  vault: VaultState,
  price: number,
  weights: WeightVector,
): DisplacementResult {
  // Net positions
  const net0 = vault.deposit0 - vault.debt0;
  const net1 = vault.deposit1 - vault.debt1;

  // Values in asset0 terms
  const value0 = net0;
  const value1 = net1 * price;

  // NAV in asset0 terms
  const nav = value0 + value1;

  // Targets
  const target0 = weights.w0 * nav;
  const target1 = weights.w1 * nav;

  // Displacement
  const displacement0 = value0 - target0;
  const displacement1 = value1 - target1;

  const relativeDisplacement = nav !== 0 ? Math.abs(displacement0) / Math.abs(nav) : 0;

  return {
    nav,
    value0,
    value1,
    target0,
    target1,
    displacement0,
    displacement1,
    relativeDisplacement,
  };
}

// ─── Trigger Coordinates (§5) ───────────────────────────────────────

/**
 * Compute trigger coordinates from a trigger fraction and curve parameters.
 * The trigger fraction is a price-based threshold: how far the marginal price
 * can move from equilibrium before the trigger fires.
 *
 * @param triggerFraction - e.g. 0.20 for "20% from equilibrium"
 * @param cx - concentration parameter (X side)
 * @param cy - concentration parameter (Y side)
 * @param x0 - equilibrium reserve_0
 * @param y0 - equilibrium reserve_1
 * @param px - price parameter X
 * @param py - price parameter Y
 * @param xb - min reserve_0 (boundary)
 * @param yb - min reserve_1 (boundary)
 */
export function computeTriggerCoordinates(
  triggerFraction: number,
  cx: number, cy: number,
  x0: number, y0: number,
  px: number, py: number,
  xb: number, yb: number,
): TriggerCoordinates {
  const eqPrice = px / py;

  // High price trigger: price goes up → reserve_0 decreases (X branch)
  const triggerPriceHigh = eqPrice * (1 + triggerFraction);
  const trigger0 = solveXForPrice(triggerPriceHigh, cx, x0, px, py, xb) ?? xb;

  // Low price trigger: price goes down → reserve_1 decreases (Y branch)
  const triggerPriceLow = eqPrice * (1 - triggerFraction);
  const trigger1 = solveYForPrice(triggerPriceLow, cy, y0, px, py, yb) ?? yb;

  return { trigger0, trigger1, eqPrice };
}

/**
 * Hot-path trigger check: two uint256 comparisons.
 * Returns true if either reserve has crossed its trigger coordinate.
 */
export function checkTrigger(
  reserve0: number,
  reserve1: number,
  trigger: TriggerCoordinates,
): boolean {
  return reserve0 < trigger.trigger0 || reserve1 < trigger.trigger1;
}

// ─── Clearing (§6) ─────────────────────────────────────────────────

/**
 * Compute clearing direction and amount from true displacement.
 *
 * @param displacement - displacement result from computeDisplacement
 * @param price - current oracle price (asset0 per asset1)
 */
export function computeClearing(
  displacement: DisplacementResult,
  price: number,
): ClearingResult {
  const d = displacement.displacement0;

  if (Math.abs(d) < 1e-12) {
    return { direction: "none", clearingAmount0: 0, clearingAmount1: 0 };
  }

  if (d > 0) {
    // Over-target in asset0. Sell asset0, buy asset1.
    return {
      direction: "asset0_in",
      clearingAmount0: d,
      clearingAmount1: d / price,
    };
  } else {
    // Over-target in asset1. Sell asset1, buy asset0.
    return {
      direction: "asset1_in",
      clearingAmount0: Math.abs(d),
      clearingAmount1: Math.abs(d) / price,
    };
  }
}

// ─── Vault State from Curve Position ────────────────────────────────

/**
 * Derive vault deposits and debts from curve position relative to equilibrium.
 * This mirrors the simulation logic: the difference between current reserves
 * and equilibrium reserves determines deposits and debts.
 *
 * @param curX - current virtual reserve X
 * @param curY - current virtual reserve Y
 * @param x0 - equilibrium virtual reserve X
 * @param y0 - equilibrium virtual reserve Y
 * @param xr - real deposit X at equilibrium
 * @param yr - real deposit Y at equilibrium
 */
export function vaultFromCurvePosition(
  curX: number, curY: number,
  x0: number, y0: number,
  xr: number, yr: number,
): VaultState {
  if (curX <= x0) {
    // X side or equilibrium: X consumed, Y added
    const consumed = x0 - curX;
    return {
      deposit0: Math.max(xr - consumed, 0),
      deposit1: yr + (curY - y0),
      debt0: Math.max(consumed - xr, 0),
      debt1: 0,
    };
  } else {
    // Y side: Y consumed, X added
    const consumed = y0 - curY;
    return {
      deposit0: xr + (curX - x0),
      deposit1: Math.max(yr - consumed, 0),
      debt0: 0,
      debt1: Math.max(consumed - yr, 0),
    };
  }
}

// ─── Vault Convention Helper ─────────────────────────────────────────

/**
 * Convert curve-based vault (deposit0=X, deposit1=Y) to displacement-based
 * vault (deposit0=Y=numeraire, deposit1=X=base). This aligns with the
 * displacement convention where asset0 is the numeraire and price converts
 * asset1 (base) into numeraire terms.
 *
 * After swapping: displacement uses price = px/py (Y per X = numeraire per base).
 */
export function swapVaultForDisplacement(v: VaultState): VaultState {
  return {
    deposit0: v.deposit1,  // Y → asset0 (numeraire)
    deposit1: v.deposit0,  // X → asset1 (base)
    debt0: v.debt1,        // Y debt → asset0 debt
    debt1: v.debt0,        // X debt → asset1 debt
  };
}

// ─── Displacement Simulation Engine ─────────────────────────────────

/** Configuration for displacement simulation. */
export interface DisplacementSimConfig {
  vol: number;              // annualized volatility
  drift: number;            // annualized drift
  steps: number;            // number of simulation steps
  stepsPerDay: number;      // for time scaling (e.g. 24 = hourly, 288 = 5-min blocks)
  seed: number;             // PRNG seed
  triggerFraction: number;  // reserve-coordinate trigger (e.g. 0.20)
  weights: WeightVector;    // target strategy
  feeBps: number;           // auction clearing fee in bps
}

/** Per-step snapshot from simulation. */
export interface DisplacementSimStep {
  step: number;
  extPrice: number;
  x: number;           // virtual reserve X
  y: number;           // virtual reserve Y
  displacement: number;  // displacement0 in asset0 terms
  relDisplacement: number; // |displacement0| / |NAV|
  nav: number;
  auctionFired: boolean;
  clearingAmount: number;
}

/** Summary statistics from a simulation run. */
export interface DisplacementSimSummary {
  auctionCount: number;
  peakRelDisplacement: number;     // max |d|/NAV over the run
  avgRelDisplacement: number;      // time-weighted average |d|/NAV
  totalAuctionCost: number;        // total fees paid during clearing
  finalNav: number;
  initialNav: number;
  navReturnPct: number;            // (final - initial) / initial * 100
}

/** Full simulation result. */
export interface DisplacementSimResult {
  steps: DisplacementSimStep[];
  summary: DisplacementSimSummary;
}

/**
 * Run displacement mechanism simulation.
 *
 * Convention: the curve uses X/Y with price px/py (Y per X). The displacement
 * module uses asset0=Y (numeraire, e.g. USDC) and asset1=X (base, e.g. WETH)
 * with price = px/py (numeraire per base). vaultFromCurvePosition returns
 * deposit0=X, deposit1=Y, so we swap before passing to displacement functions.
 *
 * Generates a GBM price path (in Y-per-X), arbs the pool each step, checks
 * trigger coordinates, fires auctions when triggered, clears displacement,
 * recenters the pool.
 */
export function runDisplacementSim(
  params: Params,
  config: DisplacementSimConfig,
): DisplacementSimResult {
  const { vol, drift, steps: nSteps, stepsPerDay, seed, triggerFraction, weights, feeBps } = config;

  // Current curve state (mutable — updated on recenter)
  let curParams = { ...params };
  let x0 = computeX0(curParams);
  let y0 = computeY0(curParams);
  let xb = computeXb(x0, curParams.rx, curParams.cx);
  let yb = computeYb(y0, curParams.ry, curParams.cy);

  const eqPrice0 = curParams.px / curParams.py; // Y per X

  // Generate price path (Y per X units)
  const rng = mulberry32(seed);
  const dt = 1 / (365 * stepsPerDay);
  const driftTerm = (drift - 0.5 * vol * vol) * dt;
  const diffusion = vol * Math.sqrt(dt);

  const prices = new Array<number>(nSteps + 1);
  prices[0] = eqPrice0;
  for (let i = 1; i <= nSteps; i++) {
    prices[i] = prices[i - 1] * Math.exp(driftTerm + diffusion * boxMuller(rng));
  }

  // Simulation state
  let curX = x0;
  let curY = y0;

  // Compute initial trigger coordinates
  let trig = computeTriggerCoordinates(
    triggerFraction, curParams.cx, curParams.cy, x0, y0,
    curParams.px, curParams.py, xb, yb,
  );

  // Initial displacement (swap vault: asset0=Y=numeraire, asset1=X=base)
  const initVaultRaw = vaultFromCurvePosition(curX, curY, x0, y0, curParams.xr, curParams.yr);
  const initVault = swapVaultForDisplacement(initVaultRaw);
  const initD = computeDisplacement(initVault, eqPrice0, weights);
  const initialNav = initD.nav;

  const simSteps: DisplacementSimStep[] = [];
  let auctionCount = 0;
  let totalAuctionCost = 0;
  let sumRelDisplacement = 0;
  let peakRelDisplacement = 0;

  for (let i = 0; i <= nSteps; i++) {
    const extPrice = prices[i]; // Y per X
    let auctionFired = false;
    let clearingAmount = 0;

    // Arb to external price (if not step 0)
    if (i > 0) {
      const curEqPrice = curParams.px / curParams.py;
      if (extPrice >= curEqPrice) {
        // X side: price above eq → x decreases
        const solved = solveXForPrice(extPrice, curParams.cx, x0, curParams.px, curParams.py, xb);
        if (solved !== null) {
          curX = solved;
          curY = fX(curX, curParams.cx, x0, y0, curParams.px, curParams.py);
        } else {
          curX = xb;
          curY = fX(xb, curParams.cx, x0, y0, curParams.px, curParams.py);
        }
      } else {
        // Y side: price below eq → y decreases
        const solved = solveYForPrice(extPrice, curParams.cy, y0, curParams.px, curParams.py, yb);
        if (solved !== null) {
          curY = solved;
          curX = gY(curY, curParams.cy, y0, x0, curParams.px, curParams.py);
        } else {
          curY = yb;
          curX = gY(yb, curParams.cy, y0, x0, curParams.px, curParams.py);
        }
      }
    }

    // Check trigger
    if (i > 0 && checkTrigger(curX, curY, trig)) {
      // Read vault state and swap for displacement convention
      const vaultRaw = vaultFromCurvePosition(curX, curY, x0, y0, curParams.xr, curParams.yr);
      const vaultSwapped = swapVaultForDisplacement(vaultRaw);
      // price = Y per X = numeraire per base (matches displacement convention)
      const d = computeDisplacement(vaultSwapped, extPrice, weights);
      const c = computeClearing(d, extPrice);

      if (c.direction !== "none" && d.relativeDisplacement > 0.001) {
        auctionFired = true;
        auctionCount++;
        clearingAmount = c.clearingAmount0;

        // Apply clearing with fee
        // clearingAmount0 is in asset0 (Y/numeraire) terms
        // clearingAmount1 is in asset1 (X/base) terms
        const feeAmountY = c.clearingAmount0 * feeBps / 10000;
        totalAuctionCost += feeAmountY;

        // Compute new real deposits after clearing
        // In displacement convention: asset0=Y, asset1=X
        // In curve convention: xr=X deposits, yr=Y deposits
        const netX = vaultRaw.deposit0 - vaultRaw.debt0; // net X position
        const netY = vaultRaw.deposit1 - vaultRaw.debt1; // net Y position

        let newNetX: number;
        let newNetY: number;

        if (c.direction === "asset0_in") {
          // Over in asset0 (Y): sell Y, buy X
          // Y decreases by clearingAmount0, X increases by clearingAmount1
          newNetY = netY - c.clearingAmount0;
          newNetX = netX + c.clearingAmount1;
        } else {
          // Over in asset1 (X): sell X, buy Y
          // X decreases by clearingAmount1, Y increases by clearingAmount0
          newNetX = netX - c.clearingAmount1;
          newNetY = netY + c.clearingAmount0;
        }

        // Subtract fee (in Y terms)
        newNetY -= feeAmountY;

        // New real deposits (set as positive net; if negative, pool is degenerate)
        curParams = {
          ...curParams,
          xr: Math.max(newNetX, 0.001),
          yr: Math.max(newNetY, 0.001),
          px: extPrice,
          py: 1,
        };

        // Recenter: recompute curve at new eq price
        x0 = computeX0(curParams);
        y0 = computeY0(curParams);
        xb = computeXb(x0, curParams.rx, curParams.cx);
        yb = computeYb(y0, curParams.ry, curParams.cy);
        curX = x0;
        curY = y0;

        // Recompute trigger coordinates
        trig = computeTriggerCoordinates(
          triggerFraction, curParams.cx, curParams.cy, x0, y0,
          curParams.px, curParams.py, xb, yb,
        );
      }
    }

    // Measure displacement at this step
    const vaultRaw = vaultFromCurvePosition(curX, curY, x0, y0, curParams.xr, curParams.yr);
    const vaultSwapped = swapVaultForDisplacement(vaultRaw);
    const dNow = computeDisplacement(vaultSwapped, extPrice, weights);
    const relD = dNow.relativeDisplacement;

    sumRelDisplacement += relD;
    if (relD > peakRelDisplacement) peakRelDisplacement = relD;

    simSteps.push({
      step: i,
      extPrice,
      x: curX,
      y: curY,
      displacement: dNow.displacement0,
      relDisplacement: relD,
      nav: dNow.nav,
      auctionFired,
      clearingAmount,
    });
  }

  const finalNav = simSteps[simSteps.length - 1].nav;

  return {
    steps: simSteps,
    summary: {
      auctionCount,
      peakRelDisplacement,
      avgRelDisplacement: sumRelDisplacement / (nSteps + 1),
      totalAuctionCost,
      finalNav,
      initialNav,
      navReturnPct: ((finalNav - initialNav) / Math.abs(initialNav)) * 100,
    },
  };
}
