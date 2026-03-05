#!/bin/bash
set -euo pipefail

# EulerSwap LP Agent — Fork Test Simulation Harness
#
# Simulates oracle price movements and swap activity on an Anvil fork.
# Requires: fork-test.sh already running (pool + hook deployed, Anvil alive).
#
# IMPORTANT: Start this harness BEFORE the agent! It replaces the real
# Chainlink oracle with a SimPriceOracle whose prices match the pool's
# hardcoded initial reserves (25k USDC / 10 WETH). If the agent polls
# first, it sees the real oracle (which doesn't match) and recenters to
# garbage reserves.
#
# Test flow:
#   Terminal 1: ./fork-test.sh              # deploy pool + hook, start Anvil
#   Terminal 2: ./sim-harness.sh            # replace oracle, start simulation
#   Terminal 3: cd agent && npm start       # start agent (oracle already correct)
#
# Modes:
#   ./sim-harness.sh                   # default: sinusoidal ±5% around initial price
#   ./sim-harness.sh --drift           # steady upward drift
#   ./sim-harness.sh --volatile        # random ±1-5% swings

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTRACTS_DIR="$SCRIPT_DIR/../contracts"
ENV_FILE="$SCRIPT_DIR/.env.fork"

if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE not found. Run fork-test.sh first."
    exit 1
fi

# Load env (disable nounset during source — .env.fork may reference unset vars like ANTHROPIC_API_KEY)
set -a
set +u
source "$ENV_FILE"
set -u
set +a

ANVIL_RPC="${RPC_URL:?RPC_URL not set in .env.fork}"
DEPLOYER_KEY="${PRIVATE_KEY:?PRIVATE_KEY not set}"
POOL="${POOL_ADDRESS:?POOL_ADDRESS not set}"

# Mode
MODE="${1:---default}"

# Known addresses
USDC="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
WETH="0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
USDC_WHALE="0x55FE002aeff02F77364de339a1292923A15844B8"
DEPLOYER="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

# Swap amounts (small relative to pool)
USDC_SWAP_AMOUNT=100000000       # 100 USDC (6 decimals)
WETH_SWAP_AMOUNT=40000000000000000  # 0.04 WETH (18 decimals)

# Helper: encode an integer (decimal or 0x hex) as 0x-prefixed left-padded 32-byte hex
# (cast to-bytes32 treats input as byte string and RIGHT-pads — wrong for uint256)
to_bytes32() {
    python3 -c "print('0x' + format(int('$1', 0), '064x'))"
}

# Helper: strip [sci] suffix from cast call output (e.g. "100000000 [1e8]" → "100000000")
strip_cast() {
    awk '{print $1}'
}

echo "============================================"
echo " EulerSwap Simulation Harness"
echo "============================================"
echo "Mode: $MODE"
echo "Pool: $POOL"
echo "RPC:  $ANVIL_RPC"
echo ""

# --- Step 1: Read on-chain addresses ---
echo "Reading pool configuration..."

ASSETS=$(cast call "$POOL" "getAssets()(address,address)" --rpc-url "$ANVIL_RPC")
ASSET0=$(echo "$ASSETS" | head -1 | strip_cast)
ASSET1=$(echo "$ASSETS" | tail -1 | strip_cast)
echo "  Asset0: $ASSET0"
echo "  Asset1: $ASSET1"

# Get supplyVault0 from static params (first field of the tuple)
STATIC_PARAMS=$(cast call "$POOL" "getStaticParams()(address,address,address,address,address,address)" --rpc-url "$ANVIL_RPC")
SUPPLY_VAULT0=$(echo "$STATIC_PARAMS" | head -1 | strip_cast)
echo "  SupplyVault0: $SUPPLY_VAULT0"

# Get oracle address from vault
ORACLE=$(cast call "$SUPPLY_VAULT0" "oracle()(address)" --rpc-url "$ANVIL_RPC" | strip_cast)
echo "  Oracle: $ORACLE"

