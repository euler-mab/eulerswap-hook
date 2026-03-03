# EulerSwap UI

Interactive visualization of the EulerSwap concentrated-liquidity AMM curve math, including boost calculations, health scoring, and NAV.

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the result.

## Testing

Unit tests and property-based fuzz tests (fast-check):

```bash
npm test
```

### Differential tests

The differential test suite (`src/lib/math.diff.test.ts`) compares the TypeScript curve functions against the on-chain Solidity `CurveLib` to verify they produce matching outputs.

**Prerequisites:** [Foundry](https://book.getfoundry.sh/getting-started/installation) (`forge` and `anvil` must be on PATH).

The tests automatically compile a thin Solidity harness (`contracts/src/CurveHarness.sol`), spin up a local anvil node, deploy the harness, and run 200 randomized input pairs per curve function.

### Boost integration tests

The boost integration test (`src/lib/math.boost.test.ts`) verifies that the TypeScript boost computation (`computeBoostX/Y`) produces equilibrium reserves that maintain health ≥ 1 at the range boundary when tested against the real on-chain EulerSwap system.

For each randomized parameter set, the test:

1. Computes boost / x0 / y0 in TypeScript and checks health at boundary (500 fast-check runs)
2. Deploys a real EulerSwap pool via `forge test` with full Euler vault infrastructure (EVC, vaults, oracle) and swaps to the boundary — if the EVC health check passes, the swap succeeds (20 runs per boundary side)

**Prerequisites:** Foundry (`forge` must be on PATH) and initialized submodules (see [Contracts](#contracts)).

## Contracts

The [EulerSwap Solidity contracts](https://github.com/euler-xyz/euler-swap) are included as a git submodule at `contracts/eulerswap`.

After cloning this repo, initialize the submodule:

```bash
git submodule update --init --recursive
```
