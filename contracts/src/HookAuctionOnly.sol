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

interface IExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @title HookAuctionOnly — Minimal auction-only hook for testing displacement mechanics
/// @notice Isolates the auction cycle from V8: trigger → start → clearing → recenter.
/// Fee model is trivial: fixed fee in normal mode, linear decay in auction mode.
/// No oracle-reactive fees, no surcharge system.
///
/// Pool sets swapHookedOperations = GET_FEE | AFTER_SWAP (0x06).
contract HookAuctionOnly is IEulerSwapHookTarget {
    using FullMath for uint256;
    using Sqrt for uint256;

    // --- Constants ---
    uint256 constant WAD = 1e18;
    uint256 constant Q192 = 2 ** 192;
    uint256 constant Q128 = 2 ** 128;
    uint256 constant Q64 = 2 ** 64;
    uint256 constant SQRT_WAD = 1e9;

    // --- Immutables ---
    address public immutable pool;
    address public immutable owner;
    address public immutable supplyVault0;
    address public immutable supplyVault1;
    address public immutable borrowVault0;
    address public immutable borrowVault1;
    address public immutable eulerAccount;
    address public immutable asset0;
    address public immutable asset1;
    address public immutable oracleTarget;
    bytes32 public immutable oracleV4PoolId;
    bool public immutable oracleToken0IsAsset0;
    int256 public immutable weightW0;

    // --- Fee parameters (owner-updatable) ---
    uint64 public fixedFee;
    uint64 public maxFee;

    // --- Auction parameters (owner-updatable) ---
    uint64 public decayPerBlock;
    uint64 public triggerFraction;
    uint64 public clearThreshold;
    uint64 public minAuctionBlocks;
    uint64 public minAuctionInterval;
    uint64 public kMarginBlocks;
    uint128 public minDisplacementThreshold;

    // --- Trigger parameters (owner-updatable) ---
    uint64 public oracleGuardMultiplier;
    uint64 public maxSnapshotInterval;

    // --- Recenter parameters (owner-updatable) ---
    uint64 public recenterRange;
    uint64 public maxRecenterDrift;

    // --- Mutable state: cached NAV ---
    uint128 public cachedNav;

    // --- Mutable state: auction ---
    bool public auctionActive;
    uint64 public auctionStartBlock;
    uint64 public auctionStartingFee;
    bool public auctionClearAsset0;
    uint112 public auctionClearingAmount;
    uint64 public auctionEndBlock;

    // --- Mutable state: trigger coordinates ---
    uint112 public triggerReserve0;
    uint112 public triggerReserve1;
    uint64 public lastSnapshotBlock;

    // --- Mutable state: saved curve params for restore after auction ---
    uint64 public savedConcentrationX;
    uint64 public savedConcentrationY;

    // --- Events ---
    event FeeParamsUpdated(uint64 fixedFee, uint64 maxFee);
    event AuctionParamsUpdated(
        uint64 decayPerBlock,
        uint64 triggerFraction,
        uint64 clearThreshold,
        uint64 minAuctionBlocks,
        uint64 minAuctionInterval,
        uint64 kMarginBlocks
    );
    event TriggerParamsUpdated(uint64 oracleGuardMultiplier, uint64 maxSnapshotInterval);
    event RecenterParamsUpdated(uint64 recenterRange, uint64 maxRecenterDrift);
    event AuctionStarted(uint64 startingFee, uint64 blockNumber, bool clearAsset0, uint112 clearingAmount);
    event AuctionEnded(uint64 blockNumber);
    event Recentered(uint64 blockNumber);
    event TriggerCoordinatesUpdated(uint112 triggerReserve0, uint112 triggerReserve1);

    // --- Constructor param structs ---
    struct OracleConfig {
        address target;
        bytes32 v4PoolId;
        address token0;
    }

    struct AuctionConfig {
        uint64 decayPerBlock;
        uint64 triggerFraction;
        uint64 clearThreshold;
        uint64 minAuctionBlocks;
        uint64 minAuctionInterval;
        uint64 kMarginBlocks;
        uint64 oracleGuardMultiplier;
        uint64 maxSnapshotInterval;
        uint64 recenterRange;
        uint64 maxRecenterDrift;
        uint128 minDisplacementThreshold;
        int256 weightW0;
    }

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
        OracleConfig memory _oracleConfig,
        uint64 _fixedFee,
        uint64 _maxFee,
        AuctionConfig memory _auctionConfig
    ) {
        pool = _pool;
        owner = _owner;
        oracleTarget = _oracleConfig.target;
        oracleV4PoolId = _oracleConfig.v4PoolId;
        oracleToken0IsAsset0 = _oracleConfig.token0 == IEVault(IEulerSwap(_pool).getStaticParams().supplyVault0).asset();

        fixedFee = _fixedFee;
        maxFee = _maxFee;

        decayPerBlock = _auctionConfig.decayPerBlock;
        triggerFraction = _auctionConfig.triggerFraction;
        clearThreshold = _auctionConfig.clearThreshold;
        minAuctionBlocks = _auctionConfig.minAuctionBlocks;
        minAuctionInterval = _auctionConfig.minAuctionInterval;
        kMarginBlocks = _auctionConfig.kMarginBlocks;
        oracleGuardMultiplier = _auctionConfig.oracleGuardMultiplier;
        maxSnapshotInterval = _auctionConfig.maxSnapshotInterval;
        recenterRange = _auctionConfig.recenterRange;
        maxRecenterDrift = _auctionConfig.maxRecenterDrift;
        minDisplacementThreshold = _auctionConfig.minDisplacementThreshold;

        weightW0 = _auctionConfig.weightW0;

        IEulerSwap.StaticParams memory sParams = IEulerSwap(_pool).getStaticParams();
        supplyVault0 = sParams.supplyVault0;
        supplyVault1 = sParams.supplyVault1;
        borrowVault0 = sParams.borrowVault0;
        borrowVault1 = sParams.borrowVault1;
        eulerAccount = sParams.eulerAccount;
        asset0 = IEVault(sParams.supplyVault0).asset();
        asset1 = IEVault(sParams.supplyVault1).asset();

        IEulerSwap.DynamicParams memory d = IEulerSwap(_pool).getDynamicParams();
        savedConcentrationX = d.concentrationX;
        savedConcentrationY = d.concentrationY;

        uint256 uniPrice = _getUniswapPrice();
        cachedNav = _computeNav(uniPrice);
        _computeTriggerCoordinates();
        lastSnapshotBlock = uint64(block.number);
    }

    // =========================================================================
    // IEulerSwapHookTarget
    // =========================================================================

    function beforeSwap(uint256, uint256, address, address) external pure override {
        revert("not implemented");
    }

    /// @notice Fixed fee in normal mode. Linear decay in auction mode.
    function getFee(bool asset0IsInput, uint112, uint112, bool)
        external
        view
        override
        returns (uint64 fee)
    {
        if (auctionActive) {
            // Wrong direction: maxFee (minReserve blocks it anyway)
            if (asset0IsInput != auctionClearAsset0) {
                return maxFee;
            }
            // Clearing direction: decaying fee
            uint256 elapsed = block.number - uint256(auctionStartBlock);
            uint256 decayed = elapsed * uint256(decayPerBlock);
            uint256 auctionFee;
            if (decayed >= uint256(auctionStartingFee)) {
                auctionFee = uint256(fixedFee);
            } else {
                uint256 raw = uint256(auctionStartingFee) - decayed;
                auctionFee = raw > uint256(fixedFee) ? raw : uint256(fixedFee);
            }
            return uint64(auctionFee > uint256(maxFee) ? uint256(maxFee) : auctionFee);
        }

        return fixedFee;
    }

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
        if (!auctionActive) {
            _handleNormalMode(reserve0, reserve1);
        } else {
            _handleAuctionMode(reserve0, reserve1);
        }
    }

    // =========================================================================
    // Owner management
    // =========================================================================

    function setFeeParams(uint64 _fixedFee, uint64 _maxFee) external onlyOwner {
        require(_fixedFee <= _maxFee, "invalid fee ordering");
        require(_maxFee < uint64(WAD), "max fee >= 100%");
        fixedFee = _fixedFee;
        maxFee = _maxFee;
        emit FeeParamsUpdated(_fixedFee, _maxFee);
    }

    function setAuctionParams(
        uint64 _decayPerBlock,
        uint64 _triggerFraction,
        uint64 _clearThreshold,
        uint64 _minAuctionBlocks,
        uint64 _minAuctionInterval,
        uint64 _kMarginBlocks,
        uint128 _minDisplacementThreshold
    ) external onlyOwner {
        decayPerBlock = _decayPerBlock;
        triggerFraction = _triggerFraction;
        clearThreshold = _clearThreshold;
        minAuctionBlocks = _minAuctionBlocks;
        minAuctionInterval = _minAuctionInterval;
        kMarginBlocks = _kMarginBlocks;
        minDisplacementThreshold = _minDisplacementThreshold;
        _computeTriggerCoordinates();
        emit AuctionParamsUpdated(
            _decayPerBlock, _triggerFraction, _clearThreshold,
            _minAuctionBlocks, _minAuctionInterval, _kMarginBlocks
        );
    }

    function setTriggerParams(uint64 _oracleGuardMultiplier, uint64 _maxSnapshotInterval) external onlyOwner {
        oracleGuardMultiplier = _oracleGuardMultiplier;
        maxSnapshotInterval = _maxSnapshotInterval;
        emit TriggerParamsUpdated(_oracleGuardMultiplier, _maxSnapshotInterval);
    }

    function setRecenterParams(uint64 _recenterRange, uint64 _maxRecenterDrift) external onlyOwner {
        recenterRange = _recenterRange;
        maxRecenterDrift = _maxRecenterDrift;
        emit RecenterParamsUpdated(_recenterRange, _maxRecenterDrift);
    }

    /// @notice Owner can force-end a stuck auction.
    function endAuction() external onlyOwner {
        auctionActive = false;
        auctionEndBlock = uint64(block.number);

        (uint112 r0, uint112 r1,) = IEulerSwap(pool).getReserves();
        uint256 uniPrice = _getUniswapPrice();
        if (uniPrice > 0) {
            IEulerSwap.DynamicParams memory d = IEulerSwap(pool).getDynamicParams();
            d.concentrationX = savedConcentrationX;
            d.concentrationY = savedConcentrationY;
            uint256 newPriceY = uint256(d.priceX).mulDiv(WAD, uniPrice);
            if (newPriceY > 0 && newPriceY <= type(uint80).max) {
                d.priceY = uint80(newPriceY);
            }
            d.equilibriumReserve0 = r0;
            d.equilibriumReserve1 = r1;
            _setMinReservesFromRange(d, r0, r1);
            try IEulerSwap(pool).reconfigure(d, IEulerSwap.InitialState(r0, r1)) {
                emit Recentered(uint64(block.number));
            } catch {}
        }

        cachedNav = _computeNav(uniPrice);
        _computeTriggerCoordinates();
        lastSnapshotBlock = uint64(block.number);
        emit AuctionEnded(uint64(block.number));
    }

    function refreshVaultState() external onlyOwner {
        uint256 uniPrice = _getUniswapPrice();
        cachedNav = _computeNav(uniPrice);
        _computeTriggerCoordinates();
        lastSnapshotBlock = uint64(block.number);
    }

    // =========================================================================
    // Internal: normal mode — reserve-coordinate trigger
    // =========================================================================

    function _handleNormalMode(uint112 reserve0, uint112 reserve1) internal {
        bool cooldownOk = block.number > uint256(auctionEndBlock) + uint256(minAuctionInterval);
        if (!cooldownOk) return;

        bool reserveTrigger = reserve0 < triggerReserve0 || reserve1 < triggerReserve1;

        IEulerSwap.DynamicParams memory d;
        bool timeTrigger;
        if (!reserveTrigger) {
            d = IEulerSwap(pool).getDynamicParams();
            timeTrigger = block.number > uint256(lastSnapshotBlock) + uint256(maxSnapshotInterval)
                && (reserve0 != d.equilibriumReserve0 || reserve1 != d.equilibriumReserve1);
        }

        if (reserveTrigger || timeTrigger) {
            if (reserveTrigger) {
                d = IEulerSwap(pool).getDynamicParams();
            }
            uint256 uniPrice = _getUniswapPrice();
            _tryStartAuction(reserve0, reserve1, d, uniPrice);
        }
    }

    // =========================================================================
    // Internal: auction mode — reserve-based clearing
    // =========================================================================

    function _handleAuctionMode(uint112 reserve0, uint112 reserve1) internal {
        uint256 elapsed = block.number - uint256(auctionStartBlock);
        if (elapsed < uint256(minAuctionBlocks)) return;

        if (_checkReserveClearing(reserve0, reserve1)) {
            _endAuctionSuccess(reserve0, reserve1);
        }
    }

    function _checkReserveClearing(uint112 reserve0, uint112 reserve1) internal view returns (bool) {
        uint256 clearAmount = uint256(auctionClearingAmount);
        if (clearAmount == 0) return true;

        IEulerSwap.DynamicParams memory d = IEulerSwap(pool).getDynamicParams();

        if (auctionClearAsset0) {
            uint256 minR1 = uint256(d.minReserve1);
            uint256 remaining;
            if (uint256(reserve1) > minR1) {
                remaining = (uint256(reserve1) - minR1) * WAD / clearAmount;
            }
            return remaining < uint256(clearThreshold);
        } else {
            uint256 minR0 = uint256(d.minReserve0);
            uint256 remaining;
            if (uint256(reserve0) > minR0) {
                remaining = (uint256(reserve0) - minR0) * WAD / clearAmount;
            }
            return remaining < uint256(clearThreshold);
        }
    }

    // =========================================================================
    // Internal: auction start — constant-sum reconfiguration
    // =========================================================================

    function _tryStartAuction(
        uint112 reserve0,
        uint112 reserve1,
        IEulerSwap.DynamicParams memory d,
        uint256 uniPrice
    ) internal {
        if (uniPrice == 0) return;

        uint256 priceDiff;
        {
            uint256 marginalPrice = _getMarginalPrice(reserve0, reserve1, d);
            if (marginalPrice == 0) return;

            uint256 blocksSinceSnapshot = block.number - uint256(lastSnapshotBlock);
            priceDiff = _absDiffWad(marginalPrice, uniPrice);

            uint256 sqrtBlocksWad = (blocksSinceSnapshot * WAD).sqrt();
            uint256 guardThreshold = uint256(oracleGuardMultiplier) * uint256(decayPerBlock) / WAD;
            guardThreshold = guardThreshold * sqrtBlocksWad / SQRT_WAD;

            uint256 eqPrice = uint256(d.priceX).mulDiv(WAD, uint256(d.priceY));

            bool oracleConfirms;
            if (marginalPrice >= eqPrice) {
                oracleConfirms = uniPrice >= marginalPrice
                    || _absDiffWad(marginalPrice, uniPrice) <= guardThreshold;
            } else {
                oracleConfirms = uniPrice <= marginalPrice
                    || _absDiffWad(uniPrice, marginalPrice) <= guardThreshold;
            }

            if (!oracleConfirms) {
                cachedNav = _computeNav(uniPrice);
                _computeTriggerCoordinates();
                lastSnapshotBlock = uint64(block.number);
                return;
            }
        }

        (uint256 clearingAmount, bool clearAsset0) = _computeClearingAmount(uniPrice);
        if (clearingAmount == 0) {
            cachedNav = _computeNav(uniPrice);
            _computeTriggerCoordinates();
            lastSnapshotBlock = uint64(block.number);
            return;
        }

        savedConcentrationX = d.concentrationX;
        savedConcentrationY = d.concentrationY;

        _reconfigureForAuction(reserve0, reserve1, d, uniPrice, clearingAmount, clearAsset0, priceDiff);
    }

    function _reconfigureForAuction(
        uint112 reserve0,
        uint112 reserve1,
        IEulerSwap.DynamicParams memory d,
        uint256 uniPrice,
        uint256 clearingAmount,
        bool clearAsset0,
        uint256 priceDiff
    ) internal {
        uint256 startFee = priceDiff + uint256(kMarginBlocks) * uint256(decayPerBlock);
        if (startFee > uint256(maxFee)) startFee = uint256(maxFee);
        if (startFee < uint256(fixedFee)) startFee = uint256(fixedFee);

        d.concentrationX = uint64(WAD);
        d.concentrationY = uint64(WAD);
        d.equilibriumReserve0 = reserve0;
        d.equilibriumReserve1 = reserve1;

        {
            uint256 auctionPriceY = uint256(d.priceX).mulDiv(WAD, uniPrice);
            if (auctionPriceY > 0 && auctionPriceY <= type(uint80).max) {
                d.priceY = uint80(auctionPriceY);
            }
        }

        uint112 clampedClearingAmount =
            uint112(clearingAmount > type(uint112).max ? type(uint112).max : clearingAmount);

        if (clearAsset0) {
            d.minReserve0 = reserve0;
            d.minReserve1 = uint112(
                uint256(reserve1) > clearingAmount ? uint256(reserve1) - clearingAmount : 0
            );
        } else {
            d.minReserve0 = uint112(
                uint256(reserve0) > clearingAmount ? uint256(reserve0) - clearingAmount : 0
            );
            d.minReserve1 = reserve1;
        }

        try IEulerSwap(pool).reconfigure(d, IEulerSwap.InitialState(reserve0, reserve1)) {
            auctionActive = true;
            auctionStartBlock = uint64(block.number);
            auctionStartingFee = uint64(startFee);
            auctionClearAsset0 = clearAsset0;
            auctionClearingAmount = clampedClearingAmount;
            emit AuctionStarted(uint64(startFee), uint64(block.number), clearAsset0, clampedClearingAmount);
        } catch {}
    }

    function _computeClearingAmount(uint256 uniPrice) internal view returns (uint256 clearingAmount, bool clearAsset0) {
        if (uniPrice == 0) return (0, false);

        address _eulerAccount = eulerAccount;

        uint256 deposit0 = IEVault(supplyVault0).convertToAssets(IEVault(supplyVault0).balanceOf(_eulerAccount));
        uint256 deposit1 = IEVault(supplyVault1).convertToAssets(IEVault(supplyVault1).balanceOf(_eulerAccount));
        uint256 debt0;
        if (borrowVault0 != address(0)) debt0 = IEVault(borrowVault0).debtOf(_eulerAccount);
        uint256 debt1;
        if (borrowVault1 != address(0)) debt1 = IEVault(borrowVault1).debtOf(_eulerAccount);

        int256 value0 = int256(deposit0) - int256(debt0);
        int256 value1InAsset0 = (int256(deposit1) - int256(debt1)) * int256(uniPrice) / int256(WAD);
        int256 nav = value0 + value1InAsset0;

        if (nav <= 0) return (0, false);

        int256 target0 = weightW0 * nav / int256(WAD);
        int256 displacement0 = value0 - target0;

        uint256 absDisp = displacement0 >= 0 ? uint256(displacement0) : uint256(-displacement0);
        if (absDisp < uint256(minDisplacementThreshold)) return (0, false);

        if (displacement0 > 0) {
            clearAsset0 = false;
            clearingAmount = uint256(displacement0);
        } else {
            clearAsset0 = true;
            clearingAmount = absDisp.mulDiv(WAD, uniPrice);
        }
    }

    // =========================================================================
    // Internal: auction end
    // =========================================================================

    function _endAuctionSuccess(uint112 reserve0, uint112 reserve1) internal {
        auctionActive = false;
        auctionEndBlock = uint64(block.number);

        uint256 uniPrice = _getUniswapPrice();
        if (uniPrice == 0) {
            emit AuctionEnded(uint64(block.number));
            return;
        }

        IEulerSwap.DynamicParams memory d = IEulerSwap(pool).getDynamicParams();

        d.concentrationX = savedConcentrationX;
        d.concentrationY = savedConcentrationY;

        uint256 newPriceY = uint256(d.priceX).mulDiv(WAD, uniPrice);

        uint256 _maxDrift = uint256(maxRecenterDrift);
        uint80 preAuctionPriceY = d.priceY;
        if (_maxDrift > 0 && uint256(preAuctionPriceY) > 0) {
            uint256 maxPY = uint256(preAuctionPriceY) * (WAD + _maxDrift) / WAD;
            uint256 minPY = uint256(preAuctionPriceY) * WAD / (WAD + _maxDrift);
            if (newPriceY > maxPY) newPriceY = maxPY;
            if (newPriceY < minPY) newPriceY = minPY;
        }

        if (newPriceY > 0 && newPriceY <= type(uint80).max) {
            d.priceY = uint80(newPriceY);
        }

        d.equilibriumReserve0 = reserve0;
        d.equilibriumReserve1 = reserve1;
        _setMinReservesFromRange(d, reserve0, reserve1);

        try IEulerSwap(pool).reconfigure(d, IEulerSwap.InitialState(reserve0, reserve1)) {
            emit Recentered(uint64(block.number));
            cachedNav = _computeNav(uniPrice);
            _computeTriggerCoordinates();
            lastSnapshotBlock = uint64(block.number);
        } catch {}

        emit AuctionEnded(uint64(block.number));
    }

    // =========================================================================
    // Internal: trigger coordinate computation
    // =========================================================================

    function _computeTriggerCoordinates() internal {
        IEulerSwap.DynamicParams memory d = IEulerSwap(pool).getDynamicParams();

        uint256 x0 = uint256(d.equilibriumReserve0);
        uint256 y0 = uint256(d.equilibriumReserve1);
        uint256 px = uint256(d.priceX);
        uint256 py = uint256(d.priceY);
        uint256 cx = uint256(d.concentrationX);
        uint256 cy = uint256(d.concentrationY);
        uint256 frac = uint256(triggerFraction);

        if (px == 0 || py == 0 || x0 == 0 || y0 == 0 || frac == 0) {
            triggerReserve0 = 0;
            triggerReserve1 = 0;
            emit TriggerCoordinatesUpdated(0, 0);
            return;
        }

        uint112 trig0;
        if (cx < WAD) {
            uint256 innerX = (WAD + frac - cx) * WAD / (WAD - cx);
            if (innerX > WAD) {
                uint256 sqrtInner = innerX.sqrt();
                trig0 = uint112(x0 * SQRT_WAD / sqrtInner);
            }
        }

        uint112 trig1;
        if (cy < WAD && frac < WAD) {
            uint256 invFrac = WAD * WAD / (WAD - frac);
            if (invFrac > cy) {
                uint256 innerY = (invFrac - cy) * WAD / (WAD - cy);
                if (innerY > WAD) {
                    uint256 sqrtInner = innerY.sqrt();
                    trig1 = uint112(y0 * SQRT_WAD / sqrtInner);
                }
            }
        }

        triggerReserve0 = trig0;
        triggerReserve1 = trig1;
        emit TriggerCoordinatesUpdated(trig0, trig1);
    }

    // =========================================================================
    // Internal: NAV computation
    // =========================================================================

    function _computeNav(uint256 uniPrice) internal view returns (uint128) {
        address _eulerAccount = eulerAccount;

        uint256 deposit0 = IEVault(supplyVault0).convertToAssets(IEVault(supplyVault0).balanceOf(_eulerAccount));
        uint256 deposit1 = IEVault(supplyVault1).convertToAssets(IEVault(supplyVault1).balanceOf(_eulerAccount));

        uint256 debt0;
        if (borrowVault0 != address(0)) debt0 = IEVault(borrowVault0).debtOf(_eulerAccount);
        uint256 debt1;
        if (borrowVault1 != address(0)) debt1 = IEVault(borrowVault1).debtOf(_eulerAccount);

        if (uniPrice == 0) return 0;

        uint256 totalDeposits = deposit0 + deposit1.mulDiv(WAD, uniPrice);
        uint256 totalDebts = debt0 + debt1.mulDiv(WAD, uniPrice);
        if (totalDebts >= totalDeposits) return 0;
        uint256 nav = totalDeposits - totalDebts;
        return nav > type(uint128).max ? type(uint128).max : uint128(nav);
    }

    // =========================================================================
    // Internal: helpers
    // =========================================================================

    function _setMinReservesFromRange(IEulerSwap.DynamicParams memory d, uint112 reserve0, uint112 reserve1)
        internal
        view
    {
        uint256 _range = uint256(recenterRange);
        if (_range == 0) {
            d.minReserve0 = 0;
            d.minReserve1 = 0;
            return;
        }

        uint256 cx = uint256(d.concentrationX);
        if (cx < WAD) {
            uint256 inner = WAD + _range * WAD / (WAD - cx);
            d.minReserve0 = uint112(uint256(reserve0) * SQRT_WAD / inner.sqrt());
        } else {
            d.minReserve0 = 0;
        }

        uint256 cy = uint256(d.concentrationY);
        if (cy < WAD) {
            uint256 inner = WAD + _range * WAD / (WAD - cy);
            d.minReserve1 = uint112(uint256(reserve1) * SQRT_WAD / inner.sqrt());
        } else {
            d.minReserve1 = 0;
        }
    }

    function _getUniswapPrice() internal view returns (uint256) {
        uint160 sqrtPriceX96;

        if (oracleV4PoolId != bytes32(0)) {
            sqrtPriceX96 = _readV4SqrtPrice();
        } else {
            sqrtPriceX96 = _readV3SqrtPrice();
        }

        if (sqrtPriceX96 == 0) return 0;

        uint256 sqrtPrice = uint256(sqrtPriceX96);
        uint256 priceWad;
        if (sqrtPrice <= type(uint128).max) {
            priceWad = (sqrtPrice * sqrtPrice).mulDiv(WAD, Q192);
        } else {
            priceWad = sqrtPrice.mulDiv(sqrtPrice, Q64).mulDiv(WAD, Q128);
        }

        if (!oracleToken0IsAsset0) {
            if (priceWad == 0) return 0;
            priceWad = WAD.mulDiv(WAD, priceWad);
        }

        return priceWad;
    }

    function _readV3SqrtPrice() internal view returns (uint160) {
        try IUniswapV3Pool(oracleTarget).slot0() returns (
            uint160 sqrtPriceX96, int24, uint16, uint16, uint16, uint8, bool
        ) {
            return sqrtPriceX96;
        } catch {
            return 0;
        }
    }

    function _readV4SqrtPrice() internal view returns (uint160) {
        bytes32 stateSlot = keccak256(abi.encode(oracleV4PoolId, bytes32(uint256(6))));
        try IExtsload(oracleTarget).extsload(stateSlot) returns (bytes32 packed) {
            return uint160(uint256(packed));
        } catch {
            return 0;
        }
    }

    function _getMarginalPrice(uint112 reserve0, uint112 reserve1, IEulerSwap.DynamicParams memory d)
        internal
        pure
        returns (uint256)
    {
        uint256 px = uint256(d.priceX);
        uint256 py = uint256(d.priceY);
        uint256 x0 = uint256(d.equilibriumReserve0);
        uint256 y0 = uint256(d.equilibriumReserve1);

        if (reserve0 == 0 || py == 0) return 0;

        if (uint256(reserve0) <= x0) {
            uint256 cx = uint256(d.concentrationX);
            uint256 r0 = uint256(reserve0);
            uint256 quadTerm = (WAD - cx).mulDiv(x0 * x0, r0 * r0);
            uint256 bracketWad = cx + quadTerm;
            return px.mulDiv(bracketWad, py);
        } else {
            if (y0 == 0) return 0;
            uint256 cy = uint256(d.concentrationY);
            uint256 r1 = uint256(reserve1);
            uint256 quadTerm = (WAD - cy).mulDiv(y0 * y0, r1 * r1);
            uint256 bracketWad = cy + quadTerm;
            return px.mulDiv(WAD, py).mulDiv(WAD, bracketWad);
        }
    }

    function _absDiffWad(uint256 a, uint256 b) internal pure returns (uint256) {
        if (a > b) {
            return (a - b) * WAD / a;
        } else if (b > a) {
            return (b - a) * WAD / b;
        }
        return 0;
    }

    // =========================================================================
    // View helpers
    // =========================================================================

    function getAuctionParams()
        external
        view
        returns (
            uint64 _decayPerBlock,
            uint64 _triggerFraction,
            uint64 _clearThreshold,
            uint64 _minAuctionBlocks,
            uint64 _minAuctionInterval,
            uint64 _kMarginBlocks
        )
    {
        return (
            decayPerBlock, triggerFraction, clearThreshold,
            minAuctionBlocks, minAuctionInterval, kMarginBlocks
        );
    }

    function getTriggerParams()
        external
        view
        returns (uint64 _oracleGuardMultiplier, uint64 _maxSnapshotInterval)
    {
        return (oracleGuardMultiplier, maxSnapshotInterval);
    }

    function getRecenterParams()
        external
        view
        returns (uint64 _recenterRange, uint64 _maxRecenterDrift)
    {
        return (recenterRange, maxRecenterDrift);
    }

    function getAuctionState()
        external
        view
        returns (
            bool _active,
            uint64 _startBlock,
            uint64 _startingFee,
            bool _clearAsset0,
            uint112 _clearingAmount,
            uint64 _endBlock
        )
    {
        return (
            auctionActive, auctionStartBlock, auctionStartingFee,
            auctionClearAsset0, auctionClearingAmount, auctionEndBlock
        );
    }

    function getTriggerState()
        external
        view
        returns (uint112 _triggerReserve0, uint112 _triggerReserve1, uint64 _lastSnapshotBlock)
    {
        return (triggerReserve0, triggerReserve1, lastSnapshotBlock);
    }

    function getDisplacementState()
        external
        view
        returns (uint128 _cachedNav, int256 _weightW0)
    {
        return (cachedNav, weightW0);
    }

    function computeCurrentDisplacement()
        external
        view
        returns (int256 displacement0, uint256 relativeDisplacement, uint256 nav)
    {
        uint256 uniPrice = _getUniswapPrice();
        if (uniPrice == 0) return (0, 0, 0);

        address _eulerAccount = eulerAccount;
        uint256 deposit0 = IEVault(supplyVault0).convertToAssets(IEVault(supplyVault0).balanceOf(_eulerAccount));
        uint256 deposit1 = IEVault(supplyVault1).convertToAssets(IEVault(supplyVault1).balanceOf(_eulerAccount));
        uint256 debt0;
        if (borrowVault0 != address(0)) debt0 = IEVault(borrowVault0).debtOf(_eulerAccount);
        uint256 debt1;
        if (borrowVault1 != address(0)) debt1 = IEVault(borrowVault1).debtOf(_eulerAccount);

        int256 value0 = int256(deposit0) - int256(debt0);
        int256 value1InAsset0 = (int256(deposit1) - int256(debt1)) * int256(uniPrice) / int256(WAD);
        int256 signedNav = value0 + value1InAsset0;

        if (signedNav <= 0) return (0, 0, 0);

        nav = uint256(signedNav);
        int256 target0 = weightW0 * signedNav / int256(WAD);
        displacement0 = value0 - target0;

        uint256 absDisp = displacement0 >= 0 ? uint256(displacement0) : uint256(-displacement0);
        relativeDisplacement = absDisp * WAD / nav;
    }
}
