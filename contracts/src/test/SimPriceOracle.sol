// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockPriceOracle — Drop-in IPriceOracle replacement for Anvil fork testing
/// @notice Uses fixed storage slots so prices can be updated via anvil_setStorageAt.
///         Deploy bytecode at the real oracle address with anvil_setCode.
///
/// Storage layout:
///   slot 0: uint256 price0 — price of asset0 in unitOfAccount (WAD-scaled, 1e18 = $1)
///   slot 1: uint256 price1 — price of asset1 in unitOfAccount (WAD-scaled)
///   slot 2: address asset0
///   slot 3: address asset1
contract SimPriceOracle {
    uint256 public price0;  // slot 0
    uint256 public price1;  // slot 1
    address public asset0;  // slot 2
    address public asset1;  // slot 3

    function getQuote(uint256 inAmount, address base, address) external view returns (uint256) {
        uint256 price = base == asset0 ? price0 : price1;
        return (inAmount * price) / 1e18;
    }

    function getQuotes(uint256 inAmount, address base, address quote)
        external
        view
        returns (uint256, uint256)
    {
        uint256 out = this.getQuote(inAmount, base, quote);
        return (out, out);
    }

    function name() external pure returns (string memory) {
        return "MockPriceOracle";
    }
}
