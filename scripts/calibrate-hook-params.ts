/**
 * Hook parameter calibration script (V8).
 *
 * Derives auction, fee, surcharge, trigger, and timing parameters from first
 * principles for a specific pool's equity, virtual depth, and oracle source.
 *
 * V8 changes from V7:
 *   - σ₁ explicit derivation from annual vol (D ≈ σ₁)
 *   - k parameter computation (startingFee = premium + k × D)
 *   - Reserve-based clearThreshold (fraction, not price bps)
 *   - auctionTimeout, minAuctionInterval, maxSnapshotInterval
 *   - Oracle guard multiplier (g)
 *   - Prints V8-ready AuctionConfig struct output
 *
 * Usage:
 *   npx tsx scripts/calibrate-hook-params.ts
 *
 * This script should be run BEFORE every hook deployment or parameter update
 * to verify all values are appropriate for the target pool.
 */

const WAD = 10n ** 18n;
const BLOCKS_PER_YEAR = 2_628_000; // ~12s blocks

// ─── Pool configurations ───────────────────────────────────────────────

interface PoolProfile {
  name: string;
  /** Actual equity in quote asset (USD terms) */
  equity: number;
  /** Virtual eq reserve 0 (human units, quote asset) */
  eq0: number;
  /** Virtual eq reserve 1 (human units, base asset) */
  eq1: number;
  /** Concentration X (0-1, typically 0 for range-based) */
  cx: number;
  /** Concentration Y (0-1, typically 0 for range-based) */
  cy: number;
  /** Oracle type */
  oracle: "v3" | "v4";
  /** Oracle fee tier in bps (for estimating noise) */
  oracleFeeBps: number;
  /** Asset pair volatility class */
  volatility: "stablecoin" | "moderate" | "high";
  /** Annualized volatility (decimal, e.g. 0.70 = 70%) */
  annualVol: number;
  /** Current auction trigger threshold (WAD) */
  auctionTriggerThreshold: number;
  /** Range parameter (WAD) */
  recenterRange: number;
}

const pools: PoolProfile[] = [
  {
    name: "USDC/WETH",
    equity: 8_000,
    eq0: 624_000,
    eq1: 301,
    cx: 0,
    cy: 0,
    oracle: "v3",
    oracleFeeBps: 5,
    volatility: "moderate",
    annualVol: 0.70, // 70%
    auctionTriggerThreshold: 0.5, // 50%
    recenterRange: 0.05, // 5% = 500 bps
  },
  {
    name: "USDC/USDT",
    equity: 500,
    eq0: 247_596_387,
    eq1: 242_338_099,
    cx: 0,
    cy: 0,
    oracle: "v4",
    oracleFeeBps: 0.08,
    volatility: "stablecoin",
    annualVol: 0.0005, // 0.05%
    auctionTriggerThreshold: 0.5, // 50%
    recenterRange: 0.0001, // 1 bps
  },
];

// ─── Oracle noise estimates ────────────────────────────────────────────

function estimateOracleNoise(pool: PoolProfile): number {
  if (pool.volatility === "stablecoin") {
    if (pool.oracle === "v4") return 0.01;
    return 0.05;
  }
  if (pool.volatility === "moderate") {
    return Math.max(0.5, pool.oracleFeeBps * 0.1);
  }
  return Math.max(2, pool.oracleFeeBps * 0.2);
}

// ─── Calibration ───────────────────────────────────────────────────────

