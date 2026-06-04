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

# GOTCHA: this repo has TWO fork-test styles in the same suite:
#   - DynamicFeeAuctionHook.fork.t.sol → no createSelectFork; relies on --fork-url
#   - HealthAtBoundary.fork.t.sol      → vm.createSelectFork(envString("MAINNET_RPC_URL"))
# We need BOTH redirects to point at the local anvil. --fork-url alone doesn't override
# the env var, and overriding the env var alone leaves tests without a fork URL.
#
# ETHERSCAN_API_KEY is dummied because foundry.toml's [etherscan] block resolves it
# eagerly even for test runs — but anvil doesn't need it.
cd contracts && \
  MAINNET_RPC_URL="http://localhost:$ANVIL_PORT" \
  ETHERSCAN_API_KEY="${ETHERSCAN_API_KEY:-unused}" \
  forge test \
    --match-path "test/*.fork.t.sol" \
    --fork-url "http://localhost:$ANVIL_PORT" \
    -vv

echo
echo "Demo complete. Anvil shutting down."
