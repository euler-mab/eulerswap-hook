/**
 * V6 Negative Fee / Attract-Clearing Simulation
 *
 * Tests a strategy where exposure is cleared primarily through fee incentives
 * rather than auction-based curve shifts:
 *
 *   1. Normal swaps: arb to market price each hour (same as V5)
 *   2. Fee asymmetry: negative fees (rebates) for exposure-reducing flow,
 *      high capture fees for exposure-increasing flow
 *   3. Retail flow model: independent organic volume ($X/day), direction-biased
 *      by attract fee. NOT proportional to arb volume.
 *   4. Auction as last resort: only fires at very high exposure (health danger)
 *   5. Bare recenter: when health is critical, recenter without auction
 *
 * Fee model:
 *   attract fee = baseFee - attractScale * (exposure / maxExposure)
 *   Can go negative when exposure is high enough.
 *   capture fee = baseFee + captureRate * |priceOffset|
 *
 * Retail flow model:
 *   Each hourly step, after arb, a retail swap arrives in the exposure-reducing
 *   direction. Size = retailVolumeFraction * |arb trade size|.
 *   The negative fee makes this the cheapest venue for that direction.
 *
 * Usage: npx tsx scripts/sim-v6-negfee.ts
 */
import {
  type Params,
  computeX0Additive, computeY0Additive,
  computeXb, computeYb,
  computeHX, computeHY,
  fX, gY,
} from '../src/lib/math';
import { mulberry32, boxMuller, solveXForPrice, solveYForPrice } from '../src/lib/simulate';

// ─── Pool config (same as V5) ───────────────────────────────────────

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

// ─── V6 config ──────────────────────────────────────────────────────

const V6_CONFIG = {
  // Fee params
  baseFee: 0.0005,              // 5 bps base
  maxCaptureFee: 0.05,          // 500 bps max capture
  captureRate: 0.5,             // capture multiplier on price offset
  externalFee: 0.0005,          // 5 bps (competitor venue)

  // Negative fee params
  attractScale: 0.0030,         // max 30 bps rebate at full exposure
  maxExposureFrac: 1.0,         // exposure / NAV at which attract reaches max negative

  // Retail flow model — independent of arb volume
  // Based on: pool captures some share of organic USDC/WETH volume
  // Uniswap USDC/WETH 0.05% does ~$200M/day. A eulerswap pool might capture 0.1-1%.
  // At 0.1%: $200k/day. Split ~50/50 direction. The attract fee biases routing.
  retailBaseVolumePerDay: 200_000, // $200k/day total routable volume
  retailDirectionBias: 0.70,       // 70% of retail goes in attract direction (routing effect)
  retailFeeMultiplier: 1.0,        // retail pays full fee (positive or negative)

  // Safety backstop
  auctionTriggerExposure: 0.70, // 70% of NAV — last resort
  healthRecenterThreshold: 1.10, // emergency recenter at h < 1.1

  // Auction params (same as V5, for backstop only)
  shiftMagnitude: 0.0108,
  decayBpsPerMinute: 21.5,
  clearThreshold: 0.0010,
  minAuctionMinutes: 1,
  maxAuctionMinutes: 120,

  quoteIsAsset0: true,
};

// ─── Shared utilities ───────────────────────────────────────────────

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

