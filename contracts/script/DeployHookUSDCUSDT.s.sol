// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {DynamicFeeAuctionHook} from "../src/DynamicFeeAuctionHook.sol";
import "../eulerswap/src/interfaces/IEulerSwapHookTarget.sol";
import {FullMath} from "../eulerswap/src/math/FullMath.sol";
import {Sqrt} from "../eulerswap/src/math/Sqrt.sol";

interface IExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @dev AUTHOR'S DEPLOYMENT EXAMPLE — pool / vault / oracle addresses are hardcoded
///      to the author's specific mainnet deployment. Kept as a concrete worked
///      example showing all parameter choices for a real pool. To deploy your
///      own pool, use the generic env-driven script/DeployHook.s.sol instead.
/// @title DeployHookUSDCUSDT — Deploy hook on existing USDC/USDT EulerSwap pool
/// @notice Calibrates eq reserves from first principles: equity × additive boost (h=1 at boundary).
/// @dev Usage:
///   PRIVATE_KEY=0x... forge script script/DeployHookUSDCUSDT.s.sol:DeployHookUSDCUSDT \
///     --rpc-url $RPC_URL --broadcast --slow -vvvv
contract DeployHookUSDCUSDT is Script {
    using Sqrt for uint256;

    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);

    // --- Pool ---
    address constant POOL = 0x719529e99b7b272c5ef4CE07C30d15BC57CD68A8;
    address constant EULER_ACCOUNT = 0x2909BCc87c17D8be263621bf087Bc806ba313BFf; // sub-account 1

    // --- Oracle: Uniswap V4 USDC/USDT pool ---
    address constant V4_POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    bytes32 constant V4_POOL_ID = 0x395f91b34aa34a477ce3bc6505639a821b286a62b1a164fc1887fa3a5ef713a5;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48; // token0 in V4 pool

    uint256 constant WAD = 1e18;

    // --- Fee parameters ---
    uint64 constant BASE_FEE = 5e12;              // 0.05 bps — undercuts V4's 0.08 bps
    uint64 constant MAX_FEE = 5e15;               // 50 bps cap
    uint64 constant GAS_COEFF = 0;                // gas negligible at 0.43 gwei
    uint64 constant EXTERNAL_FEE = 8e12;          // 0.08 bps (V4 fee)
    uint256 constant CAPTURE_RATE = 0.8e18;       // 80% arb capture
    uint256 constant ATTRACT_RATE = 0.5e18;       // 50% retail discount

    // --- Range: 1 tick = 1 bps ---
    // Pool occupies a single tick. Auctions handle rebalancing.
    uint64 constant RECENTER_RANGE = 1e14;        // 0.01% = 1 bps = 1 tick

    // --- Auction parameters ---
    uint64 constant DECAY_PER_BLOCK = 5e12;       // 0.05 bps/block
    uint64 constant AUCTION_TRIGGER = 0.5e18;     // 50% relative exposure
    uint64 constant CLEAR_THRESHOLD = 5e13;       // 0.005% (0.5 bps) — must be < maxShift
    uint64 constant MAX_SHIFT_MAGNITUDE = 1e14;   // 0.01% = 1 bps
    uint64 constant MIN_AUCTION_BLOCKS = 25;      // ~5 minutes

    // --- Recenter parameters ---
    uint64 constant MAX_RECENTER_DRIFT = 1e14;    // 0.01% = 1 bps
    uint64 constant MIN_RECENTER_DELTA = 5e13;    // 0.005% (0.5 bps)

    // --- Surcharge parameters ---
    uint64 constant SURCHARGE_DECAY = 5e12;       // 0.05 bps/block
    uint64 constant SURCHARGE_MULTIPLIER = uint64(2.5e18); // 2.5x (covers curvature bonus)
    uint64 constant DEPLOY_SURCHARGE = 5e14;      // 5 bps

    // --- LTV (from on-chain: symmetric 96% liquidation LTV) ---
    uint256 constant LLTV = 0.96e18;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        EulerSwap pool = EulerSwap(POOL);
        IEulerSwap.DynamicParams memory d = pool.getDynamicParams();

        // Read oracle price
        uint80 marketPriceY = _readMarketPrice(d.priceX);

        // Read actual equity from vaults
        IEulerSwap.StaticParams memory s = pool.getStaticParams();
        (uint256 xr, uint256 yr) = _readEquity(s);

        // Compute calibrated eq reserves: additive boost with h=1 at boundary
        (uint112 eq0, uint112 eq1) = _computeEquilibrium(xr, yr);

        _logPreFlight(deployer, d, marketPriceY, xr, yr, eq0, eq1);

        vm.startBroadcast(pk);

        // 1. Deploy hook
        DynamicFeeAuctionHook hook = _deployHook(deployer);
        console.log("hook deployed:", address(hook));

        // 2. Reconfigure pool with calibrated reserves
        _reconfigurePool(pool, d, address(hook), marketPriceY, eq0, eq1);
        console.log("Pool reconfigured with hook");

        vm.stopBroadcast();

        // 3. Verify final state
        _logFinalState(pool, hook);
    }

    // ─── Equity ──────────────────────────────────────────────────────────

    function _readEquity(IEulerSwap.StaticParams memory s) internal view returns (uint256 xr, uint256 yr) {
        // Supply = shares → assets, Debt = debtOf
        uint256 xShares = IEVault(s.supplyVault0).balanceOf(EULER_ACCOUNT);
        xr = IEVault(s.supplyVault0).convertToAssets(xShares);
        uint256 xd = IEVault(s.borrowVault0).debtOf(EULER_ACCOUNT);
        xr = xr > xd ? xr - xd : 0;

        uint256 yShares = IEVault(s.supplyVault1).balanceOf(EULER_ACCOUNT);
        yr = IEVault(s.supplyVault1).convertToAssets(yShares);
        uint256 yd = IEVault(s.borrowVault1).debtOf(EULER_ACCOUNT);
        yr = yr > yd ? yr - yd : 0;
    }

    // ─── Additive boost: h=1 at boundary ────────────────────────────────
    // x0 = xr + BX where BX = [vyx*(yr)*pXyxb*sx*R + xr*(vyx*(sx-1)*PX + R)] / [(sx-1)*(R - vyx*PX)]
    // For cx=cy=0, px=py=1: sx = sqrt(1+r), PX = sx, R = 1+r, pXyxb = 1/R

    struct EqWork {
        uint256 sxWad;
        uint256 R;
        uint256 sxMinusOne;
        uint256 term2a;
        uint256 denom;
    }

    function _computeEquilibrium(uint256 xr, uint256 yr) internal pure returns (uint112, uint112) {
        EqWork memory w = _eqWork();
        uint256 x0 = xr + _boost(w, xr, yr);
        uint256 y0 = yr + _boost(w, yr, xr);
        return (uint112(x0), uint112(y0));
    }

    // Pure curve constants — cx=cy=0, px=py=1, symmetric LLTV.
    // sx = sqrt(1+r), R = 1+r, PX = sx, denom = (sx-1)*(R - LLTV*sx)
    function _eqWork() internal pure returns (EqWork memory w) {
        uint256 r = uint256(RECENTER_RANGE);
        w.R = WAD + r;
        w.sxWad = (w.R * WAD).sqrt();
        w.sxMinusOne = w.sxWad - WAD;
        w.term2a = LLTV * w.sxMinusOne / WAD * w.sxWad / WAD;
        uint256 vPX = LLTV * w.sxWad / WAD;
        require(w.R > vPX, "denom negative: range too tight for LTV");
        w.denom = w.sxMinusOne * (w.R - vPX) / WAD;
    }

    // Additive boost for reserve `xr` given opposite-side reserve `yr`.
    // BX = [LLTV*yr*sx + xr*(LLTV*(sx-1)*sx + R)] / denom    (all WAD-scaled)
    function _boost(EqWork memory w, uint256 xr, uint256 yr) internal pure returns (uint256) {
        uint256 num = (LLTV * yr / WAD * w.sxWad / WAD) + (xr * (w.term2a + w.R) / WAD);
        return num * WAD / w.denom;
    }

    // ─── Min reserves ────────────────────────────────────────────────────

    function _computeMinReserve(uint112 eqReserve) internal pure returns (uint112) {
        uint256 r = uint256(RECENTER_RANGE);
        if (r == 0) return 0;
        // cx=0: inner = 1 + r, minReserve = eq / sqrt(1+r)
        uint256 inner = WAD + r;
        uint256 sqrtInner = (inner * WAD).sqrt(); // sqrt(inner * WAD) = WAD * sqrt(inner/WAD)
        return uint112(uint256(eqReserve) * WAD / sqrtInner);
    }

    // ─── Oracle ──────────────────────────────────────────────────────────

    function _readMarketPrice(uint80 priceX) internal view returns (uint80) {
        bytes32 stateSlot = keccak256(abi.encode(V4_POOL_ID, bytes32(uint256(6))));
        bytes32 packed = IExtsload(V4_POOL_MANAGER).extsload(stateSlot);
        uint160 sqrtPriceX96 = uint160(uint256(packed));
        require(sqrtPriceX96 > 0, "V4 oracle returned zero price");

        uint256 sqrtP = uint256(sqrtPriceX96);
        uint256 priceWad = FullMath.mulDiv(sqrtP * sqrtP, WAD, 1 << 192);
        return uint80(uint256(priceX) * WAD / priceWad);
    }

    // ─── Hook deploy ─────────────────────────────────────────────────────

    function _deployHook(address deployer) internal returns (DynamicFeeAuctionHook) {
        return new DynamicFeeAuctionHook(
            POOL,
            deployer,
            DynamicFeeAuctionHook.OracleConfig({
                target: V4_POOL_MANAGER,
                v4PoolId: V4_POOL_ID,
                token0: USDC
            }),
            DynamicFeeAuctionHook.FeeConfig({
                baseFee: BASE_FEE,
                maxFee: MAX_FEE,
                gasCoeff: GAS_COEFF,
                externalFee: EXTERNAL_FEE,
                captureRate: CAPTURE_RATE,
                attractRate: ATTRACT_RATE
            }),
            DynamicFeeAuctionHook.AuctionConfig({
                decayPerBlock: DECAY_PER_BLOCK,
                auctionTriggerThreshold: AUCTION_TRIGGER,
                clearThreshold: CLEAR_THRESHOLD,
                maxShiftMagnitude: MAX_SHIFT_MAGNITUDE,
                minAuctionBlocks: MIN_AUCTION_BLOCKS,
                recenterRange: RECENTER_RANGE,
                maxRecenterDrift: MAX_RECENTER_DRIFT,
                minRecenterDelta: MIN_RECENTER_DELTA,
                surchargeDecayPerBlock: SURCHARGE_DECAY,
                surchargeMultiplier: SURCHARGE_MULTIPLIER,
                deploySurcharge: DEPLOY_SURCHARGE
            })
        );
    }

    // ─── Reconfigure ─────────────────────────────────────────────────────

    function _reconfigurePool(
        EulerSwap pool,
        IEulerSwap.DynamicParams memory d,
        address hook,
        uint80 marketPriceY,
        uint112 eq0,
        uint112 eq1
    ) internal {
        d.swapHook = hook;
        d.swapHookedOperations = EULER_SWAP_HOOK_GET_FEE | EULER_SWAP_HOOK_AFTER_SWAP;
        d.priceY = marketPriceY;
        d.equilibriumReserve0 = eq0;
        d.equilibriumReserve1 = eq1;
        d.minReserve0 = _computeMinReserve(eq0);
        d.minReserve1 = _computeMinReserve(eq1);
        d.concentrationX = 0;
        d.concentrationY = 0;
        d.fee0 = 0;
        d.fee1 = 0;
        d.expiration = 0; // no expiry — hook manages lifecycle

        evc.call(
            POOL,
            EULER_ACCOUNT,
            0,
            abi.encodeCall(
                IEulerSwap.reconfigure,
                (d, IEulerSwap.InitialState({reserve0: eq0, reserve1: eq1}))
            )
        );
    }

    // ─── Logging ─────────────────────────────────────────────────────────

    function _logPreFlight(
        address deployer,
        IEulerSwap.DynamicParams memory d,
        uint80 marketPriceY,
        uint256 xr,
        uint256 yr,
        uint112 eq0,
        uint112 eq1
    ) internal pure {
        console.log("=== DeployHookUSDCUSDT ===");
        console.log("Deployer:", deployer);
        console.log("Pool:", POOL);
        console.log("");
        console.log("--- Equity ---");
        console.log("USDC (xr):", xr);
        console.log("USDT (yr):", yr);
        console.log("");
        console.log("--- Calibrated reserves (h=1 at boundary) ---");
        console.log("eq0:", uint256(eq0));
        console.log("eq1:", uint256(eq1));
        console.log("min0:", uint256(_computeMinReserve(eq0)));
        console.log("min1:", uint256(_computeMinReserve(eq1)));
        console.log("range: 1 bps (1 tick)");
        console.log("");
        console.log("--- Current state ---");
        console.log("priceX:", uint256(d.priceX));
        console.log("priceY:", uint256(d.priceY), "-> market:", uint256(marketPriceY));
        console.log("Hook:", d.swapHook);
    }

    function _logFinalState(EulerSwap pool, DynamicFeeAuctionHook hook) internal view {
        IEulerSwap.DynamicParams memory d = pool.getDynamicParams();
        (uint112 r0, uint112 r1,) = pool.getReserves();

        console.log("");
        console.log("=== Final state ===");
        console.log("Hook:", d.swapHook);
        console.log("HookedOps:", uint256(d.swapHookedOperations));
        console.log("priceY:", uint256(d.priceY));
        console.log("eq0:", uint256(d.equilibriumReserve0));
        console.log("eq1:", uint256(d.equilibriumReserve1));
        console.log("min0:", uint256(d.minReserve0));
        console.log("min1:", uint256(d.minReserve1));
        console.log("Reserves:", uint256(r0), uint256(r1));

        (uint64 lastExp,, uint128 cachedNav) = hook.getExposureState();
        console.log("");
        console.log("=== Exposure state ===");
        console.log("lastExposure:", uint256(lastExp));
        console.log("cachedNav:", uint256(cachedNav));

        console.log("");
        console.log("=== Copy to .env ===");
        console.log(string.concat("HOOK_V7_USDC_USDT=", vm.toString(address(hook))));
    }
}
