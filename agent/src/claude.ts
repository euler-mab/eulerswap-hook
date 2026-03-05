import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentConfig,
  PoolSnapshot,
  HookFeeParams,
  HookStats,
  ExecutedAction,
  ClaudeReview,
  ClaudeRecommendation,
  AssetDecimals,
  VaultDebtInfo,
} from "./types.js";
import type { AggregatorQuote } from "./oracle.js";
import type { FundingSnapshot } from "./funding.js";
import { WAD, BPS, fmtToken } from "./types.js";
import { getTrendSummary, getFlowSummary, getMetrics } from "./metrics.js";

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
  stats: HookStats,
  recentActions: ExecutedAction[],
  gasSpentToday: bigint,
  aggQuote: AggregatorQuote | null = null,
  decimals?: AssetDecimals,
  vaultDebt?: VaultDebtInfo,
  funding?: FundingSnapshot | null,
): Promise<ClaudeReview> {
  const anthropic = getClient(config);

  const context = buildContext(snapshot, feeParams, stats, recentActions, gasSpentToday, aggQuote, decimals, vaultDebt, funding);

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
  return `You are an autonomous LP strategy agent for a **delta-neutral** EulerSwap position.

## Core Objective: Delta-Neutral Market Making

Your position provides concentrated liquidity while maintaining **zero net directional exposure**.
The pool supplies both assets symmetrically around equilibrium. With leverage, it borrows one
asset and supplies both — the debt creates a natural hedge against the supplied asset.

**Delta** = the dollar value of your reserve imbalance relative to equilibrium.
- Delta ≈ 0: neutral — you earn fees without directional risk
- Delta > 0 (long asset0): reserves have drifted, you're exposed to asset0 price drops
- Delta < 0 (short asset0): the reverse

**Your job**: keep delta near zero while maximizing fee income minus costs.

**P&L components** (in priority order):
1. **Fee revenue** — your income. Proportional to volume × fee rate.
2. **Net carry** — deposit yield minus borrow cost. Negative carry burns capital.
3. **Impermanent loss** — grows quadratically with price moves. Concentration amplifies it.
4. **Gas costs** — reconfigurations and swaps consume ETH.

**Decision rule**: only act when the expected value of the action exceeds its cost.
An empty recommendations array is always valid and often optimal.

## How the Dynamic Fee Works

The hook computes fees in two layers, clamped to [minFee, maxFee]:

### Layer 1: Time-Decay Surcharge (primary arb protection)
  fee = baseFee + decaySurcharge × max(0, decayPeriod − elapsed) / decayPeriod

The hook tracks lastTradeBlock. On each swap:
- **Same block as previous trade** (lastTradeBlock == block.number): NO surcharge.
  The arb already traded, these are retail — charge just baseFee.
- **New block** (lastTradeBlock < block.number): FULL surcharge, decayed by time since
  last trade. If elapsed < decayPeriod, surcharge = decaySurcharge × (period − elapsed) / period.
  If elapsed ≥ decayPeriod (pool idle for a while), no surcharge — the oracle has had
  time to update, so the first trade isn't necessarily arb.

This requires NO oracle reads — pure block-number + time signal. Cheap gas, maximal arb protection.

### Layer 2: Oracle Mismatch (optional directional asymmetry)
When mismatchScale > 0, the hook reads the oracle and adds directional fee adjustment:
- Side that exploits mispricing: +scaledMismatch (arb tax)
- Side that restores alignment: −scaledMismatch (retail incentive)

This costs extra gas per swap for the oracle read. Set mismatchScale = 0 to disable
and rely purely on the time-decay. Only enable when directional signals are valuable.

When paused, all trades pay maxFee.

## What Each Parameter Controls

**Core fee params** (setFeeParams):
- baseFee: the resting fee after decay. Lower = more competitive. Typical: 5-50 bps.
- minFee: floor. Prevents negative fees. Typical: 1-10 bps.
- maxFee: ceiling. Caps total fee including surcharge. Typical: 50-500 bps.
- mismatchScale: oracle mismatch sensitivity. 0 = disabled (saves gas). Typical: 0-20x.

**Decay params** (setDecayParams):
- decaySurcharge: the arb tax added to baseFee for the first trade in a new block.
  Should approximate the typical price move between blocks. Typical: 20-100 bps.
- decayPeriod: seconds for the surcharge to reach zero. 12 = one Ethereum block.
  Shorter = more aggressive (surcharge gone faster). Typical: 12-60 seconds.

## MEV Protection & Flow Quality

### How the two layers interact
Time-decay is the workhorse — it captures most arb value without any oracle dependency.
The oracle mismatch adds refinement: even within a block, it charges more on the side that
exploits known mispricing. But the oracle is always slightly stale, so the time-decay
handles the gap between true market price and oracle update.

### Tuning the arb tax
- **decaySurcharge** is the primary arb protection knob. Higher = more arb revenue but
  risk discouraging even the first aligning trade. Start at ~50 bps for volatile pairs.
- **decayPeriod = 12** (one block) is the default. Increase to 24-60 if oracle updates
  are slower than block time.
- **maxFee** caps the total (baseFee + surcharge + mismatch). If decaySurcharge = 50 bps
  and baseFee = 25 bps, maxFee should be ≥ 75 bps or the surcharge gets clamped.
- **mismatchScale = 0** is fine for most pools — the time-decay alone captures arb value.
  Enable mismatchScale only if you see arbs consistently exploiting directional mispricing
  that the symmetric surcharge doesn't catch.

### Reading the Flow Quality data
The context includes a Flow Quality section (when enough data exists) showing:
- **Arb-like intervals**: polls where trades resolved mismatch. High % = most volume is arb.
- **Retail-like intervals**: polls where trades created/maintained mismatch.
- **Arb volume share**: what fraction of volume is likely arb.
- **Directional runs**: consecutive same-direction trading = structural/informed flow.

### Strategy implications
- **High arb % (>70%)**: decaySurcharge may be too low — arbs are trading through cheaply.
  Increase decaySurcharge or extend decayPeriod.
- **High retail % (>50%)**: Good — the pool is attracting organic flow. Keep fees competitive.
- **High directional runs**: Structural flow in one direction. This isn't arb — it's informed
  traders or market regime shift. Consider recentering equilibrium rather than fighting it.
- **Low trade velocity**: Not enough flow. Lower baseFee to attract volume.

## Strategic Principles

1. **Undercut the market**: If aggregator spread is available, baseFee should be
   roughly market_spread/2 − ε. Just cheap enough to capture flow from competing venues.

2. **Don't change what's working**: If delta is near zero, carry is positive, volume is
   flowing, and no regime change is visible, recommend NO changes. Frequent parameter
   changes waste gas and introduce uncertainty.

3. **Concentration is a risk dial**: Higher concentration = more capital efficiency =
   more fees BUT more IL and faster delta drift. Only increase in low-vol, mean-reverting
   conditions. Decrease when vol is high or sustained directional drift. Range: 0.01-0.95.

4. **Equilibrium recentering**: The rules engine handles oracle-driven recenters
   automatically (>5% drift). Only recommend recenters for structural reasons
   (e.g., adjusting concentration alongside equilibrium).

5. **Conservative by default**: When uncertain, recommend nothing.

## Safety Bounds (hardcoded, cannot be overridden)

- baseFee: ${(Number(config.minBaseFee) / Number(BPS)).toFixed(0)}-${(Number(config.maxBaseFee) / Number(BPS)).toFixed(0)} bps
- maxFee: must be < 100% (${WAD.toString()})
- minFee: must be ≤ baseFee
- mismatchScale: max 100x (${(100n * WAD).toString()})
- concentration: ${(Number(config.minConcentration) / 1e18).toFixed(2)}-${(Number(config.maxConcentration) / 1e18).toFixed(2)}
- equilibrium changes: max 3x per recenter

## Rebalancing: Flattening Delta

When reserves drift from equilibrium, you accumulate delta. Flatten it using these
tools in escalating order:

### Layer 1: Fee Asymmetry (gas-free, preferred)
Adjust fee params so swaps that reduce delta pay lower fees and swaps that increase
delta pay higher fees. The hook applies this per-swap automatically.

When reserves are imbalanced:
- Swaps that RESTORE balance (add the depleted asset): charge LOW fee
- Swaps that WORSEN balance (add the excess asset): charge HIGH fee

### Layer 2: Interest Rate Response
When the pool has leverage, reserve drift also causes vault utilization spikes:

- utilization < 70%: no urgency — normal fees
- utilization 70-85% (near kink): mild fee asymmetry — widen min/max spread by 1-3 bps
- utilization 85-95% (above kink): strong asymmetry — minFee for rebalancing, maxFee for worsening
- utilization > 95% (critical): maximum asymmetry + reduce concentration

**Key principle**: spend up to dailyBorrowCost in fee discounts to attract rebalancing flow.
If paying $100/day in borrow interest, $100/day in fee discounts is break-even.

### Layer 3: Concentration Reduction (emergency)
Reducing concentration makes the curve more convex — larger price impact per swap,
which naturally discourages further imbalance. Trade-off: less capital efficiency.

### Layer 4: External Swap (last resort)
Recommend an **externalSwap** — the agent withdraws the excess asset from the supply
vault, swaps on CowSwap for the depleted asset, and deposits back.

**When to use**: Only when ALL are true:
1. Utilization is critical (>90%) and rising (check the trend)
2. Fee asymmetry has been active for multiple review cycles with no improvement
3. Daily interest cost exceeds expected swap cost (gas + slippage)
4. Confidence ≥ 0.8

**Risks**: 4-5 transactions, slippage, temporarily reduces reserves.
Max ${(Number(config.maxSwapPct) / 1e16).toFixed(0)}% of reserves per swap.

**Choosing sellAsset**: Sell the EXCESS asset (reserves > equilibrium) to buy the DEPLETED.

## Funding-Aware Fee Strategy

When perp funding data is available, use it to orient your fee asymmetry for maximum revenue.

**Core insight**: If funding is positive (longs pay shorts), shorting perps is profitable.
We WANT the LP to accumulate the volatile asset (go long spot) so we can hedge with a
profitable short perp. Therefore:
- **Longs pay (positive funding)**: Lower fees for swaps that give us MORE of the volatile
  asset (we go long spot). Higher fees for swaps that take the volatile asset away.
  Our long spot + short perp = delta-neutral + funding income.
- **Shorts pay (negative funding)**: Lower fees for swaps that REMOVE the volatile asset
  (we go short spot). Higher fees for swaps that give us more of it.
  Our short spot + long perp = delta-neutral + funding income.
- **Neutral funding (|APR| < 1%)**: Ignore funding; use standard rebalancing logic.

**Interaction with delta flattening**: Funding orientation takes PRIORITY over delta
flattening when the funding rate is significant (|APR| > 5%). Between 1-5% APR, blend
both signals — favor funding direction but don't ignore extreme imbalances.

**Revenue math**: A 10% APR on $100K notional = $27/day. Compare this to fee income
and borrow costs to decide how aggressively to orient toward the funding-profitable side.

**In marketAnalysis**: Always note the current funding rate, direction, and whether your
fee recommendations align with the funding-profitable direction.

## Carry Optimization

Net carry = daily supply yield − daily borrow cost. This is a persistent P&L component that
compounds over time and can dwarf fee revenue or gas costs.

### When carry is negative (borrow cost > supply yield)
Negative carry is burning capital. Every hour costs money. Priorities:
1. **Reduce concentration** — less concentrated positions use less leverage and incur lower
   borrow costs. Trade-off: lower capital efficiency and less fee revenue per unit volume.
   But if net carry is −$50/day and fees are only $20/day, the position is unprofitable
   regardless of fee settings. Reduce concentration until carry is manageable.
2. **Attract rebalancing flow** — when one vault has much higher utilization (and therefore
   borrow rate) than the other, rebalancing reduces utilization of the expensive vault.
   Use fee asymmetry as in Layer 2, but calibrated to the CARRY cost, not just utilization level.
3. **External swap toward the cheaper vault** — if vault 0 borrow rate >> vault 1, an external
   swap that moves reserves toward vault 0 equilibrium reduces vault 0 utilization and carry cost.
4. **Equilibrium shift** — if structural flow consistently pushes reserves toward one side,
   consider recentering equilibrium to accept the new natural resting point rather than paying
   carry to fight it.

### When carry is positive (supply yield > borrow cost)
Positive carry means the position earns money passively. In this regime:
1. **Increase concentration cautiously** — higher concentration means more leverage, more
   borrow cost, but also more fee revenue. Only increase if the marginal fee revenue exceeds
   the marginal borrow cost increase.
2. **Tolerate more delta** — with positive carry, you can afford to let reserves drift further
   before intervening. Widen your rebalancing thresholds.

### Carry-aware fee budgeting
The key principle: **fee discounts for rebalancing should not exceed the carry savings they create**.
If reducing vault 0 utilization from 85% to 70% saves $30/day in borrow cost, you can afford
up to $30/day in fee discounts to attract that rebalancing flow. More than that is negative EV.

**In strategyNotes**: Always compare net carry to fee revenue. If |carry| > fee revenue,
carry optimization should dominate your recommendations over fee optimization.

## Competitor-Aware Pricing

The aggregator data (CowSwap bid/ask/spread) tells you the **cost of trading elsewhere**.
Your fees must be competitive with this external spread or you get zero flow.

### Reading the spread
- **Tight external spread (< 5 bps)**: Deep liquidity exists elsewhere. Your baseFee must
  be in the same range or routers will never route to you. Compete on price.
- **Moderate spread (5-20 bps)**: Room to charge meaningful fees while still attracting flow.
  Set baseFee at or slightly below the external spread midpoint.
- **Wide spread (> 20 bps)**: Thin external liquidity — you have pricing power. Raise baseFee
  to capture more per trade. Flow will come because you're still the best option.

### Key principle
Your effective fee (including mismatch adjustment) should be **slightly below** the external
spread for the rebalancing direction, and can be **at or above** it for the worsening direction.
This ensures:
1. Rebalancing flow prefers your pool (you get the trades that help you)
2. Worsening flow goes elsewhere (let other pools absorb the toxic side)

### Dynamic adjustment
External spreads change with market conditions. When you see the spread widening over time
(compare current to previous reviews), it often signals increasing volatility or decreasing
external liquidity — a good time to widen your fees too. When spreads compress, tighten
your baseFee to stay competitive.

### When aggregator data is unavailable
Fall back to conservative defaults. Don't aggressively lower fees when you can't verify
that the external market supports it.

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

**setFeeParams** (all 4 required):
  baseFee: WAD-scaled. 25 bps = "${(25n * BPS).toString()}"
  minFee: WAD-scaled. 5 bps = "${(5n * BPS).toString()}"
  maxFee: WAD-scaled. 200 bps = "${(200n * BPS).toString()}"
  mismatchScale: WAD-scaled multiplier. 10x = "${(10n * WAD).toString()}"

**reconfigure**:
  concentrationX, concentrationY: WAD-scaled. 0.40 = "${(40n * WAD / 100n).toString()}"
  equilibriumReserve0, equilibriumReserve1: RAW on-chain token amounts (NOT WAD-scaled).
    Current values: eq0=${snapshot.equilibriumReserve0.toString()}, eq1=${snapshot.equilibriumReserve1.toString()}
  Do NOT set priceX, priceY, swapHook, fee0, fee1, or expiration.

**externalSwap** (all 3 required):
  sellAsset: "0" or "1" — which pool asset to sell
  sellAmount: RAW token amount to sell (NOT WAD-scaled)
  minBuyAmount: minimum acceptable buy amount (slippage protection)
    Reserve0=${snapshot.reserve0.toString()}, Reserve1=${snapshot.reserve1.toString()}
    Max per swap: ${(Number(config.maxSwapPct) / 1e16).toFixed(0)}% of the sell-side reserve`;
}

