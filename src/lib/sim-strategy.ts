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
  /** Annualized volatility (for auction sub-simulation). */
  vol?: number;
  /** Steps per day (for dt calculation). */
  stepsPerDay?: number;
  /** Current simulation step index (0-based). */
  stepIndex?: number;
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
      // Return curve position (net input only). Fee deposited by engine.
      return { newCurX: newX, newCurY: newY, executed: true, feeRevenue, newVault: null };
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
      // Return curve position (net input only). Fee deposited by engine.
      return { newCurX: newX, newCurY: newY, executed: true, feeRevenue, newVault: null };
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
        pEquil: y0 / x0,  // Y per X (marginal price at equilibrium)
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

/**
 * Invert fX: given y on the X-side curve (x <= x0), find x.
 * y = y0 + (px/py) * (x0 - x) * (cx + (1-cx) * x0/x)
 * For cx=0: x = (px/py) * x0² / (y - y0 + (px/py) * x0)
 * For cx>0: quadratic  cx·x² + (D - (2cx-1)·x0)·x - (1-cx)·x0² = 0
 */
function invertFX(y: number, cx: number, x0: number, y0: number, px: number, py: number): number {
  const pxpy = px / py;
  const D = (y - y0) / pxpy;  // normalized displacement
  if (cx < 1e-12) {
    // cx=0 simplification
    return pxpy * x0 * x0 / (y - y0 + pxpy * x0);
  }
  // Quadratic: cx·x² + (D - (2cx-1)·x0)·x - (1-cx)·x0² = 0
  const a = cx;
  const b = D - (2 * cx - 1) * x0;
  const c = -(1 - cx) * x0 * x0;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return x0;  // shouldn't happen
  return (-b + Math.sqrt(disc)) / (2 * a);  // positive root
}

/**
 * Invert gY: given x on the Y-side curve (y <= y0), find y.
 * x = x0 + (py/px) * (y0 - y) * (cy + (1-cy) * y0/y)
 * For cy=0: y = (py/px) * y0² / (x - x0 + (py/px) * y0)
 * For cy>0: quadratic  cy·y² + (D - (2cy-1)·y0)·y - (1-cy)·y0² = 0
 */
