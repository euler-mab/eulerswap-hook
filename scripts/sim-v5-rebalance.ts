/**
 * V5 Autonomous Hook Simulation (v2 — fixed)
 *
 * Fixes from v1:
 *   1. Proper auction sub-simulation: minute-by-minute fee decay with arb trades
 *      (ported from sim-v3-rebalance.ts), not monolithic arbToPrice()
 *   2. Separate LP cost from price P&L — auction cost = price improvement + fees
 *   3. Health factor tracking via computeHX/computeHY
 *   4. Pool reconstruction via computeX0Additive (correct leveraged depth)
 *
 * V5 mechanics modeled:
 *   - Dynamic shift proportional to exposure, capped at shiftMagnitude
 *   - Starting fee = 1.5x shift, decay per block
 *   - Three clearing: equity_zero, debt_zero, price_convergence
 *   - Two triggers: equity trigger, debt trigger (reserve trigger removed — vestigial)
 *   - Surcharge post-clearing
 *
 * Usage: npx tsx scripts/sim-v5-rebalance.ts
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
  stepsPerDay: 24,
  seed: 42,
};

// ─── V5 config ──────────────────────────────────────────────────────

const V5_CONFIG = {
  baseFee: 0.0005,              // 5 bps
  maxFee: 0.05,                 // 500 bps
  externalFee: 0.0005,          // 5 bps (Uni V3)

  shiftMagnitude: 0.0108,       // 108 bps max
  // triggerThreshold removed — reserve trigger was vestigial (see section 23)
  clearThreshold: 0.0010,       // 10 bps convergence
  decayBpsPerMinute: 21.5,      // ~4.3 bps/block @ 12s, 5 blocks/min
  minAuctionMinutes: 1,         // ~5 blocks
  maxAuctionMinutes: 120,

  exposureTriggerThreshold: 0.25,
  equityClearingEnabled: true,
  quoteIsAsset0: true,

  surchargeInitialBps: 50,
  surchargeDecayBpsPerStep: 7.5, // 50 bps / ~6.7 steps to zero
};

// ─── V3 config ──────────────────────────────────────────────────────

const V3_CONFIG = {
  triggerPct: 0.50,
  auctionDeltaBps: 100,
  startFeeBps: 200,
  decayBpsPerMinute: 2,
  uniFee: 0.0005,
  maxAuctionMinutes: 120,
};

// ─── GBM ────────────────────────────────────────────────────────────

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

// ─── Vault ──────────────────────────────────────────────────────────

interface VaultState {
  xr: number; yr: number; xd: number; yd: number;
}

function vaultStateAt(curX: number, curY: number, x0: number, y0: number, init: VaultState): VaultState {
  // Track net positions: swap changes both sides simultaneously.
  // X consumed = x0 - curX (positive when curX < x0)
  // Y gained  = curY - y0  (positive when curX < x0, by curve invariant)
  const xDelta = curX - x0; // positive = X gained, negative = X consumed
  const yDelta = curY - y0; // positive = Y gained, negative = Y consumed

  const netX = (init.xr - init.xd) + xDelta;
  const netY = (init.yr - init.yd) + yDelta;

  return {
    xr: Math.max(netX, 0),
    yr: Math.max(netY, 0),
    xd: Math.max(-netX, 0),
    yd: Math.max(-netY, 0),
  };
}

function computeNAV(vault: VaultState, ethPrice: number): number {
  return vault.xr + vault.yr * ethPrice - vault.xd - vault.yd * ethPrice;
}

function computeExposure(vault: VaultState, ethPrice: number): number {
  return Math.abs(vault.yr - vault.yd) * ethPrice;
}

// ─── Pool ───────────────────────────────────────────────────────────

interface PoolState {
  x0: number; y0: number;
  curX: number; curY: number;
  params: Params;
  vault: VaultState;
}

function initPool(): PoolState {
  const params = { ...BASE_PARAMS };
  const x0 = computeX0Additive(params);
  const y0 = computeY0Additive(params);
  return {
    x0, y0, curX: x0, curY: y0, params,
    vault: { xr: params.xr, yr: params.yr, xd: params.xd, yd: params.yd },
  };
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

function recenterPool(vault: VaultState, newPy: number): PoolState {
  const params: Params = { ...BASE_PARAMS, py: newPy, xr: vault.xr, yr: vault.yr, xd: vault.xd, yd: vault.yd };
  const x0 = computeX0Additive(params);
  const y0 = computeY0Additive(params);
  return { x0, y0, curX: x0, curY: y0, params, vault: { ...vault } };
}

// ─── Health ─────────────────────────────────────────────────────────

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

// ─── V5 Auction sub-simulation ──────────────────────────────────────

type ClearCondition = 'equity_zero' | 'debt_zero' | 'price_convergence' | 'stalled';

interface V5AuctionResult {
  triggered: boolean;
  direction: 'attract_usdc' | 'attract_weth' | 'none';
  triggerType: 'equity' | 'debt';
  shiftBps: number;
  startFeeBps: number;
  exposureBefore: number;
  exposureAfter: number;
  lpCostUSDC: number;       // price improvement given to arbers
  feeRevenueUSDC: number;   // fees collected
  netCostUSDC: number;      // lpCost - feeRevenue
  numTrades: number;
  clearingTimeMin: number;
  clearCondition: ClearCondition;
  cleared: boolean;
  finalVault: VaultState;
}

/**
 * Run V5 auction sub-simulation with minute-by-minute fee decay.
 * Adapted from sim-v3-rebalance.ts runV3Auction() with V5 clearing conditions.
 */
