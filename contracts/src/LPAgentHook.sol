// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IEulerSwapHookTarget, EULER_SWAP_HOOK_GET_FEE} from
    "../eulerswap/src/interfaces/IEulerSwapHookTarget.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {FullMath} from "../eulerswap/src/math/FullMath.sol";

interface IUniswapV3Pool {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    function token0() external view returns (address);
}

/// @title LPAgentHook — Dynamic fee hook for autonomous LP management
/// @notice Implements getFee for EulerSwap.
///         Reads Uniswap V3 spot price, computes mismatch vs pool marginal price,
///         elevates fee on the arb direction to capture LVR. Counter-direction pays baseFee.
///         Owner can update fee parameters; agent EOA updates via owner calls.
contract LPAgentHook is IEulerSwapHookTarget {
    using FullMath for uint256;

    // --- Constants ---
    uint256 constant WAD = 1e18;
    uint256 constant BPS = 1e14; // 1 basis point in WAD terms (1e14 / 1e18 = 0.01%)
    uint256 constant Q192 = 2 ** 192;
    uint256 constant Q128 = 2 ** 128;
    uint256 constant Q64 = 2 ** 64;

    // --- Immutables ---
    address public immutable pool;
    address public immutable owner;
    address public immutable supplyVault0;
    address public immutable supplyVault1;
    address public immutable asset0;
    address public immutable asset1;
    address public immutable uniswapPool;
    bool public immutable uniswapToken0IsAsset0;

    // --- Fee parameters (owner-updatable) ---
    uint64 public baseFee; // base fee in WAD (e.g. 5e14 = 5bps)
    uint64 public maxFee; // maximum fee cap
    uint256 public mismatchScale; // fraction of mismatch to capture (WAD-scaled, e.g. 0.8e18 = 80%)

    // --- Events ---
    event FeeParamsUpdated(uint64 baseFee, uint64 maxFee, uint256 mismatchScale);

    // --- Errors ---
    error Unauthorized();
    error OnlyPool();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyPool() {
        if (msg.sender != pool) revert OnlyPool();
        _;
    }

    constructor(
        address _pool,
        address _owner,
        address _uniswapPool,
        uint64 _baseFee,
        uint64 _maxFee,
        uint256 _mismatchScale
    ) {
        pool = _pool;
        owner = _owner;
        uniswapPool = _uniswapPool;
        baseFee = _baseFee;
        maxFee = _maxFee;
        mismatchScale = _mismatchScale;

        // Cache vault and asset addresses from pool's static params
        IEulerSwap.StaticParams memory sParams = IEulerSwap(_pool).getStaticParams();
        supplyVault0 = sParams.supplyVault0;
        supplyVault1 = sParams.supplyVault1;
        asset0 = IEVault(sParams.supplyVault0).asset();
        asset1 = IEVault(sParams.supplyVault1).asset();

        // Determine whether Uniswap token ordering matches ours
        uniswapToken0IsAsset0 = IUniswapV3Pool(_uniswapPool).token0() == asset0;
    }

    // --- IEulerSwapHookTarget ---

    /// @notice Not used — we don't hook beforeSwap
    function beforeSwap(uint256, uint256, address, address) external pure override {
        revert("not implemented");
    }

    /// @notice Dynamic fee using Uniswap V3 spot price as market reference.
    ///
    /// When mismatchScale > 0: reads Uniswap V3 slot0 to get current market price,
    /// compares to the EulerSwap curve's marginal price, and elevates the fee on the
    /// arb direction (the side that exploits the mismatch). The counter-direction pays
    /// baseFee — never less. This captures LVR without penalizing retail flow.
    ///
    /// Set mismatchScale = 0 to disable and use flat baseFee for all swaps.
    ///
    /// @param asset0IsInput True if asset0 is being sent to the pool
    /// @param reserve0 Current reserve of asset0
    /// @param reserve1 Current reserve of asset1
    /// @return fee The fee to charge for this swap direction (WAD-scaled uint64)
    function getFee(bool asset0IsInput, uint112 reserve0, uint112 reserve1, bool)
        external
        view
        override
        returns (uint64 fee)
    {
        uint256 computedFee = uint256(baseFee);

        // --- Uniswap mismatch (directional fee elevation) ---
        // Reads Uniswap V3 slot0 for current market price. If our pool's marginal price
        // diverges, elevate the fee on the arb direction. The opposite direction is unaffected.
        // Gas: ~500 warm (arb txs that already touched Uniswap), ~5000 cold (retail).
        if (mismatchScale > 0) {
            uint256 uniPrice = _getUniswapPrice();
            if (uniPrice > 0) {
                uint256 marginalPrice = _getMarginalPrice(reserve0, reserve1);

                uint256 mismatch;
                bool isArbDirection;

                if (uniPrice > marginalPrice) {
                    // Pool underprices asset0 → arb buys asset0 from us (asset0 out)
                    mismatch = ((uniPrice - marginalPrice) * WAD) / uniPrice;
                    isArbDirection = !asset0IsInput;
                } else {
                    // Pool overprices asset0 → arb sells asset0 to us (asset0 in)
                    mismatch = ((marginalPrice - uniPrice) * WAD) / uniPrice;
                    isArbDirection = asset0IsInput;
                }

                // Only elevate on arb direction; counter-direction stays at baseFee
                if (isArbDirection) {
                    computedFee += (mismatchScale * mismatch) / WAD;
                }
            }
        }

        // Clamp to [baseFee, maxFee] — baseFee is the true floor
        if (computedFee > uint256(maxFee)) computedFee = uint256(maxFee);

        fee = uint64(computedFee);
    }

    /// @notice Not used — swap data available via pool's Swap event
    function afterSwap(uint256, uint256, uint256, uint256, uint256, uint256, address, address, uint112, uint112)
        external
        pure
        override
    {
        revert("not implemented");
    }

    // --- Owner management ---

    function setFeeParams(uint64 _baseFee, uint64 _maxFee, uint256 _mismatchScale) external onlyOwner {
        require(_baseFee <= _maxFee, "invalid fee ordering");
        require(_maxFee < uint64(WAD), "max fee >= 100%");

        baseFee = _baseFee;
        maxFee = _maxFee;
        mismatchScale = _mismatchScale;

        emit FeeParamsUpdated(_baseFee, _maxFee, _mismatchScale);
    }

    // --- Internal ---

    /// @notice Read Uniswap V3 spot price from slot0.
    /// @return WAD-scaled price (raw asset1 per raw asset0), or 0 on failure.
    function _getUniswapPrice() internal view returns (uint256) {
        // slot0 read: ~500 gas warm (arb txs), ~5000 gas cold (retail)
        try IUniswapV3Pool(uniswapPool).slot0() returns (
            uint160 sqrtPriceX96, int24, uint16, uint16, uint16, uint8, bool
        ) {
            if (sqrtPriceX96 == 0) return 0;

            uint256 sqrtPrice = uint256(sqrtPriceX96);

            // price = sqrtPriceX96^2 / 2^192 (Uniswap token1 per token0, raw units)
            // WAD-scaled: priceWad = sqrtPriceX96^2 * WAD / 2^192
            uint256 priceWad;
            if (sqrtPrice <= type(uint128).max) {
                priceWad = (sqrtPrice * sqrtPrice).mulDiv(WAD, Q192);
            } else {
                priceWad = sqrtPrice.mulDiv(sqrtPrice, Q64).mulDiv(WAD, Q128);
            }

            // If Uniswap token0 != our asset0, invert to get asset1/asset0
            if (!uniswapToken0IsAsset0) {
                if (priceWad == 0) return 0;
                priceWad = WAD.mulDiv(WAD, priceWad);
            }

            return priceWad;
        } catch {
            return 0; // Uniswap read failed — fall back to baseFee
        }
    }

    /// @notice Compute the true marginal price from the EulerSwap curve derivative.
    /// @dev For c=0: Branch 1 (x <= x0): |dy/dx| = px * x0^2 / (py * x^2)
    ///              Branch 2 (x > x0):  |dy/dx| = px * y^2 / (py * y0^2)
    ///      Uses FullMath.mulDiv for overflow-safe 512-bit intermediates.
    /// @return WAD-scaled marginal price (raw asset1 per raw asset0)
    function _getMarginalPrice(uint112 reserve0, uint112 reserve1) internal view returns (uint256) {
        IEulerSwap.DynamicParams memory d = IEulerSwap(pool).getDynamicParams();
        uint256 px = uint256(d.priceX);
        uint256 py = uint256(d.priceY);
        uint256 x0 = uint256(d.equilibriumReserve0);
        uint256 y0 = uint256(d.equilibriumReserve1);

        if (reserve0 == 0 || py == 0) return 0;

        if (uint256(reserve0) <= x0) {
            // Branch 1: marginal = px * x0^2 * WAD / (py * reserve0^2)
            uint256 step1 = px.mulDiv(x0, py);
            uint256 r0 = uint256(reserve0);
            return step1.mulDiv(x0 * WAD, r0 * r0);
        } else {
            // Branch 2: marginal = px * reserve1^2 * WAD / (py * y0^2)
            if (y0 == 0) return 0;
            uint256 r1 = uint256(reserve1);
            uint256 step1 = px.mulDiv(r1, py);
            return step1.mulDiv(r1 * WAD, y0 * y0);
        }
    }

    // --- View helpers for agent ---

    function getFeeParams()
        external
        view
        returns (uint64 _baseFee, uint64 _maxFee, uint256 _mismatchScale)
    {
        return (baseFee, maxFee, mismatchScale);
    }
}
