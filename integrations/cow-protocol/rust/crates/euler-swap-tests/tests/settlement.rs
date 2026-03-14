//! Settlement encoding tests: verify calldata matches spec and works on-chain.

mod helpers;

use alloy::primitives::{Address, Bytes, U256};
use alloy::providers::ext::AnvilApi;
use alloy::providers::Provider;
use alloy::rpc::types::TransactionRequest;
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

// ---------------------------------------------------------------------------
// Fork-based settlement simulation tests
// ---------------------------------------------------------------------------

/// WETH deposit function selector (deposit() = receive ETH, wrap to WETH)
const WETH_DEPOSIT_SELECTOR: [u8; 4] = [0xd0, 0xe3, 0x0d, 0xb0];

/// Helper: send a raw transaction from an impersonated address.
async fn send_impersonated_tx(
    provider: &impl Provider,
    from: Address,
    to: Address,
    calldata: Bytes,
) {
    let tx = TransactionRequest::default()
        .from(from)
        .to(to)
        .input(calldata.into());
    provider.send_transaction(tx).await.unwrap().watch().await.unwrap();
}

/// Simulate a full WETH→USDC settlement on a mainnet fork.
///
/// This is the critical end-to-end test: it proves that the encoded
/// interactions actually move tokens correctly when executed on-chain.
#[tokio::test]
async fn test_settlement_simulation_weth_to_usdc() {
    let provider = fork_provider();

    let pool = test_pool();
    let amount_in = U256::from(1_000_000_000_000_000_000u64); // 1 WETH
    let expected_out = U256::from(2_055_313_102u64); // from test vector

    // 1. Fund the settlement contract with ETH and wrap to WETH
    provider.anvil_set_balance(COW_SETTLEMENT, U256::from(10u64) * amount_in).await.unwrap();
    provider.anvil_impersonate_account(COW_SETTLEMENT).await.unwrap();

    // Record initial balances
    let weth = IERC20::new(WETH, &provider);
    let usdc = IERC20::new(USDC, &provider);
    let weth_before = weth.balanceOf(COW_SETTLEMENT).call().await.unwrap();
    let usdc_before = usdc.balanceOf(COW_SETTLEMENT).call().await.unwrap();

    // Deposit ETH to get WETH
    let tx = TransactionRequest::default()
        .from(COW_SETTLEMENT)
        .to(WETH)
        .value(amount_in)
        .input(WETH_DEPOSIT_SELECTOR.to_vec().into());
    provider.send_transaction(tx).await.unwrap().watch().await.unwrap();

    // Verify WETH increased by deposit amount
    let weth_after_deposit = weth.balanceOf(COW_SETTLEMENT).call().await.unwrap();
    assert_eq!(
        weth_after_deposit - weth_before, amount_in,
        "WETH balance should increase by exactly 1 WETH"
    );

    // 2. Encode the swap interactions
    let interactions = encode_swap(&pool, WETH, amount_in, expected_out, COW_SETTLEMENT);
    assert_eq!(interactions.len(), 2);

    // 3. Execute both interactions as the settlement contract
    for interaction in &interactions {
        send_impersonated_tx(
            &provider,
            COW_SETTLEMENT,
            interaction.target,
            interaction.calldata.clone(),
        ).await;
    }

    // 4. Verify token balance deltas
    let usdc_after = usdc.balanceOf(COW_SETTLEMENT).call().await.unwrap();
    let usdc_received = usdc_after - usdc_before;
    assert_eq!(
        usdc_received, expected_out,
        "Settlement should receive exactly {expected_out} USDC, got {usdc_received}"
    );

    // WETH delta should equal amount_in (all deposited WETH was spent)
    let weth_final = weth.balanceOf(COW_SETTLEMENT).call().await.unwrap();
    assert_eq!(
        weth_final, weth_before,
        "WETH balance should return to pre-deposit level (all input spent)"
    );

    provider.anvil_stop_impersonating_account(COW_SETTLEMENT).await.unwrap();
}

/// Simulate a full USDC→WETH settlement on a mainnet fork (reverse direction).
#[tokio::test]
async fn test_settlement_simulation_usdc_to_weth() {
    let provider = fork_provider();

    let pool = test_pool();
    let amount_in = U256::from(1_000_000_000u64); // 1000 USDC
    let expected_out = U256::from(483_420_909_396_946_239u64); // ~0.483 WETH, from test vector

    // 1. Fund settlement with USDC by impersonating a whale
    // Circle's USDC treasury holds plenty at this block
    let usdc_whale: Address = "0x37305B1cD40574E4C5Ce33f8e8306Be057fD7341".parse().unwrap();
    provider.anvil_impersonate_account(usdc_whale).await.unwrap();
    provider.anvil_set_balance(usdc_whale, U256::from(1_000_000_000_000_000_000u64)).await.unwrap();

    let transfer_to_settlement = IERC20::transferCall {
        to: COW_SETTLEMENT,
        amount: amount_in,
    };
    send_impersonated_tx(
        &provider,
        usdc_whale,
        USDC,
        Bytes::from(transfer_to_settlement.abi_encode()),
    ).await;
    provider.anvil_stop_impersonating_account(usdc_whale).await.unwrap();

    // Verify USDC arrived
    let usdc = IERC20::new(USDC, &provider);
    let usdc_balance = usdc.balanceOf(COW_SETTLEMENT).call().await.unwrap();
    assert!(usdc_balance >= amount_in, "Settlement should hold at least {amount_in} USDC");

    // Record initial WETH balance
    let weth = IERC20::new(WETH, &provider);
    let weth_before = weth.balanceOf(COW_SETTLEMENT).call().await.unwrap();

    // 2. Encode and execute
    provider.anvil_impersonate_account(COW_SETTLEMENT).await.unwrap();
    provider.anvil_set_balance(COW_SETTLEMENT, U256::from(1_000_000_000_000_000_000u64)).await.unwrap();

    let interactions = encode_swap(&pool, USDC, amount_in, expected_out, COW_SETTLEMENT);

    for interaction in &interactions {
        send_impersonated_tx(
            &provider,
            COW_SETTLEMENT,
            interaction.target,
            interaction.calldata.clone(),
        ).await;
    }

    // 3. Verify WETH received
    let weth_after = weth.balanceOf(COW_SETTLEMENT).call().await.unwrap();
    let weth_received = weth_after - weth_before;
    assert_eq!(
        weth_received, expected_out,
        "Settlement should receive exactly {expected_out} WETH, got {weth_received}"
    );

    provider.anvil_stop_impersonating_account(COW_SETTLEMENT).await.unwrap();
}