function runV5Auction(
  vault: VaultState,
  startRes0: number, startRes1: number,
  params: Params,
  marketPy: number,
  shift: number,
  triggerType: 'equity' | 'debt',
  asset0Deficit: boolean,
): V5AuctionResult {
  const ethPrice = marketPy;
  const exposureBefore = computeExposure(vault, ethPrice);
  const direction = asset0Deficit ? 'attract_usdc' as const : 'attract_weth' as const;
  const shiftBps = Math.round(shift * 10000);

  // V5: starting fee = 1.5x shift, capped
  const startFee = Math.min(Math.max(shift * 1.5, V5_CONFIG.baseFee), V5_CONFIG.maxFee);
  const startFeeBps = Math.round(startFee * 10000);

  // Set up shifted pool
  const pyOff = asset0Deficit
    ? marketPy / (1 + shift)
    : marketPy * (1 + shift);

  const offParams: Params = {
    ...params, py: pyOff,
    xr: vault.xr, yr: vault.yr, xd: vault.xd, yd: vault.yd,
  };
  const x0Off = computeX0Additive(offParams);
  const y0Off = computeY0Additive(offParams);

  const noResult: V5AuctionResult = {
    triggered: false, direction: 'none', triggerType, shiftBps: 0, startFeeBps: 0,
    exposureBefore, exposureAfter: exposureBefore,
    lpCostUSDC: 0, feeRevenueUSDC: 0, netCostUSDC: 0,
    numTrades: 0, clearingTimeMin: 0, clearCondition: 'stalled', cleared: false,
    finalVault: vault,
  };

  if (x0Off < 1 || y0Off < 1e-8) return noResult;

  let absoluteX = startRes0;
  let absoluteY = startRes1;
  let curVault = { ...vault };
  let numTrades = 0;
  let totalLPCost = 0;
  let totalFeeUSDC = 0;
  let clearTime = 0;
  let cleared = false;
  let clearCondition: ClearCondition = 'stalled';

  const { decayBpsPerMinute, maxAuctionMinutes, externalFee, minAuctionMinutes, clearThreshold } = V5_CONFIG;

  /** Check V5 clearing conditions.
   *  currentOffset = (1+shift)*(curReserve/eq)^2 - 1 = priceDiff (marginal vs market).
   *  Passed in from the arb loop so we use the curve position, not absoluteX/Y. */
  function checkClearing(min: number, currentOffset: number): ClearCondition | null {
    if (min < minAuctionMinutes) return null;

    // 1. Equity-zero / debt-zero
    if (triggerType === 'equity') {
      const deposits = V5_CONFIG.quoteIsAsset0 ? curVault.yr : curVault.xr;
      const debt = V5_CONFIG.quoteIsAsset0 ? curVault.yd : curVault.xd;
      const wasLong = asset0Deficit === V5_CONFIG.quoteIsAsset0;
      if (wasLong ? deposits <= debt : debt <= deposits) return 'equity_zero';
    } else {
      const clearingDebt = asset0Deficit ? curVault.xd : curVault.yd;
      if (clearingDebt < (asset0Deficit ? 0.01 : 1e-8)) return 'debt_zero';
    }

    // 2. Price convergence: offset IS the price difference (proven algebraically)
    //    After arb at baseFee: offset ≈ baseFee + externalFee = clearThreshold
    //    Add 1% tolerance for second-order term: 1/((1-a)(1-b)) - 1 ≈ a+b + ab
    if (currentOffset <= clearThreshold * 1.01) return 'price_convergence';

    return null;
  }

  if (asset0Deficit) {
    // Attract USDC: arbers buy WETH (cheap) with USDC → USDC in, WETH out
    const ybOff = computeYb(y0Off, offParams.ry, offParams.cy);
    let yCur = y0Off;

    for (let min = 0; min <= maxAuctionMinutes; min++) {
      // V5 fee: starts at 1.5x shift, decays per block (converted to per-min)
      const feeFrac = Math.max(startFee - (decayBpsPerMinute * min) / 10000, V5_CONFIG.baseFee);

      // Arb offset at current position
      const offset = (1 + shift) * (yCur / y0Off) ** 2 - 1;
      if (offset < 1e-8) break;
      if (offset <= feeFrac + externalFee) {
        if (feeFrac <= V5_CONFIG.baseFee) break;
        continue;
      }

      const denom = (1 - externalFee) * (1 - feeFrac) * (1 + shift);
      if (denom <= 0) continue;
      const yEnd = Math.max(y0Off / Math.sqrt(denom), ybOff);
      if (yEnd >= yCur - 1e-8) continue;

      const dyOut = yCur - yEnd;
      const xEnd = gY(yEnd, 0, y0Off, x0Off, 1, pyOff);
      const xCurVal = (yCur >= y0Off - 1e-8) ? x0Off : gY(yCur, 0, y0Off, x0Off, 1, pyOff);
      const dxIn = xEnd - xCurVal;
      if (dxIn < 0.01) continue;

      const feeUSDC = dxIn * feeFrac / (1 - feeFrac);
      const totalUsdcIn = dxIn + feeUSDC;

      // Update vault
      const usdcRepaid = Math.min(totalUsdcIn, curVault.xd);
      const yrUsed = Math.min(dyOut, curVault.yr);
      curVault = {
        xr: curVault.xr + (totalUsdcIn - usdcRepaid),
        yr: curVault.yr - yrUsed,
        xd: curVault.xd - usdcRepaid,
        yd: curVault.yd + (dyOut - yrUsed),
      };

      absoluteX += totalUsdcIn;
      absoluteY -= dyOut;

      totalLPCost += dyOut * marketPy - dxIn;  // arber gets WETH worth more than USDC paid
      totalFeeUSDC += feeUSDC;
      numTrades++;
      clearTime = min;
      yCur = yEnd;

      // Check clearing — pass current offset (recompute after trade)
      const postOffset = (1 + shift) * (yCur / y0Off) ** 2 - 1;
      const cond = checkClearing(min, postOffset);
      if (cond) { clearCondition = cond; cleared = true; break; }
      if (feeFrac <= V5_CONFIG.baseFee) break;
    }
    // Post-loop clearing check: arb exhausted, fee at baseFee
    if (!cleared && numTrades > 0) {
      const finalOffset = (1 + shift) * (yCur / y0Off) ** 2 - 1;
      const cond = checkClearing(clearTime, Math.max(finalOffset, 0));
      if (cond) { clearCondition = cond; cleared = true; }
    }
  } else {
    // Attract WETH: arbers sell WETH, buy USDC (cheap) → WETH in, USDC out
    const xbOff = computeXb(x0Off, offParams.rx, offParams.cx);
    let xCur = x0Off;

    for (let min = 0; min <= maxAuctionMinutes; min++) {
      const feeFrac = Math.max(startFee - (decayBpsPerMinute * min) / 10000, V5_CONFIG.baseFee);

      const offset = (1 + shift) * (xCur / x0Off) ** 2 - 1;
      if (offset < 1e-8) break;
      if (offset <= feeFrac + externalFee) {
        if (feeFrac <= V5_CONFIG.baseFee) break;
        continue;
      }

      const denom = (1 - externalFee) * (1 - feeFrac) * (1 + shift);
      if (denom <= 0) continue;
      const xEnd = Math.max(x0Off / Math.sqrt(denom), xbOff);
      if (xEnd >= xCur - 0.01) continue;

      const dxOut = xCur - xEnd;
      const yEnd = fX(xEnd, 0, x0Off, y0Off, 1, pyOff);
      const yCurVal = (xCur >= x0Off - 0.01) ? y0Off : fX(xCur, 0, x0Off, y0Off, 1, pyOff);
      const dyIn = yEnd - yCurVal;
      if (dyIn < 1e-12) continue;

      const feeWETH = dyIn * feeFrac / (1 - feeFrac);
      const totalWethIn = dyIn + feeWETH;

      const wethRepaid = Math.min(totalWethIn, curVault.yd);
      const xrUsed = Math.min(dxOut, curVault.xr);
      curVault = {
        xr: curVault.xr - xrUsed,
        yr: curVault.yr + (totalWethIn - wethRepaid),
        xd: curVault.xd + (dxOut - xrUsed),
        yd: curVault.yd - wethRepaid,
      };

      absoluteX -= dxOut;
      absoluteY += totalWethIn;

      totalLPCost += dxOut - dyIn * marketPy;
      totalFeeUSDC += feeWETH * marketPy;
      numTrades++;
      clearTime = min;
      xCur = xEnd;

      const postOffset = (1 + shift) * (xCur / x0Off) ** 2 - 1;
      const cond = checkClearing(min, postOffset);
      if (cond) { clearCondition = cond; cleared = true; break; }
      if (feeFrac <= V5_CONFIG.baseFee) break;
    }
    // Post-loop clearing check
    if (!cleared && numTrades > 0) {
      const finalOffset = (1 + shift) * (xCur / x0Off) ** 2 - 1;
      const cond = checkClearing(clearTime, Math.max(finalOffset, 0));
      if (cond) { clearCondition = cond; cleared = true; }
    }
  }

  const exposureAfter = computeExposure(curVault, ethPrice);

  return {
    triggered: true, direction, triggerType, shiftBps, startFeeBps,
    exposureBefore, exposureAfter,
    lpCostUSDC: totalLPCost,
    feeRevenueUSDC: totalFeeUSDC,
    netCostUSDC: totalLPCost - totalFeeUSDC,
    numTrades, clearingTimeMin: clearTime, clearCondition, cleared,
    finalVault: curVault,
  };
}

