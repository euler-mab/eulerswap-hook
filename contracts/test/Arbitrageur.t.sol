// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {EulerSwapTestBase, TestERC20} from "../eulerswap/test/EulerSwapTestBase.t.sol";
import {EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {Arbitrageur} from "../src/Arbitrageur.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";

/// @dev Mock Uniswap V3 SwapRouter02 — converts tokenIn -> tokenOut at a fixed 1:1 rate.
///      The "real" arb profit comes from the pool being mispriced vs this fair-price router.
contract MockSwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut) {
        // 1:1 exchange rate (fair price). Profit comes from pool mispricing.
        amountOut = p.amountIn;
        require(amountOut >= p.amountOutMinimum, "MockSwapRouter: insufficient output");

        IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        TestERC20(p.tokenOut).mint(p.recipient, amountOut);
    }
}

contract ArbitrageurTest is EulerSwapTestBase {
    Arbitrageur arb;
    EulerSwap pool;
    MockSwapRouter mockRouter;

    function setUp() public override {
        super.setUp();

        // Pool: 100 token0 + 100 token1, no static fee, 1:1 prices, 50% concentration
        pool = createEulerSwap(100e18, 100e18, 0, 1e18, 1e18, 0.5e18, 0.5e18);

        mockRouter = new MockSwapRouter();

        // Deploy Arbitrageur (this contract = owner)
        arb = new Arbitrageur(address(mockRouter), address(assetTST), address(assetTST2));
    }

    // ─── Helpers ──────────────────────────────────────────────────────

    /// @dev Sell asset0 into pool, making asset0 cheap / asset1 expensive.
    function _pushAsset0Cheap(uint256 amount) internal {
        assetTST.mint(address(this), amount);
        assetTST.transfer(address(pool), amount);
        uint256 out = pool.computeQuote(address(assetTST), address(assetTST2), amount, true);
        pool.swap(0, out, address(this), "");
    }

    /// @dev Sell asset1 into pool, making asset1 cheap / asset0 expensive.
    function _pushAsset1Cheap(uint256 amount) internal {
        assetTST2.mint(address(this), amount);
        assetTST2.transfer(address(pool), amount);
        uint256 out = pool.computeQuote(address(assetTST2), address(assetTST), amount, true);
        pool.swap(out, 0, address(this), "");
    }

    // ─── Direction B: buy asset0 from pool, sell on Uni for asset1 ───

    function test_directionB_profitable() public {
        // Push asset0 cheap in pool
        _pushAsset0Cheap(10e18);

        uint256 arbAmount0 = 5e18;
        // How much asset1 does pool need for us to take 5e18 asset0?
        uint256 amountRequired = pool.computeQuote(address(assetTST2), address(assetTST), arbAmount0, false);

        // amountRequired < 5e18 because asset0 is cheap in pool
        assertLt(amountRequired, 5e18, "pool should be mispriced");

        arb.execute(address(pool), arbAmount0, 0, amountRequired, 500, 0, block.timestamp + 100);

        // Profit = uniOut (5e18) - amountRequired (< 5e18) in asset1
        uint256 profit = assetTST2.balanceOf(address(arb));
        assertGt(profit, 0, "should have profit in asset1");
    }

    // ─── Direction A: buy asset1 from pool, sell on Uni for asset0 ───

    function test_directionA_profitable() public {
        // Push asset1 cheap in pool
        _pushAsset1Cheap(10e18);

        uint256 arbAmount1 = 5e18;
        uint256 amountRequired = pool.computeQuote(address(assetTST), address(assetTST2), arbAmount1, false);

        assertLt(amountRequired, 5e18, "pool should be mispriced");

        arb.execute(address(pool), 0, arbAmount1, amountRequired, 500, 0, block.timestamp + 100);

        uint256 profit = assetTST.balanceOf(address(arb));
        assertGt(profit, 0, "should have profit in asset0");
    }

    // ─── minProfit enforcement ───────────────────────────────────────

    function test_revert_insufficientProfit() public {
        _pushAsset0Cheap(10e18);

        uint256 arbAmount0 = 5e18;
        uint256 amountRequired = pool.computeQuote(address(assetTST2), address(assetTST), arbAmount0, false);

        // Set minProfit absurdly high — should revert
        uint256 absurdMinProfit = 100e18;
        vm.expectRevert(); // MockSwapRouter will revert on amountOutMinimum check
        arb.execute(address(pool), arbAmount0, 0, amountRequired, 500, absurdMinProfit, block.timestamp + 100);
    }

    // ─── Access control ──────────────────────────────────────────────

    function test_revert_nonOwner() public {
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(Arbitrageur.Unauthorized.selector);
        arb.execute(address(pool), 1e18, 0, 1e18, 500, 0, block.timestamp + 100);
    }

    function test_revert_deadline() public {
        vm.expectRevert(Arbitrageur.DeadlineExpired.selector);
        arb.execute(address(pool), 1e18, 0, 1e18, 500, 0, block.timestamp - 1);
    }

    // ─── Withdrawals ─────────────────────────────────────────────────

    function test_withdraw() public {
        assetTST.mint(address(arb), 10e18);
        address to = makeAddr("to");
        arb.withdraw(address(assetTST), 5e18, to);
        assertEq(assetTST.balanceOf(to), 5e18);
    }

    function test_withdrawAll() public {
        assetTST.mint(address(arb), 10e18);
        address to = makeAddr("to");
        arb.withdrawAll(address(assetTST), to);
        assertEq(assetTST.balanceOf(to), 10e18);
        assertEq(assetTST.balanceOf(address(arb)), 0);
    }

    function test_withdraw_revert_nonOwner() public {
        assetTST.mint(address(arb), 10e18);
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(Arbitrageur.Unauthorized.selector);
        arb.withdraw(address(assetTST), 1e18, makeAddr("attacker"));
    }
}
