// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {UniswapXFiller} from "../src/UniswapXFiller.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";

/// @title DeployUniswapXFiller — Deploy executor contract for filling UniswapX orders via EulerSwap
/// @notice Deploys UniswapXFiller, approves USDC and WETH to the reactor, and verifies state.
///
/// @dev Usage:
///   PRIVATE_KEY=0x... forge script script/DeployUniswapXFiller.s.sol:DeployUniswapXFiller \
///     --rpc-url $RPC_URL --broadcast --slow -vvvv
///
///   The deployer becomes the contract owner (immutable). Only the owner can call
///   execute(), executeBatch(), approveToken(), and withdraw().
contract DeployUniswapXFiller is Script {
    // Mainnet addresses
    address constant REACTOR_V2 = 0x00000011F84B9aa48e5f8aA8B9897600006289Be;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant POOL = 0x4311031739918Aba578C3C667DA3028A12Ce28A8;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        console.log("=== DeployUniswapXFiller ===");
        console.log("Deployer:", deployer);
        console.log("Reactor:", REACTOR_V2);
        console.log("Pool:", POOL);
        console.log("");

        vm.startBroadcast(pk);

        // 1. Deploy executor contract
        UniswapXFiller filler = new UniswapXFiller(REACTOR_V2);
        console.log("UniswapXFiller deployed:", address(filler));

        // 2. Approve USDC and WETH to reactor (one-time per token)
        filler.approveToken(USDC);
        filler.approveToken(WETH);
        console.log("Approved USDC and WETH to reactor");

        vm.stopBroadcast();

        // 3. Verify state
        console.log("");
        console.log("=== Verification ===");
        console.log("Owner:", filler.owner());
        console.log("Reactor:", filler.reactor());

        uint256 usdcAllowance = IERC20(USDC).allowance(address(filler), REACTOR_V2);
        uint256 wethAllowance = IERC20(WETH).allowance(address(filler), REACTOR_V2);
        console.log("USDC allowance to reactor:", usdcAllowance);
        console.log("WETH allowance to reactor:", wethAllowance);

        require(filler.owner() == deployer, "owner mismatch");
        require(filler.reactor() == REACTOR_V2, "reactor mismatch");
        require(usdcAllowance == type(uint256).max, "USDC approval failed");
        require(wethAllowance == type(uint256).max, "WETH approval failed");

        console.log("");
        console.log("=== Copy to .env.local ===");
        console.log(string.concat("EXECUTOR_ADDRESS=", vm.toString(address(filler))));
    }
}