// ─── Strategy results ───────────────────────────────────────────────

interface StrategyResult {
  name: string;
  finalNAV: number;
  initialNAV: number;
  totalAuctions: number;
  totalNetCost: number;
  totalLPCost: number;
  totalFeeRevenue: number;
  maxExposurePct: number;
  avgExposurePct: number;
  auctionsCleared: number;
  auctionsStalled: number;
  avgShiftBps: number;
  avgClearTimeMin: number;
  minHealth: number;
  triggerCounts: Record<string, number>;
  clearCounts: Record<string, number>;
  finalVault: VaultState;
  log: string[];
}

// ─── V5 Strategy ────────────────────────────────────────────────────

interface V5Overrides {
  exposureTriggerThreshold?: number;
}

interface NavSnapshot { day: number; nav: number; }

function runV5Strategy(pricePath: number[], overrides?: V5Overrides): StrategyResult & { navSnapshots: NavSnapshot[] } {
  const eqTrigger = overrides?.exposureTriggerThreshold ?? V5_CONFIG.exposureTriggerThreshold;

  const n = SIM_CONFIG.durationDays * SIM_CONFIG.stepsPerDay;
  let pool = initPool();
  const initialNAV = computeNAV(pool.vault, pool.params.py);
  const log: string[] = [];
  const navSnapshots: NavSnapshot[] = [{ day: 0, nav: initialNAV }];

  let totalAuctions = 0;
  let totalNetCost = 0;
  let totalLPCost = 0;
  let totalFeeRevenue = 0;
  let maxExposurePct = 0;
  let sumExposurePct = 0;
  let auctionsCleared = 0;
  let auctionsStalled = 0;
  let sumShiftBps = 0;
  let sumClearTime = 0;
  let minHealth = 10;
  const triggerCounts: Record<string, number> = { equity: 0, debt: 0 };
  const clearCounts: Record<string, number> = {};

  let approxNav = initialNAV;

  for (let i = 1; i <= n; i++) {
    const t = i / SIM_CONFIG.stepsPerDay;
    const extPrice = pricePath[i];
    const ethPrice = 1 / extPrice;

    // Arb to external price
    const arbed = arbToPrice(pool, extPrice);
    pool.curX = arbed.curX;
    pool.curY = arbed.curY;

    // Vault at current position
    const vault = vaultStateAt(pool.curX, pool.curY, pool.x0, pool.y0, pool.vault);
    const nav = computeNAV(vault, ethPrice);
    const exposure = computeExposure(vault, ethPrice);
    const exposurePct = nav > 0 ? exposure / nav : 0;

    if (exposurePct > maxExposurePct) maxExposurePct = exposurePct;
    sumExposurePct += exposurePct;

    // Health tracking
    const health = computeHealth(pool);
    if (health < minHealth) minHealth = health;

    // ── Check triggers ──

    let triggered = false;
    let triggerType: 'equity' | 'debt' = 'equity';
    let asset0Deficit = false;
    let shiftFraction = 0;

    // 1. Equity trigger
    if (V5_CONFIG.equityClearingEnabled && eqTrigger > 0 && approxNav > 0) {
      const nqDep = V5_CONFIG.quoteIsAsset0 ? vault.yr : vault.xr;
      const nqDebt = V5_CONFIG.quoteIsAsset0 ? vault.yd : vault.xd;

      let exposureAmt = 0;
      let isLong = false;
      if (nqDep > nqDebt + 1e-8) { exposureAmt = nqDep - nqDebt; isLong = true; }
      else if (nqDebt > nqDep + 1e-8) { exposureAmt = nqDebt - nqDep; isLong = false; }

      if (exposureAmt > 0) {
        const expInA0 = V5_CONFIG.quoteIsAsset0 ? exposureAmt * ethPrice : exposureAmt;
        if (expInA0 / approxNav > eqTrigger) {
          triggered = true; triggerType = 'equity';
          asset0Deficit = V5_CONFIG.quoteIsAsset0 ? isLong : !isLong;
          const eqA0 = asset0Deficit ? pool.x0 : pool.y0 * ethPrice;
          shiftFraction = eqA0 > 0 ? expInA0 / eqA0 : V5_CONFIG.shiftMagnitude;
        }
      }
    }

    // 2. Debt trigger (fallback when equityClearingEnabled=false)
    if (!triggered && !V5_CONFIG.equityClearingEnabled && eqTrigger > 0 && approxNav > 0) {
      if (vault.xd > 0 || vault.yd > 0) {
        const debtA0Def = vault.xd > 0;
        const debtInA0 = debtA0Def ? vault.xd : vault.yd * ethPrice;
        if (debtInA0 / approxNav > eqTrigger) {
          triggered = true; triggerType = 'debt';
          asset0Deficit = debtA0Def;
          const eq = debtA0Def ? pool.x0 : pool.y0;
          const rawDebt = debtA0Def ? vault.xd : vault.yd;
          shiftFraction = eq > 0 ? rawDebt / eq : V5_CONFIG.shiftMagnitude;
        }
      }
    }

    // NAV snapshot tracking (every 5 days)
    const dayNum = Math.floor(t);
    if (i > 0 && i % SIM_CONFIG.stepsPerDay === 0 && dayNum % 5 === 0 && dayNum > 0) {
      const snapVault = vaultStateAt(pool.curX, pool.curY, pool.x0, pool.y0, pool.vault);
      const snapNav = computeNAV(snapVault, ethPrice);
      navSnapshots.push({ day: dayNum, nav: snapNav });
    }

    // ── Run auction ──
    if (triggered) {
      const shift = Math.min(Math.max(shiftFraction, 0.0001), V5_CONFIG.shiftMagnitude);

      const auction = runV5Auction(
        vault,
        pool.curX, pool.curY,
        pool.params,
        ethPrice,
        shift,
        triggerType,
        asset0Deficit,
      );

      if (auction.triggered && auction.numTrades > 0) {
        totalAuctions++;
        totalNetCost += auction.netCostUSDC;
        totalLPCost += auction.lpCostUSDC;
        totalFeeRevenue += auction.feeRevenueUSDC;
        sumShiftBps += auction.shiftBps;
        sumClearTime += auction.clearingTimeMin;
        triggerCounts[triggerType]++;
        clearCounts[auction.clearCondition] = (clearCounts[auction.clearCondition] || 0) + 1;

        if (auction.cleared) auctionsCleared++;
        else auctionsStalled++;

        log.push(
          `Day ${t.toFixed(1).padStart(5)} ETH=$${ethPrice.toFixed(0)} ` +
          `[${triggerType}] ${auction.direction} ` +
          `shift=${auction.shiftBps}bps fee=${auction.startFeeBps}bps ` +
          `trades=${auction.numTrades} t=${auction.clearingTimeMin}min ` +
          `lp=$${auction.lpCostUSDC.toFixed(2)} fees=$${auction.feeRevenueUSDC.toFixed(2)} ` +
          `net=$${auction.netCostUSDC.toFixed(2)} ` +
          `${auction.cleared ? auction.clearCondition.toUpperCase() : 'STALLED'} ` +
          `exp: ${(auction.exposureBefore).toFixed(0)}->${(auction.exposureAfter).toFixed(0)} ` +
          `h=${computeHealth(pool).toFixed(2)}`
        );

        // Only recenter if auction cleared; stalled auctions leave pool unchanged
        if (auction.cleared) {
          pool = recenterPool(auction.finalVault, ethPrice);
          approxNav = computeNAV(auction.finalVault, ethPrice);
        }
        // Stalled: vault changes from partial trades are small, pool persists as-is
      }
    }
  }

  const finalVault = vaultStateAt(pool.curX, pool.curY, pool.x0, pool.y0, pool.vault);
  const finalNAV = computeNAV(finalVault, pool.params.py);

  // Final snapshot at day 30 (avoid duplicate if last snapshot was already day 30)
  const lastSnap = navSnapshots[navSnapshots.length - 1];
  if (!lastSnap || lastSnap.day !== SIM_CONFIG.durationDays) {
    navSnapshots.push({ day: SIM_CONFIG.durationDays, nav: finalNAV });
  }

  return {
    name: 'V5 (autonomous)',
    finalNAV, initialNAV, totalAuctions,
    totalNetCost, totalLPCost, totalFeeRevenue,
    maxExposurePct, avgExposurePct: sumExposurePct / n,
    auctionsCleared, auctionsStalled,
    avgShiftBps: totalAuctions > 0 ? sumShiftBps / totalAuctions : 0,
    avgClearTimeMin: totalAuctions > 0 ? sumClearTime / totalAuctions : 0,
    minHealth,
    triggerCounts, clearCounts,
    finalVault, log,
    navSnapshots,
  };
}

