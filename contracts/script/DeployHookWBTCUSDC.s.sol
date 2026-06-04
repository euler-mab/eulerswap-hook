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

/// @dev WORKED EXAMPLE — pool / vault / oracle addresses are placeholders for a fresh
///      WBTC/USDC deployment. Kept as a concrete reference showing how the
///      DeployHookUSDCWETH structure flips when the BASE asset (WBTC) is token0 by
///      address ordering, rather than the quote asset. To deploy your own pool,
///      use the generic env-driven script/DeployHook.s.sol instead.
/// @title DeployHookWBTCUSDC — Deploy DynamicFeeAuctionHook on a WBTC/USDC EulerSwap pool
/// @notice Deploys the hook (NAV-based exposure tracking, curvature-aware surcharge,
///         exposure-sized auction shifts), recenters at market price, and installs via EVC.
///
/// @notice **Ordering note (read first)**: For WBTC/USDC the smaller 20-byte address is
///         WBTC (0x2260...), so the on-chain token0 is the BASE asset, not the quote.
///         Every "USDC = token0" assumption in DeployHookUSDCWETH.s.sol flips here:
///           - asset0 / supplyVault0 / borrowVault0 → WBTC (8 decimals)
///           - asset1 / supplyVault1 / borrowVault1 → USDC (6 decimals)
///         The Uniswap V3 oracle (`UNI_WBTC_USDC`) happens to use the same ordering —
///         its token0 is also WBTC — so the priceY recenter math from DeployHookUSDCWETH
///         carries over unchanged (`priceY = priceX * WAD / uniPriceWad`).
///         If you point this at a different oracle whose token ordering disagrees, set
///         the hook's `OracleConfig.token0` to that oracle's token0 and the hook will
///         auto-invert via its own `oracleToken0IsAsset0` check.
///
/// @notice The auction / fee / surcharge calibration is the output of the
///         `scripts/profiles/wbtc-usdc.json` profile run through
///         `scripts/calibrate-hook-params.ts` — see docs/build-your-own-active-lp.md
///         for the end-to-end command flow.
///
/// @dev Usage:
///   PRIVATE_KEY=0x... forge script script/DeployHookWBTCUSDC.s.sol:DeployHookWBTCUSDC \
///     --rpc-url $RPC_URL --broadcast --slow -vvvv
///
///   The deployer must be the pool's eulerAccount (or authorized operator).
contract DeployHookWBTCUSDC is Script {
    using Sqrt for uint256;

    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);

    // --- Pool and oracle addresses (mainnet WBTC/USDC) ---
    // POOL is a placeholder — replace with the address returned by DeployPool.s.sol
    // for the WBTC/USDC pool you deployed. EULER_ACCOUNT is the sub-account that
    // owns the LP equity (token0 ↔ WBTC, token1 ↔ USDC, in EVK supply/borrow vaults).
    address constant POOL = address(0);
    address constant EULER_ACCOUNT = address(0);

    // Uniswap V3 WBTC/USDC 0.3% fee tier. Picked over the 0.05% tier because it
    // carries ~16x more in-range liquidity (1.08e12 vs 6.69e10), so its spot
    // price is much harder to push around for a single-block oracle read.
    // token0 in this pool is WBTC (0x2260...) — same ordering as the EulerSwap pool.
    address constant UNI_WBTC_USDC = 0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35;

    uint256 constant Q192 = 1 << 192;
    uint256 constant WAD = 1e18;

    // ─── Calibrated parameters (from scripts/profiles/wbtc-usdc.json) ──────
    // Volatility class: "moderate" (BTC σ_annual ≈ 55%, vs ETH's ~70%).
    // Fee tier: 30 bps oracle, so baseFee=5 bps still undercuts on the retail side.

    // --- Fee parameters ---
    uint64 constant BASE_FEE = 5e14;          // 5 bps
    uint64 constant MAX_FEE = 3500e14;        // 3500 bps (35%) safety cap
    uint64 constant GAS_COEFF = uint64(6.54e10); // ~25 bps at 0.4 gwei for this pool depth
    uint64 constant EXTERNAL_FEE = 30e14;     // 30 bps (Uni V3 0.3% pool)
    uint256 constant CAPTURE_RATE = 0.8e18;   // 80% of net edge on arb side
    uint256 constant ATTRACT_RATE = 0.3e18;   // 30% of routing headroom on attract side

    // --- Auction parameters ---
    uint64 constant DECAY_PER_BLOCK = 339273554673902; // σ₁ at σ_annual=55%, ~3.39 bps/block
    uint64 constant AUCTION_TRIGGER = 0.5e18;            // 50% relative exposure (NAV-based)
    uint64 constant CLEAR_THRESHOLD = 0.005e18;          // 0.5% price convergence
    uint64 constant MAX_SHIFT_MAGNITUDE = 0.015e18;      // 150 bps cap (exposure-sized)
    uint64 constant MIN_AUCTION_BLOCKS = 12;             // ~12 blocks before clearing

    // --- Recenter parameters ---
    uint64 constant RECENTER_RANGE = 0.05e18;            // 5% price range
    uint64 constant MAX_RECENTER_DRIFT = 0.03e18;        // 3% max price drift per recenter
    uint64 constant MIN_RECENTER_DELTA = 0;              // no minimum exposure decrease

    // --- Surcharge parameters ---
    uint64 constant SURCHARGE_DECAY = 5e14;              // 5 bps/block (deploySurcharge / 100)
    uint64 constant SURCHARGE_MULTIPLIER = uint64(1.25e18); // 1.25× safety margin
    uint64 constant DEPLOY_SURCHARGE = 500e14;           // 500 bps

    function run() external {
        require(POOL != address(0), "POOL placeholder - fill in after DeployPool.s.sol");
        require(EULER_ACCOUNT != address(0), "EULER_ACCOUNT placeholder - fill in your sub-account");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        EulerSwap pool = EulerSwap(POOL);

        // Sanity-check pool ordering: token0 must be WBTC (the smaller address).
        // This catches the most common pre-broadcast footgun: pointing the
        // script at a pool whose vaults were configured in USDC/WBTC order
        // instead of WBTC/USDC. Done in a helper to avoid widening run()'s stack.
        _requireWbtcIsToken0(pool);

        // Read current state
        IEulerSwap.DynamicParams memory d = pool.getDynamicParams();
        (uint112 r0, uint112 r1,) = pool.getReserves();

        // Compute market priceY from Uniswap V3 slot0. uniPriceWad is the raw
        // USDC-per-WBTC ratio (because UNI_WBTC_USDC.token0 == WBTC). We compute
        // the curve's priceY such that priceX/priceY matches that ratio:
        //   priceY = priceX * WAD / uniPriceWad
        // This is the SAME formula DeployHookUSDCWETH uses — it works because
        // the formula doesn't care which side is base vs quote, only that the
        // oracle pool's token0 matches the EulerSwap pool's token0 (asserted
        // separately via OracleConfig.token0 below).
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(UNI_WBTC_USDC).slot0();
        uint256 sqrtP = uint256(sqrtPriceX96);
        uint256 priceWad = FullMath.mulDiv(sqrtP * sqrtP, WAD, Q192);
        require(priceWad > 0, "Oracle priceWad rounded to 0 - check oracle pool state");
        uint80 marketPriceY = uint80(uint256(d.priceX) * WAD / priceWad);

        // Pre-flight logging
        console.log("=== DeployHookWBTCUSDC ===");
        console.log("Deployer:", deployer);
        console.log("Pool:", POOL);
        console.log("");
        console.log("--- Current state ---");
        console.log("Reserves:", uint256(r0), uint256(r1));
        console.log("priceY:", uint256(d.priceY), "-> market:", uint256(marketPriceY));
        console.log("Hook:", d.swapHook);
        console.log("HookedOps:", uint256(d.swapHookedOperations));

        vm.startBroadcast(pk);

        // 1. Deploy hook
        DynamicFeeAuctionHook hook = new DynamicFeeAuctionHook(
            POOL,
            deployer,
            DynamicFeeAuctionHook.OracleConfig({
                target: UNI_WBTC_USDC,
                v4PoolId: bytes32(0),
                token0: IUniswapV3Pool(UNI_WBTC_USDC).token0()
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
        console.log("hook deployed:", address(hook));

        // 2. Reconfigure pool: install hook + recenter at market price.
        (r0, r1,) = pool.getReserves();

        d.swapHook = address(hook);
        d.swapHookedOperations = EULER_SWAP_HOOK_GET_FEE | EULER_SWAP_HOOK_AFTER_SWAP;
        d.priceY = marketPriceY;
        d.equilibriumReserve0 = r0;
        d.equilibriumReserve1 = r1;

        // Compute min reserves from recenterRange using curve math:
        // minReserve = eq * sqrt(WAD) / sqrt(WAD + r * WAD / (WAD - c))
        d.minReserve0 = _computeMinReserve(r0, d.concentrationX);
        d.minReserve1 = _computeMinReserve(r1, d.concentrationY);

        evc.call(
            POOL,
            EULER_ACCOUNT,
            0,
            abi.encodeCall(
                IEulerSwap.reconfigure,
                (d, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}))
            )
        );
        console.log("Pool reconfigured with hook");

        vm.stopBroadcast();

        // 3. Verify final state
        IEulerSwap.DynamicParams memory finalD = pool.getDynamicParams();
        (uint112 finalR0, uint112 finalR1,) = pool.getReserves();

        console.log("");
        console.log("=== Final state ===");
        console.log("Hook:", finalD.swapHook);
        console.log("HookedOps:", uint256(finalD.swapHookedOperations));
        console.log("priceY:", uint256(finalD.priceY));
        console.log("eq0:", uint256(finalD.equilibriumReserve0));
        console.log("eq1:", uint256(finalD.equilibriumReserve1));
        console.log("min0:", uint256(finalD.minReserve0));
        console.log("min1:", uint256(finalD.minReserve1));
        console.log("cx:", uint256(finalD.concentrationX));
        console.log("cy:", uint256(finalD.concentrationY));
        console.log("Reserves:", uint256(finalR0), uint256(finalR1));

        // hook-specific state
        (uint64 lastExp, , uint128 cachedNav) = hook.getExposureState();
        console.log("");
        console.log("=== Exposure state ===");
        console.log("lastExposure:", uint256(lastExp));
        console.log("cachedNav:", uint256(cachedNav));

        console.log("");
        console.log("=== Copy to .env ===");
        console.log(string.concat("HOOK_WBTC_USDC=", vm.toString(address(hook))));
    }

    function _requireWbtcIsToken0(EulerSwap pool) internal view {
        IEulerSwap.StaticParams memory sp = pool.getStaticParams();
        address poolAsset0 = IEVault(sp.supplyVault0).asset();
        require(
            poolAsset0 == 0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599,
            "Pool token0 is not WBTC - re-order vaults or use a different deploy script"
        );
    }

    function _computeMinReserve(uint112 eqReserve, uint64 concentration) internal pure returns (uint112) {
        uint256 r = uint256(RECENTER_RANGE);
        if (r == 0) return 0;

        uint256 c = uint256(concentration);
        if (c >= WAD) return 0;

        uint256 inner = WAD + r * WAD / (WAD - c);
        uint256 sqrtInner = inner.sqrt();

        return uint112(uint256(eqReserve) * 1e9 / sqrtInner); // 1e9 = sqrt(WAD)
    }
}
