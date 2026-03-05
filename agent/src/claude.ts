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
import { WAD, BPS, fmtToken } from "./types.js";

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
  vaultDebt?: VaultDebtInfo
): Promise<ClaudeReview> {
  const anthropic = getClient(config);

  const context = buildContext(snapshot, feeParams, stats, recentActions, gasSpentToday, aggQuote, decimals, vaultDebt);

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
  return `You are an autonomous LP strategy agent for an EulerSwap concentrated-liquidity pool.

## How the Dynamic Fee Works

The pool's hook computes per-swap fees using this formula:
  fee = baseFee ± (mismatchScale × mismatch), clamped to [minFee, maxFee]

Where:
- mismatch = |oraclePrice − marginalPrice| / oraclePrice (0 = perfectly aligned)
- The fee is ASYMMETRIC: the mispriced side pays baseFee + scaled mismatch (protects LP),
  the other side pays baseFee − scaled mismatch (attracts retail flow)
- When mismatch is 0, both sides pay baseFee
- When paused, all trades pay maxFee (discourages trading)

## What Each Parameter Controls

- baseFee: the fee when oracle and pool agree. Lower = more competitive, more volume.
  Higher = more revenue per trade but less flow. Typical range: 5-50 bps.
- minFee: floor for the attractive side. Prevents giving away free trades during mismatch.
  Typical: 1-10 bps.
- maxFee: ceiling for the protective side. Caps the penalty on arb trades.
  Must be < 100% (contract enforces). Typical: 50-500 bps.
- mismatchScale: sensitivity multiplier. Higher = more aggressive fee asymmetry.
  At scale=10 and mismatch=50bps, the fee adjustment is 500bps. Typical: 5-20x.

## Strategic Principles

1. **Profitability = fees − IL**. Fees grow linearly with vol, IL quadratically.
   The goal is keeping fees above the IL threshold.

2. **Undercut the market**: If aggregator spread is available, baseFee should be
   roughly market_spread/2 − ε. Just cheap enough to capture flow from competing venues.

3. **Don't change what's working**: If mismatch is low (<100bps), volume is flowing,
   and no structural regime change is visible, recommend NO changes. Frequent parameter
   changes waste gas and introduce uncertainty.

4. **Concentration is a risk dial**: Higher concentration = more capital efficiency =
   more fees BUT more IL. Only increase in low-vol, mean-reverting conditions.
   Decrease when vol is high or sustained directional drift. Range: 0.01-0.95.

5. **Equilibrium recentering**: Only recommend if reserves have drifted significantly
   from equilibrium (>5%). The rules engine handles oracle-driven recenters automatically.
   You should only recenter for structural reasons (e.g., adjusting concentration).

6. **Conservative by default**: When uncertain, recommend nothing. An empty
   recommendations array is a valid and good response.

## Safety Bounds (hardcoded, cannot be overridden)

- baseFee: ${(Number(config.minBaseFee) / Number(BPS)).toFixed(0)}-${(Number(config.maxBaseFee) / Number(BPS)).toFixed(0)} bps
- maxFee: must be < 100% (${WAD.toString()})
- minFee: must be ≤ baseFee
- mismatchScale: max 100x (${(100n * WAD).toString()})
- concentration: ${(Number(config.minConcentration) / 1e18).toFixed(2)}-${(Number(config.maxConcentration) / 1e18).toFixed(2)}
- equilibrium changes: max 3x per recenter

## Interest Rate & Rebalancing Strategy

When the pool has leverage (borrow vaults), sustained one-directional flow can cause
vault utilization to spike, pushing borrow rates above the IRM kink. The agent must
manage this risk.

**Vault debt data is provided below.** Use it to assess interest rate risk:

- utilization < 70%: no urgency — normal fees
- utilization 70-85% (near kink): mild fee asymmetry — widen min/max spread by 1-3 bps
- utilization 85-95% (above kink): strong asymmetry — rebalancing direction at minFee,
  worsening direction at maxFee. Consider equilibrium shift.
- utilization > 95% (critical): maximum asymmetry + reduce concentration + alert

**Key principle**: the agent should be willing to give up fee revenue equal to the
interest cost being avoided. If paying $100/day in borrow interest, spending $100/day
in fee discounts to attract rebalancing flow is break-even.

**Fee asymmetry for rebalancing**: unlike oracle mismatch (which protects against MEV),
reserve imbalance protects against interest rate risk. Both signals are independent
and additive. When reserves are imbalanced:
- Swaps that RESTORE balance (add the depleted asset): charge LOW fee
- Swaps that WORSEN balance (add the excess asset): charge HIGH fee

**Concentration reduction**: if utilization is critical and fees aren't rebalancing
fast enough, recommend reducing concentrationX/concentrationY. This makes the curve
more convex, naturally limiting further borrowing. Trade-off: less capital efficiency.

## Response Format

Respond with ONLY valid JSON:
{
  "recommendations": [
    {
      "type": "setFeeParams" | "reconfigure",
      "params": { ... },
      "reasoning": "...",
      "confidence": 0.0-1.0
    }
  ],
  "marketAnalysis": "Brief analysis of current conditions",
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
  Do NOT set priceX, priceY, swapHook, fee0, fee1, or expiration.`;
}