// ─── V3 Strategy ────────────────────────────────────────────────────

function runV3Strategy(pricePath: number[]): StrategyResult {
  const n = SIM_CONFIG.durationDays * SIM_CONFIG.stepsPerDay;
  let pool = initPool();
  const initialNAV = computeNAV(pool.vault, pool.params.py);
  const log: string[] = [];

  let totalAuctions = 0;
  let totalNetCost = 0;
  let totalLPCost = 0;
  let totalFeeRevenue = 0;
  let maxExposurePct = 0;
  let sumExposurePct = 0;
  let auctionsCleared = 0;
  let auctionsStalled = 0;
  let sumClearTime = 0;
  let minHealth = 10;

  for (let i = 1; i <= n; i++) {
    const extPrice = pricePath[i];
    const ethPrice = 1 / extPrice;

    const arbed = arbToPrice(pool, extPrice);
    pool.curX = arbed.curX;
    pool.curY = arbed.curY;

    const vault = vaultStateAt(pool.curX, pool.curY, pool.x0, pool.y0, pool.vault);
    const nav = computeNAV(vault, ethPrice);
    const exposure = computeExposure(vault, ethPrice);
    const exposurePct = nav > 0 ? exposure / nav : 0;
    if (exposurePct > maxExposurePct) maxExposurePct = exposurePct;
    sumExposurePct += exposurePct;

    const health = computeHealth(pool);
    if (health < minHealth) minHealth = health;

    if (exposurePct > V3_CONFIG.triggerPct) {
      const newPy = 1 / extPrice;
      // Note: do NOT set pool.vault = vault here — causes delta double-counting (same as V5 fix #4)
      const delta = V3_CONFIG.auctionDeltaBps / 10000;
      const wethNet = (vault.yr - vault.yd) * ethPrice;
      const attractUsdc = wethNet >= 0;
      const pyOff = attractUsdc ? newPy / (1 + delta) : newPy * (1 + delta);

      const offParams: Params = { ...pool.params, py: pyOff, xr: vault.xr, yr: vault.yr, xd: vault.xd, yd: vault.yd };
      const x0Off = computeX0Additive(offParams);
      const y0Off = computeY0Additive(offParams);

      if (x0Off >= 1 && y0Off >= 1e-8) {
        let curVault = { ...vault };
        let numTrades = 0;
        let lpCost = 0;
        let feeRev = 0;
        let cleared = false;
        let absoluteX = pool.curX;
        let absoluteY = pool.curY;
        let clearTime = 0;

        if (attractUsdc) {
          const ybOff = computeYb(y0Off, offParams.ry, offParams.cy);
          let yCur = y0Off;
          for (let min = 0; min <= V3_CONFIG.maxAuctionMinutes; min++) {
            const feeFrac = Math.max((V3_CONFIG.startFeeBps - V3_CONFIG.decayBpsPerMinute * min) / 10000, 0);
            const offset = (1 + delta) * (yCur / y0Off) ** 2 - 1;
            if (offset < 1e-8) break;
            if (offset <= feeFrac + V3_CONFIG.uniFee) { if (feeFrac <= 0) break; continue; }
            const denom = (1 - V3_CONFIG.uniFee) * (1 - feeFrac) * (1 + delta);
            if (denom <= 0) continue;
            const yEnd = Math.max(y0Off / Math.sqrt(denom), ybOff);
            if (yEnd >= yCur - 1e-8) continue;
            const dyOut = yCur - yEnd;
            const xEnd = gY(yEnd, 0, y0Off, x0Off, 1, pyOff);
            const xCurVal = (yCur >= y0Off - 1e-8) ? x0Off : gY(yCur, 0, y0Off, x0Off, 1, pyOff);
            const dxIn = xEnd - xCurVal;
            if (dxIn < 0.01) continue;
            const feeUSDC = dxIn * feeFrac / (1 - feeFrac);
            const totalUsdcIn = dxIn + feeUSDC;
            const usdcRepaid = Math.min(totalUsdcIn, curVault.xd);
            const yrUsed = Math.min(dyOut, curVault.yr);
            curVault = { xr: curVault.xr + (totalUsdcIn - usdcRepaid), yr: curVault.yr - yrUsed, xd: curVault.xd - usdcRepaid, yd: curVault.yd + (dyOut - yrUsed) };
            absoluteX += totalUsdcIn; absoluteY -= dyOut;
            lpCost += dyOut * newPy - dxIn; feeRev += feeUSDC;
            numTrades++; clearTime = min; yCur = yEnd;
            if (absoluteX >= pool.x0) { cleared = true; break; }
            if (feeFrac <= 0) break;
          }
        } else {
          const xbOff = computeXb(x0Off, offParams.rx, offParams.cx);
          let xCur = x0Off;
          for (let min = 0; min <= V3_CONFIG.maxAuctionMinutes; min++) {
            const feeFrac = Math.max((V3_CONFIG.startFeeBps - V3_CONFIG.decayBpsPerMinute * min) / 10000, 0);
            const offset = (1 + delta) * (xCur / x0Off) ** 2 - 1;
            if (offset < 1e-8) break;
            if (offset <= feeFrac + V3_CONFIG.uniFee) { if (feeFrac <= 0) break; continue; }
            const denom = (1 - V3_CONFIG.uniFee) * (1 - feeFrac) * (1 + delta);
            if (denom <= 0) continue;
            const xEnd = Math.max(x0Off / Math.sqrt(denom), xbOff);
            if (xEnd >= xCur - 0.01) continue;
            const dxOut = xCur - xEnd;
            const yEnd = fX(xEnd, 0, x0Off, y0Off, 1, pyOff);
            const yCurVal = (xCur >= x0Off - 0.01) ? y0Off : fX(xCur, 0, x0Off, y0Off, 1, pyOff);
            const dyIn = yEnd - yCurVal;
            if (dyIn < 1e-12) continue;
            const feeWETH = dyIn * feeFrac / (1 - feeFrac);
            const totalWethIn = dyIn + feeWETH;
            const wethRepaid = Math.min(totalWethIn, curVault.yd);
            const xrUsed = Math.min(dxOut, curVault.xr);
            curVault = { xr: curVault.xr - xrUsed, yr: curVault.yr + (totalWethIn - wethRepaid), xd: curVault.xd + (dxOut - xrUsed), yd: curVault.yd - wethRepaid };
            absoluteX -= dxOut; absoluteY += totalWethIn;
            lpCost += dxOut - dyIn * newPy; feeRev += feeWETH * newPy;
            numTrades++; clearTime = min; xCur = xEnd;
            if (absoluteY >= pool.y0) { cleared = true; break; }
            if (feeFrac <= 0) break;
          }
        }

        if (numTrades > 0) {
          totalAuctions++;
          totalNetCost += lpCost - feeRev;
          totalLPCost += lpCost;
          totalFeeRevenue += feeRev;
          sumClearTime += clearTime;
          if (cleared) auctionsCleared++; else auctionsStalled++;
          pool = recenterPool(curVault, newPy);
        }
      }
    }
  }

  const finalVault = vaultStateAt(pool.curX, pool.curY, pool.x0, pool.y0, pool.vault);
  const finalNAV = computeNAV(finalVault, pool.params.py);

  return {
    name: 'V3 (fixed 100bps)',
    finalNAV, initialNAV, totalAuctions,
    totalNetCost, totalLPCost, totalFeeRevenue,
    maxExposurePct, avgExposurePct: sumExposurePct / n,
    auctionsCleared, auctionsStalled,
    avgShiftBps: V3_CONFIG.auctionDeltaBps,
    avgClearTimeMin: totalAuctions > 0 ? sumClearTime / totalAuctions : 0,
    minHealth,
    triggerCounts: {}, clearCounts: {},
    finalVault, log: [],
  };
}