function recenterPool(vault: VaultState, newPy: number, overrideRx?: number): PoolState {
  const params: Params = { ...BASE_PARAMS, py: newPy, xr: vault.xr, yr: vault.yr, xd: vault.xd, yd: vault.yd };
  if (overrideRx !== undefined) { params.rx = overrideRx; params.ry = overrideRx; }
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

// ─── V6: Negative fee computation ───────────────────────────────────

/**
 * Compute the fee for a swap in the given direction.
 * Returns: fee fraction (can be negative = rebate).
 *
 * attracting direction (reduces exposure): baseFee - attractScale * (exp/nav)
 * capturing direction (increases exposure): baseFee + captureRate * |priceOffset|
 */
function computeV6Fee(
  exposureFrac: number,     // exposure / NAV
  isExposureReducing: boolean,
  priceOffset: number,       // |marginalPrice - oraclePrice| / oraclePrice
): number {
  if (isExposureReducing) {
    const scale = Math.min(exposureFrac / V6_CONFIG.maxExposureFrac, 1.0);
    return V6_CONFIG.baseFee - V6_CONFIG.attractScale * scale;
    // At 100% exposure: 5 - 30 = -25 bps (25 bps rebate)
    // At 50% exposure: 5 - 15 = -10 bps (10 bps rebate)
    // At 17% exposure: 5 - 5 = 0 bps (break-even)
    // Below 17%: positive fee (normal revenue)
  } else {
    return Math.min(
      V6_CONFIG.baseFee + V6_CONFIG.captureRate * priceOffset,
      V6_CONFIG.maxCaptureFee,
    );
  }
}

// ─── V6: Simulate retail swap ───────────────────────────────────────

/**
 * Simulate retail swaps for this hourly step.
 * Volume is independent of arb — based on pool's share of organic USDC/WETH flow.
 * Direction is biased toward exposure-reducing by the attract fee.
 *
 * Returns the vault after retail trades and total fee revenue (can be negative).
 */
function simulateRetailSwap(
  pool: PoolState,
  vault: VaultState,
  _arbTradeSize: number,    // unused — retail is independent
  ethPrice: number,
  exposureFrac: number,
): { newVault: VaultState; feeRevenue: number; retailVolume: number; newCurX: number; newCurY: number } {
  // Volume per hourly step
  const volumePerStep = V6_CONFIG.retailBaseVolumePerDay / SIM_CONFIG.stepsPerDay;
  // Split: bias% goes in attract (exposure-reducing) direction
  const attractVolume = volumePerStep * V6_CONFIG.retailDirectionBias;
  const captureVolume = volumePerStep * (1 - V6_CONFIG.retailDirectionBias);

  if (volumePerStep < 1) return { newVault: vault, feeRevenue: 0, retailVolume: 0, newCurX: pool.curX, newCurY: pool.curY };

  // Determine exposure-reducing direction
  const wethNet = vault.yr - vault.yd;  // positive = long WETH
  // Attract = exposure-reducing. If long WETH, attract = sell WETH to pool (curY increases toward y0)
  // Capture = exposure-increasing (opposite direction)

  const pEquil = pool.params.px / pool.params.py;
  const extPrice = 1 / ethPrice;
  const priceOffset = Math.abs(extPrice - pEquil) / pEquil;

  const attractFee = computeV6Fee(exposureFrac, true, priceOffset);
  const captureFee = computeV6Fee(exposureFrac, false, priceOffset);

  const { x0, y0, params } = pool;
  let curX = pool.curX;
  let curY = pool.curY;
  let totalVolume = 0;
  let totalFeeRevenue = 0;
  let newVault = { ...vault };

  // Helper: execute a USDC-in swap (USDC → WETH). Moves curX up, curY down.
  function doUsdcInSwap(usdcAmount: number, fee: number) {
    const xb = computeXb(x0, params.rx, params.cx);
    const newX = Math.min(curX + usdcAmount, x0);  // toward equilibrium
    if (newX <= curX + 0.01) return;
    const dx = newX - curX;
    const yBefore = (curX >= x0 - 0.01) ? y0 : fX(curX, 0, x0, y0, 1, params.py);
    const yAfter = fX(newX, 0, x0, y0, 1, params.py);
    const dyOut = yBefore - yAfter;
    if (dyOut < 1e-10) return;

    totalFeeRevenue += dx * fee;  // can be negative
    totalVolume += dx;

    const yrUsed = Math.min(dyOut, newVault.yr);
    const usdcRepaid = Math.min(dx, newVault.xd);
    newVault = {
      xr: newVault.xr + (dx - usdcRepaid),
      yr: newVault.yr - yrUsed,
      xd: newVault.xd - usdcRepaid,
      yd: newVault.yd + (dyOut - yrUsed),
    };
    curX = newX;
    curY = yAfter;
  }

  // Helper: execute a WETH-in swap (WETH → USDC). Moves curY up, curX down.
  function doWethInSwap(usdcEquivAmount: number, fee: number) {
    const dyTarget = usdcEquivAmount / ethPrice;
    const newY = Math.min(curY + dyTarget, y0);  // toward equilibrium
    if (newY <= curY + 1e-10) return;
    const dy = newY - curY;
    const xBefore = (curY >= y0 - 1e-8) ? x0 : gY(curY, 0, y0, x0, 1, params.py);
    const xAfter = gY(newY, 0, y0, x0, 1, params.py);
    const dxOut = xBefore - xAfter;
    if (dxOut < 0.01) return;

    totalFeeRevenue += dxOut * fee;  // can be negative
    totalVolume += dxOut;

    const xrUsed = Math.min(dxOut, newVault.xr);
    const wethRepaid = Math.min(dy, newVault.yd);
    newVault = {
      xr: newVault.xr - xrUsed,
      yr: newVault.yr + (dy - wethRepaid),
      xd: newVault.xd + (dxOut - xrUsed),
      yd: newVault.yd - wethRepaid,
    };
    curX = xAfter;
    curY = newY;
  }

  if (wethNet > 0) {
    // Long WETH — attract = WETH-in (reduces WETH exposure), capture = USDC-in
    doWethInSwap(attractVolume, attractFee);
    doUsdcInSwap(captureVolume, captureFee);
  } else if (wethNet < 0) {
    // Short WETH — attract = USDC-in (reduces USDC exposure), capture = WETH-in
    doUsdcInSwap(attractVolume, attractFee);
    doWethInSwap(captureVolume, captureFee);
  } else {
    // No exposure — split evenly, both at baseFee
    doUsdcInSwap(volumePerStep / 2, V6_CONFIG.baseFee);
    doWethInSwap(volumePerStep / 2, V6_CONFIG.baseFee);
  }

  return { newVault, feeRevenue: totalFeeRevenue, retailVolume: totalVolume, newCurX: curX, newCurY: curY };
}

// ─── V6 Strategy ────────────────────────────────────────────────────

interface V6Result {
  name: string;
  finalNAV: number;
  initialNAV: number;
  totalRecenters: number;
  totalAuctions: number;
  bareRecenters: number;
  totalFeeRevenue: number;     // from arb swaps (normal fees)
  totalRetailFeeRevenue: number; // from retail (can be negative = rebates paid)
  totalRetailVolume: number;
  totalArbVolume: number;
  totalAuctionCost: number;
  maxExposurePct: number;
  avgExposurePct: number;
  minHealth: number;
  log: string[];
  navSnapshots: { day: number; nav: number }[];
}

function runV6Strategy(pricePath: number[], overrides?: {
  attractScale?: number;
  retailBaseVolumePerDay?: number;
  retailDirectionBias?: number;
  auctionTriggerExposure?: number;
  overrideRx?: number;
}): V6Result {
  const attractScale = overrides?.attractScale ?? V6_CONFIG.attractScale;
  const retailVol = overrides?.retailBaseVolumePerDay ?? V6_CONFIG.retailBaseVolumePerDay;
  const retailBias = overrides?.retailDirectionBias ?? V6_CONFIG.retailDirectionBias;
  const auctionTrigger = overrides?.auctionTriggerExposure ?? V6_CONFIG.auctionTriggerExposure;
  const rx = overrides?.overrideRx;

  // Temporarily override config
  const origAttractScale = V6_CONFIG.attractScale;
  const origRetailVol = V6_CONFIG.retailBaseVolumePerDay;
  const origRetailBias = V6_CONFIG.retailDirectionBias;
  V6_CONFIG.attractScale = attractScale;
  V6_CONFIG.retailBaseVolumePerDay = retailVol;
  V6_CONFIG.retailDirectionBias = retailBias;

  const n = SIM_CONFIG.durationDays * SIM_CONFIG.stepsPerDay;
  let pool = initPool(rx);
  const initialNAV = computeNAV(pool.vault, pool.params.py);
  const log: string[] = [];
  const navSnapshots: { day: number; nav: number }[] = [{ day: 0, nav: initialNAV }];

  let totalRecenters = 0;
  let totalAuctions = 0;
  let bareRecenters = 0;
  let totalFeeRevenue = 0;
  let totalRetailFeeRevenue = 0;
  let totalRetailVolume = 0;
  let totalArbVolume = 0;
  let totalAuctionCost = 0;
  let maxExposurePct = 0;
  let sumExposurePct = 0;
  let minHealth = 10;
  let approxNav = initialNAV;

  for (let i = 1; i <= n; i++) {
    const t = i / SIM_CONFIG.stepsPerDay;
    const extPrice = pricePath[i];
    const ethPrice = 1 / extPrice;

    // 1. Arb to market price
    const preArb = { curX: pool.curX, curY: pool.curY };
    const arbed = arbToPrice(pool, extPrice);
    pool.curX = arbed.curX;
    pool.curY = arbed.curY;

    // Compute arb trade size in USDC terms
    const arbDx = Math.abs(pool.curX - preArb.curX);
    const arbDy = Math.abs(pool.curY - preArb.curY);
    const arbVolume = Math.max(arbDx, arbDy * ethPrice);
    totalArbVolume += arbVolume;

    // Fee from arb swap (capture side — arb increases exposure)
    const pEquil = pool.params.px / pool.params.py;
    const priceOffset = Math.abs(extPrice - pEquil) / pEquil;

    // Vault state after arb
    let vault = vaultStateAt(pool.curX, pool.curY, pool.x0, pool.y0, pool.vault);
    let nav = computeNAV(vault, ethPrice);
    let exposure = computeExposure(vault, ethPrice);
    let exposurePct = nav > 0 ? exposure / nav : 0;

    // Arb fee revenue (capture fee on exposure-increasing arb flow)
    if (arbVolume > 0.01) {
      const capFee = computeV6Fee(exposurePct, false, priceOffset);
      totalFeeRevenue += arbVolume * capFee;
    }

    // 2. Simulate retail flow (exposure-reducing direction)
    if (retailVol > 0) {
      const retail = simulateRetailSwap(pool, vault, arbVolume, ethPrice, exposurePct);
      vault = retail.newVault;
      pool.curX = retail.newCurX;
      pool.curY = retail.newCurY;
      totalRetailFeeRevenue += retail.feeRevenue;
      totalRetailVolume += retail.retailVolume;

      // Recompute after retail
      nav = computeNAV(vault, ethPrice);
      exposure = computeExposure(vault, ethPrice);
      exposurePct = nav > 0 ? exposure / nav : 0;
    }

    if (exposurePct > maxExposurePct) maxExposurePct = exposurePct;
    sumExposurePct += exposurePct;

    const health = computeHealth(pool);
    if (health < minHealth) minHealth = health;

    // 3. Check if we need emergency action
    let didRecenter = false;

    // Emergency bare recenter (health critical)
    if (health < V6_CONFIG.healthRecenterThreshold && health < 10) {
      pool = recenterPool(vault, ethPrice, rx);
      approxNav = computeNAV(vault, ethPrice);
      totalRecenters++;
      bareRecenters++;
      didRecenter = true;
      log.push(
        `Day ${t.toFixed(1).padStart(5)} ETH=$${ethPrice.toFixed(0)} ` +
        `BARE_RECENTER h=${health.toFixed(2)} exp=${(exposurePct * 100).toFixed(0)}% ` +
        `nav=$${nav.toFixed(0)}`
      );
    }

    // Auction backstop (high exposure but health still OK)
    if (!didRecenter && exposurePct > auctionTrigger && nav > 1) {
      // Run minimal auction (same as V5)
      const wethNet = vault.yr - vault.yd;
      const asset0Deficit = V6_CONFIG.quoteIsAsset0 ? (wethNet > 0) : (wethNet < 0);
      const shift = V6_CONFIG.shiftMagnitude;

      const pyOff = asset0Deficit
        ? ethPrice / (1 + shift)
        : ethPrice * (1 + shift);

      const offParams: Params = { ...pool.params, py: pyOff, xr: vault.xr, yr: vault.yr, xd: vault.xd, yd: vault.yd };
      if (rx !== undefined) { offParams.rx = rx; offParams.ry = rx; }
      const x0Off = computeX0Additive(offParams);
      const y0Off = computeY0Additive(offParams);

      if (x0Off >= 1 && y0Off >= 1e-8) {
        // Simplified auction: run until cleared or stalled
        let curVault = { ...vault };
        let auctionCost = 0;
        let auctionFees = 0;
        let cleared = false;
        const startFee = Math.min(shift * 1.5, V6_CONFIG.maxCaptureFee);

        if (asset0Deficit) {
          let yCur = y0Off;
          const ybOff = computeYb(y0Off, offParams.ry, offParams.cy);
          for (let min = 0; min <= V6_CONFIG.maxAuctionMinutes; min++) {
            const feeFrac = Math.max(startFee - (V6_CONFIG.decayBpsPerMinute * min) / 10000, V6_CONFIG.baseFee);
            const offset = (1 + shift) * (yCur / y0Off) ** 2 - 1;
            if (offset < 1e-8) break;
            if (offset <= feeFrac + V6_CONFIG.externalFee) { if (feeFrac <= V6_CONFIG.baseFee) break; continue; }
            const denom = (1 - V6_CONFIG.externalFee) * (1 - feeFrac) * (1 + shift);
            if (denom <= 0) continue;
            const yEnd = Math.max(y0Off / Math.sqrt(denom), ybOff);
            if (yEnd >= yCur - 1e-8) continue;
            const dyOut = yCur - yEnd;
            const xEnd = gY(yEnd, 0, y0Off, x0Off, 1, pyOff);
            const xCurVal = (yCur >= y0Off - 1e-8) ? x0Off : gY(yCur, 0, y0Off, x0Off, 1, pyOff);
            const dxIn = xEnd - xCurVal;
            if (dxIn < 0.01) continue;
            const feeUSDC = dxIn * feeFrac / (1 - feeFrac);
            auctionCost += dyOut * ethPrice - dxIn;
            auctionFees += feeUSDC;
            const usdcRepaid = Math.min(dxIn + feeUSDC, curVault.xd);
            const yrUsed = Math.min(dyOut, curVault.yr);
            curVault = { xr: curVault.xr + (dxIn + feeUSDC - usdcRepaid), yr: curVault.yr - yrUsed, xd: curVault.xd - usdcRepaid, yd: curVault.yd + (dyOut - yrUsed) };
            yCur = yEnd;
            const postOffset = (1 + shift) * (yCur / y0Off) ** 2 - 1;
            if (min >= V6_CONFIG.minAuctionMinutes && postOffset <= V6_CONFIG.clearThreshold * 1.01) { cleared = true; break; }
            if (feeFrac <= V6_CONFIG.baseFee) break;
          }
        } else {
          let xCur = x0Off;
          const xbOff = computeXb(x0Off, offParams.rx, offParams.cx);
          for (let min = 0; min <= V6_CONFIG.maxAuctionMinutes; min++) {
            const feeFrac = Math.max(startFee - (V6_CONFIG.decayBpsPerMinute * min) / 10000, V6_CONFIG.baseFee);
            const offset = (1 + shift) * (xCur / x0Off) ** 2 - 1;
            if (offset < 1e-8) break;
            if (offset <= feeFrac + V6_CONFIG.externalFee) { if (feeFrac <= V6_CONFIG.baseFee) break; continue; }
            const denom = (1 - V6_CONFIG.externalFee) * (1 - feeFrac) * (1 + shift);
            if (denom <= 0) continue;
            const xEnd = Math.max(x0Off / Math.sqrt(denom), xbOff);
            if (xEnd >= xCur - 0.01) continue;
            const dxOut = xCur - xEnd;
            const yEnd = fX(xEnd, 0, x0Off, y0Off, 1, pyOff);
            const yCurVal = (xCur >= x0Off - 0.01) ? y0Off : fX(xCur, 0, x0Off, y0Off, 1, pyOff);
            const dyIn = yEnd - yCurVal;
            if (dyIn < 1e-12) continue;
            const feeWETH = dyIn * feeFrac / (1 - feeFrac);
            auctionCost += dxOut - dyIn * ethPrice;
            auctionFees += feeWETH * ethPrice;
            const wethRepaid = Math.min(dyIn + feeWETH, curVault.yd);
            const xrUsed = Math.min(dxOut, curVault.xr);
            curVault = { xr: curVault.xr - xrUsed, yr: curVault.yr + (dyIn + feeWETH - wethRepaid), xd: curVault.xd + (dxOut - xrUsed), yd: curVault.yd - wethRepaid };
            xCur = xEnd;
            const postOffset = (1 + shift) * (xCur / x0Off) ** 2 - 1;
            if (min >= V6_CONFIG.minAuctionMinutes && postOffset <= V6_CONFIG.clearThreshold * 1.01) { cleared = true; break; }
            if (feeFrac <= V6_CONFIG.baseFee) break;
          }
        }

        totalAuctionCost += auctionCost - auctionFees;
        totalAuctions++;
        totalRecenters++;

        if (cleared) {
          vault = curVault;
        }
        pool = recenterPool(cleared ? curVault : vault, ethPrice, rx);
        approxNav = computeNAV(vault, ethPrice);

        log.push(
          `Day ${t.toFixed(1).padStart(5)} ETH=$${ethPrice.toFixed(0)} ` +
          `AUCTION ${cleared ? 'CLEARED' : 'STALLED'} exp=${(exposurePct * 100).toFixed(0)}% ` +
          `cost=$${(auctionCost - auctionFees).toFixed(2)} nav=$${nav.toFixed(0)}`
        );
      }
    }

    // NAV snapshots every 5 days
    const dayNum = Math.floor(t);
    if (i % SIM_CONFIG.stepsPerDay === 0 && dayNum % 5 === 0 && dayNum > 0) {
      const snapVault = vaultStateAt(pool.curX, pool.curY, pool.x0, pool.y0, pool.vault);
      const snapNav = computeNAV(snapVault, ethPrice);
      navSnapshots.push({ day: dayNum, nav: snapNav });
    }
  }

  const finalVault = vaultStateAt(pool.curX, pool.curY, pool.x0, pool.y0, pool.vault);
  const finalNAV = computeNAV(finalVault, pool.params.py);
  navSnapshots.push({ day: SIM_CONFIG.durationDays, nav: finalNAV });

  // Restore config
  V6_CONFIG.attractScale = origAttractScale;
  V6_CONFIG.retailBaseVolumePerDay = origRetailVol;
  V6_CONFIG.retailDirectionBias = origRetailBias;

  return {
    name: `V6 neg-fee`,
    finalNAV, initialNAV,
    totalRecenters, totalAuctions, bareRecenters,
    totalFeeRevenue, totalRetailFeeRevenue, totalRetailVolume, totalArbVolume,
    totalAuctionCost,
    maxExposurePct, avgExposurePct: sumExposurePct / n,
    minHealth, log, navSnapshots,
  };
}

// ─── Output ─────────────────────────────────────────────────────────

function printV6(r: V6Result, label?: string) {
  const navPct = ((r.finalNAV / r.initialNAV - 1) * 100).toFixed(1);
  const netFees = r.totalFeeRevenue + r.totalRetailFeeRevenue - r.totalAuctionCost;
  console.log(
    `  ${(label || r.name).padEnd(35)} ` +
    `NAV: $${r.initialNAV.toFixed(0)} -> $${r.finalNAV.toFixed(0).padStart(6)} (${navPct.padStart(7)}%)  ` +
    `recenters=${String(r.totalRecenters).padStart(3)} (auction=${r.totalAuctions} bare=${r.bareRecenters})  ` +
    `minH=${r.minHealth.toFixed(2)}`
  );
  console.log(
    `${''.padEnd(37)} ` +
    `arbFees=$${r.totalFeeRevenue.toFixed(0)}  retailFees=$${r.totalRetailFeeRevenue.toFixed(0)}  ` +
    `auctionCost=$${r.totalAuctionCost.toFixed(0)}  ` +
    `netFees=$${netFees.toFixed(0)}  ` +
    `avgExp=${(r.avgExposurePct * 100).toFixed(0)}%  maxExp=${(r.maxExposurePct * 100).toFixed(0)}%`
  );
  console.log(
    `${''.padEnd(37)} ` +
    `retailVol=$${(r.totalRetailVolume / 1000).toFixed(0)}k  arbVol=$${(r.totalArbVolume / 1000).toFixed(0)}k  ` +
    `ratio=${r.totalArbVolume > 0 ? (r.totalRetailVolume / r.totalArbVolume * 100).toFixed(0) : 0}%`
  );
}

// ─── Run ─────────────────────────────────────────────────────────────

function run() {
  console.log('=== V6 Negative Fee / Attract-Clearing Simulation ===');
  console.log(`Pool: USDC/WETH, rx=ry=${BASE_PARAMS.rx}, equity=$${BASE_PARAMS.xr}`);
  console.log(`Attract scale: ${V6_CONFIG.attractScale * 10000}bps max rebate | Retail: $${(V6_CONFIG.retailBaseVolumePerDay/1000).toFixed(0)}k/day (${V6_CONFIG.retailDirectionBias*100}% attract-biased)`);
  console.log(`Auction backstop: ${V6_CONFIG.auctionTriggerExposure * 100}% exposure | Health recenter: ${V6_CONFIG.healthRecenterThreshold}`);
  console.log('');

  // ── Main comparison across volatilities ──
  for (const vol of [0.30, 0.45, 0.60, 0.90]) {
    SIM_CONFIG.vol = vol;
    const pEquil = BASE_PARAMS.px / BASE_PARAMS.py;
    const pricePath = generatePricePath(pEquil);
    const ethStart = 1 / pricePath[0];
    const ethEnd = 1 / pricePath[pricePath.length - 1];
    console.log(`--- Vol=${(vol * 100).toFixed(0)}%, ${SIM_CONFIG.durationDays}d, ETH $${ethStart.toFixed(0)}->${ethEnd.toFixed(0)} ---`);

    const v6 = runV6Strategy(pricePath);
    printV6(v6);

    // Also run V6 with no retail (pure arb) for comparison
    const v6NoRetail = runV6Strategy(pricePath, { retailBaseVolumePerDay: 0 });
    printV6(v6NoRetail, 'V6 no-retail (arb only)');

    console.log('');
  }

  // ── Sensitivity: retail volume sweep ──
  console.log('\n=== Sensitivity: Retail Volume per Day (60% vol) ===');
  SIM_CONFIG.vol = 0.60;
  const pricePath = generatePricePath(BASE_PARAMS.px / BASE_PARAMS.py);
  console.log('  $/day    | Final NAV |  NAV %  | Recenters | Retail Fees | Auction Cost | Net Fees | Avg Exp%');
  console.log('  ---------|-----------|---------|-----------|-------------|-------------|----------|--------');
  for (const vol of [0, 50_000, 100_000, 200_000, 500_000, 1_000_000, 2_000_000]) {
    const r = runV6Strategy(pricePath, { retailBaseVolumePerDay: vol });
    const navPct = ((r.finalNAV / r.initialNAV - 1) * 100).toFixed(1);
    const netFees = r.totalFeeRevenue + r.totalRetailFeeRevenue - r.totalAuctionCost;
    console.log(
      `  ${(vol >= 1_000_000 ? `${(vol / 1_000_000).toFixed(0)}M` : `${(vol / 1000).toFixed(0)}k`).padStart(8)} | ` +
      `${('$' + r.finalNAV.toFixed(0)).padStart(9)} | ${navPct.padStart(6)}% | ` +
      `${String(r.totalRecenters).padStart(9)} | ` +
      `${('$' + r.totalRetailFeeRevenue.toFixed(0)).padStart(11)} | ` +
      `${('$' + r.totalAuctionCost.toFixed(0)).padStart(11)} | ` +
      `${('$' + netFees.toFixed(0)).padStart(8)} | ` +
      `${(r.avgExposurePct * 100).toFixed(0).padStart(5)}%`
    );
  }

  // ── Sensitivity: attract scale sweep ──
  console.log('\n=== Sensitivity: Attract Scale / Rebate Size (60% vol, 30% retail) ===');
  console.log('  Rebate  | Final NAV |  NAV %  | Recenters | Retail Fees | Net Fees | Avg Exp%');
  console.log('  --------|-----------|---------|-----------|-------------|----------|--------');
  for (const scale of [0, 0.0010, 0.0020, 0.0030, 0.0050, 0.0100]) {
    const r = runV6Strategy(pricePath, { attractScale: scale });
    const navPct = ((r.finalNAV / r.initialNAV - 1) * 100).toFixed(1);
    const netFees = r.totalFeeRevenue + r.totalRetailFeeRevenue - r.totalAuctionCost;
    console.log(
      `  ${(scale * 10000).toFixed(0).padStart(4)}bps | ` +
      `${('$' + r.finalNAV.toFixed(0)).padStart(9)} | ${navPct.padStart(6)}% | ` +
      `${String(r.totalRecenters).padStart(9)} | ` +
      `${('$' + r.totalRetailFeeRevenue.toFixed(0)).padStart(11)} | ` +
      `${('$' + netFees.toFixed(0)).padStart(8)} | ` +
      `${(r.avgExposurePct * 100).toFixed(0).padStart(5)}%`
    );
  }

  // ── Sensitivity: wider range (lower leverage) ──
  console.log('\n=== Sensitivity: Range Width / Leverage (60% vol, 30% retail) ===');
  console.log('  rx    |  L_eff | Final NAV |  NAV %  | Recenters | Auctions | Bare | Net Fees | Min H | Avg Exp%');
  console.log('  ------|--------|-----------|---------|-----------|----------|------|----------|-------|--------');
  for (const rxVal of [0.05, 0.10, 0.15, 0.25, 0.50]) {
    const r = runV6Strategy(pricePath, { overrideRx: rxVal });
    const navPct = ((r.finalNAV / r.initialNAV - 1) * 100).toFixed(1);
    const netFees = r.totalFeeRevenue + r.totalRetailFeeRevenue - r.totalAuctionCost;
    // Compute effective leverage
    const testParams = { ...BASE_PARAMS, rx: rxVal, ry: rxVal };
    const x0 = computeX0Additive(testParams);
    const y0 = computeY0Additive(testParams);
    const poolVal = x0 + y0 * BASE_PARAMS.py;
    const lEff = poolVal / BASE_PARAMS.xr;
    console.log(
      `  ${rxVal.toFixed(2).padStart(5)} | ${lEff.toFixed(0).padStart(5)}x | ` +
      `${('$' + r.finalNAV.toFixed(0)).padStart(9)} | ${navPct.padStart(6)}% | ` +
      `${String(r.totalRecenters).padStart(9)} | ` +
      `${String(r.totalAuctions).padStart(8)} | ` +
      `${String(r.bareRecenters).padStart(4)} | ` +
      `${('$' + netFees.toFixed(0)).padStart(8)} | ` +
      `${r.minHealth.toFixed(2).padStart(5)} | ` +
      `${(r.avgExposurePct * 100).toFixed(0).padStart(5)}%`
    );
  }

  // ── Log first 20 events for default config ──
  SIM_CONFIG.vol = 0.60;
  const v6log = runV6Strategy(pricePath);
  if (v6log.log.length > 0) {
    console.log(`\n=== V6 Event Log (first 20, 60% vol) ===`);
    for (const line of v6log.log.slice(0, 20)) console.log(`  ${line}`);
    if (v6log.log.length > 20) console.log(`  ... (${v6log.log.length - 20} more)`);
  }
}

run();
