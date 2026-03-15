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
    // Mainnet defaults — overridable via env vars for multichain deployment
    address constant DEFAULT_REACTOR = 0x00000011F84B9aa48e5f8aA8B9897600006289Be;
    address constant DEFAULT_USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant DEFAULT_WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        // Read reactor address from env (defaults to mainnet V2DutchOrderReactor)
        address reactorAddr = vm.envOr("REACTOR_ADDRESS", DEFAULT_REACTOR);

        // Read tokens to approve from env (comma-separated) or default to USDC+WETH
        address[] memory approveTokens = _getApproveTokens();

        console.log("=== DeployUniswapXFiller ===");
        console.log("Deployer:", deployer);
        console.log("Reactor:", reactorAddr);
        console.log("Tokens to approve:", approveTokens.length);
        console.log("");

        vm.startBroadcast(pk);

        // 1. Deploy executor contract
        UniswapXFiller filler = new UniswapXFiller(reactorAddr);
        console.log("UniswapXFiller deployed:", address(filler));

        // 2. Approve tokens to reactor (one-time per token)
        for (uint256 i = 0; i < approveTokens.length; i++) {
            filler.approveToken(approveTokens[i]);
            console.log("Approved token:", approveTokens[i]);
        }

        vm.stopBroadcast();

        // 3. Verify state
        console.log("");
        console.log("=== Verification ===");
        console.log("Owner:", filler.owner());
        console.log("Reactor:", filler.reactor());

        require(filler.owner() == deployer, "owner mismatch");
        require(filler.reactor() == reactorAddr, "reactor mismatch");

        for (uint256 i = 0; i < approveTokens.length; i++) {
            uint256 allowance = IERC20(approveTokens[i]).allowance(address(filler), reactorAddr);
            require(allowance == type(uint256).max, "approval failed");
            console.log("Allowance OK:", approveTokens[i]);
        }

        console.log("");
        console.log("=== Copy to .env.local ===");
        console.log(string.concat("EXECUTOR_ADDRESS=", vm.toString(address(filler))));
    }

    function _getApproveTokens() internal view returns (address[] memory) {
        // Try APPROVE_TOKENS env var first (comma-separated addresses)
        try vm.envString("APPROVE_TOKENS") returns (string memory tokensStr) {
            // Parse comma-separated addresses
            // Foundry doesn't have string split, so fall back to envAddress array
            // If the env var exists but isn't parseable, fall back to defaults
            if (bytes(tokensStr).length > 0) {
                // Use envAddress with the key directly — Foundry supports JSON arrays
                // e.g. APPROVE_TOKENS='["0x...", "0x..."]'
                try vm.envAddress("APPROVE_TOKENS", ",") returns (address[] memory tokens) {
                    return tokens;
                } catch {
                    // Single address
                    address[] memory single = new address[](1);
                    single[0] = vm.envAddress("APPROVE_TOKENS");
                    return single;
                }
            }
        } catch {}

        // Default: USDC + WETH (mainnet)
        address[] memory defaults = new address[](2);
        defaults[0] = DEFAULT_USDC;
        defaults[1] = DEFAULT_WETH;
        return defaults;
    }
}
