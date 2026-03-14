// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "forge-std/Test.sol";
import {OneInchFusionResolver, LimitOrder} from "../src/OneInchFusionResolver.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";

/// @dev Fork test: deploys OneInchFusionResolver against mainnet EulerSwap pool and 1inch LOP V4
contract OneInchFusionResolverTest is Test {
    // Mainnet addresses
    address constant POOL = 0x4311031739918Aba578C3C667DA3028A12Ce28A8;
    address constant LOP = 0x111111125421cA6dc452d289314280a0f8842A65; // 1inch Limit Order Protocol V4
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    OneInchFusionResolver resolver;

    function setUp() public {
        resolver = new OneInchFusionResolver(LOP);
        resolver.approveToken(USDC, LOP);
        resolver.approveToken(WETH, LOP);
    }

    // ---- Constructor & Access Control ----

    function test_constructor_sets_immutables() public view {
        assertEq(resolver.owner(), address(this));
        assertEq(resolver.limitOrderProtocol(), LOP);
    }

    function test_approveToken_setsAllowance() public view {
        assertEq(IERC20(USDC).allowance(address(resolver), LOP), type(uint256).max);
        assertEq(IERC20(WETH).allowance(address(resolver), LOP), type(uint256).max);
    }

    function test_approveToken_onlyOwner() public {
        vm.prank(makeAddr("notOwner"));
        vm.expectRevert(OneInchFusionResolver.Unauthorized.selector);
        resolver.approveToken(USDC, LOP);
    }

    // ---- takerInteraction ----

    function test_takerInteraction_onlyLOP() public {
        vm.expectRevert(OneInchFusionResolver.OnlyLOP.selector);
        resolver.takerInteraction(
            _emptyOrder(), "", bytes32(0), address(resolver), 0, 0, 0, _extraData(USDC, WETH, 0)
        );
    }

    function test_takerInteraction_notTaker() public {
        vm.prank(LOP);
        vm.expectRevert(OneInchFusionResolver.NotTaker.selector);
        resolver.takerInteraction(
            _emptyOrder(),
            "",
            bytes32(0),
            makeAddr("wrongTaker"), // not the resolver
            0,
            0,
            0,
            _extraData(USDC, WETH, 0)
        );
    }

    function test_takerInteraction_usdc_to_weth() public {
        // Simulate LOP transferring maker's USDC to resolver
        uint256 makerAmount = 1000e6;
        deal(USDC, address(resolver), makerAmount);

        // takingAmount = WETH the LOP will pull from us (set to 0 for this unit test)
        vm.prank(LOP);
        resolver.takerInteraction(
            _emptyOrder(), "", bytes32(0), address(resolver), makerAmount, 0, 0, _extraData(USDC, WETH, 0)
        );

        uint256 wethBal = IERC20(WETH).balanceOf(address(resolver));
        assertTrue(wethBal > 0, "should have received WETH from EulerSwap");
        console.log("USDC->WETH: input=%d USDC, output=%d WETH (wei)", makerAmount / 1e6, wethBal);
    }

    function test_takerInteraction_weth_to_usdc() public {
        uint256 makerAmount = 0.5e18;
        deal(WETH, address(resolver), makerAmount);

        vm.prank(LOP);
        resolver.takerInteraction(
            _emptyOrder(), "", bytes32(0), address(resolver), makerAmount, 0, 0, _extraData(WETH, USDC, 0)
        );

        uint256 usdcBal = IERC20(USDC).balanceOf(address(resolver));
        assertTrue(usdcBal > 0, "should have received USDC from EulerSwap");
        console.log("WETH->USDC: input=0.5 WETH, output=%d USDC", usdcBal / 1e6);
    }

    function test_takerInteraction_minProfit_passes() public {
        uint256 makerAmount = 1000e6;
        deal(USDC, address(resolver), makerAmount);

        // minProfit = 0, takingAmount = 0 → any output satisfies
        vm.prank(LOP);
        resolver.takerInteraction(
            _emptyOrder(), "", bytes32(0), address(resolver), makerAmount, 0, 0, _extraData(USDC, WETH, 0)
        );

        assertTrue(IERC20(WETH).balanceOf(address(resolver)) > 0);
    }

    function test_takerInteraction_minProfit_reverts() public {
        uint256 makerAmount = 1000e6;
        deal(USDC, address(resolver), makerAmount);

        vm.prank(LOP);
        vm.expectRevert(OneInchFusionResolver.InsufficientProfit.selector);
        resolver.takerInteraction(
            _emptyOrder(),
            "",
            bytes32(0),
            address(resolver),
            makerAmount,
            0, // takingAmount
            0,
            _extraData(USDC, WETH, type(uint256).max) // impossible minProfit
        );
    }

    function test_takerInteraction_takingAmount_check() public {
        // Verify that takingAmount is factored into the profit check
        uint256 makerAmount = 1000e6;
        deal(USDC, address(resolver), makerAmount);

        // Set takingAmount impossibly high → revert even with minProfit = 0
        vm.prank(LOP);
        vm.expectRevert(OneInchFusionResolver.InsufficientProfit.selector);
        resolver.takerInteraction(
            _emptyOrder(),
            "",
            bytes32(0),
            address(resolver),
            makerAmount,
            type(uint256).max, // impossibly high takingAmount
            0,
            _extraData(USDC, WETH, 0)
        );
    }

    // ---- settleOrders ----

    function test_settleOrders_onlyOwner() public {
        vm.prank(makeAddr("notOwner"));
        vm.expectRevert(OneInchFusionResolver.Unauthorized.selector);
        resolver.settleOrders("");
    }

    function test_settleOrders_bubbles_revert() public {
        // Calling LOP with garbage data should revert (bubbled from LOP)
        vm.expectRevert();
        resolver.settleOrders(hex"deadbeef");
    }

    // ---- Withdraw ----

    function test_withdraw_onlyOwner() public {
        deal(USDC, address(resolver), 1000e6);

        vm.prank(makeAddr("notOwner"));
        vm.expectRevert(OneInchFusionResolver.Unauthorized.selector);
        resolver.withdraw(USDC, 1000e6, makeAddr("notOwner"));
    }

    function test_withdraw() public {
        deal(USDC, address(resolver), 1000e6);
        address recipient = makeAddr("recipient");

        resolver.withdraw(USDC, 500e6, recipient);
        assertEq(IERC20(USDC).balanceOf(recipient), 500e6);
        assertEq(IERC20(USDC).balanceOf(address(resolver)), 500e6);
    }

    function test_withdrawAll() public {
        deal(WETH, address(resolver), 1e18);
        address recipient = makeAddr("recipient");

        resolver.withdrawAll(WETH, recipient);
        assertEq(IERC20(WETH).balanceOf(recipient), 1e18);
        assertEq(IERC20(WETH).balanceOf(address(resolver)), 0);
    }

    // ---- Helpers ----

    function _extraData(address makerAsset, address takerAsset, uint256 minProfit)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(POOL, makerAsset, takerAsset, minProfit);
    }

    function _emptyOrder() internal pure returns (LimitOrder memory) {
        return LimitOrder({
            salt: 0,
            maker: 0,
            receiver: 0,
            makerAsset: 0,
            takerAsset: 0,
            makingAmount: 0,
            takingAmount: 0,
            makerTraits: 0
        });
    }
}
