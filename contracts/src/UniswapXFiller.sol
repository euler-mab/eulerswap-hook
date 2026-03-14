// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";

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
///      Profit (excess output beyond what the reactor pulls) accumulates in this contract.
contract UniswapXFiller {
    address public immutable owner;
    address public immutable reactor;
    address public immutable pool;
    address public immutable asset0; // USDC (lower address)
    address public immutable asset1; // WETH (higher address)

    error Unauthorized();
    error OnlyReactor();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address _reactor, address _pool, address _asset0, address _asset1) {
        owner = msg.sender;
        reactor = _reactor;
        pool = _pool;
        asset0 = _asset0;
        asset1 = _asset1;

        // Pre-approve reactor to pull output tokens after swap
        IERC20(_asset0).approve(_reactor, type(uint256).max);
        IERC20(_asset1).approve(_reactor, type(uint256).max);
    }

    /// @notice Called by the reactor during executeWithCallback.
    ///         Input tokens have been transferred to this contract by the reactor.
    ///         We swap them through EulerSwap, then the reactor pulls outputs via transferFrom.
    function reactorCallback(ResolvedOrder[] calldata resolvedOrders, bytes calldata) external {
        if (msg.sender != reactor) revert OnlyReactor();

        for (uint256 i = 0; i < resolvedOrders.length; i++) {
            _fillOrder(resolvedOrders[i]);
        }
    }

    function _fillOrder(ResolvedOrder calldata order) internal {
        address tokenIn = order.input.token;
        uint256 amountIn = order.input.amount;
        address tokenOut = order.outputs[0].token;

        // Transfer input tokens to EulerSwap pool
        IERC20(tokenIn).transfer(pool, amountIn);

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

        // Reactor will now pull required output via transferFrom (approvals set in constructor).
        // Any excess output stays in this contract as profit.
    }

    /// @notice Withdraw accumulated profit
    function withdraw(address token, uint256 amount, address to) external onlyOwner {
        IERC20(token).transfer(to, amount);
    }

    /// @notice Withdraw all of a token
    function withdrawAll(address token, address to) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).transfer(to, bal);
    }

    /// @notice Allow receiving ETH (for WETH unwrapping if needed)
    receive() external payable {}
}
