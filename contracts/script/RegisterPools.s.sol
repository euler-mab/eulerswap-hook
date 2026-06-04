// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IEulerSwapRegistry} from "../eulerswap/src/interfaces/IEulerSwapRegistry.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";

/// @title RegisterPools — Register one or more EulerSwap pools with the mainnet registry
/// @notice Posts a bond and calls registry.registerPool via the EVC for each (pool, account) pair.
///         The registry address is hardcoded to the mainnet deployment.
///
/// @dev Usage (env-driven):
///   PRIVATE_KEY=0x...                                   \
///   POOLS=0xPool1,0xPool2                               \
///   EULER_ACCOUNTS=0xAcct1,0xAcct2                      \
///   BOND_WEI=1000000000000000                           \
///     forge script script/RegisterPools.s.sol:RegisterPools \
///     --rpc-url $RPC_URL --broadcast -vvvv
///
/// POOLS and EULER_ACCOUNTS are comma-separated lists of equal length. Each pool is
/// registered using the corresponding euler account at the same index.
///
/// If POOLS / EULER_ACCOUNTS / BOND_WEI are unset, the author's mainnet defaults are
/// used (USDC/WETH and USDC/USDT pools, 0.001 ether bond).
///
/// @dev Footgun guard: if POOLS is unset, the script would otherwise silently fall back
/// to the author's live mainnet pools. To prevent an accidental broadcast that bonds
/// the caller's ETH against pools they do not own, this script reverts unless the
/// caller explicitly sets `ACK_AUTHOR_POOLS=yes`. Set `POOLS` to your own
/// comma-separated list for normal use.
contract RegisterPools is Script {
    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);
    IEulerSwapRegistry constant registry = IEulerSwapRegistry(0x5FcCB84363F020c0cADE052C9c654aABF932814A);

    // --- Author defaults (mainnet) ---
    address constant USDC_WETH_POOL = 0x4311031739918Aba578C3C667DA3028A12Ce28A8;
    address constant USDC_USDT_POOL = 0x719529e99b7b272c5ef4CE07C30d15BC57CD68A8;
    address constant EULER_ACCOUNT_0 = 0x2909bCc87c17d8Be263621bF087bC806BA313BFE; // sub-account 0
    address constant EULER_ACCOUNT_FF = 0x2909BCc87c17D8be263621bf087Bc806ba313BFf; // sub-account 255
    uint256 constant DEFAULT_BOND = 0.001 ether;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        // Footgun guard: refuse to fall back to the author's live mainnet pools
        // unless the caller has explicitly acknowledged it. Runs BEFORE any broadcast.
        string memory poolsRaw = vm.envOr("POOLS", string(""));
        if (bytes(poolsRaw).length == 0) {
            string memory ack = vm.envOr("ACK_AUTHOR_POOLS", string(""));
            require(
                _eq(ack, "yes"),
                "Refusing to register the author's default pools. If this is intentional, set ACK_AUTHOR_POOLS=yes. Otherwise set POOLS to your own comma-separated list."
            );
            console.log("WARNING: POOLS unset; using author defaults (ACK_AUTHOR_POOLS=yes).");
        }

        address[] memory pools = _readPools();
        address[] memory accounts = _readAccounts();
        require(pools.length == accounts.length, "POOLS / EULER_ACCOUNTS length mismatch");
        require(pools.length > 0, "no pools provided");

        uint256 bond = vm.envOr("BOND_WEI", DEFAULT_BOND);

        console.log("=== RegisterPools ===");
        console.log("Registry:", address(registry));
        console.log("Bond per pool (wei):", bond);
        console.log("Pool count:", pools.length);

        vm.startBroadcast(deployerKey);

        for (uint256 i = 0; i < pools.length; i++) {
            evc.call{value: bond}(
                address(registry),
                accounts[i],
                bond,
                abi.encodeCall(registry.registerPool, (pools[i]))
            );
            console.log("Registered pool:", pools[i]);
            console.log("  Euler account:", accounts[i]);
            console.log("  Bond:", bond);
        }

        vm.stopBroadcast();
    }

    // --- env parsing ---

    function _readPools() internal view returns (address[] memory) {
        string memory raw = vm.envOr("POOLS", string(""));
        if (bytes(raw).length == 0) {
            address[] memory defaults = new address[](2);
            defaults[0] = USDC_WETH_POOL;
            defaults[1] = USDC_USDT_POOL;
            return defaults;
        }
        return _parseAddressList(raw);
    }

    function _readAccounts() internal view returns (address[] memory) {
        string memory raw = vm.envOr("EULER_ACCOUNTS", string(""));
        if (bytes(raw).length == 0) {
            address[] memory defaults = new address[](2);
            defaults[0] = EULER_ACCOUNT_0;
            defaults[1] = EULER_ACCOUNT_FF;
            return defaults;
        }
        return _parseAddressList(raw);
    }

    /// @dev Splits a comma-separated string of hex addresses into an address[].
    ///      Whitespace inside the string is not supported; supply "0xaaa,0xbbb".
    function _parseAddressList(string memory csv) internal pure returns (address[] memory out) {
        bytes memory b = bytes(csv);
        uint256 n = 1;
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] == ",") n++;
        }
        out = new address[](n);

        uint256 start = 0;
        uint256 idx = 0;
        for (uint256 i = 0; i <= b.length; i++) {
            if (i == b.length || b[i] == ",") {
                bytes memory slice = new bytes(i - start);
                for (uint256 j = 0; j < slice.length; j++) {
                    slice[j] = b[start + j];
                }
                out[idx++] = _parseAddress(string(slice));
                start = i + 1;
            }
        }
    }

    function _parseAddress(string memory s) internal pure returns (address) {
        bytes memory b = bytes(s);
        require(b.length == 42, "address must be 0x + 40 hex chars");
        require(b[0] == "0" && (b[1] == "x" || b[1] == "X"), "address must start with 0x");
        uint160 acc = 0;
        for (uint256 i = 2; i < 42; i++) {
            acc = acc * 16 + uint160(_hexDigit(uint8(b[i])));
        }
        return address(acc);
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _hexDigit(uint8 c) internal pure returns (uint8) {
        if (c >= 0x30 && c <= 0x39) return c - 0x30;
        if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
        if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
        revert("invalid hex digit");
    }
}
