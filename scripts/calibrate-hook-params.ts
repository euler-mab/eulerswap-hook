/**
 * Hook parameter calibration script.
 *
 * Derives auction, fee, surcharge, trigger, and timing parameters from first
 * principles for a specific pool's equity, virtual depth, and oracle source.
 *
 * Output matches DynamicFeeAuctionHook's FeeConfig and AuctionConfig structs so the
 * printed values can be pasted directly into a deploy script.
 *
 * Usage:
 *   # Run all profiles in scripts/profiles/
 *   npx tsx scripts/calibrate-hook-params.ts
 *
 *   # Run a single profile
 *   npx tsx scripts/calibrate-hook-params.ts profiles/my-pool.json
 *
 *   # Single profile + emit env vars ready to paste into a shell before
 *   # running contracts/script/DeployHook.s.sol
 *   npx tsx scripts/calibrate-hook-params.ts profiles/my-pool.json --env
 *
 * Run BEFORE every hook deployment or parameter update to verify all values
 * are appropriate for the target pool.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const WAD = 10n ** 18n;
const BLOCKS_PER_YEAR = 2_628_000; // ~12s blocks

// ─── Pool profile ──────────────────────────────────────────────────────

interface PoolProfile {
  name: string;
  /** Actual equity in quote asset (USD terms) */
  equity: number;
  /**
   * Virtual eq reserve for token0 (human units).
   *
   * Convention: eq0 / eq1 are expressed in the pool's ON-CHAIN token0 / token1
   * units. EulerSwap (like Uniswap V3) orders tokens by ADDRESS — the smaller
   * 20-byte address is token0. The pair's "quote/base" identity is unrelated:
   * for USDC/WETH the quote (USDC) happens to be token0, but for e.g.
   * WBTC/USDC the base (WBTC) is token0 by address.
   *
   * If you set the optional `asset0` / `asset1` fields below, the calibrator
   * validates that `asset0` is the smaller address (i.e. matches eq0). The
   * leverage figure (`eq0 / equity`) is only meaningful when eq0 is in the
   * same units as `equity`; the address check catches the silent 10^N error
   * caused by swapping them.
   */
  eq0: number;
  /** Virtual eq reserve for token1 (human units). See `eq0` for ordering rules. */
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
  /**
   * Optional. 0x-prefixed ERC20 address corresponding to `eq0`. When both
   * `asset0` and `asset1` are present, the calibrator verifies (lowercase
   * lexicographic compare) that `asset0` is the smaller address — i.e. the
   * on-chain token0 under EulerSwap / Uniswap V3 ordering. Mismatch is a
   * hard error: silently calibrating against swapped reserves produces a
   * leverage figure that is off by ~10^(decimals1 - decimals0).
   */
  asset0?: string;
  /** Optional. 0x-prefixed ERC20 address corresponding to `eq1`. See `asset0`. */
  asset1?: string;
}

// ─── Profile loading + validation ──────────────────────────────────────

