# EulerSwap UI

Interactive visualization and position builder for the EulerSwap concentrated-liquidity AMM, including boost calculations, health scoring, order book analysis, and NAV.

## Architecture

```
src/
├── app/
│   ├── page.tsx                    # Explorer: full parameter controls + chart tabs
│   └── create/page.tsx             # Position builder: guided form → preview → deploy
├── components/
│   ├── ParamControls.tsx           # 8-section parameter editor (LLTVs, prices, ranges, debt)
│   ├── ParamSlider.tsx             # Slider + number input (linear/log scale)
│   ├── OrderBookChart.tsx          # Depth, density, fingerprint charts (4 numeraire modes)
│   ├── HealthChart.tsx             # Collateral/debt/health/NAV across X and Y sides
│   ├── CurveChart.tsx              # AMM curve visualization (boosted, real, shifted)
│   ├── SimChart.tsx                # LP simulation: GBM price paths, arb replay, P&L charts
│   ├── AssetNameInputs.tsx         # Token symbol selectors + preset buttons
│   ├── Tex.tsx                     # KaTeX inline math renderer
│   └── create/                     # Position builder sub-components
│       ├── TokenPairDeposit.tsx     # Pair selector + deposit amounts
│       ├── StrategySection.tsx      # Presets, price range, concentration
│       ├── LeverageSection.tsx      # Debt asset picker + health display
│       ├── ExistingPositions.tsx    # Vault deposit/debt inputs + impact analysis
│       ├── PositionPreview.tsx      # Metrics + depth chart preview
│       ├── AdvancedSection.tsx      # Raw params + CurveChart + HealthChart
│       └── SectionCard.tsx          # Collapsible section wrapper
└── lib/
    ├── math.ts                     # Core AMM math (60 exported functions, see header)
    ├── paramBuilder.ts             # Form state → Params translation
    ├── presets.ts                   # Strategy presets (conservative/moderate/aggressive)
    ├── simulate.ts                  # LP simulation engine (GBM, arb solver, P&L tracking)
    ├── tokens.ts                    # Token metadata for presets (symbol, price, color)
    └── labels.ts                    # Asset display labels (pure UI, no math impact)
```

### Data flow

Both pages follow the same pattern:

```
User input → form state → buildParams() / direct Params → validateParams()
                                                      ↓
                         chart components ← math functions (computeX0, generateOrderBookPointsX, ...)
```

The `Params` interface (32 fields) is the central data type. All chart components accept `params: Params` and derive everything from it using pure functions in `math.ts`.

### Key concepts

The math library (`src/lib/math.ts`) has a 150-line header documenting the full mathematical model. Key ideas:

- **Virtual vs real reserves**: Virtual reserves (`x0 = xr × boost`) include concentration and leverage amplification. Real reserves (`xr`, `yr`) are actual deposits.
- **Concentration boost** (`bXC`): Concentrates liquidity in a narrower price range, increasing capital efficiency.
- **Leverage boost** (`bXL`): Calibrated so health = 1 at the range boundary. Four candidate solutions per debt mode.
- **Two-sided analysis**: X-side (price rises, AMM sells X) and Y-side (price drops, AMM sells Y) are analyzed independently with symmetric formulas.
- **Order book mapping**: `priceDelta → logPrice` uses the actual marginal price: `xLogP(d) = log(pRatio) + log(1+d)` for X-side, `yLogP(d) = log(pRatio) - log(1+d)` for Y-side.
- **LP simulation** (`simulate.ts`): Generates GBM price paths, uses a closed-form arb solver (`x = x0/√((p·py/px − cx)/(1−cx))`) to find the AMM position at each external price in O(1), tracks LP NAV vs HODL, cumulative fees, impermanent loss, and health over time.
- **Numeraire modes**: Order book charts support 4 viewing modes — raw (native units), X, Y, or external (USD). Conversion uses AMM marginal prices for raw/X/Y and oracle prices for external.

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) for the explorer, [http://localhost:3000/create](http://localhost:3000/create) for the position builder.

## Testing

906 tests across 10 test files:

| File | Tests | Coverage |
|------|-------|----------|
| `math.test.ts` | 272 | Core functions: curves, boost, health, debt phases, boundary prices, NAV |
| `math.fuzz.test.ts` | 87 | Property-based (fast-check, 500 runs): curves, order book, boost, health |
| `generators.test.ts` | 336 | Point generators, derivative consistency, density composition, phase boundaries |
| `orderbookchart.test.ts` | 122 | Depth chart coordinate mapping, swap economics, effective prices |
| `paramBuilder.test.ts` | 28 | Form → Params conversion, formatting |
| `simulate.test.ts` | 27 | Trade simulation |
| `presets.test.ts` | 9 | Preset configurations |
| `math.strategy.test.ts` | 17 | IL/NAV strategy hypotheses |
| `math.diff.test.ts` | 5 | TS vs Solidity differential (requires Foundry) |
| `math.boost.test.ts` | 3 | On-chain health validation (requires Foundry) |

```bash
npm test                              # all tests (requires Foundry for last 2)
npx vitest run src/lib/math.test.ts   # unit tests only (no Foundry needed)
```

### Differential tests

`math.diff.test.ts` compares TypeScript curve functions (`fX`, `gY`, `fY`, `gX`) against Solidity `CurveLib` via a thin harness. Spins up anvil, deploys `CurveHarness.sol`, runs 200 randomized inputs per function. Tolerance: `max(3 wei, |value| × 1e-9)`.

**Prerequisites:** [Foundry](https://book.getfoundry.sh/getting-started/installation) (`forge` and `anvil` on PATH).

### Boost integration tests

`math.boost.test.ts` verifies the TypeScript boost computation against real on-chain EulerSwap:

1. 500 fast-check runs: compute boost → verify H ≥ 1 at boundary in TypeScript
2. 20 forge runs per boundary: deploy full EulerSwap pool (EVC + vaults + oracle), swap to boundary, verify EVC health check passes

**Prerequisites:** Foundry + initialized submodules (see below).

## Contracts

The [EulerSwap Solidity contracts](https://github.com/euler-xyz/euler-swap) are included as a git submodule at `contracts/eulerswap`.

After cloning this repo, initialize the submodule:

```bash
git submodule update --init --recursive
```
