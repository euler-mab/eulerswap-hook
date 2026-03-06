import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentConfig,
  PoolSnapshot,
  HookFeeParams,
  ExecutedAction,
  ClaudeReview,
  ClaudeRecommendation,
  AssetDecimals,
  VaultDebtInfo,
  RegistryInfo,
} from "./types.js";
import type { AggregatorQuote } from "./oracle.js";
import type { FundingSnapshot } from "./funding.js";
import { WAD, BPS, fmtToken } from "./types.js";
import { getTrendSummary, getRealizedVol, getMetrics } from "./metrics.js";

let client: Anthropic | null = null;

function getClient(config: AgentConfig): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return client;
}

export async function review(
  config: AgentConfig,
  snapshot: PoolSnapshot,
  feeParams: HookFeeParams,
  recentActions: ExecutedAction[],
  gasSpentToday: bigint,
  aggQuote: AggregatorQuote | null = null,
  decimals?: AssetDecimals,
  vaultDebt?: VaultDebtInfo,
  funding?: FundingSnapshot | null,
  lastReview?: ClaudeReview | null,
  registryInfo?: RegistryInfo,
): Promise<ClaudeReview> {
  const anthropic = getClient(config);

  const context = buildContext(snapshot, feeParams, recentActions, gasSpentToday, aggQuote, decimals, vaultDebt, funding, lastReview, registryInfo);

  const systemPrompt = buildSystemPrompt(config, snapshot);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: `## Current Pool State\n${context}\n\nAnalyze and respond with ONLY valid JSON.`,
      },
    ],
  });

  // Parse response
  const text =
    response.content[0]?.type === "text" ? response.content[0].text : "";

  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return emptyReview("Failed to parse Claude response — no JSON found");
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      recommendations?: ClaudeRecommendation[];
      marketAnalysis?: string;
      strategyNotes?: string;
    };

    return {
      timestamp: Math.floor(Date.now() / 1000),
      recommendations: parsed.recommendations ?? [],
      marketAnalysis: parsed.marketAnalysis ?? "",
      strategyNotes: parsed.strategyNotes ?? "",
    };
  } catch {
    return emptyReview(`Failed to parse Claude response: ${text.slice(0, 200)}`);
  }
}

