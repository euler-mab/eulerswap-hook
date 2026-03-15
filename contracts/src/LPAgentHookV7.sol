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

/// @title LPAgentHookV7 — Clean exposure tracking + curvature-aware surcharge
/// @notice Two mechanisms:
///   1. Continuous recenter: on every swap that reduces exposure, recenter immediately.
///      Smart surcharge covers both curvature bonus (displacement) and oracle price change.
///   2. Clearing auction (fallback): when relative exposure exceeds trigger,
///      exposure-sized shift creates arb → fee-decay auction → recenter.
///
/// Key improvements over V6:
///   - NAV (deposits - debts) as exposure denominator, not gross deposits
///   - Exposure-sized auction shifts, not fixed shiftMagnitude
///   - Curvature-aware surcharge prevents round-trip extraction through recenters
///   - surchargeInitialAmount is computed per-recenter (mutable state, not param)
///
/// Pool sets swapHookedOperations = GET_FEE | AFTER_SWAP (0x06).
contract LPAgentHookV7 is IEulerSwapHookTarget {
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
    uint64 public auctionTriggerThreshold; // WAD: relative exposure threshold to start auction
    uint64 public clearThreshold; // WAD: price convergence to end auction
    uint64 public maxShiftMagnitude; // WAD: cap on exposure-computed shift
    uint64 public minAuctionBlocks;

    // --- Recenter parameters (owner-updatable) ---
    uint64 public recenterRange;
    uint64 public maxRecenterDrift;
    uint64 public minRecenterDelta; // WAD: minimum exposure decrease to trigger recenter

    // --- Mutable state: exposure tracking ---
    uint64 public lastExposure; // WAD: vault-based relative exposure after previous swap
    bool public lastNetLongWeth; // direction at last exposure measurement
    int128 public baseNetAsset1; // net WETH at last recenter (deposits1 - debts1)
    uint128 public cachedNav; // NAV in asset0 terms at last recenter

    // --- Mutable state: surcharge ---
    uint64 public surchargeStartBlock;
    uint64 public surchargeInitialAmount; // computed per-recenter, not a param

    // --- Mutable state: auction ---
    bool public auctionActive;
    uint64 public auctionStartBlock;
    uint64 public auctionStartingFee;
    bool public auctionClearAsset0;
    uint80 public preShiftPriceY;

    // --- Events ---
    event FeeParamsUpdated(
        uint64 baseFee, uint64 maxFee, uint64 gasCoeff, uint64 externalFee, uint256 captureRate, uint256 attractRate
    );
    event AuctionParamsUpdated(
        uint64 decayPerBlock, uint64 auctionTriggerThreshold, uint64 clearThreshold, uint64 maxShiftMagnitude,
        uint64 minAuctionBlocks
    );
    event RecenterParamsUpdated(uint64 recenterRange, uint64 maxRecenterDrift, uint64 minRecenterDelta);
    event SurchargeParamsUpdated(uint64 surchargeDecayPerBlock, uint64 surchargeMultiplier);
    event AuctionStarted(uint64 startingFee, uint64 blockNumber, bool clearAsset0);
    event AuctionEnded(uint64 blockNumber);
    event Recentered(uint64 blockNumber);

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
        uint64 auctionTriggerThreshold;
        uint64 clearThreshold;
        uint64 maxShiftMagnitude;
        uint64 minAuctionBlocks;
        uint64 recenterRange;
        uint64 maxRecenterDrift;
        uint64 minRecenterDelta;
        uint64 surchargeDecayPerBlock;
        uint64 surchargeMultiplier;
        uint64 deploySurcharge;
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
        auctionTriggerThreshold = _auctionConfig.auctionTriggerThreshold;
        clearThreshold = _auctionConfig.clearThreshold;
        maxShiftMagnitude = _auctionConfig.maxShiftMagnitude;
        minAuctionBlocks = _auctionConfig.minAuctionBlocks;
        recenterRange = _auctionConfig.recenterRange;
        maxRecenterDrift = _auctionConfig.maxRecenterDrift;
        minRecenterDelta = _auctionConfig.minRecenterDelta;
        surchargeDecayPerBlock = _auctionConfig.surchargeDecayPerBlock;
        require(_auctionConfig.surchargeMultiplier <= 10e18, "surchargeMultiplier too large");
        surchargeMultiplier = _auctionConfig.surchargeMultiplier;

        IEulerSwap.StaticParams memory sParams = IEulerSwap(_pool).getStaticParams();
        supplyVault0 = sParams.supplyVault0;
        supplyVault1 = sParams.supplyVault1;
        borrowVault0 = sParams.borrowVault0;
        borrowVault1 = sParams.borrowVault1;
        eulerAccount = sParams.eulerAccount;
        asset0 = IEVault(sParams.supplyVault0).asset();
        asset1 = IEVault(sParams.supplyVault1).asset();

        // Init vault state
        _cacheVaultState(_getUniswapPrice());

        // Deployment protection surcharge — starts high so mispriced deploys are expensive
        // to arb, giving the deployer time to detect and correct.
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
    function getFee(bool asset0IsInput, uint112 reserve0, uint112 reserve1, bool)
        external
        view
        override
        returns (uint64 fee)
    {
        if (auctionActive) {
            uint256 elapsed = block.number - uint256(auctionStartBlock);
            uint256 decayed = elapsed * uint256(decayPerBlock);
            uint256 auctionFee;
            if (decayed >= uint256(auctionStartingFee)) {
                auctionFee = uint256(baseFee);
            } else {
                uint256 raw = uint256(auctionStartingFee) - decayed;
                auctionFee = raw > uint256(baseFee) ? raw : uint256(baseFee);
            }

            if (asset0IsInput == auctionClearAsset0) {
                return uint64(auctionFee > uint256(maxFee) ? uint256(maxFee) : auctionFee);
            } else {
                uint256 normalFee = _computeNormalFee(asset0IsInput, reserve0, reserve1);
                uint256 effectiveFee = normalFee > auctionFee ? normalFee : auctionFee;
                return uint64(effectiveFee > uint256(maxFee) ? uint256(maxFee) : effectiveFee);
            }
        }

        uint256 computedFee = _computeNormalFee(asset0IsInput, reserve0, reserve1);
        computedFee += _currentSurcharge();
        if (computedFee > uint256(maxFee)) computedFee = uint256(maxFee);
        return uint64(computedFee);
    }

    /// @notice afterSwap: continuous recenter on improvement, auction as fallback.
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
            if (block.number >= uint256(auctionStartBlock) + uint256(minAuctionBlocks)) {
                (bool converged, uint256 uniPrice) = _checkPriceConvergence(reserve0, reserve1);
                if (converged) {
                    _endAuctionAndRecenter(reserve0, reserve1, uniPrice);
                }
            }
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
        uint64 _auctionTriggerThreshold,
        uint64 _clearThreshold,
        uint64 _maxShiftMagnitude,
        uint64 _minAuctionBlocks
    ) external onlyOwner {
        require(_clearThreshold < _maxShiftMagnitude, "clear threshold must be < max shift magnitude");
        decayPerBlock = _decayPerBlock;
        auctionTriggerThreshold = _auctionTriggerThreshold;
        clearThreshold = _clearThreshold;
        maxShiftMagnitude = _maxShiftMagnitude;
        minAuctionBlocks = _minAuctionBlocks;
        emit AuctionParamsUpdated(
            _decayPerBlock, _auctionTriggerThreshold, _clearThreshold, _maxShiftMagnitude, _minAuctionBlocks
        );
    }

    function setRecenterParams(uint64 _recenterRange, uint64 _maxRecenterDrift, uint64 _minRecenterDelta)
        external
        onlyOwner
    {
        recenterRange = _recenterRange;
        maxRecenterDrift = _maxRecenterDrift;
        minRecenterDelta = _minRecenterDelta;
        emit RecenterParamsUpdated(_recenterRange, _maxRecenterDrift, _minRecenterDelta);
    }

    function setSurchargeParams(uint64 _surchargeDecayPerBlock, uint64 _surchargeMultiplier) external onlyOwner {
        require(_surchargeMultiplier <= 10e18, "surchargeMultiplier too large");
        surchargeDecayPerBlock = _surchargeDecayPerBlock;
        surchargeMultiplier = _surchargeMultiplier;
        emit SurchargeParamsUpdated(_surchargeDecayPerBlock, _surchargeMultiplier);
    }

    /// @notice Owner can force-end a stuck auction (emergency).
    /// Recenters at market, restores min reserves, refreshes vault state, sets surcharge.
    function endAuction() external onlyOwner {
        auctionActive = false;

        // Try to recenter at market price
        (uint112 r0, uint112 r1,) = IEulerSwap(pool).getReserves();
        uint256 uniPrice = _getUniswapPrice();
        if (uniPrice > 0) {
            IEulerSwap.DynamicParams memory d = IEulerSwap(pool).getDynamicParams();
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

        _cacheVaultState(uniPrice);
        surchargeStartBlock = uint64(block.number);
        surchargeInitialAmount = baseFee;
        lastExposure = 0;
        emit AuctionEnded(uint64(block.number));
    }

    /// @notice Owner can refresh vault state to correct for interest accrual drift
    function refreshVaultState() external onlyOwner {
        _cacheVaultState(_getUniswapPrice());
    }

    // =========================================================================
    // Internal: normal mode — continuous recenter on improvement
    // =========================================================================

    function _handleNormalMode(uint112 reserve0, uint112 reserve1) internal {
        uint256 uniPrice = _getUniswapPrice();
        IEulerSwap.DynamicParams memory d = IEulerSwap(pool).getDynamicParams();
        (uint256 relExposure, uint256 absExposure, bool netLongWeth) =
            _computeVaultExposure(reserve1, d, uniPrice);

        uint256 last = uint256(lastExposure);

        if (relExposure < last) {
            // Exposure decreased — check if recenter is warranted
            bool shouldRecenter = true;

            // Gate 1: minimum delta — skip noise recenters
            if (last - relExposure < uint256(minRecenterDelta)) {
                shouldRecenter = false;
            }

            // Gate 2: sign flip — exposure decreased by crossing zero, not moving toward zero.
            // E.g. long 60% → short 10% is a decrease but not an improvement — pool just
            // crossed through neutral and is building exposure in the new direction.
            if (last > 0 && netLongWeth != lastNetLongWeth) {
                shouldRecenter = false;
            }

            if (shouldRecenter) {
                uint112 preEq0 = d.equilibriumReserve0;
                uint112 preEq1 = d.equilibriumReserve1;
                uint256 recenterMag = _recenterAtMarket(reserve0, reserve1, d, uniPrice);
                _initSurcharge(recenterMag, reserve0, reserve1, preEq0, preEq1, d);
                _cacheVaultState(uniPrice);

                // Measure post-recenter vault exposure (d was mutated in-place by _recenterAtMarket)
                (uint256 postExposure,, bool postDir) = _computeVaultExposure(reserve1, d, uniPrice);
                lastExposure = uint64(postExposure > type(uint64).max ? type(uint64).max : postExposure);
                lastNetLongWeth = postDir;
            } else {
                // Just update tracking without recentering
                lastExposure = uint64(relExposure > type(uint64).max ? type(uint64).max : relExposure);
                lastNetLongWeth = netLongWeth;
            }
        } else {
            lastExposure = uint64(relExposure > type(uint64).max ? type(uint64).max : relExposure);
            lastNetLongWeth = netLongWeth;

            if (relExposure > uint256(auctionTriggerThreshold)) {
                _startAuction(reserve0, reserve1, netLongWeth, d, absExposure, uniPrice);
            }
        }
    }

    // =========================================================================
    // Internal: recenter at market price
    // =========================================================================

    /// @notice Recenter: set eq = current reserves, align priceY to oracle, set min reserves.
    /// @return recenterMagnitude WAD-scaled relative price change |newPrice - oldPrice| / max(new, old)
    function _recenterAtMarket(uint112 reserve0, uint112 reserve1, IEulerSwap.DynamicParams memory d, uint256 uniPrice)
        internal
        returns (uint256 recenterMagnitude)
    {
        if (uniPrice == 0) return 0;

        uint256 oldPriceRatio = uint256(d.priceX) * WAD / uint256(d.priceY);
        uint256 newPriceY = uint256(d.priceX).mulDiv(WAD, uniPrice);
        if (newPriceY == 0 || newPriceY > type(uint80).max) return 0;

        // Magnitude = |newPrice - oldPrice| / max(newPrice, oldPrice)
        recenterMagnitude = uniPrice > oldPriceRatio
            ? (uniPrice - oldPriceRatio) * WAD / uniPrice
            : (oldPriceRatio - uniPrice) * WAD / oldPriceRatio;

        d.priceY = uint80(newPriceY);
        d.equilibriumReserve0 = reserve0;
        d.equilibriumReserve1 = reserve1;
        _setMinReservesFromRange(d, reserve0, reserve1);

        try IEulerSwap(pool).reconfigure(d, IEulerSwap.InitialState(reserve0, reserve1)) {
            emit Recentered(uint64(block.number));
        } catch {
            recenterMagnitude = 0;
        }
    }

    // =========================================================================
    // Internal: smart surcharge — covers curvature bonus + price change
    // =========================================================================

    /// @notice Compute surcharge from two components:
    /// 1. Curvature bonus: (1-c) × [(eq/reserve)² − 1] — exact value extractable from curve flattening
    /// 2. Price change: recenterMagnitude — value from oracle price realignment
    /// Total scaled by surchargeMultiplier for safety margin.
    function _initSurcharge(
        uint256 recenterMagnitude,
        uint112 reserve0,
        uint112 reserve1,
        uint112 preEq0,
        uint112 preEq1,
        IEulerSwap.DynamicParams memory d
    ) internal {
        uint256 curvatureComponent;
        {
            uint256 eq0 = uint256(preEq0);
            uint256 eq1 = uint256(preEq1);
            uint256 r0 = uint256(reserve0);
            uint256 r1 = uint256(reserve1);

            if (r0 < eq0 && r0 > 0) {
                // X branch: displaced toward asset0 boundary
                uint256 ratioSqWad = eq0.mulDiv(eq0, r0).mulDiv(WAD, r0);
                uint256 cx = uint256(d.concentrationX);
                curvatureComponent = (WAD - cx) * (ratioSqWad - WAD) / WAD;
            } else if (r1 < eq1 && r1 > 0) {
                // Y branch: displaced toward asset1 boundary
                uint256 ratioSqWad = eq1.mulDiv(eq1, r1).mulDiv(WAD, r1);
                uint256 cy = uint256(d.concentrationY);
                curvatureComponent = (WAD - cy) * (ratioSqWad - WAD) / WAD;
            }
            // At equilibrium (r0 == eq0 && r1 == eq1): curvatureComponent = 0
        }

        uint256 priceComponent = recenterMagnitude;

        uint256 amount = (curvatureComponent + priceComponent) * uint256(surchargeMultiplier) / WAD;

        // Floor: baseFee / 2
        uint256 floor = uint256(baseFee) / 2;
        if (amount < floor) amount = floor;

        surchargeInitialAmount = uint64(amount > type(uint64).max ? type(uint64).max : amount);
        surchargeStartBlock = uint64(block.number);
    }

    // =========================================================================
    // Internal: auction (fallback for sustained directional moves)
    // =========================================================================

    /// @notice Start clearing auction with exposure-sized shift.
    function _startAuction(
        uint112 reserve0,
        uint112 reserve1,
        bool netLongWeth,
        IEulerSwap.DynamicParams memory d,
        uint256 absExposureWeth,
        uint256 uniPrice
    ) internal {
        // Compute shift from actual absolute exposure
        uint256 shift = _computeAuctionShift(absExposureWeth, d.equilibriumReserve1);

        // Recenter priceY at market before shifting
        if (uniPrice > 0) {
            uint256 marketPriceY = uint256(d.priceX).mulDiv(WAD, uniPrice);
            if (marketPriceY > 0 && marketPriceY <= type(uint80).max) {
                d.priceY = uint80(marketPriceY);
            }
        }

        preShiftPriceY = d.priceY;

        // Shift priceY past market to create deliberate mispricing
        if (netLongWeth) {
            d.priceY = uint80(uint256(d.priceY) * WAD / (WAD + shift));
        } else {
            d.priceY = uint80(uint256(d.priceY) * (WAD + shift) / WAD);
        }

        // Relax boundaries during auction
        d.minReserve0 = 0;
        d.minReserve1 = 0;
        d.equilibriumReserve0 = reserve0;
        d.equilibriumReserve1 = reserve1;

        try IEulerSwap(pool).reconfigure(d, IEulerSwap.InitialState(reserve0, reserve1)) {
            uint256 startFee = shift * 3 / 2;
            if (startFee > uint256(maxFee)) startFee = uint256(maxFee);
            if (startFee < uint256(baseFee)) startFee = uint256(baseFee);
            auctionActive = true;
            auctionStartBlock = uint64(block.number);
            auctionStartingFee = uint64(startFee);
            auctionClearAsset0 = netLongWeth;
            lastExposure = 0;
            emit AuctionStarted(auctionStartingFee, uint64(block.number), netLongWeth);
        } catch {}
    }

    /// @notice Compute auction shift sized to actual exposure, capped at maxShiftMagnitude.
    function _computeAuctionShift(uint256 absExposureWeth, uint112 eq1) internal view returns (uint256) {
        if (eq1 == 0) return uint256(maxShiftMagnitude);
        uint256 shift = absExposureWeth.mulDiv(WAD, uint256(eq1));
        if (shift > uint256(maxShiftMagnitude)) shift = uint256(maxShiftMagnitude);
        uint256 floor = uint256(clearThreshold) * 2;
        if (shift < floor) shift = floor;
        return shift;
    }

    /// @notice Check if marginal price converged to oracle within clearThreshold.
    /// @return converged True if price difference < clearThreshold.
    /// @return uniPrice The oracle price (passed through to avoid redundant SLOAD in caller).
    function _checkPriceConvergence(uint112 reserve0, uint112 reserve1)
        internal
        view
        returns (bool converged, uint256 uniPrice)
    {
        uniPrice = _getUniswapPrice();
        if (uniPrice == 0) return (false, 0);

        IEulerSwap.DynamicParams memory d = IEulerSwap(pool).getDynamicParams();
        uint256 marginalPrice = _getMarginalPrice(reserve0, reserve1, d);
        uint256 priceDiff;
        if (uniPrice > marginalPrice) {
            priceDiff = (uniPrice - marginalPrice) * WAD / uniPrice;
        } else {
            priceDiff = (marginalPrice - uniPrice) * WAD / uniPrice;
        }
        converged = priceDiff < uint256(clearThreshold);
    }

    /// @notice End auction and recenter at market with drift clamp.
    /// @param uniPrice Oracle price from _checkPriceConvergence (avoids redundant SLOAD).
    function _endAuctionAndRecenter(uint112 reserve0, uint112 reserve1, uint256 uniPrice) internal {
        auctionActive = false;

        // Compute recenter magnitude from preShiftPriceY for surcharge
        uint256 _preShiftPY = uint256(preShiftPriceY);
        uint256 recenterMag;

        if (uniPrice > 0) {
            IEulerSwap.DynamicParams memory d = IEulerSwap(pool).getDynamicParams();
            uint256 newPriceY = uint256(d.priceX).mulDiv(WAD, uniPrice);

            // Clamp to within maxRecenterDrift of pre-shift priceY
            uint256 _maxDrift = uint256(maxRecenterDrift);
            if (_preShiftPY > 0 && _maxDrift > 0) {
                uint256 maxPY = _preShiftPY * (WAD + _maxDrift) / WAD;
                uint256 minPY = _preShiftPY * WAD / (WAD + _maxDrift);
                if (newPriceY > maxPY) newPriceY = maxPY;
                if (newPriceY < minPY) newPriceY = minPY;
            }

            // Compute recenter magnitude from clamped price (not raw oracle)
            if (_preShiftPY > 0 && newPriceY > 0) {
                uint256 preShiftPrice = uint256(d.priceX) * WAD / _preShiftPY;
                uint256 actualPrice = uint256(d.priceX) * WAD / newPriceY;
                recenterMag = actualPrice > preShiftPrice
                    ? (actualPrice - preShiftPrice) * WAD / actualPrice
                    : (preShiftPrice - actualPrice) * WAD / preShiftPrice;
            }

            if (newPriceY > 0 && newPriceY <= type(uint80).max) {
                d.priceY = uint80(newPriceY);
            }

            d.equilibriumReserve0 = reserve0;
            d.equilibriumReserve1 = reserve1;
            _setMinReservesFromRange(d, reserve0, reserve1);

            try IEulerSwap(pool).reconfigure(d, IEulerSwap.InitialState(reserve0, reserve1)) {
                emit Recentered(uint64(block.number));
                _cacheVaultState(uniPrice);
            } catch {}
        }

        // Measure actual post-recenter vault exposure
        {
            IEulerSwap.DynamicParams memory dPost = IEulerSwap(pool).getDynamicParams();
            (uint256 postExposure,, bool postDir) = _computeVaultExposure(reserve1, dPost, uniPrice);
            lastExposure = uint64(postExposure > type(uint64).max ? type(uint64).max : postExposure);
            lastNetLongWeth = postDir;
        }

        // Post-auction surcharge: derived from actual price displacement
        uint256 surchargeAmount = recenterMag * uint256(surchargeMultiplier) / WAD;
        uint256 floor = uint256(baseFee);
        if (surchargeAmount < floor) surchargeAmount = floor;
        surchargeInitialAmount = uint64(surchargeAmount > type(uint64).max ? type(uint64).max : surchargeAmount);
        surchargeStartBlock = uint64(block.number);
        emit AuctionEnded(uint64(block.number));
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
    // Internal: exposure computation
    // =========================================================================

    /// @notice Vault-based exposure: relative (for trigger), absolute (for auction sizing), and direction.
    /// @return relExposure |netWeth| * ethPrice / cachedNav (WAD). Can exceed 100%.
    /// @return absExposureWeth |baseNetAsset1 + displacement| in WETH units.
    /// @return netLongWeth true if pool is net long WETH (needs to sell WETH to clear).
    function _computeVaultExposure(uint112 reserve1, IEulerSwap.DynamicParams memory d, uint256 uniPrice)
        internal
        view
        returns (uint256 relExposure, uint256 absExposureWeth, bool netLongWeth)
    {
        uint256 eq1 = uint256(d.equilibriumReserve1);
        int256 curNet1 = int256(baseNetAsset1) + int256(uint256(reserve1)) - int256(eq1);
        netLongWeth = curNet1 >= 0;
        absExposureWeth = netLongWeth ? uint256(curNet1) : uint256(-curNet1);

        if (uniPrice == 0) return (0, absExposureWeth, netLongWeth);

        uint256 exposureAsset0 = absExposureWeth.mulDiv(WAD, uniPrice);

        uint256 nav = uint256(cachedNav);
        if (nav == 0) return (type(uint256).max, absExposureWeth, netLongWeth);

        relExposure = exposureAsset0.mulDiv(WAD, nav);
    }

    // =========================================================================
    // Internal: vault state caching
    // =========================================================================

    /// @notice Cache net asset1 (WETH) and NAV. Called at each recenter.
    function _cacheVaultState(uint256 uniPrice) internal {
        address _eulerAccount = eulerAccount;

        // Cache baseNetAsset1 (WETH position)
        uint256 deposit1 = IEVault(supplyVault1).convertToAssets(IEVault(supplyVault1).balanceOf(_eulerAccount));
        uint256 debt1;
        address _bv1 = borrowVault1;
        if (_bv1 != address(0)) debt1 = IEVault(_bv1).debtOf(_eulerAccount);
        int256 net = int256(deposit1) - int256(debt1);
        require(net >= type(int128).min && net <= type(int128).max, "baseNetAsset1 overflow");
        baseNetAsset1 = int128(net);

        // Cache NAV (deposits - debts in asset0 terms); preserve on oracle failure
        uint128 newNav = _computeNav(uniPrice);
        if (newNav > 0) cachedNav = newNav;
    }

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

        // All in asset0 terms
        uint256 totalDeposits = deposit0 + deposit1.mulDiv(WAD, uniPrice);
        uint256 totalDebts = debt0 + debt1.mulDiv(WAD, uniPrice);
        if (totalDebts >= totalDeposits) return 0; // underwater
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
        // V4 StateLibrary: slot0 is at keccak256(abi.encode(poolId, POOLS_SLOT))
        // POOLS_SLOT = bytes32(uint256(6)) in PoolManager
        bytes32 stateSlot = keccak256(abi.encode(oracleV4PoolId, bytes32(uint256(6))));
        try IExtsload(oracleTarget).extsload(stateSlot) returns (bytes32 packed) {
            return uint160(uint256(packed));
        } catch {
            return 0;
        }
    }

    /// @notice Concentration-aware marginal price.
    /// X branch (reserve0 <= eq0): price = (px/py) × [cx + (1-cx) × (x0/x)²]
    /// Y branch (reserve0 > eq0):  price = (px/py) / [cy + (1-cy) × (y0/y)²]
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
            // price = (px/py) × [cx + (1-cx) × (x0/x)²]
            uint256 r0 = uint256(reserve0);
            uint256 quadTerm = (WAD - cx).mulDiv(x0 * x0, r0 * r0); // (1-cx) × (x0/x)²  [WAD scale]
            uint256 bracketWad = cx + quadTerm; // cx + (1-cx)(x0/x)²  [WAD scale]
            return px.mulDiv(bracketWad, py); // (px/py) × bracket  [WAD scale]
        } else {
            if (y0 == 0) return 0;
            uint256 cy = uint256(d.concentrationY);
            // price = (px/py) / [cy + (1-cy) × (y0/y)²]
            uint256 r1 = uint256(reserve1);
            uint256 quadTerm = (WAD - cy).mulDiv(y0 * y0, r1 * r1); // (1-cy) × (y0/y)²  [WAD scale]
            uint256 bracketWad = cy + quadTerm; // cy + (1-cy)(y0/y)²  [WAD scale]
            return px.mulDiv(WAD, py).mulDiv(WAD, bracketWad); // (px/py) / bracket  [WAD scale]
        }
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
            uint64 _auctionTriggerThreshold,
            uint64 _clearThreshold,
            uint64 _maxShiftMagnitude,
            uint64 _minAuctionBlocks
        )
    {
        return (decayPerBlock, auctionTriggerThreshold, clearThreshold, maxShiftMagnitude, minAuctionBlocks);
    }

    function getRecenterParams()
        external
        view
        returns (uint64 _recenterRange, uint64 _maxRecenterDrift, uint64 _minRecenterDelta)
    {
        return (recenterRange, maxRecenterDrift, minRecenterDelta);
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
        returns (bool _active, uint64 _startBlock, uint64 _startingFee, bool _clearAsset0)
    {
        return (auctionActive, auctionStartBlock, auctionStartingFee, auctionClearAsset0);
    }

    function getSurchargeState() external view returns (uint64 _startBlock, uint256 _surcharge) {
        return (surchargeStartBlock, _currentSurcharge());
    }

    function getExposureState()
        external
        view
        returns (uint64 _lastExposure, int128 _baseNetAsset1, uint128 _cachedNav)
    {
        return (lastExposure, baseNetAsset1, cachedNav);
    }

    /// @notice Current vault exposure for monitoring.
    /// @return relExposure Relative exposure (WAD), absExposureWeth Absolute (WETH), netLongWeth direction.
    function computeCurrentVaultExposure()
        external
        view
        returns (uint256 relExposure, uint256 absExposureWeth, bool netLongWeth)
    {
        (, uint112 r1,) = IEulerSwap(pool).getReserves();
        IEulerSwap.DynamicParams memory d = IEulerSwap(pool).getDynamicParams();
        return _computeVaultExposure(r1, d, _getUniswapPrice());
    }
}
