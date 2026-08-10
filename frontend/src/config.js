// Model B config — the backend is the single source of truth (auth + chain). No wallet-kit,
// no client-side network picker: a treasury runs on ONE chain (Base Sepolia) from the backend.
export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:8792";

let _backend = null;
export async function loadBackendConfig() {
  if (_backend) return _backend;
  const r = await fetch(`${BACKEND_URL}/api/config`);
  if (!r.ok) throw new Error(`backend /api/config failed: ${r.status}`);
  _backend = await r.json(); // { appName, chainId, rpcUrl, diamondAddress, usdcAddress, turnkeyBaseUrl, ... }
  return _backend;
}

export function buildConfig(b) {
  return {
    backend: BACKEND_URL,
    appName: b.appName,
    turnkeyBaseUrl: b.turnkeyBaseUrl,
    chainId: Number(b.chainId),
    rpcUrl: b.rpcUrl,
    diamondAddress: b.diamondAddress,
    tokenAddress: b.usdcAddress,
    tokenSymbol: "USDC",
    tokenDecimals: 6,
    networkName: "Base Sepolia",
    explorerUrl: "https://sepolia.basescan.org",
    nativeSymbol: "ETH",
    gasFaucets: [
      { name: "Alchemy Base Sepolia faucet", url: "https://www.alchemy.com/faucets/base-sepolia" },
      { name: "Coinbase Developer faucet", url: "https://portal.cdp.coinbase.com/products/faucet" },
    ],
    tokenFaucets: [{ name: "Circle USDC faucet", url: "https://faucet.circle.com" }],
  };
}

export const explorerTx = (hash) => (hash ? `https://sepolia.basescan.org/tx/${hash}` : null);
export const explorerAddress = (addr) => (addr ? `https://sepolia.basescan.org/address/${addr}` : null);
