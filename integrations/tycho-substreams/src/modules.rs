use std::collections::BTreeMap;

use anyhow::Result;
use num_bigint::BigInt;
use substreams::prelude::*;
use substreams::store::{StoreAddBigInt, StoreSetString};
use substreams_ethereum::pb::eth::v2::Block;

use crate::abi::euler_swap_pool::events::{EulerSwapConfigured, Swap};
use crate::abi::euler_swap_registry::events::{PoolRegistered, PoolUnregistered};
use crate::pb::tycho::{
    Attribute, BalanceChange, BalanceDelta, Block as TychoBlock, BlockBalanceDeltas, BlockChanges,
    BlockTransactionProtocolComponents, ChangeType, ContractChange, ContractSlot, EntityChanges,
    Transaction, TransactionChanges, TransactionProtocolComponents,
};
use crate::pool_factories;

// ─── Params ─────────────────────────────────────────────────────────────────

#[derive(Debug)]
struct DeploymentConfig {
    registry_address: Vec<u8>,
    hook_contracts: Vec<Vec<u8>>,
    oracle_contracts: Vec<Vec<u8>>,
}

fn decode_hex_list(val: &str) -> Result<Vec<Vec<u8>>, hex::FromHexError> {
    if val.is_empty() {
        return Ok(Vec::new());
    }
    val.split(',')
        .map(|s| hex::decode(s.trim()))
        .collect()
}

fn parse_config(params: &str) -> Result<DeploymentConfig> {
    let mut registry_address = Vec::new();
    let mut hook_contracts = Vec::new();
    let mut oracle_contracts = Vec::new();

    for pair in params.split('&') {
        let mut kv = pair.splitn(2, '=');
        let key = kv.next().unwrap_or("");
        let val = kv.next().unwrap_or("");
        match key {
            "registry_address" => registry_address = hex::decode(val)?,
            "hook_contracts" => hook_contracts = decode_hex_list(val)?,
            "oracle_contracts" => oracle_contracts = decode_hex_list(val)?,
            _ => {}
        }
    }

    Ok(DeploymentConfig {
        registry_address,
        hook_contracts,
        oracle_contracts,
    })
}

fn make_tx(tx: &substreams_ethereum::pb::eth::v2::TransactionTrace) -> Transaction {
    Transaction {
        hash: tx.hash.clone(),
        from: tx.from.clone(),
        to: tx.to.clone(),
        index: tx.index.into(),
    }
}

fn get_or_insert_tx<'a>(
    map: &'a mut BTreeMap<u64, TransactionChanges>,
    tx: Transaction,
) -> &'a mut TransactionChanges {
    map.entry(tx.index).or_insert_with(|| TransactionChanges {
        tx: Some(tx),
        ..Default::default()
    })
}

// ─── Module 1: map_protocol_components ──────────────────────────────────────
//
// PoolRegistered  → ProtocolComponent (Creation)
// PoolUnregistered → ProtocolComponent (Deletion)
//
// Unregistration is reversible — the pool contract survives and can be
// re-registered, which emits a fresh Creation.

#[substreams::handlers::map]
pub fn map_protocol_components(
    params: String,
    block: Block,
) -> Result<BlockTransactionProtocolComponents> {
    let config = parse_config(&params)?;
    let registry_addr: [u8; 20] = config
        .registry_address
        .as_slice()
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid registry address length"))?;

    let mut tx_components = Vec::new();

    for tx in block.transactions() {
        let mut components = Vec::new();

        for log in tx.logs_with_calls().map(|(log, _)| log) {
            let log_address: [u8; 20] = match log.address.as_slice().try_into() {
                Ok(a) => a,
                Err(_) => continue,
            };

            if log_address != registry_addr {
                continue;
            }

            if let Some(event) = PoolRegistered::match_and_decode(log) {
                let pool_addr: [u8; 20] = event.pool.to_fixed_bytes();
                components.push(pool_factories::create_component(&event, &pool_addr));
            }

            if let Some(event) = PoolUnregistered::match_and_decode(log) {
                components.push(crate::pb::tycho::ProtocolComponent {
                    id: hex::encode(event.pool.to_fixed_bytes()),
                    change: ChangeType::Deletion.into(),
                    ..Default::default()
                });
            }
        }

        if !components.is_empty() {
            tx_components.push(TransactionProtocolComponents {
                tx: Some(make_tx(tx)),
                components,
            });
        }
    }

    Ok(BlockTransactionProtocolComponents { tx_components })
}

