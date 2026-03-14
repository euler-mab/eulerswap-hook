//! EulerSwap liquidity source for CoW Protocol driver integration.
//!
//! This crate implements pool discovery, quoting, and settlement encoding
//! for EulerSwap pools. Phase 1 uses `computeQuote()` via eth_call for
//! pricing — no native Rust curve math is needed.
//!
//! ## Modules
//!
//! - [`abi`] — Contract ABI bindings (sol! macro)
//! - [`types`] — Domain types (pool state, reserves, fees, limits)
//! - [`pool_fetching`] — Registry discovery and per-block state caching
//! - [`quoting`] — Quote computation via eth_call
//! - [`settlement`] — CoW settlement interaction encoding

pub mod abi;
pub mod pool_fetching;
pub mod quoting;
pub mod settlement;
pub mod types;

// Re-exports for convenience.
pub use pool_fetching::PoolFetcher;
pub use quoting::EthCallQuoter;
pub use settlement::{encode_swap, gas_estimate, Interaction};
pub use types::EulerSwapPool;