// ─── Static Strategy ────────────────────────────────────────────────

function runStaticStrategy(pricePath: number[]): StrategyResult {
  const n = SIM_CONFIG.durationDays * SIM_CONFIG.stepsPerDay;
  let pool = initPool();
  const initialNAV = computeNAV(pool.vault, pool.params.py);
  let maxExposurePct = 0;
  let sumExposurePct = 0;
  let minHealth = 10;

  for (let i = 1; i <= n; i++) {
    const extPrice = pricePath[i];
    const ethPrice = 1 / extPrice;
    const arbed = arbToPrice(pool, extPrice);
    pool.curX = arbed.curX;
    pool.curY = arbed.curY;

    const vault = vaultStateAt(pool.curX, pool.curY, pool.x0, pool.y0, pool.vault);
    const nav = computeNAV(vault, ethPrice);
    const exposure = computeExposure(vault, ethPrice);
    const exposurePct = nav > 0 ? exposure / nav : 0;
    if (exposurePct > maxExposurePct) maxExposurePct = exposurePct;
    sumExposurePct += exposurePct;

    const health = computeHealth(pool);
    if (health < minHealth) minHealth = health;

    if (i % 24 === 0) {
      pool = recenterPool(vault, 1 / extPrice);
    }
  }

  const finalVault = vaultStateAt(pool.curX, pool.curY, pool.x0, pool.y0, pool.vault);
  const finalNAV = computeNAV(finalVault, pool.params.py);

  return {
    name: 'Static (daily recenter)',
    finalNAV, initialNAV, totalAuctions: 0,
    totalNetCost: 0, totalLPCost: 0, totalFeeRevenue: 0,
    maxExposurePct, avgExposurePct: sumExposurePct / n,
    auctionsCleared: 0, auctionsStalled: 0, avgShiftBps: 0,
    avgClearTimeMin: 0, minHealth,
    triggerCounts: {}, clearCounts: {},
    finalVault, log: [],
  };
}