# --- Step 2: Replace oracle with SimPriceOracle ---
echo ""
echo "Replacing oracle with SimPriceOracle..."

cd "$CONTRACTS_DIR"
BYTECODE=$(forge inspect src/test/SimPriceOracle.sol:SimPriceOracle deployedBytecode)
cast rpc anvil_setCode "$ORACLE" "$BYTECODE" --rpc-url "$ANVIL_RPC" > /dev/null

# Mock oracle prices must match what the hook expects from getQuote(WAD, asset, unitOfAccount).
# getQuote(1e18_raw_units, asset, uoa) returns the value of 1e18 RAW units of the asset.
#
# For USDC (6 decimals): 1e18 raw = 1e12 actual USDC = $1e12
#   → price0 = 1e12 * 1e18 = 1e30 (WAD-scaled)
# For WETH (18 decimals): 1e18 raw = 1 actual WETH = $ETH_USD
#   → price1 = ETH_USD * 1e18 (WAD-scaled)
#
# The hook computes: oraclePrice = (price0 * WAD) / price1
# The hook computes: marginalPrice = (reserve1 * WAD) / reserve0
# At equilibrium (25000 USDC / 10 WETH), both should be ~4e26.

USDC_PRICE=1000000000000000000000000000000   # 1e30: value of 1e18 raw USDC = 1e12 USDC @ $1
ETH_USD=2500                                  # ETH price in USD (human-readable)
ETH_PRICE=$(python3 -c "print(int($ETH_USD * 10**18))")  # 2500e18

cast rpc anvil_setStorageAt "$ORACLE" "0x0" "$(to_bytes32 $USDC_PRICE)" --rpc-url "$ANVIL_RPC" > /dev/null
cast rpc anvil_setStorageAt "$ORACLE" "0x1" "$(to_bytes32 $ETH_PRICE)" --rpc-url "$ANVIL_RPC" > /dev/null
cast rpc anvil_setStorageAt "$ORACLE" "0x2" "$(to_bytes32 "$ASSET0")" --rpc-url "$ANVIL_RPC" > /dev/null
cast rpc anvil_setStorageAt "$ORACLE" "0x3" "$(to_bytes32 "$ASSET1")" --rpc-url "$ANVIL_RPC" > /dev/null

# Verify: hook computes oraclePrice = (getQuote(WAD,USDC,uoa) * WAD) / getQuote(WAD,WETH,uoa)
#        = (1e30 * 1e18) / 2500e18 = 4e26
# Marginal at equilibrium: (10e18 * 1e18) / 2.5e10 = 4e26 ✓
VERIFY=$(cast call "$ORACLE" "getQuote(uint256,address,address)(uint256)" \
    1000000000000000000 "$ASSET1" "$ASSET0" --rpc-url "$ANVIL_RPC" | strip_cast)
echo "  Mock oracle WETH quote: $VERIFY (expected $ETH_PRICE)"
echo "  Oracle replaced!"

# --- Step 3: Deploy EulerSwapPeriphery ---
echo ""
echo "Deploying EulerSwapPeriphery..."

PERIPHERY_OUTPUT=$(forge create eulerswap/src/EulerSwapPeriphery.sol:EulerSwapPeriphery \
    --rpc-url "$ANVIL_RPC" --private-key "$DEPLOYER_KEY" --broadcast 2>&1)
PERIPHERY=$(echo "$PERIPHERY_OUTPUT" | grep "Deployed to:" | awk '{print $3}')
echo "  Periphery: $PERIPHERY"

# --- Step 4: Fund swapper with tokens ---
echo ""
echo "Funding swapper with tokens..."

# Fund with USDC from whale (enough for many swaps)
cast rpc anvil_impersonateAccount "$USDC_WHALE" --rpc-url "$ANVIL_RPC" > /dev/null
cast send "$USDC" "transfer(address,uint256)" "$DEPLOYER" 10000000000 \
    --from "$USDC_WHALE" --rpc-url "$ANVIL_RPC" --unlocked > /dev/null