// ─── Module 2: store_protocol_tokens ────────────────────────────────────────
//
// Store keys:
//   "pool:<hex>"         → "1"           — pool exists (event + storage filtering)
//   "<hex>:token:0"      → "<token_hex>" — asset0 address
//   "<hex>:token:1"      → "<token_hex>" — asset1 address

#[substreams::handlers::store]
pub fn store_protocol_tokens(
    components: BlockTransactionProtocolComponents,
    store: StoreSetString,
) {
    for tx_comp in &components.tx_components {
        for component in &tx_comp.components {
            if component.change == i32::from(ChangeType::Deletion) {
                continue;
            }

            store.set(0, &format!("pool:{}", component.id), "1");

            for (i, token) in component.tokens.iter().enumerate() {
                store.set(
                    0,
                    &format!("{}:token:{}", component.id, i),
                    &hex::encode(token),
                );
            }
        }
    }
}

// ─── Module 3: map_relative_component_balance ───────────────────────────────
//
// Swap events → signed BalanceDeltas (amountIn - amountOut per token).

#[substreams::handlers::map]
pub fn map_relative_component_balance(
    _params: String,
    block: Block,
    tokens_store: StoreGetString,
) -> Result<BlockBalanceDeltas> {
    let mut balance_deltas = Vec::new();
    let mut ordinal: u64 = 0;

    for tx in block.transactions() {
        for log in tx.logs_with_calls().map(|(log, _)| log) {
            let event = match Swap::match_and_decode(log) {
                Some(e) => e,
                None => continue,
            };

            let pool_addr: [u8; 20] = match log.address.as_slice().try_into() {
                Ok(a) => a,
                Err(_) => continue,
            };
            let component_id = hex::encode(pool_addr);

            if tokens_store
                .get_last(&format!("pool:{}", component_id))
                .is_none()
            {
                continue;
            }

            let token0 = match tokens_store.get_last(&format!("{}:token:0", component_id)) {
                Some(h) => hex::decode(&h).unwrap_or_default(),
                None => continue,
            };
            let token1 = match tokens_store.get_last(&format!("{}:token:1", component_id)) {
                Some(h) => hex::decode(&h).unwrap_or_default(),
                None => continue,
            };

            let tx_proto = make_tx(tx);
            let cid = component_id.as_bytes().to_vec();

            let delta0 = BigInt::from(event.amount0_in) - BigInt::from(event.amount0_out);
            let delta1 = BigInt::from(event.amount1_in) - BigInt::from(event.amount1_out);

            for (token, delta) in [(token0, delta0), (token1, delta1)] {
                if delta.sign() != num_bigint::Sign::NoSign {
                    ordinal += 1;
                    balance_deltas.push(BalanceDelta {
                        ord: ordinal,
                        tx: Some(tx_proto.clone()),
                        token,
                        delta: delta.to_signed_bytes_be(),
                        component_id: cid.clone(),
                    });
                }
            }
        }
    }

    Ok(BlockBalanceDeltas { balance_deltas })
}

// ─── Module 4: store_component_balances ─────────────────────────────────────

#[substreams::handlers::store]
pub fn store_component_balances(deltas: BlockBalanceDeltas, store: StoreAddBigInt) {
    for delta in &deltas.balance_deltas {
        let component_id = String::from_utf8_lossy(&delta.component_id);
        let key = format!("{}:{}", component_id, hex::encode(&delta.token));
        store.add(delta.ord, &key, BigInt::from_signed_bytes_be(&delta.delta));
    }
}

// ─── Module 5: map_protocol_changes ─────────────────────────────────────────
//
// Aggregates into BlockChanges:
//   1. Component creation/deletion
//   2. EulerSwapConfigured → update_marker EntityChange
//   3. Contract storage slot changes (pool + hook + oracle)
//   4. Balance changes from store deltas

