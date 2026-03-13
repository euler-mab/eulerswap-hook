/**
 * AMM strategy interfaces and implementations for the unified simulation.
 *
 * Provides a pluggable abstraction over different AMM curves (EulerSwap, xy=k)
 * so they can compete head-to-head on the same price path.
 */

import {
  type Params,
  computeX0Additive, computeY0Additive,
  computeXb, computeYb,
  computeHX, computeHY,
  fX, gY,
} from "./math";
import { solveXForPrice, solveYForPrice } from "./simulate";

// ─── Vault State ─────────────────────────────────────────────────────

export interface VaultState {
  xr: number;   // X supply (real deposits)
  yr: number;   // Y supply
  xd: number;   // X debt
  yd: number;   // Y debt
}

export function vaultStateAt(curX: number, curY: number, x0: number, y0: number, init: VaultState): VaultState {
  const netX = (init.xr - init.xd) + (curX - x0);
  const netY = (init.yr - init.yd) + (curY - y0);
  return { xr: Math.max(netX, 0), yr: Math.max(netY, 0), xd: Math.max(-netX, 0), yd: Math.max(-netY, 0) };
}

export function computeNAV(vault: VaultState, ethPrice: number): number {
  return vault.xr + vault.yr * ethPrice - vault.xd - vault.yd * ethPrice;
}

export function computeExposure(vault: VaultState, ethPrice: number): number {
  return Math.abs(vault.yr - vault.yd) * ethPrice;
}

// ─── Strategy State ──────────────────────────────────────────────────

export interface StrategyState {
  /** Current X reserve (cursor position) */
  curX: number;
  /** Current Y reserve (cursor position) */
  curY: number;
  /** Equilibrium X reserve */
  x0: number;
  /** Equilibrium Y reserve */
  y0: number;
  /** X boundary (min reserve) */
  xb: number;
  /** Y boundary (min reserve) */
  yb: number;
  /** Equilibrium price (Y per X) */
  pEquil: number;
  /** Vault state (null for non-leveraged strategies) */
  vault: VaultState | null;
  /** Full params (for EulerSwap only) */
  params: Params | null;
}

export interface SwapResult {
  newCurX: number;
  newCurY: number;
  executed: boolean;
  feeRevenue: number;     // in X units (USDC)
  newVault: VaultState | null;
}

// ─── AMM Curve Interface ─────────────────────────────────────────────

export interface AMMCurve {
  /** Compute position for a target marginal price (closed-form arb).
   *  Returns null if price is out of range. */
  solveForPrice(state: StrategyState, targetPrice: number): { x: number; y: number } | null;

  /** Current marginal price (Y per X) at cursor position */
  marginalPrice(state: StrategyState): number;

  /** Execute a swap with fee-on-input. Returns new state + fee revenue. */
  executeSwap(
    state: StrategyState,
    isBuyX: boolean,
    grossAmountUSDC: number,
    ethPrice: number,
    fee: number,
  ): SwapResult;
}

// ─── Strategy Interface ──────────────────────────────────────────────

export interface SimHook {
  beforeSwap?(ctx: SwapContext): boolean;
  getFee?(ctx: FeeContext): number | null;
  afterSwap?(ctx: AfterSwapContext): void;
}

export interface SwapContext {
  state: StrategyState;
  extPrice: number;
  ethPrice: number;
  isArb: boolean;
}

export interface FeeContext {
  asset0IsInput: boolean;   // true = trader sending X (selling USDC)
  state: StrategyState;
  extPrice: number;
  ethPrice: number;
  isArb: boolean;
  /** For non-arb: is this trade reducing the pool's directional exposure? */
  isExposureReducing: boolean;
  /** |extPrice - pEquil| / pEquil */
  priceOffset: number;
  /** exposure / NAV (0–1+) */
  exposureFrac: number;
}

export interface AfterSwapContext {
  state: StrategyState;
  amount0In: number;
  amount1In: number;
  amount0Out: number;
  amount1Out: number;
  fee: number;
  extPrice: number;
  ethPrice: number;
  isArb: boolean;
  /** Mutable: hook can set this to a new reconfigured state */
  reconfiguredState: StrategyState | null;
  /** Mutable accumulators */
  accum: ResultAccumulators;
}