function validateProfile(raw: unknown, source: string): PoolProfile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${source}: profile must be a JSON object`);
  }
  const r = raw as Record<string, unknown>;

  const requireType = (key: string, type: "string" | "number") => {
    if (!(key in r)) throw new Error(`${source}: missing required field "${key}"`);
    if (typeof r[key] !== type) {
      throw new Error(`${source}: field "${key}" must be ${type}, got ${typeof r[key]}`);
    }
  };

  requireType("name", "string");
  requireType("equity", "number");
  requireType("eq0", "number");
  requireType("eq1", "number");
  requireType("cx", "number");
  requireType("cy", "number");
  requireType("oracle", "string");
  requireType("oracleFeeBps", "number");
  requireType("volatility", "string");
  requireType("annualVol", "number");
  requireType("auctionTriggerThreshold", "number");
  requireType("recenterRange", "number");

  if (r.oracle !== "v3" && r.oracle !== "v4") {
    throw new Error(`${source}: field "oracle" must be "v3" or "v4", got "${r.oracle}"`);
  }
  if (r.volatility !== "stablecoin" && r.volatility !== "moderate" && r.volatility !== "high") {
    throw new Error(
      `${source}: field "volatility" must be "stablecoin", "moderate", or "high", got "${r.volatility}"`,
    );
  }

  for (const key of ["equity", "eq0", "eq1", "annualVol", "auctionTriggerThreshold", "recenterRange"]) {
    if ((r[key] as number) <= 0) {
      throw new Error(`${source}: field "${key}" must be > 0`);
    }
  }
  for (const key of ["cx", "cy"]) {
    const v = r[key] as number;
    if (v < 0 || v > 1) throw new Error(`${source}: field "${key}" must be in [0, 1]`);
  }

  // ── Optional asset0 / asset1 address-ordering check ──────────────────
  // EulerSwap (and Uniswap V3) order pool tokens by address: the smaller
  // 20-byte address is token0. The profile's eq0 must be in token0 units.
  // If the caller supplied both asset addresses, verify ordering matches.
  const hasAsset0 = "asset0" in r && r.asset0 !== undefined && r.asset0 !== null;
  const hasAsset1 = "asset1" in r && r.asset1 !== undefined && r.asset1 !== null;
  if (hasAsset0 !== hasAsset1) {
    throw new Error(
      `${source}: "asset0" and "asset1" must be set together (or both omitted)`,
    );
  }
  if (hasAsset0 && hasAsset1) {
    const isHexAddress = (v: unknown): v is string =>
      typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
    if (!isHexAddress(r.asset0)) {
      throw new Error(`${source}: field "asset0" must be a 0x-prefixed 20-byte hex address`);
    }
    if (!isHexAddress(r.asset1)) {
      throw new Error(`${source}: field "asset1" must be a 0x-prefixed 20-byte hex address`);
    }
    const a0 = (r.asset0 as string).toLowerCase();
    const a1 = (r.asset1 as string).toLowerCase();
    if (a0 === a1) {
      throw new Error(`${source}: "asset0" and "asset1" must be different addresses`);
    }
    const smaller = a0 < a1 ? a0 : a1;
    if (a0 !== smaller) {
      throw new Error(
        `${source}: Profile field "asset0" (the eq0 units) is NOT the on-chain token0. ` +
          `By address ordering, token0 is ${smaller}. ` +
          `Either swap eq0 ↔ eq1 in the profile (and matching asset0 ↔ asset1) ` +
          `OR re-derive the calibration in token0 units.`,
      );
    }
  }

  return r as unknown as PoolProfile;
}

function loadProfile(filePath: string): PoolProfile {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Profile file not found: ${abs}`);
  }
  const raw = JSON.parse(fs.readFileSync(abs, "utf8"));
  return validateProfile(raw, abs);
}

function loadAllProfiles(): { profile: PoolProfile; source: string }[] {
  const dir = path.resolve(__dirname, "profiles");
  if (!fs.existsSync(dir)) {
    throw new Error(`Profiles directory not found: ${dir}`);
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    throw new Error(`No .json profiles found in ${dir}`);
  }
  return files.map((f) => {
    const full = path.join(dir, f);
    return { profile: loadProfile(full), source: full };
  });
}

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

interface CalibrationResult {
  // FeeConfig (WAD)
  baseFeeWad: bigint;
  maxFeeWad: bigint;
  gasCoeffWad: bigint;
  externalFeeWad: bigint;
  captureRateWad: bigint;
  attractRateWad: bigint;
  // AuctionConfig (WAD / blocks)
  decayPerBlockWad: bigint;
  auctionTriggerThresholdWad: bigint;
  clearThresholdWad: bigint;
  maxShiftMagnitudeWad: bigint;
  minAuctionBlocks: number;
  recenterRangeWad: bigint;
  maxRecenterDriftWad: bigint;
  minRecenterDeltaWad: bigint;
  surchargeDecayPerBlockWad: bigint;
  surchargeMultiplierWad: bigint;
  deploySurchargeWad: bigint;
}

