// Supported Fairblock / Stabletrust TESTNETS.
//
// Diamond (contract) addresses are the REDEPLOYED testnet diamonds (4-arg + fee
// facets), pinned explicitly per-chain here. confidential.js passes each one
// straight to the SDK's ConfidentialTransferClient, so THIS FILE is the single
// source of truth for the diamond addresses — it does NOT rely on the SDK's
// built-in address map. Token addresses + RPCs + explorers come from the SDK's own
// reference config (examples/complete-flow.js). The Turnkey wallet is ONE Ethereum
// address that works on every EVM chain here — but the confidential account
// (encryption key + on-chain registration) is PER-CHAIN, because the key is derived
// from an EIP-712 signature bound to (chainId, contract). So each redeployed diamond
// address means a FRESH confidential account per chain (old balances stay on the old
// diamonds).
//
// Any field can be overridden at build time with a VITE_ env var, e.g.
//   VITE_RPC_84532=https://my-base-sepolia-rpc  (per-chain RPC override)

const env = import.meta.env || {};
const rpcOverride = (chainId, fallback) => env[`VITE_RPC_${chainId}`] || fallback;

export const NETWORKS = {
  84532: {
    key: "base-sepolia",
    chainId: 84532,
    name: "Base Sepolia",
    shortName: "Base",
    rpcUrl: rpcOverride(84532, "https://sepolia.base.org"),
    diamondAddress: "0xb6cdAE7ccfEE03e351694c63436D5c5c073aEF84", // 2.0.12 redeploy (withdraw-fee facet)
    tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Circle test USDC
    tokenSymbol: "USDC",
    tokenDecimals: 6,
    nativeSymbol: "ETH",
    explorerUrl: "https://sepolia.basescan.org",
    gasFaucets: [
      { name: "Alchemy Base Sepolia faucet", url: "https://www.alchemy.com/faucets/base-sepolia" },
      { name: "Coinbase Developer faucet", url: "https://portal.cdp.coinbase.com/products/faucet" },
    ],
    tokenFaucets: [{ name: "Circle USDC faucet", url: "https://faucet.circle.com" }],
    recommended: true,
  },
  11155111: {
    key: "ethereum-sepolia",
    chainId: 11155111,
    name: "Ethereum Sepolia",
    shortName: "Sepolia",
    rpcUrl: rpcOverride(11155111, "https://ethereum-sepolia-rpc.publicnode.com"),
    diamondAddress: "0x5A061604A1d94f4fa9939544707f6B200d6bB5cf", // 2.0.12 redeploy (withdraw-fee facet)
    tokenAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    tokenSymbol: "USDC",
    tokenDecimals: 6,
    nativeSymbol: "ETH",
    explorerUrl: "https://sepolia.etherscan.io",
    gasFaucets: [
      { name: "Google Cloud Sepolia faucet", url: "https://cloud.google.com/application/web3/faucet/ethereum/sepolia" },
      { name: "Alchemy Sepolia faucet", url: "https://www.alchemy.com/faucets/ethereum-sepolia" },
    ],
    tokenFaucets: [{ name: "Circle USDC faucet", url: "https://faucet.circle.com" }],
  },
  421614: {
    key: "arbitrum-sepolia",
    chainId: 421614,
    name: "Arbitrum Sepolia",
    shortName: "Arbitrum",
    rpcUrl: rpcOverride(421614, "https://sepolia-rollup.arbitrum.io/rpc"),
    diamondAddress: "0x147C6D8cA1a4784Ed76d98b0E3CcA41C38a49A5f", // 2.0.12 redeploy (withdraw-fee facet)
    tokenAddress: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    tokenSymbol: "USDC",
    tokenDecimals: 6,
    nativeSymbol: "ETH",
    explorerUrl: "https://sepolia.arbiscan.io",
    gasFaucets: [
      { name: "Alchemy Arbitrum Sepolia faucet", url: "https://www.alchemy.com/faucets/arbitrum-sepolia" },
      { name: "QuickNode Arbitrum Sepolia faucet", url: "https://faucet.quicknode.com/arbitrum/sepolia" },
    ],
    tokenFaucets: [{ name: "Circle USDC faucet", url: "https://faucet.circle.com" }],
  },
  2201: {
    key: "stable-testnet",
    chainId: 2201,
    name: "Stable Testnet",
    shortName: "Stable",
    rpcUrl: rpcOverride(2201, "https://rpc.testnet.stable.xyz"),
    diamondAddress: "0x0b6791C168ffBF52e82F5E862929Dbf505c3A46E", // 2.0.12 redeploy (withdraw-fee facet)
    tokenAddress: "0x78Cf24370174180738C5B8E352B6D14c83a6c9A9",
    tokenSymbol: "USDC",
    tokenDecimals: 6,
    nativeSymbol: "ETH",
    explorerUrl: "https://testnet.stablescan.xyz",
    gasFaucets: [{ name: "Fairblock — request testnet funds", url: "https://docs.fairblock.network" }],
    tokenFaucets: [],
  },
  5042002: {
    key: "arc-testnet",
    chainId: 5042002,
    name: "Arc Testnet",
    shortName: "Arc",
    rpcUrl: rpcOverride(5042002, "https://rpc.testnet.arc.network"),
    diamondAddress: "0xA90621B79d49c8E3A5eeEBcaaa839E2f886240C5", // 2.0.12 redeploy (withdraw-fee facet)
    tokenAddress: "0x3600000000000000000000000000000000000000",
    tokenSymbol: "USDC",
    tokenDecimals: 6,
    nativeSymbol: "ETH",
    explorerUrl: "https://testnet.arcscan.app",
    gasFaucets: [{ name: "Fairblock — request testnet funds", url: "https://docs.fairblock.network" }],
    tokenFaucets: [],
  },
  42431: {
    key: "tempo-testnet",
    chainId: 42431,
    name: "Tempo Testnet",
    shortName: "Tempo",
    rpcUrl: rpcOverride(42431, "https://rpc.moderato.tempo.xyz"),
    diamondAddress: "0xE559fB936C69c46E216bf61B07C16bF1a6d444aa",
    // Tempo uses a native/system fee token; deposits use the same token.
    tokenAddress: "0x20c0000000000000000000000000000000000000",
    tokenSymbol: "USD",
    tokenDecimals: 6,
    nativeSymbol: "TEMPO",
    explorerUrl: "https://explore.tempo.xyz",
    gasFaucets: [{ name: "Fairblock — request testnet funds", url: "https://docs.fairblock.network" }],
    tokenFaucets: [],
  },
};