#[substreams::handlers::map]
pub fn map_protocol_changes(
    params: String,
    block: Block,
    components: BlockTransactionProtocolComponents,
    balance_deltas: BlockBalanceDeltas,
    tokens_store: StoreGetString,
    balance_store: Deltas<DeltaBigInt>,
) -> Result<BlockChanges> {
    let config = parse_config(&params)?;

    let mut static_tracked: Vec<[u8; 20]> = config
        .hook_contracts
        .iter()
        .chain(&config.oracle_contracts)
        .filter_map(|c| <[u8; 20]>::try_from(c.as_slice()).ok())
        .collect();
    static_tracked.dedup();

    let mut tx_changes: BTreeMap<u64, TransactionChanges> = BTreeMap::new();

    // ── 1. Component creations/deletions ────────────────────────────────

    for tx_comp in &components.tx_components {
        if let Some(ref tx) = tx_comp.tx {
            get_or_insert_tx(&mut tx_changes, tx.clone())
                .component_changes
                .extend(tx_comp.components.clone());
        }
    }

    // ── 2. EulerSwapConfigured → update_marker ──────────────────────────

    for tx in block.transactions() {
        let mut entity_changes: Vec<EntityChanges> = Vec::new();

        for log in tx.logs_with_calls().map(|(log, _)| log) {
            if EulerSwapConfigured::match_and_decode(log).is_some() {
                let component_id = hex::encode(log.address.as_slice());
                if tokens_store
                    .get_last(&format!("pool:{}", component_id))
                    .is_some()
                {
                    entity_changes.push(EntityChanges {
                        component_id,
                        attributes: vec![Attribute {
                            name: "update_marker".to_string(),
                            value: vec![1u8],
                            change: ChangeType::Update.into(),
                        }],
                    });
                }
            }
        }

        if !entity_changes.is_empty() {
            get_or_insert_tx(&mut tx_changes, make_tx(tx))
                .entity_changes
                .extend(entity_changes);
        }
    }

    // ── 3. Contract storage changes (skips reverted calls) ──────────────

    for tx in block.transactions() {
        let mut contract_changes: Vec<ContractChange> = Vec::new();

        for call in tx.calls.iter() {
            if call.state_reverted {
                continue;
            }

            for sc in &call.storage_changes {
                let addr: [u8; 20] = match sc.address.as_slice().try_into() {
                    Ok(a) => a,
                    Err(_) => continue,
                };

                let is_tracked = static_tracked.contains(&addr)
                    || tokens_store
                        .get_last(&format!("pool:{}", hex::encode(addr)))
                        .is_some();

                if !is_tracked {
                    continue;
                }

                let slot = ContractSlot {
                    slot: sc.key.clone(),
                    value: sc.new_value.clone(),
                    previous_value: sc.old_value.clone(),
                };

                match contract_changes
                    .iter_mut()
                    .find(|c| c.address == addr.to_vec())
                {
                    Some(cc) => cc.slots.push(slot),
                    None => {
                        contract_changes.push(ContractChange {
                            address: addr.to_vec(),
                            slots: vec![slot],
                            change: ChangeType::Update.into(),
                            ..Default::default()
                        });
                    }
                }
            }
        }

        if !contract_changes.is_empty() {
            get_or_insert_tx(&mut tx_changes, make_tx(tx))
                .contract_changes
                .extend(contract_changes);
        }
    }

    // ── 4. Balance changes ──────────────────────────────────────────────

    for delta in balance_store.deltas.iter() {
        let parts: Vec<&str> = delta.key.splitn(2, ':').collect();
        if parts.len() != 2 {
            continue;
        }
        let (component_id, token_hex) = (parts[0], parts[1]);

        let token_addr = match hex::decode(token_hex) {
            Ok(addr) if addr.len() == 20 => addr,
            _ => continue,
        };

        let matching_delta = balance_deltas
            .balance_deltas
            .iter()
            .find(|d| String::from_utf8_lossy(&d.component_id) == component_id);
        let tx_index = matching_delta
            .and_then(|d| d.tx.as_ref())
            .map(|tx| tx.index)
            .unwrap_or(0);
        let entry = tx_changes
            .entry(tx_index)
            .or_insert_with(|| TransactionChanges {
                tx: matching_delta.and_then(|d| d.tx.clone()),
                ..Default::default()
            });
        entry.balance_changes.push(BalanceChange {
            token: token_addr,
            balance: delta.new_value.to_signed_bytes_be(),
            component_id: component_id.as_bytes().to_vec(),
        });
    }

    // ── Build output ────────────────────────────────────────────────────

    Ok(BlockChanges {
        block: Some(TychoBlock {
            hash: block.hash.clone(),
            parent_hash: block
                .header
                .as_ref()
                .map(|h| h.parent_hash.clone())
                .unwrap_or_default(),
            number: block.number,
            ts: block
                .header
                .as_ref()
                .map(|h| h.timestamp.as_ref().map(|t| t.seconds as u64).unwrap_or(0))
                .unwrap_or(0),
        }),
        changes: tx_changes.into_values().collect(),
        ..Default::default()
    })
}
