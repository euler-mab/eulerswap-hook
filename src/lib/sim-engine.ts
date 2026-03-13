/**
 * Unified simulation engine for EulerSwap.
 *
 * Runs N strategies head-to-head on the same GBM price path with
 * optimal retail routing. Tracks NAV, fees, edge, exposure, health.
 */

import { mulberry32, generatePricePath } from "./simulate";
import type {
  AMMStrategy, StrategyState, SimHook,
  FeeContext, AfterSwapContext, SwapContext,
  VaultState, ResultAccumulators,
} from "./sim-strategy";
import { vaultStateAt, computeNAV, computeExposure } from "./sim-strategy";
import { poissonSample, lognormalSample, routeBestVenue, type RetailConfig, type QuoteVenue } from "./sim-retail";

// ─── Config ──────────────────────────────────────────────────────────

export interface SimConfig {
  vol: number;
  drift: number;
  durationDays: number;
  stepsPerDay: number;
  seed: number;
}

export const DEFAULT_SIM_CONFIG: SimConfig = {
  vol: 0.60,
  drift: 0.0,
  durationDays: 30,
  stepsPerDay: 24,
  seed: 42,
};

export interface EngineConfig {
  /** Strategies to run head-to-head on the same price path */
  strategies: AMMStrategy[];
  /** Initial value in USDC for each strategy */
  initialValueUSDC: number;
  /** Starting price (Y per X, e.g. 1/1986 for USDC/WETH) */
  startPrice: number;
  /** Simulation parameters */
  sim: SimConfig;
  /** Retail flow (null = arb only) */
  retail: RetailConfig | null;
  /** Reference venue for routing (depth per side in USDC, fee) */
  refVenue: { depthUSDC: number; fee: number };
  /** Static fee for strategies without getFee hook */
  defaultFee: number;
}

// ─── Results ─────────────────────────────────────────────────────────

export interface StrategyResult {
  name: string;
  initialNAV: number;
  finalNAV: number;
  arbFeeRevenue: number;
  retailFeeRevenue: number;
  retailVolume: number;
  retailOrders: number;
  retailCaptureRate: number;
  totalRetailGenerated: number;
  arbVolume: number;
  /** ammchallenge-style edge: Σ(amountX × fairPrice − amountY) across all trades */
  edge: number;
  totalRecenters: number;
  totalAuctions: number;
  auctionCost: number;
  maxExposurePct: number;
  avgExposurePct: number;
  minHealth: number;
}

export interface SimResult {
  strategies: StrategyResult[];
  hodlNAV: number;
  pricePath: number[];
}

// ─── Per-Strategy Runtime State ──────────────────────────────────────

interface StrategyRuntime {
  strategy: AMMStrategy;
  state: StrategyState;
  initialNAV: number;
  arbFeeRevenue: number;
  retailFeeRevenue: number;
  retailVolume: number;
  retailOrders: number;
  totalRetailGenerated: number;
  arbVolume: number;
  edge: number;
  accum: ResultAccumulators;
  maxExposurePct: number;
  sumExposurePct: number;
  minHealth: number;
}

// ─── Engine ──────────────────────────────────────────────────────────

