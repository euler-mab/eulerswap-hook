// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IEulerSwapCallee} from "../eulerswap/src/interfaces/IEulerSwapCallee.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IEulerSwapPool {
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function getAssets() external view returns (address asset0, address asset1);
}

/// @title Arbitrageur
/// @notice Atomic arb: flash-swap from EulerSwap pool → sell on Uniswap V3 → keep profit.
/// @dev Uses EulerSwap's IEulerSwapCallee callback (like Uni V2 flash-swaps).
///      The pool sends output tokens first, then verifies its invariant after the callback.
///      Zero capital required — if the arb isn't profitable, the tx reverts.
contract Arbitrageur is IEulerSwapCallee {
    address public immutable owner;
    address public immutable uniRouter;
    address public immutable asset0;
    address public immutable asset1;

    // Track which pool initiated the current callback (reentrancy safety)
    address private _activePool;

    error Unauthorized();
    error NotActivePool();
    error InsufficientProfit();
    error DeadlineExpired();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address _uniRouter, address _asset0, address _asset1) {
        owner = msg.sender;
        uniRouter = _uniRouter;
        asset0 = _asset0;
        asset1 = _asset1;

        // Pre-approve Uniswap router for both tokens (saves ~20k gas per arb)
        IERC20(_asset0).approve(_uniRouter, type(uint256).max);
        IERC20(_asset1).approve(_uniRouter, type(uint256).max);
    }

    /// @notice Execute an arbitrage against an EulerSwap pool.
    /// @param pool The EulerSwap pool address
    /// @param amount0Out Amount of asset0 to buy from pool (0 if buying asset1)
    /// @param amount1Out Amount of asset1 to buy from pool (0 if buying asset0)
    /// @param amountRequired Amount of input token the pool needs (from computeQuote)
    /// @param uniPoolFee Uniswap V3 fee tier (e.g. 500 = 0.05%)
    /// @param minProfit Minimum profit in the Uniswap output token
    /// @param deadline Block timestamp deadline
    function execute(
        address pool,
        uint256 amount0Out,
        uint256 amount1Out,
        uint256 amountRequired,
        uint24 uniPoolFee,
        uint256 minProfit,
        uint256 deadline
    ) external onlyOwner {
        if (block.timestamp > deadline) revert DeadlineExpired();

        _activePool = pool;

        bytes memory data = abi.encode(amountRequired, uniPoolFee, minProfit);

        IEulerSwapPool(pool).swap(amount0Out, amount1Out, address(this), data);

        _activePool = address(0);
    }

    /// @notice Flash-swap callback from EulerSwap.
    ///         Pool already sent us output tokens. We sell on Uniswap V3,
    ///         send the required input back to the pool, keep the profit.
    function eulerSwapCall(address, uint256 amount0, uint256 amount1, bytes calldata data) external override {
        if (msg.sender != _activePool) revert NotActivePool();

        (uint256 amountRequired, uint24 uniPoolFee, uint256 minProfit) =
            abi.decode(data, (uint256, uint24, uint256));

        address pool = msg.sender;

        if (amount1 > 0) {
            // Direction A: received asset1 (WETH), sell on Uni for asset0 (USDC)
            uint256 uniOut = ISwapRouter02(uniRouter).exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: asset1,
                    tokenOut: asset0,
                    fee: uniPoolFee,
                    recipient: address(this),
                    amountIn: amount1,
                    amountOutMinimum: amountRequired + minProfit,
                    sqrtPriceLimitX96: 0
                })
            );

            // Send exactly what the pool needs, keep the rest
            IERC20(asset0).transfer(pool, amountRequired);

            if (uniOut - amountRequired < minProfit) revert InsufficientProfit();
        } else {
            // Direction B: received asset0 (USDC), sell on Uni for asset1 (WETH)
            uint256 uniOut = ISwapRouter02(uniRouter).exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: asset0,
                    tokenOut: asset1,
                    fee: uniPoolFee,
                    recipient: address(this),
                    amountIn: amount0,
                    amountOutMinimum: amountRequired + minProfit,
                    sqrtPriceLimitX96: 0
                })
            );

            IERC20(asset1).transfer(pool, amountRequired);

            if (uniOut - amountRequired < minProfit) revert InsufficientProfit();
        }
    }

    /// @notice Withdraw accumulated profit tokens
    function withdraw(address token, uint256 amount, address to) external onlyOwner {
        IERC20(token).transfer(to, amount);
    }

    /// @notice Withdraw all of a token
    function withdrawAll(address token, address to) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).transfer(to, bal);
    }
}