export interface ResultAccumulators {
  totalRecenters: number;
  totalAuctions: number;
  auctionCost: number;
}

export interface AMMStrategy {
  name: string;
  curve: AMMCurve;
  hook: SimHook | null;
  /** Whether this strategy tracks vault state (leverage) */
  hasVault: boolean;

  /** Initialize strategy state for given reserves and price */
  init(xr: number, yr: number, price: number): StrategyState;

  /** Recenter the pool to a new price, preserving vault state.
   *  Returns new state at equilibrium. */
  recenter(vault: VaultState, newPrice: number): StrategyState;

  /** Compute health factor at current position. Returns 10 if no debt. */
  computeHealth(state: StrategyState): number;
}

// ─── xy=k Strategy ───────────────────────────────────────────────────

/** Constant-product AMM curve (xy=k). Used as normalizer. */
const xyKCurve: AMMCurve = {
  solveForPrice(state: StrategyState, targetPrice: number): { x: number; y: number } | null {
    // xy = k, marginal price = y/x. At target price p: y = p*x, x*p*x = k → x = √(k/p)
    const k = state.curX * state.curY;  // current invariant
    if (targetPrice <= 0) return null;
    const x = Math.sqrt(k / targetPrice);
    const y = Math.sqrt(k * targetPrice);
    return { x, y };
  },

  marginalPrice(state: StrategyState): number {
    if (state.curX <= 0) return Infinity;
    return state.curY / state.curX;
  },

  executeSwap(state, isBuyX, grossAmountUSDC, ethPrice, fee): SwapResult {
    const gamma = 1 - fee;
    const k = state.curX * state.curY;

    if (isBuyX) {
      // Trader sends Y (WETH), receives X (USDC)
      const dyGross = grossAmountUSDC / ethPrice;
      const dyNet = dyGross * gamma;
      const newY = state.curY + dyNet;
      const newX = k / newY;
      const dxOut = state.curX - newX;
      if (dxOut < 0.01) return { newCurX: state.curX, newCurY: state.curY, executed: false, feeRevenue: 0, newVault: null };
      const dyFee = dyGross - dyNet;  // fee in Y terms
      const feeRevenue = dyFee * ethPrice;
      // Add fee to reserves (grows k, like Uni V2)
      return { newCurX: newX, newCurY: newY + dyFee, executed: true, feeRevenue, newVault: null };
    } else {
      // Trader sends X (USDC), receives Y (WETH)
      const dxGross = grossAmountUSDC;
      const dxNet = dxGross * gamma;
      const newX = state.curX + dxNet;
      const newY = k / newX;
      const dyOut = state.curY - newY;
      if (dyOut < 1e-10) return { newCurX: state.curX, newCurY: state.curY, executed: false, feeRevenue: 0, newVault: null };
      const dxFee = dxGross - dxNet;  // fee in X terms
      const feeRevenue = dxFee;
      // Add fee to reserves (grows k, like Uni V2)
      return { newCurX: newX + dxFee, newCurY: newY, executed: true, feeRevenue, newVault: null };
    }
  },
};

/** Create a constant-product xy=k strategy with fixed fee. */
export function xyKStrategy(fee: number, name?: string): AMMStrategy {
  return {
    name: name ?? `xy=k ${(fee * 10000).toFixed(0)}bps`,
    curve: xyKCurve,
    hook: null,
    hasVault: false,

    init(xr: number, _yr: number, price: number): StrategyState {
      // Initialize with equal value on each side
      // xr is total value in USDC, split 50/50
      const x0 = xr / 2;
      const y0 = x0 / price;  // equivalent value in Y terms
      return {
        curX: x0, curY: y0, x0, y0,
        xb: 0, yb: 0,  // no boundaries for xy=k
        pEquil: price,
        vault: null,
        params: null,
      };
    },

    recenter(_vault: VaultState, newPrice: number): StrategyState {
      // xy=k doesn't recenter — this shouldn't be called
      throw new Error("xy=k strategy does not support recentering");
    },

    computeHealth(): number {
      return 10;  // no leverage
    },
  };
}

// ─── EulerSwap Strategy ──────────────────────────────────────────────