// ─── Output ─────────────────────────────────────────────────────────

function printResults(result: StrategyResult) {
  const navChange = ((result.finalNAV / result.initialNAV - 1) * 100).toFixed(1).padStart(7);
  const costParts = result.totalAuctions > 0
    ? `  lp=$${result.totalLPCost.toFixed(0)} fees=$${result.totalFeeRevenue.toFixed(0)} net=$${result.totalNetCost.toFixed(0)}`
    : '';
  const clearInfo = result.totalAuctions > 0
    ? `  cleared=${result.auctionsCleared}/${result.totalAuctions}` +
      (result.auctionsStalled > 0 ? ` stall=${result.auctionsStalled}` : '') +
      `  avgShift=${result.avgShiftBps.toFixed(0)}bps  avgClear=${result.avgClearTimeMin.toFixed(0)}min`
    : '';
  console.log(
    `  ${result.name.padEnd(25)} NAV: $${result.initialNAV.toFixed(0)} -> $${result.finalNAV.toFixed(0).padStart(6)} (${navChange}%)` +
    `  auctions=${String(result.totalAuctions).padStart(3)}${costParts}` +
    `  maxExp=${(result.maxExposurePct * 100).toFixed(0).padStart(4)}%  avgExp=${(result.avgExposurePct * 100).toFixed(0).padStart(4)}%` +
    `  minH=${result.minHealth.toFixed(2)}` +
    clearInfo
  );
}

