#!/usr/bin/env bash
# Anvil-fork demo for the DynamicFeeAuctionHook.
# Spins up a forked-mainnet anvil node and runs the USDC/WETH hook fork tests
# against it — they deploy the full hook + bind it + assert it works. Never broadcasts.

set -euo pipefail

: "${MAINNET_RPC_URL:?MAINNET_RPC_URL must be set. Copy .env.example to .env and source it.}"

ANVIL_PORT=${ANVIL_PORT:-8545}

cleanup() {
  if [ -n "${ANVIL_PID:-}" ]; then
    kill "$ANVIL_PID" 2>/dev/null || true
    wait "$ANVIL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "Forking mainnet to anvil on port $ANVIL_PORT..."
anvil --fork-url "$MAINNET_RPC_URL" --port "$ANVIL_PORT" --silent &
ANVIL_PID=$!

for _ in $(seq 1 20); do
  if cast block-number --rpc-url "http://localhost:$ANVIL_PORT" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo "Anvil ready."
echo
echo "Running the hook fork tests against the local anvil. This exercises the full"
echo "deploy + install path against real mainnet state."
echo

# Scope to DynamicFeeAuctionHook.fork.t.sol — the canonical "does the hook
# deploy, install, quote, swap, recenter, auction on real mainnet state"
# demonstration. HealthAtBoundary.fork.t.sol is power-user territory: it
# pushes swaps to the exact getLimits() boundary, which is sensitive to the
# tiniest live-state drift even at a pinned block. Run that one via
# `make fork-test` if you want it.
#
# Two tests in the file depend on specific live LP account state and are
# skipped here:
#   - test_fork_surcharge_no_overflow: a 2%-of-reserves swap that pushes the
#     fork account past EVK liquidity. Overflow case is unit-tested instead.
#   - test_fork_continuous_recenter: expects pre-existing high exposure on the
#     LP account to drive a specific auction/recenter sequence; at a fresh
#     pinned block the account isn't that loaded.
# Both still run via `make fork-test`; they're not demo-quality reliable.
#
# GOTCHA: tests use vm.createSelectFork(vm.envString("MAINNET_RPC_URL"), BLOCK)
# so they fork FROM THE ENV VAR, not from `forge test --fork-url`. Override
# the env var so they hit local anvil. --fork-url is kept for tests that
# don't call createSelectFork.
#
# ETHERSCAN_API_KEY is dummied because foundry.toml's [etherscan] block
# resolves it eagerly even for test runs — but anvil doesn't need it.
cd contracts && \
  MAINNET_RPC_URL="http://localhost:$ANVIL_PORT" \
  ETHERSCAN_API_KEY="${ETHERSCAN_API_KEY:-unused}" \
  forge test \
    --match-path "test/DynamicFeeAuctionHook.fork.t.sol" \
    --no-match-test "test_fork_surcharge_no_overflow|test_fork_continuous_recenter" \
    --fork-url "http://localhost:$ANVIL_PORT" \
    -vv

echo
echo "Demo complete. Anvil shutting down."
