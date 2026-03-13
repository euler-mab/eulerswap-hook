/**
 * Prebuilt hook implementations for the unified simulation framework.
 *
 * Each hook is a factory function returning a SimHook object.
 * Hooks can be composed via compositeHook().
 */

import type {
  SimHook, FeeContext, AfterSwapContext, StrategyState,
  VaultState, ResultAccumulators,
} from "./sim-strategy";
import {
  vaultStateAt, computeNAV, computeExposure,
} from "./sim-strategy";
import {
  type Params,
  computeX0Additive, computeY0Additive,
  computeXb, computeYb,
  fX, gY,
} from "./math";
import { mulberry32, boxMuller } from "./simulate";

// ─── Static Fee Hook ─────────────────────────────────────────────────

/** Constant fee, no beforeSwap or afterSwap logic. */
export function staticFeeHook(fee: number): SimHook {
  return {
    getFee(): number { return fee; },
  };
}

// ─── Oracle Fee Hook ─────────────────────────────────────────────────

export interface OracleFeeConfig {
  baseFee: number;         // resting fee (fraction, e.g. 0.0005 = 5 bps)
  maxFee: number;          // ceiling
  captureRate: number;     // arb-side: fraction of price offset to capture
  attractRate: number;     // attract-side: rebate scaling factor
  externalFee: number;     // arber's external cost floor
  maxExposureFrac?: number; // normalisation for attract scale (default 1.0)
}

/**
 * Oracle-reactive dynamic fee.
 * Arb direction: baseFee + captureRate × priceOffset (capped at maxFee)
 * Attract direction: baseFee − attractRate × (exposure / maxExposure)
 */
export function oracleFeeHook(config: OracleFeeConfig): SimHook {
  const maxExpFrac = config.maxExposureFrac ?? 1.0;

  return {
    getFee(ctx: FeeContext): number {
      if (ctx.isExposureReducing) {
        const scale = Math.min(ctx.exposureFrac / maxExpFrac, 1.0);
        return Math.max(config.baseFee - config.attractRate * scale, 0);
      } else {
        return Math.min(
          config.baseFee + config.captureRate * ctx.priceOffset,
          config.maxFee,
        );
      }
    },
  };
}

// ─── Continuous Recenter Hook ────────────────────────────────────────

export interface ContinuousRecenterConfig {
  rx: number;              // range width for recentered pool
  /** Surcharge added to fee after each recenter (fraction, e.g. 0.005 = 50 bps). Default 0. */
  surchargeInitial?: number;
  /** Fraction of surcharge that decays each step (e.g. 0.02 = 2% per step). Default 0.02. */
  surchargeDecayPerStep?: number;
}

/**
 * V8-style afterSwap: recenter if reserve exposure decreased since last check.
 * Tracks last reserve exposure and recenters when improvement is detected.
 */
export function continuousRecenterHook(config: ContinuousRecenterConfig): SimHook {
  let lastReserveExposure = 0;
  let surchargeRemaining = 0;
  const surchargeInitial = config.surchargeInitial ?? 0;
  const surchargeDecay = config.surchargeDecayPerStep ?? 0.02;

  function computeReserveExposure(state: StrategyState): number {
    const { curX, curY, x0, y0, xb, yb } = state;
    if (curX < x0 && x0 > xb) return (x0 - curX) / (x0 - xb);
    if (curY < y0 && y0 > yb) return (y0 - curY) / (y0 - yb);
    return 0;
  }

  return {
    getFee(_ctx: FeeContext): number | null {
      if (surchargeRemaining < 1e-6) return null;
      return surchargeRemaining;  // additive when composed
    },

    afterSwap(ctx: AfterSwapContext): void {
      // Decay surcharge each step (even without recenter)
      surchargeRemaining *= (1 - surchargeDecay);
      const exposure = computeReserveExposure(ctx.state);

      if (exposure < lastReserveExposure && ctx.state.vault) {
        // Exposure decreased — lock in improvement by recentering
        const vault = vaultStateAt(
          ctx.state.curX, ctx.state.curY,
          ctx.state.x0, ctx.state.y0,
          ctx.state.vault,
        );
        const newPrice = ctx.ethPrice;
        const p = ctx.state.params!;
        const params: Params = {
          ...p,
          px: 1,
          py: newPrice,
          rx: config.rx,
          ry: config.rx,
          xr: vault.xr, yr: vault.yr,
          xd: vault.xd, yd: vault.yd,
        };
        const x0 = computeX0Additive(params);
        const y0 = computeY0Additive(params);

        ctx.reconfiguredState = {
          curX: x0, curY: y0, x0, y0,
          xb: computeXb(x0, params.rx, params.cx),
          yb: computeYb(y0, params.ry, params.cy),
          pEquil: 1 / newPrice,
          vault: { ...vault },
          params,
        };
        ctx.accum.totalRecenters++;
        lastReserveExposure = 0;
        if (surchargeInitial > 0) surchargeRemaining = surchargeInitial;
      } else {
        lastReserveExposure = exposure;
      }
    },
  };
}

