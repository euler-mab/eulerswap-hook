//! Quoting tests: verify all 31 test vectors from test-vectors.json against mainnet fork.

mod helpers;

use alloy::primitives::U256;
use euler_swap::abi::IEulerSwap;
use euler_swap::quoting::EthCallQuoter;
use euler_swap::types::*;
use helpers::*;

/// Create a minimal EulerSwapPool for quoting (only address and assets matter).
fn pool_for_quote(pool_addr: alloy::primitives::Address, asset0: alloy::primitives::Address, asset1: alloy::primitives::Address) -> EulerSwapPool {
    EulerSwapPool {
        address: pool_addr,
        asset0,
        asset1,
        reserves: Reserves { reserve0: 0, reserve1: 0, status: 1 },
        params: CurveParams {
            equilibrium_reserve0: 0, equilibrium_reserve1: 0,
            min_reserve0: 0, min_reserve1: 0,
            price_x: U256::ZERO, price_y: U256::ZERO,
            concentration_x: 0, concentration_y: 0,
        },
        fees: Fees { fee0: 0, fee1: 0 },
        limits: Limits::default(),
        hook: HookInfo { hook_address: alloy::primitives::Address::ZERO, hooked_operations: 0 },
        expiration: 0,
        gas_estimate: 150_000,
    }
}

/// Run all test vectors from test-vectors.json.
#[tokio::test]
async fn test_all_vectors() {
    let provider = fork_provider();
    let quoter = EthCallQuoter::new(&provider);
    let vectors = load_test_vectors();

    let mut pass_count = 0;
    let mut total = 0;

    for pool_data in &vectors.pools {
        let pool_addr: alloy::primitives::Address = pool_data.pool.parse().unwrap();
        let asset0: alloy::primitives::Address = pool_data.asset0.parse().unwrap();
        let asset1: alloy::primitives::Address = pool_data.asset1.parse().unwrap();
        let pool = pool_for_quote(pool_addr, asset0, asset1);

        // exactIn vectors
        for v in &pool_data.quotes.exact_in {
            total += 1;
            let token_in = token_address(&v.token_in);
            let token_out = token_address(&v.token_out);
            let amount_in = parse_amount(v.amount_in.as_ref().unwrap());
            let expected = v.expected_out.as_ref().unwrap();

            if expected.starts_with("REVERT") {
                let result = quoter.get_amount_out(&pool, token_in, token_out, amount_in).await.unwrap();
                assert!(
                    result.is_none(),
                    "[{}] {} — expected revert but got {:?}",
                    pool_data.id, v.description, result
                );
            } else {
                let expected_val = parse_amount(expected);
                let result = quoter.get_amount_out(&pool, token_in, token_out, amount_in).await.unwrap();
                assert_eq!(
                    result,
                    Some(expected_val),
                    "[{}] {} — expected {} got {:?}",
                    pool_data.id, v.description, expected, result
                );
            }
            pass_count += 1;
        }

        // exactOut vectors
        for v in &pool_data.quotes.exact_out {
            total += 1;
            let token_in = token_address(&v.token_in);
            let token_out = token_address(&v.token_out);
            let amount_out = parse_amount(v.amount_out.as_ref().unwrap());
            let expected = v.expected_in.as_ref().unwrap();

            if expected.starts_with("REVERT") {
                let result = quoter.get_amount_in(&pool, token_in, token_out, amount_out).await.unwrap();
                assert!(
                    result.is_none(),
                    "[{}] {} — expected revert but got {:?}",
                    pool_data.id, v.description, result
                );
            } else {
                let expected_val = parse_amount(expected);
                let result = quoter.get_amount_in(&pool, token_in, token_out, amount_out).await.unwrap();
                assert_eq!(
                    result,
                    Some(expected_val),
                    "[{}] {} — expected {} got {:?}",
                    pool_data.id, v.description, expected, result
                );
            }
            pass_count += 1;
        }

        // zeroAmount vectors
        for v in &pool_data.quotes.zero_amount {
            total += 1;
            let token_in = token_address(&v.token_in);
            let token_out = token_address(&v.token_out);
            let amount_in = parse_amount(v.amount_in.as_ref().unwrap());
            let expected_val = parse_amount(v.expected_out.as_ref().unwrap());

            let result = quoter.get_amount_out(&pool, token_in, token_out, amount_in).await.unwrap();
            assert_eq!(
                result,
                Some(expected_val),
                "[{}] {} — expected {} got {:?}",
                pool_data.id, v.description, v.expected_out.as_ref().unwrap(), result
            );
            pass_count += 1;
        }
    }

    assert_eq!(pass_count, total);
    eprintln!("All {total} test vectors passed.");
}

/// Test computeQuote directly via contract binding (sanity check).
#[tokio::test]
async fn test_compute_quote_direct() {
    let provider = fork_provider();
    let pool = IEulerSwap::new(POOL_USDC_WETH, &provider);

    // 1 WETH -> USDC (exactIn)
    let result = pool
        .computeQuote(WETH, USDC, U256::from(1_000_000_000_000_000_000u64), true)
        .call()
        .await
        .unwrap();

    assert_eq!(result, U256::from(2_055_313_102u64));
}

/// Test that limit-exceeding amounts return None (not an error).
#[tokio::test]
async fn test_limit_exceeded_returns_none() {
    let provider = fork_provider();
    let quoter = EthCallQuoter::new(&provider);
    let pool = pool_for_quote(POOL_USDC_WETH, USDC, WETH);

    // 10 WETH exceeds limit of ~7.588 WETH
    let result = quoter
        .get_amount_out(&pool, WETH, USDC, U256::from(10_000_000_000_000_000_000u128))
        .await
        .unwrap();

    assert!(result.is_none(), "Expected None for limit-exceeding swap");
}
