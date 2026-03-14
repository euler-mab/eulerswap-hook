// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";

interface IEulerSwapPool {
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function computeQuote(address tokenIn, address tokenOut, uint256 amount, bool exactIn)
        external
        view
        returns (uint256);
}

/// @dev Minimal struct from UniswapX ReactorStructs.sol
struct ResolvedOrder {
    OrderInfo info;
    InputToken input;
    OutputToken[] outputs;
    bytes sig;
    bytes32 hash;
}

struct OrderInfo {
    address reactor;
    address swapper;
    uint256 nonce;
    uint256 deadline;
    address additionalValidationContract;
    bytes additionalValidationData;
}

struct InputToken {
    address token;
    uint256 amount;
    uint256 maxAmount;
}

struct OutputToken {
    address token;
    uint256 amount;
    address recipient;
}

/// @title UniswapXFiller
/// @notice Executor contract for filling UniswapX orders via EulerSwap.
/// @dev Implements IReactorCallback. When the reactor calls reactorCallback,
///      this contract swaps input tokens through EulerSwap to source output tokens.
///      Pool address and min profit are passed via callbackData, making the contract
///      reusable across pools without redeployment.
contract UniswapXFiller {
    using SafeERC20 for IERC20;

    address public immutable owner;
    address public immutable reactor;

    error Unauthorized();
    error OnlyReactor();
    error MultipleOutputsNotSupported();
    error InsufficientProfit();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address _reactor) {
        owner = msg.sender;
        reactor = _reactor;
    }

    /// @notice Approve a token to the reactor. Call once per token before filling.
    function approveToken(address token) external onlyOwner {
        IERC20(token).forceApprove(reactor, type(uint256).max);
    }

    /// @notice Called by the reactor during executeWithCallback.
    ///         Input tokens have been transferred to this contract by the reactor.
    ///         We swap them through EulerSwap, then the reactor pulls outputs via transferFrom.
    /// @param callbackData ABI-encoded (address pool, uint256 minProfit)
    function reactorCallback(ResolvedOrder[] calldata resolvedOrders, bytes calldata callbackData) external {
        if (msg.sender != reactor) revert OnlyReactor();

        (address pool, uint256 minProfit) = abi.decode(callbackData, (address, uint256));

        for (uint256 i = 0; i < resolvedOrders.length; i++) {
            _fillOrder(resolvedOrders[i], pool, minProfit);
        }
    }

    function _fillOrder(ResolvedOrder calldata order, address pool, uint256 minProfit) internal {
        // Only single-output orders supported (covers standard UniswapX swaps)
        if (order.outputs.length != 1) revert MultipleOutputsNotSupported();

        address tokenIn = order.input.token;
        uint256 amountIn = order.input.amount;
        address tokenOut = order.outputs[0].token;
        uint256 requiredOutput = order.outputs[0].amount;

        // Transfer input tokens to EulerSwap pool
        IERC20(tokenIn).safeTransfer(pool, amountIn);

        // Get quote for exact input
        uint256 amountOut = IEulerSwapPool(pool).computeQuote(tokenIn, tokenOut, amountIn, true);

        // Execute swap — no callback data (pool reads its balance for input)
        if (tokenIn < tokenOut) {
            // tokenIn is asset0, getting asset1 out
            IEulerSwapPool(pool).swap(0, amountOut, address(this), "");
        } else {
            // tokenIn is asset1, getting asset0 out
            IEulerSwapPool(pool).swap(amountOut, 0, address(this), "");
        }

        // Verify minimum profit
        uint256 outputBal = IERC20(tokenOut).balanceOf(address(this));
        if (outputBal < requiredOutput + minProfit) revert InsufficientProfit();

        // Reactor will now pull required output via transferFrom.
        // Any excess output stays in this contract as profit.
    }

    /// @notice Withdraw accumulated profit
    function withdraw(address token, uint256 amount, address to) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Withdraw all of a token
    function withdrawAll(address token, address to) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).safeTransfer(to, bal);
    }

    /// @notice Allow receiving ETH (for WETH unwrapping if needed)
    receive() external payable {}
}