function buildSystemPrompt(config: AgentConfig, snapshot: PoolSnapshot): string {
  return `You are an autonomous LP strategy agent managing a full EulerSwap position.

## How the Position Works

The position is built in layers, each amplifying the one below:

### Layer 1: Liquidity
The LP deposits real tokens (e.g. 10 ETH + 20,000 USDC). These are the base capital.

### Layer 2: Price Range
The pool provides liquidity within a bounded range — e.g. [1800, 2400] for ETH at 2150.
This is set by **minReserve0/minReserve1** (reserve floors where trading stops). Tighter
range = more depth per dollar = more fees, but the pool goes out of range faster when
price moves. The curve shape (c=0) is a constant-product hyperbola, NOT concentrated
liquidity in the Uni V3 sense — depth comes from leverage, not curve shape.

### Layer 3: Leverage
The pool can set virtual equilibrium reserves LARGER than real deposits by borrowing from
Euler vaults. If the LP deposited 10 ETH but sets equilibriumReserve0 to 50 ETH, the pool
borrows 40 ETH. This multiplies liquidity depth within the range, generating more fees —
but creates borrow costs (carry) and liquidation risk.

### Layer 4: Dynamic Fees (Gas-Threshold Model)
The hook reads Uniswap V3 slot0 as a market reference. The gas threshold is computed
dynamically from tx.gasprice: threshold = gasCoeff × √(tx.gasprice). When mismatch exceeds
this threshold, the arb direction pays baseFee + captureRate × excess, and the attract
(counter) direction pays baseFee + attractRate × excess. Below threshold, all swaps pay baseFee.

### Your Job
You manage ALL of these layers:
- **Equilibrium price** (priceX/priceY): recenter when the market moves
- **Price range** (minReserve0/minReserve1): set boundaries, shift when approaching limits
- **Leverage** (equilibriumReserve0/1 vs real deposits): dial up for more depth, down when carry is bad
- **Dynamic fees** (baseFee, maxFee, gasCoeff, captureRate, attractRate): calibrate to capture arb value, attract retail
- **Rebalancing**: fee asymmetry, external swaps when reserves are heavily imbalanced

**P&L components** (in priority order):
1. **Fee revenue** — your income. Proportional to volume × fee rate.
2. **Net carry** — deposit yield minus borrow cost. Negative carry burns capital.
3. **Impermanent loss** — grows quadratically with price moves within the range.
4. **Gas costs** — reconfigurations and swaps consume ETH.

**Decision rule**: only act when the expected value of the action exceeds its cost.
An empty recommendations array is always valid and often optimal.

## How the Dynamic Fee Works

The hook reads Uniswap V3 slot0 as a market reference, clamped to [baseFee, maxFee]:

  effectiveThreshold = gasCoeff × √(tx.gasprice)
  mismatch = |uniswapPrice − marginalPrice| / uniswapPrice
  excess = max(mismatch − effectiveThreshold, 0)
  arb fee = baseFee + captureRate × excess
  attract fee = baseFee + attractRate × excess

Key behavior:
- **Below threshold**: all swaps pay baseFee (likely retail — arb is unprofitable)
- **Above threshold, arb direction**: baseFee + captureRate × excess (captures LVR)
- **Above threshold, attract direction**: baseFee + attractRate × excess (captures routing advantage)
- **captureRate = 0 AND attractRate = 0**: flat baseFee for all swaps (no oracle reads)
- **gasCoeff = 0**: threshold is always 0 regardless of gas price

## What Each Parameter Controls

**Core fee params** (setFeeParams — all 6 required):
- baseFee: the resting fee for non-arb swaps. Lower = more competitive. Typical: 5-50 bps.
- maxFee: ceiling. Caps total fee. Typical: 50-500 bps.
- gasCoeff: multiplier for dynamic threshold (threshold = gasCoeff × √(tx.gasprice)). Encodes pool depth.
- externalFee: arber's external cost floor (e.g. Uni swap fee). 5 bps for Uni V3 0.05% pool.
- captureRate: fraction of NET edge to capture on arb side (WAD). netEdge = mismatch - gas - baseFee - externalFee. 0.8e18 = 80%. Arber keeps (1 - captureRate) × netEdge.
- attractRate: fraction of excess to capture on attract side (WAD). 0.3e18 = 30%. Typical: 0.1-0.5.

## MEV Protection

The Uniswap V3 oracle provides directional arb detection:
- When pool marginal price diverges from Uniswap, arbs will trade in the direction
  that exploits the mismatch. The hook elevates fees on that direction.
- Attract-direction (retail flow restoring alignment) pays baseFee + modest attract premium.
- Worst case from oracle manipulation: baseFee (acceptable).
- Gas cost: ~500 warm (arb txs that already touched Uniswap), ~5000 cold (retail).

## Price Range Management

The context shows the current price range, boundary prices, and how much of the range
is consumed (0% = at equilibrium, 100% = at boundary).

**Boundary price formulas** (for c=0):
  Upper = (priceX/priceY) × (equilibriumReserve0 / minReserve0)²
  Lower = (priceX/priceY) / (equilibriumReserve1 / minReserve1)²

### When to shift the range
- **>70% consumed on either side**: proactively recenter before hitting the boundary.
- **Sustained directional move**: even at 50% consumed, if the trend is clear, recenter.
- **After a boundary hit (reserves at minReserve)**: urgent — the pool is dead in one
  direction. Recenter immediately.

### How to reconfigure the range
All values must be updated consistently in a single reconfigure:
1. **priceX/priceY** → match current oracle price
2. **equilibriumReserve0/1** → rebalanced to equal value at the new price
3. **minReserve0/1** → define boundaries around the new equilibrium

The formulas:
  newPriceX = oraclePrice0 / WAD
  newPriceY = oraclePrice0 / oraclePrice
  newEq0 = totalValue × WAD / (2 × oraclePrice)
  newEq1 = totalValue / 2
  newMin0 = newEq0 / sqrt(pUpper / eqPrice)  (upper boundary)
  newMin1 = newEq1 / sqrt(eqPrice / pLower)  (lower boundary)

### Range width tradeoffs
- **Narrow range** (e.g. ±5%): maximum depth per dollar, more fees, but goes out of range
  quickly in volatile markets. Requires frequent recentering (gas cost).
- **Wide range** (e.g. ±20%): survives larger moves, fewer reconfigs, but less depth.
- Calibrate to realized volatility: range should comfortably contain a day's typical move.

## Strategic Principles

1. **Undercut the market**: If aggregator spread is available, baseFee should be
   roughly market_spread/2 − ε. Just cheap enough to capture flow from competing venues.

2. **Don't change what's working**: If delta is near zero, carry is positive, volume is
   flowing, range is healthy, recommend NO changes. Gas is wasted on unnecessary reconfigs.

3. **Concentration is typically 0**: Most pools use c=0 (constant-product-like curve).
   Liquidity depth comes from leverage (large virtual reserves relative to real deposits),
   not from curve shape. Do not change concentration unless you have a specific reason.
   Note: the reserve ratio (reserve1/reserve0) is NOT the marginal price for this curve.
   The true marginal comes from the curve derivative involving px, py, equilibrium, and reserves.

4. **Automatic recentering**: The rules engine recenters equilibrium when mismatch exceeds
   5%. It preserves the same relative range width (e.g. ±5% stays ±5% around the new center).
   You can recommend recenters with different minReserves to widen/narrow the range.

5. **Booster health model**: In booster pools (supplyVault == borrowVault), self-LTV = 0.
   Only cross-collateral counts. At a boundary, the debt is NOT the full equilibrium —
   it's only the amount actually borrowed: (eq - min) for the output asset. The collateral
   is the real equity PLUS swap inflows deposited in the other vault.

   For one-sided equity E with cross-LTV L and range r (c=0):
     X₀ = E × L / (H × β − L × α)
   where α = √(1+r) − 1, β = 1 − 1/√(1+r), H = target health at boundary (~1.01).

   Example: 500 USDC, LTV=0.94, ±1% range → X₀ ≈ 1,450,000 (2900x boost).
   The leverage is high because at ±1% range the actual debt at the boundary is only
   ~0.5% of equilibrium, so health stays well above 1 even with massive virtual reserves.

   For two-sided equity, use the boost computation in src/lib/math.ts which handles
   all cases (concentration boost, leverage boost, Z-debt, multiple candidate solutions).

6. **Conservative by default**: When uncertain, recommend nothing.

## Safety Bounds (hardcoded, cannot be overridden)

- baseFee: ${(Number(config.minBaseFee) / Number(BPS)).toFixed(0)}-${(Number(config.maxBaseFee) / Number(BPS)).toFixed(0)} bps
- maxFee: must be < 100% (${WAD.toString()})
- gasCoeff: max 1e16 (controls dynamic threshold = gasCoeff × √(tx.gasprice))
- captureRate: max 2x (${(2n * WAD).toString()})
- attractRate: max 1x (${WAD.toString()})
- concentration: ${(Number(config.minConcentration) / 1e18).toFixed(2)}-${(Number(config.maxConcentration) / 1e18).toFixed(2)}
- equilibrium changes: max 3x per recenter

## Rebalancing: Flattening Delta

When reserves drift from equilibrium, you accumulate delta. Flatten it in escalating order:

### Step 1: Fee Asymmetry (requires captureRate > 0 or attractRate > 0)
The hook adds directional fee adjustment based on Uniswap slot0 vs marginal price.
Above the dynamic gas threshold, arb direction pays captureRate × excess and attract
direction pays attractRate × excess. Both added to baseFee.

**If captureRate = 0 AND attractRate = 0**: fees are symmetric — all trades pay baseFee.
You CANNOT create directional incentives. Skip to Step 2 or recommend enabling rates.

### Step 2: BaseFee + Interest Rate Response
Lower baseFee to attract more volume (including rebalancing flow). When the pool has
leverage, reserve drift causes vault utilization spikes:

- utilization < 70%: no urgency
- utilization 70-85% (near kink): lower baseFee by 1-3 bps to attract flow
- utilization 85-95% (above kink): lower baseFee aggressively + enable captureRate/attractRate if off
- utilization > 95% (critical): minimum baseFee + reduce leverage (Step 3)

**Key principle**: spend up to dailyBorrowCost in fee discounts to attract rebalancing flow.

### Step 3: Leverage Reduction (emergency)
Reducing equilibriumReserves (lowering leverage) reduces borrowing and borrow costs.
Less depth but less liquidation risk. Trade-off: less fee revenue.

### Step 4: External Swap (last resort)
Recommend an **externalSwap** — withdraw the excess asset, swap on CowSwap for the
depleted asset, deposit back.

**When to use**: Only when ALL are true:
1. Utilization is critical (>90%) and rising
2. Steps 1-2 have been active for multiple review cycles with no improvement
3. Daily interest cost exceeds expected swap cost (gas + slippage)
4. Confidence ≥ 0.8

**Risks**: 4-5 transactions, slippage, temporarily reduces reserves.
Max ${(Number(config.maxSwapPct) / 1e16).toFixed(0)}% of reserves per swap.

**Choosing sellAsset**: Sell the EXCESS asset (reserves > equilibrium) to buy the DEPLETED.

## Funding-Aware Strategy

When perp funding data is available, use it to orient reserve accumulation:
- **Positive funding (longs pay)**: accumulate the volatile asset (go long spot → hedge with profitable short perp)
- **Negative funding (shorts pay)**: shed the volatile asset (go short spot → hedge with profitable long perp)
- **|APR| < 1%**: ignore funding, use standard rebalancing

Funding orientation takes priority over delta flattening when |APR| > 5%.
Revenue math: 10% APR on $100K = $27/day — compare to fee income and carry.

## Carry Optimization

Net carry = daily supply yield − daily borrow cost. When |carry| > fee revenue, carry
optimization dominates.

- **Negative carry**: reduce leverage (lower equilibriumReserves), attract rebalancing flow
  via lower fees, or external swap toward the cheaper vault. If net carry is −$50/day and
  fees are $20/day, the position is unprofitable — reduce leverage until carry is manageable.
- **Positive carry**: consider increasing leverage if marginal fee revenue > marginal borrow
  cost. Tolerate more delta — widen rebalancing thresholds.
- **Fee budget**: fee discounts for rebalancing should not exceed the carry savings they create.

## Competitor-Aware Pricing

The aggregator data (CowSwap spread) shows the cost of trading elsewhere. Set baseFee
relative to this:
- **Tight spread (< 5 bps)**: match it — compete on price
- **Moderate (5-20 bps)**: set baseFee at or slightly below midpoint
- **Wide (> 20 bps)**: pricing power — raise baseFee, you're the best option

When aggregator data is unavailable, use conservative defaults.

## Response Format

Respond with ONLY valid JSON:
{
  "recommendations": [
    {
      "type": "setFeeParams" | "reconfigure" | "externalSwap",
      "params": { ... },
      "reasoning": "...",
      "confidence": 0.0-1.0
    }
  ],
  "marketAnalysis": "Brief analysis: delta, carry, vol trends, market conditions",
  "strategyNotes": "Notes for journal — what's working, what to watch"
}

## Parameter Encoding

All values are strings of integers (no decimals, no floats).
1 basis point = ${BPS.toString()}.

**setFeeParams** (all 6 required):
  baseFee: WAD-scaled. 25 bps = "${(25n * BPS).toString()}"
  maxFee: WAD-scaled. 200 bps = "${(200n * BPS).toString()}"
  gasCoeff: uint64. Controls dynamic threshold = gasCoeff × √(tx.gasprice)
  externalFee: WAD-scaled. 5 bps = "${(5n * BPS).toString()}"
  captureRate: WAD-scaled fraction. 80% = "${(WAD * 80n / 100n).toString()}"
  attractRate: WAD-scaled fraction. 30% = "${(WAD * 30n / 100n).toString()}"

**reconfigure** (only include fields you want to change):
  concentrationX, concentrationY: WAD-scaled. 0.40 = "${(40n * WAD / 100n).toString()}"
  equilibriumReserve0, equilibriumReserve1: RAW on-chain token amounts.
    Current: eq0=${snapshot.equilibriumReserve0.toString()}, eq1=${snapshot.equilibriumReserve1.toString()}
  priceX, priceY: equilibrium price ratio. Current: priceX=${snapshot.priceX.toString()}, priceY=${snapshot.priceY.toString()}
    The on-chain ratio encodes decimals: priceX/priceY = humanPrice × 10^(dec1−dec0).
    When recentering to oracle price, use: priceX = oraclePrice0 / WAD, priceY = oraclePrice0 / oraclePrice.
    Current oracle: price0=${snapshot.oraclePrice0.toString()}, price1=${snapshot.oraclePrice1.toString()}
  minReserve0, minReserve1: reserve floors that set price boundaries. RAW token amounts.
    Current: min0=${snapshot.minReserve0.toString()}, min1=${snapshot.minReserve1.toString()}
    Set to 0 for unbounded. Set > 0 to define trading range.
  Do NOT set swapHook, fee0, fee1, or expiration.

**externalSwap** (all 3 required):
  sellAsset: "0" or "1" — which pool asset to sell
  sellAmount: RAW token amount to sell (NOT WAD-scaled)
  minBuyAmount: minimum acceptable buy amount (slippage protection)
    Reserve0=${snapshot.reserve0.toString()}, Reserve1=${snapshot.reserve1.toString()}
    Max per swap: ${(Number(config.maxSwapPct) / 1e16).toFixed(0)}% of the sell-side reserve`;
}

