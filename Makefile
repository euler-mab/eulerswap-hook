# Self-documenting Makefile. Run `make` to see available targets.
#
# This is a convenience layer over commands documented in the README and walkthrough.
# Mainnet broadcasts are NOT exposed as targets — they stay as explicit
# `forge script ... --broadcast` commands in docs/build-your-own-active-lp.md.

.PHONY: help setup test fork-test demo calibrate doctor clean

help:                                ## Show this help (default target)
	@echo "Usage: make <target>"
	@echo ""
	@awk -F ':.*## ' '/^[a-z][a-zA-Z0-9_-]*:.*## / { printf "  %-18s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

setup:                               ## One-time: pull submodules, install JS deps, build
	git submodule update --init --recursive
	cd scripts && npm install
	cd contracts && forge build

test:                                ## Run unit tests (no RPC required, ~167 tests)
	cd contracts && forge test --no-match-path "test/*.fork.t.sol"

fork-test: check-rpc                 ## Run mainnet-fork tests (needs MAINNET_RPC_URL)
	cd contracts && forge test --match-path "test/*.fork.t.sol" --fork-url $$MAINNET_RPC_URL -vv

demo: check-rpc                      ## Anvil end-to-end demo: deploy USDC/WETH hook on forked mainnet
	./bin/anvil-demo.sh

calibrate:                           ## Generate paste-ready env vars: make calibrate profile=usdc-weth
	@if [ -z "$(profile)" ]; then echo "Usage: make calibrate profile=<name>  (looks up scripts/profiles/<name>.json)"; exit 1; fi
	cd scripts && npx tsx calibrate-hook-params.ts profiles/$(profile).json --env

doctor:                              ## Preflight: foundry, node, submodules, env
	./bin/doctor.sh

clean:                               ## Remove build artifacts
	cd contracts && forge clean

check-rpc:
	@if [ -z "$$MAINNET_RPC_URL" ]; then \
		echo "MAINNET_RPC_URL is not set. Copy .env.example to .env and fill it in,"; \
		echo "then 'source .env' or 'export MAINNET_RPC_URL=...' before running."; \
		exit 1; \
	fi
