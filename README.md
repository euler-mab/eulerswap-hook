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

## Contracts

The [EulerSwap Solidity contracts](https://github.com/euler-xyz/euler-swap) are included as a git submodule at `contracts/eulerswap`.

After cloning this repo, initialize the submodule:

```bash
git submodule update --init --recursive
```
