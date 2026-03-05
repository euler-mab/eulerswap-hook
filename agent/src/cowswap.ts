import type { Address, WalletClient } from "viem";

const COWSWAP_API = "https://api.cow.fi/mainnet/api/v1";

const GPV2_SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41" as Address;
export const GPV2_VAULT_RELAYER = "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110" as Address;

const ORDER_TIMEOUT_MS = 300_000; // 5 minutes
const POLL_INTERVAL_MS = 5_000;

// EIP-712 domain for GPv2 Settlement (mainnet)
const GPV2_DOMAIN = {
  name: "Gnosis Protocol",
  version: "v2",
  chainId: 1,
  verifyingContract: GPV2_SETTLEMENT,
} as const;

// EIP-712 Order type definition (matches GPv2Order struct)
const ORDER_TYPES = {
  Order: [
    { name: "sellToken", type: "address" },
    { name: "buyToken", type: "address" },
    { name: "receiver", type: "address" },
    { name: "sellAmount", type: "uint256" },
    { name: "buyAmount", type: "uint256" },
    { name: "validTo", type: "uint32" },
    { name: "appData", type: "bytes32" },
    { name: "feeAmount", type: "uint256" },
    { name: "kind", type: "string" },
    { name: "partiallyFillable", type: "bool" },
    { name: "sellTokenBalance", type: "string" },
    { name: "buyTokenBalance", type: "string" },
  ],
} as const;

const ZERO_APP_DATA = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

export interface CowSwapOrder {
  sellToken: Address;
  buyToken: Address;
  receiver: Address;
  sellAmount: string;
  buyAmount: string;
  validTo: number;
  feeAmount: string;
  kind: "sell";
  partiallyFillable: boolean;
}

export interface CowSwapResult {
  orderUid: string;
  sellAmount: bigint;
  buyAmount: bigint;
  status: "fulfilled" | "expired" | "cancelled";
}

/** Get an execution quote from CowSwap including solver fees */
export async function getSwapQuote(
  sellToken: Address,
  buyToken: Address,
  sellAmount: bigint,
  from: Address,
): Promise<CowSwapOrder | null> {
  const validTo = Math.floor(Date.now() / 1000) + 600; // 10 min validity

  try {
    const res = await fetch(`${COWSWAP_API}/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sellToken,
        buyToken,
        sellAmountBeforeFee: sellAmount.toString(),
        kind: "sell",
        from,
        receiver: from,
        validTo,
        appData: ZERO_APP_DATA,
        partiallyFillable: false,
        signingScheme: "eip712",
      }),
    });

    if (!res.ok) {
      const error = await res.text();
      console.error(`CowSwap quote error: ${res.status} ${error}`);
      return null;
    }

    const data = (await res.json()) as {
      quote: {
        sellToken: string;
        buyToken: string;
        receiver: string;
        sellAmount: string;
        buyAmount: string;
        validTo: number;
        feeAmount: string;
        kind: string;
        partiallyFillable: boolean;
      };
    };

    return {
      sellToken: data.quote.sellToken as Address,
      buyToken: data.quote.buyToken as Address,
      receiver: data.quote.receiver as Address,
      sellAmount: data.quote.sellAmount,
      buyAmount: data.quote.buyAmount,
      validTo: data.quote.validTo,
      feeAmount: data.quote.feeAmount,
      kind: "sell",
      partiallyFillable: false,
    };
  } catch (err) {
    console.error(`CowSwap quote failed: ${err}`);
    return null;
  }
}

/** Sign a CowSwap order using EIP-712 via the agent's wallet */
export async function signOrder(
  walletClient: WalletClient,
  order: CowSwapOrder,
): Promise<`0x${string}`> {
  const account = walletClient.account;
  if (!account) throw new Error("Wallet client has no account");

  return walletClient.signTypedData({
    account,
    domain: GPV2_DOMAIN,
    types: ORDER_TYPES,
    primaryType: "Order",
    message: {
      sellToken: order.sellToken,
      buyToken: order.buyToken,
      receiver: order.receiver,
      sellAmount: BigInt(order.sellAmount),
      buyAmount: BigInt(order.buyAmount),
      validTo: order.validTo,
      appData: ZERO_APP_DATA,
      feeAmount: BigInt(order.feeAmount),
      kind: "sell",
      partiallyFillable: false,
      sellTokenBalance: "erc20",
      buyTokenBalance: "erc20",
    },
  });
}

/** Submit a signed order to CowSwap, returns the order UID */
export async function submitOrder(
  order: CowSwapOrder,
  signature: string,
  from: Address,
): Promise<string> {
  const res = await fetch(`${COWSWAP_API}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sellToken: order.sellToken,
      buyToken: order.buyToken,
      receiver: order.receiver,
      sellAmount: order.sellAmount,
      buyAmount: order.buyAmount,
      validTo: order.validTo,
      feeAmount: order.feeAmount,
      kind: "sell",
      partiallyFillable: false,
      appData: ZERO_APP_DATA,
      sellTokenBalance: "erc20",
      buyTokenBalance: "erc20",
      from,
      signature,
      signingScheme: "eip712",
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`CowSwap order submission failed: ${res.status} ${error}`);
  }

  return (await res.json()) as string;
}

/** Poll CowSwap for order completion with timeout */
export async function waitForOrder(orderUid: string): Promise<CowSwapResult> {
  const deadline = Date.now() + ORDER_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

    try {
      const res = await fetch(`${COWSWAP_API}/orders/${orderUid}`);
      if (!res.ok) continue;

      const data = (await res.json()) as {
        status: string;
        executedSellAmount?: string;
        executedBuyAmount?: string;
        sellAmount: string;
        buyAmount: string;
      };

      if (data.status === "fulfilled") {
        return {
          orderUid,
          sellAmount: BigInt(data.executedSellAmount ?? data.sellAmount),
          buyAmount: BigInt(data.executedBuyAmount ?? data.buyAmount),
          status: "fulfilled",
        };
      }

      if (data.status === "expired" || data.status === "cancelled") {
        return {
          orderUid,
          sellAmount: 0n,
          buyAmount: 0n,
          status: data.status as "expired" | "cancelled",
        };
      }
    } catch {
      // Network error, keep polling
    }
  }

  return { orderUid, sellAmount: 0n, buyAmount: 0n, status: "expired" };
}
