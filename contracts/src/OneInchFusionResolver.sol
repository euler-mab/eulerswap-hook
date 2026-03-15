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
    function getLimits() external view returns (uint256 limit0, uint256 limit1);
    function getAssets() external view returns (address asset0, address asset1);
}

/// @dev Minimal Order struct matching 1inch Limit Order Protocol V4.
///      Uses uint256 for Address/MakerTraits types (they're uint256-sized in the ABI).
struct LimitOrder {
    uint256 salt;
    uint256 maker;
    uint256 receiver;
    uint256 makerAsset;
    uint256 takerAsset;
    uint256 makingAmount;
    uint256 takingAmount;
    uint256 makerTraits;
}

/// @title OneInchFusionResolver
/// @notice Resolver contract for filling 1inch Fusion orders via EulerSwap.
/// @dev Implements ITakerInteraction. When the Limit Order Protocol calls takerInteraction,
///      this contract swaps received maker tokens through EulerSwap to source taker tokens.
///      The LOP then pulls taker tokens from this contract via transferFrom.
///
///      Fill flow:
///        1. Owner calls settleOrders(data) → forwards to LOP
///        2. LOP transfers maker tokens to this contract (the taker)
///        3. LOP calls takerInteraction() → we swap on EulerSwap
///        4. LOP calls transferFrom to pull taker tokens from this contract
///
///      Pool address and minProfit are passed via takerInteraction extraData,
///      making the contract reusable across pools without redeployment.
contract OneInchFusionResolver {
    using SafeERC20 for IERC20;

    address public immutable owner;
    address public immutable limitOrderProtocol;

    error Unauthorized();
    error OnlyLOP();
    error NotTaker();
    error AssetMismatch();
    error ZeroOutput();
    error InsufficientProfit();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address _limitOrderProtocol) {
        owner = msg.sender;
        limitOrderProtocol = _limitOrderProtocol;
    }

    /// @notice Approve a token to the LOP so it can pull taker tokens via transferFrom.
    ///         Call once per token before filling.
    function approveToken(address token, address spender) external onlyOwner {
        IERC20(token).forceApprove(spender, type(uint256).max);
    }

    /// @notice Forward raw fill calldata to the Limit Order Protocol.
    /// @dev The data should encode a call to fillOrderArgs or similar LOP fill function.
    ///      Constructed off-chain using the 1inch Fusion SDK.
    function settleOrders(bytes calldata data) external onlyOwner {
        (bool success,) = limitOrderProtocol.call(data);
        if (!success) {
            // Bubble up revert reason from LOP
            assembly {
                let size := returndatasize()
                let ptr := mload(0x40)
                returndatacopy(ptr, 0, size)
                revert(ptr, size)
            }
        }
    }

    /// @notice Called by the LOP during order filling.
    /// @dev Execution order: preInteraction → maker→taker transfer → takerInteraction → taker→maker transfer → postInteraction.
    ///      At this point, maker tokens are already in this contract. We swap them on EulerSwap
    ///      to produce taker tokens. The LOP will then pull taker tokens via transferFrom.
    /// @param taker Must be this contract (we are the taker)
    /// @param makingAmount Amount of maker tokens transferred to us
    /// @param takingAmount Amount of taker tokens the LOP will pull from us
    /// @param extraData ABI-encoded (address pool, address makerAsset, address takerAsset, uint256 minProfit)
    function takerInteraction(
        LimitOrder calldata, /* order */
        bytes calldata, /* extension */
        bytes32, /* orderHash */
        address taker,
        uint256 makingAmount,
        uint256 takingAmount,
        uint256, /* remainingMakingAmount */
        bytes calldata extraData
    ) external {
        if (msg.sender != limitOrderProtocol) revert OnlyLOP();
        if (taker != address(this)) revert NotTaker();

        (address pool, address makerAsset, address takerAsset, uint256 minProfit) =
            abi.decode(extraData, (address, address, address, uint256));

        // Validate that makerAsset and takerAsset match the pool's actual assets
        // Prevents misconfigured bot from sending tokens to wrong pool
        {
            (address poolAsset0, address poolAsset1) = IEulerSwapPool(pool).getAssets();
            bool validPair = (makerAsset == poolAsset0 && takerAsset == poolAsset1)
                || (makerAsset == poolAsset1 && takerAsset == poolAsset0);
            if (!validPair) revert AssetMismatch();
        }

        // makerAsset = what we received (input to EulerSwap)
        // takerAsset = what we need to produce (output from EulerSwap)
        uint256 amountOut = IEulerSwapPool(pool).computeQuote(makerAsset, takerAsset, makingAmount, true);
        if (amountOut == 0) revert ZeroOutput();

        // Track pre-swap balance for accurate profit check
        uint256 balBefore = IERC20(takerAsset).balanceOf(address(this));

        // Transfer maker tokens to EulerSwap pool
        IERC20(makerAsset).safeTransfer(pool, makingAmount);

        // Execute swap
        if (makerAsset < takerAsset) {
            IEulerSwapPool(pool).swap(0, amountOut, address(this), "");
        } else {
            IEulerSwapPool(pool).swap(amountOut, 0, address(this), "");
        }

        // Verify we got enough: takingAmount (what LOP will pull) + minProfit
        uint256 received = IERC20(takerAsset).balanceOf(address(this)) - balBefore;
        if (received < takingAmount + minProfit) revert InsufficientProfit();

        // LOP will now call transferFrom to pull takingAmount of takerAsset.
        // Any excess stays in this contract as profit.
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

    /// @notice Withdraw native ETH (e.g. from WETH unwrapping)
    function withdrawETH(uint256 amount, address payable to) external onlyOwner {
        (bool success,) = to.call{value: amount}("");
        require(success);
    }

    /// @notice Allow receiving ETH (for WETH unwrapping if needed)
    receive() external payable {}
}
