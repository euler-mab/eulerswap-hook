// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {CurveLib} from "../eulerswap/src/libraries/CurveLib.sol";

/// @notice Thin wrapper exposing CurveLib.f and CurveLib.fInverse for differential testing.
contract CurveHarness {
    function f(uint256 x, uint256 px, uint256 py, uint256 x0, uint256 y0, uint256 c)
        external
        pure
        returns (uint256)
    {
        return CurveLib.f(x, px, py, x0, y0, c);
    }

    function fInverse(uint256 y, uint256 px, uint256 py, uint256 x0, uint256 y0, uint256 cx)
        external
        pure
        returns (uint256)
    {
        return CurveLib.fInverse(y, px, py, x0, y0, cx);
    }
}
