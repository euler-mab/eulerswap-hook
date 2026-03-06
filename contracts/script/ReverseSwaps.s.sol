// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {EulerSwapPeriphery} from "../eulerswap/src/EulerSwapPeriphery.sol";

interface IERC20Min {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @title ReverseSwaps — Opposite direction swaps on both pools
contract ReverseSwaps is Script {
    address constant USDC_WETH_POOL = 0x4311031739918Aba578C3C667DA3028A12Ce28A8;
    address constant USDC_USDT_POOL = 0x719529e99b7b272c5ef4CE07C30d15BC57CD68A8;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        console.log("=== Before ===");
        console.log("USDC:", IERC20Min(USDC).balanceOf(deployer));
        console.log("WETH:", IERC20Min(WETH).balanceOf(deployer));
        console.log("USDT:", IERC20Min(USDT).balanceOf(deployer));

        vm.startBroadcast(pk);

        EulerSwapPeriphery periphery = new EulerSwapPeriphery();

        // Swap 1: 0.002 WETH → USDC (opposite of previous USDC → WETH)
        IERC20Min(WETH).approve(address(periphery), type(uint256).max);
        periphery.swapExactIn(USDC_WETH_POOL, WETH, USDC, 0.002 ether, deployer, 0, 0);
        console.log("Swapped 0.002 WETH -> USDC");

        // Swap 2: 4.5 USDT → USDC (opposite of previous USDC → USDT)
        IERC20Min(USDT).approve(address(periphery), type(uint256).max);
        periphery.swapExactIn(USDC_USDT_POOL, USDT, USDC, 4_500_000, deployer, 0, 0);
        console.log("Swapped 4.5 USDT -> USDC");

        vm.stopBroadcast();

        console.log("=== After ===");
        console.log("USDC:", IERC20Min(USDC).balanceOf(deployer));
        console.log("WETH:", IERC20Min(WETH).balanceOf(deployer));
        console.log("USDT:", IERC20Min(USDT).balanceOf(deployer));
    }
}
