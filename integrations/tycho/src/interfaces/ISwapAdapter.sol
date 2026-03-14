// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.13;

import {ISwapAdapterTypes} from "src/interfaces/ISwapAdapterTypes.sol";

/// @title ISwapAdapter
/// @dev Implement this interface to support Propeller routing through your
/// pools.
interface ISwapAdapter is ISwapAdapterTypes {
    /// @notice Calculates marginal prices for specified amounts (optional).
    /// @dev The returned prices should include all dex fees. The returned price
    /// should be the marginal price (price to trade an infinitesimally small
    /// amount after the trade of specifiedAmount).
    /// @param poolId The ID of the trading pool.
    /// @param sellToken The token being sold.
    /// @param buyToken The token being bought.
    /// @param specifiedAmounts Amounts to calculate marginal prices at.
    /// @return prices Array of prices as fractions.
    function price(
        bytes32 poolId,
        address sellToken,
        address buyToken,
        uint256[] memory specifiedAmounts
    ) external returns (Fraction[] memory prices);

    /// @notice Simulates swapping tokens on a given pool.
    /// @dev This function should actually execute the swap and change EVM state.
    /// @param poolId The ID of the trading pool.
    /// @param sellToken The token being sold.
    /// @param buyToken The token being bought.
    /// @param side The side of the trade (Sell or Buy).
    /// @param specifiedAmount The amount to be traded.
    /// @return trade Trade struct with calculatedAmount, gasUsed, and price.
    function swap(
        bytes32 poolId,
        address sellToken,
        address buyToken,
        OrderSide side,
        uint256 specifiedAmount
    ) external returns (Trade memory trade);

    /// @notice Retrieves the limits for each token.
    /// @dev Returns max sell and max buy amounts.
    /// @param poolId The ID of the trading pool.
    /// @param sellToken The token being sold.
    /// @param buyToken The token being bought.
    /// @return limits Array of [maxSell, maxBuy].
    function getLimits(bytes32 poolId, address sellToken, address buyToken)
        external
        returns (uint256[] memory limits);

    /// @notice Retrieves the capabilities of the selected pool.
    /// @param poolId The ID of the trading pool.
    /// @return capabilities An array of Capability.
    function getCapabilities(
        bytes32 poolId,
        address sellToken,
        address buyToken
    ) external returns (Capability[] memory capabilities);

    /// @notice Retrieves the tokens in the selected pool.
    /// @param poolId The ID of the trading pool.
    /// @return tokens An array of token addresses.
    function getTokens(bytes32 poolId)
        external
        returns (address[] memory tokens);

    /// @notice Retrieves a range of pool IDs.
    /// @param offset The starting index.
    /// @param limit The maximum number of pool IDs to retrieve.
    /// @return ids An array of pool IDs.
    function getPoolIds(uint256 offset, uint256 limit)
        external
        returns (bytes32[] memory ids);
}
