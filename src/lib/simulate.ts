import {
  Params,
  computeX0, computeY0, computeXb, computeYb,
  fX, gY,
  pXxy, pYxy,
  computeHX, computeHY,
  computeZd,
} from "./math";

// ─── Config & Result Types ──────────────────────────────────────────

export interface SimConfig {
  vol: number;           // annualized volatility (e.g. 0.80)
  drift: number;         // annualized drift (e.g. 0)
  durationDays: number;  // sim length
  stepsPerDay: number;   // resolution (24 = hourly)
  feeBps: number;        // swap fee in basis points
  seed: number;          // PRNG seed
}

export const defaultSimConfig: SimConfig = {
  vol: 0.80,
  drift: 0.0,
  durationDays: 30,
  stepsPerDay: 24,
  feeBps: 30,
  seed: 42,
};

export interface SimStep {
  t: number;              // time in days
  extPrice: number;       // external price (Y per X)
  x: number;              // virtual x position
  y: number;              // virtual y position
  realX: number;          // real X reserves
  realY: number;          // real Y reserves
  lpNav: number;          // LP NAV in Y units
  hodlNav: number;        // HODL NAV in Y units
  feesCum: number;        // cumulative fees (Y units)
  netPnl: number;         // lpNav + fees - hodlNav
  health: number;         // health score (capped at 10)
  inRange: boolean;       // within price boundaries
}

export interface SimResult {
  steps: SimStep[];
  summary: {
    netReturn: number;
    totalFees: number;
    totalIL: number;
    maxDrawdown: number;
    timeInRange: number;  // fraction 0–1
    liquidated: boolean;
    liquidationDay: number | null;
  };
}

// ─── Seedable PRNG ──────────────────────────────────────────────────

