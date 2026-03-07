// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {LPAgentHookV2} from "../src/LPAgentHookV2.sol";
import "../eulerswap/src/interfaces/IEulerSwapHookTarget.sol";

/// @title UpgradeHookV2 — Deploy LPAgentHookV2 with debt auction on USDC/WETH pool
/// @notice Deploys V2 hook (getFee + afterSwap), configures auction params to trigger
///         on existing WETH vault debt (0.7117 WETH), and reconfigures pool to use it.
///         Auction attracts WETH inflow → FundsLib repays borrow debt first.
///
/// @dev Usage:
///   PRIVATE_KEY=0x... forge script script/UpgradeHookV2.s.sol:UpgradeHookV2 \
///     --rpc-url $RPC_URL --broadcast --slow -vvvv
contract UpgradeHookV2 is Script {
    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);

    address constant POOL = 0x4311031739918Aba578C3C667DA3028A12Ce28A8;
    address constant EULER_ACCOUNT = 0x2909bCc87c17d8Be263621bF087bC806BA313BFE;
    address constant UNI_USDC_WETH = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        EulerSwap pool = EulerSwap(POOL);

        // Log current state
        (uint112 r0, uint112 r1,) = pool.getReserves();
        IEulerSwap.DynamicParams memory d = pool.getDynamicParams();
        console.log("Deployer:", deployer);
        console.log("Current reserves:", uint256(r0), uint256(r1));
        console.log("Current eq:", uint256(d.equilibriumReserve0), uint256(d.equilibriumReserve1));
        console.log("Current priceY:", uint256(d.priceY));
        console.log("Current hook:", d.swapHook);
        console.log("Current hookedOps:", uint256(d.swapHookedOperations));

        vm.startBroadcast(pk);

        // 1. Deploy LPAgentHookV2
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
        console.log("LPAgentHookV2 deployed:", address(hook));

        // 2. Set auction params — target WETH debt repayment
        // threshold1 = 321.5 WETH (above current ~320.52 → triggers immediately)
        // At 100bps delta: ~1.6 WETH inflow → fully repays 0.7117 WETH debt
        // USDC outflow ~3.2k from 4.39k supply vault (no new USDC borrowing)
        // Fee: 200bps start, 1bps/sec decay → 12bps/block → ~13 blocks to arber clearing
        hook.setAuctionParams(
            0,                                     // threshold0: disabled
            321_500_000_000_000_000_000,            // threshold1: 321.5 WETH
            uint64(100e14),                         // delta: 100 bps off-market shift
            uint64(200e14),                         // startFee: 200 bps
            uint64(1e14)                            // decayPerSecond: 1 bps/sec (12 bps/block)
        );
        console.log("Auction params set: threshold1=321.5 WETH, delta=100bps, startFee=200bps");

        // 3. Install hook on pool (GET_FEE + AFTER_SWAP)
        d.swapHook = address(hook);
        d.swapHookedOperations = EULER_SWAP_HOOK_GET_FEE | EULER_SWAP_HOOK_AFTER_SWAP; // 6

        // Re-read reserves (may have changed between reads)
        (r0, r1,) = pool.getReserves();

        evc.call(
            POOL,
            EULER_ACCOUNT,
            0,
            abi.encodeCall(
                IEulerSwap.reconfigure,
                (d, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}))
            )
        );
        console.log("Hook installed, swapHookedOperations = GET_FEE | AFTER_SWAP (6)");

        vm.stopBroadcast();

        // Verify
        IEulerSwap.DynamicParams memory finalD = pool.getDynamicParams();
        (uint112 finalR0, uint112 finalR1,) = pool.getReserves();
        (bool active,,, uint112 t0, uint112 t1) = hook.getAuctionState();

        console.log("");
        console.log("=== Final state ===");
        console.log("Hook address:", finalD.swapHook);
        console.log("HookedOps:", uint256(finalD.swapHookedOperations));
        console.log("Reserves:", uint256(finalR0), uint256(finalR1));
        console.log("Auction active:", active);
        console.log("Threshold0:", uint256(t0));
        console.log("Threshold1:", uint256(t1));
        console.log("");
        console.log("Next swap will trigger the auction (reserve1 < threshold1).");
        console.log("Auction attracts WETH -- repays 0.7117 WETH vault debt.");
    }
}
