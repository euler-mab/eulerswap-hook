//! Contract ABI bindings for EulerSwap pool, registry, and hook interfaces.
//!
//! Uses alloy's `sol!` macro for compile-time ABI generation.

use alloy::sol;

sol! {
    /// EulerSwap pool interface — swap, quote, and state queries.
    #[sol(rpc)]
    interface IEulerSwap {
        struct DynamicParams {
            uint112 equilibriumReserve0;
            uint112 equilibriumReserve1;
            uint112 minReserve0;
            uint112 minReserve1;
            uint80 priceX;
            uint80 priceY;
            uint64 concentrationX;
            uint64 concentrationY;
            uint64 fee0;
            uint64 fee1;
            uint40 expiration;
            uint8 swapHookedOperations;
            address swapHook;
        }

        struct StaticParams {
            address supplyVault0;
            address supplyVault1;
            address borrowVault0;
            address borrowVault1;
            address eulerAccount;
            address feeRecipient;
        }

        struct InitialState {
            uint112 reserve0;
            uint112 reserve1;
        }

        function getAssets() external view returns (address asset0, address asset1);
        function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 status);
        function getDynamicParams() external view returns (DynamicParams);
        function getStaticParams() external view returns (StaticParams);
        function getLimits(address tokenIn, address tokenOut) external view returns (uint256 limitIn, uint256 limitOut);
        function computeQuote(address tokenIn, address tokenOut, uint256 amount, bool exactIn) external view returns (uint256);
        function isInstalled() external view returns (bool installed);
        function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    }

    /// EulerSwap registry — pool discovery and enumeration.
    #[sol(rpc)]
    interface IEulerSwapRegistry {
        function poolsLength() external view returns (uint256);
        function poolsSlice(uint256 start, uint256 end) external view returns (address[]);
        function pools() external view returns (address[]);
        function poolsByPair(address asset0, address asset1) external view returns (address[]);
        function poolsByPairLength(address asset0, address asset1) external view returns (uint256);
        function poolByEulerAccount(address who) external view returns (address);
    }

    /// EulerSwap hook interface — dynamic fee queries (for Phase 2 reference).
    #[sol(rpc)]
    interface IEulerSwapHookTarget {
        function getFee(bool asset0IsInput, uint112 reserve0, uint112 reserve1, bool readOnly) external returns (uint64 fee);
    }

    /// ERC20 transfer for settlement encoding.
    #[sol(rpc)]
    interface IERC20 {
        function transfer(address to, uint256 amount) external returns (bool);
    }
}
