// App config = app settings (from the thin backend) + the selected network (from the
// client-side registry in networks.js). AUTH is handled entirely by Turnkey's Embedded
// Wallet Kit (see main.jsx) — the backend holds NO keys and no chain config; the user
// picks the testnet in the browser.
export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:8792";

// Non-secret app config from the thin backend (just naming + optional SDK override).
export async function loadBackendConfig() {
  const r = await fetch(`${BACKEND_URL}/api/config`);
  if (!r.ok) throw new Error(`backend /api/config failed: ${r.status}`);
  return await r.json(); // { appName, sdkApiBaseUrl }
}

// Merge backend config with a chosen network into the single `cfg` object the
// rest of the app consumes (confidential.js, etc.).
export function buildConfig(backendCfg, network) {
  return {
    backend: BACKEND_URL,
    ...backendCfg,
    // chain config (from the client-side registry)
    chainId: network.chainId,
    rpcUrl: network.rpcUrl,
    diamondAddress: network.diamondAddress,
    tokenAddress: network.tokenAddress,
    tokenSymbol: network.tokenSymbol,
    tokenDecimals: network.tokenDecimals,
    networkName: network.name,
    explorerUrl: network.explorerUrl,
    network, // the full network record (faucets, native symbol, etc.)
  };
}
