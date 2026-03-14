//! Domain types for EulerSwap pool state, curve parameters, and metadata.

use alloy_primitives::{Address, U256};
use serde::{Deserialize, Serialize};

use crate::abi::IEulerSwap;

/// 1e18 as u64 — the scale factor for fees and concentrations.
pub const E18: u64 = 1_000_000_000_000_000_000;

/// Hook operation flag: GET_FEE (bit 1).
const HOOK_GET_FEE: u8 = 0x02;

/// Complete state of an EulerSwap pool needed for quoting and settlement.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EulerSwapPool {
    pub address: Address,
    pub asset0: Address,
    pub asset1: Address,
    pub reserves: Reserves,
    pub params: CurveParams,
    pub fees: Fees,
    pub limits: Limits,
    pub hook: HookInfo,
    pub expiration: u64,
    pub gas_estimate: u64,
}

/// Current reserve state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reserves {
    pub reserve0: u128,
    pub reserve1: u128,
    /// 0 = unactivated, 1 = unlocked, 2 = locked.
    pub status: u32,
}

/// Curve shape parameters.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurveParams {
    pub equilibrium_reserve0: u128,
    pub equilibrium_reserve1: u128,
    pub min_reserve0: u128,
    pub min_reserve1: u128,
    /// Oracle price of asset0 (1e18 scale).
    pub price_x: U256,
    /// Oracle price of asset1 (1e18 scale).
    pub price_y: U256,
    /// Concentration for X-side (0 = constant-product, 1e18 = constant-sum).
    pub concentration_x: u64,
    /// Concentration for Y-side.
    pub concentration_y: u64,
}

/// Fee parameters.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fees {
    /// Fee when asset0 is input (1e18 scale, must be < 1e18).
    pub fee0: u64,
    /// Fee when asset1 is input (1e18 scale, must be < 1e18).
    pub fee1: u64,
}

/// Swap limits in both directions.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Limits {
    pub limit_in_0to1: Option<U256>,
    pub limit_out_0to1: Option<U256>,
    pub limit_in_1to0: Option<U256>,
    pub limit_out_1to0: Option<U256>,
}

/// Hook configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookInfo {
    pub hook_address: Address,
    pub hooked_operations: u8,
}

/// Immutable parameters cached at discovery time.
#[derive(Debug, Clone)]
pub struct StaticParams {
    pub supply_vault0: Address,
    pub supply_vault1: Address,
    pub borrow_vault0: Address,
    pub borrow_vault1: Address,
    pub euler_account: Address,
    pub fee_recipient: Address,
}

/// Ordered token pair for indexing.
#[derive(Debug, Clone, Hash, Eq, PartialEq)]
pub struct TokenPair(pub Address, pub Address);

impl EulerSwapPool {
    /// Whether this pool is active and can accept swaps.
    pub fn is_active(&self, now: u64) -> bool {
        // Must be unlocked
        if self.reserves.status != 1 {
            return false;
        }
        // Must not be expired
        if self.expiration != 0 && self.expiration <= now {
            return false;
        }
        // Must not have 100% fee (swap rejection)
        if self.fees.fee0 >= E18 || self.fees.fee1 >= E18 {
            return false;
        }
        true
    }

    /// Whether this pool uses dynamic fees from a hook.
    pub fn has_dynamic_fees(&self) -> bool {
        self.hook.hooked_operations & HOOK_GET_FEE != 0
    }

    /// Whether the given token is asset0.
    pub fn is_asset0(&self, token: Address) -> bool {
        token == self.asset0
    }

    /// Get the token pair (always asset0 < asset1).
    pub fn token_pair(&self) -> TokenPair {
        TokenPair(self.asset0, self.asset1)
    }
}

/// Convert ABI DynamicParams to our domain CurveParams.
impl From<&IEulerSwap::DynamicParams> for CurveParams {
    fn from(dp: &IEulerSwap::DynamicParams) -> Self {
        Self {
            equilibrium_reserve0: dp.equilibriumReserve0.to::<u128>(),
            equilibrium_reserve1: dp.equilibriumReserve1.to::<u128>(),
            min_reserve0: dp.minReserve0.to::<u128>(),
            min_reserve1: dp.minReserve1.to::<u128>(),
            price_x: U256::from(dp.priceX),
            price_y: U256::from(dp.priceY),
            concentration_x: dp.concentrationX,
            concentration_y: dp.concentrationY,
        }
    }
}

/// Convert ABI DynamicParams to our domain Fees.
impl From<&IEulerSwap::DynamicParams> for Fees {
    fn from(dp: &IEulerSwap::DynamicParams) -> Self {
        Self {
            fee0: dp.fee0,
            fee1: dp.fee1,
        }
    }
}

/// Convert ABI DynamicParams to our domain HookInfo.
impl From<&IEulerSwap::DynamicParams> for HookInfo {
    fn from(dp: &IEulerSwap::DynamicParams) -> Self {
        Self {
            hook_address: dp.swapHook,
            hooked_operations: dp.swapHookedOperations,
        }
    }
}

/// Convert ABI StaticParams to our domain StaticParams.
impl From<&IEulerSwap::StaticParams> for StaticParams {
    fn from(sp: &IEulerSwap::StaticParams) -> Self {
        Self {
            supply_vault0: sp.supplyVault0,
            supply_vault1: sp.supplyVault1,
            borrow_vault0: sp.borrowVault0,
            borrow_vault1: sp.borrowVault1,
            euler_account: sp.eulerAccount,
            fee_recipient: sp.feeRecipient,
        }
    }
}

/// Build a complete EulerSwapPool from on-chain data.
impl EulerSwapPool {
    pub fn from_on_chain(
        address: Address,
        asset0: Address,
        asset1: Address,
        reserve0: u128,
        reserve1: u128,
        status: u32,
        dp: &IEulerSwap::DynamicParams,
        limits: Limits,
    ) -> Self {
        Self {
            address,
            asset0,
            asset1,
            reserves: Reserves {
                reserve0,
                reserve1,
                status,
            },
            params: CurveParams::from(dp),
            fees: Fees::from(dp),
            limits,
            hook: HookInfo::from(dp),
            expiration: dp.expiration.to::<u64>(),
            gas_estimate: 150_000,
        }
    }
}
