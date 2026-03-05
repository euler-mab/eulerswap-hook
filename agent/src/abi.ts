// ABI fragments for EulerSwap pool and LPAgentHook

export const eulerSwapAbi = [
  {
    name: "getReserves",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "reserve0", type: "uint112" },
      { name: "reserve1", type: "uint112" },
      { name: "status", type: "uint32" },
    ],
  },
  {
    name: "getDynamicParams",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "equilibriumReserve0", type: "uint112" },
          { name: "equilibriumReserve1", type: "uint112" },
          { name: "minReserve0", type: "uint112" },
          { name: "minReserve1", type: "uint112" },
          { name: "priceX", type: "uint80" },
          { name: "priceY", type: "uint80" },
          { name: "concentrationX", type: "uint64" },
          { name: "concentrationY", type: "uint64" },
          { name: "fee0", type: "uint64" },
          { name: "fee1", type: "uint64" },
          { name: "expiration", type: "uint40" },
          { name: "swapHookedOperations", type: "uint8" },
          { name: "swapHook", type: "address" },
        ],
      },
    ],
  },
  {
    name: "getStaticParams",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "supplyVault0", type: "address" },
          { name: "supplyVault1", type: "address" },
          { name: "borrowVault0", type: "address" },
          { name: "borrowVault1", type: "address" },
          { name: "eulerAccount", type: "address" },
          { name: "feeRecipient", type: "address" },
        ],
      },
    ],
  },
  {
    name: "getAssets",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "asset0", type: "address" },
      { name: "asset1", type: "address" },
    ],
  },
  {
    name: "reconfigure",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "dParams",
        type: "tuple",
        components: [
          { name: "equilibriumReserve0", type: "uint112" },
          { name: "equilibriumReserve1", type: "uint112" },
          { name: "minReserve0", type: "uint112" },
          { name: "minReserve1", type: "uint112" },
          { name: "priceX", type: "uint80" },
          { name: "priceY", type: "uint80" },
          { name: "concentrationX", type: "uint64" },
          { name: "concentrationY", type: "uint64" },
          { name: "fee0", type: "uint64" },
          { name: "fee1", type: "uint64" },
          { name: "expiration", type: "uint40" },
          { name: "swapHookedOperations", type: "uint8" },
          { name: "swapHook", type: "address" },
        ],
      },
      {
        name: "initialState",
        type: "tuple",
        components: [
          { name: "reserve0", type: "uint112" },
          { name: "reserve1", type: "uint112" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

export const evcAbi = [
  {
    name: "call",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "targetContract", type: "address" },
      { name: "onBehalfOfAccount", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes" }],
  },
] as const;

// Euler vault and price oracle ABIs (for reading real oracle price)
export const evaultAbi = [
  {
    name: "oracle",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "unitOfAccount",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "asset",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export const priceOracleAbi = [
  {
    name: "getQuote",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "base", type: "address" },
      { name: "quote", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const erc20Abi = [
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

export const hookAbi = [
  {
    name: "getTradeStats",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "_tradeCount", type: "uint256" },
      { name: "_volume0", type: "uint256" },
      { name: "_volume1", type: "uint256" },
      { name: "_lastAsset0In", type: "bool" },
      { name: "_lastSize", type: "uint256" },
      { name: "_lastBlock", type: "uint256" },
    ],
  },
  {
    name: "getFeeParams",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "_baseFee", type: "uint64" },
      { name: "_maxFee", type: "uint64" },
      { name: "_minFee", type: "uint64" },
      { name: "_mismatchScale", type: "uint256" },
      { name: "_paused", type: "bool" },
    ],
  },
  {
    name: "setFeeParams",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_baseFee", type: "uint64" },
      { name: "_maxFee", type: "uint64" },
      { name: "_minFee", type: "uint64" },
      { name: "_mismatchScale", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "setPaused",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "_paused", type: "bool" }],
    outputs: [],
  },
  {
    name: "oraclePrice",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
