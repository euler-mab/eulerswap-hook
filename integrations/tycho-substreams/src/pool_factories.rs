use crate::abi::euler_swap_registry::events::PoolRegistered;
use crate::pb::tycho::{
    Attribute, ChangeType, FinancialType, ImplementationType, ProtocolComponent, ProtocolType,
};

pub const PROTOCOL_NAME: &str = "eulerswap";

fn creation_attr(name: &str, value: Vec<u8>) -> Attribute {
    Attribute {
        name: name.to_string(),
        value,
        change: ChangeType::Creation.into(),
    }
}

/// Creates a ProtocolComponent from a PoolRegistered event.
///
/// Component ID = lowercased hex pool address (no 0x prefix).
/// `contracts` contains only the pool address (immutable after creation).
/// Hook/oracle storage is tracked via params or DCI in the aggregation module.
/// `manual_updates=true` — re-simulation triggered by update_marker, not storage noise.
pub fn create_component(
    event: &PoolRegistered,
    pool_address: &[u8; 20],
) -> ProtocolComponent {
    let sp = &event.s_params;
    let static_att = vec![
        creation_attr("supply_vault_0", sp.0.to_fixed_bytes().to_vec()),
        creation_attr("supply_vault_1", sp.1.to_fixed_bytes().to_vec()),
        creation_attr("borrow_vault_0", sp.2.to_fixed_bytes().to_vec()),
        creation_attr("borrow_vault_1", sp.3.to_fixed_bytes().to_vec()),
        creation_attr("euler_account", sp.4.to_fixed_bytes().to_vec()),
        creation_attr("fee_recipient", sp.5.to_fixed_bytes().to_vec()),
        creation_attr("manual_updates", vec![1u8]),
    ];

    ProtocolComponent {
        id: hex::encode(pool_address),
        tokens: vec![
            event.asset0.to_fixed_bytes().to_vec(),
            event.asset1.to_fixed_bytes().to_vec(),
        ],
        contracts: vec![pool_address.to_vec()],
        static_att,
        change: ChangeType::Creation.into(),
        protocol_type: Some(ProtocolType {
            name: PROTOCOL_NAME.to_string(),
            financial_type: FinancialType::Swap.into(),
            attribute_schema: vec![],
            implementation_type: ImplementationType::Vm.into(),
        }),
    }
}
