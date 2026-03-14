// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.13;

import {ISwapAdapter} from "src/interfaces/ISwapAdapter.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Minimal interface for EulerSwap pool contracts. Each pool is a standalone
/// contract with a Uniswap V2-style swap interface (optimistic output transfer,
/// then verify input). See: https://github.com/euler-xyz/euler-swap
interface IEulerSwapPool {
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function computeQuote(address tokenIn, address tokenOut, uint256 amount, bool exactIn)
        external
        view
        returns (uint256);
    function getLimits(address tokenIn, address tokenOut) external view returns (uint256 limitIn, uint256 limitOut);
    function getAssets() external view returns (address asset0, address asset1);
}

/// @dev EulerSwap pool registry — tracks all deployed pools on-chain.
/// Mainnet: 0x5FcCB84363F020c0cADE052C9c654aABF932814A
interface IEulerSwapRegistry {
    function poolsSlice(uint256 start, uint256 end) external view returns (address[] memory);
    function poolsLength() external view returns (uint256);
}

/// @title EulerSwap Adapter for Tycho Protocol SDK
/// @notice Implements ISwapAdapter to enable Propeller solvers to route through EulerSwap pools.
/// @dev Uses EulerSwap's direct Uni V2-style interface (swap, computeQuote, getLimits) rather
/// than routing through Uniswap V4 PoolManager, saving gas and reducing complexity.
///
/// Pool IDs are bytes32(bytes20(poolAddress)) — each EulerSwap pool is a separate contract.
///
/// EulerSwap swap flow (Uni V2 pattern):
///   1. Transfer input tokens directly to the pool contract
///   2. Call pool.swap(amount0Out, amount1Out, recipient, "")
///   3. Pool sends output tokens to recipient, then verifies curve invariant
///
/// Note on hooks: EulerSwap pools may have dynamic fee hooks (e.g. V7 hook reads a Uniswap
/// oracle). The computeQuote view function staticcalls the hook — if Tycho's VM doesn't index
/// the hook contract and its dependencies, computeQuote will revert. Ensure the substreams
/// indexer captures hook contract storage.
contract EulerSwapAdapter is ISwapAdapter {
    using SafeERC20 for IERC20;

    IEulerSwapRegistry public immutable registry;

    /// @dev Fallback delta for numerical price derivative if decimals() call fails.
    uint256 constant PRICE_DELTA_DEFAULT = 1e6;

    constructor(address registry_) {
        registry = IEulerSwapRegistry(registry_);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────

    function _pool(bytes32 poolId) internal pure returns (IEulerSwapPool) {
        return IEulerSwapPool(address(bytes20(poolId)));
    }

    function _sellIsAsset0(IEulerSwapPool pool, address sellToken) internal view returns (bool) {
        (address asset0,) = pool.getAssets();
        return sellToken == asset0;
    }

    /// @dev Picks a small delta for the numerical price derivative based on token decimals.
    /// The delta must be large enough to avoid rounding to zero in the curve math,
    /// but small enough to approximate the true derivative. We use ~1e-6 in token terms
    /// (e.g. 1e12 wei for 18-decimal tokens, 1 for 6-decimal tokens like USDC).
    function _priceDelta(address token) internal view returns (uint256) {
        try IERC20Decimals(token).decimals() returns (uint8 d) {
            if (d <= 6) return 1;
            return 10 ** (d - 6);
        } catch {
            return PRICE_DELTA_DEFAULT;
        }
    }

    // ─── ISwapAdapter ────────────────────────────────────────────────────

    /// @inheritdoc ISwapAdapter
    function getTokens(bytes32 poolId) external view override returns (address[] memory tokens) {
        IEulerSwapPool pool = _pool(poolId);
        (address asset0, address asset1) = pool.getAssets();
        tokens = new address[](2);
        tokens[0] = asset0;
        tokens[1] = asset1;
    }

    /// @inheritdoc ISwapAdapter
    function getPoolIds(uint256 offset, uint256 limit)
        external
        view
        override
        returns (bytes32[] memory ids)
    {
        uint256 total = registry.poolsLength();
        if (offset >= total) {
            return new bytes32[](0);
        }

        uint256 end = offset + limit;
        if (end > total) end = total;

        address[] memory poolAddrs = registry.poolsSlice(offset, end);
        ids = new bytes32[](poolAddrs.length);
        for (uint256 i = 0; i < poolAddrs.length; i++) {
            ids[i] = bytes32(bytes20(poolAddrs[i]));
        }
    }

    /// @inheritdoc ISwapAdapter
    function getCapabilities(bytes32, address, address)
        external
        pure
        override
        returns (Capability[] memory capabilities)
    {
        capabilities = new Capability[](4);
        capabilities[0] = Capability.SellOrder;
        capabilities[1] = Capability.BuyOrder;
        capabilities[2] = Capability.PriceFunction;
        capabilities[3] = Capability.MarginalPrice;
    }

    /// @inheritdoc ISwapAdapter
    function getLimits(bytes32 poolId, address sellToken, address buyToken)
        external
        view
        override
        returns (uint256[] memory limits)
    {
        IEulerSwapPool pool = _pool(poolId);
        (uint256 limitIn, uint256 limitOut) = pool.getLimits(sellToken, buyToken);
        limits = new uint256[](2);
        limits[0] = limitIn;
        limits[1] = limitOut;
    }

    /// @inheritdoc ISwapAdapter
    function swap(
        bytes32 poolId,
        address sellToken,
        address buyToken,
        OrderSide side,
        uint256 specifiedAmount
    ) external override returns (Trade memory trade) {
        if (specifiedAmount == 0) return trade;

        IEulerSwapPool pool = _pool(poolId);
        address poolAddr = address(bytes20(poolId));
        bool isAsset0 = _sellIsAsset0(pool, sellToken);

        uint256 gasBefore = gasleft();

        if (side == OrderSide.Sell) {
            // Exact input: specifiedAmount of sellToken -> ? buyToken
            uint256 amountOut = pool.computeQuote(sellToken, buyToken, specifiedAmount, true);

            // Transfer sell tokens directly to the pool (Uni V2 pattern)
            IERC20(sellToken).safeTransferFrom(msg.sender, poolAddr, specifiedAmount);

            // Execute swap — output goes to msg.sender
            if (isAsset0) {
                pool.swap(0, amountOut, msg.sender, "");
            } else {
                pool.swap(amountOut, 0, msg.sender, "");
            }

            trade.calculatedAmount = amountOut;
        } else {
            // Exact output: ? sellToken -> specifiedAmount of buyToken
            uint256 amountIn = pool.computeQuote(sellToken, buyToken, specifiedAmount, false);

            // Transfer required input to the pool
            IERC20(sellToken).safeTransferFrom(msg.sender, poolAddr, amountIn);

            // Execute swap
            if (isAsset0) {
                pool.swap(0, specifiedAmount, msg.sender, "");
            } else {
                pool.swap(specifiedAmount, 0, msg.sender, "");
            }

            trade.calculatedAmount = amountIn;
        }

        trade.gasUsed = gasBefore - gasleft();
        trade.price = _marginalPrice(pool, sellToken, buyToken);
    }

    /// @inheritdoc ISwapAdapter
    function price(
        bytes32 poolId,
        address sellToken,
        address buyToken,
        uint256[] memory specifiedAmounts
    ) external view override returns (Fraction[] memory prices) {
        IEulerSwapPool pool = _pool(poolId);
        prices = new Fraction[](specifiedAmounts.length);
        uint256 delta = _priceDelta(sellToken);

        for (uint256 i = 0; i < specifiedAmounts.length; i++) {
            uint256 amt = specifiedAmounts[i];

            if (amt == 0) {
                // Marginal price at current state
                uint256 out = pool.computeQuote(sellToken, buyToken, delta, true);
                prices[i] = Fraction(out, delta);
            } else {
                // Marginal price after trading `amt`:
                // f'(amt) ≈ (f(amt + delta) - f(amt)) / delta
                uint256 outAt = pool.computeQuote(sellToken, buyToken, amt, true);
                uint256 outAtDelta = pool.computeQuote(sellToken, buyToken, amt + delta, true);
                prices[i] = Fraction(outAtDelta - outAt, delta);
            }
        }
    }

    // ─── Internal ────────────────────────────────────────────────────────

    /// @dev Computes the marginal price at the current pool state using a numerical
    /// derivative: price ≈ computeQuote(delta) / delta for a small delta.
    function _marginalPrice(IEulerSwapPool pool, address sellToken, address buyToken)
        internal
        view
        returns (Fraction memory)
    {
        uint256 delta = _priceDelta(sellToken);
        uint256 out = pool.computeQuote(sellToken, buyToken, delta, true);
        return Fraction(out, delta);
    }
}

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}
