// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {LPAgentHookV8} from "../src/LPAgentHookV8.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {DeployHookV8Base, IUniswapV3Pool} from "./DeployHookV8Base.s.sol";

/// @title DeployHookV8UsdcWeth — Deploy V8 hook on USDC/WETH pool
/// @notice Delta-neutral strategy: target 0% WETH exposure. V3 oracle.
/// @dev Usage:
///   PRIVATE_KEY=0x... forge script script/DeployHookV8UsdcWeth.s.sol:DeployHookV8UsdcWeth \
///     --rpc-url $RPC_URL --broadcast --slow -vvvv
contract DeployHookV8UsdcWeth is DeployHookV8Base {

    // --- Pool and oracle addresses (mainnet USDC/WETH) ---
    address constant POOL = 0x4311031739918Aba578C3C667DA3028A12Ce28A8;
    address constant EULER_ACCOUNT = 0x2909bCc87c17d8Be263621bF087bC806BA313BFE;
    address constant UNI_USDC_WETH = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640; // V3 0.05% fee tier

    // --- Fee parameters ---
    uint64 constant BASE_FEE = 5e14;             // 5 bps
    uint64 constant MAX_FEE = 3500e14;           // 3500 bps (35%)
    uint64 constant GAS_COEFF = uint64(6.54e10); // ~25 bps at 0.4 gwei for current pool depth
    uint64 constant EXTERNAL_FEE = 5e14;         // 5 bps (Uni V3 0.05% pool)
    uint256 constant CAPTURE_RATE = 0.8e18;      // 80% of net edge on arb side
    uint256 constant ATTRACT_RATE = 0.3e18;      // 30% of routing headroom on attract side

    // --- Auction parameters ---
    // σ₁ ≈ 4.3 bps/block from ETH annual vol ~80% / sqrt(2,628,000 blocks/year)
    uint64 constant DECAY_PER_BLOCK = uint64(4.3e14);    // D ≈ σ₁
    uint64 constant AUCTION_TRIGGER = 0.5e18;             // 50% NAV exposure → trigger
    uint64 constant CLEAR_THRESHOLD = 0.1e18;             // 10% remaining → cleared
    uint64 constant MIN_AUCTION_BLOCKS = 12;              // ~2.4 min before clearing
    uint64 constant MIN_AUCTION_INTERVAL = 25;            // ~5 min cooldown after auction
    uint64 constant K_MARGIN_BLOCKS = 15;                 // startingFee = premium + 15*D

    // --- Trigger parameters ---
    uint64 constant ORACLE_GUARD_MULTIPLIER = 3e18;       // g=3: <0.3% false positive
    uint64 constant MAX_SNAPSHOT_INTERVAL = 7200;          // ~24h time-based trigger fallback

    // --- Recenter parameters ---
    uint64 constant RECENTER_RANGE_VAL = 0.05e18;         // 5% price range
    uint64 constant MAX_RECENTER_DRIFT = 0.03e18;         // 3% max price drift

    // --- Surcharge parameters ---
    uint64 constant SURCHARGE_DECAY = 10e14;              // 10 bps/block
    uint64 constant SURCHARGE_MULTIPLIER = uint64(1.25e18); // 1.25× safety margin
    uint64 constant DEPLOY_SURCHARGE = 500e14;            // 500 bps

    // --- Displacement threshold ---
    uint128 constant MIN_DISPLACEMENT = 10e6;             // $10 USDC minimum displacement

    // ─── Overrides ─────────────────────────────────────────────────────

    function _poolAddress() internal pure override returns (address) { return POOL; }
    function _eulerAccount() internal pure override returns (address) { return EULER_ACCOUNT; }
    function _recenterRange() internal pure override returns (uint64) { return RECENTER_RANGE_VAL; }

    function _oracleConfig() internal view override returns (LPAgentHookV8.OracleConfig memory) {
        return LPAgentHookV8.OracleConfig({
            target: UNI_USDC_WETH,
            v4PoolId: bytes32(0),
            token0: IUniswapV3Pool(UNI_USDC_WETH).token0()
        });
    }

    function _feeConfig() internal pure override returns (LPAgentHookV8.FeeConfig memory) {
        return LPAgentHookV8.FeeConfig({
            baseFee: BASE_FEE,
            maxFee: MAX_FEE,
            gasCoeff: GAS_COEFF,
            externalFee: EXTERNAL_FEE,
            captureRate: CAPTURE_RATE,
            attractRate: ATTRACT_RATE
        });
    }

    function _auctionConfig() internal pure override returns (LPAgentHookV8.AuctionConfig memory) {
        return LPAgentHookV8.AuctionConfig({
            decayPerBlock: DECAY_PER_BLOCK,
            triggerFraction: AUCTION_TRIGGER,
            clearThreshold: CLEAR_THRESHOLD,
            minAuctionBlocks: MIN_AUCTION_BLOCKS,
            minAuctionInterval: MIN_AUCTION_INTERVAL,
            kMarginBlocks: K_MARGIN_BLOCKS,
            oracleGuardMultiplier: ORACLE_GUARD_MULTIPLIER,
            maxSnapshotInterval: MAX_SNAPSHOT_INTERVAL,
            recenterRange: RECENTER_RANGE_VAL,
            maxRecenterDrift: MAX_RECENTER_DRIFT,
            surchargeDecayPerBlock: SURCHARGE_DECAY,
            surchargeMultiplier: SURCHARGE_MULTIPLIER,
            deploySurcharge: DEPLOY_SURCHARGE,
            minDisplacementThreshold: MIN_DISPLACEMENT,
            weightW0: int256(1e18) // delta-neutral: 100% in asset0 (USDC)
        });
    }

    function _readMarketPrice(uint80 priceX) internal view override returns (uint80) {
        return _readV3Price(UNI_USDC_WETH, priceX);
    }

    /// @notice Delta-neutral: eq reserves = current reserves (recenter at market).
    function _computeEquilibrium(
        IEulerSwap.DynamicParams memory,
        uint256,
        uint256
    ) internal view override returns (uint112 eq0, uint112 eq1) {
        (eq0, eq1,) = IEulerSwap(POOL).getReserves();
    }
}