/** EulerSwap curve implementation with full leverage and vault tracking. */
class EulerSwapCurve implements AMMCurve {
  solveForPrice(state: StrategyState, targetPrice: number): { x: number; y: number } | null {
    const p = state.params!;
    const { x0, y0, xb, yb } = state;
    const pEquil = p.px / p.py;

    if (x0 < 1 || y0 < 1e-8) return null;

    if (targetPrice >= pEquil) {
      const solved = solveXForPrice(targetPrice, p.cx, x0, p.px, p.py, xb);
      if (solved !== null) {
        return { x: solved, y: fX(solved, p.cx, x0, y0, p.px, p.py) };
      }
      // At boundary
      return { x: xb, y: fX(xb, p.cx, x0, y0, p.px, p.py) };
    } else {
      const solved = solveYForPrice(targetPrice, p.cy, y0, p.px, p.py, yb);
      if (solved !== null) {
        return { x: gY(solved, p.cy, y0, x0, p.px, p.py), y: solved };
      }
      return { x: gY(yb, p.cy, y0, x0, p.px, p.py), y: yb };
    }
  }

  marginalPrice(state: StrategyState): number {
    // Marginal price at current position
    const p = state.params!;
    const pEquil = p.px / p.py;
    if (state.curX <= state.x0) {
      // X side: price = (px/py) * (cx + (1-cx)*(x0/x)^2)
      const r = state.x0 / state.curX;
      return (p.px / p.py) * (p.cx + (1 - p.cx) * r * r);
    } else {
      // Y side: price = (px/py) / (cy + (1-cy)*(y0/y)^2)
      const r = state.y0 / state.curY;
      return (p.px / p.py) / (p.cy + (1 - p.cy) * r * r);
    }
  }

  executeSwap(state: StrategyState, isBuyX: boolean, grossAmountUSDC: number, ethPrice: number, fee: number): SwapResult {
    const p = state.params!;
    const { x0, y0, xb, yb } = state;
    let curX = state.curX;
    let curY = state.curY;
    const vault = state.vault!;
    let newVault = { ...vault };
    const gamma = 1 - fee;

    const yAtXb = fX(xb, p.cx, x0, y0, p.px, p.py);
    const xAtYb = gY(yb, p.cy, y0, x0, p.px, p.py);

    const noExec: SwapResult = { newCurX: curX, newCurY: curY, executed: false, feeRevenue: 0, newVault: vault };

    if (isBuyX) {
      const dyGross = grossAmountUSDC / ethPrice;
      const dyNet = dyGross * gamma;
      const yMax = yAtXb * 0.999;
      const newY = Math.min(curY + dyNet, yMax);
      if (newY <= curY + 1e-10) return noExec;

      const dy = newY - curY;
      let xAfter: number;
      if (newY >= y0) {
        const pxpy = p.px / p.py;
        xAfter = pxpy * x0 * x0 / (newY - y0 + pxpy * x0);
      } else {
        xAfter = gY(newY, p.cy, y0, x0, p.px, p.py);
      }

      let xBefore: number;
      if (curY >= y0 - 1e-8) {
        if (curY >= y0) {
          const pxpy = p.px / p.py;
          xBefore = pxpy * x0 * x0 / (curY - y0 + pxpy * x0);
        } else {
          xBefore = x0;
        }
      } else {
        xBefore = gY(curY, p.cy, y0, x0, p.px, p.py);
      }

      const dxOut = xBefore - xAfter;
      if (dxOut < 0.01) return noExec;

      const dyFee = dy / gamma - dy;  // fee in Y terms
      const feeRevenue = dyFee * ethPrice;

      const xrUsed = Math.min(dxOut, newVault.xr);
      const wethRepaid = Math.min(dy, newVault.yd);
      newVault = {
        xr: newVault.xr - xrUsed,
        yr: newVault.yr + (dy - wethRepaid) + dyFee,  // deposit fee into vault supply
        xd: newVault.xd + (dxOut - xrUsed),
        yd: newVault.yd - wethRepaid,
      };

      return { newCurX: xAfter, newCurY: newY, executed: true, feeRevenue, newVault };
    } else {
      const dxGross = grossAmountUSDC;
      const dxNet = dxGross * gamma;
      const xMax = xAtYb * 0.999;
      const newX = Math.min(curX + dxNet, xMax);
      if (newX <= curX + 0.01) return noExec;

      const dx = newX - curX;
      let yAfter: number;
      if (newX >= x0) {
        const pypx = p.py / p.px;
        yAfter = pypx * y0 * y0 / (newX - x0 + pypx * y0);
      } else {
        yAfter = fX(newX, p.cx, x0, y0, p.px, p.py);
      }

      let yBefore: number;
      if (curX >= x0 - 0.01) {
        if (curX >= x0) {
          const pypx = p.py / p.px;
          yBefore = pypx * y0 * y0 / (curX - x0 + pypx * y0);
        } else {
          yBefore = y0;
        }
      } else {
        yBefore = fX(curX, p.cx, x0, y0, p.px, p.py);
      }

      const dyOut = yBefore - yAfter;
      if (dyOut < 1e-10) return noExec;

      const dxFee = dx / gamma - dx;  // fee in X terms
      const feeRevenue = dxFee;

      const yrUsed = Math.min(dyOut, newVault.yr);
      const usdcRepaid = Math.min(dx, newVault.xd);
      newVault = {
        xr: newVault.xr + (dx - usdcRepaid) + dxFee,  // deposit fee into vault supply
        yr: newVault.yr - yrUsed,
        xd: newVault.xd - usdcRepaid,
        yd: newVault.yd + (dyOut - yrUsed),
      };

      return { newCurX: newX, newCurY: yAfter, executed: true, feeRevenue, newVault };
    }
  }
}

