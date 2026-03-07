// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {LPAgentHookV2} from "../src/LPAgentHookV2.sol";
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

/// @title RedeployHookV2 — Deploy fixed LPAgentHookV2 and restore pool params
/// @notice Deploys V2 hook with fixed _restorePreAuctionParams (eq=reserves pattern).
///         Also fixes the stale pool state left by the failed restore:
///         - priceY: 1995 → market (~1982)
///         - minReserves: 0 → proper range floor
///         - eq: stale → current reserves
///
/// @dev Usage:
///   PRIVATE_KEY=0x... forge script script/RedeployHookV2.s.sol:RedeployHookV2 \
///     --rpc-url $RPC_URL --broadcast --slow -vvvv
contract RedeployHookV2 is Script {
    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);

    address constant POOL = 0x4311031739918Aba578C3C667DA3028A12Ce28A8;
    address constant EULER_ACCOUNT = 0x2909bCc87c17d8Be263621bF087bC806BA313BFE;
    address constant UNI_USDC_WETH = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640;

    uint256 constant Q192 = 1 << 192;
    uint256 constant WAD = 1e18;

    /// @dev Min reserve ratio: ~2.4% below eq (matches pre-auction range rx≈ry≈0.025)
    uint256 constant MIN_RESERVE_BPS = 9759;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        EulerSwap pool = EulerSwap(POOL);

        // Read current state
        (uint112 r0, uint112 r1,) = pool.getReserves();
        IEulerSwap.DynamicParams memory d = pool.getDynamicParams();

        // Compute market priceY from Uniswap
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(UNI_USDC_WETH).slot0();
        uint256 sqrtP = uint256(sqrtPriceX96);
        uint256 priceWad = FullMath.mulDiv(sqrtP * sqrtP, WAD, Q192);
        uint80 marketPriceY = uint80(uint256(d.priceX) * WAD / priceWad);

        // Log current vs corrected state
        console.log("Deployer:", deployer);
        console.log("Reserves:", uint256(r0), uint256(r1));
        console.log("");
        console.log("=== Fixing stale params ===");
        console.log("priceY:  ", uint256(d.priceY), "->", uint256(marketPriceY));
        console.log("eq0:     ", uint256(d.equilibriumReserve0), "->", uint256(r0));
        console.log("eq1:     ", uint256(d.equilibriumReserve1), "->", uint256(r1));
        console.log("min0:    ", uint256(d.minReserve0), "->", uint256(r0) * MIN_RESERVE_BPS / 10000);
        console.log("min1:    ", uint256(d.minReserve1), "->", uint256(r1) * MIN_RESERVE_BPS / 10000);

        vm.startBroadcast(pk);

        // 1. Deploy fixed LPAgentHookV2
        LPAgentHookV2 hook = new LPAgentHookV2(
            POOL,
            deployer,
            UNI_USDC_WETH,
            5e14,            // baseFee: 5 bps
            3500e14,         // maxFee: 3500 bps
            uint64(6.54e10), // gasCoeff (from BoostReconfigure)
            5e14,            // externalFee: 5 bps (Uni V3 0.05%)
            0.8e18,          // captureRate: 80%
            0.3e18           // attractRate: 30%
        );
        console.log("Fixed hook deployed:", address(hook));

        // 2. Set auction params — disabled for now (no active debt)
        //    Owner can enable later via setAuctionParams when thresholds are decided.
        hook.setAuctionParams(
            0,                  // threshold0: disabled
            0,                  // threshold1: disabled
            uint64(100e14),     // delta: 100 bps
            uint64(200e14),     // startFee: 200 bps
            uint64(1e14)        // decayPerSecond: 1 bps/sec
        );
        console.log("Auction params set (thresholds disabled)");

        // 3. Reconfigure pool: new hook + fix stale params
        // Re-read reserves (may have changed during broadcast setup)
        (r0, r1,) = pool.getReserves();

        d.swapHook = address(hook);
        d.swapHookedOperations = EULER_SWAP_HOOK_GET_FEE | EULER_SWAP_HOOK_AFTER_SWAP; // 6
        d.priceY = marketPriceY;
        d.equilibriumReserve0 = r0;
        d.equilibriumReserve1 = r1;
        d.minReserve0 = uint112(uint256(r0) * MIN_RESERVE_BPS / 10000);
        d.minReserve1 = uint112(uint256(r1) * MIN_RESERVE_BPS / 10000);

        evc.call(
            POOL,
            EULER_ACCOUNT,
            0,
            abi.encodeCall(
                IEulerSwap.reconfigure,
                (d, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}))
            )
        );
        console.log("Pool reconfigured with fixed params");

        vm.stopBroadcast();

        // Verify
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
        console.log("Reserves:", uint256(finalR0), uint256(finalR1));
    }
}
