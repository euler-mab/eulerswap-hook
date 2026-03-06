// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {LPAgentHook} from "../src/LPAgentHook.sol";
import "../eulerswap/src/interfaces/IEulerSwapHookTarget.sol";

/// @title UpgradeHooks — Deploy new LPAgentHook contracts and reconfigure both pools
/// @notice Deploys new hook bytecode (Uniswap V3 mismatch-based fees, no pause, no afterSwap)
///         and reconfigures each pool to use the new hook with swapHookedOperations = GET_FEE only.
///
/// @dev Usage:
///   PRIVATE_KEY=0x... forge script script/UpgradeHooks.s.sol:UpgradeHooks \
///     --rpc-url $RPC_URL --broadcast --slow -vvvv
contract UpgradeHooks is Script {
    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);

    // --- Pool addresses ---
    address constant USDC_WETH_POOL = 0x4311031739918Aba578C3C667DA3028A12Ce28A8;
    address constant USDC_USDT_POOL = 0x719529e99b7b272c5ef4CE07C30d15BC57CD68A8;

    // --- Euler accounts ---
    address constant USDC_WETH_ACCOUNT = 0x2909bCc87c17d8Be263621bF087bC806BA313BFE;
    address constant USDC_USDT_ACCOUNT = 0x2909BCc87c17D8be263621bf087Bc806ba313BFf;

    // --- Uniswap V3 reference pools ---
    address constant UNI_USDC_WETH = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640; // 0.05%
    address constant UNI_USDC_USDT = 0x3416cF6C708Da44DB2624D63ea0AAef7113527C6; // 0.01%

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        console.log("Deployer:", deployer);

        vm.startBroadcast(pk);

        // --- USDC/WETH ---
        LPAgentHook hook1 = new LPAgentHook(
            USDC_WETH_POOL,
            deployer,
            UNI_USDC_WETH,
            5e14,    // baseFee: 5 bps
            3500e14, // maxFee: 3500 bps
            30e14,   // gasThreshold: 30 bps (no-arb zone)
            0.8e18   // captureRate: 80% of excess mismatch
        );
        console.log("USDC/WETH hook:", address(hook1));
        _installHook(USDC_WETH_POOL, USDC_WETH_ACCOUNT, address(hook1));

        // --- USDC/USDT ---
        LPAgentHook hook2 = new LPAgentHook(
            USDC_USDT_POOL,
            deployer,
            UNI_USDC_USDT,
            5e13,    // baseFee: 0.5 bps
            50e14,   // maxFee: 50 bps
            5e14,    // gasThreshold: 5 bps (stables have tight no-arb zone)
            0.8e18   // captureRate: 80% of excess mismatch
        );
        console.log("USDC/USDT hook:", address(hook2));
        _installHook(USDC_USDT_POOL, USDC_USDT_ACCOUNT, address(hook2));

        vm.stopBroadcast();

        console.log("");
        console.log("=== Done ===");
        console.log("USDC/WETH hook:", address(hook1));
        console.log("USDC/USDT hook:", address(hook2));
    }

    function _installHook(address poolAddr, address eulerAccount, address hookAddr) internal {
        EulerSwap pool = EulerSwap(poolAddr);

        IEulerSwap.DynamicParams memory dParams = pool.getDynamicParams();
        dParams.swapHook = hookAddr;
        dParams.swapHookedOperations = EULER_SWAP_HOOK_GET_FEE;

        (uint112 r0, uint112 r1,) = pool.getReserves();

        evc.call(
            poolAddr,
            eulerAccount,
            0,
            abi.encodeCall(IEulerSwap.reconfigure, (dParams, IEulerSwap.InitialState({reserve0: r0, reserve1: r1})))
        );
        console.log("  Hook installed, swapHookedOperations = GET_FEE only");
    }
}
