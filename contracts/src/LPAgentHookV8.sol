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

/// @title LPAgentHookV8 — Strategy-agnostic displacement auction
/// @notice Single mechanism:
///   Clearing auction: when reserve-coordinate trigger fires,
///   reconfigure to constant-sum → fee-decay auction → reserve-based clearing → restore.
///
/// Strategy-agnostic design (see docs/displacement-mechanism.md):
///   - Weight vector [w0, w1] defines target composition (w0 + w1 = 1e18)
///   - Trigger is curve-based: reserve coordinates where marginal price crosses threshold
///   - Hot path: 2 uint comparisons (reserve0 < trigger0 || reserve1 < trigger1)
///   - Displacement computed at auction start from full vault read + weight vector
///   - No continuous recentering for c=0 curves (gas cost > benefit)
///
/// Pool sets swapHookedOperations = GET_FEE | AFTER_SWAP (0x06).
contract LPAgentHookV8 is IEulerSwapHookTarget {
    using FullMath for uint256;
    using Sqrt for uint256;

    // --- Constants ---
    uint256 constant WAD = 1e18;
    uint256 constant Q192 = 2 ** 192;
    uint256 constant Q128 = 2 ** 128;
    uint256 constant Q64 = 2 ** 64;
    uint256 constant SQRT_WAD = 1e9; // sqrt(1e18)

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
    address public immutable oracleTarget; // V3: pool address, V4: PoolManager address
    bytes32 public immutable oracleV4PoolId; // non-zero = V4 mode
    bool public immutable oracleToken0IsAsset0;

    /// @notice Target weight for asset0 in WAD (e.g. 1e18 = 100% asset0 = delta-neutral).
    /// w1 = WAD - w0 implicitly. Supports negative weights via int256 storage.
    int256 public immutable weightW0;

    // --- Fee parameters (owner-updatable) ---
    uint64 public baseFee;
    uint64 public maxFee;
    uint64 public gasCoeff;
    uint64 public externalFee;
    uint256 public captureRate;
    uint256 public attractRate;

    // --- Surcharge parameters (owner-updatable) ---
    uint64 public surchargeDecayPerBlock;
    uint64 public surchargeMultiplier; // e.g. 1.25e18 — safety margin on exact curvature formula

    // --- Auction parameters (owner-updatable) ---
    uint64 public decayPerBlock;
    uint64 public triggerFraction; // WAD: price fraction from eq that triggers auction (e.g. 0.20e18 = 20%)
    uint64 public clearThreshold; // WAD: remaining fraction to declare auction cleared (e.g. 0.1e18 = 10%)
    uint64 public minAuctionBlocks; // minimum blocks before clearing check
    uint64 public minAuctionInterval; // cooldown blocks after auction end before next trigger
    uint64 public kMarginBlocks; // starting fee = premium + k * D
    uint128 public minDisplacementThreshold; // minimum displacement in asset0 units to start auction

    // --- Trigger parameters (owner-updatable) ---
    uint64 public oracleGuardMultiplier; // g in guard formula (WAD-scaled, e.g. 3e18)
    uint64 public maxSnapshotInterval; // time-based trigger fallback

    // --- Recenter parameters (owner-updatable) ---
    uint64 public recenterRange;
    uint64 public maxRecenterDrift;

    // --- Mutable state: cached NAV (updated at snapshot) ---
    uint128 public cachedNav; // NAV in asset0 terms at last snapshot

    // --- Mutable state: surcharge ---
    uint64 public surchargeStartBlock;
    uint64 public surchargeInitialAmount; // computed per-recenter, not a param

    // --- Mutable state: auction ---
    bool public auctionActive;
    uint64 public auctionStartBlock;
    uint64 public auctionStartingFee;
    bool public auctionClearAsset0; // true = clearing direction is asset0-in, asset1-out
    uint112 public auctionClearingAmount; // reserve units to clear on output side
    uint64 public auctionEndBlock; // block when last auction ended (for cooldown)

    // --- Mutable state: trigger coordinates (strategy-agnostic, curve-based) ---
    uint112 public triggerReserve0; // reserve0 below this → trigger fires (X branch, price up)
    uint112 public triggerReserve1; // reserve1 below this → trigger fires (Y branch, price down)
    uint64 public lastSnapshotBlock; // block number of last snapshot

    // --- Mutable state: saved curve params for restore after auction ---
    uint64 public savedConcentrationX;
    uint64 public savedConcentrationY;

    // --- Events ---
    event FeeParamsUpdated(
        uint64 baseFee, uint64 maxFee, uint64 gasCoeff, uint64 externalFee, uint256 captureRate, uint256 attractRate
    );
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
    event SurchargeParamsUpdated(uint64 surchargeDecayPerBlock, uint64 surchargeMultiplier);
    event AuctionStarted(uint64 startingFee, uint64 blockNumber, bool clearAsset0, uint112 clearingAmount);
    event AuctionEnded(uint64 blockNumber);
    event Recentered(uint64 blockNumber);
    event TriggerCoordinatesUpdated(uint112 triggerReserve0, uint112 triggerReserve1);

    // --- Constructor param structs ---
    struct OracleConfig {
        address target; // V3: pool address, V4: PoolManager address
        bytes32 v4PoolId; // set to 0 for V3 oracle
        address token0; // which token is token0 in the oracle pool
    }

    struct FeeConfig {
        uint64 baseFee;
        uint64 maxFee;
        uint64 gasCoeff;
        uint64 externalFee;
        uint256 captureRate;
        uint256 attractRate;
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
        uint64 surchargeDecayPerBlock;
        uint64 surchargeMultiplier;
        uint64 deploySurcharge;
        uint128 minDisplacementThreshold; // minimum displacement in asset0 units to start auction
        int256 weightW0; // target weight for asset0 (WAD-scaled, can be negative)
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
        FeeConfig memory _feeConfig,
        AuctionConfig memory _auctionConfig
    ) {
        pool = _pool;
        owner = _owner;
        oracleTarget = _oracleConfig.target;
        oracleV4PoolId = _oracleConfig.v4PoolId;
        oracleToken0IsAsset0 = _oracleConfig.token0 == IEVault(IEulerSwap(_pool).getStaticParams().supplyVault0).asset();

        baseFee = _feeConfig.baseFee;
        maxFee = _feeConfig.maxFee;
        gasCoeff = _feeConfig.gasCoeff;
        externalFee = _feeConfig.externalFee;
        require(_feeConfig.captureRate <= WAD, "captureRate > 100%");
        require(_feeConfig.attractRate <= WAD, "attractRate > 100%");
        captureRate = _feeConfig.captureRate;
        attractRate = _feeConfig.attractRate;

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
        surchargeDecayPerBlock = _auctionConfig.surchargeDecayPerBlock;
        require(_auctionConfig.surchargeMultiplier <= 10e18, "surchargeMultiplier too large");
        surchargeMultiplier = _auctionConfig.surchargeMultiplier;
        minDisplacementThreshold = _auctionConfig.minDisplacementThreshold;

        // Weight vector: w0 + w1 = WAD
        weightW0 = _auctionConfig.weightW0;

        IEulerSwap.StaticParams memory sParams = IEulerSwap(_pool).getStaticParams();
        supplyVault0 = sParams.supplyVault0;
        supplyVault1 = sParams.supplyVault1;
        borrowVault0 = sParams.borrowVault0;
        borrowVault1 = sParams.borrowVault1;
        eulerAccount = sParams.eulerAccount;
        asset0 = IEVault(sParams.supplyVault0).asset();
        asset1 = IEVault(sParams.supplyVault1).asset();

        // Save initial concentration for auction restore
        IEulerSwap.DynamicParams memory d = IEulerSwap(_pool).getDynamicParams();
        savedConcentrationX = d.concentrationX;
        savedConcentrationY = d.concentrationY;

        // Init NAV and trigger coordinates
        uint256 uniPrice = _getUniswapPrice();
        cachedNav = _computeNav(uniPrice);
        _computeTriggerCoordinates();
        lastSnapshotBlock = uint64(block.number);

        // Deployment protection surcharge
        surchargeStartBlock = uint64(block.number);
        surchargeInitialAmount = _auctionConfig.deploySurcharge;
    }

    // =========================================================================
    // IEulerSwapHookTarget
    // =========================================================================

    function beforeSwap(uint256, uint256, address, address) external pure override {
        revert("not implemented");
    }

    /// @notice Dynamic fee: normal (oracle-reactive + surcharge) or auction (fee-decay).
    /// In auction mode, wrong direction returns maxFee (pool's minReserve blocks it anyway).
    function getFee(bool asset0IsInput, uint112 reserve0, uint112 reserve1, bool)
        external
        view
        override
        returns (uint64 fee)
    {
        if (auctionActive) {
            // Wrong direction: return maxFee (minReserve on non-clearing side blocks the swap)
            if (asset0IsInput != auctionClearAsset0) {
                return maxFee;
            }
            // Clearing direction: decaying fee
            uint256 elapsed = block.number - uint256(auctionStartBlock);
            uint256 decayed = elapsed * uint256(decayPerBlock);
            uint256 auctionFee;
            if (decayed >= uint256(auctionStartingFee)) {
                auctionFee = uint256(baseFee);
            } else {
                uint256 raw = uint256(auctionStartingFee) - decayed;
                auctionFee = raw > uint256(baseFee) ? raw : uint256(baseFee);
            }
            return uint64(auctionFee > uint256(maxFee) ? uint256(maxFee) : auctionFee);
        }

        uint256 computedFee = _computeNormalFee(asset0IsInput, reserve0, reserve1);
        computedFee += _currentSurcharge();
        if (computedFee > uint256(maxFee)) computedFee = uint256(maxFee);
        return uint64(computedFee);
    }

    /// @notice afterSwap: check trigger, start auction if needed.
    /// No continuous recentering — hot path is two uint comparisons.
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
        require(_captureRate <= WAD, "captureRate > 100%");
        require(_attractRate <= WAD, "attractRate > 100%");
        baseFee = _baseFee;
        maxFee = _maxFee;
        gasCoeff = _gasCoeff;
        externalFee = _externalFee;
        captureRate = _captureRate;
        attractRate = _attractRate;
        emit FeeParamsUpdated(_baseFee, _maxFee, _gasCoeff, _externalFee, _captureRate, _attractRate);
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
        // Recompute trigger coordinates with new fraction
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

    function setSurchargeParams(uint64 _surchargeDecayPerBlock, uint64 _surchargeMultiplier) external onlyOwner {
        require(_surchargeMultiplier <= 10e18, "surchargeMultiplier too large");
        surchargeDecayPerBlock = _surchargeDecayPerBlock;
        surchargeMultiplier = _surchargeMultiplier;
        emit SurchargeParamsUpdated(_surchargeDecayPerBlock, _surchargeMultiplier);
    }

    /// @notice Owner can force-end a stuck auction (emergency).
    /// Restores concentration, recenters at market, refreshes state, sets surcharge.
    function endAuction() external onlyOwner {
        auctionActive = false;
        auctionEndBlock = uint64(block.number);

        (uint112 r0, uint112 r1,) = IEulerSwap(pool).getReserves();
        uint256 uniPrice = _getUniswapPrice();
        if (uniPrice > 0) {
            IEulerSwap.DynamicParams memory d = IEulerSwap(pool).getDynamicParams();
            // Restore concentration
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
        surchargeStartBlock = uint64(block.number);
        surchargeInitialAmount = baseFee;
        emit AuctionEnded(uint64(block.number));
    }

    /// @notice Owner can refresh snapshot to correct for interest accrual drift.
    function refreshVaultState() external onlyOwner {
        uint256 uniPrice = _getUniswapPrice();
        cachedNav = _computeNav(uniPrice);
        _computeTriggerCoordinates();
        lastSnapshotBlock = uint64(block.number);
    }

    // =========================================================================
    // Internal: normal mode — strategy-agnostic reserve-coordinate trigger
    // =========================================================================

    /// @notice Normal mode: check reserve-coordinate trigger. No continuous recentering.
    /// Hot path is two uint comparisons — fully strategy-agnostic.
    function _handleNormalMode(uint112 reserve0, uint112 reserve1) internal {
        // Cooldown check
        bool cooldownOk = block.number > uint256(auctionEndBlock) + uint256(minAuctionInterval);
        if (!cooldownOk) return;

        // Reserve-coordinate trigger (cheap: 2 uint comparisons)
        bool reserveTrigger = reserve0 < triggerReserve0 || reserve1 < triggerReserve1;

        // Time-based trigger: any displacement after maxSnapshotInterval
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

        // Minimum blocks before clearing check
        if (elapsed < uint256(minAuctionBlocks)) return;

        // Reserve-based clearing check
        if (_checkReserveClearing(reserve0, reserve1)) {
            _endAuctionSuccess(reserve0, reserve1);
        }
    }

    /// @notice Check if auction has cleared: remaining < clearThreshold.
    function _checkReserveClearing(uint112 reserve0, uint112 reserve1) internal view returns (bool) {
        uint256 clearAmount = uint256(auctionClearingAmount);
        if (clearAmount == 0) return true;

        IEulerSwap.DynamicParams memory d = IEulerSwap(pool).getDynamicParams();

        if (auctionClearAsset0) {
            // Clearing direction: asset0 in, asset1 out
            uint256 minR1 = uint256(d.minReserve1);
            uint256 remaining;
            if (uint256(reserve1) > minR1) {
                remaining = (uint256(reserve1) - minR1) * WAD / clearAmount;
            }
            return remaining < uint256(clearThreshold);
        } else {
            // Clearing direction: asset1 in, asset0 out
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

    /// @notice Try to start auction. Oracle guard can abort and re-snapshot.
    function _tryStartAuction(
        uint112 reserve0,
        uint112 reserve1,
        IEulerSwap.DynamicParams memory d,
        uint256 uniPrice
    ) internal {
        if (uniPrice == 0) return;

        uint256 priceDiff;
        {
            // Oracle guard (directional): oracle must confirm the displacement direction.
            // Allow if oracle is MORE extreme than marginal (confirms move).
            // Allow if oracle is LESS extreme than marginal by at most g * D * sqrt(blocks).
            // Block only if oracle contradicts the marginal price by more than the margin.
            uint256 marginalPrice = _getMarginalPrice(reserve0, reserve1, d);
            if (marginalPrice == 0) return;

            uint256 blocksSinceSnapshot = block.number - uint256(lastSnapshotBlock);
            priceDiff = _absDiffWad(marginalPrice, uniPrice);

            // Guard threshold: g * D * sqrt(blocks) (all WAD-scaled)
            uint256 sqrtBlocksWad = (blocksSinceSnapshot * WAD).sqrt();
            uint256 guardThreshold = uint256(oracleGuardMultiplier) * uint256(decayPerBlock) / WAD;
            guardThreshold = guardThreshold * sqrtBlocksWad / SQRT_WAD;

            // Eq price = pool's configured price (priceX / priceY in WAD terms)
            uint256 eqPrice = uint256(d.priceX).mulDiv(WAD, uint256(d.priceY));

            // Directional check: only penalize oracle being less extreme than marginal.
            // If marginal moved up from eq (marginal > eqPrice), oracle >= marginal - margin is OK.
            // If marginal moved down from eq (marginal < eqPrice), oracle <= marginal + margin is OK.
            bool oracleConfirms;
            if (marginalPrice >= eqPrice) {
                // Price went up. Oracle more extreme = oracle >= marginal. Always OK.
                // Oracle less extreme = oracle < marginal. OK if deficit < threshold.
                oracleConfirms = uniPrice >= marginalPrice
                    || _absDiffWad(marginalPrice, uniPrice) <= guardThreshold;
            } else {
                // Price went down. Oracle more extreme = oracle <= marginal. Always OK.
                // Oracle less extreme = oracle > marginal. OK if deficit < threshold.
                oracleConfirms = uniPrice <= marginalPrice
                    || _absDiffWad(uniPrice, marginalPrice) <= guardThreshold;
            }

            if (!oracleConfirms) {
                // Guard triggered: oracle contradicts the trigger direction, re-snapshot
                cachedNav = _computeNav(uniPrice);
                _computeTriggerCoordinates();
                lastSnapshotBlock = uint64(block.number);
                return;
            }
        }

        // Full vault read: compute displacement from weight vector
        (uint256 clearingAmount, bool clearAsset0) = _computeClearingAmount(uniPrice);
        if (clearingAmount == 0) {
            // False positive: trigger fired but displacement is negligible
            cachedNav = _computeNav(uniPrice);
            _computeTriggerCoordinates();
            lastSnapshotBlock = uint64(block.number);
            return;
        }

        // Save normal-mode concentration for restore
        savedConcentrationX = d.concentrationX;
        savedConcentrationY = d.concentrationY;

        // Compute starting fee and reconfigure
        _reconfigureForAuction(reserve0, reserve1, d, uniPrice, clearingAmount, clearAsset0, priceDiff);
    }

    /// @notice Apply constant-sum reconfiguration for auction start.
    function _reconfigureForAuction(
        uint112 reserve0,
        uint112 reserve1,
        IEulerSwap.DynamicParams memory d,
        uint256 uniPrice,
        uint256 clearingAmount,
        bool clearAsset0,
        uint256 priceDiff
    ) internal {
        // Starting fee = premium + k * D
        uint256 startFee = priceDiff + uint256(kMarginBlocks) * uint256(decayPerBlock);
        if (startFee > uint256(maxFee)) startFee = uint256(maxFee);
        if (startFee < uint256(baseFee)) startFee = uint256(baseFee);

        // Reconfigure to constant-sum
        d.concentrationX = uint64(WAD);
        d.concentrationY = uint64(WAD);
        d.equilibriumReserve0 = reserve0;
        d.equilibriumReserve1 = reserve1;

        // Set priceX/priceY from oracle
        {
            uint256 auctionPriceY = uint256(d.priceX).mulDiv(WAD, uniPrice);
            if (auctionPriceY > 0 && auctionPriceY <= type(uint80).max) {
                d.priceY = uint80(auctionPriceY);
            }
        }

        // Min reserves: lock wrong direction, allow clearing direction
        uint112 clampedClearingAmount =
            uint112(clearingAmount > type(uint112).max ? type(uint112).max : clearingAmount);

        if (clearAsset0) {
            d.minReserve0 = reserve0; // LOCK: no asset0 output
            d.minReserve1 = uint112(
                uint256(reserve1) > clearingAmount ? uint256(reserve1) - clearingAmount : 0
            );
        } else {
            d.minReserve0 = uint112(
                uint256(reserve0) > clearingAmount ? uint256(reserve0) - clearingAmount : 0
            );
            d.minReserve1 = reserve1; // LOCK: no asset1 output
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

    /// @notice Compute clearing amount and direction from displacement formula.
    /// Uses weight vector: displacement_0 = value_0 - (w_0 * NAV).
    /// All values in asset0 terms; uniPrice converts asset1 to asset0.
    function _computeClearingAmount(uint256 uniPrice) internal view returns (uint256 clearingAmount, bool clearAsset0) {
        if (uniPrice == 0) return (0, false);

        address _eulerAccount = eulerAccount;

        // Read vault positions
        uint256 deposit0 = IEVault(supplyVault0).convertToAssets(IEVault(supplyVault0).balanceOf(_eulerAccount));
        uint256 deposit1 = IEVault(supplyVault1).convertToAssets(IEVault(supplyVault1).balanceOf(_eulerAccount));
        uint256 debt0;
        if (borrowVault0 != address(0)) debt0 = IEVault(borrowVault0).debtOf(_eulerAccount);
        uint256 debt1;
        if (borrowVault1 != address(0)) debt1 = IEVault(borrowVault1).debtOf(_eulerAccount);

        // Net positions in native units
        // value_0 = (deposit0 - debt0) in asset0 terms
        // value_1 = (deposit1 - debt1) * uniPrice / WAD in asset0 terms
        // NAV = value_0 + value_1
        int256 value0 = int256(deposit0) - int256(debt0);
        int256 value1InAsset0 = (int256(deposit1) - int256(debt1)) * int256(uniPrice) / int256(WAD);
        int256 nav = value0 + value1InAsset0;

        if (nav <= 0) return (0, false);

        // displacement_0 = value_0 - (w_0 * NAV / WAD)
        int256 target0 = weightW0 * nav / int256(WAD);
        int256 displacement0 = value0 - target0;

        // Minimum displacement threshold (in asset0 units)
        uint256 absDisp = displacement0 >= 0 ? uint256(displacement0) : uint256(-displacement0);
        if (absDisp < uint256(minDisplacementThreshold)) return (0, false);

        if (displacement0 > 0) {
            // Over-target in asset0: pool needs to lose asset0
            // Clearing direction: asset1 in → asset0 out (arber buys excess asset0)
            // clearingAmount in asset0 units = displacement0
            clearAsset0 = false;
            clearingAmount = uint256(displacement0);
        } else {
            // Under-target in asset0: pool needs to gain asset0
            // Clearing direction: asset0 in → asset1 out (arber sells asset0 to pool)
            // clearingAmount in asset1 units = |displacement0| * WAD / uniPrice
            clearAsset0 = true;
            clearingAmount = absDisp.mulDiv(WAD, uniPrice);
        }
    }

    // =========================================================================
    // Internal: auction end
    // =========================================================================

    /// @notice End auction successfully: restore curved pool, recenter, apply surcharge.
    function _endAuctionSuccess(uint112 reserve0, uint112 reserve1) internal {
        auctionActive = false;
        auctionEndBlock = uint64(block.number);

        uint256 uniPrice = _getUniswapPrice();
        if (uniPrice == 0) {
            emit AuctionEnded(uint64(block.number));
            return;
        }

        IEulerSwap.DynamicParams memory d = IEulerSwap(pool).getDynamicParams();

        // Restore normal concentration
        d.concentrationX = savedConcentrationX;
        d.concentrationY = savedConcentrationY;

        // Recenter at market with drift clamp
        uint256 oldPriceRatio = uint256(d.priceX) * WAD / uint256(d.priceY);
        uint256 newPriceY = uint256(d.priceX).mulDiv(WAD, uniPrice);

        // Clamp drift
        uint256 _maxDrift = uint256(maxRecenterDrift);
        uint80 preAuctionPriceY = d.priceY;
        if (_maxDrift > 0 && uint256(preAuctionPriceY) > 0) {
            uint256 maxPY = uint256(preAuctionPriceY) * (WAD + _maxDrift) / WAD;
            uint256 minPY = uint256(preAuctionPriceY) * WAD / (WAD + _maxDrift);
            if (newPriceY > maxPY) newPriceY = maxPY;
            if (newPriceY < minPY) newPriceY = minPY;
        }

        uint256 recenterMag;
        if (newPriceY > 0 && uint256(preAuctionPriceY) > 0) {
            uint256 actualPrice = uint256(d.priceX) * WAD / newPriceY;
            recenterMag = actualPrice > oldPriceRatio
                ? (actualPrice - oldPriceRatio) * WAD / actualPrice
                : (oldPriceRatio - actualPrice) * WAD / oldPriceRatio;
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

        // Post-auction surcharge: price component from recenter magnitude
        uint256 surchargeAmount = recenterMag * uint256(surchargeMultiplier) / WAD;
        uint256 floor = uint256(baseFee);
        if (surchargeAmount < floor) surchargeAmount = floor;
        surchargeInitialAmount = uint64(surchargeAmount > type(uint64).max ? type(uint64).max : surchargeAmount);
        surchargeStartBlock = uint64(block.number);
        emit AuctionEnded(uint64(block.number));
    }

    // =========================================================================
    // Internal: trigger coordinate computation (strategy-agnostic, curve-based)
    // =========================================================================

    /// @notice Compute reserve coordinates where marginal price crosses trigger threshold.
    /// Strategy-agnostic: uses only curve math and triggerFraction.
    ///
    /// For X branch (price up → reserve0 decreases):
    ///   triggerPrice = eqPrice * (1 + triggerFraction)
    ///   triggerReserve0 = x0 / sqrt((triggerPrice * py / px - cx) / (1 - cx))
    ///
    /// For Y branch (price down → reserve1 decreases):
    ///   triggerPrice = eqPrice * (1 - triggerFraction)
    ///   triggerReserve1 = y0 / sqrt((px / (py * triggerPrice) - cy) / (1 - cy))
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

        // X branch: price up by triggerFraction
        // triggerPrice = (px/py) * (1 + frac) = px * (WAD + frac) / (py * WAD)
        // inner = (triggerPrice * py / px - cx) / (1 - cx)
        //       = ((WAD + frac) - cx) / (WAD - cx)    [simplified: triggerPrice * py/px = (WAD + frac)/WAD * ... ]
        // Actually: triggerPrice * py / px = (WAD + frac) / WAD
        // So: inner = ((WAD + frac) / WAD - cx/WAD) / ((WAD - cx)/WAD)
        //           = (WAD + frac - cx) / (WAD - cx)
        uint112 trig0;
        if (cx < WAD) {
            uint256 innerX = (WAD + frac - cx) * WAD / (WAD - cx);
            if (innerX > WAD) {
                // triggerReserve0 = x0 / sqrt(innerX / WAD) = x0 * sqrt(WAD) / sqrt(innerX)
                uint256 sqrtInner = innerX.sqrt();
                trig0 = uint112(x0 * SQRT_WAD / sqrtInner);
            }
        }

        // Y branch: price down by triggerFraction
        // triggerPrice = (px/py) * (1 - frac)
        // For solveYForPrice: inner = (px / (py * triggerPrice) - cy) / (1 - cy)
        // px / (py * triggerPrice) = px / (py * px/py * (WAD - frac)/WAD) = WAD / (WAD - frac)
        // So: inner = (WAD / (WAD - frac) - cy/WAD) / ((WAD - cy)/WAD)
        //           = (WAD * WAD / (WAD - frac) - cy) / (WAD - cy)
        uint112 trig1;
        if (cy < WAD && frac < WAD) {
            uint256 invFrac = WAD * WAD / (WAD - frac); // WAD / (1 - frac) in WAD scale
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
    // Internal: fee computation
    // =========================================================================

    function _computeNormalFee(bool asset0IsInput, uint112 reserve0, uint112 reserve1)
        internal
        view
        returns (uint256)
    {
        uint256 computedFee = uint256(baseFee);

        uint256 _captureRate = captureRate;
        uint256 _attractRate = attractRate;

        if (_captureRate > 0 || _attractRate > 0) {
            uint256 uniPrice = _getUniswapPrice();
            if (uniPrice > 0) {
                IEulerSwap.DynamicParams memory d = IEulerSwap(pool).getDynamicParams();
                uint256 marginalPrice = _getMarginalPrice(reserve0, reserve1, d);

                uint256 mismatch;
                bool isArbDirection;

                if (uniPrice > marginalPrice) {
                    mismatch = ((uniPrice - marginalPrice) * WAD) / uniPrice;
                    isArbDirection = !asset0IsInput;
                } else {
                    mismatch = ((marginalPrice - uniPrice) * WAD) / uniPrice;
                    isArbDirection = asset0IsInput;
                }

                if (isArbDirection && _captureRate > 0) {
                    uint256 effectiveThreshold = uint256(gasCoeff) * tx.gasprice.sqrt();
                    uint256 totalCost = effectiveThreshold + uint256(baseFee) + uint256(externalFee);
                    if (mismatch > totalCost) {
                        computedFee += (_captureRate * (mismatch - totalCost)) / WAD;
                    }
                } else if (!isArbDirection && _attractRate > 0) {
                    uint256 headroom = mismatch + uint256(externalFee);
                    computedFee += (_attractRate * headroom) / WAD;
                }
            }
        }

        if (computedFee > uint256(maxFee)) computedFee = uint256(maxFee);
        return computedFee;
    }

    function _currentSurcharge() internal view returns (uint256) {
        uint64 _surchargeStart = surchargeStartBlock;
        if (_surchargeStart == 0) return 0;

        uint256 _initial = uint256(surchargeInitialAmount);
        if (_initial == 0) return 0;

        uint256 decayed = (block.number - uint256(_surchargeStart)) * uint256(surchargeDecayPerBlock);
        return decayed >= _initial ? 0 : _initial - decayed;
    }

    // =========================================================================
    // Internal: NAV computation
    // =========================================================================

    /// @notice Compute NAV = total deposits - total debts, all in asset0 terms.
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

    /// @notice Concentration-aware marginal price.
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

    /// @notice |a - b| / max(a, b) in WAD scale.
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

    function getSurchargeParams()
        external
        view
        returns (uint64 _surchargeDecayPerBlock, uint64 _surchargeMultiplier)
    {
        return (surchargeDecayPerBlock, surchargeMultiplier);
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

    function getSurchargeState() external view returns (uint64 _startBlock, uint256 _surcharge) {
        return (surchargeStartBlock, _currentSurcharge());
    }

    function getDisplacementState()
        external
        view
        returns (uint128 _cachedNav, int256 _weightW0)
    {
        return (cachedNav, weightW0);
    }

    /// @notice Current displacement from target, computed from live vault state.
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