cast rpc anvil_stopImpersonatingAccount "$USDC_WHALE" --rpc-url "$ANVIL_RPC" > /dev/null
echo "  Funded 10,000 USDC"

# Wrap ETH for WETH (deployer has 10000 ETH on Anvil)
cast send "$WETH" "deposit()" --value 5000000000000000000 \
    --from "$DEPLOYER" --private-key "$DEPLOYER_KEY" --rpc-url "$ANVIL_RPC" > /dev/null 2>&1
echo "  Wrapped 5 ETH → WETH"

# Approve periphery for both tokens (type(uint256).max)
MAX_UINT="115792089237316195423570985008687907853269984665640564039457584007913129639935"
cast send "$USDC" "approve(address,uint256)" "$PERIPHERY" "$MAX_UINT" \
    --from "$DEPLOYER" --private-key "$DEPLOYER_KEY" --rpc-url "$ANVIL_RPC" > /dev/null
cast send "$WETH" "approve(address,uint256)" "$PERIPHERY" "$MAX_UINT" \
    --from "$DEPLOYER" --private-key "$DEPLOYER_KEY" --rpc-url "$ANVIL_RPC" > /dev/null
echo "  Approved periphery for USDC + WETH"

# --- Step 5: Simulation loop ---
echo ""
echo "============================================"
echo " Starting simulation loop ($MODE)"
echo "============================================"
echo ""

STEP=0
CURRENT_ETH_USD=$ETH_USD

