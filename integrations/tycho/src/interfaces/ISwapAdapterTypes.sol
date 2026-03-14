// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.13;

/// @title ISwapAdapterTypes
/// @dev Types used by the ISwapAdapter interface.
interface ISwapAdapterTypes {
    /// @dev The side of the order.
    enum OrderSide {
        Sell,
        Buy
    }

    /// @dev Capabilities of a pool.
    enum Capability {
        SellOrder,
        BuyOrder,
        PriceFunction,
        FeeOnTransfer,
        ConstantPrice,
        MarginalPrice,
        HardLimits,
        ScaledPrices
    }

    /// @dev A fraction with a numerator and denominator.
    struct Fraction {
        uint256 numerator;
        uint256 denominator;
    }

    /// @dev A trade result.
    struct Trade {
        uint256 calculatedAmount;
        uint256 gasUsed;
        Fraction price;
    }

    /// @dev Thrown when a pool or swap is not available.
    error Unavailable(string reason);

    /// @dev Thrown when an order is invalid.
    error InvalidOrder(string reason);

    /// @dev Thrown when an amount is too small to process.
    error TooSmall(string reason);

    /// @dev Thrown when a limit is exceeded.
    error LimitExceeded(string reason);

    /// @dev Thrown when a function is not implemented.
    error NotImplemented(string reason);
}
