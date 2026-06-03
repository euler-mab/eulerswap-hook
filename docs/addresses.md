# Canonical Addresses

Per-chain reference for the contracts this repo interacts with. See [README](../README.md) for the project overview and [case-study-usdc-usdt.md](case-study-usdc-usdt.md) for the live deployment that uses these.

> **Note:** Addresses change with redeployments. Always verify against the source repos ([euler-swap](https://github.com/euler-xyz/euler-swap), [euler-vault-kit](https://github.com/euler-xyz/euler-vault-kit), [evk-periphery](https://github.com/euler-xyz/evk-periphery)) and on a block explorer before relying on them for a real deploy. The values below are a snapshot at the time of this commit.

---

## Ethereum Mainnet

### Euler core

| Contract | Address | Notes |
|---|---|---|
| EVC (Ethereum Vault Connector) | [`0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383`](https://etherscan.io/address/0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383) | Used by all deploy scripts; see [RegisterPools.s.sol](../contracts/script/RegisterPools.s.sol) and [DeployHookUSDCUSDT.s.sol](../contracts/script/DeployHookUSDCUSDT.s.sol). |

### EulerSwap

| Contract | Address | Notes |
|---|---|---|
| EulerSwap Registry | [`0x5FcCB84363F020c0cADE052C9c654aABF932814A`](https://etherscan.io/address/0x5FcCB84363F020c0cADE052C9c654aABF932814A) | Used by [RegisterPools.s.sol](../contracts/script/RegisterPools.s.sol). Pools must register here to be discoverable by integrators. |
| EulerSwap Factory | *not statically pinned in this repo* | The mainnet factory is deployed by the EVK periphery infrastructure rather than a fixed address checked into source. See the [euler-swap repo](https://github.com/euler-xyz/euler-swap) for the current factory, or look up the `PoolDeployed` event sender for any known mainnet pool (e.g. [USDC/USDT pool](https://etherscan.io/address/0x719529e99b7b272c5ef4ce07c30d15bc57cd68a8)). |

### Uniswap (used as fee oracle source)

| Contract | Address | Notes |
|---|---|---|
| Uniswap V4 PoolManager | [`0x000000000004444c5dc75cB358380D2e3dE08A90`](https://etherscan.io/address/0x000000000004444c5dc75cB358380D2e3dE08A90) | Read via `extsload` for V4-backed oracles. See [uniswap-oracle-pattern.md](uniswap-oracle-pattern.md). |
| Uniswap V3 USDC/WETH 0.05% pool | [`0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640`](https://etherscan.io/address/0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640) | Oracle source for the USDC/WETH propAMM pool. Sample V3 reference; substitute the appropriate fee-tier pool for your pair. |

### Live propAMM deployments

| Pool | Hook | Sub-account |
|---|---|---|
| USDC/WETH [`0x4311...28A8`](https://etherscan.io/address/0x4311031739918Aba578C3C667DA3028A12Ce28A8) | V7 [`0x7bb6...e4FB`](https://etherscan.io/address/0x7bb638b9842eA4275901aafB2e34943d9C2Fe4FB) | `0x2909bCc87c17d8Be263621bF087bC806BA313BFE` (sub `0x00`) |
| USDC/USDT [`0x7195...68A8`](https://etherscan.io/address/0x719529e99b7b272c5ef4ce07c30d15bc57cd68a8) | V7 [`0x99b9...4e41`](https://etherscan.io/address/0x99b97FD05b4F943899358F90855C0BEE34584e41) | `0x2909BCc87c17D8be263621bf087Bc806ba313BFf` (sub `0x01`) |

Deployer EOA: `0x2909bCc87c17d8Be263621bF087bC806BA313BFE`. See the [FAQ](faq.md#how-do-i-compute-a-sub-account-address-from-my-eoa) for the sub-account XOR derivation.

---

## Base

A testing deployment of EulerSwap exists on Base. These addresses are from [contracts/eulerswap/script/README.md](../contracts/eulerswap/script/README.md) and described there as **temporary deployments for testing** — the canonical EulerSwap instances will be deployed by the EVK periphery infrastructure, so verify before using in production.

| Contract | Address |
|---|---|
| EulerSwap Factory | [`0xd7c9ec4925e5d95d341a169e8d7275e92b064b74`](https://basescan.org/address/0xd7c9ec4925e5d95d341a169e8d7275e92b064b74) |
| EulerSwap Registry | [`0x93c4d4909fdc3b0651374f1160ec2aed4960d82c`](https://basescan.org/address/0x93c4d4909fdc3b0651374f1160ec2aed4960d82c) |
| EulerSwap Periphery | [`0x18f0e5f802937447f49ea5e8faebb454c5c74c71`](https://basescan.org/address/0x18f0e5f802937447f49ea5e8faebb454c5c74c71) |

This repo has no Base deploy scripts; you'd need to write your own using the mainnet scripts as templates.

---

## How to find your vaults

The propAMM pool needs a **supply vault** (where deposits sit as collateral) and a **borrow vault** (where the directional leg is borrowed from) for each side of the pair. To find the right ones for your assets:

1. **app.euler.finance** is the easiest path. Open the cluster you want to use (Prime, Yield, Stablecoin, etc.), pick your asset, and copy the vault address from the contract details panel. The same UI shows current LTVs, which you need for calibration ([calibration-guide.md](calibration-guide.md)).
2. **Query the EVK factory directly** via `cast` — the EVK factory exposes enumeration methods like `getProxyListSlice(start, end)` that return all deployed vault proxies. You can then call `asset()` on each to find the one matching your token. Interfaces are in [contracts/euler-interfaces/](../contracts/euler-interfaces).
3. **Read an existing deploy script.** [DeployHookUSDCUSDT.s.sol](../contracts/script/DeployHookUSDCUSDT.s.sol) and [DeployHookUSDCWETH.s.sol](../contracts/script/DeployHookUSDCWETH.s.sol) record the exact vault addresses used by the live pools — useful as a sanity check that you're looking at the same cluster.

Pick vaults whose **risk parameters (LTV, borrow caps, oracle)** match your calibration assumptions — different clusters carry different LTVs for the same asset, and using the wrong one will silently break your range calculation.