// ─── Auction Backstop Hook ───────────────────────────────────────────

export interface AuctionBackstopConfig {
  triggerExposureRatio: number;   // vault exposure / NAV threshold
  shiftMagnitude: number;         // price shift to create clearing arb (e.g. 0.0108)
  decayBpsPerMinute: number;      // fee decay rate
  clearThreshold: number;         // offset convergence target
  minAuctionMinutes: number;      // guard against premature clearing
  maxAuctionMinutes?: number;     // upper bound (default 120)
  baseFee: number;                // floor fee during auction
  refFee: number;                 // reference venue fee (for clearing calc)
  rx: number;                     // range width for recentered pool
  /** If true, simulate price movement during auction minutes. Default false. */
  dynamicAuctionPrice?: boolean;
}

/**
 * Fee-decay auction backstop. Triggers when vault exposure exceeds threshold.
 * Shifts equilibrium price to create clearing arb, decays fee until arb
 * can profitably clear the offset.
 */
export function auctionBackstopHook(config: AuctionBackstopConfig): SimHook {
  const maxMin = config.maxAuctionMinutes ?? 120;

  return {
    afterSwap(ctx: AfterSwapContext): void {
      if (!ctx.state.vault || !ctx.state.params) return;
      // Already recentered by another hook in this composite?
      if (ctx.reconfiguredState) return;

      const vault = vaultStateAt(
        ctx.state.curX, ctx.state.curY,
        ctx.state.x0, ctx.state.y0,
        ctx.state.vault,
      );
      const nav = computeNAV(vault, ctx.ethPrice);
      const exposure = computeExposure(vault, ctx.ethPrice);
      const exposurePct = nav > 0 ? exposure / nav : 0;

      if (exposurePct <= config.triggerExposureRatio || nav <= 1) return;

      // Determine direction
      const wethNet = vault.yr - vault.yd;
      const asset0Deficit = wethNet > 0;
      const shift = config.shiftMagnitude;
      const pyOff = asset0Deficit
        ? ctx.ethPrice / (1 + shift)
        : ctx.ethPrice * (1 + shift);

      const p = ctx.state.params;
      const offParams: Params = {
        ...p,
        px: 1,
        py: pyOff,
        rx: config.rx,
        ry: config.rx,
        xr: vault.xr, yr: vault.yr,
        xd: vault.xd, yd: vault.yd,
      };
      const x0Off = computeX0Additive(offParams);
      const y0Off = computeY0Additive(offParams);

      if (x0Off < 1 || y0Off < 1e-8) return;

      let curVault = { ...vault };
      let aCost = 0;
      let aFees = 0;
      let cleared = false;
      const startFee = Math.min(shift * 1.5, 0.05);

      // Dynamic auction price: evolve ethPrice during auction minutes
      let auctionEthPrice = ctx.ethPrice;
      const useDynamicPrice = config.dynamicAuctionPrice && ctx.vol;
      const dtMin = 1 / (365 * 24 * 60);  // one minute in years
      const auctionRng = useDynamicPrice
        ? mulberry32(Math.floor(ctx.ethPrice * 1e6))
        : null;

      if (asset0Deficit) {
        let yCur = y0Off;
        const ybOff = computeYb(y0Off, offParams.ry, offParams.cy);
        for (let min = 0; min <= maxMin; min++) {
          if (useDynamicPrice && auctionRng && min > 0) {
            const vol = ctx.vol!;
            auctionEthPrice *= Math.exp(-0.5 * vol * vol * dtMin + vol * Math.sqrt(dtMin) * boxMuller(auctionRng));
          }
          const feeFrac = Math.max(startFee - (config.decayBpsPerMinute * min) / 10000, config.baseFee);
          const offset = (1 + shift) * (yCur / y0Off) ** 2 - 1;
          if (offset < 1e-8) break;
          if (offset <= feeFrac + config.refFee) { if (feeFrac <= config.baseFee) break; continue; }
          const denom = (1 - config.refFee) * (1 - feeFrac) * (1 + shift);
          if (denom <= 0) continue;
          const yEnd = Math.max(y0Off / Math.sqrt(denom), ybOff);
          if (yEnd >= yCur - 1e-8) continue;
          const dyOut = yCur - yEnd;
          const xEnd = gY(yEnd, 0, y0Off, x0Off, 1, pyOff);
          const xCurVal = (yCur >= y0Off - 1e-8) ? x0Off : gY(yCur, 0, y0Off, x0Off, 1, pyOff);
          const dxIn = xEnd - xCurVal;
          if (dxIn < 0.01) continue;
          const feeUSDC = dxIn * feeFrac / (1 - feeFrac);
          aCost += dyOut * auctionEthPrice - dxIn;
          aFees += feeUSDC;
          const usdcRepaid = Math.min(dxIn + feeUSDC, curVault.xd);
          const yrUsed = Math.min(dyOut, curVault.yr);
          curVault = {
            xr: curVault.xr + (dxIn + feeUSDC - usdcRepaid),
            yr: curVault.yr - yrUsed,
            xd: curVault.xd - usdcRepaid,
            yd: curVault.yd + (dyOut - yrUsed),
          };
          yCur = yEnd;
          const postOffset = (1 + shift) * (yCur / y0Off) ** 2 - 1;
          if (min >= config.minAuctionMinutes && postOffset <= config.clearThreshold * 1.01) { cleared = true; break; }
          if (feeFrac <= config.baseFee) break;
        }
      } else {
        let xCur = x0Off;
        const xbOff = computeXb(x0Off, offParams.rx, offParams.cx);
        for (let min = 0; min <= maxMin; min++) {
          if (useDynamicPrice && auctionRng && min > 0) {
            const vol = ctx.vol!;
            auctionEthPrice *= Math.exp(-0.5 * vol * vol * dtMin + vol * Math.sqrt(dtMin) * boxMuller(auctionRng));
          }
          const feeFrac = Math.max(startFee - (config.decayBpsPerMinute * min) / 10000, config.baseFee);
          const offset = (1 + shift) * (xCur / x0Off) ** 2 - 1;
          if (offset < 1e-8) break;
          if (offset <= feeFrac + config.refFee) { if (feeFrac <= config.baseFee) break; continue; }
          const denom = (1 - config.refFee) * (1 - feeFrac) * (1 + shift);
          if (denom <= 0) continue;
          const xEnd = Math.max(x0Off / Math.sqrt(denom), xbOff);
          if (xEnd >= xCur - 0.01) continue;
          const dxOut = xCur - xEnd;
          const yEnd = fX(xEnd, 0, x0Off, y0Off, 1, pyOff);
          const yCurVal = (xCur >= x0Off - 0.01) ? y0Off : fX(xCur, 0, x0Off, y0Off, 1, pyOff);
          const dyIn = yEnd - yCurVal;
          if (dyIn < 1e-12) continue;
          const feeWETH = dyIn * feeFrac / (1 - feeFrac);
          aCost += dxOut - dyIn * auctionEthPrice;
          aFees += feeWETH * auctionEthPrice;
          const wethRepaid = Math.min(dyIn + feeWETH, curVault.yd);
          const xrUsed = Math.min(dxOut, curVault.xr);
          curVault = {
            xr: curVault.xr - xrUsed,
            yr: curVault.yr + (dyIn + feeWETH - wethRepaid),
            xd: curVault.xd + (dxOut - xrUsed),
            yd: curVault.yd - wethRepaid,
          };
          xCur = xEnd;
          const postOffset = (1 + shift) * (xCur / x0Off) ** 2 - 1;
          if (min >= config.minAuctionMinutes && postOffset <= config.clearThreshold * 1.01) { cleared = true; break; }
          if (feeFrac <= config.baseFee) break;
        }
      }

      ctx.accum.auctionCost += aCost - aFees;
      ctx.accum.totalAuctions++;
      ctx.accum.totalRecenters++;

      // Recenter after auction. Always use post-clearing vault — the arber
      // trades happened regardless of whether the offset fully cleared.
      const finalVault = curVault;
      const params: Params = {
        ...p,
        px: 1,
        py: ctx.ethPrice,
        rx: config.rx,
        ry: config.rx,
        xr: finalVault.xr, yr: finalVault.yr,
        xd: finalVault.xd, yd: finalVault.yd,
      };
      const x0 = computeX0Additive(params);
      const y0 = computeY0Additive(params);

      ctx.reconfiguredState = {
        curX: x0, curY: y0, x0, y0,
        xb: computeXb(x0, params.rx, params.cx),
        yb: computeYb(y0, params.ry, params.cy),
        pEquil: 1 / ctx.ethPrice,
        vault: { ...finalVault },
        params,
      };
    },
  };
}

// ─── Composite Hook ──────────────────────────────────────────────────

/**
 * Chain multiple hooks. For getFee, first non-null is base fee,
 * subsequent non-null values are added (surcharges). For afterSwap,
 * calls each in order (skipping if already recentered).
 */
export function compositeHook(...hooks: SimHook[]): SimHook {
  return {
    beforeSwap(ctx) {
      for (const h of hooks) {
        if (h.beforeSwap && !h.beforeSwap(ctx)) return false;
      }
      return true;
    },

    getFee(ctx) {
      let baseFee: number | null = null;
      for (const h of hooks) {
        if (h.getFee) {
          const fee = h.getFee(ctx);
          if (fee !== null) {
            if (baseFee === null) baseFee = fee;
            else baseFee += fee;  // additive surcharge
          }
        }
      }
      return baseFee;
    },

    afterSwap(ctx) {
      for (const h of hooks) {
        if (h.afterSwap) {
          h.afterSwap(ctx);
          // If this hook recentered, subsequent hooks see the new state
          if (ctx.reconfiguredState) return;
        }
      }
    },
  };
}
