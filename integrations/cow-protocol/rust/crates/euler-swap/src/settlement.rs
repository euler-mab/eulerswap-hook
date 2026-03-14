//! Settlement encoding for CoW Protocol interactions.
//!
//! Each EulerSwap swap requires two interactions:
//! 1. Transfer input tokens to the pool (ERC20.transfer)
//! 2. Execute the swap on the pool (pool.swap)
//!
//! This is simpler than Uniswap V2 in CoW (which routes through a router):
//! EulerSwap swaps go directly to the pool contract.

use alloy::primitives::{Address, Bytes, U256};
use alloy::sol_types::SolCall;

use crate::abi::{IERC20, IEulerSwap};
use crate::types::EulerSwapPool;

/// A single interaction in a CoW Protocol settlement.
#[derive(Debug, Clone)]
pub struct Interaction {
    pub target: Address,
    pub value: U256,
    pub calldata: Bytes,
}

/// Estimated gas cost per EulerSwap swap.
pub const GAS_ESTIMATE: u64 = 150_000;

/// CoW Protocol settlement contract address (mainnet).
pub const COW_SETTLEMENT: Address = Address::new([
    0x90, 0x08, 0xD1, 0x9f, 0x58, 0xAA, 0xbD, 0x9e, 0xD0, 0xD6,
    0x09, 0x71, 0x56, 0x5A, 0xA8, 0x51, 0x05, 0x60, 0xab, 0x41,
]);

/// Encode a swap through an EulerSwap pool as CoW settlement interactions.
///
/// Returns two interactions:
/// 1. `ERC20.transfer(pool, amount_in)` — send input tokens to pool
/// 2. `pool.swap(amount0Out, amount1Out, settlement, "")` — execute swap
pub fn encode_swap(
    pool: &EulerSwapPool,
    token_in: Address,
    amount_in: U256,
    amount_out: U256,
    settlement: Address,
) -> Vec<Interaction> {
    let asset0_is_input = pool.is_asset0(token_in);

    // Interaction 1: Transfer input tokens to pool
    let transfer_call = IERC20::transferCall {
        to: pool.address,
        amount: amount_in,
    };

    // Interaction 2: Execute swap on pool
    // If input is asset0 -> output is asset1 (amount1Out = amount_out)
    // If input is asset1 -> output is asset0 (amount0Out = amount_out)
    let (amount0_out, amount1_out) = if asset0_is_input {
        (U256::ZERO, amount_out)
    } else {
        (amount_out, U256::ZERO)
    };

    let swap_call = IEulerSwap::swapCall {
        amount0Out: amount0_out,
        amount1Out: amount1_out,
        to: settlement,
        data: Bytes::new(),
    };

    vec![
        Interaction {
            target: token_in,
            value: U256::ZERO,
            calldata: Bytes::from(transfer_call.abi_encode()),
        },
        Interaction {
            target: pool.address,
            value: U256::ZERO,
            calldata: Bytes::from(swap_call.abi_encode()),
        },
    ]
}

/// Return the gas estimate for a single EulerSwap interaction.
pub fn gas_estimate() -> u64 {
    GAS_ESTIMATE
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::*;
    use alloy::primitives::address;

    fn test_pool() -> EulerSwapPool {
        let usdc = address!("A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
        let weth = address!("C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
        let pool_addr = address!("4311031739918Aba578C3C667DA3028A12Ce28A8");

        EulerSwapPool {
            address: pool_addr,
            asset0: usdc,  // USDC < WETH by address
            asset1: weth,
            reserves: Reserves { reserve0: 0, reserve1: 0, status: 1 },
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
            fees: Fees { fee0: 0, fee1: 0 },
            limits: Limits::default(),
            hook: HookInfo {
                hook_address: Address::ZERO,
                hooked_operations: 0,
            },
            expiration: 0,
            gas_estimate: GAS_ESTIMATE,
        }
    }

    #[test]
    fn test_transfer_selector() {
        // ERC20.transfer selector is 0xa9059cbb
        let pool = test_pool();
        let interactions = encode_swap(
            &pool,
            pool.asset1, // WETH in
            U256::from(1_000_000_000_000_000_000u64), // 1 WETH
            U256::from(2_055_313_102u64), // ~2055 USDC
            COW_SETTLEMENT,
        );

        assert_eq!(interactions.len(), 2);
        assert_eq!(&interactions[0].calldata[..4], &[0xa9, 0x05, 0x9c, 0xbb]);
    }

    #[test]
    fn test_swap_selector() {
        // swap selector is 0x022c0d9f (same as Uniswap V2)
        let pool = test_pool();
        let interactions = encode_swap(
            &pool,
            pool.asset1,
            U256::from(1u64),
            U256::from(1u64),
            COW_SETTLEMENT,
        );

        assert_eq!(&interactions[1].calldata[..4], &[0x02, 0x2c, 0x0d, 0x9f]);
    }

    #[test]
    fn test_weth_in_usdc_out() {
        let pool = test_pool();
        let interactions = encode_swap(
            &pool,
            pool.asset1, // WETH is asset1
            U256::from(1_000_000_000_000_000_000u64),
            U256::from(2_055_313_102u64),
            COW_SETTLEMENT,
        );

        // Transfer: target = WETH
        assert_eq!(interactions[0].target, pool.asset1);
        assert_eq!(interactions[0].value, U256::ZERO);
        // Swap: target = pool, amount0Out = 2055313102 (USDC), amount1Out = 0
        assert_eq!(interactions[1].target, pool.address);
        assert_eq!(interactions[1].value, U256::ZERO);
    }

    #[test]
    fn test_usdc_in_weth_out() {
        let pool = test_pool();
        let interactions = encode_swap(
            &pool,
            pool.asset0, // USDC is asset0
            U256::from(1_000_000_000u64), // 1000 USDC
            U256::from(483_420_909_396_946_239u64),
            COW_SETTLEMENT,
        );

        // Transfer: target = USDC
        assert_eq!(interactions[0].target, pool.asset0);
        // Swap: target = pool
        assert_eq!(interactions[1].target, pool.address);
    }

    #[test]
    fn test_gas_estimate_value() {
        assert_eq!(gas_estimate(), 150_000);
    }
}