/** Mulberry32: fast seedable 32-bit PRNG → [0,1) */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller: uniform → standard normal */
export function boxMuller(rng: () => number): number {
  let u1: number;
  do { u1 = rng(); } while (u1 === 0);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ─── GBM Price Path ─────────────────────────────────────────────────

/** Generate GBM price path: S(t+dt) = S(t)·exp((μ-σ²/2)dt + σ√dt·Z) */
export function generatePricePath(startPrice: number, config: SimConfig): number[] {
  const { vol, drift, durationDays, stepsPerDay, seed } = config;
  const rng = mulberry32(seed);
  const n = durationDays * stepsPerDay;
  const dt = 1 / (365 * stepsPerDay);
  const driftTerm = (drift - 0.5 * vol * vol) * dt;
  const diffusion = vol * Math.sqrt(dt);

  const prices = new Array<number>(n + 1);
  prices[0] = startPrice;
  for (let i = 1; i <= n; i++) {
    prices[i] = prices[i - 1] * Math.exp(driftTerm + diffusion * boxMuller(rng));
  }
  return prices;
}

// ─── Closed-Form Arb Solver ─────────────────────────────────────────

/** Solve for virtual x given target price p (Y per X) on X side.
 *  p = (px/py)·(cx + (1-cx)·(x0/x)²)  →  x = x0/√((p·py/px - cx)/(1-cx))
 *  Returns null if price is below equilibrium or beyond boundary. */
export function solveXForPrice(
  p: number, cx: number, x0: number, px: number, py: number, xb: number,
): number | null {
  const inner = (p * py / px - cx) / (1 - cx);
  if (inner < 1e-12) return null;
  const x = x0 / Math.sqrt(inner);
  return x >= xb ? x : null;
}

/** Solve for virtual y given target price p (Y per X) on Y side.
 *  p = (px/py)/(cy + (1-cy)·(y0/y)²)  →  y = y0/√((px/(py·p) - cy)/(1-cy))
 *  Returns null if price is above equilibrium or beyond boundary. */
export function solveYForPrice(
  p: number, cy: number, y0: number, px: number, py: number, yb: number,
): number | null {
  const inner = (px / (py * p) - cy) / (1 - cy);
  if (inner < 1e-12) return null;
  const y = y0 / Math.sqrt(inner);
  return y >= yb ? y : null;
}

// ─── Simulation Loop ────────────────────────────────────────────────

export function runSimulation(params: Params, config: SimConfig): SimResult {
  const { px, py, cx, cy, rx, ry, xr, yr } = params;
  const x0 = computeX0(params);
  const y0 = computeY0(params);
  const xb = computeXb(x0, rx, cx);
  const yb = computeYb(y0, ry, cy);
  const pEquil = px / py;
  const hasDebt = params.xd > 0 || params.yd > 0 || computeZd(params) > 0;

  const pricePath = generatePricePath(pEquil, config);
  const n = config.durationDays * config.stepsPerDay;

  let curX = x0;
  let curY = y0;
  let cumFees = 0;
  let liquidated = false;
  let liquidationDay: number | null = null;
  let peakNav = 0;
  let maxDrawdown = 0;
  let stepsInRange = 0;

  const initialNav = xr * pEquil + yr;
  peakNav = initialNav;

  const steps: SimStep[] = [];

  for (let i = 0; i <= n; i++) {
    const t = i / config.stepsPerDay;
    const extPrice = pricePath[i];

    let inRange = true;

    if (!liquidated && i > 0) {
      // Arb: find target position for external price
      let newX: number;
      let newY: number;

      if (extPrice >= pEquil) {
        // X side: price above equilibrium → x decreases
        const solved = solveXForPrice(extPrice, cx, x0, px, py, xb);
        if (solved !== null) {
          newX = solved;
          newY = fX(newX, cx, x0, y0, px, py);
        } else {
          newX = xb;
          newY = fX(xb, cx, x0, y0, px, py);
          inRange = false;
        }
      } else {
        // Y side: price below equilibrium → y decreases
        const solved = solveYForPrice(extPrice, cy, y0, px, py, yb);
        if (solved !== null) {
          newY = solved;
          newX = gY(newY, cy, y0, x0, px, py);
        } else {
          newY = yb;
          newX = gY(yb, cy, y0, x0, px, py);
          inRange = false;
        }
      }

      // Fee on trade notional
      const deltaX = Math.abs(newX - curX);
      const fee = deltaX * extPrice * config.feeBps / 10000;
      cumFees += fee;

      curX = newX;
      curY = newY;
    }

    if (inRange) stepsInRange++;

    // Real reserves
    let realX: number;
    let realY: number;
    if (curX <= x0) {
      // X side or equilibrium
      realX = Math.max(xr - (x0 - curX), 0);
      realY = yr + (curY - y0);
    } else {
      // Y side
      realY = Math.max(yr - (y0 - curY), 0);
      realX = xr + (curX - x0);
    }

    const lpNav = realX * extPrice + realY;
    const hodlNav = xr * extPrice + yr;
    const netPnl = lpNav + cumFees - hodlNav;

    // Health
    let health = 10;
    if (hasDebt) {
      if (curX <= x0) {
        const h = computeHX(curX, params, x0, y0);
        if (isFinite(h)) health = Math.min(h, 10);
      } else {
        const h = computeHY(curY, params, x0, y0);
        if (isFinite(h)) health = Math.min(h, 10);
      }
    }

    if (!liquidated && hasDebt && health < 1) {
      liquidated = true;
      liquidationDay = t;
    }

    // Drawdown
    const totalNav = lpNav + cumFees;
    if (totalNav > peakNav) peakNav = totalNav;
    const dd = peakNav > 0 ? (peakNav - totalNav) / peakNav : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;

    steps.push({
      t,
      extPrice,
      x: curX,
      y: curY,
      realX,
      realY,
      lpNav,
      hodlNav,
      feesCum: cumFees,
      netPnl,
      health,
      inRange,
    });
  }

  const finalStep = steps[steps.length - 1];
  return {
    steps,
    summary: {
      netReturn: initialNav > 0 ? (finalStep.lpNav + cumFees) / initialNav - 1 : 0,
      totalFees: cumFees,
      totalIL: finalStep.lpNav - finalStep.hodlNav,
      maxDrawdown,
      timeInRange: (n + 1) > 0 ? stepsInRange / (n + 1) : 1,
      liquidated,
      liquidationDay,
    },
  };
}
