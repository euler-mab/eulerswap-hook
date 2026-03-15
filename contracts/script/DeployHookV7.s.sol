// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {LPAgentHookV7} from "../src/LPAgentHookV7.sol";
import "../eulerswap/src/interfaces/IEulerSwapHookTarget.sol";
import {FullMath} from "../eulerswap/src/math/FullMath.sol";
import {Sqrt} from "../eulerswap/src/math/Sqrt.sol";

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

    function token0() external view returns (address);
}

/// @title DeployHookV7 — Deploy LPAgentHookV7 and install on existing EulerSwap pool
/// @notice Deploys the V7 hook (NAV-based exposure tracking, curvature-aware surcharge,
///         exposure-sized auction shifts), recenters at market price, and installs via EVC.
///
/// @dev Usage:
///   PRIVATE_KEY=0x... forge script script/DeployHookV7.s.sol:DeployHookV7 \
///     --rpc-url $RPC_URL --broadcast --slow -vvvv
///
///   The deployer must be the pool's eulerAccount (or authorized operator).
contract DeployHookV7 is Script {
    using Sqrt for uint256;

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
    uint64 constant DECAY_PER_BLOCK = uint64(4.3e14);     // ~4.3 bps/block
    uint64 constant AUCTION_TRIGGER = 0.6e18;              // 60% relative exposure (NAV-based)
    uint64 constant CLEAR_THRESHOLD = 0.005e18;            // 0.5% price convergence
    uint64 constant MAX_SHIFT_MAGNITUDE = 0.015e18;        // 150 bps cap (exposure-sized)
    uint64 constant MIN_AUCTION_BLOCKS = 12;               // ~12 blocks before clearing

    // --- Recenter parameters ---
    uint64 constant RECENTER_RANGE = 0.05e18;              // 5% price range
    uint64 constant MAX_RECENTER_DRIFT = 0.03e18;          // 3% max price drift per recenter
    uint64 constant MIN_RECENTER_DELTA = 0;                // no minimum exposure decrease

    // --- Surcharge parameters ---
    uint64 constant SURCHARGE_DECAY = 10e14;               // 10 bps/block
    uint64 constant SURCHARGE_MULTIPLIER = uint64(1.25e18); // 1.25× safety margin
    uint64 constant DEPLOY_SURCHARGE = 500e14;              // 500 bps

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
        console.log("=== DeployHookV7 ===");
        console.log("Deployer:", deployer);
        console.log("Pool:", POOL);
        console.log("");
        console.log("--- Current state ---");
        console.log("Reserves:", uint256(r0), uint256(r1));
        console.log("priceY:", uint256(d.priceY), "-> market:", uint256(marketPriceY));
        console.log("Hook:", d.swapHook);
        console.log("HookedOps:", uint256(d.swapHookedOperations));

        vm.startBroadcast(pk);

        // 1. Deploy V7 hook
        LPAgentHookV7 hook = new LPAgentHookV7(
            POOL,
            deployer,
            LPAgentHookV7.OracleConfig({
                target: UNI_USDC_WETH,
                v4PoolId: bytes32(0),
                token0: IUniswapV3Pool(UNI_USDC_WETH).token0()
            }),
            LPAgentHookV7.FeeConfig({
                baseFee: BASE_FEE,
                maxFee: MAX_FEE,
                gasCoeff: GAS_COEFF,
                externalFee: EXTERNAL_FEE,
                captureRate: CAPTURE_RATE,
                attractRate: ATTRACT_RATE
            }),
            LPAgentHookV7.AuctionConfig({
                decayPerBlock: DECAY_PER_BLOCK,
                auctionTriggerThreshold: AUCTION_TRIGGER,
                clearThreshold: CLEAR_THRESHOLD,
                maxShiftMagnitude: MAX_SHIFT_MAGNITUDE,
                minAuctionBlocks: MIN_AUCTION_BLOCKS,
                recenterRange: RECENTER_RANGE,
                maxRecenterDrift: MAX_RECENTER_DRIFT,
                minRecenterDelta: MIN_RECENTER_DELTA,
                surchargeDecayPerBlock: SURCHARGE_DECAY,
                surchargeMultiplier: SURCHARGE_MULTIPLIER,
                deploySurcharge: DEPLOY_SURCHARGE
            })
        );
        console.log("V7 hook deployed:", address(hook));

        // 2. Reconfigure pool: install hook + recenter at market price
        (r0, r1,) = pool.getReserves();

        d.swapHook = address(hook);
        d.swapHookedOperations = EULER_SWAP_HOOK_GET_FEE | EULER_SWAP_HOOK_AFTER_SWAP;
        d.priceY = marketPriceY;
        d.equilibriumReserve0 = r0;
        d.equilibriumReserve1 = r1;

        // Compute min reserves from recenterRange using curve math:
        // minReserve = eq * sqrt(WAD) / sqrt(WAD + r * WAD / (WAD - c))
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
        console.log("Pool reconfigured with V7 hook");

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

        // V7-specific state
        (uint64 lastExp, int128 baseNet, uint128 cachedNav) = hook.getExposureState();
        console.log("");
        console.log("=== V7 exposure state ===");
        console.log("lastExposure:", uint256(lastExp));
        console.log("cachedNav:", uint256(cachedNav));

        console.log("");
        console.log("=== Copy to .env ===");
        console.log(string.concat("HOOK_V7_ADDRESS=", vm.toString(address(hook))));
    }

    function _computeMinReserve(uint112 eqReserve, uint64 concentration) internal pure returns (uint112) {
        uint256 r = uint256(RECENTER_RANGE);
        if (r == 0) return 0;

        uint256 c = uint256(concentration);
        if (c >= WAD) return 0;

        uint256 inner = WAD + r * WAD / (WAD - c);
        uint256 sqrtInner = inner.sqrt();

        return uint112(uint256(eqReserve) * 1e9 / sqrtInner); // 1e9 = sqrt(WAD)
    }
}
