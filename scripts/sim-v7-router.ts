/**
 * V7 Router-Based Simulation (ammchallenge-style)
 *
 * Ports the ammchallenge simulation architecture to EulerSwap:
 *   - Poisson retail arrivals with lognormal sizes (from ammchallenge)
 *   - Optimal 2-venue router: splits each order between our pool and a
 *     reference venue (e.g. Uniswap) based on fee competitiveness
 *   - Closed-form arbitrage (adapted for EulerSwap curve)
 *   - EulerSwap-specific: leverage, vault tracking, health, recentering
 *
 * Each simulation step:
 *   1. GBM price move
 *   2. Arbitrage: arb trades our pool to market price (always happens)
 *   3. Retail: Poisson arrivals, each routed optimally between our pool
 *      and the reference venue based on current fees
 *   4. Trigger check: auction or bare recenter if needed
 *
 * The key question this answers: given realistic fee-sensitive retail routing,
 * how much volume does the pool capture, and does it offset variance drain?
 *
 * Usage: npx tsx scripts/sim-v7-router.ts
 */
import {
  type Params,
  computeX0Additive, computeY0Additive,
  computeXb, computeYb,
  computeHX, computeHY,
  fX, gY,
} from '../src/lib/math';
import { mulberry32, boxMuller, solveXForPrice, solveYForPrice } from '../src/lib/simulate';

// ─── Pool config ────────────────────────────────────────────────────

const BASE_PARAMS: Params = {
  vyx: 0.84, vxy: 0.85,
  vxz: 0, vyz: 0, vzx: 0, vzy: 0,
  px: 1, py: 1986, pxz: 1,
  rx: 0.05, ry: 0.05,
  cx: 0, cy: 0,
  xr: 3611, yr: 0,
  zr: 0, xd: 0, yd: 0, zdebt: 0,
  rXX: 0, rXY: 0, rXZ: 0,
  rYX: 0, rYY: 0, rYZ: 0,
  eXC: 0, eXD: 0, eYC: 0, eYD: 0,
};

const SIM_CONFIG = {
  vol: 0.60,
  drift: 0.0,
  durationDays: 30,
  stepsPerDay: 24,  // hourly
  seed: 42,
};

// ─── Fee config ─────────────────────────────────────────────────────

const FEE_CONFIG = {
  // Our pool's fees
  baseFee: 0.0005,              // 5 bps
  maxCaptureFee: 0.05,          // 500 bps max
  captureRate: 0.5,             // capture multiplier

  // Attract fee: can go negative (rebate) at high exposure
  attractScale: 0.0030,         // max 30 bps rebate at full exposure
  maxExposureFrac: 1.0,         // normalisation

  // Reference venue (Uniswap V3 0.05%)
  refFee: 0.0005,               // 5 bps both directions

  // Auction backstop
  auctionTriggerExposure: 0.70,
  healthRecenterThreshold: 1.10,
  shiftMagnitude: 0.0108,
  decayBpsPerMinute: 21.5,
  clearThreshold: 0.0010,
  minAuctionMinutes: 1,
  maxAuctionMinutes: 120,
};

// ─── Retail config (from ammchallenge, scaled to our pool) ──────────

const RETAIL_CONFIG = {
  // ammchallenge: λ=0.8/step, mean=$20 (in Y), σ_log=1.2, 10k steps
  // Our pool: hourly steps, USDC/WETH. Scale retail to realistic volume.
  //
  // Uniswap USDC/WETH 0.05% does ~$200M/day = ~$8.3M/hour.
  // Our pool competes for a share. The router determines how much we get.
  // We model total routable retail as a parameter.
  //
  // arrivals: ~3/hour, mean $5k per order = ~$15k/hour base = ~$360k/day
  // These orders are then SPLIT by the router between our pool and the ref.
  arrivalRate: 3.0,          // orders per step (hour)
  meanSize: 5000,            // mean order size in USDC
  sizeSigma: 1.2,            // lognormal sigma (from ammchallenge)
  buyProb: 0.5,              // 50/50 direction
};

// ─── RNG utilities ──────────────────────────────────────────────────

function poissonSample(rng: () => number, lambda: number): number {
  // Knuth's algorithm for small lambda
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L);
  return k - 1;
}

function lognormalSample(rng: () => number, mean: number, sigma: number): number {
  const mu = Math.log(mean) - 0.5 * sigma * sigma;
  return Math.exp(mu + sigma * boxMuller(rng));
}

// ─── Pool / Vault / Health (same as V5/V6) ──────────────────────────

interface VaultState { xr: number; yr: number; xd: number; yd: number; }

function vaultStateAt(curX: number, curY: number, x0: number, y0: number, init: VaultState): VaultState {
  const netX = (init.xr - init.xd) + (curX - x0);
  const netY = (init.yr - init.yd) + (curY - y0);
  return { xr: Math.max(netX, 0), yr: Math.max(netY, 0), xd: Math.max(-netX, 0), yd: Math.max(-netY, 0) };
}

function computeNAV(vault: VaultState, ethPrice: number): number {
  return vault.xr + vault.yr * ethPrice - vault.xd - vault.yd * ethPrice;
}

function computeExposure(vault: VaultState, ethPrice: number): number {
  return Math.abs(vault.yr - vault.yd) * ethPrice;
}

