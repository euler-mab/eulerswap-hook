// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";

/// @title EnableCollateral — EVC sub-account setup helper
/// @notice Enables a list of collateral vaults (and optionally a controller vault)
///         on an EVC sub-account in a single batch. Run this before deploying a
///         pool whose eulerAccount is a fresh sub-account.
///
/// @dev Usage:
///   PRIVATE_KEY=0x...                                    \
///   EULER_ACCOUNT=0x...                                  \
///   COLLATERAL_VAULTS=0xVault1,0xVault2,0xVault3         \  # comma-separated
///   CONTROLLER_VAULT=0x...                               \  # optional; address(0) -> skip
///     forge script script/EnableCollateral.s.sol:EnableCollateral \
///     --rpc-url $RPC_URL --broadcast --slow -vvvv
///
///   PRIVATE_KEY must control the owner of the EVC sub-account (the address
///   that shares the upper 19 bytes with EULER_ACCOUNT). All operations are
///   batched into a single evc.batch() call.
contract EnableCollateral is Script {
    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        address eulerAccount = vm.envAddress("EULER_ACCOUNT");
        address controller = vm.envOr("CONTROLLER_VAULT", address(0));
        address[] memory collaterals = _parseCollaterals(vm.envString("COLLATERAL_VAULTS"));
        require(collaterals.length > 0, "COLLATERAL_VAULTS empty");

        console.log("=== EnableCollateral ===");
        console.log("Deployer:    ", deployer);
        console.log("EulerAccount:", eulerAccount);
        console.log("Controller:  ", controller);
        for (uint256 i = 0; i < collaterals.length; ++i) {
            console.log("Collateral:  ", collaterals[i]);
        }

        uint256 nItems = collaterals.length + (controller != address(0) ? 1 : 0);
        IEVC.BatchItem[] memory items = new IEVC.BatchItem[](nItems);

        for (uint256 i = 0; i < collaterals.length; ++i) {
            items[i] = IEVC.BatchItem({
                targetContract: address(evc),
                onBehalfOfAccount: address(0),
                value: 0,
                data: abi.encodeCall(IEVC.enableCollateral, (eulerAccount, collaterals[i]))
            });
        }

        if (controller != address(0)) {
            items[nItems - 1] = IEVC.BatchItem({
                targetContract: address(evc),
                onBehalfOfAccount: address(0),
                value: 0,
                data: abi.encodeCall(IEVC.enableController, (eulerAccount, controller))
            });
        }

        vm.startBroadcast(pk);
        evc.batch(items);
        vm.stopBroadcast();

        console.log("");
        console.log("Batch executed:", nItems, "items");
    }

    /// @dev Splits a comma-separated address list (no whitespace required) into
    ///      an address[]. Uses vm.parseAddress on each segment so malformed
    ///      entries revert with a clear forge error.
    function _parseCollaterals(string memory csv) internal pure returns (address[] memory) {
        bytes memory b = bytes(csv);
        if (b.length == 0) return new address[](0);

        // Count commas to size the output array.
        uint256 count = 1;
        for (uint256 i = 0; i < b.length; ++i) {
            if (b[i] == ",") ++count;
        }

        address[] memory out = new address[](count);
        uint256 idx;
        uint256 start;
        for (uint256 i = 0; i <= b.length; ++i) {
            if (i == b.length || b[i] == ",") {
                bytes memory seg = new bytes(i - start);
                for (uint256 j = 0; j < seg.length; ++j) {
                    seg[j] = b[start + j];
                }
                out[idx++] = vm.parseAddress(string(seg));
                start = i + 1;
            }
        }
        return out;
    }
}
