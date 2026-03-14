//! Pool discovery and state fetching from the EulerSwap registry.
//!
//! Discovery: enumerate pools from the registry (run periodically, ~5 min).
//! State refresh: fetch reserves, params, and limits per block.

use std::collections::HashMap;

use alloy::primitives::{Address, U256};
use alloy::providers::Provider;
use eyre::Result;
use tracing::{info, warn};

use crate::abi::{IEulerSwap, IEulerSwapRegistry};
use crate::types::{EulerSwapPool, Limits, StaticParams, TokenPair};

/// Metadata discovered once per pool (assets are immutable).
#[derive(Debug, Clone)]
pub struct PoolMetadata {
    pub address: Address,
    pub asset0: Address,
    pub asset1: Address,
    pub static_params: StaticParams,
}

/// Fetches and caches EulerSwap pool state from the on-chain registry.
pub struct PoolFetcher<P: Provider> {
    registry_address: Address,
    provider: P,
    /// Pool metadata keyed by pool address (discovered once, cached forever).
    known_pools: HashMap<Address, PoolMetadata>,
    /// Token pair index: (asset0, asset1) -> [pool addresses].
    pair_index: HashMap<TokenPair, Vec<Address>>,
}

impl<P: Provider> PoolFetcher<P> {
    pub fn new(registry_address: Address, provider: P) -> Self {
        Self {
            registry_address,
            provider,
            known_pools: HashMap::new(),
            pair_index: HashMap::new(),
        }
    }

    /// Discover all pools from the registry. Returns total pool count. Call periodically (~5 min).
    pub async fn discover_pools(&mut self) -> Result<usize> {
        let registry = IEulerSwapRegistry::new(self.registry_address, &self.provider);

        let count: u64 = registry.poolsLength().call().await?.to::<u64>();
        if count == 0 {
            return Ok(0);
        }

        let pool_addresses = registry
            .poolsSlice(U256::from(0u64), U256::from(count))
            .call()
            .await?;

        let mut new_count = 0;
        for &addr in &pool_addresses {
            if self.known_pools.contains_key(&addr) {
                continue;
            }

            let pool = IEulerSwap::new(addr, &self.provider);

            // Fetch immutable data
            let assets = match pool.getAssets().call().await {
                Ok(a) => a,
                Err(e) => {
                    warn!(?addr, ?e, "Failed to fetch assets, skipping pool");
                    continue;
                }
            };

            let static_params = match pool.getStaticParams().call().await {
                Ok(sp) => StaticParams::from(&sp),
                Err(e) => {
                    warn!(?addr, ?e, "Failed to fetch static params, skipping pool");
                    continue;
                }
            };

            // Check if installed
            match pool.isInstalled().call().await {
                Ok(installed) if !installed => {
                    info!(?addr, "Pool not installed, skipping");
                    continue;
                }
                Err(e) => {
                    warn!(?addr, ?e, "Failed to check install status, skipping pool");
                    continue;
                }
                _ => {}
            }

            let metadata = PoolMetadata {
                address: addr,
                asset0: assets.asset0,
                asset1: assets.asset1,
                static_params,
            };

            let pair = TokenPair(assets.asset0, assets.asset1);
            self.pair_index.entry(pair).or_default().push(addr);
            self.known_pools.insert(addr, metadata);
            new_count += 1;
        }

        info!(
            total = pool_addresses.len(),
            new = new_count,
            "Pool discovery complete"
        );
        Ok(pool_addresses.len())
    }

    /// Fetch current state for all known pools. Call per block / per auction round.
    pub async fn fetch_pool_states(&self) -> Result<Vec<EulerSwapPool>> {
        let mut pools = Vec::new();

        for meta in self.known_pools.values() {
            match self.fetch_single_pool(meta).await {
                Ok(pool) => pools.push(pool),
                Err(e) => {
                    warn!(pool = ?meta.address, ?e, "Failed to fetch pool state, skipping");
                }
            }
        }

        Ok(pools)
    }

    /// Fetch state for pools matching specific token pairs.
    pub async fn fetch_pools_for_pairs(
        &self,
        pairs: &[TokenPair],
    ) -> Result<Vec<EulerSwapPool>> {
        let mut pools = Vec::new();
        let mut seen = std::collections::HashSet::new();

        for pair in pairs {
            if let Some(addrs) = self.pair_index.get(pair) {
                for &addr in addrs {
                    if !seen.insert(addr) {
                        continue;
                    }
                    if let Some(meta) = self.known_pools.get(&addr) {
                        match self.fetch_single_pool(meta).await {
                            Ok(pool) => pools.push(pool),
                            Err(e) => {
                                warn!(pool = ?addr, ?e, "Failed to fetch pool state, skipping");
                            }
                        }
                    }
                }
            }
        }

        Ok(pools)
    }

    /// Fetch full state for a single pool.
    async fn fetch_single_pool(&self, meta: &PoolMetadata) -> Result<EulerSwapPool> {
        let pool = IEulerSwap::new(meta.address, &self.provider);

        // Fetch reserves
        let reserves = pool.getReserves().call().await?;

        // Fetch dynamic params
        let dp = pool.getDynamicParams().call().await?;

        // Fetch limits in both directions (graceful degradation if call fails)
        let limits_0to1: Option<IEulerSwap::getLimitsReturn> = pool
            .getLimits(meta.asset0, meta.asset1)
            .call()
            .await
            .ok();
        let limits_1to0: Option<IEulerSwap::getLimitsReturn> = pool
            .getLimits(meta.asset1, meta.asset0)
            .call()
            .await
            .ok();

        let limits = Limits {
            limit_in_0to1: limits_0to1.as_ref().map(|l| l.limitIn),
            limit_out_0to1: limits_0to1.as_ref().map(|l| l.limitOut),
            limit_in_1to0: limits_1to0.as_ref().map(|l| l.limitIn),
            limit_out_1to0: limits_1to0.as_ref().map(|l| l.limitOut),
        };

        Ok(EulerSwapPool::from_on_chain(
            meta.address,
            meta.asset0,
            meta.asset1,
            reserves.reserve0.to::<u128>(),
            reserves.reserve1.to::<u128>(),
            reserves.status,
            &dp,
            limits,
        ))
    }

    /// Get all known pool addresses.
    pub fn known_pool_addresses(&self) -> Vec<Address> {
        self.known_pools.keys().copied().collect()
    }

    /// Get the pair index.
    pub fn pair_index(&self) -> &HashMap<TokenPair, Vec<Address>> {
        &self.pair_index
    }

    /// Filter active pools from a list.
    pub fn filter_active(pools: &[EulerSwapPool], now: u64) -> Vec<&EulerSwapPool> {
        pools.iter().filter(|p| p.is_active(now)).collect()
    }
}