interface PoolState {
  x0: number; y0: number;
  curX: number; curY: number;
  params: Params;
  vault: VaultState;
}

function initPool(overrideRx?: number): PoolState {
  const params = { ...BASE_PARAMS };
  if (overrideRx !== undefined) { params.rx = overrideRx; params.ry = overrideRx; }
  const x0 = computeX0Additive(params);
  const y0 = computeY0Additive(params);
  return { x0, y0, curX: x0, curY: y0, params, vault: { xr: params.xr, yr: params.yr, xd: params.xd, yd: params.yd } };
}

function arbToPrice(pool: PoolState, extPrice: number): { curX: number, curY: number, inRange: boolean } {
  const { x0, y0, params } = pool;
  const xb = computeXb(x0, params.rx, params.cx);
  const yb = computeYb(y0, params.ry, params.cy);
  const pEquil = params.px / params.py;
  if (x0 < 1 || y0 < 1e-8) return { curX: pool.curX, curY: pool.curY, inRange: false };
  if (extPrice >= pEquil) {
    const solved = solveXForPrice(extPrice, params.cx, x0, params.px, params.py, xb);
    if (solved !== null) return { curX: solved, curY: fX(solved, params.cx, x0, y0, params.px, params.py), inRange: true };
    return { curX: xb, curY: fX(xb, params.cx, x0, y0, params.px, params.py), inRange: false };
  } else {
    const solved = solveYForPrice(extPrice, params.cy, y0, params.px, params.py, yb);
    if (solved !== null) return { curX: gY(solved, params.cy, y0, x0, params.px, params.py), curY: solved, inRange: true };
    return { curX: gY(yb, params.cy, y0, x0, params.px, params.py), curY: yb, inRange: false };
  }
}

function recenterPool(vault: VaultState, newPy: number, rx?: number): PoolState {
  const params: Params = { ...BASE_PARAMS, py: newPy, xr: vault.xr, yr: vault.yr, xd: vault.xd, yd: vault.yd };
  if (rx !== undefined) { params.rx = rx; params.ry = rx; }
  const x0 = computeX0Additive(params);
  const y0 = computeY0Additive(params);
  return { x0, y0, curX: x0, curY: y0, params, vault: { ...vault } };
}

function computeHealth(pool: PoolState): number {
  const { curX, curY, x0, y0, params } = pool;
  if (x0 <= 0 || y0 <= 0) return 10;
  if (curX <= x0) {
    const h = computeHX(Math.max(curX, 0.001), params, x0, y0);
    if (isFinite(h)) return Math.min(h, 10);
  } else {
    const h = computeHY(Math.max(curY, 1e-8), params, x0, y0);
    if (isFinite(h)) return Math.min(h, 10);
  }
  return 10;
}

// ─── Fee computation ────────────────────────────────────────────────

/**
 * Our pool's fee for a given trade direction.
 * isExposureReducing: true if this trade reduces the pool's net exposure.
 */
function ourPoolFee(exposureFrac: number, isExposureReducing: boolean, priceOffset: number): number {
  if (isExposureReducing) {
    const scale = Math.min(exposureFrac / FEE_CONFIG.maxExposureFrac, 1.0);
    return FEE_CONFIG.baseFee - FEE_CONFIG.attractScale * scale;
  } else {
    return Math.min(FEE_CONFIG.baseFee + FEE_CONFIG.captureRate * priceOffset, FEE_CONFIG.maxCaptureFee);
  }
}

// ─── Optimal Router (ported from ammchallenge) ──────────────────────

/**
 * Route a single retail order between our pool and a reference venue.
 *
 * ammchallenge router formula for 2 constant-product AMMs with fee-on-input:
 *   A_i = sqrt(x_i * γ_i * y_i)
 *   r = A_1 / A_2
 *   Δy_1 = (r * (y_2 + γ_2 * Y) - y_1) / (γ_1 + r * γ_2)
 *
 * For EulerSwap: we approximate the pool as constant-product with virtual reserves
 * (x0, y0) and effective fee. This is exact for c=0.
 *
 * Returns fraction of order routed to our pool [0, 1].
 */