function invertGY(x: number, cy: number, y0: number, x0: number, px: number, py: number): number {
  const pypx = py / px;
  const D = (x - x0) / pypx;  // normalized displacement
  if (cy < 1e-12) {
    // cy=0 simplification
    return pypx * y0 * y0 / (x - x0 + pypx * y0);
  }
  // Quadratic: cy·y² + (D - (2cy-1)·y0)·y - (1-cy)·y0² = 0
  const a = cy;
  const b = D - (2 * cy - 1) * y0;
  const c = -(1 - cy) * y0 * y0;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return y0;
  return (-b + Math.sqrt(disc)) / (2 * a);
}

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
        xAfter = invertFX(newY, p.cx, x0, y0, p.px, p.py);
      } else {
        xAfter = gY(newY, p.cy, y0, x0, p.px, p.py);
      }

      let xBefore: number;
      if (curY >= y0 - 1e-8) {
        if (curY >= y0) {
          xBefore = invertFX(curY, p.cx, x0, y0, p.px, p.py);
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

      // Don't deposit fee here — engine handles fee deposit uniformly
      // for both arb and retail paths. Only return raw vault state.
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
        yAfter = invertGY(newX, p.cy, y0, x0, p.px, p.py);
      } else {
        yAfter = fX(newX, p.cx, x0, y0, p.px, p.py);
      }

      let yBefore: number;
      if (curX >= x0 - 0.01) {
        if (curX >= x0) {
          yBefore = invertGY(curX, p.cy, y0, x0, p.px, p.py);
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

      // Don't deposit fee here — engine handles fee deposit uniformly
      // for both arb and retail paths. Only return raw vault state.
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
  /** Override strategy name */
  name?: string;
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
    name: config.name ?? "EulerSwap",
    curve: eulerSwapCurve,
    hook,
    hasVault: true,

    init(xr: number, _yr: number, price: number): StrategyState {
      // If no leverage (vyx=0 and vxy=0), split equity 50/50 across both sides.
      // With leverage, one-sided equity works because the pool borrows the other side.
      const hasLeverage = config.baseParams.vyx > 0 || config.baseParams.vxy > 0;
      const xEquity = hasLeverage ? xr : xr / 2;
      const yEquity = hasLeverage ? 0 : (xr / 2) / price;

      const params: Params = {
        ...config.baseParams,
        px: 1,
        py: price,
        rx: config.rx,
        ry: config.rx,
        cx,
        cy: cx,
        xr: xEquity,
        yr: yEquity,
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

// ─── Yield Basis Releverage Strategy ────────────────────────────────

export interface YBReleverageConfig {
  /** Leverage factor (default 2). */
  leverage?: number;
  /** Fixed fee for the releverage AMM (default 0.007 = 70 bps, optimal per YB paper). */
  fee?: number;
  /** Annual borrow rate for structural debt (default 0). */
  borrowRateAnnual?: number;
  /** Override strategy name. */
  name?: string;
}

/**
 * Yield Basis releverage AMM strategy.
 *
 * Models the YB two-AMM architecture's releverage component:
 * - Leveraged xy=k curve (L=2 default): LP equity E controls L×E/2 per side
 * - Recenters after every swap (arb + retail) to maintain target leverage
 * - Fixed fee (default 70 bps from YB paper's optimization)
 *
 * Per-step equity dynamics:
 *   Discrete:  E_new = E × (L√r − (L−1))     (residual IL ≈ σ²T/4)
 *   Ideal:     E_new = E × r                  (IL = 0, continuous limit)
 *
 * This implements the discrete version — arb trades on the leveraged xy=k
 * curve, then afterSwap recenters. The gap from ideal measures the cost
 * of discrete re-leveraging.
 *
 * Vault encoding:
 *   xr = curX (total USDC on curve, including borrowed)
 *   yr = curY (total WETH on curve)
 *   xd = debt (USDC borrowed = (L-1)×equity)
 *   yd = 0
 *   NAV = curX + curY×ethPrice − debt = equity
 */
export function yieldBasisReleverageStrategy(config?: YBReleverageConfig): AMMStrategy {
  const L = config?.leverage ?? 2;
  const fee = config?.fee ?? 0.007;  // 70 bps default
  const borrowRate = config?.borrowRateAnnual ?? 0;

  // Track structural debt interest internally.
  // The engine's vault-based interest accrual doesn't work for YB because
  // after recenter, vaultStateAt reports zero net debt (the borrowed USDC
  // is on the curve, cancelling against the vault's xd).
  // Instead, we deduct interest from equity on each recenter.
  let debtBalance = 0;        // current debt (USDC)
  let pendingInterest = 0;    // interest accrued since last recenter
  let lastAccrualStep = 0;    // last step at which interest was accrued

  /** Build state at equilibrium for given equity and ethPrice. */
  function buildState(equity: number, ethPrice: number): StrategyState {
    const curX = L * equity / 2;             // USDC on curve
    const curY = L * equity / (2 * ethPrice); // WETH on curve
    const debt = (L - 1) * equity;            // borrowed USDC
    debtBalance = debt;
    pendingInterest = 0;
    return {
      curX, curY,
      x0: curX, y0: curY,
      xb: 0, yb: 0,
      pEquil: 1 / ethPrice,  // Y per X = WETH per USDC
      vault: { xr: curX, yr: curY, xd: debt, yd: 0 },
      params: null,
    };
  }

  const hook: SimHook = {
    getFee(): number {
      return fee;
    },

    afterSwap(ctx: AfterSwapContext): void {
      if (!ctx.state.vault) return;

      // Accrue interest on structural debt for ALL elapsed steps since last accrual,
      // not just the current step. This ensures interest is correct even when
      // multiple steps pass without a swap (no afterSwap call).
      const stepsPerDay = ctx.stepsPerDay ?? 24;
      const dt = 1 / (365 * stepsPerDay);
      const currentStep = ctx.stepIndex ?? (lastAccrualStep + 1);
      const elapsedSteps = Math.max(currentStep - lastAccrualStep, 1);
      lastAccrualStep = currentStep;

      for (let s = 0; s < elapsedSteps; s++) {
        const stepInterest = debtBalance * borrowRate * dt;
        pendingInterest += stepInterest;
        debtBalance += stepInterest;
      }

      // Compute current equity from vault state, minus accrued interest
      const vault = vaultStateAt(
        ctx.state.curX, ctx.state.curY,
        ctx.state.x0, ctx.state.y0,
        ctx.state.vault,
      );
      const rawEquity = computeNAV(vault, ctx.ethPrice);
      const equity = rawEquity - pendingInterest;

      if (equity <= 0) return;  // wiped out

      // Recenter: rebuild state at current price preserving equity
      ctx.reconfiguredState = buildState(equity, ctx.ethPrice);
      ctx.accum.totalRecenters++;
    },
  };

  return {
    name: config?.name ?? `YB relev L=${L} ${(fee * 10000).toFixed(0)}bps`,
    curve: xyKCurve,
    hook,
    hasVault: true,

    init(xr: number, _yr: number, price: number): StrategyState {
      // price = ethPrice (USDC per WETH), xr = equity in USDC
      return buildState(xr, price);
    },

    recenter(vault: VaultState, newPrice: number): StrategyState {
      // newPrice is extPrice (Y per X), convert to ethPrice
      const ethPrice = 1 / newPrice;
      const equity = computeNAV(vault, ethPrice);
      return buildState(Math.max(equity, 0), ethPrice);
    },

    computeHealth(state: StrategyState): number {
      if (!state.vault) return 10;
      if (state.curX <= 0 || state.curY <= 0) return 0;

      // Infer ethPrice from curve position (marginal price of xy=k)
      const ethPrice = state.curX / state.curY;
      const vault = vaultStateAt(
        state.curX, state.curY,
        state.x0, state.y0,
        state.vault,
      );
      const equity = computeNAV(vault, ethPrice);
      if (equity <= 0) return 0;

      // Collateral / debt ratio. For L=2 at equilibrium: 2E/E = 2.
      const totalValue = vault.xr + vault.yr * ethPrice;
      const totalDebt = vault.xd + vault.yd * ethPrice;
      if (totalDebt <= 0) return 10;
      return totalValue / totalDebt;
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
