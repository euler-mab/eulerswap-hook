// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {LPAgentHookV4} from "../src/LPAgentHookV4.sol";
import "../eulerswap/src/interfaces/IEulerSwapHookTarget.sol";
import {FullMath} from "../eulerswap/src/math/FullMath.sol";

interface IUniswapV3Pool {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
}

/// @title DeployHookV4 — Deploy LPAgentHookV4 and install on existing EulerSwap pool
/// @notice Deploys the V4 autonomous hook (oracle-reactive fees + equity clearing auction),
///         recenters the pool at market price, and installs the hook via EVC reconfigure.
///
/// @dev Usage:
///   PRIVATE_KEY=0x... forge script script/DeployHookV4.s.sol:DeployHookV4 \
///     --rpc-url $RPC_URL --broadcast --slow -vvvv
///
///   The deployer must be the pool's eulerAccount (or authorized operator).
///   The script reads the current pool state, computes market price from Uniswap V3,
///   and recenters eq=reserves + priceY=market before installing the hook.
contract DeployHookV4 is Script {
    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);

    // --- Pool and oracle addresses (mainnet USDC/WETH) ---
    address constant POOL = 0x4311031739918Aba578C3C667DA3028A12Ce28A8;
    address constant EULER_ACCOUNT = 0x2909bCc87c17d8Be263621bF087bC806BA313BFE;
    address constant UNI_USDC_WETH = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640; // 0.05% fee tier

    uint256 constant Q192 = 1 << 192;
    uint256 constant WAD = 1e18;

    // --- Fee parameters ---
    uint64 constant BASE_FEE = 5e14;         // 5 bps
    uint64 constant MAX_FEE = 3500e14;       // 3500 bps (35%)
    uint64 constant GAS_COEFF = uint64(6.54e10); // ~25 bps at 0.4 gwei for current pool depth
    uint64 constant EXTERNAL_FEE = 5e14;     // 5 bps (Uni V3 0.05% pool)
    uint256 constant CAPTURE_RATE = 0.8e18;  // 80% of net edge on arb side
    uint256 constant ATTRACT_RATE = 0.3e18;  // 30% of routing headroom on attract side

    // --- Auction parameters ---
    // Calibration: shiftMagnitude ≈ targetBlocks × decayPerBlock
    // 25 blocks × 4.3 bps/block ≈ 108 bps
    uint64 constant DECAY_PER_BLOCK = uint64(4.3e14);  // ~4.3 bps/block
    uint64 constant TRIGGER_THRESHOLD = 0.15e18;       // 15% of range
    uint64 constant CLEAR_THRESHOLD = 0.005e18;        // 0.5% price convergence
    uint64 constant SHIFT_MAGNITUDE = 0.0108e18;       // 108 bps
    uint64 constant MAX_RECENTER_DRIFT = 0.03e18;      // 3% max price drift per recenter
    uint64 constant MIN_AUCTION_BLOCKS = 12;            // ~12 blocks before clearing permitted
    uint64 constant RECENTER_RANGE = 0.05e18;           // 5% price range → min ≈ 97.6% of eq at c=0

    // --- Surcharge parameters ---
    uint64 constant SURCHARGE_DECAY = 10e14;            // 10 bps/block
    uint64 constant SURCHARGE_INITIAL = 50e14;          // 50 bps initial surcharge

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        EulerSwap pool = EulerSwap(POOL);

        // Read current state
        IEulerSwap.DynamicParams memory d = pool.getDynamicParams();
        (uint112 r0, uint112 r1,) = pool.getReserves();

        // Compute market priceY from Uniswap V3 slot0
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(UNI_USDC_WETH).slot0();
        uint256 sqrtP = uint256(sqrtPriceX96);
        uint256 priceWad = FullMath.mulDiv(sqrtP * sqrtP, WAD, Q192);
        uint80 marketPriceY = uint80(uint256(d.priceX) * WAD / priceWad);

        // Pre-flight logging
        console.log("=== DeployHookV4 ===");
        console.log("Deployer:", deployer);
        console.log("Pool:", POOL);
        console.log("");
        console.log("--- Current state ---");
        console.log("Reserves:", uint256(r0), uint256(r1));
        console.log("priceY:", uint256(d.priceY), "-> market:", uint256(marketPriceY));
        console.log("Hook:", d.swapHook);
        console.log("HookedOps:", uint256(d.swapHookedOperations));

        vm.startBroadcast(pk);

        // 1. Deploy V4 hook
        LPAgentHookV4 hook = new LPAgentHookV4(
            POOL,
            deployer,
            UNI_USDC_WETH,
            LPAgentHookV4.FeeConfig({
                baseFee: BASE_FEE,
                maxFee: MAX_FEE,
                gasCoeff: GAS_COEFF,
                externalFee: EXTERNAL_FEE,
                captureRate: CAPTURE_RATE,
                attractRate: ATTRACT_RATE
            }),
            LPAgentHookV4.AuctionConfig({
                decayPerBlock: DECAY_PER_BLOCK,
                triggerThreshold: TRIGGER_THRESHOLD,
                clearThreshold: CLEAR_THRESHOLD,
                shiftMagnitude: SHIFT_MAGNITUDE,
                surchargeDecayPerBlock: SURCHARGE_DECAY,
                surchargeInitialAmount: SURCHARGE_INITIAL,
                maxRecenterDrift: MAX_RECENTER_DRIFT,
                minAuctionBlocks: MIN_AUCTION_BLOCKS,
                recenterRange: RECENTER_RANGE
            })
        );
        console.log("V4 hook deployed:", address(hook));

        // 2. Reconfigure pool: install hook + recenter at market price
        // Re-read reserves (may change between simulation and broadcast)
        (r0, r1,) = pool.getReserves();

        d.swapHook = address(hook);
        d.swapHookedOperations = EULER_SWAP_HOOK_GET_FEE | EULER_SWAP_HOOK_AFTER_SWAP;
        d.priceY = marketPriceY;
        d.equilibriumReserve0 = r0;
        d.equilibriumReserve1 = r1;

        // Compute min reserves from recenterRange using curve math:
        // minReserve = eq * sqrt(WAD) / sqrt(WAD + r * WAD / (WAD - c))
        // This ensures h=1 at the boundary for the pool's leverage/LTV.
        d.minReserve0 = _computeMinReserve(r0, d.concentrationX);
        d.minReserve1 = _computeMinReserve(r1, d.concentrationY);

        evc.call(
            POOL,
            EULER_ACCOUNT,
            0,
            abi.encodeCall(
                IEulerSwap.reconfigure,
                (d, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}))
            )
        );
        console.log("Pool reconfigured with V4 hook");

        vm.stopBroadcast();

        // 3. Verify final state
        IEulerSwap.DynamicParams memory finalD = pool.getDynamicParams();
        (uint112 finalR0, uint112 finalR1,) = pool.getReserves();

        console.log("");
        console.log("=== Final state ===");
        console.log("Hook:", finalD.swapHook);
        console.log("HookedOps:", uint256(finalD.swapHookedOperations));
        console.log("priceY:", uint256(finalD.priceY));
        console.log("eq0:", uint256(finalD.equilibriumReserve0));
        console.log("eq1:", uint256(finalD.equilibriumReserve1));
        console.log("min0:", uint256(finalD.minReserve0));
        console.log("min1:", uint256(finalD.minReserve1));
        console.log("cx:", uint256(finalD.concentrationX));
        console.log("cy:", uint256(finalD.concentrationY));
        console.log("Reserves:", uint256(finalR0), uint256(finalR1));

        // Log for agent .env
        console.log("");
        console.log("=== Copy to .env ===");
        console.log(string.concat("HOOK_V4_ADDRESS=", vm.toString(address(hook))));
    }

    function _computeMinReserve(uint112 eqReserve, uint64 concentration) internal pure returns (uint112) {
        uint256 r = uint256(RECENTER_RANGE);
        if (r == 0) return 0;

        uint256 c = uint256(concentration);
        if (c >= WAD) return 0; // constant-sum: no boundary

        // inner = WAD + r * WAD / (WAD - c)
        uint256 inner = WAD + r * WAD / (WAD - c);

        // minReserve = eq * sqrt(WAD) / sqrt(inner)
        uint256 sqrtWAD = _sqrt(WAD);
        uint256 sqrtInner = _sqrt(inner);

        return uint112(uint256(eqReserve) * sqrtWAD / sqrtInner);
    }

    /// @dev Integer square root (Babylonian method)
    function _sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y;
    }
}