function routeOrder(
  isBuyX: boolean,         // true = trader buys USDC, sells WETH (buy X in USDC/WETH terms)
  orderSizeUSDC: number,
  pool: PoolState,
  ourFee: number,          // our pool's fee for this direction (can be negative)
  ethPrice: number,
): number {
  // Our pool: virtual reserves x0, y0 at current cursor position
  // For routing, we use remaining capacity from cursor to boundary
  const { x0, y0, curX, curY, params } = pool;

  // Reference venue: model as a Uniswap V3 pool with $50M depth per side
  // (USDC/WETH 0.05% pool has ~$180M TVL, effective reserves ~$100M per side)
  const refX = 100_000_000;  // $100M USDC
  const refY = refX / ethPrice; // equivalent WETH
  const refFee = FEE_CONFIG.refFee;

  // Effective gamma (1 - fee). For negative fees, gamma > 1 (rebate).
  const gamma1 = 1 - Math.max(ourFee, -0.10);  // cap rebate at 10%
  const gamma2 = 1 - refFee;

  if (gamma1 <= 0) return 0;  // our fee too high, route nothing

  if (isBuyX) {
    // Trader buys X (USDC), spending Y (WETH). Route Y input.
    // A_i = sqrt(x_i * γ_i * y_i)
    const a1 = Math.sqrt(curX * gamma1 * curY);  // use current reserves, not equilibrium
    const a2 = Math.sqrt(refX * gamma2 * refY);

    if (a2 === 0) return 1;
    const r = a1 / a2;

    const totalY = orderSizeUSDC / ethPrice;  // order in WETH terms
    const numerator = r * (refY + gamma2 * totalY) - curY;
    const denominator = gamma1 + r * gamma2;
    if (denominator === 0) return 0.5;

    const y1 = numerator / denominator;
    const frac = Math.max(0, Math.min(1, y1 / totalY));
    return frac;
  } else {
    // Trader sells X (USDC), receiving Y (WETH). Route X input.
    const b1 = Math.sqrt(curY * gamma1 * curX);
    const b2 = Math.sqrt(refY * gamma2 * refX);

    if (b2 === 0) return 1;
    const r = b1 / b2;

    const totalX = orderSizeUSDC;
    const numerator = r * (refX + gamma2 * totalX) - curX;
    const denominator = gamma1 + r * gamma2;
    if (denominator === 0) return 0.5;

    const x1 = numerator / denominator;
    const frac = Math.max(0, Math.min(1, x1 / totalX));
    return frac;
  }
}

// ─── Execute retail swap on our pool ────────────────────────────────

/**
 * Execute a retail swap on our pool with fee-on-input.
 *
 * Fee is deducted from the INPUT before curve math runs (matching EulerSwap's
 * QuoteLib: `amount = amount - amount * fee / 1e18`). The curve only sees
 * the net input. Fee revenue goes to LP, not into the pool's reserves.
 *
 * amountUSDC: gross order size in USDC terms (before fee).
 */
function executeRetailOnPool(
  pool: PoolState,
  vault: VaultState,
  isBuyX: boolean,
  amountUSDC: number,
  ethPrice: number,
  fee: number,
): { newVault: VaultState; feeRevenue: number; newCurX: number; newCurY: number; executed: boolean } {
  const { x0, y0, params } = pool;
  let curX = pool.curX;
  let curY = pool.curY;
  let newVault = { ...vault };
  const gamma = 1 - fee;  // can be > 1 for negative fees (rebate)
  const noExec = { newVault: vault, feeRevenue: 0, newCurX: curX, newCurY: curY, executed: false };

  // Compute actual curve boundaries (not y0*0.99 or x0*0.99)
  const xb = computeXb(x0, params.rx, params.cx);
  const yb = computeYb(y0, params.ry, params.cy);
  // Max Y when X hits boundary (X-side limit)
  const yAtXb = fX(xb, params.cx, x0, y0, params.px, params.py);
  // Max X when Y hits boundary (Y-side limit)
  const xAtYb = gY(yb, params.cy, y0, x0, params.px, params.py);

  if (isBuyX) {
    // Trader buys X (USDC out), sends WETH in → curY increases, curX decreases
    // Fee-on-input: deduct fee from WETH input before curve
    const dyGross = amountUSDC / ethPrice;
    const dyNet = dyGross * gamma;

    // Clamp to curve boundary (yAtXb is the max Y on the curve)
    const yMax = yAtXb * 0.999;  // stay slightly inside boundary
    const newY = Math.min(curY + dyNet, yMax);
    if (newY <= curY + 1e-10) return noExec;

    const dy = newY - curY;
    // Compute X position from Y on the correct side of the curve
    let xAfter: number;
    if (newY >= y0) {
      // X-side: use fX inverse → need to find x such that fX(x)=newY
      // For c=0: fX(x) = y0 + (px/py)(x0²/x - x0), solve for x
      // x = (px/py)*x0² / (newY - y0 + (px/py)*x0)
      const pxpy = params.px / params.py;
      xAfter = pxpy * x0 * x0 / (newY - y0 + pxpy * x0);
    } else {
      // Y-side: gY gives x from y
      xAfter = gY(newY, params.cy, y0, x0, params.px, params.py);
    }

    let xBefore: number;
    if (curY >= y0 - 1e-8) {
      if (curY >= y0) {
        const pxpy = params.px / params.py;
        xBefore = pxpy * x0 * x0 / (curY - y0 + pxpy * x0);
      } else {
        xBefore = x0;
      }
    } else {
      xBefore = gY(curY, params.cy, y0, x0, params.px, params.py);
    }

    const dxOut = xBefore - xAfter;
    if (dxOut < 0.01) return noExec;

    // Fee: proportional to what was actually used (may be clamped)
    const dyActualGross = dy / gamma;
    const feeRevenue = (dyActualGross - dy) * ethPrice;

    const xrUsed = Math.min(dxOut, newVault.xr);
    const wethRepaid = Math.min(dy, newVault.yd);
    newVault = {
      xr: newVault.xr - xrUsed,
      yr: newVault.yr + (dy - wethRepaid),
      xd: newVault.xd + (dxOut - xrUsed),
      yd: newVault.yd - wethRepaid,
    };

    return { newVault, feeRevenue, newCurX: xAfter, newCurY: newY, executed: true };
  } else {
    // Trader sells X (USDC in), receives WETH out → curX increases, curY decreases
    // Fee-on-input: deduct fee from USDC input before curve
    const dxGross = amountUSDC;
    const dxNet = dxGross * gamma;

    // Clamp to curve boundary (xAtYb is the max X on the curve)
    const xMax = xAtYb * 0.999;
    const newX = Math.min(curX + dxNet, xMax);
    if (newX <= curX + 0.01) return noExec;

    const dx = newX - curX;
    // Compute Y position from X on the correct side of the curve
    let yAfter: number;
    if (newX >= x0) {
      // Y-side: use gY inverse → find y such that gY(y)=newX
      // For c=0: gY(y) = x0 + (py/px)(y0²/y - y0), solve for y
      // y = (py/px)*y0² / (newX - x0 + (py/px)*y0)
      const pypx = params.py / params.px;
      yAfter = pypx * y0 * y0 / (newX - x0 + pypx * y0);
    } else {
      // X-side: fX gives y from x
      yAfter = fX(newX, params.cx, x0, y0, params.px, params.py);
    }

    let yBefore: number;
    if (curX >= x0 - 0.01) {
      if (curX >= x0) {
        const pypx = params.py / params.px;
        yBefore = pypx * y0 * y0 / (curX - x0 + pypx * y0);
      } else {
        yBefore = y0;
      }
    } else {
      yBefore = fX(curX, params.cx, x0, y0, params.px, params.py);
    }

    const dyOut = yBefore - yAfter;
    if (dyOut < 1e-10) return noExec;

    // Fee: proportional to what was actually used (may be clamped)
    const dxActualGross = dx / gamma;
    const feeRevenue = dxActualGross - dx;

    const yrUsed = Math.min(dyOut, newVault.yr);
    const usdcRepaid = Math.min(dx, newVault.xd);
    newVault = {
      xr: newVault.xr + (dx - usdcRepaid),
      yr: newVault.yr - yrUsed,
      xd: newVault.xd - usdcRepaid,
      yd: newVault.yd + (dyOut - yrUsed),
    };

    return { newVault, feeRevenue, newCurX: newX, newCurY: yAfter, executed: true };
  }
}

