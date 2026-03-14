// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.13;

import "src/interfaces/ISwapAdapterTypes.sol";

library FractionMath {
    /// @dev Compares two Fraction instances from ISwapAdapterTypes.
    /// @param frac1 The first Fraction instance.
    /// @param frac2 The second Fraction instance.
    /// @return int8 Returns 0 if fractions are equal, 1 if frac1 is greater, -1
    /// if frac1 is lesser.
    function compareFractions(
        ISwapAdapterTypes.Fraction memory frac1,
        ISwapAdapterTypes.Fraction memory frac2
    ) internal pure returns (int8) {
        uint256 fixed1 = toQ128x128(frac1.numerator, frac1.denominator);
        uint256 fixed2 = toQ128x128(frac2.numerator, frac2.denominator);

        // fractions are equal
        if (fixed1 == fixed2) return 0;
        // frac1 is greater than frac2
        else if (fixed1 > fixed2) return 1;
        // frac1 is less than frac2
        else return -1;
    }

    /// @notice Converts a Fraction into unsigned Q128.128 fixed point
    function toQ128x128(ISwapAdapterTypes.Fraction memory rational)
        internal
        pure
        returns (uint256 result)
    {
        return toQ128x128(rational.numerator, rational.denominator);
    }

    /// @notice Converts an unsigned rational `numerator / denominator`
    ///         into Q128.128 (unsigned 128.128 fixed point),
    ///         rounding toward zero (floor for positive inputs).
    ///
    ///         see https://github.com/Liquidity-Party/toQ128x128
    ///
    /// @dev Reverts if:
    ///      - `denominator == 0`, or
    ///      - the exact result >= 2^256 (i.e. overflow of uint256).
    ///
    ///      This computes floor(numerator * 2^128 / denominator)
    ///      using a full 512-bit intermediate to avoid precision loss.
    ///
    function toQ128x128(uint256 numerator, uint256 denominator)
        internal
        pure
        returns (uint256 result)
    {
        require(denominator != 0, "toQ128x128: div by zero");

        uint256 prod0;
        uint256 prod1;
        unchecked {
            prod0 = numerator << 128;
            prod1 = numerator >> 128;
        }

        if (prod1 == 0) {
            unchecked {
                return prod0 / denominator;
            }
        }

        require(denominator > prod1, "Q128x128: overflow");

        uint256 remainder;
        assembly {
            remainder := mulmod(numerator, shl(128, 1), denominator)
        }

        assembly {
            let borrow := lt(prod0, remainder)
            prod0 := sub(prod0, remainder)
            prod1 := sub(prod1, borrow)
        }

        uint256 twos;
        unchecked {
            twos = denominator & (~denominator + 1);
        }

        assembly {
            denominator := div(denominator, twos)
            prod0 := div(prod0, twos)
            twos := add(div(sub(0, twos), twos), 1)
            prod0 := or(prod0, mul(prod1, twos))
        }

        unchecked {
            uint256 inv = (3 * denominator) ^ 2;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            result = prod0 * inv;
        }
    }

    /// @notice Multiply a Fraction and a uint256 using full precision
    function mul(ISwapAdapterTypes.Fraction memory rational, uint256 y)
        internal
        pure
        returns (uint256 result)
    {
        return mulDiv(rational.numerator, y, rational.denominator);
    }

    /// @notice Full-precision mulDiv: computes floor(x * y / denominator)
    ///         with 512-bit intermediate precision to avoid overflow.
    function mulDiv(uint256 x, uint256 y, uint256 denominator)
        internal
        pure
        returns (uint256 result)
    {
        require(denominator != 0, "mulDiv: div by zero");

        uint256 prod0;
        uint256 prod1;
        assembly {
            let mm := mulmod(x, y, not(0))
            prod0 := mul(x, y)
            prod1 := sub(sub(mm, prod0), lt(mm, prod0))
        }

        if (prod1 == 0) {
            unchecked {
                return prod0 / denominator;
            }
        }

        require(denominator > prod1, "mulDiv: overflow");

        uint256 remainder;
        assembly {
            remainder := mulmod(x, y, denominator)
            let borrow := lt(prod0, remainder)
            prod0 := sub(prod0, remainder)
            prod1 := sub(prod1, borrow)
        }

        uint256 twos;
        unchecked {
            twos = denominator & (~denominator + 1);
        }

        assembly {
            denominator := div(denominator, twos)
            prod0 := div(prod0, twos)
            twos := add(div(sub(0, twos), twos), 1)
            prod0 := or(prod0, mul(prod1, twos))
        }

        unchecked {
            uint256 inv = (3 * denominator) ^ 2;
            inv *= 2 - denominator * inv; // 2^8
            inv *= 2 - denominator * inv; // 2^16
            inv *= 2 - denominator * inv; // 2^32
            inv *= 2 - denominator * inv; // 2^64
            inv *= 2 - denominator * inv; // 2^128
            inv *= 2 - denominator * inv; // 2^256
            result = prod0 * inv;
        }
    }
}
