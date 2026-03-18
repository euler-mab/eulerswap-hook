// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {LPAgentHookV8} from "../src/LPAgentHookV8.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {Sqrt} from "../eulerswap/src/math/Sqrt.sol";
import {DeployHookV8Base} from "./DeployHookV8Base.s.sol";

/// @title DeployHookV8UsdcUsdt — Deploy V8 hook on USDC/USDT pool
/// @notice 50:50 strategy with additive boost (h=1 at boundary). V4 oracle.
/// @dev Usage:
///   PRIVATE_KEY=0x... forge script script/DeployHookV8UsdcUsdt.s.sol:DeployHookV8UsdcUsdt \
///     --rpc-url $RPC_URL --broadcast --slow -vvvv
contract DeployHookV8UsdcUsdt is DeployHookV8Base {
    using Sqrt for uint256;

    // --- Pool ---
    address constant POOL = 0x719529e99b7b272c5ef4CE07C30d15BC57CD68A8;
    address constant EULER_ACCOUNT = 0x2909BCc87c17D8be263621bf087Bc806ba313BFf; // sub-account 1

    // --- Oracle: Uniswap V4 USDC/USDT pool ---
    address constant V4_POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    bytes32 constant V4_POOL_ID = 0x395f91b34aa34a477ce3bc6505639a821b286a62b1a164fc1887fa3a5ef713a5;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    // --- Fee parameters ---
    uint64 constant BASE_FEE = 5e12;              // 0.05 bps — undercuts V4's 0.08 bps
    uint64 constant MAX_FEE = 5e15;               // 50 bps cap
    uint64 constant GAS_COEFF = 0;                // gas negligible at stablecoin pool depth
    uint64 constant EXTERNAL_FEE = 8e12;          // 0.08 bps (V4 fee)
    uint256 constant CAPTURE_RATE = 0.8e18;       // 80% arb capture
    uint256 constant ATTRACT_RATE = 0.5e18;       // 50% retail discount

    // --- Range: 1 tick = 1 bps ---
    uint64 constant RECENTER_RANGE_VAL = 1e14;    // 0.01% = 1 bps = 1 tick

    // --- Auction parameters ---
    // σ₁ ≈ 0.05 bps/block from USDC/USDT annual vol ~0.5% / sqrt(2,628,000)
    uint64 constant DECAY_PER_BLOCK = 5e12;       // 0.05 bps/block
    uint64 constant AUCTION_TRIGGER = 0.5e18;     // 50% relative exposure
    uint64 constant CLEAR_THRESHOLD = 0.1e18;     // 10% remaining → cleared
    uint64 constant MIN_AUCTION_BLOCKS = 25;      // ~5 minutes
    uint64 constant MIN_AUCTION_INTERVAL = 50;    // ~10 min cooldown
    uint64 constant K_MARGIN_BLOCKS = 250;        // stable pair: wider margin

    // --- Trigger parameters ---
    uint64 constant ORACLE_GUARD_MULTIPLIER = 3e18;
    uint64 constant MAX_SNAPSHOT_INTERVAL = 21600; // ~72h for stablecoin

    // --- Recenter parameters ---
    uint64 constant MAX_RECENTER_DRIFT = 1e14;    // 0.01% = 1 bps

    // --- Surcharge parameters ---
    uint64 constant SURCHARGE_DECAY = 5e12;       // 0.05 bps/block
    uint64 constant SURCHARGE_MULTIPLIER = uint64(2.5e18); // 2.5x (covers curvature bonus)
    uint64 constant DEPLOY_SURCHARGE = 5e14;      // 5 bps

    // --- Displacement threshold ---
    uint128 constant MIN_DISPLACEMENT = 1e6;     // $1 USDC minimum displacement

    // --- LTV (symmetric 96% liquidation LTV) ---
    uint256 constant LLTV = 0.96e18;

    // ─── Overrides ─────────────────────────────────────────────────────

    function _poolAddress() internal pure override returns (address) { return POOL; }
    function _eulerAccount() internal pure override returns (address) { return EULER_ACCOUNT; }
    function _recenterRange() internal pure override returns (uint64) { return RECENTER_RANGE_VAL; }

    function _oracleConfig() internal pure override returns (LPAgentHookV8.OracleConfig memory) {
        return LPAgentHookV8.OracleConfig({
            target: V4_POOL_MANAGER,
            v4PoolId: V4_POOL_ID,
            token0: USDC
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
            weightW0: int256(0.5e18) // 50:50 strategy for stablecoin pool
        });
    }

    function _readMarketPrice(uint80 priceX) internal view override returns (uint80) {
        return _readV4Price(V4_POOL_MANAGER, V4_POOL_ID, priceX);
    }

    /// @notice Compute min reserve for cx=cy=0 (stablecoin pool).
    function _computeMinReserve(uint112 eqReserve, uint64) internal view override returns (uint112) {
        uint256 r = uint256(RECENTER_RANGE_VAL);
        if (r == 0) return 0;
        // cx=0: inner = 1 + r, minReserve = eq / sqrt(1+r)
        uint256 inner = WAD + r;
        uint256 sqrtInner = (inner * WAD).sqrt();
        return uint112(uint256(eqReserve) * WAD / sqrtInner);
    }

    /// @notice Additive boost with h=1 at boundary. Same formula as V7 USDC/USDT deploy.
    function _computeEquilibrium(
        IEulerSwap.DynamicParams memory,
        uint256 xr,
        uint256 yr
    ) internal pure override returns (uint112, uint112) {
        return (_computeEq0(xr, yr), _computeEq0(yr, xr));
    }

    /// @dev Compute equilibrium for one side: eq = deposit + boost.
    /// Symmetric: call with (xr, yr) for X side, (yr, xr) for Y side.
    function _computeEq0(uint256 deposit, uint256 other) internal pure returns (uint112) {
        uint256 r = uint256(RECENTER_RANGE_VAL);
        uint256 sxWad = ((WAD + r) * WAD).sqrt();
        uint256 sxM1 = sxWad - WAD;
        uint256 R = WAD + r;
        uint256 v = LLTV;

        uint256 term2a = v * sxM1 / WAD * sxWad / WAD;
        uint256 vPX = v * sxWad / WAD;
        require(R > vPX, "denom negative: range too tight for LTV");
        uint256 denom = sxM1 * (R - vPX) / WAD;

        uint256 num = v * other / WAD * sxWad / WAD + deposit * (term2a + R) / WAD;
        return uint112(deposit + num * WAD / denom);
    }
}
