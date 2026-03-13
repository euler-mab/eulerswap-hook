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

  // ── 2. Hook comparison: static vs oracle vs full stack ──

  console.log('\n=== Hook Comparison (60% vol, with retail) ===');
  const sim60 = { ...DEFAULT_SIM_CONFIG, vol: 0.60 };

  runScenario({
    name: 'Static 30bps vs xy=k 30bps',
    pair,
    strategies: [
      eulerSwapStrategy({ baseParams: DEFAULT_EULER_PARAMS, rx, hook: staticFeeHook(0.003) }),
      xyKStrategy(0.003),
    ],
    sim: sim60,
    retail: { ...DEFAULT_RETAIL },
    refVenue: { depthUSDC: 100_000_000, fee: pair.uniswapFeeTier },
    initialValueUSDC: equity,
  });

  runScenario({
    name: 'Oracle fees only vs xy=k 30bps',
    pair,
    strategies: [
      eulerSwapStrategy({ baseParams: DEFAULT_EULER_PARAMS, rx, hook: makeOracleHook(pair) }),
      xyKStrategy(0.003),
    ],
    sim: sim60,
    retail: { ...DEFAULT_RETAIL },
    refVenue: { depthUSDC: 100_000_000, fee: pair.uniswapFeeTier },
    initialValueUSDC: equity,
  });

  runScenario({
    name: 'Full stack vs xy=k 30bps',
    pair,
    strategies: [
      makeEulerStrategy(pair, rx),
      xyKStrategy(0.003),
    ],
    sim: sim60,
    retail: { ...DEFAULT_RETAIL },
    refVenue: { depthUSDC: 100_000_000, fee: pair.uniswapFeeTier },
    initialValueUSDC: equity,
  });

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
