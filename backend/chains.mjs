// ─────────────────────────────────────────────────────────────────────────────
// Model B multi-chain registry (server-side, for EXECUTION: providers, nonce
// reservation, broadcasting, receipts, explorer links).
//
// A treasury's wallet is ONE Ethereum address that works on every EVM chain here.
// The confidential diamond + USDC are per-chain. The confidential account (encryption
// key + on-chain registration) is per-chain too (derived from a sig bound to
// (chainId, contract)) — so funding/activation happen independently on each chain.
//
// ⚠ MUST STAY IN SYNC with frontend/src/networks.js (same diamond/token/rpc per chain).
// The frontend owns the UI extras (faucets, order); the backend owns execution.
// Per-chain RPC override: set env RPC_<chainId> (e.g. RPC_84532=https://…).
// ─────────────────────────────────────────────────────────────────────────────
import { ethers } from "ethers";

const rpc = (chainId, fallback) => process.env[`RPC_${chainId}`] || fallback;

export const CHAINS = {
  84532: {
    chainId: 84532, name: "Base Sepolia", shortName: "Base",
    rpcUrl: rpc(84532, "https://sepolia.base.org"),
    diamondAddress: "0x31Ce72e1D2A499140a95c19accE7bCF5E0664689",
    usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    explorerUrl: "https://sepolia.basescan.org", nativeSymbol: "ETH", tokenSymbol: "USDC", tokenDecimals: 6, recommended: true,
  },
  11155111: {
    chainId: 11155111, name: "Ethereum Sepolia", shortName: "Sepolia",
    rpcUrl: rpc(11155111, "https://ethereum-sepolia-rpc.publicnode.com"),
    diamondAddress: "0x7aeb444f608bDA6f922B0dBaDad6F83BCB516338",
    usdcAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    explorerUrl: "https://sepolia.etherscan.io", nativeSymbol: "ETH", tokenSymbol: "USDC", tokenDecimals: 6,
  },
  421614: {
    chainId: 421614, name: "Arbitrum Sepolia", shortName: "Arbitrum",
    rpcUrl: rpc(421614, "https://sepolia-rollup.arbitrum.io/rpc"),
    diamondAddress: "0xd180189fa0774736127146a87290B4EeAe545314",
    usdcAddress: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    explorerUrl: "https://sepolia.arbiscan.io", nativeSymbol: "ETH", tokenSymbol: "USDC", tokenDecimals: 6,
  },
  2201: {
    chainId: 2201, name: "Stable Testnet", shortName: "Stable",
    rpcUrl: rpc(2201, "https://rpc.testnet.stable.xyz"),
    diamondAddress: "0x196f9F80134c2DeBa81E93cb4C8aD37924149A74",
    usdcAddress: "0x78Cf24370174180738C5B8E352B6D14c83a6c9A9",
    explorerUrl: "https://testnet.stablescan.xyz", nativeSymbol: "ETH", tokenSymbol: "USDC", tokenDecimals: 6,
  },
  5042002: {
    chainId: 5042002, name: "Arc Testnet", shortName: "Arc",
    rpcUrl: rpc(5042002, "https://rpc.testnet.arc.network"),
    diamondAddress: "0x2f9EAcE58059592f428C1dE1237ff1D4957548E3",
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

export const CHAIN_ORDER = [84532, 11155111, 421614, 2201, 5042002, 42431];
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
