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

    // --- Time-decay fee parameters (owner-updatable) ---
    // Symmetric surcharge applied to ALL swaps, decays linearly from decaySurcharge
    // to 0 over decayPeriod seconds since the last trade. Protects against MEV:
    // first trade in a new block pays full surcharge (likely arb), subsequent trades
    // in the same block pay nothing (likely retail).
    uint64 public decaySurcharge; // max surcharge in WAD (e.g. 50e14 = 50bps)
    uint32 public decayPeriod; // seconds for surcharge to decay to zero (e.g. 12 = 1 block)

    // --- Trade stats (updated by afterSwap) ---
    uint256 public tradeCount;
    uint256 public cumulativeVolume0;
    uint256 public cumulativeVolume1;
    bool public lastTradeAsset0In;
    uint256 public lastTradeSize;
    uint256 public lastTradeBlock;
    uint256 public lastTradeTimestamp;

    // --- Events ---
    event FeeParamsUpdated(uint64 baseFee, uint64 maxFee, uint64 minFee, uint256 mismatchScale);
    event DecayParamsUpdated(uint64 surcharge, uint32 period);
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

    /// @notice Dynamic fee combining time-decay (primary) and oracle mismatch (optional).
    ///
    /// Time-decay: after each swap, the fee starts high and decays linearly to baseFee
    /// over decayPeriod seconds. First trade in a new block pays the surcharge (arb tax),
    /// subsequent same-block trades pay near-baseFee (retail-friendly). No oracle needed.
    ///
    /// Oracle mismatch (opt-in, mismatchScale > 0): adds directional fee asymmetry based
    /// on oracle-vs-marginal price divergence. Costs extra gas per swap for the oracle read.
    /// Set mismatchScale = 0 to disable and save gas.
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
        if (paused) return maxFee;

        uint256 computedFee = uint256(baseFee);

        // --- Layer 1: Time-decay surcharge (primary arb protection, no oracle) ---
        // First trade in a new block pays full surcharge (likely arb exploiting price move).
        // Subsequent same-block trades pay zero surcharge (likely retail after arb aligned price).
        // Between blocks, the surcharge decays linearly over decayPeriod seconds so a pool
        // idle for a long time doesn't penalize the first real trade.
        if (decaySurcharge > 0 && lastTradeBlock > 0) {
            if (lastTradeBlock == block.number) {
                // Same block as a previous trade — no surcharge (retail)
            } else if (decayPeriod > 0) {
                // New block — apply surcharge, decayed by time since last trade
                uint256 elapsed = block.timestamp - lastTradeTimestamp;
                if (elapsed < uint256(decayPeriod)) {
                    computedFee += uint256(decaySurcharge) * (uint256(decayPeriod) - elapsed) / uint256(decayPeriod);
                }
                // If elapsed >= decayPeriod, pool has been idle long enough — no surcharge
            } else {
                // decayPeriod = 0: no decay, always charge full surcharge on new blocks
                computedFee += uint256(decaySurcharge);
            }
        }

        // --- Layer 2: Oracle mismatch (optional directional asymmetry) ---
        // Only active when mismatchScale > 0. Adds/subtracts fee based on which side of the
        // trade exploits mispricing. Costs extra gas for oracle reads.
        if (mismatchScale > 0) {
            uint256 oraclePrice = _getOraclePrice();
            if (oraclePrice > 0) {
                uint256 marginalPrice = (uint256(reserve1) * WAD) / uint256(reserve0);

                uint256 mismatch;
                bool poolUnderpriced0;
                if (oraclePrice > marginalPrice) {
                    mismatch = ((oraclePrice - marginalPrice) * WAD) / oraclePrice;
                    poolUnderpriced0 = true;
                } else {
                    mismatch = ((marginalPrice - oraclePrice) * WAD) / oraclePrice;
                    poolUnderpriced0 = false;
                }

                uint256 scaledMismatch = (uint256(mismatchScale) * mismatch) / WAD;

                // Charge high on the side that exploits mispricing, low on the other
                bool chargeHigh = (poolUnderpriced0 && !asset0IsInput) || (!poolUnderpriced0 && asset0IsInput);

                if (chargeHigh) {
                    computedFee += scaledMismatch;
                } else {
                    if (scaledMismatch >= computedFee) {
                        computedFee = uint256(minFee);
                    } else {
                        computedFee -= scaledMismatch;
                    }
                }
            }
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
        lastTradeTimestamp = block.timestamp;

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

    function setDecayParams(uint64 _surcharge, uint32 _period) external onlyOwner {
        require(_surcharge <= uint64(WAD), "surcharge >= 100%");
        decaySurcharge = _surcharge;
        decayPeriod = _period;
        emit DecayParamsUpdated(_surcharge, _period);
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

    function getDecayParams()
        external
        view
        returns (uint64 _surcharge, uint32 _period, uint256 _lastTradeTimestamp)
    {
        return (decaySurcharge, decayPeriod, lastTradeTimestamp);
    }
}
