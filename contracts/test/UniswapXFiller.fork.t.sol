// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "forge-std/Test.sol";
import {UniswapXFiller, ResolvedOrder, OrderInfo, InputToken, OutputToken, SignedOrder} from "../src/UniswapXFiller.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";

interface IEulerSwapPool {
    function computeQuote(address tokenIn, address tokenOut, uint256 amount, bool exactIn)
        external
        view
        returns (uint256);

    function getLimits(address tokenIn, address tokenOut)
        external
        view
        returns (uint256 maxIn, uint256 maxOut);

    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 status);
}

/// @dev Extended fork test: exercises realistic fill scenarios against mainnet pool.
///      Tests batch fills, profit tracking, pool limits, and withdraw cycle.
///      Run with: forge test --match-contract UniswapXFillerForkTest --fork-url $RPC_URL -vv
contract UniswapXFillerForkTest is Test {
    // Mainnet addresses
    address constant POOL = 0x4311031739918Aba578C3C667DA3028A12Ce28A8;
    address constant REACTOR = 0x00000011F84B9aa48e5f8aA8B9897600006289Be;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    UniswapXFiller filler;
    IEulerSwapPool pool;

    function setUp() public {
        filler = new UniswapXFiller(REACTOR);
        filler.approveToken(USDC);
        filler.approveToken(WETH);
        pool = IEulerSwapPool(POOL);
    }

    function _callbackData(uint256 minProfit) internal pure returns (bytes memory) {
        return abi.encode(POOL, minProfit);
    }

    // ---- Realistic fill with required output ----

    function test_fill_usdc_to_weth_withRequiredOutput() public {
        uint256 usdcAmount = 5000e6; // 5000 USDC
        uint256 quote = pool.computeQuote(USDC, WETH, usdcAmount, true);
        if (quote == 0) return; // skip if pool can't quote

        // Require 99% of the quote (1% spread for the filler)
        uint256 requiredOutput = quote * 99 / 100;

        deal(USDC, address(filler), usdcAmount);
        ResolvedOrder[] memory orders = new ResolvedOrder[](1);
        orders[0] = _buildOrder(USDC, usdcAmount, WETH, requiredOutput, address(0xBEEF));

        vm.prank(REACTOR);
        filler.reactorCallback(orders, _callbackData(0));

        uint256 wethBal = IERC20(WETH).balanceOf(address(filler));
        assertTrue(wethBal >= requiredOutput, "should meet required output");
        console.log("USDC->WETH: in=%d USDC, required=%d, got=%d",
            usdcAmount / 1e6, requiredOutput, wethBal);
    }

    function test_fill_weth_to_usdc_withRequiredOutput() public {
        uint256 wethAmount = 1e18; // 1 WETH
        uint256 quote = pool.computeQuote(WETH, USDC, wethAmount, true);
        if (quote == 0) return;

        uint256 requiredOutput = quote * 99 / 100;

        deal(WETH, address(filler), wethAmount);
        ResolvedOrder[] memory orders = new ResolvedOrder[](1);
        orders[0] = _buildOrder(WETH, wethAmount, USDC, requiredOutput, address(0xBEEF));

        vm.prank(REACTOR);
        filler.reactorCallback(orders, _callbackData(0));

        uint256 usdcBal = IERC20(USDC).balanceOf(address(filler));
        assertTrue(usdcBal >= requiredOutput, "should meet required output");
        console.log("WETH->USDC: in=1 WETH, required=%d, got=%d USDC",
            requiredOutput / 1e6, usdcBal / 1e6);
    }

    // ---- Batch fills ----

    function test_batchFill_two_orders_same_direction() public {
        uint256 amount1 = 1000e6; // 1000 USDC
        uint256 amount2 = 2000e6; // 2000 USDC

        // Check pool can handle combined amount
        (uint256 maxIn,) = pool.getLimits(USDC, WETH);
        if (maxIn < amount1 + amount2) return;

        // Check combined amount is quotable
        uint256 combinedQuote = pool.computeQuote(USDC, WETH, amount1 + amount2, true);
        if (combinedQuote == 0) return;

        deal(USDC, address(filler), amount1 + amount2);

        ResolvedOrder[] memory orders = new ResolvedOrder[](2);
        orders[0] = _buildOrder(USDC, amount1, WETH, 0, address(0xBEEF));
        orders[1] = _buildOrder(USDC, amount2, WETH, 0, address(0xCAFE));

        vm.prank(REACTOR);
        filler.reactorCallback(orders, _callbackData(0));

        uint256 wethBal = IERC20(WETH).balanceOf(address(filler));
        assertTrue(wethBal > 0, "batch should produce WETH");
        console.log("Batch 2x USDC->WETH: total in=%d USDC, total out=%d WETH (wei)",
            (amount1 + amount2) / 1e6, wethBal);
    }

    function test_batchFill_opposite_directions() public {
        // Order 1: USDC -> WETH, Order 2: WETH -> USDC
        uint256 usdcAmount = 2000e6;
        uint256 wethAmount = 0.5e18;

        uint256 quoteUW = pool.computeQuote(USDC, WETH, usdcAmount, true);
        uint256 quoteWU = pool.computeQuote(WETH, USDC, wethAmount, true);
        if (quoteUW == 0 || quoteWU == 0) return;

        deal(USDC, address(filler), usdcAmount);
        deal(WETH, address(filler), wethAmount);

        ResolvedOrder[] memory orders = new ResolvedOrder[](2);
        orders[0] = _buildOrder(USDC, usdcAmount, WETH, 0, address(0xBEEF));
        orders[1] = _buildOrder(WETH, wethAmount, USDC, 0, address(0xCAFE));

        vm.prank(REACTOR);
        filler.reactorCallback(orders, _callbackData(0));

        uint256 wethBal = IERC20(WETH).balanceOf(address(filler));
        uint256 usdcBal = IERC20(USDC).balanceOf(address(filler));
        // At least one token should have balance (net of the two swaps)
        assertTrue(wethBal > 0 || usdcBal > 0, "should have output from bidirectional batch");
        console.log("Bidirectional batch: WETH=%d, USDC=%d", wethBal, usdcBal / 1e6);
    }

    // ---- MinProfit enforcement ----

    function test_minProfit_realistic() public {
        uint256 usdcAmount = 10000e6; // 10k USDC
        uint256 quote = pool.computeQuote(USDC, WETH, usdcAmount, true);
        if (quote == 0) return;

        // Set required output to 99% of quote, so ~1% is "profit"
        uint256 requiredOutput = quote * 99 / 100;
        uint256 expectedProfit = quote - requiredOutput;

        deal(USDC, address(filler), usdcAmount);
        ResolvedOrder[] memory orders = new ResolvedOrder[](1);
        orders[0] = _buildOrder(USDC, usdcAmount, WETH, requiredOutput, address(0xBEEF));

        // minProfit = half the expected profit (should pass)
        vm.prank(REACTOR);
        filler.reactorCallback(orders, _callbackData(expectedProfit / 2));

        uint256 wethBal = IERC20(WETH).balanceOf(address(filler));
        assertTrue(wethBal >= requiredOutput + expectedProfit / 2, "should meet minProfit");
        console.log("MinProfit pass: profit=%d, threshold=%d", wethBal - requiredOutput, expectedProfit / 2);
    }

    function test_minProfit_tight_reverts() public {
        uint256 usdcAmount = 1000e6;
        uint256 quote = pool.computeQuote(USDC, WETH, usdcAmount, true);
        if (quote == 0) return;

        // Set required output to full quote — no room for minProfit
        deal(USDC, address(filler), usdcAmount);
        ResolvedOrder[] memory orders = new ResolvedOrder[](1);
        orders[0] = _buildOrder(USDC, usdcAmount, WETH, quote, address(0xBEEF));

        // Any non-zero minProfit should fail since received == requiredOutput
        vm.prank(REACTOR);
        vm.expectRevert(UniswapXFiller.InsufficientProfit.selector);
        filler.reactorCallback(orders, _callbackData(1));
    }

    // ---- Pool limits ----

    function test_overlimit_reverts() public {
        (uint256 maxIn,) = pool.getLimits(USDC, WETH);
        if (maxIn == 0) return;

        // Try to swap more than the pool limit
        uint256 overLimit = maxIn + 1e6;
        deal(USDC, address(filler), overLimit);

        ResolvedOrder[] memory orders = new ResolvedOrder[](1);
        orders[0] = _buildOrder(USDC, overLimit, WETH, 0, address(0xBEEF));

        vm.prank(REACTOR);
        vm.expectRevert(); // pool should revert (SwapLimitExceeded or CurveViolation)
        filler.reactorCallback(orders, _callbackData(0));
    }

    // ---- Multi-output with required amounts ----

    function test_multiOutput_withAmounts() public {
        uint256 usdcAmount = 5000e6;
        uint256 quote = pool.computeQuote(USDC, WETH, usdcAmount, true);
        if (quote == 0) return;

        // Split required output: 90% to swapper, 10% to fee recipient
        uint256 swapperAmount = quote * 90 / 100;
        uint256 feeAmount = quote * 5 / 100;

        OutputToken[] memory outputs = new OutputToken[](2);
        outputs[0] = OutputToken({token: WETH, amount: swapperAmount, recipient: address(0xBEEF)});
        outputs[1] = OutputToken({token: WETH, amount: feeAmount, recipient: address(0xFEE)});

        ResolvedOrder[] memory orders = new ResolvedOrder[](1);
        orders[0] = ResolvedOrder({
            info: _emptyInfo(),
            input: InputToken({token: USDC, amount: usdcAmount, maxAmount: usdcAmount}),
            outputs: outputs,
            sig: "",
            hash: bytes32(0)
        });

        deal(USDC, address(filler), usdcAmount);
        vm.prank(REACTOR);
        filler.reactorCallback(orders, _callbackData(0));

        uint256 wethBal = IERC20(WETH).balanceOf(address(filler));
        assertTrue(wethBal >= swapperAmount + feeAmount, "should meet multi-output total");
        console.log("Multi-output: total required=%d, got=%d",
            swapperAmount + feeAmount, wethBal);
    }

    // ---- Profit accumulation + withdraw cycle ----

    function test_profit_accumulation_and_withdraw() public {
        // Fill 1: USDC -> WETH
        uint256 usdcAmount = 2000e6;
        uint256 quote1 = pool.computeQuote(USDC, WETH, usdcAmount, true);
        if (quote1 == 0) return;

        deal(USDC, address(filler), usdcAmount);
        ResolvedOrder[] memory orders1 = new ResolvedOrder[](1);
        orders1[0] = _buildOrder(USDC, usdcAmount, WETH, 0, address(0xBEEF));

        vm.prank(REACTOR);
        filler.reactorCallback(orders1, _callbackData(0));
        uint256 profit1 = IERC20(WETH).balanceOf(address(filler));
        assertTrue(profit1 > 0, "fill 1 should produce profit");

        // Fill 2: another USDC -> WETH (profit accumulates)
        deal(USDC, address(filler), usdcAmount);
        ResolvedOrder[] memory orders2 = new ResolvedOrder[](1);
        orders2[0] = _buildOrder(USDC, usdcAmount, WETH, 0, address(0xBEEF));

        vm.prank(REACTOR);
        filler.reactorCallback(orders2, _callbackData(0));
        uint256 totalProfit = IERC20(WETH).balanceOf(address(filler));
        assertTrue(totalProfit > profit1, "profit should accumulate");

        // Withdraw all profit
        address recipient = makeAddr("profitRecipient");
        filler.withdrawAll(WETH, recipient);

        assertEq(IERC20(WETH).balanceOf(address(filler)), 0, "filler should be empty");
        assertEq(IERC20(WETH).balanceOf(recipient), totalProfit, "recipient should have all profit");
        console.log("Profit cycle: fill1=%d, total=%d, withdrawn=%d",
            profit1, totalProfit, IERC20(WETH).balanceOf(recipient));
    }

    // ---- Pool status check ----

    function test_pool_status_unlocked() public view {
        (, , uint32 status) = pool.getReserves();
        assertEq(status, 1, "pool should be unlocked (status=1)");
    }

    function test_pool_quotes_both_directions() public view {
        uint256 quoteUW = pool.computeQuote(USDC, WETH, 1000e6, true);
        uint256 quoteWU = pool.computeQuote(WETH, USDC, 1e18, true);
        assertTrue(quoteUW > 0, "USDC->WETH quote should be non-zero");
        assertTrue(quoteWU > 0, "WETH->USDC quote should be non-zero");
        console.log("Quotes: 1000 USDC -> %d WETH (wei), 1 WETH -> %d USDC",
            quoteUW, quoteWU / 1e6);
    }

    // ---- Helpers ----

    function _buildOrder(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 requiredOutput,
        address recipient
    ) internal pure returns (ResolvedOrder memory) {
        OutputToken[] memory outputs = new OutputToken[](1);
        outputs[0] = OutputToken({token: tokenOut, amount: requiredOutput, recipient: recipient});

        return ResolvedOrder({
            info: _emptyInfo(),
            input: InputToken({token: tokenIn, amount: amountIn, maxAmount: amountIn}),
            outputs: outputs,
            sig: "",
            hash: bytes32(0)
        });
    }

    function _emptyInfo() internal pure returns (OrderInfo memory) {
        return OrderInfo({
            reactor: address(0),
            swapper: address(0),
            nonce: 0,
            deadline: type(uint256).max,
            additionalValidationContract: address(0),
            additionalValidationData: ""
        });
    }
}
