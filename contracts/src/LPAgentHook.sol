// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IEulerSwapHookTarget, EULER_SWAP_HOOK_GET_FEE, EULER_SWAP_HOOK_AFTER_SWAP} from
    "../eulerswap/src/interfaces/IEulerSwapHookTarget.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {IPriceOracle} from "evk/interfaces/IPriceOracle.sol";

/// @title LPAgentHook — Dynamic fee hook for autonomous LP management
/// @notice Implements getFee (Layer 1) and afterSwap (Layer 2) for EulerSwap.
///         getFee: reads oracle price, computes mismatch vs pool marginal price,
///         returns asymmetric fee that charges more on the mispriced side.
///         afterSwap: tracks trade stats for monitoring.
///         Owner can update fee parameters; agent EOA updates via owner calls.
contract LPAgentHook is IEulerSwapHookTarget {
    // --- Constants ---
    uint256 constant WAD = 1e18;
    uint256 constant BPS = 1e14; // 1 basis point in WAD terms (1e14 / 1e18 = 0.01%)

    // --- Immutables ---
    address public immutable pool;
    address public immutable owner;
    address public immutable supplyVault0; // for oracle access
    address public immutable supplyVault1;
    address public immutable asset0;
    address public immutable asset1;

    // --- Fee parameters (owner-updatable) ---
    uint64 public baseFee; // base fee in WAD (e.g. 25e14 = 25bps)
    uint64 public maxFee; // maximum fee cap
    uint64 public minFee; // minimum fee floor
    uint256 public mismatchScale; // fee increase per unit mismatch (WAD-scaled)
    bool public paused; // kill switch

    // --- Trade stats (updated by afterSwap) ---
    uint256 public tradeCount;
    uint256 public cumulativeVolume0;
    uint256 public cumulativeVolume1;
    bool public lastTradeAsset0In;
    uint256 public lastTradeSize;
    uint256 public lastTradeBlock;

    // --- Events ---
    event FeeParamsUpdated(uint64 baseFee, uint64 maxFee, uint64 minFee, uint256 mismatchScale);
    event Paused(bool paused);
    event TradeRecorded(
        uint256 tradeCount, bool asset0In, uint256 amountIn, uint256 amountOut, uint64 feeApplied
    );

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
        uint64 _baseFee,
        uint64 _maxFee,
        uint64 _minFee,
        uint256 _mismatchScale
    ) {
        pool = _pool;
        owner = _owner;
        baseFee = _baseFee;
        maxFee = _maxFee;
        minFee = _minFee;
        mismatchScale = _mismatchScale;

        // Cache vault and asset addresses from pool's static params
        IEulerSwap.StaticParams memory sParams = IEulerSwap(_pool).getStaticParams();
        supplyVault0 = sParams.supplyVault0;
        supplyVault1 = sParams.supplyVault1;
        asset0 = IEVault(sParams.supplyVault0).asset();
        asset1 = IEVault(sParams.supplyVault1).asset();
    }

    // --- IEulerSwapHookTarget ---

    /// @notice Not used — we don't hook beforeSwap
    function beforeSwap(uint256, uint256, address, address) external pure override {
        revert("not implemented");
    }

    /// @notice Dynamic fee based on oracle-vs-pool mismatch
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
        if (paused) return maxFee;

        // Get oracle price: how much asset1 per 1 unit of asset0
        uint256 oraclePrice = _getOraclePrice();
        if (oraclePrice == 0) return baseFee; // fallback if oracle fails

        // Pool marginal price: reserve1 / reserve0 (WAD-scaled)
        uint256 marginalPrice = (uint256(reserve1) * WAD) / uint256(reserve0);

        // Compute mismatch: |oracle - marginal| / oracle (WAD-scaled)
        uint256 mismatch;
        bool poolUnderpriced0; // true if oracle > marginal (pool sells asset0 too cheap)
        if (oraclePrice > marginalPrice) {
            mismatch = ((oraclePrice - marginalPrice) * WAD) / oraclePrice;
            poolUnderpriced0 = true;
        } else {
            mismatch = ((marginalPrice - oraclePrice) * WAD) / oraclePrice;
            poolUnderpriced0 = false;
        }

        // Compute direction-aware fee
        // If pool underprices asset0 (oracle > marginal):
        //   - asset0 output (asset1 input, asset0IsInput=false): charge HIGH (protect ask)
        //   - asset0 input (asset0IsInput=true): charge LOW (attract retail)
        // If pool overprices asset0 (oracle < marginal):
        //   - asset0 input (asset0IsInput=true): charge HIGH (protect bid)
        //   - asset0 output (asset0IsInput=false): charge LOW (attract retail)
        uint256 scaledMismatch = (uint256(mismatchScale) * mismatch) / WAD;
        uint256 computedFee;

        bool chargeHigh = (poolUnderpriced0 && !asset0IsInput) || (!poolUnderpriced0 && asset0IsInput);

        if (chargeHigh) {
            computedFee = uint256(baseFee) + scaledMismatch;
        } else {
            computedFee = scaledMismatch > uint256(baseFee)
                ? uint256(minFee)
                : uint256(baseFee) - scaledMismatch;
        }

        // Clamp to [minFee, maxFee]
        if (computedFee > uint256(maxFee)) computedFee = uint256(maxFee);
        if (computedFee < uint256(minFee)) computedFee = uint256(minFee);

        fee = uint64(computedFee);
    }

    /// @notice Track trade stats after each swap
    function afterSwap(
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        uint256 fee0,
        uint256 fee1,
        address,
        address,
        uint112,
        uint112
    ) external override onlyPool {
        bool asset0In = amount0In > 0;

        tradeCount++;
        cumulativeVolume0 += amount0In + amount0Out;
        cumulativeVolume1 += amount1In + amount1Out;
        lastTradeAsset0In = asset0In;
        lastTradeSize = asset0In ? amount0In : amount1In;
        lastTradeBlock = block.number;

        uint64 feeApplied = asset0In ? uint64(fee0) : uint64(fee1);

        emit TradeRecorded(tradeCount, asset0In, asset0In ? amount0In : amount1In, asset0In ? amount1Out : amount0Out, feeApplied);
    }

    // --- Owner management ---

    function setFeeParams(uint64 _baseFee, uint64 _maxFee, uint64 _minFee, uint256 _mismatchScale)
        external
        onlyOwner
    {
        require(_minFee <= _baseFee && _baseFee <= _maxFee, "invalid fee ordering");
        require(_maxFee < uint64(WAD), "max fee >= 100%");

        baseFee = _baseFee;
        maxFee = _maxFee;
        minFee = _minFee;
        mismatchScale = _mismatchScale;

        emit FeeParamsUpdated(_baseFee, _maxFee, _minFee, _mismatchScale);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }

    // --- Internal ---

    /// @notice Get oracle price: asset1 per 1 WAD of asset0
    function _getOraclePrice() internal view returns (uint256) {
        address oracleAddr = IEVault(supplyVault0).oracle();
        if (oracleAddr == address(0)) return 0;

        address unitOfAccount = IEVault(supplyVault0).unitOfAccount();

        // Get price of 1 unit of asset0 in unit of account
        uint256 price0 = IPriceOracle(oracleAddr).getQuote(WAD, asset0, unitOfAccount);
        // Get price of 1 unit of asset1 in unit of account
        uint256 price1 = IPriceOracle(oracleAddr).getQuote(WAD, asset1, unitOfAccount);

        if (price1 == 0) return 0;

        // asset1 per asset0 = price0 / price1 (WAD-scaled)
        return (price0 * WAD) / price1;
    }

    // --- View helpers for agent ---

    function getTradeStats()
        external
        view
        returns (
            uint256 _tradeCount,
            uint256 _volume0,
            uint256 _volume1,
            bool _lastAsset0In,
            uint256 _lastSize,
            uint256 _lastBlock
        )
    {
        return (tradeCount, cumulativeVolume0, cumulativeVolume1, lastTradeAsset0In, lastTradeSize, lastTradeBlock);
    }

    function getFeeParams()
        external
        view
        returns (uint64 _baseFee, uint64 _maxFee, uint64 _minFee, uint256 _mismatchScale, bool _paused)
    {
        return (baseFee, maxFee, minFee, mismatchScale, paused);
    }
}
