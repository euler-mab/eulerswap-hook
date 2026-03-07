// ABI fragments for pool monitoring (view-only subset from agent/src/abi.ts + events)

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
    name: "isInstalled",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  // Swap event
  {
    type: "event",
    name: "Swap",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "amount0In", type: "uint256", indexed: false },
      { name: "amount1In", type: "uint256", indexed: false },
      { name: "amount0Out", type: "uint256", indexed: false },
      { name: "amount1Out", type: "uint256", indexed: false },
      { name: "fee0", type: "uint256", indexed: false },
      { name: "fee1", type: "uint256", indexed: false },
      { name: "reserve0", type: "uint112", indexed: false },
      { name: "reserve1", type: "uint112", indexed: false },
      { name: "to", type: "address", indexed: true },
    ],
    anonymous: false,
  },
  // getLimits — max tradeable amounts in each direction
  {
    name: "getLimits",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
    ],
    outputs: [
      { name: "limitIn", type: "uint256" },
      { name: "limitOut", type: "uint256" },
    ],
  },
  // computeQuote — actual swap quote including hook fees and price impact
  {
    name: "computeQuote",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "exactIn", type: "bool" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const evaultAbi = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "convertToAssets",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "debtOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "asset",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "oracle",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "totalAssets",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "totalBorrows",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ERC4626 vault events for tracking capital flows
export const vaultEventAbi = [
  {
    type: "event",
    name: "Deposit",
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "assets", type: "uint256", indexed: false },
      { name: "shares", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Withdraw",
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "receiver", type: "address", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "assets", type: "uint256", indexed: false },
      { name: "shares", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
] as const;

export const erc20Abi = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

export const hookAbi = [
  {
    name: "getFeeParams",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "_baseFee", type: "uint64" },
      { name: "_maxFee", type: "uint64" },
      { name: "_gasCoeff", type: "uint64" },
      { name: "_externalFee", type: "uint64" },
      { name: "_captureRate", type: "uint256" },
      { name: "_attractRate", type: "uint256" },
    ],
  },
  {
    name: "getFee",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "asset0IsInput", type: "bool" },
      { name: "reserve0", type: "uint112" },
      { name: "reserve1", type: "uint112" },
      { name: "", type: "bool" },
    ],
    outputs: [{ name: "fee", type: "uint64" }],
  },
] as const;

export const uniswapV3PoolAbi = [
  {
    name: "slot0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
  {
    name: "observe",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "secondsAgos", type: "uint32[]" }],
    outputs: [
      { name: "tickCumulatives", type: "int56[]" },
      { name: "secondsPerLiquidityCumulativeX128s", type: "uint160[]" },
    ],
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
