// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {EulerSwapTestBase, EulerSwap, TestERC20} from "../eulerswap/test/EulerSwapTestBase.t.sol";

/// @notice Integration test verifying that TS-computed boost parameters produce
///         pools whose health remains ≥ 1 at the range boundary.
///         Pool params are passed via environment variables from the TS orchestrator.
contract BoostVerifyTest is EulerSwapTestBase {
    function setUp() public override {
        super.setUp();

        // Extra borrow liquidity for high-boost scenarios
        mintAndDeposit(depositor, eTST, 1000e18);
        mintAndDeposit(depositor, eTST2, 1000e18);
    }

    /// @notice Swap to the X-side boundary (send Y in, receive X out).
    ///         If the TS boost is correct, the EVC health check passes.
    function test_xBoundary() public {
        (EulerSwap pool,,) = _createPoolFromEnv();

        // Swap to X-side boundary: send assetTST2 (Y) to get assetTST (X)
        (uint256 inLimit,) = periphery.getLimits(address(pool), address(assetTST2), address(assetTST));
        if (inLimit > 0) {
            uint256 amountOut = periphery.quoteExactInput(address(pool), address(assetTST2), address(assetTST), inLimit);
            assetTST2.mint(address(this), inLimit);
            assetTST2.transfer(address(pool), inLimit);
            pool.swap(amountOut, 0, address(this), "");
        }
        // If we reach here, health check passed — swap would have reverted otherwise
    }

    /// @notice Swap to the Y-side boundary (send X in, receive Y out).
    function test_yBoundary() public {
        (EulerSwap pool,,) = _createPoolFromEnv();

        // Swap to Y-side boundary: send assetTST (X) to get assetTST2 (Y)
        (uint256 inLimit,) = periphery.getLimits(address(pool), address(assetTST), address(assetTST2));
        if (inLimit > 0) {
            uint256 amountOut = periphery.quoteExactInput(address(pool), address(assetTST), address(assetTST2), inLimit);
            assetTST.mint(address(this), inLimit);
            assetTST.transfer(address(pool), inLimit);
            pool.swap(0, amountOut, address(this), "");
        }
        // If we reach here, health check passed — swap would have reverted otherwise
    }

    function _createPoolFromEnv() internal returns (EulerSwap pool, uint80 px, uint80 py) {
        uint112 x0 = uint112(vm.envUint("X0"));
        uint112 y0 = uint112(vm.envUint("Y0"));
        px = uint80(vm.envUint("PX"));
        py = uint80(vm.envUint("PY"));
        uint64 cx = uint64(vm.envUint("CX"));
        uint64 cy = uint64(vm.envUint("CY"));

        // Update oracle prices to match pool params
        oracle.setPrice(address(assetTST), unitOfAccount, uint256(px));
        oracle.setPrice(address(assetTST2), unitOfAccount, uint256(py));
        oracle.setPrice(address(assetTST), address(assetTST2), uint256(px) * 1e18 / uint256(py));
        oracle.setPrice(address(assetTST2), address(assetTST), uint256(py) * 1e18 / uint256(px));

        pool = createEulerSwap(x0, y0, 0, px, py, cx, cy);
    }
}