function printV5Details(result: StrategyResult) {
  const { triggerCounts: tc, clearCounts: cc } = result;
  if (Object.keys(tc).length > 0) {
    console.log(`  triggers: equity=${tc.equity||0} debt=${tc.debt||0}`);
  }
  if (Object.keys(cc).length > 0) {
    const entries = Object.entries(cc).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`  clearing: ${entries}`);
  }
  if (result.totalAuctions > 0) {
    const avgNet = result.totalNetCost / result.totalAuctions;
    console.log(`  avg auction: net=$${avgNet.toFixed(2)}/auction, lp=$${(result.totalLPCost/result.totalAuctions).toFixed(2)}, fees=$${(result.totalFeeRevenue/result.totalAuctions).toFixed(2)}`);
  }
}

function runAtVol(vol: number, showLog: boolean = false) {
  SIM_CONFIG.vol = vol;
  const pEquil = BASE_PARAMS.px / BASE_PARAMS.py;
  const pricePath = generatePricePath(pEquil);
  const ethPriceStart = 1 / pricePath[0];
  const ethPriceEnd = 1 / pricePath[pricePath.length - 1];

  console.log(`\n--- Vol=${(vol * 100).toFixed(0)}%, ${SIM_CONFIG.durationDays}d, ETH $${ethPriceStart.toFixed(0)}->${ethPriceEnd.toFixed(0)} ---`);

  const v5 = runV5Strategy(pricePath);
  const v3 = runV3Strategy(pricePath);
  const stat = runStaticStrategy(pricePath);

  printResults(v5);
  printResults(v3);
  printResults(stat);
  printV5Details(v5);

  if (showLog && v5.log.length > 0) {
    console.log(`\n  V5 log (first 30):`);
    for (const line of v5.log.slice(0, 30)) console.log(`    ${line}`);
    if (v5.log.length > 30) console.log(`    ... (${v5.log.length - 30} more)`);
  }
}

function run() {
  console.log('=== V5 Autonomous Hook Simulation (v2) ===');
  console.log(`Pool: USDC/WETH, rx=ry=${BASE_PARAMS.rx}, real=$${BASE_PARAMS.xr}`);
  console.log(`Equity trigger: ${V5_CONFIG.exposureTriggerThreshold * 100}% NAV`);
  console.log(`Max shift: ${V5_CONFIG.shiftMagnitude * 10000}bps | Start fee: 1.5x shift | Decay: ${V5_CONFIG.decayBpsPerMinute.toFixed(1)}bps/min`);
  console.log(`Clear: ${V5_CONFIG.clearThreshold * 10000}bps convergence | Min auction: ${V5_CONFIG.minAuctionMinutes}min`);
  console.log(`Cost = LP cost (price improvement to arbers) − fee revenue`);

  for (const vol of [0.30, 0.45, 0.60, 0.90]) {
    runAtVol(vol, vol === 0.60);
  }
}

// ─── Sensitivity Analysis ────────────────────────────────────────────