while true; do
    STEP=$((STEP + 1))

    # --- Compute new ETH price based on mode ---
    case "$MODE" in
        --drift)
            # Steady upward drift: +0.5% per step
            CURRENT_ETH_USD=$(python3 -c "print(round($CURRENT_ETH_USD * 1.005, 2))")
            ;;
        --volatile)
            # Random ±1-5% swings
            CURRENT_ETH_USD=$(python3 -c "
import random
change = random.uniform(-0.05, 0.05)
print(round($CURRENT_ETH_USD * (1 + change), 2))
")
            ;;
        --default|*)
            # Sinusoidal: ±5% around base, period ~20 steps
            CURRENT_ETH_USD=$(python3 -c "
import math
base = $ETH_USD
amplitude = 0.05
phase = $STEP * 2 * math.pi / 20
print(round(base * (1 + amplitude * math.sin(phase)), 2))
")
            ;;
    esac

    # --- Update oracle (only price1 = ETH price changes; USDC stays at $1) ---
    CURRENT_ETH_PRICE=$(python3 -c "print(int(float('$CURRENT_ETH_USD') * 10**18))")
    cast rpc anvil_setStorageAt "$ORACLE" "0x1" "$(to_bytes32 $CURRENT_ETH_PRICE)" \
        --rpc-url "$ANVIL_RPC" > /dev/null

    echo "Step $STEP: ETH price → \$$CURRENT_ETH_USD"

    # --- Advance time (30-60 seconds) ---
    TIME_ADVANCE=$(python3 -c "import random; print(random.randint(30, 60))")
    cast rpc evm_increaseTime "$TIME_ADVANCE" --rpc-url "$ANVIL_RPC" > /dev/null
    cast rpc evm_mine --rpc-url "$ANVIL_RPC" > /dev/null

    # --- Determine swap direction based on mismatch ---
    # Read reserves
    RESERVES=$(cast call "$POOL" "getReserves()(uint112,uint112,uint32)" --rpc-url "$ANVIL_RPC")
    R0=$(echo "$RESERVES" | head -1 | strip_cast)
    R1=$(echo "$RESERVES" | sed -n '2p' | strip_cast)

    # Replicate the hook's price comparison:
    #   oraclePrice  = (price0 * WAD) / price1  = (1e30 * 1e18) / (ETH_USD * 1e18) = 1e30 / ETH_USD
    #   marginalPrice = (reserve1 * WAD) / reserve0
    # Both are in the same unit space (WETH-per-USDC in raw-unit terms, WAD-scaled).
    DIRECTION=$(python3 -c "
r0 = $R0
r1 = $R1
usdc_price = $USDC_PRICE
eth_price = $CURRENT_ETH_PRICE
oracle_price = usdc_price * 10**18 / eth_price  # matches hook's (price0 * WAD) / price1
marginal = r1 * 10**18 / r0 if r0 > 0 else 0    # matches hook's (reserve1 * WAD) / reserve0
# If oracle > marginal: pool underprices asset0 (USDC), arbitrageur buys USDC (sends WETH)
# If oracle < marginal: pool overprices asset0 (USDC), arbitrageur sells USDC (sends USDC)
if oracle_price > marginal * 1.001:
    print('sell_weth')  # Send WETH to pool, receive USDC
elif oracle_price < marginal * 0.999:
    print('buy_weth')   # Send USDC to pool, receive WETH
else:
    print('skip')
")

    if [ "$DIRECTION" = "buy_weth" ]; then
        # Sell USDC → Buy WETH
        QUOTE=$(cast call "$PERIPHERY" \
            "quoteExactInput(address,address,address,uint256)(uint256)" \
            "$POOL" "$USDC" "$WETH" "$USDC_SWAP_AMOUNT" \
            --rpc-url "$ANVIL_RPC" 2>/dev/null | strip_cast || echo "0")

        if [ "$QUOTE" != "0" ]; then
            cast send "$PERIPHERY" \
                "swapExactIn(address,address,address,uint256,address,uint256,uint256)" \
                "$POOL" "$USDC" "$WETH" "$USDC_SWAP_AMOUNT" "$DEPLOYER" 0 0 \
                --from "$DEPLOYER" --private-key "$DEPLOYER_KEY" --rpc-url "$ANVIL_RPC" > /dev/null 2>&1
            WETH_OUT=$(python3 -c "print(f'{$QUOTE / 1e18:.6f}')")
            echo "  Swap: 100 USDC → $WETH_OUT WETH"
        else
            echo "  Swap: quote failed, skipping"
        fi

    elif [ "$DIRECTION" = "sell_weth" ]; then
        # Sell WETH → Buy USDC
        QUOTE=$(cast call "$PERIPHERY" \
            "quoteExactInput(address,address,address,uint256)(uint256)" \
            "$POOL" "$WETH" "$USDC" "$WETH_SWAP_AMOUNT" \
            --rpc-url "$ANVIL_RPC" 2>/dev/null | strip_cast || echo "0")

        if [ "$QUOTE" != "0" ]; then
            cast send "$PERIPHERY" \
                "swapExactIn(address,address,address,uint256,address,uint256,uint256)" \
                "$POOL" "$WETH" "$USDC" "$WETH_SWAP_AMOUNT" "$DEPLOYER" 0 0 \
                --from "$DEPLOYER" --private-key "$DEPLOYER_KEY" --rpc-url "$ANVIL_RPC" > /dev/null 2>&1
            USDC_OUT=$(python3 -c "print(f'{$QUOTE / 1e6:.2f}')")
            echo "  Swap: 0.04 WETH → $USDC_OUT USDC"
        else
            echo "  Swap: quote failed, skipping"
        fi
    else
        echo "  No mismatch, skipping swap"
    fi

    # --- Print status ---
    RESERVES_AFTER=$(cast call "$POOL" "getReserves()(uint112,uint112,uint32)" --rpc-url "$ANVIL_RPC")
    R0_AFTER=$(echo "$RESERVES_AFTER" | head -1 | strip_cast)
    R1_AFTER=$(echo "$RESERVES_AFTER" | sed -n '2p' | strip_cast)
    R0_FMT=$(python3 -c "print(f'{$R0_AFTER / 1e6:.2f}')")
    R1_FMT=$(python3 -c "print(f'{$R1_AFTER / 1e18:.4f}')")
    echo "  Reserves: $R0_FMT USDC / $R1_FMT WETH"
    echo ""

    # Wait before next step
    sleep 10
done
