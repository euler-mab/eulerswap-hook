// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {MinimalHook} from "../src/MinimalHook.sol";
import {EULER_SWAP_HOOK_GET_FEE} from "../eulerswap/src/interfaces/IEulerSwapHookTarget.sol";

/// @title DeployMinimalHook — Bind a constant-fee MinimalHook to an existing EulerSwap pool
/// @notice Use this as a starting point for your own hook deployments. Once you've
///         forked MinimalHook into something more interesting, copy this script and
///         adjust the constructor args + hook flags.
///
/// Usage:
///   PRIVATE_KEY=0x...          \
///   POOL=0x...                 \
///   EULER_ACCOUNT=0x...        \
///   FEE_WAD=500000000000000    \
///     forge script script/DeployMinimalHook.s.sol:DeployMinimalHook \
///     --rpc-url $RPC_URL --broadcast -vvvv
///
/// FEE_WAD is WAD-scaled (1e18 = 100%). Examples:
///   - 5e14   = 0.05%  = 5 bps
///   - 5e15   = 0.5%   = 50 bps
///   - 1e16   = 1%     = 100 bps
contract DeployMinimalHook is Script {
    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address pool = vm.envAddress("POOL");
        address eulerAccount = vm.envAddress("EULER_ACCOUNT");
        uint256 feeWad = vm.envUint("FEE_WAD");
        require(feeWad <= type(uint64).max, "FEE_WAD overflows uint64");

        console.log("=== DeployMinimalHook ===");
        console.log("Pool:         ", pool);
        console.log("EulerAccount: ", eulerAccount);
        console.log("Fee (WAD):    ", feeWad);

        vm.startBroadcast(pk);

        MinimalHook hook = new MinimalHook(uint64(feeWad));
        console.log("Hook deployed:", address(hook));

        IEulerSwap.DynamicParams memory d = EulerSwap(pool).getDynamicParams();
        d.swapHook = address(hook);
        d.swapHookedOperations = EULER_SWAP_HOOK_GET_FEE;

        (uint112 r0, uint112 r1,) = EulerSwap(pool).getReserves();
        evc.call(
            pool,
            eulerAccount,
            0,
            abi.encodeCall(
                IEulerSwap.reconfigure,
                (d, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}))
            )
        );
        console.log("Pool reconfigured with MinimalHook bound to GET_FEE.");

        vm.stopBroadcast();
    }
}
