//! Quote computation via eth_call to on-chain `computeQuote()`.
//!
//! Phase 1 implementation: all quoting is delegated to the pool contract.
//! This handles dynamic fees from hooks automatically since computeQuote()
//! calls getFee() on-chain.

use alloy::primitives::{Address, U256};
use alloy::providers::Provider;
use eyre::Result;
use tracing::debug;

use crate::abi::IEulerSwap;
use crate::types::EulerSwapPool;

/// Quotes EulerSwap pools via eth_call to `computeQuote()`.
pub struct EthCallQuoter<P: Provider> {
    provider: P,
}

impl<P: Provider> EthCallQuoter<P> {
    pub fn new(provider: P) -> Self {
        Self { provider }
    }

    /// Get output amount for an exact input swap.
    ///
    /// Returns `None` if the swap would revert (e.g., exceeds limits, pool locked).
    pub async fn get_amount_out(
        &self,
        pool: &EulerSwapPool,
        token_in: Address,
        token_out: Address,
        amount_in: U256,
    ) -> Result<Option<U256>> {
        self.quote(pool.address, token_in, token_out, amount_in, true)
            .await
    }

    /// Get input amount for an exact output swap.
    ///
    /// Returns `None` if the swap would revert.
    pub async fn get_amount_in(
        &self,
        pool: &EulerSwapPool,
        token_in: Address,
        token_out: Address,
        amount_out: U256,
    ) -> Result<Option<U256>> {
        self.quote(pool.address, token_in, token_out, amount_out, false)
            .await
    }

    /// Internal: call computeQuote() via eth_call.
    async fn quote(
        &self,
        pool_address: Address,
        token_in: Address,
        token_out: Address,
        amount: U256,
        exact_in: bool,
    ) -> Result<Option<U256>> {
        let contract = IEulerSwap::new(pool_address, &self.provider);

        match contract
            .computeQuote(token_in, token_out, amount, exact_in)
            .call()
            .await
        {
            Ok(result) => {
                let value = result;
                // U256::MAX is the Solidity overflow sentinel
                if value == U256::MAX {
                    debug!(?pool_address, "computeQuote returned overflow sentinel");
                    Ok(None)
                } else {
                    Ok(Some(value))
                }
            }
            Err(e) => {
                // Contract reverts are expected for limit-exceeding swaps, expired pools, etc.
                let err_str = e.to_string();
                if err_str.contains("revert") || err_str.contains("execution reverted") {
                    debug!(?pool_address, %err_str, "computeQuote reverted (expected)");
                    Ok(None)
                } else {
                    // Propagate unexpected RPC errors
                    Err(e.into())
                }
            }
        }
    }
}
