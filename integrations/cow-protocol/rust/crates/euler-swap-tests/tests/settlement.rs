//! Settlement encoding tests: verify calldata matches spec and works on-chain.

mod helpers;

use alloy::primitives::{Address, U256};
use alloy::sol_types::SolCall;
use euler_swap::abi::{IERC20, IEulerSwap};
use euler_swap::settlement::{encode_swap, gas_estimate, COW_SETTLEMENT};
use euler_swap::types::*;
use helpers::*;

fn test_pool() -> EulerSwapPool {
    EulerSwapPool {
        address: POOL_USDC_WETH,
        asset0: USDC,
        asset1: WETH,
        reserves: Reserves { reserve0: 0, reserve1: 0, status: 1 },
        params: CurveParams {
            equilibrium_reserve0: 0, equilibrium_reserve1: 0,
            min_reserve0: 0, min_reserve1: 0,
            price_x: U256::ZERO, price_y: U256::ZERO,
            concentration_x: 0, concentration_y: 0,
        },
        fees: Fees { fee0: 0, fee1: 0 },
        limits: Limits::default(),
        hook: HookInfo { hook_address: Address::ZERO, hooked_operations: 0 },
        expiration: 0,
        gas_estimate: 150_000,
    }
}

#[test]
fn test_transfer_selector_is_correct() {
    let pool = test_pool();
    let interactions = encode_swap(
        &pool,
        WETH,
        U256::from(1_000_000_000_000_000_000u64),
        U256::from(2_055_313_102u64),
        COW_SETTLEMENT,
    );

    // ERC20.transfer = 0xa9059cbb
    assert_eq!(&interactions[0].calldata[..4], &[0xa9, 0x05, 0x9c, 0xbb]);
}

#[test]
fn test_swap_selector_is_correct() {
    let pool = test_pool();
    let interactions = encode_swap(
        &pool,
        WETH,
        U256::from(1u64),
        U256::from(1u64),
        COW_SETTLEMENT,
    );

    // swap = 0x022c0d9f (same as Uniswap V2)
    assert_eq!(&interactions[1].calldata[..4], &[0x02, 0x2c, 0x0d, 0x9f]);
}

#[test]
fn test_weth_in_usdc_out_encoding() {
    let pool = test_pool();
    let amount_in = U256::from(1_000_000_000_000_000_000u64);
    let amount_out = U256::from(2_055_313_102u64);

    let interactions = encode_swap(&pool, WETH, amount_in, amount_out, COW_SETTLEMENT);

    assert_eq!(interactions.len(), 2);

    // Interaction 0: transfer WETH to pool
    assert_eq!(interactions[0].target, WETH);
    assert_eq!(interactions[0].value, U256::ZERO);

    // Decode transfer calldata
    let transfer = IERC20::transferCall::abi_decode(&interactions[0].calldata).unwrap();
    assert_eq!(transfer.to, POOL_USDC_WETH);
    assert_eq!(transfer.amount, amount_in);

    // Interaction 1: swap on pool
    assert_eq!(interactions[1].target, POOL_USDC_WETH);
    assert_eq!(interactions[1].value, U256::ZERO);

    // Decode swap calldata: WETH is asset1, so amount0Out = usdc_out, amount1Out = 0
    let swap = IEulerSwap::swapCall::abi_decode(&interactions[1].calldata).unwrap();
    assert_eq!(swap.amount0Out, amount_out); // USDC out
    assert_eq!(swap.amount1Out, U256::ZERO);
    assert_eq!(swap.to, COW_SETTLEMENT);
    assert!(swap.data.is_empty());
}

#[test]
fn test_usdc_in_weth_out_encoding() {
    let pool = test_pool();
    let amount_in = U256::from(1_000_000_000u64);
    let amount_out = U256::from(483_420_909_396_946_239u64);

    let interactions = encode_swap(&pool, USDC, amount_in, amount_out, COW_SETTLEMENT);

    // Transfer: USDC to pool
    assert_eq!(interactions[0].target, USDC);
    let transfer = IERC20::transferCall::abi_decode(&interactions[0].calldata).unwrap();
    assert_eq!(transfer.to, POOL_USDC_WETH);
    assert_eq!(transfer.amount, amount_in);

    // Swap: USDC is asset0, so amount0Out = 0, amount1Out = weth_out
    let swap = IEulerSwap::swapCall::abi_decode(&interactions[1].calldata).unwrap();
    assert_eq!(swap.amount0Out, U256::ZERO);
    assert_eq!(swap.amount1Out, amount_out); // WETH out
    assert_eq!(swap.to, COW_SETTLEMENT);
}

#[test]
fn test_gas_estimate() {
    assert_eq!(gas_estimate(), 150_000);
}

#[test]
fn test_cow_settlement_address() {
    // Verify the hardcoded CoW settlement address
    let expected: Address = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41"
        .parse()
        .unwrap();
    assert_eq!(COW_SETTLEMENT, expected);
}

#[test]
fn test_zero_value_interactions() {
    let pool = test_pool();
    let interactions = encode_swap(
        &pool,
        WETH,
        U256::from(1u64),
        U256::from(1u64),
        COW_SETTLEMENT,
    );

    // Both interactions must have zero ETH value
    for interaction in &interactions {
        assert_eq!(interaction.value, U256::ZERO);
    }
}
