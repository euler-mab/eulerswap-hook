// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Arbitrageur} from "../src/Arbitrageur.sol";

contract DeployArbitrageur is Script {
    // Mainnet addresses
    address constant UNI_ROUTER_02 = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        Arbitrageur arb = new Arbitrageur(UNI_ROUTER_02, USDC, WETH);

        console.log("Arbitrageur deployed:", address(arb));
        console.log("Owner:", arb.owner());

        vm.stopBroadcast();
    }
}