const eulerSwapCurve = new EulerSwapCurve();

export interface EulerSwapConfig {
  /** Base Params template (vyx, vxy, etc.). px/py will be overridden by pair price. */
  baseParams: Params;
  /** Range width (applied to both rx and ry) */
  rx: number;
  /** Concentration (applied to both cx and cy) */
  cx?: number;
  /** Hook for dynamic fees and afterSwap logic */
  hook?: SimHook;
}

/** Create an EulerSwap strategy with full leverage and vault tracking. */
export function eulerSwapStrategy(config: EulerSwapConfig): AMMStrategy {
  const hook = config.hook ?? null;
  const cx = config.cx ?? 0;

  function makeState(params: Params): StrategyState {
    const x0 = computeX0Additive(params);
    const y0 = computeY0Additive(params);
    const xb = computeXb(x0, params.rx, params.cx);
    const yb = computeYb(y0, params.ry, params.cy);
    return {
      curX: x0, curY: y0, x0, y0, xb, yb,
      pEquil: params.px / params.py,
      vault: { xr: params.xr, yr: params.yr, xd: params.xd, yd: params.yd },
      params,
    };
  }

  return {
    name: "EulerSwap",
    curve: eulerSwapCurve,
    hook,
    hasVault: true,

    init(xr: number, _yr: number, price: number): StrategyState {
      const params: Params = {
        ...config.baseParams,
        px: 1,
        py: price,
        rx: config.rx,
        ry: config.rx,
        cx,
        cy: cx,
        xr,
        yr: 0,
      };
      return makeState(params);
    },

    recenter(vault: VaultState, newPrice: number): StrategyState {
      const params: Params = {
        ...config.baseParams,
        px: 1,
        py: newPrice,
        rx: config.rx,
        ry: config.rx,
        cx,
        cy: cx,
        xr: vault.xr,
        yr: vault.yr,
        xd: vault.xd,
        yd: vault.yd,
      };
      return makeState(params);
    },

    computeHealth(state: StrategyState): number {
      const { curX, curY, x0, y0, params } = state;
      if (!params || x0 <= 0 || y0 <= 0) return 10;
      if (curX <= x0) {
        const h = computeHX(Math.max(curX, 0.001), params, x0, y0);
        if (isFinite(h)) return Math.min(h, 10);
      } else {
        const h = computeHY(Math.max(curY, 1e-8), params, x0, y0);
        if (isFinite(h)) return Math.min(h, 10);
      }
      return 10;
    },
  };
}

/** Default base params for EulerSwap (USDC/WETH style, leveraged). */
export const DEFAULT_EULER_PARAMS: Params = {
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