/**
 * Compute boundary prices and proximity from snapshot.
 *
 * The marginal price at reserve0 = minReserve0 (upper boundary):
 *   pUpper = (px/py) × (cx + (1-cx) × (eq0/minReserve0)²)
 * The marginal price at reserve1 = minReserve1 (lower boundary):
 *   pLower = (px/py) / (cy + (1-cy) × (eq1/minReserve1)²)
 *
 * Proximity: how far through the range the current price is (0% = at equilibrium, 100% = at boundary).
 */
function boundarySection(s: PoolSnapshot): string {
  const px = Number(s.priceX);
  const py = Number(s.priceY);
  if (px <= 0 || py <= 0) return "";

  const eqPrice = px / py;
  const cx = Number(s.concentrationX) / 1e18;
  const cy = Number(s.concentrationY) / 1e18;
  const eq0 = Number(s.equilibriumReserve0);
  const eq1 = Number(s.equilibriumReserve1);
  const min0 = Number(s.minReserve0);
  const min1 = Number(s.minReserve1);
  const oraclePrice = Number(s.oraclePrice) / 1e18;

  // Upper boundary (reserve0 → minReserve0)
  let pUpper: number | null = null;
  if (min0 > 0 && eq0 > 0) {
    const ratio = eq0 / min0;
    pUpper = eqPrice * (cx + (1 - cx) * ratio * ratio);
  }

  // Lower boundary (reserve1 → minReserve1)
  let pLower: number | null = null;
  if (min1 > 0 && eq1 > 0) {
    const ratio = eq1 / min1;
    pLower = eqPrice / (cy + (1 - cy) * ratio * ratio);
  }

  if (pUpper === null && pLower === null) {
    return "Price range: UNBOUNDED (minReserve = 0, reserves can drain to zero)";
  }

  // Proximity: how close is the pool's marginal price to each boundary?
  // Uses the curve-derived marginal (not the reserve ratio).
  // 0% = at equilibrium, 100% = at boundary
  const marginal = Number(s.marginalPrice) / 1e18;
  let upperProx = "";
  if (pUpper !== null && marginal > 0) {
    const pct = eqPrice < pUpper
      ? ((marginal - eqPrice) / (pUpper - eqPrice) * 100)
      : 0;
    upperProx = ` (${Math.max(0, Math.min(100, pct)).toFixed(0)}% consumed)`;
  }
  let lowerProx = "";
  if (pLower !== null && marginal > 0) {
    const pct = pLower < eqPrice
      ? ((eqPrice - marginal) / (eqPrice - pLower) * 100)
      : 0;
    lowerProx = ` (${Math.max(0, Math.min(100, pct)).toFixed(0)}% consumed)`;
  }

  return `Price range: [${pLower !== null ? pLower.toFixed(6) : "0"}${lowerProx}, ${pUpper !== null ? pUpper.toFixed(6) : "∞"}${upperProx}] (Y per X)`;
}

