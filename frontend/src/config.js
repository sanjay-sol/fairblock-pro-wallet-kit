// Model B config. The BACKEND supplies app/auth config + which chains it can execute on
// (/api/config → { appName, chains, defaultChainId, turnkeyBaseUrl, … }). The full per-chain
// details (addresses, faucets, explorers) live in networks.js; buildConfig() merges the
// backend app config with the SELECTED network into the single shape the app consumes.
import { getNetwork } from "./networks.js";
export { explorerTx, explorerAddress } from "./networks.js"; // chain-aware: (chainId, hash|addr)

export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:8792";

let _backend = null;
export async function loadBackendConfig() {
  if (_backend) return _backend;
  const r = await fetch(`${BACKEND_URL}/api/config`);
  if (!r.ok) throw new Error(`backend /api/config failed: ${r.status}`);
  _backend = await r.json();
  return _backend;
}

export function buildConfig(backendCfg, network) {
  return {
    backend: BACKEND_URL,
    appName: backendCfg.appName,
    turnkeyBaseUrl: backendCfg.turnkeyBaseUrl,
    sdkApiBaseUrl: backendCfg.sdkApiBaseUrl || null,
    chainId: network.chainId,
    rpcUrl: network.rpcUrl,
    diamondAddress: network.diamondAddress,
    tokenAddress: network.tokenAddress,
    tokenSymbol: network.tokenSymbol,
    tokenDecimals: network.tokenDecimals,
    networkName: network.name,
    shortName: network.shortName,
    explorerUrl: network.explorerUrl,
    nativeSymbol: network.nativeSymbol,
    gasFaucets: network.gasFaucets || [],
    tokenFaucets: network.tokenFaucets || [],
  };
}

// Which chains from the local registry the backend can actually execute on.
export function supportedNetworks(backendCfg, list) {
  const ids = new Set((backendCfg?.chains || []).map((c) => Number(c.chainId)));
  const filtered = list.filter((n) => ids.has(n.chainId));
  return filtered.length ? filtered : list; // fall back to all if backend didn't advertise
}
