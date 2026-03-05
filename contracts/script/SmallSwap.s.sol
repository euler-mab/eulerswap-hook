// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {EulerSwapPeriphery} from "../eulerswap/src/EulerSwapPeriphery.sol";

interface IERC20Min {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

contract SmallSwap is Script {
    address constant POOL = 0x4311031739918Aba578C3C667DA3028A12Ce28A8;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        console.log("Deployer:", deployer);
        console.log("USDC balance:", IERC20Min(USDC).balanceOf(deployer));
        console.log("WETH balance:", IERC20Min(WETH).balanceOf(deployer));

        vm.startBroadcast(pk);

        // Deploy a stateless periphery router
        EulerSwapPeriphery periphery = new EulerSwapPeriphery();
        console.log("Periphery:", address(periphery));

        // Approve periphery for USDC
        IERC20Min(USDC).approve(address(periphery), type(uint256).max);

        // Swap 5 USDC → WETH (amountOutMin=0 for simplicity)
        periphery.swapExactIn(POOL, USDC, WETH, 5e6, deployer, 0, 0);

        vm.stopBroadcast();

        console.log("USDC after:", IERC20Min(USDC).balanceOf(deployer));
        console.log("WETH after:", IERC20Min(WETH).balanceOf(deployer));
    }
}