// ─── Main simulation ────────────────────────────────────────────────

interface V7Result {
  name: string;
  finalNAV: number;
  initialNAV: number;
  totalRecenters: number;
  totalAuctions: number;
  bareRecenters: number;
  arbFeeRevenue: number;
  retailFeeRevenue: number;
  retailVolume: number;
  retailOrders: number;
  retailCaptureRate: number;  // fraction of total retail routed to us
  totalRetailGenerated: number;
  arbVolume: number;
  auctionCost: number;
  maxExposurePct: number;
  avgExposurePct: number;
  minHealth: number;
  log: string[];
}

function runV7(pricePath: number[], overrides?: {
  overrideRx?: number;
  attractScale?: number;
  arrivalRate?: number;
  meanSize?: number;
  refFee?: number;
  auctionTriggerExposure?: number;
}): V7Result {
  const rx = overrides?.overrideRx;
  const attractScale = overrides?.attractScale ?? FEE_CONFIG.attractScale;
  const arrivalRate = overrides?.arrivalRate ?? RETAIL_CONFIG.arrivalRate;
  const meanSize = overrides?.meanSize ?? RETAIL_CONFIG.meanSize;
  const refFee = overrides?.refFee ?? FEE_CONFIG.refFee;
  const auctionTrigger = overrides?.auctionTriggerExposure ?? FEE_CONFIG.auctionTriggerExposure;

  // Save & override
  const origAttract = FEE_CONFIG.attractScale;
  const origRef = FEE_CONFIG.refFee;
  FEE_CONFIG.attractScale = attractScale;
  FEE_CONFIG.refFee = refFee;

  const n = SIM_CONFIG.durationDays * SIM_CONFIG.stepsPerDay;
  let pool = initPool(rx);
  const initialNAV = computeNAV(pool.vault, pool.params.py);
  const rng = mulberry32(SIM_CONFIG.seed + 1000);  // separate seed for retail
  const log: string[] = [];

  let totalRecenters = 0, totalAuctions = 0, bareRecenters = 0;
  let arbFeeRevenue = 0, retailFeeRevenue = 0;
  let retailVolume = 0, retailOrders = 0, totalRetailGenerated = 0;
  let arbVolume = 0, auctionCost = 0;
  let maxExposurePct = 0, sumExposurePct = 0, minHealth = 10;
  let approxNav = initialNAV;

  for (let i = 1; i <= n; i++) {
    const t = i / SIM_CONFIG.stepsPerDay;
    const extPrice = pricePath[i];
    const ethPrice = 1 / extPrice;
    const pEquil = pool.params.px / pool.params.py;
    const priceOffset = Math.abs(extPrice - pEquil) / pEquil;

    // 1. Compute arb fee at PRE-ARB state (EulerSwap's getFee sees pre-swap reserves)
    const preArbVault = vaultStateAt(pool.curX, pool.curY, pool.x0, pool.y0, pool.vault);
    const preArbNav = computeNAV(preArbVault, ethPrice);
    const preArbExposure = computeExposure(preArbVault, ethPrice);
    const preArbExposurePct = preArbNav > 0 ? preArbExposure / preArbNav : 0;
    const arbFee = ourPoolFee(preArbExposurePct, false, priceOffset);
    const arbGamma = 1 - arbFee;

    // 2. Arb with fee friction — fee-on-input creates a no-arb band.
    //    For fee-on-input γ:
    //    - Arb buys X (extPrice > pEquil): stops when p_curve = γ·extPrice
    //    - Arb sells X (extPrice < pEquil): stops when p_curve = extPrice/γ
    //    The arb can't profitably push price closer than this to the external price.
    const preArb = { curX: pool.curX, curY: pool.curY };
    let targetPrice: number;
    let shouldArb = false;
    if (extPrice > pEquil && arbGamma > 0) {
      targetPrice = arbGamma * extPrice;
      shouldArb = targetPrice > pEquil;  // target still above equilibrium
    } else if (extPrice < pEquil && arbGamma > 0) {
      targetPrice = extPrice / arbGamma;
      shouldArb = targetPrice < pEquil;  // target still below equilibrium
    } else {
      targetPrice = extPrice;
    }

    if (shouldArb) {
      const arbed = arbToPrice(pool, targetPrice);
      pool.curX = arbed.curX;
      pool.curY = arbed.curY;
    }

    const arbDx = Math.abs(pool.curX - preArb.curX);
    arbVolume += arbDx;

    // Arb fee revenue: fee fraction of the GROSS input.
    // The curve moved by net input; gross = net / γ; fee = gross - net = net * (1-γ)/γ.
    // For arb buying X (sending Y): net Y input = pool.curY - preArb.curY, fee in Y
    // For arb selling X (sending X): net X input = pool.curX - preArb.curX, fee in X
    if (arbDx > 0.01 && arbGamma > 0) {
      if (extPrice > pEquil) {
        // Arb sent Y (WETH), received X. Fee on Y input.
        const dyNet = pool.curY - preArb.curY;
        const feeY = dyNet * (1 - arbGamma) / arbGamma;
        arbFeeRevenue += feeY * ethPrice;  // convert to USDC
      } else {
        // Arb sent X (USDC), received Y. Fee on X input.
        const dxNet = pool.curX - preArb.curX;
        const feeX = dxNet * (1 - arbGamma) / arbGamma;
        arbFeeRevenue += feeX;
      }
    }

    // Vault after arb
    let vault = vaultStateAt(pool.curX, pool.curY, pool.x0, pool.y0, pool.vault);
    let nav = computeNAV(vault, ethPrice);
    let exposure = computeExposure(vault, ethPrice);
    let exposurePct = nav > 0 ? exposure / nav : 0;

    // 3. Generate retail orders (Poisson arrivals)
    // After EACH swap (arb or retail), check triggers — mirrors EulerSwap afterSwap.
    const nOrders = poissonSample(rng, arrivalRate);
    let wethNet = vault.yr - vault.yd;
    let health = computeHealth(pool);
    if (health < minHealth) minHealth = health;
    let needsRecenter = health < FEE_CONFIG.healthRecenterThreshold && health < 10;
    let needsAuction = !needsRecenter && exposurePct > auctionTrigger && nav > 1;

    if (!needsRecenter && !needsAuction) {
      for (let j = 0; j < nOrders; j++) {
        const orderSize = lognormalSample(rng, meanSize, RETAIL_CONFIG.sizeSigma);
        const isBuyX = rng() < RETAIL_CONFIG.buyProb;
        totalRetailGenerated += orderSize;

        const isReducing = isBuyX ? (wethNet > 0) : (wethNet < 0);
        const fee = ourPoolFee(exposurePct, isReducing, priceOffset);
        const fraction = routeOrder(isBuyX, orderSize, pool, fee, ethPrice);
        const ourAmount = orderSize * fraction;

        if (ourAmount > 1) {
          const result = executeRetailOnPool(pool, vault, isBuyX, ourAmount, ethPrice, fee);
          if (result.executed) {
            vault = result.newVault;
            pool.curX = result.newCurX;
            pool.curY = result.newCurY;
            retailFeeRevenue += result.feeRevenue;
            retailVolume += ourAmount;
            retailOrders++;

            nav = computeNAV(vault, ethPrice);
            exposure = computeExposure(vault, ethPrice);
            exposurePct = nav > 0 ? exposure / nav : 0;
            wethNet = vault.yr - vault.yd;

            // afterSwap trigger check
            health = computeHealth(pool);
            if (health < minHealth) minHealth = health;
            needsRecenter = health < FEE_CONFIG.healthRecenterThreshold && health < 10;
            needsAuction = !needsRecenter && exposurePct > auctionTrigger && nav > 1;
            if (needsRecenter || needsAuction) break;
          }
        }
      }
    }

    if (exposurePct > maxExposurePct) maxExposurePct = exposurePct;
    sumExposurePct += exposurePct;

    // 4. Emergency recenter
    if (needsRecenter) {
      pool = recenterPool(vault, ethPrice, rx);
      approxNav = computeNAV(vault, ethPrice);
      totalRecenters++; bareRecenters++;
      log.push(`Day ${t.toFixed(1).padStart(5)} BARE_RECENTER h=${health.toFixed(2)} exp=${(exposurePct*100).toFixed(0)}%`);
      continue;
    }

    // 5. Auction backstop
    if (needsAuction) {
      const asset0Deficit = wethNet > 0;
      const shift = FEE_CONFIG.shiftMagnitude;
      const pyOff = asset0Deficit ? ethPrice / (1 + shift) : ethPrice * (1 + shift);
      const offParams: Params = { ...pool.params, py: pyOff, xr: vault.xr, yr: vault.yr, xd: vault.xd, yd: vault.yd };
      if (rx !== undefined) { offParams.rx = rx; offParams.ry = rx; }
      const x0Off = computeX0Additive(offParams);
      const y0Off = computeY0Additive(offParams);

      if (x0Off >= 1 && y0Off >= 1e-8) {
        let curVault = { ...vault };
        let aCost = 0, aFees = 0, cleared = false;
        const startFee = Math.min(shift * 1.5, FEE_CONFIG.maxCaptureFee);

        if (asset0Deficit) {
          let yCur = y0Off;
          const ybOff = computeYb(y0Off, offParams.ry, offParams.cy);
          for (let min = 0; min <= FEE_CONFIG.maxAuctionMinutes; min++) {
            const feeFrac = Math.max(startFee - (FEE_CONFIG.decayBpsPerMinute * min) / 10000, FEE_CONFIG.baseFee);
            const offset = (1 + shift) * (yCur / y0Off) ** 2 - 1;
            if (offset < 1e-8) break;
            if (offset <= feeFrac + FEE_CONFIG.refFee) { if (feeFrac <= FEE_CONFIG.baseFee) break; continue; }
            const denom = (1 - FEE_CONFIG.refFee) * (1 - feeFrac) * (1 + shift);
            if (denom <= 0) continue;
            const yEnd = Math.max(y0Off / Math.sqrt(denom), ybOff);
            if (yEnd >= yCur - 1e-8) continue;
            const dyOut = yCur - yEnd;
            const xEnd = gY(yEnd, 0, y0Off, x0Off, 1, pyOff);
            const xCurVal = (yCur >= y0Off - 1e-8) ? x0Off : gY(yCur, 0, y0Off, x0Off, 1, pyOff);
            const dxIn = xEnd - xCurVal;
            if (dxIn < 0.01) continue;
            const feeUSDC = dxIn * feeFrac / (1 - feeFrac);
            aCost += dyOut * ethPrice - dxIn;
            aFees += feeUSDC;
            const usdcRepaid = Math.min(dxIn + feeUSDC, curVault.xd);
            const yrUsed = Math.min(dyOut, curVault.yr);
            curVault = { xr: curVault.xr + (dxIn + feeUSDC - usdcRepaid), yr: curVault.yr - yrUsed, xd: curVault.xd - usdcRepaid, yd: curVault.yd + (dyOut - yrUsed) };
            yCur = yEnd;
            const postOffset = (1 + shift) * (yCur / y0Off) ** 2 - 1;
            if (min >= FEE_CONFIG.minAuctionMinutes && postOffset <= FEE_CONFIG.clearThreshold * 1.01) { cleared = true; break; }
            if (feeFrac <= FEE_CONFIG.baseFee) break;
          }
        } else {
          let xCur = x0Off;
          const xbOff = computeXb(x0Off, offParams.rx, offParams.cx);
          for (let min = 0; min <= FEE_CONFIG.maxAuctionMinutes; min++) {
            const feeFrac = Math.max(startFee - (FEE_CONFIG.decayBpsPerMinute * min) / 10000, FEE_CONFIG.baseFee);
            const offset = (1 + shift) * (xCur / x0Off) ** 2 - 1;
            if (offset < 1e-8) break;
            if (offset <= feeFrac + FEE_CONFIG.refFee) { if (feeFrac <= FEE_CONFIG.baseFee) break; continue; }
            const denom = (1 - FEE_CONFIG.refFee) * (1 - feeFrac) * (1 + shift);
            if (denom <= 0) continue;
            const xEnd = Math.max(x0Off / Math.sqrt(denom), xbOff);
            if (xEnd >= xCur - 0.01) continue;
            const dxOut = xCur - xEnd;
            const yEnd = fX(xEnd, 0, x0Off, y0Off, 1, pyOff);
            const yCurVal = (xCur >= x0Off - 0.01) ? y0Off : fX(xCur, 0, x0Off, y0Off, 1, pyOff);
            const dyIn = yEnd - yCurVal;
            if (dyIn < 1e-12) continue;
            const feeWETH = dyIn * feeFrac / (1 - feeFrac);
            aCost += dxOut - dyIn * ethPrice;
            aFees += feeWETH * ethPrice;
            const wethRepaid = Math.min(dyIn + feeWETH, curVault.yd);
            const xrUsed = Math.min(dxOut, curVault.xr);
            curVault = { xr: curVault.xr - xrUsed, yr: curVault.yr + (dyIn + feeWETH - wethRepaid), xd: curVault.xd + (dxOut - xrUsed), yd: curVault.yd - wethRepaid };
            xCur = xEnd;
            const postOffset = (1 + shift) * (xCur / x0Off) ** 2 - 1;
            if (min >= FEE_CONFIG.minAuctionMinutes && postOffset <= FEE_CONFIG.clearThreshold * 1.01) { cleared = true; break; }
            if (feeFrac <= FEE_CONFIG.baseFee) break;
          }
        }

        auctionCost += aCost - aFees;
        totalAuctions++;
        totalRecenters++;
        pool = recenterPool(cleared ? curVault : vault, ethPrice, rx);
        approxNav = computeNAV(cleared ? curVault : vault, ethPrice);
        log.push(`Day ${t.toFixed(1).padStart(5)} AUCTION ${cleared?'OK':'STALL'} exp=${(exposurePct*100).toFixed(0)}% cost=$${(aCost-aFees).toFixed(1)}`);
      }
    }
  }

  const finalVault = vaultStateAt(pool.curX, pool.curY, pool.x0, pool.y0, pool.vault);
  const finalNAV = computeNAV(finalVault, pool.params.py);

  FEE_CONFIG.attractScale = origAttract;
  FEE_CONFIG.refFee = origRef;

  return {
    name: 'V7 router',
    finalNAV, initialNAV,
    totalRecenters, totalAuctions, bareRecenters,
    arbFeeRevenue, retailFeeRevenue, retailVolume, retailOrders,
    retailCaptureRate: totalRetailGenerated > 0 ? retailVolume / totalRetailGenerated : 0,
    totalRetailGenerated,
    arbVolume, auctionCost,
    maxExposurePct, avgExposurePct: sumExposurePct / n,
    minHealth, log,
  };
}