function calibrate(pool: PoolProfile) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  ${pool.name} — V8 Hook Parameter Calibration`);
  console.log(`${"=".repeat(70)}\n`);

  const leverage = pool.eq0 / pool.equity;
  const priceSensitivityPerDollar = 2 / pool.eq0;

  // ── σ₁ derivation ─────────────────────────────────────────────────
  const sigma1 = pool.annualVol / Math.sqrt(BLOCKS_PER_YEAR);
  const sigma1Bps = sigma1 * 1e4;

  console.log("Pool characteristics:");
  console.log(`  Equity:           $${pool.equity.toLocaleString()}`);
  console.log(`  Virtual depth:    $${pool.eq0.toLocaleString()} / ${pool.eq1.toLocaleString()}`);
  console.log(`  Leverage:         ${leverage.toLocaleString("en", { maximumFractionDigits: 0 })}x`);
  console.log(`  Annual vol:       ${(pool.annualVol * 100).toFixed(2)}%`);
  console.log(`  σ₁ (per-block):   ${sigma1Bps.toFixed(4)} bps`);
  console.log(`  Oracle:           ${pool.oracle.toUpperCase()} (${pool.oracleFeeBps} bps fee)`);
  console.log();

  // Variance drain viability check
  const halfLifeBlocks = Math.log(2) * 8 / (leverage * pool.annualVol ** 2 / BLOCKS_PER_YEAR);
  const halfLifeDays = halfLifeBlocks * 12 / 86400;
  console.log("Variance drain:");
  console.log(`  Half-life:        ${halfLifeDays.toFixed(0)} days (${(halfLifeBlocks / BLOCKS_PER_YEAR).toFixed(1)} years)`);
  if (halfLifeDays < 30) {
    console.log(`  ⚠ WARNING: Half-life < 30 days. Pool may not be viable without high volume.`);
  }
  console.log();

  // ── D = σ₁ (decayPerBlock) ────────────────────────────────────────
  const decayPerBlockBps = sigma1Bps;
  const decayPerBlockWad = BigInt(Math.round(decayPerBlockBps * 1e14));

  // ── k (margin blocks) ─────────────────────────────────────────────
  let kMarginBlocks: number;
  if (pool.volatility === "stablecoin") kMarginBlocks = 250;
  else if (pool.volatility === "moderate") kMarginBlocks = 15;
  else kMarginBlocks = 10;

  const startingFeeMarginBps = kMarginBlocks * decayPerBlockBps;
  console.log(`Starting fee formula: premium + k × D`);
  console.log(`  k:                ${kMarginBlocks} blocks`);
  console.log(`  k × D margin:     ${startingFeeMarginBps.toFixed(4)} bps`);
  console.log();

  // ── Trigger / exposure parameters ─────────────────────────────────
  const triggerExposure = pool.equity * pool.auctionTriggerThreshold;
  const triggerExposureBps = (triggerExposure / pool.eq0) * 1e4; // as fraction of pool depth

  console.log(`Trigger (${pool.auctionTriggerThreshold * 100}% NAV = $${triggerExposure.toLocaleString()}):`);
  console.log(`  As % of pool depth: ${triggerExposureBps.toFixed(4)} bps`);
  console.log();

  // ── Clear threshold (V8: reserve-based, not price-based) ──────────
  // V8 uses fraction of clearing amount remaining (0.1 = 10% remaining = 90% cleared)
  const clearThresholdFraction = 0.1; // 10% remaining
  const clearThresholdWad = BigInt(Math.round(clearThresholdFraction * 1e18));

  // ── Min auction blocks ─────────────────────────────────────────────
  // startingFee / D / 2 ≈ (k*D + premium) / D / 2 ≈ k/2 + premium/(2*D)
  // Approximate with k/2 as minimum
  const minAuctionBlocks = Math.max(12, Math.round(kMarginBlocks / 2));

  // ── Auction timeout ────────────────────────────────────────────────
  // 3 × (startingFee / D) ≈ 3 × (k + premium/D)
  // Conservative: 3 × k + generous buffer
  let auctionTimeout: number;
  if (pool.volatility === "stablecoin") auctionTimeout = 1500; // ~5 hours
  else if (pool.volatility === "moderate") auctionTimeout = 500; // ~100 min
  else auctionTimeout = 300; // ~60 min

  // ── Min auction interval (cooldown) ────────────────────────────────
  const minAuctionInterval = minAuctionBlocks * 2;

  // ── Max snapshot interval (time-based trigger) ─────────────────────
  let maxSnapshotInterval: number;
  if (pool.volatility === "stablecoin") maxSnapshotInterval = 21600; // ~72h
  else if (pool.volatility === "moderate") maxSnapshotInterval = 7200; // ~24h
  else maxSnapshotInterval = 3600; // ~12h

  // ── Oracle guard multiplier ────────────────────────────────────────
  const oracleGuardMultiplier = 3; // 3-sigma = 99.7% confidence
  const guardAt25Blocks = oracleGuardMultiplier * decayPerBlockBps * Math.sqrt(25);
  const guardAt100Blocks = oracleGuardMultiplier * decayPerBlockBps * Math.sqrt(100);

  console.log("Auction timing:");
  console.log(`  decayPerBlock (D): ${decayPerBlockWad} (${decayPerBlockBps.toFixed(4)} bps/block = σ₁)`);
  console.log(`  minAuctionBlocks:  ${minAuctionBlocks}`);
  console.log(`  minAuctionInterval: ${minAuctionInterval} (cooldown)`);
  console.log(`  auctionTimeout:    ${auctionTimeout}`);
  console.log(`  clearThreshold:    ${clearThresholdFraction * 100}% remaining (${clearThresholdWad})`);
  console.log();

  console.log("Oracle guard (g=3):");
  console.log(`  At 25 blocks:  ${guardAt25Blocks.toFixed(4)} bps threshold`);
  console.log(`  At 100 blocks: ${guardAt100Blocks.toFixed(4)} bps threshold`);
  console.log(`  maxSnapshotInterval: ${maxSnapshotInterval} blocks`);
  console.log();

  // ── Fee parameters ─────────────────────────────────────────────────
  const externalFeeBps = pool.oracleFeeBps;
  const externalFeeWad = BigInt(Math.round(externalFeeBps * 1e14));

  let baseFeeBps: number;
  if (pool.volatility === "stablecoin") baseFeeBps = 0.05;
  else if (pool.volatility === "moderate") baseFeeBps = 5;
  else baseFeeBps = 10;
  const baseFeeWad = BigInt(Math.round(baseFeeBps * 1e14));

  let maxFeeBps: number;
  if (pool.volatility === "stablecoin") maxFeeBps = 50;
  else if (pool.volatility === "moderate") maxFeeBps = 3500;
  else maxFeeBps = 5000;
  const maxFeeWad = BigInt(Math.round(maxFeeBps * 1e14));

  let gasCoeffWad = 0n;
  if (pool.volatility !== "stablecoin") {
    gasCoeffWad = 65400000000n; // 6.54e10
  }

  let captureRate = 0.8; // 80%
  let attractRate = pool.volatility === "stablecoin" ? 0.5 : 0.3;

  console.log("Fee parameters:");
  console.log(`  baseFee:       ${baseFeeWad} (${baseFeeBps} bps)`);
  console.log(`  maxFee:        ${maxFeeWad} (${maxFeeBps} bps)`);
  console.log(`  externalFee:   ${externalFeeWad} (${externalFeeBps} bps)`);
  console.log(`  gasCoeff:      ${gasCoeffWad}`);
  console.log(`  captureRate:   ${captureRate * 100}%`);
  console.log(`  attractRate:   ${attractRate * 100}%`);
  console.log();

  // ── Surcharge parameters ───────────────────────────────────────────
  let deploySurchargeBps: number;
  if (pool.volatility === "stablecoin") deploySurchargeBps = 5;
  else if (pool.volatility === "moderate") deploySurchargeBps = 500;
  else deploySurchargeBps = 1000;
  const deploySurchargeWad = BigInt(Math.round(deploySurchargeBps * 1e14));

  const surchargeDecayBlocks = 100; // ~20 minutes
  const surchargeDecayBps = deploySurchargeBps / surchargeDecayBlocks;
  const surchargeDecayWad = BigInt(Math.round(surchargeDecayBps * 1e14));

  let surchargeMultiplier: number;
  if (pool.volatility === "stablecoin") surchargeMultiplier = 2.5;
  else surchargeMultiplier = 1.25;

  console.log("Surcharge parameters:");
  console.log(`  deploySurcharge:       ${deploySurchargeWad} (${deploySurchargeBps} bps)`);
  console.log(`  surchargeDecayPerBlock: ${surchargeDecayWad} (${surchargeDecayBps.toFixed(4)} bps/block)`);
  console.log(`  surchargeMultiplier:   ${surchargeMultiplier}x`);
  console.log(`  Deploy decay time:     ${surchargeDecayBlocks} blocks (~${Math.round(surchargeDecayBlocks * 12 / 60)} min)`);
  console.log();

  // ── Recenter parameters ────────────────────────────────────────────
  let maxRecenterDriftBps: number;
  if (pool.volatility === "stablecoin") maxRecenterDriftBps = 1; // 1 bps
  else if (pool.volatility === "moderate") maxRecenterDriftBps = 300; // 3%
  else maxRecenterDriftBps = 500; // 5%

  let minRecenterDeltaBps: number;
  if (pool.volatility === "stablecoin") minRecenterDeltaBps = 0.5; // 0.5 bps
  else minRecenterDeltaBps = 0;

  // ═══════════════════════════════════════════════════════════════════
  // V8 AuctionConfig output
  // ═══════════════════════════════════════════════════════════════════

  console.log("─".repeat(70));
  console.log("V8 AuctionConfig struct values:");
  console.log(`  decayPerBlock:          ${decayPerBlockWad}`);
  console.log(`  auctionTriggerThreshold: ${BigInt(Math.round(pool.auctionTriggerThreshold * 1e18))}`);
  console.log(`  clearThreshold:         ${clearThresholdWad}`);
  console.log(`  minAuctionBlocks:       ${minAuctionBlocks}`);
  console.log(`  minAuctionInterval:     ${minAuctionInterval}`);
  console.log(`  auctionTimeout:         ${auctionTimeout}`);
  console.log(`  kMarginBlocks:          ${kMarginBlocks}`);
  console.log(`  oracleGuardMultiplier:  ${BigInt(Math.round(oracleGuardMultiplier * 1e18))}`);
  console.log(`  maxSnapshotInterval:    ${maxSnapshotInterval}`);
  console.log(`  recenterRange:          ${BigInt(Math.round(pool.recenterRange * 1e18))}`);
  console.log(`  maxRecenterDrift:       ${BigInt(Math.round(maxRecenterDriftBps * 1e14))}`);
  console.log(`  minRecenterDelta:       ${BigInt(Math.round(minRecenterDeltaBps * 1e14))}`);
  console.log(`  surchargeDecayPerBlock: ${surchargeDecayWad}`);
  console.log(`  surchargeMultiplier:    ${BigInt(Math.round(surchargeMultiplier * 1e18))}`);
  console.log(`  deploySurcharge:        ${deploySurchargeWad}`);
  console.log();
  console.log("V8 FeeConfig struct values:");
  console.log(`  baseFee:     ${baseFeeWad}`);
  console.log(`  maxFee:      ${maxFeeWad}`);
  console.log(`  gasCoeff:    ${gasCoeffWad}`);
  console.log(`  externalFee: ${externalFeeWad}`);
  console.log(`  captureRate: ${BigInt(Math.round(captureRate * 1e18))}`);
  console.log(`  attractRate: ${BigInt(Math.round(attractRate * 1e18))}`);
  console.log("─".repeat(70));

  // ── Validation checks ──────────────────────────────────────────────

  console.log("\nValidation:");
  const oracleNoiseBps = estimateOracleNoise(pool);

  const checks = [
    {
      name: "D ≈ σ₁ (within 2x)",
      pass: decayPerBlockBps >= sigma1Bps * 0.5 && decayPerBlockBps <= sigma1Bps * 2,
      detail: `D=${decayPerBlockBps.toFixed(4)} bps, σ₁=${sigma1Bps.toFixed(4)} bps`,
    },
    {
      name: "k × D < maxFee (starting fee feasible)",
      pass: startingFeeMarginBps < maxFeeBps,
      detail: `${startingFeeMarginBps.toFixed(2)} bps < ${maxFeeBps} bps`,
    },
    {
      name: "timeout > 3 × minAuctionBlocks",
      pass: auctionTimeout > 3 * minAuctionBlocks,
      detail: `${auctionTimeout} > ${3 * minAuctionBlocks}`,
    },
    {
      name: "cooldown ≥ minAuctionBlocks",
      pass: minAuctionInterval >= minAuctionBlocks,
      detail: `${minAuctionInterval} >= ${minAuctionBlocks}`,
    },
    {
      name: "baseFee < maxFee",
      pass: baseFeeWad < maxFeeWad,
      detail: `${baseFeeWad} < ${maxFeeWad}`,
    },
    {
      name: "baseFee ≤ externalFee (competitive)",
      pass: baseFeeBps <= externalFeeBps || pool.volatility === "stablecoin",
      detail: `${baseFeeBps} bps vs ${externalFeeBps} bps`,
    },
    {
      name: "deploy surcharge decays < 100 min",
      pass: surchargeDecayBlocks * 12 / 60 < 100,
      detail: `${Math.round(surchargeDecayBlocks * 12 / 60)} min`,
    },
    {
      name: "oracle guard at 25 blocks > 3× noise",
      pass: guardAt25Blocks > oracleNoiseBps * 3,
      detail: `${guardAt25Blocks.toFixed(4)} bps > ${(oracleNoiseBps * 3).toFixed(4)} bps`,
    },
    {
      name: "half-life > 30 days",
      pass: halfLifeDays > 30,
      detail: `${halfLifeDays.toFixed(0)} days`,
    },
  ];

  let allPass = true;
  for (const c of checks) {
    const icon = c.pass ? "✓" : "✗";
    console.log(`  ${icon} ${c.name}: ${c.detail}`);
    if (!c.pass) allPass = false;
  }

  if (!allPass) {
    console.log("\n  ⚠ SOME CHECKS FAILED — review before deploying");
  } else {
    console.log("\n  All checks passed ✓");
  }
}

// ─── Run ───────────────────────────────────────────────────────────────

for (const pool of pools) {
  calibrate(pool);
}