export function runSimulation(config: EngineConfig): SimResult {
  const { strategies, sim, retail, refVenue, defaultFee } = config;
  const n = sim.durationDays * sim.stepsPerDay;

  // Generate price path (Y per X, e.g. 1/1986 for USDC/WETH)
  const simConfig = { ...sim, feeBps: 0 };  // feeBps not used by generatePricePath
  const pricePath = generatePricePath(config.startPrice, { ...simConfig, feeBps: 0 });

  // HODL NAV baseline (initial USDC value, no trading)
  const hodlInitialUSDC = config.initialValueUSDC;

  // Initialize all strategies
  const runtimes: StrategyRuntime[] = strategies.map(strat => {
    const state = strat.init(config.initialValueUSDC, 0, 1 / config.startPrice);
    // Compute initial NAV
    const ethPrice0 = 1 / config.startPrice;
    let initialNAV: number;
    if (state.vault) {
      initialNAV = computeNAV(state.vault, ethPrice0);
    } else {
      // xy=k: NAV = x + y * ethPrice
      initialNAV = state.curX + state.curY * ethPrice0;
    }

    return {
      strategy: strat,
      state,
      initialNAV,
      arbFeeRevenue: 0,
      retailFeeRevenue: 0,
      retailVolume: 0,
      retailOrders: 0,
      totalRetailGenerated: 0,
      arbVolume: 0,
      edge: 0,
      accum: { totalRecenters: 0, totalAuctions: 0, auctionCost: 0 },
      maxExposurePct: 0,
      sumExposurePct: 0,
      minHealth: 10,
    };
  });

  // Separate RNG for retail (reproducible regardless of arb path)
  const retailRng = mulberry32(sim.seed + 1000);

  // ─── Main Loop ───────────────────────────────────────────────────

  for (let i = 1; i <= n; i++) {
    const extPrice = pricePath[i];    // Y per X (e.g. 1/1986 for USDC/WETH)
    const ethPrice = 1 / extPrice;    // USDC per WETH

    // ── Phase 1: Arb each strategy independently ──────────────────

    for (const rt of runtimes) {
      const { strategy, state } = rt;
      const hook = strategy.hook;

      // beforeSwap gate
      if (hook?.beforeSwap) {
        const ctx: SwapContext = { state, extPrice, ethPrice, isArb: true };
        if (!hook.beforeSwap(ctx)) continue;
      }

      const pEquil = state.pEquil;
      const priceOffset = Math.abs(extPrice - pEquil) / pEquil;

      // Get arb fee
      let arbFee = defaultFee;
      if (hook?.getFee) {
        const vault = getVault(state);
        const nav = vault ? computeNAV(vault, ethPrice) : (state.curX + state.curY * ethPrice);
        const exposure = vault ? computeExposure(vault, ethPrice) : 0;
        const exposureFrac = nav > 0 ? exposure / nav : 0;

        const feeCtx: FeeContext = {
          asset0IsInput: extPrice < pEquil,
          state,
          extPrice,
          ethPrice,
          isArb: true,
          isExposureReducing: false,  // arb is never exposure-reducing by convention
          priceOffset,
          exposureFrac,
        };
        const hookFee = hook.getFee(feeCtx);
        if (hookFee !== null) arbFee = hookFee;
      }

      const arbGamma = 1 - arbFee;
      if (arbGamma <= 0) continue;

      // Fee-adjusted target price
      let targetPrice: number;
      let shouldArb = false;
      if (extPrice > pEquil) {
        targetPrice = arbGamma * extPrice;
        shouldArb = targetPrice > pEquil;
      } else if (extPrice < pEquil) {
        targetPrice = extPrice / arbGamma;
        shouldArb = targetPrice < pEquil;
      } else {
        continue;  // at equilibrium
      }

      if (!shouldArb) continue;

      const preX = state.curX;
      const preY = state.curY;

      // Solve for target position
      const target = strategy.curve.solveForPrice(state, targetPrice);
      if (!target) continue;

      state.curX = target.x;
      state.curY = target.y;

      const arbDx = Math.abs(state.curX - preX);
      rt.arbVolume += arbDx;

      // Edge: pure trade impact (LVR). Computed BEFORE fee deposit so it's
      // consistent between EulerSwap (fee→vault) and xy=k (fee→reserves).
      rt.edge += computeEdge(preX, preY, state.curX, state.curY, ethPrice);

      // Arb fee revenue: fee = netInput × (1−γ)/γ
      // Fee is deposited into vault supply (EulerSwap) or reserves (xy=k)
      if (arbDx > 0.01 && arbGamma > 0 && arbGamma < 1) {
        const feeMultiplier = (1 - arbGamma) / arbGamma;
        if (extPrice > pEquil) {
          // Arb buys X → sends Y (net Y input). Fee in Y terms.
          const dyNet = Math.max(state.curY - preY, 0);
          const feeY = dyNet * feeMultiplier;
          rt.arbFeeRevenue += feeY * ethPrice;
          if (state.vault) {
            state.vault.yr += feeY;  // deposit fee into vault supply
          } else {
            state.curY += feeY;  // grow reserves (like Uni V2)
          }
        } else {
          // Arb sells X → sends X (net X input). Fee in X terms.
          const dxNet = Math.max(state.curX - preX, 0);
          const feeX = dxNet * feeMultiplier;
          rt.arbFeeRevenue += feeX;
          if (state.vault) {
            state.vault.xr += feeX;  // deposit fee into vault supply
          } else {
            state.curX += feeX;  // grow reserves (like Uni V2)
          }
        }
      }

      // afterSwap callback
      if (hook?.afterSwap) {
        const afterCtx = makeAfterSwapCtx(
          state, preX, preY, arbFee, extPrice, ethPrice, true, rt.accum,
        );
        hook.afterSwap(afterCtx);
        if (afterCtx.reconfiguredState) {
          Object.assign(rt.state, afterCtx.reconfiguredState);
        }
      }

    }

    // ── Phase 2: Retail orders ────────────────────────────────────

    if (retail && retail.arrivalRate > 0) {
      const nOrders = poissonSample(retailRng, retail.arrivalRate);

      for (let j = 0; j < nOrders; j++) {
        const orderSize = lognormalSample(retailRng, retail.meanSize, retail.sizeSigma);
        const isBuyX = retailRng() < retail.buyProb;

        // Track total retail generated across all strategies
        for (const rt of runtimes) {
          rt.totalRetailGenerated += orderSize;
        }

        // Quote each venue: compute effective price (output per input after fee)
        // and pick the best one. For small orders vs deep pools, marginal price
        // is a good proxy — no need for full executeSwap quote.
        const quoteVenues: QuoteVenue[] = [];
        const venueFees: number[] = [];

        for (const rt of runtimes) {
          const { strategy, state } = rt;
          const hook = strategy.hook;
          const pEquil = state.pEquil;
          const priceOffset = Math.abs(extPrice - pEquil) / pEquil;

          // Compute fee for this direction
          let fee = defaultFee;
          if (hook?.getFee) {
            const vault = getVault(state);
            const nav = vault ? computeNAV(vault, ethPrice) : (state.curX + state.curY * ethPrice);
            const exposure = vault ? computeExposure(vault, ethPrice) : 0;
            const exposureFrac = nav > 0 ? exposure / nav : 0;
            const wethNet = vault ? (vault.yr - vault.yd) : 0;
            const isReducing = isBuyX ? (wethNet > 0) : (wethNet < 0);

            const feeCtx: FeeContext = {
              asset0IsInput: !isBuyX,
              state,
              extPrice,
              ethPrice,
              isArb: false,
              isExposureReducing: isReducing,
              priceOffset,
              exposureFrac,
            };
            const hookFee = hook.getFee(feeCtx);
            if (hookFee !== null) fee = hookFee;
          }

          venueFees.push(fee);

          // Marginal price = Y per X at current cursor position
          const mp = strategy.curve.marginalPrice(state);
          const gamma = 1 - fee;

          if (isBuyX) {
            // Trader sends Y (WETH), receives X (USDC).
            // Effective price = X output per Y input = (1/mp) × γ
            // Higher = better for trader (more USDC per WETH).
            quoteVenues.push({
              effectivePrice: mp > 0 ? gamma / mp : 0,
              available: gamma > 0 && mp > 0,
            });
          } else {
            // Trader sends X (USDC), receives Y (WETH).
            // Effective price = Y output per X input = mp × γ
            // Higher = better for trader (more WETH per USDC).
            quoteVenues.push({
              effectivePrice: mp > 0 ? mp * gamma : 0,
              available: gamma > 0 && mp > 0,
            });
          }
        }

        // Reference venue: xy=k at fair price with refVenue.fee
        const refGamma = 1 - refVenue.fee;
        if (isBuyX) {
          // ref marginal price = extPrice (Y per X), effective = γ / mp
          quoteVenues.push({
            effectivePrice: refGamma / extPrice,
            available: true,
          });
        } else {
          quoteVenues.push({
            effectivePrice: extPrice * refGamma,
            available: true,
          });
        }

        // Route to best venue
        const bestIdx = routeBestVenue(quoteVenues);
        if (bestIdx < 0 || bestIdx >= runtimes.length) continue;  // went to ref venue or none

        // Execute on the winning strategy
        const rt = runtimes[bestIdx];
        const { strategy, state } = rt;
        const fee = venueFees[bestIdx];
        const preX = state.curX;
        const preY = state.curY;

        const result = strategy.curve.executeSwap(state, isBuyX, orderSize, ethPrice, fee);

        if (result.executed) {
          state.curX = result.newCurX;
          state.curY = result.newCurY;
          if (result.newVault && state.vault) {
            Object.assign(state.vault, result.newVault);
          }

          // Edge: pure trade impact. Computed before fee deposit.
          rt.edge += computeEdge(preX, preY, state.curX, state.curY, ethPrice);

          // Deposit fee into vault supply (EulerSwap) or reserves (xy=k)
          if (result.feeRevenue > 0) {
            if (isBuyX) {
              const feeY = result.feeRevenue / ethPrice;
              if (state.vault) {
                state.vault.yr += feeY;
              } else {
                state.curY += feeY;
              }
            } else {
              const feeX = result.feeRevenue;
              if (state.vault) {
                state.vault.xr += feeX;
              } else {
                state.curX += feeX;
              }
            }
          }

          rt.retailFeeRevenue += result.feeRevenue;
          rt.retailVolume += orderSize;
          rt.retailOrders++;

          // afterSwap callback
          if (strategy.hook?.afterSwap) {
            const afterCtx = makeAfterSwapCtx(
              state, preX, preY, fee, extPrice, ethPrice, false, rt.accum,
            );
            strategy.hook.afterSwap(afterCtx);
            if (afterCtx.reconfiguredState) {
              Object.assign(rt.state, afterCtx.reconfiguredState);
            }
          }
        }
      }
    }

    // ── Phase 3: Per-step metrics (once per step, all strategies) ──
    for (const rt of runtimes) {
      trackMetrics(rt, ethPrice);
    }
  }

  // ─── Final Results ─────────────────────────────────────────────

  const finalExtPrice = pricePath[n];
  const finalEthPrice = 1 / finalExtPrice;

  const results: StrategyResult[] = runtimes.map(rt => {
    let finalNAV: number;
    if (rt.state.vault) {
      const vault = vaultStateAt(
        rt.state.curX, rt.state.curY,
        rt.state.x0, rt.state.y0,
        rt.state.vault,
      );
      finalNAV = computeNAV(vault, finalEthPrice);
    } else {
      finalNAV = rt.state.curX + rt.state.curY * finalEthPrice;
    }

    return {
      name: rt.strategy.name,
      initialNAV: rt.initialNAV,
      finalNAV,
      arbFeeRevenue: rt.arbFeeRevenue,
      retailFeeRevenue: rt.retailFeeRevenue,
      retailVolume: rt.retailVolume,
      retailOrders: rt.retailOrders,
      retailCaptureRate: rt.totalRetailGenerated > 0
        ? rt.retailVolume / rt.totalRetailGenerated
        : 0,
      totalRetailGenerated: rt.totalRetailGenerated,
      arbVolume: rt.arbVolume,
      edge: rt.edge,
      totalRecenters: rt.accum.totalRecenters,
      totalAuctions: rt.accum.totalAuctions,
      auctionCost: rt.accum.auctionCost,
      maxExposurePct: rt.maxExposurePct,
      avgExposurePct: n > 0 ? rt.sumExposurePct / n : 0,
      minHealth: rt.minHealth,
    };
  });

  // HODL: hold initial 50/50 portfolio (half USDC, half WETH at starting price)
  const ethPrice0 = 1 / config.startPrice;
  const hodlUSDC = config.initialValueUSDC / 2;
  const hodlWETH = hodlUSDC / ethPrice0;
  const hodlNAV = hodlUSDC + hodlWETH * finalEthPrice;

  return { strategies: results, hodlNAV, pricePath };
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Net USDC-equivalent value the LP gained from a trade.
 *  Positive = LP profited (fee revenue). Negative = LP lost value. */
function computeEdge(preX: number, preY: number, newX: number, newY: number, ethPrice: number): number {
  const dxIn = Math.max(newX - preX, 0);
  const dyIn = Math.max(newY - preY, 0);
  const dxOut = Math.max(preX - newX, 0);
  const dyOut = Math.max(preY - newY, 0);
  return (dxIn + dyIn * ethPrice) - (dxOut + dyOut * ethPrice);
}

function getVault(state: StrategyState): VaultState | null {
  if (!state.vault) return null;
  return vaultStateAt(state.curX, state.curY, state.x0, state.y0, state.vault);
}

function trackMetrics(rt: StrategyRuntime, ethPrice: number): void {
  if (rt.state.vault) {
    const vault = getVault(rt.state)!;
    const nav = computeNAV(vault, ethPrice);
    const exposure = computeExposure(vault, ethPrice);
    const exposurePct = nav > 0 ? exposure / nav : 0;
    if (exposurePct > rt.maxExposurePct) rt.maxExposurePct = exposurePct;
    rt.sumExposurePct += exposurePct;
  }

  const health = rt.strategy.computeHealth(rt.state);
  if (health < rt.minHealth) rt.minHealth = health;
}

function makeAfterSwapCtx(
  state: StrategyState,
  preX: number, preY: number,
  fee: number,
  extPrice: number, ethPrice: number,
  isArb: boolean,
  accum: ResultAccumulators,
): AfterSwapContext {
  const dx = state.curX - preX;
  const dy = state.curY - preY;

  return {
    state,
    amount0In: Math.max(dx, 0),
    amount1In: Math.max(dy, 0),
    amount0Out: Math.max(-dx, 0),
    amount1Out: Math.max(-dy, 0),
    fee,
    extPrice,
    ethPrice,
    isArb,
    reconfiguredState: null,
    accum,
  };
}
