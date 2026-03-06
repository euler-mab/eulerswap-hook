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
  {
    name: "swap",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount0Out", type: "uint256" },
      { name: "amount1Out", type: "uint256" },
      { name: "to", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
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
  {
    name: "totalBorrows",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "totalAssets",
    type: "function",
    stateMutability: "view",
    inputs: [],
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
    name: "interestRate",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
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
    name: "LTVBorrow",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "collateral", type: "address" }],
    outputs: [{ name: "", type: "uint16" }],
  },
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    name: "deposit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
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
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
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
      { name: "_mismatchScale", type: "uint256" },
    ],
  },
  {
    name: "setFeeParams",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_baseFee", type: "uint64" },
      { name: "_maxFee", type: "uint64" },
      { name: "_mismatchScale", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

// Arbitrageur contract ABI
export const arbitrageurAbi = [
  {
    name: "execute",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pool", type: "address" },
      { name: "amount0Out", type: "uint256" },
      { name: "amount1Out", type: "uint256" },
      { name: "amountRequired", type: "uint256" },
      { name: "uniPoolFee", type: "uint24" },
      { name: "minProfit", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "withdrawAll",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "to", type: "address" },
    ],
    outputs: [],
  },
  {
    name: "owner",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

// EulerSwap Registry ABI
export const registryAbi = [
  {
    name: "validityBond",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "pool", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "poolByEulerAccount",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "who", type: "address" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "poolsLength",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// Uniswap V3 QuoterV2 — quoteExactInputSingle is NOT a view fn (uses revert trick)
export const quoterV2Abi = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;
