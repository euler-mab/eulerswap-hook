// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "forge-std/Test.sol";
import {UniswapXFiller, ResolvedOrder, OrderInfo, InputToken, OutputToken} from "../src/UniswapXFiller.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";

/// @dev Fork test: deploys UniswapXFiller against mainnet EulerSwap pool and V2DutchOrderReactor
contract UniswapXFillerTest is Test {
    // Mainnet addresses
    address constant POOL = 0x4311031739918Aba578C3C667DA3028A12Ce28A8;
    address constant REACTOR = 0x00000011F84B9aa48e5f8aA8B9897600006289Be;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    UniswapXFiller filler;

    function setUp() public {
        filler = new UniswapXFiller(REACTOR, POOL, USDC, WETH);
    }

    function test_constructor_sets_immutables() public view {
        assertEq(filler.owner(), address(this));
        assertEq(filler.reactor(), REACTOR);
        assertEq(filler.pool(), POOL);
        assertEq(filler.asset0(), USDC);
        assertEq(filler.asset1(), WETH);
    }

    function test_constructor_approves_reactor() public view {
        uint256 usdcAllowance = IERC20(USDC).allowance(address(filler), REACTOR);
        uint256 wethAllowance = IERC20(WETH).allowance(address(filler), REACTOR);
        assertEq(usdcAllowance, type(uint256).max);
        assertEq(wethAllowance, type(uint256).max);
    }

    function test_reactorCallback_onlyReactor() public {
        ResolvedOrder[] memory orders = new ResolvedOrder[](0);
        vm.expectRevert(UniswapXFiller.OnlyReactor.selector);
        filler.reactorCallback(orders, "");
    }

    function test_reactorCallback_fills_usdc_to_weth() public {
        // Simulate reactor calling our executor with USDC input
        uint256 usdcAmount = 1000e6; // 1000 USDC
        deal(USDC, address(filler), usdcAmount);

        // Build a mock ResolvedOrder
        ResolvedOrder[] memory orders = new ResolvedOrder[](1);
        orders[0] = _buildOrder(USDC, usdcAmount, WETH, address(this));

        // Call as reactor
        vm.prank(REACTOR);
        filler.reactorCallback(orders, "");

        // Filler should have WETH output
        uint256 wethBal = IERC20(WETH).balanceOf(address(filler));
        assertTrue(wethBal > 0, "should have received WETH");
        console.log("USDC->WETH: input=%d USDC, output=%d WETH (wei)", usdcAmount / 1e6, wethBal);
    }

    function test_reactorCallback_fills_weth_to_usdc() public {
        // Simulate reactor calling our executor with WETH input
        uint256 wethAmount = 0.5e18; // 0.5 WETH
        deal(WETH, address(filler), wethAmount);

        ResolvedOrder[] memory orders = new ResolvedOrder[](1);
        orders[0] = _buildOrder(WETH, wethAmount, USDC, address(this));

        vm.prank(REACTOR);
        filler.reactorCallback(orders, "");

        uint256 usdcBal = IERC20(USDC).balanceOf(address(filler));
        assertTrue(usdcBal > 0, "should have received USDC");
        console.log("WETH->USDC: input=0.5 WETH, output=%d USDC", usdcBal / 1e6);
    }

    function test_withdraw_onlyOwner() public {
        deal(USDC, address(filler), 1000e6);

        address notOwner = makeAddr("notOwner");
        vm.prank(notOwner);
        vm.expectRevert(UniswapXFiller.Unauthorized.selector);
        filler.withdraw(USDC, 1000e6, notOwner);
    }

    function test_withdraw() public {
        deal(USDC, address(filler), 1000e6);
        address recipient = makeAddr("recipient");

        filler.withdraw(USDC, 500e6, recipient);
        assertEq(IERC20(USDC).balanceOf(recipient), 500e6);
        assertEq(IERC20(USDC).balanceOf(address(filler)), 500e6);
    }

    function test_withdrawAll() public {
        deal(WETH, address(filler), 1e18);
        address recipient = makeAddr("recipient");

        filler.withdrawAll(WETH, recipient);
        assertEq(IERC20(WETH).balanceOf(recipient), 1e18);
        assertEq(IERC20(WETH).balanceOf(address(filler)), 0);
    }

    // ---- Helpers ----

    function _buildOrder(address tokenIn, uint256 amountIn, address tokenOut, address recipient)
        internal
        pure
        returns (ResolvedOrder memory)
    {
        OutputToken[] memory outputs = new OutputToken[](1);
        outputs[0] = OutputToken({token: tokenOut, amount: 0, recipient: recipient});

        return ResolvedOrder({
            info: OrderInfo({
                reactor: address(0),
                swapper: address(0),
                nonce: 0,
                deadline: type(uint256).max,
                additionalValidationContract: address(0),
                additionalValidationData: ""
            }),
            input: InputToken({token: tokenIn, amount: amountIn, maxAmount: amountIn}),
            outputs: outputs,
            sig: "",
            hash: bytes32(0)
        });
    }
}