function buildContext(
  snapshot: PoolSnapshot,
  feeParams: HookFeeParams,
  stats: HookStats,
  recentActions: ExecutedAction[],
  gasSpentToday: bigint,
  aggQuote: AggregatorQuote | null,
  decimals?: AssetDecimals,
  vaultDebt?: VaultDebtInfo
): string {
  const fmtR0 = (v: bigint) => decimals ? fmtToken(v, decimals.dec0) : (Number(v) / 1e18).toFixed(6);
  const fmtR1 = (v: bigint) => decimals ? fmtToken(v, decimals.dec1) : (Number(v) / 1e18).toFixed(6);
  const fmtWad = (v: bigint) => (Number(v) / 1e18).toFixed(6);
  const fmtBps = (v: bigint) => (Number(v) / Number(BPS)).toFixed(1) + " bps";
  const fmtEth = (v: bigint) => (Number(v) / 1e18).toFixed(6) + " ETH";
  const fmtPct = (v: bigint) => (Number(v) / 1e16).toFixed(1) + "%";
  // Interest rate: per-second 1e27 ray → annualized percentage
  const fmtApr = (v: bigint) => (Number(v) * 365.25 * 86400 / 1e27 * 100).toFixed(1) + "% APR";

  return `
Reserves: ${fmtR0(snapshot.reserve0)} / ${fmtR1(snapshot.reserve1)}
Equilibrium: ${fmtR0(snapshot.equilibriumReserve0)} / ${fmtR1(snapshot.equilibriumReserve1)}
Oracle price: ${fmtWad(snapshot.oraclePrice)} (asset1 per asset0)
Marginal price: ${fmtWad(snapshot.marginalPrice)}
Mismatch: ${fmtBps(snapshot.mismatch)}
Concentration: X=${fmtWad(snapshot.concentrationX)}, Y=${fmtWad(snapshot.concentrationY)}

Hook fee params:
  baseFee: ${fmtBps(feeParams.baseFee)}
  minFee: ${fmtBps(feeParams.minFee)}
  maxFee: ${fmtBps(feeParams.maxFee)}
  mismatchScale: ${fmtWad(feeParams.mismatchScale)}
  paused: ${feeParams.paused}

Trade stats:
  Total trades: ${stats.tradeCount.toString()}
  Volume: ${fmtR0(stats.cumulativeVolume0)} / ${fmtR1(stats.cumulativeVolume1)}
  Last trade: ${stats.lastTradeAsset0In ? "asset0 in" : "asset1 in"}, size ${stats.lastTradeAsset0In ? fmtR0(stats.lastTradeSize) : fmtR1(stats.lastTradeSize)}

Gas spent today: ${fmtEth(gasSpentToday)}
Recent actions: ${recentActions.length > 0 ? recentActions.map((a) => `${a.type}: ${a.reason} (${a.success ? "OK" : "FAILED"})`).join("; ") : "none"}
${aggQuote ? `
Aggregator market data (CowSwap):
  Mid price: ${aggQuote.midPrice.toFixed(6)} (asset1 per asset0)
  Bid: ${aggQuote.bidPrice.toFixed(6)}, Ask: ${aggQuote.askPrice.toFixed(6)}
  Spread: ${aggQuote.spread.toFixed(1)} bps` : `
Aggregator market data: unavailable`}
${vaultDebt ? `
Vault debt & utilization:
  Borrow vault 0: ${vaultDebt.hasBorrowVault0 ? `debt=${fmtR0(vaultDebt.debt0)}, utilization=${fmtPct(vaultDebt.utilization0)}, borrowRate=${fmtApr(vaultDebt.borrowRate0)}, dailyCost=${fmtR0(vaultDebt.dailyCost0)}` : "disabled (no borrow vault)"}
  Borrow vault 1: ${vaultDebt.hasBorrowVault1 ? `debt=${fmtR1(vaultDebt.debt1)}, utilization=${fmtPct(vaultDebt.utilization1)}, borrowRate=${fmtApr(vaultDebt.borrowRate1)}, dailyCost=${fmtR1(vaultDebt.dailyCost1)}` : "disabled (no borrow vault)"}
  Supply deposits: ${fmtR0(vaultDebt.deposit0)} / ${fmtR1(vaultDebt.deposit1)}` : `
Vault debt & utilization: not available`}
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