function calibrate(pool: PoolProfile): CalibrationResult {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  ${pool.name} — Hook Parameter Calibration`);
  console.log(`${"=".repeat(70)}\n`);

  const leverage = pool.eq0 / pool.equity;

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

  // ── Max shift magnitude (cap on per-auction priceY shift) ──────────
  // Sized per volatility class to match existing deployments. Floored to
  // a generous multiple of the "typical" exposure-sized shift so the cap
  // only saturates for unusually large exposures.
  let maxShiftMagnitudeBps: number;
  if (pool.volatility === "stablecoin") maxShiftMagnitudeBps = 1; // 1 bps
  else if (pool.volatility === "moderate") maxShiftMagnitudeBps = 150; // 1.5%
  else maxShiftMagnitudeBps = 250; // 2.5%
  const maxShiftMagnitudeWad = BigInt(Math.round(maxShiftMagnitudeBps * 1e14));

  // ── Clear threshold ─────────────────────────────────────────────────
  // Price-convergence metric: |marginalPrice - oraclePrice| / oraclePrice.
  // Hook invariant: clearThreshold < maxShiftMagnitude (otherwise auction
  // would clear on the very first swap). Use 1/3 of maxShift so the arb
  // has been mostly consumed before clearing is permitted.
  const clearThresholdBps = maxShiftMagnitudeBps / 3;
  const clearThresholdWad = BigInt(Math.round(clearThresholdBps * 1e14));

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
  console.log(`  clearThreshold:    ${clearThresholdBps.toFixed(4)} bps (${clearThresholdWad})`);
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
  // AuctionConfig output
  // ═══════════════════════════════════════════════════════════════════

  const auctionTriggerThresholdWad = BigInt(Math.round(pool.auctionTriggerThreshold * 1e18));
  const recenterRangeWad = BigInt(Math.round(pool.recenterRange * 1e18));
  const maxRecenterDriftWad = BigInt(Math.round(maxRecenterDriftBps * 1e14));
  const minRecenterDeltaWad = BigInt(Math.round(minRecenterDeltaBps * 1e14));
  const captureRateWad = BigInt(Math.round(captureRate * 1e18));
  const attractRateWad = BigInt(Math.round(attractRate * 1e18));
  const surchargeMultiplierWad = BigInt(Math.round(surchargeMultiplier * 1e18));

  console.log("─".repeat(70));
  console.log("AuctionConfig struct values:");
  console.log(`  decayPerBlock:          ${decayPerBlockWad}`);
  console.log(`  auctionTriggerThreshold: ${auctionTriggerThresholdWad}`);
  console.log(`  clearThreshold:         ${clearThresholdWad}`);
  console.log(`  minAuctionBlocks:       ${minAuctionBlocks}`);
  console.log(`  minAuctionInterval:     ${minAuctionInterval}`);
  console.log(`  auctionTimeout:         ${auctionTimeout}`);
  console.log(`  kMarginBlocks:          ${kMarginBlocks}`);
  console.log(`  oracleGuardMultiplier:  ${BigInt(Math.round(oracleGuardMultiplier * 1e18))}`);
  console.log(`  maxSnapshotInterval:    ${maxSnapshotInterval}`);
  console.log(`  recenterRange:          ${recenterRangeWad}`);
  console.log(`  maxRecenterDrift:       ${maxRecenterDriftWad}`);
  console.log(`  minRecenterDelta:       ${minRecenterDeltaWad}`);
  console.log(`  surchargeDecayPerBlock: ${surchargeDecayWad}`);
  console.log(`  surchargeMultiplier:    ${surchargeMultiplierWad}`);
  console.log(`  deploySurcharge:        ${deploySurchargeWad}`);
  console.log(`  maxShiftMagnitude:      ${maxShiftMagnitudeWad} (${maxShiftMagnitudeBps} bps)`);
  console.log();
  console.log("FeeConfig struct values:");
  console.log(`  baseFee:     ${baseFeeWad}`);
  console.log(`  maxFee:      ${maxFeeWad}`);
  console.log(`  gasCoeff:    ${gasCoeffWad}`);
  console.log(`  externalFee: ${externalFeeWad}`);
  console.log(`  captureRate: ${captureRateWad}`);
  console.log(`  attractRate: ${attractRateWad}`);
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
    {
      name: "clearThreshold < maxShiftMagnitude (hook invariant)",
      pass: clearThresholdWad < maxShiftMagnitudeWad,
      detail: `${clearThresholdWad} < ${maxShiftMagnitudeWad}`,
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

  return {
    baseFeeWad,
    maxFeeWad,
    gasCoeffWad,
    externalFeeWad,
    captureRateWad,
    attractRateWad,
    decayPerBlockWad,
    auctionTriggerThresholdWad,
    clearThresholdWad,
    maxShiftMagnitudeWad,
    minAuctionBlocks,
    recenterRangeWad,
    maxRecenterDriftWad,
    minRecenterDeltaWad,
    surchargeDecayPerBlockWad: surchargeDecayWad,
    surchargeMultiplierWad,
    deploySurchargeWad,
  };
}

// ─── Env-var emitter ───────────────────────────────────────────────────

function emitEnvBlock(pool: PoolProfile, r: CalibrationResult): void {
  console.log();
  console.log("# ─── Paste into your shell, then run DeployHook.s.sol ──────────────");
  console.log(`# Profile: ${pool.name}`);
  // FeeConfig
  console.log(`BASE_FEE=${r.baseFeeWad}`);
  console.log(`MAX_FEE=${r.maxFeeWad}`);
  console.log(`GAS_COEFF=${r.gasCoeffWad}`);
  console.log(`EXTERNAL_FEE=${r.externalFeeWad}`);
  console.log(`CAPTURE_RATE=${r.captureRateWad}`);
  console.log(`ATTRACT_RATE=${r.attractRateWad}`);
  // AuctionConfig
  console.log(`DECAY_PER_BLOCK=${r.decayPerBlockWad}`);
  console.log(`AUCTION_TRIGGER_THRESHOLD=${r.auctionTriggerThresholdWad}`);
  console.log(`CLEAR_THRESHOLD=${r.clearThresholdWad}`);
  console.log(`MAX_SHIFT_MAGNITUDE=${r.maxShiftMagnitudeWad}`);
  console.log(`MIN_AUCTION_BLOCKS=${r.minAuctionBlocks}`);
  console.log(`RECENTER_RANGE=${r.recenterRangeWad}`);
  console.log(`MAX_RECENTER_DRIFT=${r.maxRecenterDriftWad}`);
  console.log(`MIN_RECENTER_DELTA=${r.minRecenterDeltaWad}`);
  console.log(`SURCHARGE_DECAY_PER_BLOCK=${r.surchargeDecayPerBlockWad}`);
  console.log(`SURCHARGE_MULTIPLIER=${r.surchargeMultiplierWad}`);
  console.log(`DEPLOY_SURCHARGE=${r.deploySurchargeWad}`);
}

// ─── Entry point ───────────────────────────────────────────────────────

function main(): void {
  const argv = process.argv.slice(2);
  const wantEnv = argv.includes("--env");
  const positional = argv.filter((a) => !a.startsWith("--"));

  let runs: { profile: PoolProfile; source: string }[];
  if (positional.length === 0) {
    runs = loadAllProfiles();
  } else if (positional.length === 1) {
    const source = positional[0];
    runs = [{ profile: loadProfile(source), source }];
  } else {
    throw new Error(
      `Expected 0 or 1 profile path arguments, got ${positional.length}: ${positional.join(" ")}`,
    );
  }

  const results: { profile: PoolProfile; result: CalibrationResult }[] = [];
  for (const { profile } of runs) {
    results.push({ profile, result: calibrate(profile) });
  }

  if (wantEnv) {
    if (results.length !== 1) {
      console.log();
      console.log(
        "⚠ --env requires exactly one profile (got " + results.length + "). Re-run with a single profile path.",
      );
    } else {
      emitEnvBlock(results[0].profile, results[0].result);
    }
  }
}

main();
