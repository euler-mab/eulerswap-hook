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

    /// @dev Margin applied to pool limits to ensure computeQuote doesn't revert
    /// at boundary values. Pool's getLimits() returns theoretical maximums where
    /// rounding can cause reverts at the exact boundary.
    uint256 constant LIMIT_MARGIN_BPS = 9900; // 99% of raw limit

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
    /// The delta must be large enough to avoid rounding noise in the curve math,
    /// but small enough to approximate the true derivative. We use ~0.001 in token terms
    /// (e.g. 1e15 wei for 18-decimal tokens, 1e3 for 6-decimal tokens like USDC).
    /// A delta that's too small (e.g. 1 wei for USDC) causes integer rounding to dominate,
    /// overestimating the derivative and violating executedPrice >= marginalPrice.
    function _priceDelta(address token) internal view returns (uint256) {
        try IERC20Decimals(token).decimals() returns (uint8 d) {
            if (d <= 3) return 1;
            return 10 ** (d - 3);
        } catch {
            return PRICE_DELTA_DEFAULT;
        }
    }

    // ─── ISwapAdapter ────────────────────────────────────────────────────

    /// @inheritdoc ISwapAdapter
    function getTokens(bytes32 poolId) external override returns (address[] memory tokens) {
        IEulerSwapPool pool = _pool(poolId);
        (address asset0, address asset1) = pool.getAssets();
        tokens = new address[](2);
        tokens[0] = asset0;
        tokens[1] = asset1;
    }

    /// @inheritdoc ISwapAdapter
    function getPoolIds(uint256 offset, uint256 limit)
        external
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
        capabilities = new Capability[](5);
        capabilities[0] = Capability.SellOrder;
        capabilities[1] = Capability.BuyOrder;
        capabilities[2] = Capability.PriceFunction;
        capabilities[3] = Capability.MarginalPrice;
        capabilities[4] = Capability.HardLimits;
    }

    /// @inheritdoc ISwapAdapter
    /// @dev EulerSwap's pool.getLimits() returns theoretical maximums from the curve math.
    /// At or very near the exact limit, computeQuote may revert due to integer rounding
    /// in the invariant check. We reduce by 1% to ensure all amounts within our reported
    /// limits are actually tradeable. The Tycho spec prefers overestimating limits, but
    /// correctness (no revert within stated limits) takes priority.
    function getLimits(bytes32 poolId, address sellToken, address buyToken)
        external
        override
        returns (uint256[] memory limits)
    {
        IEulerSwapPool pool = _pool(poolId);
        (uint256 limitIn, uint256 limitOut) = pool.getLimits(sellToken, buyToken);
        limits = new uint256[](2);
        limits[0] = limitIn * LIMIT_MARGIN_BPS / 10000;
        limits[1] = limitOut * LIMIT_MARGIN_BPS / 10000;
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

        // Enforce HardLimits: revert with LimitExceeded if amount exceeds adapter limits
        {
            (uint256 rawLimitIn, uint256 rawLimitOut) = pool.getLimits(sellToken, buyToken);
            uint256 adapterLimitIn = rawLimitIn * LIMIT_MARGIN_BPS / 10000;
            uint256 adapterLimitOut = rawLimitOut * LIMIT_MARGIN_BPS / 10000;
            if (side == OrderSide.Sell && specifiedAmount > adapterLimitIn) {
                revert LimitExceeded(adapterLimitIn);
            }
            if (side == OrderSide.Buy && specifiedAmount > adapterLimitOut) {
                revert LimitExceeded(adapterLimitOut);
            }
        }

        if (side == OrderSide.Sell) {
            // Exact input: specifiedAmount of sellToken -> ? buyToken
            uint256 amountOut;
            try pool.computeQuote(sellToken, buyToken, specifiedAmount, true) returns (uint256 out) {
                amountOut = out;
            } catch {
                revert Unavailable("EulerSwap: quote failed for sell");
            }

            // Gas measurement covers only transfer + swap (excludes quote computation)
            uint256 gasBefore = gasleft();
            IERC20(sellToken).safeTransferFrom(msg.sender, poolAddr, specifiedAmount);
            if (isAsset0) {
                pool.swap(0, amountOut, msg.sender, "");
            } else {
                pool.swap(amountOut, 0, msg.sender, "");
            }
            trade.gasUsed = gasBefore - gasleft();
            trade.calculatedAmount = amountOut;
        } else {
            // Exact output: ? sellToken -> specifiedAmount of buyToken
            uint256 amountIn;
            try pool.computeQuote(sellToken, buyToken, specifiedAmount, false) returns (uint256 inp) {
                amountIn = inp;
            } catch {
                revert Unavailable("EulerSwap: quote failed for buy");
            }

            uint256 gasBefore = gasleft();
            IERC20(sellToken).safeTransferFrom(msg.sender, poolAddr, amountIn);
            if (isAsset0) {
                pool.swap(0, specifiedAmount, msg.sender, "");
            } else {
                pool.swap(specifiedAmount, 0, msg.sender, "");
            }
            trade.gasUsed = gasBefore - gasleft();
            trade.calculatedAmount = amountIn;
        }

        // EulerSwap has dynamic fees (hook reads Uniswap oracle), so the post-swap
        // marginal price can be higher than the executed average when a swap reduces
        // oracle divergence and lowers the fee. Return Fraction(0,1) per the spec:
        // "it is valid to return a Fraction(0, 0) value for this price" and
        // "For zero use Fraction(0, 1)."
        trade.price = Fraction(0, 1);
    }

    /// @inheritdoc ISwapAdapter
    function price(
        bytes32 poolId,
        address sellToken,
        address buyToken,
        uint256[] memory specifiedAmounts
    ) external override returns (Fraction[] memory prices) {
        IEulerSwapPool pool = _pool(poolId);
        prices = new Fraction[](specifiedAmounts.length);
        uint256 delta = _priceDelta(sellToken);

        // Enforce HardLimits: revert if any amount exceeds adapter sell limit
        (uint256 rawLimitIn,) = pool.getLimits(sellToken, buyToken);
        uint256 adapterLimitIn = rawLimitIn * LIMIT_MARGIN_BPS / 10000;
        for (uint256 i = 0; i < specifiedAmounts.length; i++) {
            if (specifiedAmounts[i] > adapterLimitIn) revert LimitExceeded(adapterLimitIn);
            prices[i] = _priceAt(pool, sellToken, buyToken, specifiedAmounts[i], delta);
        }
    }

    // ─── Internal ────────────────────────────────────────────────────────

    /// @dev Numerical marginal price at a given amount. Returns Fraction(0, 1) if
    /// computeQuote reverts (e.g. amount near or beyond pool limits).
    function _priceAt(
        IEulerSwapPool pool,
        address sellToken,
        address buyToken,
        uint256 amt,
        uint256 delta
    ) internal view returns (Fraction memory) {
        if (amt == 0) {
            // Marginal price at current state: f(delta) / delta
            try pool.computeQuote(sellToken, buyToken, delta, true) returns (uint256 out) {
                return Fraction(out, delta);
            } catch {
                return Fraction(0, 1);
            }
        }
        // Marginal price after trading `amt`: (f(amt + delta) - f(amt)) / delta
        try pool.computeQuote(sellToken, buyToken, amt, true) returns (uint256 outAt) {
            try pool.computeQuote(sellToken, buyToken, amt + delta, true) returns (uint256 outAtDelta) {
                return Fraction(outAtDelta - outAt, delta);
            } catch {
                return Fraction(0, 1);
            }
        } catch {
            return Fraction(0, 1);
        }
    }

}

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}