function runSensitivityAnalysis() {
  console.log('\n\n========================================');
  console.log('=== SENSITIVITY ANALYSIS ===');
  console.log('========================================');

  // Use 60% vol for all sensitivity analysis
  SIM_CONFIG.vol = 0.60;
  const pEquil = BASE_PARAMS.px / BASE_PARAMS.py;
  const pricePath = generatePricePath(pEquil);

  // ── 1. NAV Trajectory ──
  console.log('\n--- 1. NAV Trajectory (V5, 60% vol) ---');
  const v5baseline = runV5Strategy(pricePath);
  console.log('  Day  |    NAV ($) | NAV change');
  console.log('  -----|-----------|----------');
  for (const snap of v5baseline.navSnapshots) {
    const pct = ((snap.nav / v5baseline.initialNAV - 1) * 100).toFixed(1);
    console.log(`  ${String(snap.day).padStart(4)} | ${snap.nav.toFixed(0).padStart(9)} | ${pct.padStart(7)}%`);
  }

  // ── 2. Trigger Threshold Sweep ──
  console.log('\n--- 2. Equity Trigger Threshold Sweep (V5, 60% vol) ---');
  console.log('  Same price path for fair comparison.');
  console.log('');
  console.log('  Threshold | Final NAV |  NAV %  | Auctions | Avg Exp% | Min Health | Cleared/Stalled');
  console.log('  ----------|-----------|---------|----------|----------|------------|----------------');

  const thresholds = [0.25, 0.50, 0.75, 1.00, 2.00, 5.00];
  for (const thresh of thresholds) {
    const result = runV5Strategy(pricePath, { exposureTriggerThreshold: thresh });
    const navPct = ((result.finalNAV / result.initialNAV - 1) * 100).toFixed(1);
    const avgExp = (result.avgExposurePct * 100).toFixed(0);
    const minH = result.minHealth.toFixed(2);
    const clearStall = `${result.auctionsCleared}/${result.auctionsStalled}`;
    console.log(
      `  ${thresh.toFixed(2).padStart(9)} | ` +
      `${('$' + result.finalNAV.toFixed(0)).padStart(9)} | ` +
      `${navPct.padStart(6)}% | ` +
      `${String(result.totalAuctions).padStart(8)} | ` +
      `${avgExp.padStart(7)}% | ` +
      `${minH.padStart(10)} | ` +
      `${clearStall}`
    );
  }

  // ── 3. Theoretical IL Check ──
  console.log('\n--- 3. Theoretical IL vs Simulated ---');

  const x0 = computeX0Additive(BASE_PARAMS);
  const y0 = computeY0Additive(BASE_PARAMS);
  const ethStart = BASE_PARAMS.py;
  const ethEnd = 1 / pricePath[pricePath.length - 1];
  const k = ethEnd / ethStart;  // price ratio

  // Effective leverage = pool_value / LP_equity (NOT x0/xr — both sides contribute)
  const poolValue = x0 + y0 * ethStart;
  const lpEquity = v5baseline.initialNAV;
  const leverage = poolValue / lpEquity;

  // Constant-product IL for c=0
  const poolIL = 2 * Math.sqrt(k) / (1 + k) - 1;
  const leveragedIL = leverage * poolIL;

  // Single-period theoretical (no recentering)
  const theoreticalNAV = v5baseline.initialNAV * (1 + leveragedIL);

  const nRecenters = v5baseline.auctionsCleared;

  console.log(`  Pool value: x0=${x0.toFixed(0)} + y0×p=${(y0 * ethStart).toFixed(0)} = $${poolValue.toFixed(0)}`);
  console.log(`  LP equity: $${lpEquity.toFixed(0)}`);
  console.log(`  Effective leverage: pool_value/equity = ${leverage.toFixed(0)}x`);
  console.log(`  ETH price: $${ethStart.toFixed(0)} -> $${ethEnd.toFixed(0)} (k = ${k.toFixed(4)})`);
  console.log(`  Pool IL (c=0, no leverage): ${(poolIL * 100).toFixed(4)}%`);
  console.log(`  Single-period leveraged IL (no recenter): ${(leveragedIL * 100).toFixed(1)}% -> NAV $${theoreticalNAV.toFixed(0)}`);

  // The key insight: IL is path-dependent. For a random walk, each recenter
  // crystallizes IL from variance, not from net price change. The endpoint
  // k doesn't matter much — what matters is cumulative variance consumed.
  //
  // For constant-product with c=0, IL ≈ -σ²/8 per period (second-order).
  // With N recenters over T days: dt = T/(365*N), var = σ²·dt per period.
  // Compounded: NAV_final = NAV_0 · (1 + L·(-σ²dt/8))^N
  //
  // This is the "variance drain" — the mechanism that destroys leveraged LP NAV
  // even when price ends up where it started.

  const vol = SIM_CONFIG.vol;
  const dtPerAuction = SIM_CONFIG.durationDays / (365 * Math.max(nRecenters, 1));
  const varPerAuction = vol * vol * dtPerAuction;
  const expectedILPerAuction = -varPerAuction / 8;
  const expectedCompoundedNAV = v5baseline.initialNAV * Math.pow(1 + leverage * expectedILPerAuction, nRecenters);

  console.log(`\n  Variance-drain model (path-dependent IL):`);
  console.log(`    N recenters: ${nRecenters}`);
  console.log(`    dt per auction: ${(dtPerAuction * 365).toFixed(4)} days = ${(dtPerAuction * 365 * 24 * 60).toFixed(1)} min`);
  console.log(`    σ²·dt per auction: ${(varPerAuction * 10000).toFixed(2)} bps²`);
  console.log(`    E[IL] per auction (pool, c=0): ${(expectedILPerAuction * 10000).toFixed(4)} bps`);
  console.log(`    E[IL] per auction (leveraged): ${(leverage * expectedILPerAuction * 10000).toFixed(2)} bps`);
  console.log(`    Predicted compounded NAV: $${expectedCompoundedNAV.toFixed(0)}`);
  console.log(`    Simulated V5 NAV:         $${v5baseline.finalNAV.toFixed(0)}`);
  console.log(`    Auction net cost:         $${v5baseline.totalNetCost.toFixed(0)} (${(v5baseline.totalNetCost / v5baseline.initialNAV * 100).toFixed(1)}% of initial NAV)`);
  console.log(`    NAV loss from IL alone:   $${(v5baseline.initialNAV - v5baseline.finalNAV - v5baseline.totalNetCost).toFixed(0)}`);

  // Cross-check: total variance consumed = σ² · T/365
  const totalVar = vol * vol * SIM_CONFIG.durationDays / 365;
  const singleShotIL = -totalVar / 8;
  console.log(`\n  Cross-check:`);
  console.log(`    Total σ²·T: ${(totalVar * 100).toFixed(2)}%`);
  console.log(`    Single-shot IL (no recenter, pool): ${(singleShotIL * 100).toFixed(4)}%`);
  console.log(`    Single-shot leveraged: ${(leverage * singleShotIL * 100).toFixed(1)}%`);
  console.log(`    Key: compounding ${nRecenters} small losses >> single large loss`);
  console.log(`    Ratio: compounded/single-shot = ${(1 - expectedCompoundedNAV / v5baseline.initialNAV).toFixed(4)} / ${(-leverage * singleShotIL).toFixed(4)} = ${((1 - expectedCompoundedNAV / v5baseline.initialNAV) / (-leverage * singleShotIL)).toFixed(1)}x`);
}

run();
runSensitivityAnalysis();
