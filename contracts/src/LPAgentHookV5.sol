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

/// @title LPAgentHookV5 — Autonomous two-mode hook with debt-aware clearing
/// @notice V5 improvements over V4:
///   1. Dynamic shift: shift magnitude proportional to actual debt, capped at shiftMagnitude
///   2. Debt-zero clearing: auction ends when vault debt reaches zero (prevents over-clearing)
///
///         Normal mode:
///           Oracle-reactive asymmetric fees with routing-aware attract pricing.
///           Arb direction:    fee = baseFee + captureRate × max(0, netEdge)
///           Attract direction: fee = baseFee + attractRate × (mismatch + externalFee)
///           Plus additive surcharge that decays to zero after any reconfigure.
///
///         Equity clearing mode:
///           Triggered when directional exposure crosses threshold or debt/NAV exceeds threshold.
///           Step 1: Shift eq price proportional to debt to create clearing arb + fee-decay auction
///           Step 2: Fee decays per block — arbers clear exposure at minimum cost
///           Step 3: Debt reaches zero OR price converges → recenter at market + surcharge
///
///         Pool sets swapHookedOperations = GET_FEE | AFTER_SWAP (0x06).
///         No agent needed for core loop — agent only tunes parameters.
contract LPAgentHookV5 is IEulerSwapHookTarget {
    using FullMath for uint256;
    using Sqrt for uint256;

    // --- Constants ---
    uint256 constant WAD = 1e18;
    uint256 constant Q192 = 2 ** 192;
    uint256 constant Q128 = 2 ** 128;
    uint256 constant Q64 = 2 ** 64;

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
    address public immutable uniswapPool;
    bool public immutable uniswapToken0IsAsset0;

    // --- Fee parameters (owner-updatable) ---
    uint64 public baseFee; // base fee in WAD (e.g. 5e14 = 5bps)
    uint64 public maxFee; // maximum fee cap
    uint64 public gasCoeff; // threshold = gasCoeff × √(tx.gasprice)
    uint64 public externalFee; // WAD: arber's external cost floor (Uni swap fee)
    uint256 public captureRate; // WAD: fraction of net edge to capture on arb side
    uint256 public attractRate; // WAD: fraction of routing headroom to capture on attract side

    // --- Auction parameters (owner-updatable) ---
    uint64 public decayPerBlock; // WAD: fee decay per block during auction (≈ σ₁ ≈ 4.3e14)
    uint64 public triggerThreshold; // WAD: exposure fraction to start auction (e.g. 0.5e18 = 50% of range)
    uint64 public clearThreshold; // WAD: exposure fraction to end auction (e.g. 0.05e18 = 5% of range)
    uint64 public shiftMagnitude; // WAD: how far to shift eq price for clearing arb (e.g. 0.05e18 = 5%)
    uint64 public minAuctionBlocks; // minimum blocks before auction can clear (ensures fee decay)
    uint64 public recenterRange; // WAD: price range for min reserves after recenter (e.g. 0.05e18 = ±5%)

    // --- Surcharge parameters (owner-updatable) ---
    uint64 public surchargeDecayPerBlock; // WAD: surcharge decay per block
    uint64 public surchargeInitialAmount; // WAD: initial surcharge after any reconfigure

    // --- Debt trigger parameters (owner-updatable) ---
    uint64 public debtTriggerThreshold; // WAD: debt/NAV fraction to trigger clearing (e.g. 0.25e18 = 25%)

    // --- Recenter safety (owner-updatable) ---
    uint64 public maxRecenterDrift; // WAD: max allowed price change from pre-shift (e.g. 0.03e18 = 3%)

    // --- Auction state ---
    bool public auctionActive;
    uint64 public auctionStartBlock;
    uint64 public auctionStartingFee; // WAD: fee at auction start (≈ mispricing from shift)
    bool public auctionClearAsset0; // true = want asset0 in (clearing asset1-long / asset0-deficit)
    uint80 public preShiftPriceY; // priceY before the shift — reference for recenter clamping

    // --- Debt trigger state ---
    uint128 public approxNav; // approximate NAV in asset0 terms, updated on recenter

    // --- Surcharge state ---
    uint64 public surchargeStartBlock; // block when surcharge was activated

    // --- Events ---
    event FeeParamsUpdated(
        uint64 baseFee, uint64 maxFee, uint64 gasCoeff, uint64 externalFee, uint256 captureRate, uint256 attractRate
    );
    event AuctionParamsUpdated(
        uint64 decayPerBlock, uint64 triggerThreshold, uint64 clearThreshold, uint64 shiftMagnitude,
        uint64 minAuctionBlocks
    );
    event SurchargeParamsUpdated(uint64 surchargeDecayPerBlock, uint64 surchargeInitialAmount);
    event AuctionStarted(uint64 startingFee, uint64 blockNumber, bool clearAsset0);
    event AuctionEnded(uint64 blockNumber);
    event Recentered(uint64 blockNumber);

    // --- Constructor param structs (to avoid stack-too-deep) ---
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
        uint64 triggerThreshold;
        uint64 clearThreshold;
        uint64 shiftMagnitude;
        uint64 surchargeDecayPerBlock;
        uint64 surchargeInitialAmount;
        uint64 maxRecenterDrift;
        uint64 minAuctionBlocks;
        uint64 recenterRange;
        uint64 debtTriggerThreshold;
    }

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
        FeeConfig memory _feeConfig,
        AuctionConfig memory _auctionConfig
    ) {
        pool = _pool;
        owner = _owner;
        uniswapPool = _uniswapPool;
        baseFee = _feeConfig.baseFee;
        maxFee = _feeConfig.maxFee;
        gasCoeff = _feeConfig.gasCoeff;
        externalFee = _feeConfig.externalFee;
        captureRate = _feeConfig.captureRate;
        attractRate = _feeConfig.attractRate;
        decayPerBlock = _auctionConfig.decayPerBlock;
        triggerThreshold = _auctionConfig.triggerThreshold;
        clearThreshold = _auctionConfig.clearThreshold;
        shiftMagnitude = _auctionConfig.shiftMagnitude;
        surchargeDecayPerBlock = _auctionConfig.surchargeDecayPerBlock;
        surchargeInitialAmount = _auctionConfig.surchargeInitialAmount;
        maxRecenterDrift = _auctionConfig.maxRecenterDrift;
        minAuctionBlocks = _auctionConfig.minAuctionBlocks;
        recenterRange = _auctionConfig.recenterRange;
        debtTriggerThreshold = _auctionConfig.debtTriggerThreshold;

        // Cache vault and asset addresses from pool's static params
        IEulerSwap.StaticParams memory sParams = IEulerSwap(_pool).getStaticParams();
        supplyVault0 = sParams.supplyVault0;
        supplyVault1 = sParams.supplyVault1;
        borrowVault0 = sParams.borrowVault0;
        borrowVault1 = sParams.borrowVault1;
        eulerAccount = sParams.eulerAccount;
        asset0 = IEVault(sParams.supplyVault0).asset();
        asset1 = IEVault(sParams.supplyVault1).asset();

        // Determine whether Uniswap token ordering matches ours
        uniswapToken0IsAsset0 = IUniswapV3Pool(_uniswapPool).token0() == asset0;

        // Activate surcharge on deployment to protect initial configuration
        surchargeStartBlock = uint64(block.number);

        // Set initial approxNav from current vault state
        approxNav = _computeApproxNav();
    }

    // --- IEulerSwapHookTarget ---

    /// @notice Not used — no beforeSwap hook
    function beforeSwap(uint256, uint256, address, address) external pure override {
        revert("not implemented");
    }

    /// @notice Dynamic fee: two modes — normal (oracle-reactive + surcharge) and equity clearing (fee-decay auction).
    function getFee(bool asset0IsInput, uint112 reserve0, uint112 reserve1, bool)
        external
        view
        override
        returns (uint64 fee)
    {
        // --- Equity clearing mode: fee-decay auction ---
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

            bool isClearingDirection = (asset0IsInput == auctionClearAsset0);

            if (isClearingDirection) {
                // Clearing direction: decaying auction fee
                return uint64(auctionFee > uint256(maxFee) ? uint256(maxFee) : auctionFee);
            } else {
                // Non-clearing: allow at max(auctionFee, normalFee) — never undercut clearing side
                uint256 normalFee = _computeNormalFee(asset0IsInput, reserve0, reserve1);
                uint256 effectiveFee = normalFee > auctionFee ? normalFee : auctionFee;
                return uint64(effectiveFee > uint256(maxFee) ? uint256(maxFee) : effectiveFee);
            }
        }

        // --- Normal mode: oracle-reactive fees + surcharge ---
        uint256 computedFee = _computeNormalFee(asset0IsInput, reserve0, reserve1);
        computedFee += _currentSurcharge();

        if (computedFee > uint256(maxFee)) computedFee = uint256(maxFee);
        return uint64(computedFee);
    }

    /// @notice afterSwap: autonomous exposure monitoring + equity clearing lifecycle.
    /// In normal mode: checks if reserve-based exposure exceeds trigger threshold → shifts + starts auction.
    /// In auction mode: checks if marginal price has converged to oracle → recenters + activates surcharge.
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
            // --- Normal mode: reserve-based exposure trigger ---
            IEulerSwap.DynamicParams memory d = IEulerSwap(pool).getDynamicParams();
            (uint256 exposure, bool asset0Deficit) = _computeExposure(reserve0, reserve1, d);
            if (exposure > uint256(triggerThreshold)) {
                // Use reserve deficit as debt proxy for dynamic shift
                uint256 debtProxy = asset0Deficit
                    ? uint256(d.equilibriumReserve0) - uint256(reserve0)
                    : uint256(d.equilibriumReserve1) - uint256(reserve1);
                _startEquityClearing(reserve0, reserve1, asset0Deficit, d, debtProxy);
            } else {
                // --- Debt trigger: check vault-level imbalance ---
                _checkDebtTrigger(reserve0, reserve1, d);
            }
        } else {
            // --- Auction mode: debt-zero + price-convergence clearing ---
            if (block.number >= uint256(auctionStartBlock) + uint256(minAuctionBlocks)) {
                // Check 1: Debt-zero clearing — end auction when vault debt is fully cleared.
                // This prevents over-clearing: once debt hits zero, further clearing-direction
                // swaps would create opposite-side debt. Ending the auction immediately stops this.
                address clearingVault = auctionClearAsset0 ? borrowVault0 : borrowVault1;
                if (clearingVault != address(0)) {
                    uint256 remainingDebt = IEVault(clearingVault).debtOf(eulerAccount);
                    if (remainingDebt == 0) {
                        _endAuctionAndRecenter(reserve0, reserve1);
                        return;
                    }
                }

                // Check 2: Price-convergence clearing (original V4 logic).
                // The shift created a deliberate mispricing. Arbers close it by trading.
                // When marginal price converges to oracle within clearThreshold, recenter.
                uint256 uniPrice = _getUniswapPrice();
                if (uniPrice > 0) {
                    uint256 marginalPrice = _getMarginalPrice(reserve0, reserve1);
                    uint256 priceDiff;
                    if (uniPrice > marginalPrice) {
                        priceDiff = (uniPrice - marginalPrice) * WAD / uniPrice;
                    } else {
                        priceDiff = (marginalPrice - uniPrice) * WAD / uniPrice;
                    }
                    if (priceDiff < uint256(clearThreshold)) {
                        _endAuctionAndRecenter(reserve0, reserve1);
                    }
                }
            }
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
        uint64 _decayPerBlock,
        uint64 _triggerThreshold,
        uint64 _clearThreshold,
        uint64 _shiftMagnitude,
        uint64 _maxRecenterDrift,
        uint64 _minAuctionBlocks,
        uint64 _recenterRange,
        uint64 _debtTriggerThreshold
    ) external onlyOwner {
        require(_clearThreshold < _shiftMagnitude, "clear threshold must be < shift magnitude");
        decayPerBlock = _decayPerBlock;
        triggerThreshold = _triggerThreshold;
        clearThreshold = _clearThreshold;
        shiftMagnitude = _shiftMagnitude;
        maxRecenterDrift = _maxRecenterDrift;
        minAuctionBlocks = _minAuctionBlocks;
        recenterRange = _recenterRange;
        debtTriggerThreshold = _debtTriggerThreshold;
        emit AuctionParamsUpdated(
            _decayPerBlock, _triggerThreshold, _clearThreshold, _shiftMagnitude, _minAuctionBlocks
        );
    }

    function setSurchargeParams(uint64 _surchargeDecayPerBlock, uint64 _surchargeInitialAmount) external onlyOwner {
        surchargeDecayPerBlock = _surchargeDecayPerBlock;
        surchargeInitialAmount = _surchargeInitialAmount;
        emit SurchargeParamsUpdated(_surchargeDecayPerBlock, _surchargeInitialAmount);
    }

    /// @notice Owner can force-end a stuck auction (emergency)
    function endAuction() external onlyOwner {
        auctionActive = false;
        emit AuctionEnded(uint64(block.number));
    }

    // --- Internal: equity clearing lifecycle ---

    /// @notice Step 1: Recenter at market, shift past it to create clearing arb, start fee-decay auction.
    /// Shift magnitude is dynamic: proportional to debt (debtAmount/eq), capped at shiftMagnitude.
    /// For asset0 deficit: recenter → decrease py → underprices asset1 →
    ///   arbers buy asset1 from us, sending asset0 → asset0 deficit decreases.
    /// For asset1 deficit: recenter → increase py → underprices asset0 →
    ///   arbers buy asset0 from us, sending asset1 → asset1 deficit decreases.
    /// @param debtAmount Raw debt in the deficit asset's units (0 = use fixed shiftMagnitude)
    function _startEquityClearing(
        uint112 reserve0,
        uint112 reserve1,
        bool asset0Deficit,
        IEulerSwap.DynamicParams memory d,
        uint256 debtAmount
    ) internal {
        uint256 maxShift = uint256(shiftMagnitude);
        uint256 shift;

        if (debtAmount > 0) {
            // Dynamic shift: proportional to debt/eq ratio
            uint256 eq = asset0Deficit ? uint256(d.equilibriumReserve0) : uint256(d.equilibriumReserve1);
            if (eq > 0) {
                shift = debtAmount * WAD / eq;
                if (shift > maxShift) shift = maxShift;
                if (shift == 0) shift = 1; // minimum 1 wei shift
            } else {
                shift = maxShift;
            }
        } else {
            shift = maxShift;
        }

        // Step 1: Recenter priceY at market price BEFORE shifting.
        // The pool's priceY may be stale if the market moved since last reconfigure.
        // Shifting from a stale price can leave us on the wrong side of market.
        uint256 uniPrice = _getUniswapPrice();
        if (uniPrice > 0) {
            uint256 marketPriceY = uint256(d.priceX).mulDiv(WAD, uniPrice);
            if (marketPriceY > 0 && marketPriceY <= type(uint80).max) {
                d.priceY = uint80(marketPriceY);
            }
        }

        // Snapshot recentered priceY as reference for post-auction recenter clamping
        preShiftPriceY = d.priceY;

        // Step 2: Shift priceY PAST market to create deliberate mispricing.
        // Decrease py → increase px/py → asset1 cheaper → arbers buy asset1, send asset0.
        // Increase py → decrease px/py → asset0 cheaper → arbers buy asset0, send asset1.
        if (asset0Deficit) {
            d.priceY = uint80(uint256(d.priceY) * WAD / (WAD + shift));
        } else {
            d.priceY = uint80(uint256(d.priceY) * (WAD + shift) / WAD);
        }

        // Keep current reserves as-is — the shift alone creates the arb
        // Relax min reserves during auction to avoid boundary revert
        d.minReserve0 = 0;
        d.minReserve1 = 0;

        // Set eq reserves = current reserves so CurveLib.verify passes with shifted price
        d.equilibriumReserve0 = reserve0;
        d.equilibriumReserve1 = reserve1;

        try IEulerSwap(pool).reconfigure(d, IEulerSwap.InitialState(reserve0, reserve1)) {
            // Starting fee = 150% of shift to ensure no arber can profit immediately.
            // The shift creates exact mispricing = s (at eq, marginal = px/py for all c).
            // At 1.5x, arbers must wait for ~shift/(2*decayPerBlock) blocks before trading profitably.
            uint256 startFee = shift * 3 / 2;
            if (startFee > uint256(maxFee)) startFee = uint256(maxFee);
            if (startFee < uint256(baseFee)) startFee = uint256(baseFee);
            auctionActive = true;
            auctionStartBlock = uint64(block.number);
            auctionStartingFee = uint64(startFee);
            // Clearing direction: if asset0 is deficit, we want asset0 IN
            auctionClearAsset0 = asset0Deficit;

            emit AuctionStarted(auctionStartingFee, uint64(block.number), asset0Deficit);
        } catch {
            // Reconfigure failed — don't block the swap, stay in normal mode
        }
    }

    /// @notice Step 3: Exposure cleared → recenter at market price + activate surcharge.
    /// Safety: clamps new eq price to within maxRecenterDrift of pre-shift price.
    function _endAuctionAndRecenter(uint112 reserve0, uint112 reserve1) internal {
        auctionActive = false;

        // Read current market price from Uniswap
        uint256 uniPrice = _getUniswapPrice();
        if (uniPrice > 0) {
            IEulerSwap.DynamicParams memory d = IEulerSwap(pool).getDynamicParams();

            // Recenter: set eq price to market price
            // priceX/priceY should encode uniPrice (WAD-scaled asset1/asset0)
            // We adjust priceY to achieve the desired ratio while keeping priceX stable
            // Target: priceX / newPriceY = uniPrice → newPriceY = priceX * WAD / uniPrice
            uint256 newPriceY = uint256(d.priceX).mulDiv(WAD, uniPrice);

            // Safety guard: clamp newPriceY to within maxRecenterDrift of pre-shift priceY.
            // This prevents oracle manipulation from causing a wildly wrong recenter.
            uint256 _preShiftPY = uint256(preShiftPriceY);
            uint256 _maxDrift = uint256(maxRecenterDrift);
            if (_preShiftPY > 0 && _maxDrift > 0) {
                uint256 maxPY = _preShiftPY * (WAD + _maxDrift) / WAD;
                uint256 minPY = _preShiftPY * WAD / (WAD + _maxDrift);
                if (newPriceY > maxPY) newPriceY = maxPY;
                if (newPriceY < minPY) newPriceY = minPY;
            }

            if (newPriceY > 0 && newPriceY <= type(uint80).max) {
                d.priceY = uint80(newPriceY);
            }

            // Set eq reserves to current reserves at the new price
            d.equilibriumReserve0 = reserve0;
            d.equilibriumReserve1 = reserve1;

            // Restore min reserves from recenterRange using curve math.
            // For price range r and concentration c:
            //   pBoundary = (px/py) × (1 + r)
            //   minReserve = eq / sqrt(1 + r/(1-c))
            // This ensures h=1 at the boundary when calibrated with the pool's LTV.
            _setMinReservesFromRange(d, reserve0, reserve1);

            try IEulerSwap(pool).reconfigure(d, IEulerSwap.InitialState(reserve0, reserve1)) {
                emit Recentered(uint64(block.number));
            } catch {}
        }

        // Update approxNav after clearing
        approxNav = _computeApproxNav();

        // Activate surcharge regardless of reconfigure success
        surchargeStartBlock = uint64(block.number);

        emit AuctionEnded(uint64(block.number));
    }

    // --- Internal: fee computation ---

    /// @notice Normal mode fee: routing-aware attract + arb capture.
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

                if (isArbDirection && _captureRate > 0) {
                    uint256 effectiveThreshold = uint256(gasCoeff) * tx.gasprice.sqrt();
                    uint256 totalCost = effectiveThreshold + uint256(baseFee) + uint256(externalFee);
                    if (mismatch > totalCost) {
                        uint256 netEdge = mismatch - totalCost;
                        computedFee += (_captureRate * netEdge) / WAD;
                    }
                } else if (!isArbDirection && _attractRate > 0) {
                    // Routing-aware attract: capture fraction of total headroom over Uniswap
                    uint256 headroom = mismatch + uint256(externalFee);
                    computedFee += (_attractRate * headroom) / WAD;
                }
            }
        }

        if (computedFee > uint256(maxFee)) computedFee = uint256(maxFee);
        return computedFee;
    }

    /// @notice Compute current surcharge (decays to zero from surchargeInitialAmount).
    function _currentSurcharge() internal view returns (uint256) {
        uint64 _surchargeStart = surchargeStartBlock;
        if (_surchargeStart == 0) return 0;

        uint256 _initial = uint256(surchargeInitialAmount);
        if (_initial == 0) return 0;

        uint256 elapsed = block.number - uint256(_surchargeStart);
        uint256 decayed = elapsed * uint256(surchargeDecayPerBlock);

        if (decayed >= _initial) return 0;
        return _initial - decayed;
    }

    /// @notice Compute min reserves from recenterRange and pool concentration.
    /// @dev For price range r and concentration c: minReserve = eq / sqrt(1 + r/(1-c))
    ///      When c = WAD (constant-sum), minReserve = 0 (no boundary needed).
    ///      When recenterRange = 0, minReserve = 0 (no boundary).
    function _setMinReservesFromRange(
        IEulerSwap.DynamicParams memory d,
        uint112 reserve0,
        uint112 reserve1
    ) internal view {
        uint256 _range = uint256(recenterRange);
        if (_range == 0) {
            d.minReserve0 = 0;
            d.minReserve1 = 0;
            return;
        }

        uint256 sqrtWAD = WAD.sqrt();

        // X side: minReserve0 = eq0 / sqrt(1 + r/(1-cx))
        uint256 cx = uint256(d.concentrationX);
        if (cx < WAD) {
            uint256 inner = WAD + _range * WAD / (WAD - cx);
            d.minReserve0 = uint112(uint256(reserve0) * sqrtWAD / inner.sqrt());
        } else {
            d.minReserve0 = 0;
        }

        // Y side: minReserve1 = eq1 / sqrt(1 + r/(1-cy))
        uint256 cy = uint256(d.concentrationY);
        if (cy < WAD) {
            uint256 inner = WAD + _range * WAD / (WAD - cy);
            d.minReserve1 = uint112(uint256(reserve1) * sqrtWAD / inner.sqrt());
        } else {
            d.minReserve1 = 0;
        }
    }

    // --- Internal: exposure computation ---

    /// @notice Compute directional exposure as fraction of range consumed (WAD-scaled).
    /// @return exposure WAD fraction (0 = at equilibrium, 1e18 = at boundary)
    /// @return asset0Deficit true if reserve0 < equilibrium (pool is short asset0 / long asset1)
    function _computeExposure(uint112 reserve0, uint112 reserve1, IEulerSwap.DynamicParams memory d)
        internal
        pure
        returns (uint256 exposure, bool asset0Deficit)
    {
        uint256 eq0 = uint256(d.equilibriumReserve0);
        uint256 eq1 = uint256(d.equilibriumReserve1);
        uint256 min0 = uint256(d.minReserve0);
        uint256 min1 = uint256(d.minReserve1);

        if (uint256(reserve0) < eq0 && eq0 > min0) {
            asset0Deficit = true;
            exposure = (eq0 - uint256(reserve0)) * WAD / (eq0 - min0);
        } else if (uint256(reserve1) < eq1 && eq1 > min1) {
            asset0Deficit = false;
            exposure = (eq1 - uint256(reserve1)) * WAD / (eq1 - min1);
        }
        // else: at or above equilibrium → exposure = 0
    }

    // --- Internal: vault debt trigger ---

    /// @notice Check if vault-level debt exceeds threshold relative to approxNav.
    /// Triggers clearing when reserves are at equilibrium but vault has accumulated debt.
    /// Only one side can have debt at a time — short-circuit after the first hit.
    function _checkDebtTrigger(uint112 reserve0, uint112 reserve1, IEulerSwap.DynamicParams memory d) internal {
        uint64 _threshold = debtTriggerThreshold;
        if (_threshold == 0) return;

        uint128 _nav = approxNav;
        if (_nav == 0) return;

        address _eulerAccount = eulerAccount;
        uint256 debt0;
        uint256 debt1;
        bool asset0Deficit;

        address _bv0 = borrowVault0;
        if (_bv0 != address(0)) {
            debt0 = IEVault(_bv0).debtOf(_eulerAccount);
        }

        if (debt0 > 0) {
            asset0Deficit = true;
        } else {
            address _bv1 = borrowVault1;
            if (_bv1 != address(0)) {
                debt1 = IEVault(_bv1).debtOf(_eulerAccount);
            }
            if (debt1 == 0) return; // no debt on either side
            asset0Deficit = false;
        }

        // Convert debt to asset0 terms using oracle price for comparison with NAV
        uint256 debtInAsset0;
        if (asset0Deficit) {
            debtInAsset0 = debt0;
        } else {
            uint256 uniPrice = _getUniswapPrice();
            if (uniPrice == 0) return;
            debtInAsset0 = debt1 * WAD / uniPrice;
        }

        // Trigger if debt/NAV exceeds threshold
        if (debtInAsset0 * WAD / uint256(_nav) > uint256(_threshold)) {
            // Pass raw debt in the deficit asset's units for dynamic shift
            uint256 rawDebt = asset0Deficit ? debt0 : debt1;
            _startEquityClearing(reserve0, reserve1, asset0Deficit, d, rawDebt);
        }
    }

    /// @notice Compute approximate NAV in asset0 terms from vault deposits and debts.
    function _computeApproxNav() internal view returns (uint128) {
        address _eulerAccount = eulerAccount;

        // Deposits: convert eToken shares to underlying assets
        uint256 deposit0 = IEVault(supplyVault0).convertToAssets(IEVault(supplyVault0).balanceOf(_eulerAccount));
        uint256 deposit1 = IEVault(supplyVault1).convertToAssets(IEVault(supplyVault1).balanceOf(_eulerAccount));

        // Debts
        uint256 debt0;
        uint256 debt1;
        address _bv0 = borrowVault0;
        address _bv1 = borrowVault1;
        if (_bv0 != address(0)) debt0 = IEVault(_bv0).debtOf(_eulerAccount);
        if (_bv1 != address(0)) debt1 = IEVault(_bv1).debtOf(_eulerAccount);

        // Convert asset1 amounts to asset0 terms using oracle price
        uint256 uniPrice = _getUniswapPrice();
        if (uniPrice == 0) return 0;

        uint256 totalDeposits = deposit0 + deposit1 * WAD / uniPrice;
        uint256 totalDebts = debt0 + debt1 * WAD / uniPrice;

        if (totalDebts >= totalDeposits) return 0;
        uint256 nav = totalDeposits - totalDebts;

        return nav > type(uint128).max ? type(uint128).max : uint128(nav);
    }

    // --- Internal: price reads ---

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

    /// @notice Compute marginal price from EulerSwap curve derivative.
    /// @dev c=0: Branch 1 (x <= x0): |dy/dx| = px * x0^2 / (py * x^2)
    ///          Branch 2 (x > x0):  |dy/dx| = px * y^2 / (py * y0^2)
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

    // Auction params are accessible via individual public getters:
    // decayPerBlock(), triggerThreshold(), clearThreshold(), shiftMagnitude(),
    // maxRecenterDrift(), minAuctionBlocks(), recenterRange()

    function getSurchargeParams()
        external
        view
        returns (uint64 _surchargeDecayPerBlock, uint64 _surchargeInitialAmount)
    {
        return (surchargeDecayPerBlock, surchargeInitialAmount);
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
}
