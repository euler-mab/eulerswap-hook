// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IEulerSwapHookTarget, EULER_SWAP_HOOK_GET_FEE, EULER_SWAP_HOOK_AFTER_SWAP} from
    "../eulerswap/src/interfaces/IEulerSwapHookTarget.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {FullMath} from "../eulerswap/src/math/FullMath.sol";
import {Sqrt} from "../eulerswap/src/math/Sqrt.sol";

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

/// @title LPAgentHookV3 — Dynamic fee hook with exposure-based rebalancing auction
/// @notice Replaces V2's absolute reserve thresholds with exposure relative to NAV.
///         Target: 100% USDC deposits. Any directional exposure (ETH-long or ETH-short)
///         triggers a rebalancing auction that returns the pool to neutral.
///         Mode 2 (normal): mismatch-based fees via Uniswap V3 spot price.
///         Mode 1 (auction): afterSwap reconfigures off-market, getFee returns
///         time-decaying fee for the asset-attracting direction.
contract LPAgentHookV3 is IEulerSwapHookTarget {
    using FullMath for uint256;
    using Sqrt for uint256;

    // --- Constants ---
    uint256 constant WAD = 1e18;
    uint256 constant BPS = 1e14;
    uint256 constant Q192 = 2 ** 192;
    uint256 constant Q128 = 2 ** 128;
    uint256 constant Q64 = 2 ** 64;

    /// @notice 5% price range boundary factor: 1 - 1/sqrt(1.05) ≈ 0.0241
    /// minReserve = reserve * BOUNDARY_FACTOR / WAD
    uint256 constant BOUNDARY_FACTOR = 0.9759e18;

    // --- Immutables ---
    address public immutable pool;
    address public immutable owner;
    address public immutable supplyVault0;
    address public immutable supplyVault1;
    address public immutable asset0;
    address public immutable asset1;
    address public immutable uniswapPool;
    bool public immutable uniswapToken0IsAsset0;

    // --- Fee parameters (Mode 2, owner-updatable) ---
    uint64 public baseFee;
    uint64 public maxFee;
    uint64 public gasCoeff;
    uint64 public externalFee;
    uint256 public captureRate;
    uint256 public attractRate;

    // --- Auction state (Mode 1) ---
    bool public auctionActive;
    uint40 public auctionStart;
    bool public auctionAttractAsset1; // true = want asset1 in, false = want asset0 in

    // --- Auction config (owner-updatable) ---
    uint112 public nav;          // LP real equity in asset0 (USDC) terms
    uint64 public triggerBps;    // exposure threshold (BPS of NAV), e.g. 5000 = 50%
    uint64 public auctionDelta;       // WAD: off-market price shift (e.g. 100e14 = 100bps)
    uint64 public auctionStartFee;    // WAD: starting fee for decay (must be < WAD)
    uint64 public auctionDecayPerSecond; // WAD: fee decay per second

    // --- Pre-auction snapshot ---
    uint80 private preAuctionPriceY;
    uint112 private preAuctionEq0;  // neutral eq before drift (clearing target)
    uint112 private preAuctionEq1;

    // --- Events ---
    event FeeParamsUpdated(
        uint64 baseFee, uint64 maxFee, uint64 gasCoeff, uint64 externalFee, uint256 captureRate, uint256 attractRate
    );
    event AuctionParamsUpdated(uint112 nav, uint64 triggerBps, uint64 delta, uint64 startFee, uint64 decayPerSecond);
    event AuctionTriggered(bool attractAsset1, uint112 reserve0, uint112 reserve1);
    event AuctionCleared(uint112 reserve0, uint112 reserve1);

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
        uint64 _gasCoeff,
        uint64 _externalFee,
        uint256 _captureRate,
        uint256 _attractRate
    ) {
        pool = _pool;
        owner = _owner;
        uniswapPool = _uniswapPool;
        baseFee = _baseFee;
        maxFee = _maxFee;
        gasCoeff = _gasCoeff;
        externalFee = _externalFee;
        captureRate = _captureRate;
        attractRate = _attractRate;

        IEulerSwap.StaticParams memory sParams = IEulerSwap(_pool).getStaticParams();
        supplyVault0 = sParams.supplyVault0;
        supplyVault1 = sParams.supplyVault1;
        asset0 = IEVault(sParams.supplyVault0).asset();
        asset1 = IEVault(sParams.supplyVault1).asset();

        uniswapToken0IsAsset0 = IUniswapV3Pool(_uniswapPool).token0() == asset0;
    }

    // --- IEulerSwapHookTarget ---

    /// @notice Not used — we don't hook beforeSwap
    function beforeSwap(uint256, uint256, address, address) external pure override {
        revert("not implemented");
    }

    /// @notice Dynamic fee with auction override.
    /// In auction mode: time-decaying fee for asset-attracting direction, maxFee for other.
    /// In normal mode: mismatch-based fee using Uniswap V3 spot price.
    function getFee(bool asset0IsInput, uint112 reserve0, uint112 reserve1, bool)
        external
        view
        override
        returns (uint64 fee)
    {
        // --- Auction mode: override normal fee logic ---
        if (auctionActive) {
            bool isAttractDirection = (auctionAttractAsset1 != asset0IsInput);
            if (isAttractDirection) {
                uint256 elapsed = block.timestamp - uint256(auctionStart);
                uint256 decay = uint256(auctionDecayPerSecond) * elapsed;
                uint256 aFee = uint256(auctionStartFee);
                if (aFee > decay) {
                    return uint64(aFee - decay);
                }
                return 0;
            } else {
                return uint64(maxFee);
            }
        }

        // --- Normal Mode 2 logic ---
        uint256 computedFee = uint256(baseFee);

        uint256 _captureRate = captureRate;
        uint256 _attractRate = attractRate;

        if (_captureRate > 0 || _attractRate > 0) {
            uint256 uniPrice = _getUniswapPrice();
            if (uniPrice > 0) {
                uint256 marginalPrice = _getMarginalPrice(reserve0, reserve1);

                uint256 mismatch;
                bool isArbDirection;

                if (uniPrice > marginalPrice) {
                    mismatch = ((uniPrice - marginalPrice) * WAD) / uniPrice;
                    isArbDirection = !asset0IsInput;
                } else {
                    mismatch = ((marginalPrice - uniPrice) * WAD) / uniPrice;
                    isArbDirection = asset0IsInput;
                }

                uint256 effectiveThreshold = uint256(gasCoeff) * tx.gasprice.sqrt();

                if (isArbDirection && _captureRate > 0) {
                    uint256 totalCost = effectiveThreshold + uint256(baseFee) + uint256(externalFee);
                    if (mismatch > totalCost) {
                        uint256 netEdge = mismatch - totalCost;
                        computedFee += (_captureRate * netEdge) / WAD;
                    }
                } else if (!isArbDirection && _attractRate > 0) {
                    if (mismatch > effectiveThreshold) {
                        uint256 excess = mismatch - effectiveThreshold;
                        computedFee += (_attractRate * excess) / WAD;
                    }
                }
            }
        }

        if (computedFee > uint256(maxFee)) computedFee = uint256(maxFee);

        fee = uint64(computedFee);
    }

    /// @notice afterSwap: exposure-based rebalancing auction.
    /// Measures reserve deviation from equilibrium as a fraction of NAV.
    /// Triggers when exposure exceeds triggerBps% of NAV.
    /// Clears when the attracted reserve returns to equilibrium.
    function afterSwap(
        uint256,
        uint256,
        uint256,
        uint256,
        uint256,
        uint256,
        address,
        address,
        uint112 reserve0,
        uint112 reserve1
    ) external override onlyPool {
        // Skip if auction params not configured
        if (nav == 0 || triggerBps == 0) return;

        if (auctionActive) {
            _checkAuctionClear(reserve0, reserve1);
            return;
        }

        // Measure exposure relative to equilibrium
        IEulerSwap.DynamicParams memory dp = IEulerSwap(pool).getDynamicParams();
        uint256 eq0 = uint256(dp.equilibriumReserve0);
        uint256 eq1 = uint256(dp.equilibriumReserve1);

        uint256 exposure;
        bool attractAsset1;

        if (uint256(reserve0) < eq0) {
            // ETH-long: USDC outflow → attract asset0 (USDC) back
            exposure = eq0 - uint256(reserve0);
            attractAsset1 = false;
        } else if (uint256(reserve1) < eq1) {
            // ETH-short: WETH outflow → attract asset1 (WETH) back
            // Convert WETH exposure to asset0 (USDC) terms
            exposure = (eq1 - uint256(reserve1)) * uint256(dp.priceX) / uint256(dp.priceY);
            attractAsset1 = true;
        } else {
            // Both reserves at or above eq → no exposure
            return;
        }

        // Trigger when exposure exceeds threshold % of NAV
        if (exposure > uint256(nav) * uint256(triggerBps) / 10000) {
            _triggerAuction(reserve0, reserve1, attractAsset1);
        }
    }

    // --- Owner management ---

    function setFeeParams(
        uint64 _baseFee,
        uint64 _maxFee,
        uint64 _gasCoeff,
        uint64 _externalFee,
        uint256 _captureRate,
        uint256 _attractRate
    ) external onlyOwner {
        require(_baseFee <= _maxFee, "invalid fee ordering");
        require(_maxFee < uint64(WAD), "max fee >= 100%");

        baseFee = _baseFee;
        maxFee = _maxFee;
        gasCoeff = _gasCoeff;
        externalFee = _externalFee;
        captureRate = _captureRate;
        attractRate = _attractRate;

        emit FeeParamsUpdated(_baseFee, _maxFee, _gasCoeff, _externalFee, _captureRate, _attractRate);
    }

    function setAuctionParams(
        uint112 _nav,
        uint64 _triggerBps,
        uint64 _delta,
        uint64 _startFee,
        uint64 _decayPerSecond
    ) external onlyOwner {
        require(_startFee < uint64(WAD), "startFee >= 100%");
        require(_triggerBps <= 10000, "triggerBps > 100%");

        nav = _nav;
        triggerBps = _triggerBps;
        auctionDelta = _delta;
        auctionStartFee = _startFee;
        auctionDecayPerSecond = _decayPerSecond;

        emit AuctionParamsUpdated(_nav, _triggerBps, _delta, _startFee, _decayPerSecond);
    }

    /// @notice Emergency: clear the auction state without reconfiguring the pool.
    /// Owner (agent) can use this to abort an auction and handle exposure manually.
    function clearAuction() external onlyOwner {
        auctionActive = false;
    }

    // --- View helpers ---

    function getFeeParams()
        external
        view
        returns (
            uint64 _baseFee,
            uint64 _maxFee,
            uint64 _gasCoeff,
            uint64 _externalFee,
            uint256 _captureRate,
            uint256 _attractRate
        )
    {
        return (baseFee, maxFee, gasCoeff, externalFee, captureRate, attractRate);
    }

    function getAuctionState()
        external
        view
        returns (bool active, uint40 start, bool attractAsset1, uint112 _nav, uint64 _triggerBps)
    {
        return (auctionActive, auctionStart, auctionAttractAsset1, nav, triggerBps);
    }

    // --- Internal ---

    function _checkAuctionClear(uint112 reserve0, uint112 reserve1) internal {
        bool cleared;
        if (auctionAttractAsset1) {
            // Was attracting asset1 → clear when reserve1 returns to pre-drift eq1
            cleared = reserve1 >= preAuctionEq1;
        } else {
            // Was attracting asset0 → clear when reserve0 returns to pre-drift eq0
            cleared = reserve0 >= preAuctionEq0;
        }
        if (cleared) {
            auctionActive = false;
            _restorePreAuctionParams(reserve0, reserve1);
            emit AuctionCleared(reserve0, reserve1);
        }
    }

    function _triggerAuction(uint112 reserve0, uint112 reserve1, bool attractAsset1) internal {
        IEulerSwap.DynamicParams memory dp = IEulerSwap(pool).getDynamicParams();

        // Snapshot pre-drift state for clearing and restoration
        preAuctionPriceY = dp.priceY;
        preAuctionEq0 = dp.equilibriumReserve0;  // neutral eq (clearing target)
        preAuctionEq1 = dp.equilibriumReserve1;

        // Set equilibrium = current reserves → CurveLib.verify auto-passes
        dp.equilibriumReserve0 = reserve0;
        dp.equilibriumReserve1 = reserve1;

        // Shift priceY off-market
        uint256 delta = uint256(auctionDelta);
        if (attractAsset1) {
            // Increase py → pool overprices asset0 in asset1 terms → arbers sell asset1
            dp.priceY = uint80(uint256(dp.priceY) * (WAD + delta) / WAD);
        } else {
            // Decrease py → pool overprices asset1 in asset0 terms → arbers sell asset0
            dp.priceY = uint80(uint256(dp.priceY) * WAD / (WAD + delta));
        }

        // Relax minReserves during auction
        dp.minReserve0 = 0;
        dp.minReserve1 = 0;

        try IEulerSwap(pool).reconfigure(dp, IEulerSwap.InitialState(reserve0, reserve1)) {
            auctionActive = true;
            auctionStart = uint40(block.timestamp);
            auctionAttractAsset1 = attractAsset1;
            emit AuctionTriggered(attractAsset1, reserve0, reserve1);
        } catch {
            // Silently fail — don't block normal swaps
        }
    }

    /// @notice Restore pool params after auction clears.
    /// Sets eq = current reserves, restores priceY to market.
    /// Both minReserves set at 5% price range from current (off-centre) reserves.
    /// For c=0: 5% price change ≈ reserve * (1 - 1/sqrt(1.05)) = reserve * 0.0241
    function _restorePreAuctionParams(uint112 reserve0, uint112 reserve1) internal {
        IEulerSwap.DynamicParams memory dp = IEulerSwap(pool).getDynamicParams();
        dp.priceY = preAuctionPriceY;
        dp.equilibriumReserve0 = reserve0;
        dp.equilibriumReserve1 = reserve1;

        // Symmetric 5% price range boundaries from off-centre reserves
        dp.minReserve0 = uint112(uint256(reserve0) * BOUNDARY_FACTOR / WAD);
        dp.minReserve1 = uint112(uint256(reserve1) * BOUNDARY_FACTOR / WAD);

        try IEulerSwap(pool).reconfigure(dp, IEulerSwap.InitialState(reserve0, reserve1)) {}
        catch {
            // Restore failed — agent must reconfigure manually
        }
    }

    /// @notice Read Uniswap V3 spot price from slot0.
    /// @return WAD-scaled price (raw asset1 per raw asset0), or 0 on failure.
    function _getUniswapPrice() internal view returns (uint256) {
        try IUniswapV3Pool(uniswapPool).slot0() returns (
            uint160 sqrtPriceX96, int24, uint16, uint16, uint16, uint8, bool
        ) {
            if (sqrtPriceX96 == 0) return 0;

            uint256 sqrtPrice = uint256(sqrtPriceX96);

            uint256 priceWad;
            if (sqrtPrice <= type(uint128).max) {
                priceWad = (sqrtPrice * sqrtPrice).mulDiv(WAD, Q192);
            } else {
                priceWad = sqrtPrice.mulDiv(sqrtPrice, Q64).mulDiv(WAD, Q128);
            }

            if (!uniswapToken0IsAsset0) {
                if (priceWad == 0) return 0;
                priceWad = WAD.mulDiv(WAD, priceWad);
            }

            return priceWad;
        } catch {
            return 0;
        }
    }

    /// @notice Compute the true marginal price from the EulerSwap curve derivative.
    /// @return WAD-scaled marginal price (raw asset1 per raw asset0)
    function _getMarginalPrice(uint112 reserve0, uint112 reserve1) internal view returns (uint256) {
        IEulerSwap.DynamicParams memory d = IEulerSwap(pool).getDynamicParams();
        uint256 px = uint256(d.priceX);
        uint256 py = uint256(d.priceY);
        uint256 x0 = uint256(d.equilibriumReserve0);
        uint256 y0 = uint256(d.equilibriumReserve1);

        if (reserve0 == 0 || py == 0) return 0;

        if (uint256(reserve0) <= x0) {
            uint256 step1 = px.mulDiv(x0, py);
            uint256 r0 = uint256(reserve0);
            return step1.mulDiv(x0 * WAD, r0 * r0);
        } else {
            if (y0 == 0) return 0;
            uint256 r1 = uint256(reserve1);
            uint256 step1 = px.mulDiv(r1, py);
            return step1.mulDiv(r1 * WAD, y0 * y0);
        }
    }
}
