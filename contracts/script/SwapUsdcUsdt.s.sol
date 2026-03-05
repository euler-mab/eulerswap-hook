// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {EulerSwapPeriphery} from "../eulerswap/src/EulerSwapPeriphery.sol";

interface IERC20Min {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @title SwapUsdcUsdt — Small test swap on the USDC/USDT pool
contract SwapUsdcUsdt is Script {
    address constant POOL = 0x719529e99b7b272c5ef4CE07C30d15BC57CD68A8;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        console.log("USDC before:", IERC20Min(USDC).balanceOf(deployer));
        console.log("USDT before:", IERC20Min(USDT).balanceOf(deployer));

        vm.startBroadcast(pk);

        // Deploy periphery, approve, swap
        EulerSwapPeriphery periphery = new EulerSwapPeriphery();
        IERC20Min(USDC).approve(address(periphery), type(uint256).max);
        periphery.swapExactIn(POOL, USDC, USDT, 5e6, deployer, 0, 0);

        vm.stopBroadcast();

        console.log("USDC after:", IERC20Min(USDC).balanceOf(deployer));
        console.log("USDT after:", IERC20Min(USDT).balanceOf(deployer));
    }
}
