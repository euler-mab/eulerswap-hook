//! Pool discovery and state fetching tests against a mainnet fork.

mod helpers;

use alloy::primitives::U256;
use euler_swap::abi::{IEulerSwap, IEulerSwapRegistry};
use euler_swap::pool_fetching::PoolFetcher;
use euler_swap::types::{EulerSwapPool, E18};
use helpers::*;

#[tokio::test]
async fn test_registry_pool_count() {
    let provider = fork_provider();
    let registry = IEulerSwapRegistry::new(REGISTRY, &provider);

    let count: u64 = registry.poolsLength().call().await.unwrap().to::<u64>();
    assert_eq!(count, 4, "Expected 4 pools in registry at block {TEST_BLOCK}");
}

#[tokio::test]
async fn test_registry_pool_addresses() {
    let provider = fork_provider();
    let registry = IEulerSwapRegistry::new(REGISTRY, &provider);

    let pools = registry
        .poolsSlice(U256::from(0u64), U256::from(4u64))
        .call()
        .await
        .unwrap();

    assert_eq!(pools.len(), 4);
    for expected in &EXPECTED_POOLS {
        assert!(
            pools.contains(expected),
            "Missing expected pool {expected:?}"
        );
    }
}

#[tokio::test]
async fn test_pool_metadata_fetch() {
    let provider = fork_provider();

    // Test USDC/WETH pool
    let pool = IEulerSwap::new(POOL_USDC_WETH, &provider);
    let assets = pool.getAssets().call().await.unwrap();
    assert_eq!(assets.asset0, USDC);
    assert_eq!(assets.asset1, WETH);

    let installed = pool.isInstalled().call().await.unwrap();
    assert!(installed, "USDC/WETH pool should be installed");

    // Test PYUSD/USDC pool
    let pool2 = IEulerSwap::new(POOL_PYUSD_USDC, &provider);
    let assets2 = pool2.getAssets().call().await.unwrap();
    assert_eq!(assets2.asset0, PYUSD);
    assert_eq!(assets2.asset1, USDC);
}

#[tokio::test]
async fn test_pool_fetcher_discovery() {
    let provider = fork_provider();
    let mut fetcher = PoolFetcher::new(REGISTRY, provider);

    let count = fetcher.discover_pools().await.unwrap();
    assert_eq!(count, 4);
    assert_eq!(fetcher.known_pool_addresses().len(), 4);
}

#[tokio::test]
async fn test_pool_fetcher_state() {
    let provider = fork_provider();
    let mut fetcher = PoolFetcher::new(REGISTRY, provider);

    fetcher.discover_pools().await.unwrap();
    let pools = fetcher.fetch_pool_states().await.unwrap();

    // Should have at least the 3 pools with test vectors (4th may also succeed)
    assert!(pools.len() >= 3, "Expected at least 3 pools, got {}", pools.len());

    // Find USDC/WETH pool and verify state
    let usdc_weth = pools.iter().find(|p| p.address == POOL_USDC_WETH).unwrap();
    assert_eq!(usdc_weth.asset0, USDC);
    assert_eq!(usdc_weth.asset1, WETH);
    assert_eq!(usdc_weth.reserves.status, 1);
    assert_eq!(usdc_weth.reserves.reserve0, 633_609_943_779u128);
    assert_eq!(usdc_weth.reserves.reserve1, 296_143_607_353_420_043_666u128);
    assert_eq!(usdc_weth.params.concentration_x, 0);
    assert_eq!(usdc_weth.params.concentration_y, 0);
}

#[tokio::test]
async fn test_pool_filtering() {
    // Test is_active() with constructed data
    let active_pool = make_test_pool(1, 0, 0, 0);
    assert!(active_pool.is_active(1000));

    // Locked pool
    let locked = make_test_pool(2, 0, 0, 0);
    assert!(!locked.is_active(1000));

    // Expired pool
    let expired = make_test_pool(1, 500, 0, 0);
    assert!(!expired.is_active(1000));

    // Not expired (expiration in future)
    let not_expired = make_test_pool(1, 2000, 0, 0);
    assert!(not_expired.is_active(1000));

    // No expiration (0 means never expires)
    let no_expiration = make_test_pool(1, 0, 0, 0);
    assert!(no_expiration.is_active(u64::MAX));

    // 100% fee (swap rejected)
    let full_fee = make_test_pool(1, 0, E18, 0);
    assert!(!full_fee.is_active(1000));
}

#[tokio::test]
async fn test_hook_detection() {
    let provider = fork_provider();
    let mut fetcher = PoolFetcher::new(REGISTRY, provider);
    fetcher.discover_pools().await.unwrap();
    let pools = fetcher.fetch_pool_states().await.unwrap();

    let usdc_weth = pools.iter().find(|p| p.address == POOL_USDC_WETH).unwrap();
    assert!(
        usdc_weth.has_dynamic_fees(),
        "USDC/WETH should have dynamic fees (swapHookedOperations=6)"
    );

    let pyusd_usdc = pools.iter().find(|p| p.address == POOL_PYUSD_USDC).unwrap();
    assert!(
        !pyusd_usdc.has_dynamic_fees(),
        "PYUSD/USDC should NOT have dynamic fees (swapHookedOperations=0)"
    );

    let usdc_usdt = pools.iter().find(|p| p.address == POOL_USDC_USDT).unwrap();
    assert!(
        usdc_usdt.has_dynamic_fees(),
        "USDC/USDT should have dynamic fees (swapHookedOperations=2)"
    );
}

/// Helper to create a test pool with specific parameters.
fn make_test_pool(status: u32, expiration: u64, fee0: u64, fee1: u64) -> EulerSwapPool {
    use alloy::primitives::Address;
    use euler_swap::types::*;

    EulerSwapPool {
        address: Address::ZERO,
        asset0: USDC,
        asset1: WETH,
        reserves: Reserves {
            reserve0: 0,
            reserve1: 0,
            status,
        },
        params: CurveParams {
            equilibrium_reserve0: 0,
            equilibrium_reserve1: 0,
            min_reserve0: 0,
            min_reserve1: 0,
            price_x: U256::ZERO,
            price_y: U256::ZERO,
            concentration_x: 0,
            concentration_y: 0,
        },
        fees: Fees { fee0, fee1 },
        limits: Limits::default(),
        hook: HookInfo {
            hook_address: Address::ZERO,
            hooked_operations: 0,
        },
        expiration,
        gas_estimate: 150_000,
    }
}