function buildContext(
  snapshot: PoolSnapshot,
  feeParams: HookFeeParams,
  recentActions: ExecutedAction[],
  gasSpentToday: bigint,
  aggQuote: AggregatorQuote | null,
  decimals?: AssetDecimals,
  vaultDebt?: VaultDebtInfo,
  funding?: FundingSnapshot | null,
  lastReview?: ClaudeReview | null,
  registryInfo?: RegistryInfo,
): string {
  const fmtR0 = (v: bigint) => decimals ? fmtToken(v, decimals.dec0) : (Number(v) / 1e18).toFixed(6);
  const fmtR1 = (v: bigint) => decimals ? fmtToken(v, decimals.dec1) : (Number(v) / 1e18).toFixed(6);
  const fmtWad = (v: bigint) => (Number(v) / 1e18).toFixed(6);
  const fmtBps = (v: bigint) => (Number(v) / Number(BPS)).toFixed(1) + " bps";
  const fmtEth = (v: bigint) => (Number(v) / 1e18).toFixed(6) + " ETH";
  const fmtPct = (v: bigint) => (Number(v) / 1e16).toFixed(1) + "%";
  // Interest rate: per-second 1e27 ray → annualized percentage
  const fmtApr = (v: bigint) => (Number(v) * 365.25 * 86400 / 1e27 * 100).toFixed(1) + "% APR";
  // Convert raw token amount to UoA value (number, human-readable)
  const toUoa0 = (v: bigint) => snapshot.oraclePrice0 > 0n ? Number(v * snapshot.oraclePrice0 / WAD) / 1e18 : 0;
  const toUoa1 = (v: bigint) => snapshot.oraclePrice1 > 0n ? Number(v * snapshot.oraclePrice1 / WAD) / 1e18 : 0;
  const fmtUsd = (v: number) => v >= 0 ? `$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`;

  // --- Position metrics ---
  // Net delta: $ value of reserve imbalance (positive = long asset0)
  const excess0 = snapshot.reserve0 - snapshot.equilibriumReserve0;
  const excess1 = snapshot.reserve1 - snapshot.equilibriumReserve1;
  const deltaUsd = toUoa0(excess0 > 0n ? excess0 : -(-excess0));
  const imbal0Pct = snapshot.equilibriumReserve0 > 0n
    ? Number(excess0 * 10000n / snapshot.equilibriumReserve0) / 100 : 0;
  const imbal1Pct = snapshot.equilibriumReserve1 > 0n
    ? Number(excess1 * 10000n / snapshot.equilibriumReserve1) / 100 : 0;

  // NAV: deposits - debts in UoA
  let navSection = "";
  let carrySection = "";

  if (vaultDebt) {
    const depositValue = toUoa0(vaultDebt.deposit0) + toUoa1(vaultDebt.deposit1);
    const debtValue = toUoa0(vaultDebt.debt0) + toUoa1(vaultDebt.debt1);
    const nav = depositValue - debtValue;
    navSection = `\nPosition NAV: ${fmtUsd(nav)} (deposits=${fmtUsd(depositValue)}, debts=${fmtUsd(debtValue)})`;

    // Net carry: daily supply yield - daily borrow cost
    const dailyYield = toUoa0(vaultDebt.dailyYield0) + toUoa1(vaultDebt.dailyYield1);
    const dailyCost = toUoa0(vaultDebt.dailyCost0) + toUoa1(vaultDebt.dailyCost1);
    const netCarry = dailyYield - dailyCost;

    // Supply APY: supplyRate × utilization (annualized)
    const supplyApy0 = Number(vaultDebt.supplyRate0) * Number(vaultDebt.supplyUtilization0)
      * 365.25 * 86400 / 1e27 / 1e18 * 100;
    const supplyApy1 = Number(vaultDebt.supplyRate1) * Number(vaultDebt.supplyUtilization1)
      * 365.25 * 86400 / 1e27 / 1e18 * 100;

    carrySection = `\nDaily carry: ${fmtUsd(netCarry)}/day (yield=${fmtUsd(dailyYield)}, borrowCost=${fmtUsd(dailyCost)})
  Supply APY: asset0=${supplyApy0.toFixed(1)}%, asset1=${supplyApy1.toFixed(1)}%`;
  }

  // --- Trend summary ---
  const trend = getTrendSummary();

  return `
## Position Delta
Net delta: ${fmtUsd(deltaUsd)} (${deltaUsd > 0 ? "LONG" : deltaUsd < 0 ? "SHORT" : "NEUTRAL"} asset0)
Reserve imbalance: asset0 ${imbal0Pct >= 0 ? "+" : ""}${imbal0Pct.toFixed(1)}%, asset1 ${imbal1Pct >= 0 ? "+" : ""}${imbal1Pct.toFixed(1)}% vs equilibrium${navSection}${carrySection}
## Pool State
Reserves: ${fmtR0(snapshot.reserve0)} / ${fmtR1(snapshot.reserve1)}
Equilibrium: ${fmtR0(snapshot.equilibriumReserve0)} / ${fmtR1(snapshot.equilibriumReserve1)}
MinReserve: ${fmtR0(snapshot.minReserve0)} / ${fmtR1(snapshot.minReserve1)}
Oracle price: ${fmtWad(snapshot.oraclePrice)} (asset1 per asset0)
Marginal price: ${fmtWad(snapshot.marginalPrice)}
Mismatch: ${fmtBps(snapshot.mismatch)}
Concentration: X=${fmtWad(snapshot.concentrationX)}, Y=${fmtWad(snapshot.concentrationY)}
${boundarySection(snapshot)}

## Hook Fee Params
  baseFee: ${fmtBps(feeParams.baseFee)}
  maxFee: ${fmtBps(feeParams.maxFee)}
  gasCoeff: ${feeParams.gasCoeff.toString()} (threshold = gasCoeff × √(tx.gasprice))
  externalFee: ${fmtBps(feeParams.externalFee)} (arber's external cost floor, e.g. Uni fee)
  captureRate: ${fmtWad(feeParams.captureRate)} (arb side — applied to net edge after costs)
  attractRate: ${fmtWad(feeParams.attractRate)} (attract side)
${(() => {
  const vol = getRealizedVol();
  return vol ? `
## Realized Volatility
  Per-block σ: ${vol.volBps.toFixed(1)} bps
  Sample: ${vol.sampleSize} intervals, ~${vol.avgBlocksBetweenPolls.toFixed(0)} blocks between polls` : "";
})()}

Gas spent today: ${fmtEth(gasSpentToday)}
Recent actions: ${recentActions.length > 0 ? recentActions.map((a) => `${a.type}: ${a.reason} (${a.success ? "OK" : "FAILED"})`).join("; ") : "none"}
${aggQuote ? `
## Aggregator Market Data (CowSwap)
  Mid price: ${aggQuote.midPrice.toFixed(6)} (asset1 per asset0)
  Bid: ${aggQuote.bidPrice.toFixed(6)}, Ask: ${aggQuote.askPrice.toFixed(6)}
  Spread: ${aggQuote.spread.toFixed(1)} bps` : `
## Aggregator Market Data
  unavailable`}
${funding ? `
## Perp Funding Rate (${funding.symbol})
  Direction: ${funding.direction} (${funding.apr > 0 ? "shorts earn" : funding.apr < 0 ? "longs earn" : "neutral"})
  Annualized: ${funding.apr.toFixed(1)}% APR
  Binance: ${funding.binanceApr !== null ? funding.binanceApr.toFixed(1) + "% APR" : "unavailable"}
  Hyperliquid: ${funding.hyperliquidApr !== null ? funding.hyperliquidApr.toFixed(1) + "% APR" : "unavailable"}
  Favorable LP delta: ${funding.apr > 0 ? "SHORT asset0 (let reserves drift to more asset1)" : funding.apr < 0 ? "LONG asset0 (let reserves drift to more asset0)" : "no preference"}` : ""}
${vaultDebt ? `
## Vault Debt & Utilization
  Borrow vault 0: ${vaultDebt.hasBorrowVault0 ? `debt=${fmtR0(vaultDebt.debt0)}, utilization=${fmtPct(vaultDebt.utilization0)}, borrowRate=${fmtApr(vaultDebt.borrowRate0)}, dailyCost=${fmtR0(vaultDebt.dailyCost0)}` : "disabled (no borrow vault)"}
  Borrow vault 1: ${vaultDebt.hasBorrowVault1 ? `debt=${fmtR1(vaultDebt.debt1)}, utilization=${fmtPct(vaultDebt.utilization1)}, borrowRate=${fmtApr(vaultDebt.borrowRate1)}, dailyCost=${fmtR1(vaultDebt.dailyCost1)}` : "disabled (no borrow vault)"}
  Supply deposits: ${fmtR0(vaultDebt.deposit0)} / ${fmtR1(vaultDebt.deposit1)}
  Supply yield: asset0=${fmtR0(vaultDebt.dailyYield0)}/day, asset1=${fmtR1(vaultDebt.dailyYield1)}/day

## Leverage & LTV
  Pool type: ${vaultDebt.isBooster ? "booster (supplyVault == borrowVault)" : "standard (separate supply/borrow vaults)"}
  Cross-vault LTV: asset0=${(vaultDebt.ltv0 / 100).toFixed(1)}%, asset1=${(vaultDebt.ltv1 / 100).toFixed(1)}%
  Max leverage: asset0=${vaultDebt.maxLeverage0.toFixed(2)}x, asset1=${vaultDebt.maxLeverage1.toFixed(2)}x
  Current leverage: asset0=${vaultDebt.deposit0 > 0n && vaultDebt.deposit0 > vaultDebt.debt0 ? (Number(vaultDebt.deposit0) / Number(vaultDebt.deposit0 - vaultDebt.debt0)).toFixed(2) + "x" : vaultDebt.debt0 > 0n ? "∞ (debt ≥ deposit)" : "1.00x (no debt)"}, asset1=${vaultDebt.deposit1 > 0n && vaultDebt.deposit1 > vaultDebt.debt1 ? (Number(vaultDebt.deposit1) / Number(vaultDebt.deposit1 - vaultDebt.debt1)).toFixed(2) + "x" : vaultDebt.debt1 > 0n ? "∞ (debt ≥ deposit)" : "1.00x (no debt)"}
  Real capital: asset0=${vaultDebt.deposit0 > vaultDebt.debt0 ? fmtR0(vaultDebt.deposit0 - vaultDebt.debt0) : "0 (underwater)"}, asset1=${vaultDebt.deposit1 > vaultDebt.debt1 ? fmtR1(vaultDebt.deposit1 - vaultDebt.debt1) : "0 (underwater)"}` : `
## Vault Debt & Utilization
  not available`}
${registryInfo ? `
## Registry
  Registered: ${registryInfo.registered}
  Validity bond: ${(Number(registryInfo.validityBond) / 1e18).toFixed(6)} ETH
  Total pools in registry: ${registryInfo.totalPoolsInRegistry.toString()}${!registryInfo.registered ? "\n  WARNING: Pool is NOT registered — not discoverable via registry API" : ""}` : ""}
${trend ? `\n## Trend\n${trend}` : ""}
${lastReview && lastReview.recommendations.length > 0 ? `
## Previous Review (${Math.round((Date.now() / 1000 - lastReview.timestamp) / 60)} min ago)
  Recommendations: ${lastReview.recommendations.map(r => `${r.type}(${r.confidence.toFixed(1)}): ${r.reasoning}`).join("; ")}
  Executed: ${recentActions.filter(a => a.timestamp >= lastReview.timestamp).map(a => `${a.type}: ${a.success ? "OK" : "FAILED"}`).join("; ") || "none"}
  Strategy notes: ${lastReview.strategyNotes || "none"}` : ""}
`.trim();
}

function emptyReview(notes: string): ClaudeReview {
  return {
    timestamp: Math.floor(Date.now() / 1000),
    recommendations: [],
    marketAnalysis: "",
    strategyNotes: notes,
  };
}
