/**
 * Unified Simulation Framework for EulerSwap.
 *
 * Runs ammchallenge-style head-to-head simulations between AMM strategies
 * (EulerSwap with pluggable hooks vs xy=k normalizer) on the same price path.
 *
 * Usage: npx tsx scripts/unified-sim.ts
 */

import { PAIRS, type AssetPair } from "../src/lib/sim-pairs";
import {
  eulerSwapStrategy, xyKStrategy,
  DEFAULT_EULER_PARAMS,
  type AMMStrategy,
} from "../src/lib/sim-strategy";
import type { Params } from "../src/lib/math";
import {
  oracleFeeHook, continuousRecenterHook, auctionBackstopHook, compositeHook, staticFeeHook,
} from "../src/lib/sim-hooks";
import { DEFAULT_RETAIL, type RetailConfig } from "../src/lib/sim-retail";
import {
  runSimulation,
  DEFAULT_SIM_CONFIG,
  type EngineConfig, type SimConfig, type StrategyResult, type SimResult,
} from "../src/lib/sim-engine";

// ─── Scenario Definition ─────────────────────────────────────────────

interface Scenario {
  name: string;
  pair: AssetPair;
  strategies: AMMStrategy[];
  sim: SimConfig;
  retail: RetailConfig | null;
  refVenue: { depthUSDC: number; fee: number };
  initialValueUSDC: number;
}

// ─── Prebuilt Hook Configs ───────────────────────────────────────────

function makeOracleHook(pair: AssetPair) {
  return oracleFeeHook({
    baseFee: 0.0005,
    maxFee: 0.05,
    captureRate: 0.5,
    attractRate: 0.003,
    externalFee: pair.uniswapFeeTier,
  });
}

function makeFullHook(pair: AssetPair, rx: number) {
  return compositeHook(
    makeOracleHook(pair),
    continuousRecenterHook({ rx }),
    auctionBackstopHook({
      triggerExposureRatio: 0.70,
      shiftMagnitude: 0.0108,
      decayBpsPerMinute: 21.5,
      clearThreshold: 0.001,
      minAuctionMinutes: 1,
      baseFee: 0.0005,
      refFee: pair.uniswapFeeTier,
      rx,
    }),
  );
}

function makeEulerStrategy(pair: AssetPair, rx: number, hook?: ReturnType<typeof compositeHook>): AMMStrategy {
  return eulerSwapStrategy({
    baseParams: DEFAULT_EULER_PARAMS,
    rx,
    hook: hook ?? makeFullHook(pair, rx),
  });
}

// ─── Output Formatting ───────────────────────────────────────────────

function printHeader(scenario: Scenario) {
  const { pair, sim } = scenario;
  console.log(`\n${'─'.repeat(90)}`);
  console.log(`Scenario: ${scenario.name}`);
  console.log(`Pair: ${pair.name} | Vol: ${(sim.vol * 100).toFixed(0)}% | ${sim.durationDays}d | Equity: $${scenario.initialValueUSDC}`);
  if (scenario.retail) {
    console.log(`Retail: ${scenario.retail.arrivalRate}/hr, mean $${scenario.retail.meanSize} | Ref: ${(scenario.refVenue.fee * 10000).toFixed(0)}bps`);
  } else {
    console.log(`Retail: none (arb only)`);
  }
  console.log('');
}

function printResult(r: StrategyResult, hodlNAV: number) {
  const navPct = ((r.finalNAV / r.initialNAV - 1) * 100).toFixed(1);
  const netFees = r.arbFeeRevenue + r.retailFeeRevenue - r.auctionCost;
  const edgeStr = r.edge >= 0 ? `+$${r.edge.toFixed(0)}` : `-$${Math.abs(r.edge).toFixed(0)}`;

  console.log(
    `  ${r.name.padEnd(28)} ` +
    `NAV $${r.finalNAV.toFixed(0).padStart(6)} (${navPct.padStart(6)}%)  ` +
    `edge=${edgeStr.padStart(7)}  ` +
    `recenters=${String(r.totalRecenters).padStart(3)}  ` +
    `minH=${r.minHealth.toFixed(2)}`
  );
  console.log(
    `${''.padEnd(30)} ` +
    `arbFees=$${r.arbFeeRevenue.toFixed(0).padStart(5)}  ` +
    `retailFees=$${r.retailFeeRevenue.toFixed(0).padStart(5)}  ` +
    `auctionCost=$${r.auctionCost.toFixed(0).padStart(4)}  ` +
    `net=$${netFees.toFixed(0).padStart(5)}  ` +
    `capture=${(r.retailCaptureRate * 100).toFixed(1)}%`
  );
}

