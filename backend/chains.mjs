import { ethers } from "ethers";

const rpc = (chainId, fallback) => process.env[`RPC_${chainId}`] || fallback;

export const CHAINS = {
  84532: {
    chainId: 84532, name: "Base Sepolia", shortName: "Base",
    rpcUrl: rpc(84532, "https://sepolia.base.org"),
    diamondAddress: "0xb6cdAE7ccfEE03e351694c63436D5c5c073aEF84", // 2.0.12 redeploy (withdraw-fee facet)
    usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    explorerUrl: "https://sepolia.basescan.org", nativeSymbol: "ETH", tokenSymbol: "USDC", tokenDecimals: 6, recommended: true,
  },
  11155111: {
    chainId: 11155111, name: "Ethereum Sepolia", shortName: "Sepolia",
    rpcUrl: rpc(11155111, "https://ethereum-sepolia-rpc.publicnode.com"),
    diamondAddress: "0x5A061604A1d94f4fa9939544707f6B200d6bB5cf", // 2.0.12 redeploy (withdraw-fee facet)
    usdcAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    explorerUrl: "https://sepolia.etherscan.io", nativeSymbol: "ETH", tokenSymbol: "USDC", tokenDecimals: 6,
  },
  421614: {
    chainId: 421614, name: "Arbitrum Sepolia", shortName: "Arbitrum",
    rpcUrl: rpc(421614, "https://sepolia-rollup.arbitrum.io/rpc"),
    diamondAddress: "0x147C6D8cA1a4784Ed76d98b0E3CcA41C38a49A5f", // 2.0.12 redeploy (withdraw-fee facet)
    usdcAddress: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    explorerUrl: "https://sepolia.arbiscan.io", nativeSymbol: "ETH", tokenSymbol: "USDC", tokenDecimals: 6,
  },
  2201: {
    chainId: 2201, name: "Stable Testnet", shortName: "Stable",
    rpcUrl: rpc(2201, "https://rpc.testnet.stable.xyz"),
    diamondAddress: "0x0b6791C168ffBF52e82F5E862929Dbf505c3A46E", // 2.0.12 redeploy (withdraw-fee facet)
    usdcAddress: "0x78Cf24370174180738C5B8E352B6D14c83a6c9A9",
    explorerUrl: "https://testnet.stablescan.xyz", nativeSymbol: "ETH", tokenSymbol: "USDC", tokenDecimals: 6,
  },
  5042002: {
    chainId: 5042002, name: "Arc Testnet", shortName: "Arc",
    rpcUrl: rpc(5042002, "https://rpc.testnet.arc.network"),
    diamondAddress: "0xA90621B79d49c8E3A5eeEBcaaa839E2f886240C5", // 2.0.12 redeploy (withdraw-fee facet)
    usdcAddress: "0x3600000000000000000000000000000000000000",
    explorerUrl: "https://testnet.arcscan.app", nativeSymbol: "ETH", tokenSymbol: "USDC", tokenDecimals: 6,
  },
  42431: {
    chainId: 42431, name: "Tempo Testnet", shortName: "Tempo",
    rpcUrl: rpc(42431, "https://rpc.moderato.tempo.xyz"),
    diamondAddress: "0xE559fB936C69c46E216bf61B07C16bF1a6d444aa",
    usdcAddress: "0x20c0000000000000000000000000000000000000",
    explorerUrl: "https://explore.tempo.xyz", nativeSymbol: "TEMPO", tokenSymbol: "USD", tokenDecimals: 6,
  },
};

// Tempo (42431) hidden — not in the 2.0.12 redeploy set (old diamond lacks the
// withdraw-fee facet 2.0.12 needs). Re-add once its new diamond is provided.
export const CHAIN_ORDER = [84532, 11155111, 421614, 2201, 5042002];
export const DEFAULT_CHAIN_ID = 84532;
export const chainList = () => CHAIN_ORDER.map((id) => CHAINS[id]).filter(Boolean);
export const getChain = (id) => CHAINS[Number(id)] || null;
export const allDiamonds = () => chainList().map((c) => c.diamondAddress);

const _providers = {};
export function providerFor(chainId) {
  const c = getChain(chainId);
  if (!c) return null;
  if (!_providers[c.chainId]) _providers[c.chainId] = new ethers.JsonRpcProvider(c.rpcUrl, c.chainId);
  return _providers[c.chainId];
}

export const explorerTxFor = (chainId, hash) => { const c = getChain(chainId); return c && hash ? `${c.explorerUrl}/tx/${hash}` : null; };