// ─── Price path ─────────────────────────────────────────────────────

function generatePricePath(startPrice: number): number[] {
  const { vol, drift, durationDays, stepsPerDay, seed } = SIM_CONFIG;
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

// ─── Output ─────────────────────────────────────────────────────────

function printV7(r: V7Result, label?: string) {
  const navPct = ((r.finalNAV / r.initialNAV - 1) * 100).toFixed(1);
  const netFees = r.arbFeeRevenue + r.retailFeeRevenue - r.auctionCost;
  console.log(
    `  ${(label || r.name).padEnd(32)} ` +
    `NAV $${r.finalNAV.toFixed(0).padStart(5)} (${navPct.padStart(6)}%)  ` +
    `recenters=${String(r.totalRecenters).padStart(3)}  ` +
    `minH=${r.minHealth.toFixed(2)}  ` +
    `capture=${(r.retailCaptureRate*100).toFixed(1)}%`
  );
  console.log(
    `${''.padEnd(34)} ` +
    `arbFees=$${r.arbFeeRevenue.toFixed(0).padStart(5)}  ` +
    `retailFees=$${r.retailFeeRevenue.toFixed(0).padStart(5)}  ` +
    `auctionCost=$${r.auctionCost.toFixed(0).padStart(4)}  ` +
    `net=$${netFees.toFixed(0).padStart(5)}  ` +
    `retailVol=$${(r.retailVolume/1000).toFixed(0)}k/${(r.totalRetailGenerated/1000).toFixed(0)}k  ` +
    `avgExp=${(r.avgExposurePct*100).toFixed(0)}%`
  );
}

// ─── Run ─────────────────────────────────────────────────────────────

function run() {
  console.log('=== V7 Router-Based Simulation (ammchallenge-style) ===');
  console.log(`Pool: USDC/WETH, rx=ry=${BASE_PARAMS.rx}, equity=$${BASE_PARAMS.xr}`);
  console.log(`Ref venue: Uniswap ${FEE_CONFIG.refFee*10000}bps | Our base: ${FEE_CONFIG.baseFee*10000}bps + attract to -${FEE_CONFIG.attractScale*10000}bps`);
  console.log(`Retail: ~${RETAIL_CONFIG.arrivalRate}/hr, mean $${RETAIL_CONFIG.meanSize}, 50/50 direction`);
  console.log(`Auction backstop at ${FEE_CONFIG.auctionTriggerExposure*100}% exposure`);
  console.log('');

  // Main comparison across volatilities (with + without retail)
  for (const vol of [0.30, 0.45, 0.60, 0.90]) {
    SIM_CONFIG.vol = vol;
    const pricePath = generatePricePath(BASE_PARAMS.px / BASE_PARAMS.py);
    const ethStart = 1 / pricePath[0];
    const ethEnd = 1 / pricePath[pricePath.length - 1];
    console.log(`--- Vol=${(vol*100).toFixed(0)}%, 30d, ETH $${ethStart.toFixed(0)}->${ethEnd.toFixed(0)} ---`);
    const rNoRetail = runV7(pricePath, { arrivalRate: 0 });
    printV7(rNoRetail, 'no retail (production)');
    const r = runV7(pricePath);
    printV7(r, 'with retail (3/hr $5k)');
    console.log('');
  }

  // ── Sensitivity: range width ──
  console.log('=== Range Width Sweep (60% vol) ===');
  SIM_CONFIG.vol = 0.60;
  const pp = generatePricePath(BASE_PARAMS.px / BASE_PARAMS.py);
  console.log('  rx    |  L_eff | Retail | Final NAV | NAV %  | Rcntrs | Capture | Retail$ | Net Fees | MinH');
  console.log('  ------|--------|--------|-----------|--------|--------|---------|---------|----------|-----');
  for (const rxVal of [0.05, 0.10, 0.15, 0.25, 0.50]) {
    const testP = { ...BASE_PARAMS, rx: rxVal, ry: rxVal };
    const lEff = (computeX0Additive(testP) + computeY0Additive(testP) * BASE_PARAMS.py) / BASE_PARAMS.xr;
    for (const withRetail of [false, true]) {
      const r = runV7(pp, { overrideRx: rxVal, arrivalRate: withRetail ? RETAIL_CONFIG.arrivalRate : 0 });
      const navPct = ((r.finalNAV / r.initialNAV - 1) * 100).toFixed(1);
      const net = r.arbFeeRevenue + r.retailFeeRevenue - r.auctionCost;
      const tag = withRetail ? 'yes' : 'no ';
      console.log(
        `  ${rxVal.toFixed(2).padStart(5)} | ${lEff.toFixed(0).padStart(5)}x | ` +
        `${tag.padStart(6)} | ` +
        `$${r.finalNAV.toFixed(0).padStart(7)} | ${navPct.padStart(5)}% | ` +
        `${String(r.totalRecenters).padStart(6)} | ` +
        `${(r.retailCaptureRate*100).toFixed(1).padStart(6)}% | ` +
        `$${(r.retailVolume/1000).toFixed(0).padStart(5)}k | ` +
        `$${net.toFixed(0).padStart(8)} | ` +
        `${r.minHealth.toFixed(2).padStart(4)}`
      );
    }
  }

  // ── Sensitivity: retail arrival rate ──
  console.log('\n=== Retail Volume Sweep (60% vol, rx=0.25) ===');
  // No-retail baseline first
  const rBase = runV7(pp, { overrideRx: 0.25, arrivalRate: 0 });
  const baseNavPct = ((rBase.finalNAV / rBase.initialNAV - 1) * 100).toFixed(1);
  const baseNet = rBase.arbFeeRevenue + rBase.retailFeeRevenue - rBase.auctionCost;
  console.log('  Rate | Mean$ | Final NAV | NAV %  | Rcntrs | Capture | RetailVol | Net Fees');
  console.log('  -----|-------|-----------|--------|--------|---------|-----------|--------');
  console.log(
    `     0 |    $0 | ` +
    `$${rBase.finalNAV.toFixed(0).padStart(7)} | ${baseNavPct.padStart(5)}% | ` +
    `${String(rBase.totalRecenters).padStart(6)} | ` +
    `${(rBase.retailCaptureRate*100).toFixed(1).padStart(6)}% | ` +
    `$${(rBase.retailVolume/1000).toFixed(0).padStart(7)}k | ` +
    `$${baseNet.toFixed(0).padStart(7)}   <- no retail baseline`
  );
  for (const [rate, mean] of [[1, 2000], [3, 5000], [5, 5000], [10, 5000], [10, 10000], [20, 10000]] as [number, number][]) {
    const r = runV7(pp, { overrideRx: 0.25, arrivalRate: rate, meanSize: mean });
    const navPct = ((r.finalNAV / r.initialNAV - 1) * 100).toFixed(1);
    const net = r.arbFeeRevenue + r.retailFeeRevenue - r.auctionCost;
    console.log(
      `  ${String(rate).padStart(4)} | $${String(mean).padStart(4)} | ` +
      `$${r.finalNAV.toFixed(0).padStart(7)} | ${navPct.padStart(5)}% | ` +
      `${String(r.totalRecenters).padStart(6)} | ` +
      `${(r.retailCaptureRate*100).toFixed(1).padStart(6)}% | ` +
      `$${(r.retailVolume/1000).toFixed(0).padStart(7)}k | ` +
      `$${net.toFixed(0).padStart(7)}`
    );
  }

  // ── Sensitivity: negative fee (attract scale) ──
  console.log('\n=== Attract Scale Sweep (60% vol, rx=0.25, 3/hr $5k) ===');
  console.log('  Attract | Final NAV | NAV %  | Capture | Retail Fees | Net Fees');
  console.log('  --------|-----------|--------|---------|-------------|--------');
  for (const scale of [0, 0.0010, 0.0030, 0.0050, 0.0100, 0.0200]) {
    const r = runV7(pp, { overrideRx: 0.25, attractScale: scale });
    const navPct = ((r.finalNAV / r.initialNAV - 1) * 100).toFixed(1);
    const net = r.arbFeeRevenue + r.retailFeeRevenue - r.auctionCost;
    console.log(
      `  ${(scale*10000).toFixed(0).padStart(5)}bps | ` +
      `$${r.finalNAV.toFixed(0).padStart(7)} | ${navPct.padStart(5)}% | ` +
      `${(r.retailCaptureRate*100).toFixed(1).padStart(6)}% | ` +
      `$${r.retailFeeRevenue.toFixed(0).padStart(11)} | ` +
      `$${net.toFixed(0).padStart(7)}`
    );
  }

  // Log
  SIM_CONFIG.vol = 0.60;
  const rLog = runV7(pp, { overrideRx: 0.25 });
  if (rLog.log.length > 0) {
    console.log(`\n=== Event Log (rx=0.25, 60% vol, first 20) ===`);
    for (const line of rLog.log.slice(0, 20)) console.log(`  ${line}`);
    if (rLog.log.length > 20) console.log(`  ... (${rLog.log.length - 20} more)`);
  }
}

run();