function runScenario(scenario: Scenario): SimResult {
  const config: EngineConfig = {
    strategies: scenario.strategies,
    initialValueUSDC: scenario.initialValueUSDC,
    startPrice: 1 / scenario.pair.price,  // Y per X (WETH per USDC)
    sim: scenario.sim,
    retail: scenario.retail,
    refVenue: scenario.refVenue,
    defaultFee: 0.003,  // 30 bps default for strategies without getFee
  };

  printHeader(scenario);
  const result = runSimulation(config);

  for (const r of result.strategies) {
    printResult(r, result.hodlNAV);
  }
  console.log(`  ${'HODL'.padEnd(28)} NAV $${result.hodlNAV.toFixed(0).padStart(6)}`);

  return result;
}

// ─── Main Scenarios ──────────────────────────────────────────────────

function run() {
  const pair = PAIRS["WETH/USDC"];
  const rx = 0.05;
  const equity = 1_000_000;  // $1M per strategy — realistic pool size

  console.log('══════════════════════════════════════════════════════════════════════');
  console.log('  Unified EulerSwap Simulation (ammchallenge-style)');
  console.log('══════════════════════════════════════════════════════════════════════');

  // ── 1. Volatility sweep: EulerSwap full stack vs xy=k normalizer ──

  console.log('\n=== Volatility Sweep: EulerSwap (oracle+recenter+auction) vs xy=k 30bps ===');

  for (const vol of [0.30, 0.45, 0.60, 0.90]) {
    const sim = { ...DEFAULT_SIM_CONFIG, vol };

    // With retail
    runScenario({
      name: `Vol ${(vol * 100).toFixed(0)}% — with retail`,
      pair,
      strategies: [
        makeEulerStrategy(pair, rx),
        xyKStrategy(0.003),
      ],
      sim,
      retail: { ...DEFAULT_RETAIL },
      refVenue: { depthUSDC: 100_000_000, fee: pair.uniswapFeeTier },
      initialValueUSDC: equity,
    });

    // Without retail (arb only)
    runScenario({
      name: `Vol ${(vol * 100).toFixed(0)}% — arb only`,
      pair,
      strategies: [
        makeEulerStrategy(pair, rx),
        xyKStrategy(0.003),
      ],
      sim,
      retail: null,
      refVenue: { depthUSDC: 100_000_000, fee: pair.uniswapFeeTier },
      initialValueUSDC: equity,
    });
  }

  // ── 2. Strategy Library ──────────────────────────────────────────────
  //
  // Systematic comparison building from simple → complex:
  //   A. xy=k baseline (no hooks, no range limits)
  //   B. Unleveraged EulerSwap — same depth as xy=k, varying range + hooks
  //   C. Leveraged EulerSwap — vault borrowing amplifies depth + LVR

  console.log('\n=== Strategy Library (60% vol, $1M equity, 30d, with retail) ===');
  const sim60 = { ...DEFAULT_SIM_CONFIG, vol: 0.60 };

  const UNLEVERAGED_PARAMS: Params = {
    ...DEFAULT_EULER_PARAMS,
    vyx: 0, vxy: 0,  // no leverage — x0 ≈ xr
  };

  // Strategy definitions: [label, AMMStrategy]
  const strategyLib: [string, AMMStrategy][] = [
    // ── A. Baselines ──
    ['A1 xy=k 30bps',
      xyKStrategy(0.003, 'A1 xy=k 30bps')],

    // ── B. Unleveraged, varying range width ──
    // B1: Full range (rx=10), static fee — almost identical to xy=k
    ['B1 wide static 30bps',
      eulerSwapStrategy({ baseParams: UNLEVERAGED_PARAMS, rx: 10, hook: staticFeeHook(0.003) })],
    // B2: Full range, oracle fees
    ['B2 wide oracle',
      eulerSwapStrategy({ baseParams: UNLEVERAGED_PARAMS, rx: 10, hook: makeOracleHook(pair) })],
    // B3–B6: Decreasing range, oracle fees (concentrated liquidity)
    ['B3 rx=0.50 oracle',
      eulerSwapStrategy({ baseParams: UNLEVERAGED_PARAMS, rx: 0.50, hook: makeOracleHook(pair) })],
    ['B4 rx=0.25 oracle',
      eulerSwapStrategy({ baseParams: UNLEVERAGED_PARAMS, rx: 0.25, hook: makeOracleHook(pair) })],
    ['B5 rx=0.10 oracle',
      eulerSwapStrategy({ baseParams: UNLEVERAGED_PARAMS, rx: 0.10, hook: makeOracleHook(pair) })],
    ['B6 rx=0.05 oracle',
      eulerSwapStrategy({ baseParams: UNLEVERAGED_PARAMS, rx: 0.05, hook: makeOracleHook(pair) })],
    // B7: Narrow range, static fee — the Uni V3 problem
    ['B7 rx=0.05 static 30bps',
      eulerSwapStrategy({ baseParams: UNLEVERAGED_PARAMS, rx: 0.05, hook: staticFeeHook(0.003) })],

    // ── C. Leveraged (vault borrowing) ──
    // ── C. Leveraged, narrow range (rx=0.05) — high boost ──
    ['C1 lev rx=0.05 static',
      eulerSwapStrategy({ baseParams: DEFAULT_EULER_PARAMS, rx, hook: staticFeeHook(0.003) })],
    ['C2 lev rx=0.05 oracle',
      eulerSwapStrategy({ baseParams: DEFAULT_EULER_PARAMS, rx, hook: makeOracleHook(pair) })],
    ['C3 lev rx=0.05 full',
      makeEulerStrategy(pair, rx)],

    // ── D. Leveraged, wide range (rx=10) — moderate boost, never out of range ──
    // Varying LTV: lower LTV = less leverage = less LVR amplification
    ...([
      [0.30, 0.30, 'D1 lev30 wide oracle'],
      [0.50, 0.50, 'D2 lev50 wide oracle'],
      [0.70, 0.70, 'D3 lev70 wide oracle'],
      [0.84, 0.85, 'D4 lev84 wide oracle'],
    ] as [number, number, string][]).map(([vyx, vxy, label]) => {
      const p: Params = { ...DEFAULT_EULER_PARAMS, vyx, vxy };
      return [label, eulerSwapStrategy({ baseParams: p, rx: 10, hook: makeOracleHook(pair) })] as [string, AMMStrategy];
    }),
    // D5: Full LTV, wide range, full stack (oracle + recenter + auction)
    ...([
      [0.84, 0.85, 'D5 lev84 wide full'],
    ] as [number, number, string][]).map(([vyx, vxy, label]) => {
      const p: Params = { ...DEFAULT_EULER_PARAMS, vyx, vxy };
      return [label, eulerSwapStrategy({ baseParams: p, rx: 10, hook: makeFullHook(pair, 10) })] as [string, AMMStrategy];
    }),

    // ── E. Range sweep at full LTV with oracle fees ──
    // Find the optimum between wide (low boost, never OOR) and narrow (high boost, high LVR)
    ...([0.03, 0.05, 0.10, 0.15, 0.25, 0.50, 1.0, 2.0, 5.0, 10.0] as number[]).map(rxVal => {
      const label = `E rx=${rxVal < 1 ? rxVal.toFixed(2) : rxVal.toFixed(1)} lev oracle`;
      return [label, eulerSwapStrategy({ baseParams: DEFAULT_EULER_PARAMS, rx: rxVal, hook: makeOracleHook(pair) })] as [string, AMMStrategy];
    }),
  ];

  // Run each strategy head-to-head with xy=k normalizer
  const libResults: { label: string; r: StrategyResult }[] = [];
  let hodlRef = 0;

  for (const [label, strat] of strategyLib) {
    // Override the strategy name with our label
    (strat as any).name = label;
    const config: EngineConfig = {
      strategies: [strat],
      initialValueUSDC: equity,
      startPrice: 1 / pair.price,
      sim: sim60,
      retail: { ...DEFAULT_RETAIL },
      refVenue: { depthUSDC: 100_000_000, fee: pair.uniswapFeeTier },
      defaultFee: 0.003,
    };
    const result = runSimulation(config);
    libResults.push({ label, r: result.strategies[0] });
    hodlRef = result.hodlNAV;
  }

  // ── Summary table ──
  // Decomposition: NAV change = NetFees + ExposurePnL
  //   NetFees    = arb fees + retail fees − auction cost  (strategy alpha)
  //   ExposurePnL = NAV change − NetFees  (directional gains/losses from vault position)
  console.log('\n  Strategy Library Summary (60% vol, $1M, 30d)');
  console.log('  ' + '─'.repeat(130));
  console.log(
    '  ' +
    'Strategy'.padEnd(26) +
    'NAV %'.padStart(7) +
    'NetFee'.padStart(10) +
    'ExpPnL'.padStart(10) +
    'Edge'.padStart(10) +
    'ArbFee'.padStart(10) +
    'RetFee'.padStart(9) +
    'AucCst'.padStart(8) +
    'AvgExp'.padStart(8) +
    'MaxExp'.padStart(8) +
    'MinH'.padStart(7) +
    'Rctr'.padStart(6) +
    'vs HODL'.padStart(9)
  );
  console.log('  ' + '─'.repeat(130));

  for (const { label, r } of libResults) {
    const navPct = ((r.finalNAV / r.initialNAV - 1) * 100).toFixed(1);
    const net = r.arbFeeRevenue + r.retailFeeRevenue - r.auctionCost;
    const navChange = r.finalNAV - r.initialNAV;
    const exposurePnl = navChange - net;  // what the directional position earned/lost
    const vsHodl = r.finalNAV - hodlRef;
    const vsHodlStr = vsHodl >= 0 ? `+$${vsHodl.toFixed(0)}` : `-$${Math.abs(vsHodl).toFixed(0)}`;
    const edgeStr = r.edge >= 0 ? `+$${r.edge.toFixed(0)}` : `-$${Math.abs(r.edge).toFixed(0)}`;
    const expStr = exposurePnl >= 0 ? `+$${exposurePnl.toFixed(0)}` : `-$${Math.abs(exposurePnl).toFixed(0)}`;

    console.log(
      '  ' +
      label.padEnd(26) +
      `${navPct}%`.padStart(7) +
      `$${net.toFixed(0)}`.padStart(10) +
      expStr.padStart(10) +
      edgeStr.padStart(10) +
      `$${r.arbFeeRevenue.toFixed(0)}`.padStart(10) +
      `$${r.retailFeeRevenue.toFixed(0)}`.padStart(9) +
      `$${r.auctionCost.toFixed(0)}`.padStart(8) +
      `${(r.avgExposurePct * 100).toFixed(0)}%`.padStart(8) +
      `${(r.maxExposurePct * 100).toFixed(0)}%`.padStart(8) +
      `${r.minHealth.toFixed(2)}`.padStart(7) +
      `${r.totalRecenters}`.padStart(6) +
      vsHodlStr.padStart(9)
    );
  }
  console.log('  ' + '─'.repeat(130));
  console.log(`  HODL NAV: $${hodlRef.toFixed(0)}  |  NAV change = NetFees + ExposurePnL`);

  // ── 3. Range width sweep ──

  console.log('\n=== Range Width Sweep (60% vol, with retail) ===');
  console.log('  rx    | Strategy     | NAV %  | Edge    | Capture | Net Fees | MinH');
  console.log('  ------|--------------|--------|---------|---------|----------|-----');

  for (const rxVal of [0.05, 0.10, 0.15, 0.25, 0.50]) {
    const config: EngineConfig = {
      strategies: [
        makeEulerStrategy(pair, rxVal),
        xyKStrategy(0.003),
      ],
      initialValueUSDC: equity,
      startPrice: 1 / pair.price,
      sim: sim60,
      retail: { ...DEFAULT_RETAIL },
      refVenue: { depthUSDC: 100_000_000, fee: pair.uniswapFeeTier },
      defaultFee: 0.003,
    };
    const result = runSimulation(config);

    for (const r of result.strategies) {
      const navPct = ((r.finalNAV / r.initialNAV - 1) * 100).toFixed(1);
      const edgeStr = r.edge >= 0 ? `+$${r.edge.toFixed(0)}` : `-$${Math.abs(r.edge).toFixed(0)}`;
      const net = r.arbFeeRevenue + r.retailFeeRevenue - r.auctionCost;
      console.log(
        `  ${rxVal.toFixed(2).padStart(5)} | ${r.name.padEnd(12)} | ${navPct.padStart(5)}% | ${edgeStr.padStart(7)} | ` +
        `${(r.retailCaptureRate * 100).toFixed(1).padStart(6)}% | $${net.toFixed(0).padStart(7)} | ${r.minHealth.toFixed(2)}`
      );
    }
  }

  // ── 4. Asset pair comparison ──

  console.log('\n=== Asset Pair Comparison (full stack, with retail) ===');

  for (const pairName of ["WETH/USDC", "WBTC/WETH", "USDC/USDT", "wstETH/WETH"]) {
    const p = PAIRS[pairName];
    const pairRx = pairName === "USDC/USDT" || pairName === "wstETH/WETH" ? 0.01 : 0.05;
    const pairEquity = equity;  // same NAV for all pairs — apples to apples

    runScenario({
      name: `${p.name} — full stack`,
      pair: p,
      strategies: [
        makeEulerStrategy(p, pairRx),
        xyKStrategy(0.003),
      ],
      sim: { ...DEFAULT_SIM_CONFIG, vol: p.vol },
      retail: {
        arrivalRate: p.typicalRetail.arrivalRate,
        meanSize: p.typicalRetail.meanSize,
        sizeSigma: 1.2,
        buyProb: 0.5,
      },
      refVenue: { depthUSDC: 100_000_000, fee: p.uniswapFeeTier },
      initialValueUSDC: pairEquity,
    });
  }

  // ── 5. Attract scale sweep ──

  console.log('\n=== Attract Scale Sweep (60% vol, rx=0.25, with retail) ===');
  console.log('  Attract | EulerSwap NAV% | Capture | Retail Fees | Net Fees');
  console.log('  --------|---------------|---------|-------------|--------');

  for (const scale of [0, 0.001, 0.003, 0.005, 0.010, 0.020]) {
    const hook = compositeHook(
      oracleFeeHook({
        baseFee: 0.0005,
        maxFee: 0.05,
        captureRate: 0.5,
        attractRate: scale,
        externalFee: pair.uniswapFeeTier,
      }),
      continuousRecenterHook({ rx: 0.25 }),
      auctionBackstopHook({
        triggerExposureRatio: 0.70,
        shiftMagnitude: 0.0108,
        decayBpsPerMinute: 21.5,
        clearThreshold: 0.001,
        minAuctionMinutes: 1,
        baseFee: 0.0005,
        refFee: pair.uniswapFeeTier,
        rx: 0.25,
      }),
    );

    const config: EngineConfig = {
      strategies: [eulerSwapStrategy({ baseParams: DEFAULT_EULER_PARAMS, rx: 0.25, hook })],
      initialValueUSDC: equity,
      startPrice: 1 / pair.price,
      sim: sim60,
      retail: { ...DEFAULT_RETAIL },
      refVenue: { depthUSDC: 100_000_000, fee: pair.uniswapFeeTier },
      defaultFee: 0.003,
    };
    const result = runSimulation(config);
    const r = result.strategies[0];
    const navPct = ((r.finalNAV / r.initialNAV - 1) * 100).toFixed(1);
    const net = r.arbFeeRevenue + r.retailFeeRevenue - r.auctionCost;

    console.log(
      `  ${(scale * 10000).toFixed(0).padStart(5)}bps | ${navPct.padStart(12)}% | ` +
      `${(r.retailCaptureRate * 100).toFixed(1).padStart(6)}% | ` +
      `$${r.retailFeeRevenue.toFixed(0).padStart(11)} | ` +
      `$${net.toFixed(0).padStart(7)}`
    );
  }
}

run();
