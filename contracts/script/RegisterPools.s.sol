// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IEulerSwapRegistry} from "../eulerswap/src/interfaces/IEulerSwapRegistry.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";

contract RegisterPools is Script {
    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);
    IEulerSwapRegistry constant registry = IEulerSwapRegistry(0x5FcCB84363F020c0cADE052C9c654aABF932814A);

    // Pools
    address constant USDC_WETH_POOL = 0x4311031739918Aba578C3C667DA3028A12Ce28A8;
    address constant USDC_USDT_POOL = 0x719529e99b7b272c5ef4CE07C30d15BC57CD68A8;

    // Euler accounts (different EVC sub-accounts for the same owner)
    address constant EULER_ACCOUNT_0 = 0x2909bCc87c17d8Be263621bF087bC806BA313BFE; // sub-account 0
    address constant EULER_ACCOUNT_FF = 0x2909BCc87c17D8be263621bf087Bc806ba313BFf; // sub-account 255

    uint256 constant BOND = 0.001 ether;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        // Register USDC/WETH pool
        evc.call{value: BOND}(
            address(registry),
            EULER_ACCOUNT_0,
            BOND,
            abi.encodeCall(registry.registerPool, (USDC_WETH_POOL))
        );
        console.log("Registered USDC/WETH pool:", USDC_WETH_POOL);
        console.log("  Bond:", BOND);

        // Register USDC/USDT pool
        evc.call{value: BOND}(
            address(registry),
            EULER_ACCOUNT_FF,
            BOND,
            abi.encodeCall(registry.registerPool, (USDC_USDT_POOL))
        );
        console.log("Registered USDC/USDT pool:", USDC_USDT_POOL);
        console.log("  Bond:", BOND);

        vm.stopBroadcast();
    }
}