function buildContext(
  snapshot: PoolSnapshot,
  feeParams: HookFeeParams,
  stats: HookStats,
  recentActions: ExecutedAction[],
  gasSpentToday: bigint,
  aggQuote: AggregatorQuote | null,
  decimals?: AssetDecimals,
  vaultDebt?: VaultDebtInfo,
  funding?: FundingSnapshot | null,
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
  let feeRevenueSection = "";

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

  // Fee revenue estimate from cumulative volume
  const metricsData = getMetrics();
  const runtimeSec = (Date.now() - metricsData.startTime) / 1000;
  if (runtimeSec > 60 && stats.cumulativeVolume0 > 0n) {
    const avgFeeWad = (feeParams.baseFee + feeParams.minFee) / 2n; // conservative estimate
    const dailyVol0Uoa = toUoa0(stats.cumulativeVolume0) * 86400 / runtimeSec;
    const dailyVol1Uoa = toUoa1(stats.cumulativeVolume1) * 86400 / runtimeSec;
    const dailyFeeRev = (dailyVol0Uoa + dailyVol1Uoa) * Number(avgFeeWad) / 1e18;
    feeRevenueSection = `\nEstimated daily fee revenue: ${fmtUsd(dailyFeeRev)} (from ${fmtUsd(dailyVol0Uoa + dailyVol1Uoa)}/day volume)`;
  }

  // --- Trend summary ---
  const trend = getTrendSummary();
  const flow = getFlowSummary();

  return `
## Position Delta
Net delta: ${fmtUsd(deltaUsd)} (${deltaUsd > 0 ? "LONG" : deltaUsd < 0 ? "SHORT" : "NEUTRAL"} asset0)
Reserve imbalance: asset0 ${imbal0Pct >= 0 ? "+" : ""}${imbal0Pct.toFixed(1)}%, asset1 ${imbal1Pct >= 0 ? "+" : ""}${imbal1Pct.toFixed(1)}% vs equilibrium${navSection}${carrySection}${feeRevenueSection}

## Pool State
Reserves: ${fmtR0(snapshot.reserve0)} / ${fmtR1(snapshot.reserve1)}
Equilibrium: ${fmtR0(snapshot.equilibriumReserve0)} / ${fmtR1(snapshot.equilibriumReserve1)}
Oracle price: ${fmtWad(snapshot.oraclePrice)} (asset1 per asset0)
Marginal price: ${fmtWad(snapshot.marginalPrice)}
Mismatch: ${fmtBps(snapshot.mismatch)}
Concentration: X=${fmtWad(snapshot.concentrationX)}, Y=${fmtWad(snapshot.concentrationY)}

## Hook Fee Params
  baseFee: ${fmtBps(feeParams.baseFee)}
  minFee: ${fmtBps(feeParams.minFee)}
  maxFee: ${fmtBps(feeParams.maxFee)}
  mismatchScale: ${fmtWad(feeParams.mismatchScale)}
  paused: ${feeParams.paused}

## Trade Stats
  Total trades: ${stats.tradeCount.toString()}
  Volume: ${fmtR0(stats.cumulativeVolume0)} / ${fmtR1(stats.cumulativeVolume1)}
  Last trade: ${stats.lastTradeAsset0In ? "asset0 in" : "asset1 in"}, size ${stats.lastTradeAsset0In ? fmtR0(stats.lastTradeSize) : fmtR1(stats.lastTradeSize)}

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
  Formula: maxLeverage = 1 / (1 - LTV). Current debt/deposit ratio: asset0=${vaultDebt.deposit0 > 0n ? (Number(vaultDebt.debt0) * 100 / Number(vaultDebt.deposit0)).toFixed(1) : "0"}%, asset1=${vaultDebt.deposit1 > 0n ? (Number(vaultDebt.debt1) * 100 / Number(vaultDebt.deposit1)).toFixed(1) : "0"}%` : `
## Vault Debt & Utilization
  not available`}
${trend ? `\n## Trend\n${trend}` : ""}
${flow ? `\n## Flow Quality\n${flow}` : ""}
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