// Order shown in the picker (recommended EVM Sepolia testnets first).
// Tempo (42431) is temporarily hidden: its diamond was NOT part of the 2.0.12
// redeploy set, so its old diamond lacks the withdraw-fee facet that SDK 2.0.12's
// withdraw() reads (would revert). Re-add 42431 once a new Tempo diamond is provided.
export const NETWORK_ORDER = [84532, 11155111, 421614, 2201, 5042002];

export const DEFAULT_CHAIN_ID = 84532; // Base Sepolia — easiest faucets

export const networkList = () => NETWORK_ORDER.map((id) => NETWORKS[id]).filter(Boolean);

export function getNetwork(chainId) {
  return NETWORKS[Number(chainId)] || null;
}

// Confidential tokens the app offers per chain. IMPORTANT: the confidential
// diamond only accepts tokens its admin has whitelisted via setTokenConfig(token,
// true, mul) — see isSupportedToken() on-chain. So this list must be a SUBSET of
// the whitelisted tokens (today: just the default USDC on every chain).
//
// To add another supported token (once the admin has whitelisted it on-chain),
// add an optional `tokens: [{ address, symbol, decimals }, …]` array to that
// chain's record above — e.g. Base Sepolia once EURC is enabled:
//   tokens: [
//     { address: "0x036C…CF7e", symbol: "USDC", decimals: 6 },
//     { address: "0x…EURC…",   symbol: "EURC", decimals: 6 },
//   ]
// Users can also add a whitelisted token by address at runtime (validated on-chain).
export function getTokens(chainId) {
  const n = getNetwork(chainId);
  if (!n) return [];
  if (Array.isArray(n.tokens) && n.tokens.length) return n.tokens;
  return [{ address: n.tokenAddress, symbol: n.tokenSymbol, decimals: n.tokenDecimals }];
}

const LSKEY = "fbp-network";

export function loadSelectedChainId() {
  try {
    const v = Number(localStorage.getItem(LSKEY));
    if (v && NETWORKS[v]) return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_CHAIN_ID;
}

export function saveSelectedChainId(chainId) {
  try {
    localStorage.setItem(LSKEY, String(chainId));
  } catch {
    /* ignore */
  }
}

// A block explorer link for a tx hash / address.
export function explorerTx(chainId, hash) {
  const n = getNetwork(chainId);
  return n && hash ? `${n.explorerUrl}/tx/${hash}` : null;
}
export function explorerAddress(chainId, address) {
  const n = getNetwork(chainId);
  return n && address ? `${n.explorerUrl}/address/${address}` : null;
}
