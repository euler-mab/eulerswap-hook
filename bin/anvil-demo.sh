#!/usr/bin/env bash
# Anvil-fork demo for the DynamicFeeAuctionHook.
# Spins up a forked-mainnet anvil node and runs the USDC/WETH deploy script
# against it using the well-known anvil test key. Never broadcasts to mainnet.

set -euo pipefail

: "${MAINNET_RPC_URL:?MAINNET_RPC_URL must be set. Copy .env.example to .env and source it.}"

ANVIL_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
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
echo "Running the USDC/WETH hook fork tests against the local anvil. This exercises"
echo "the full deploy + install path against real mainnet state."
echo

cd contracts && forge test \
  --match-contract DynamicFeeAuctionHookForkTest \
  --fork-url "http://localhost:$ANVIL_PORT" \
  -vv

echo
echo "Demo complete. Anvil shutting down."
