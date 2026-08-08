// Wrapper around the Fairblock SDK's ConfidentialTransferClient.
//
// The treasury's confidential balance is an encrypted on-chain account. Amounts are
// hidden on-chain; the treasury (sender) is visible and pays its own gas. WASM proving
// + key derivation happen IN THE BROWSER.
//
// MULTI-TOKEN: the confidential ACCOUNT (encryption key) is per (chain, contract, user)
// — NOT per token — so ONE activation covers every token. Each op takes an explicit
// `token` ({ address, symbol, decimals }); the SDK is token-agnostic. The diamond only
// accepts tokens its admin has whitelisted (isSupportedToken) — resolveToken() checks
// that on-chain before the app offers a token.
//
// Delivery methods exposed to the dashboard:
//   • confidentialSettlement (transfer)  → recipient's CONFIDENTIAL balance; amount hidden.
//   • direct (withdraw + ERC20 transfer) → recipient's PUBLIC wallet; amount public.
import { ConfidentialTransferClient } from "@fairblock/stabletrust";
import { ethers } from "ethers";

// Minimal ERC-20 ABI for reads + the Direct-to-wallet transfer + deposit approval.
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
];
// The confidential diamond's token-allowlist getter.
const DIAMOND_TOKEN_ABI = ["function isSupportedToken(address) view returns (bool)"];

let _client = null;
let _cfg = null;

export function initConfidential(cfg) {
  _cfg = cfg;
  // In production we do NOT override the SDK's backend — it posts request rows to
  // its own hosted default. Only pass apiBaseUrl if the operator explicitly set one.
  const opts = cfg.sdkApiBaseUrl ? { apiBaseUrl: cfg.sdkApiBaseUrl } : undefined;
  _client = new ConfidentialTransferClient(cfg.rpcUrl, cfg.diamondAddress, cfg.chainId, opts);
  return _client;
}

function client() {
  if (!_client) throw new Error("confidential client not initialized");
  return _client;
}

function readProvider() {
  return new ethers.JsonRpcProvider(_cfg.rpcUrl, _cfg.chainId);
}

// Normalise a token argument to { address, symbol, decimals }. Accepts a token
// object (from the registry / a resolved custom token) — decimals MUST be present
// (registry tokens carry it; resolveToken() reads it from chain).
function normToken(token) {
  if (!token || !token.address) throw new Error("A token is required");
  if (token.decimals == null) throw new Error(`Missing decimals for token ${token.address}`);
  return { address: token.address, symbol: token.symbol || "TOKEN", decimals: Number(token.decimals) };
}

// Resolve a token address on the current chain: is it whitelisted on the diamond,
// and what are its symbol/decimals? Used by "add token by address" so the app never
// offers a token the confidential contract would reject with "token not supported".
export async function resolveToken(address) {
  if (!ethers.isAddress(address)) throw new Error("Enter a valid 0x token address");
  const addr = ethers.getAddress(address);
  const provider = readProvider();
  const diamond = new ethers.Contract(_cfg.diamondAddress, DIAMOND_TOKEN_ABI, provider);
  const token = new ethers.Contract(addr, ERC20_ABI, provider);
  const [supported, decimals, symbol] = await Promise.all([
    diamond.isSupportedToken(addr).catch(() => false),
    token.decimals().then(Number).catch(() => null),
    token.symbol().catch(() => null),
  ]);
  if (decimals == null) throw new Error("That address isn't an ERC-20 token (no decimals())");
  return { address: addr, symbol: symbol || `${addr.slice(0, 6)}…`, decimals, supported: Boolean(supported) };
}

// Derive the encryption key (passkey / session) + create the confidential account if
// needed. ONE account holds every token's balance. Returns { publicKey, privateKey }.
export async function activateAccount(signer) {
  return await client().ensureAccount(signer);
}

// Does an address already have an activated (finalized) confidential account?
export async function isActivated(address) {
  try {
    const info = await client().getAccountInfo(address);
    return !!(info?.exists && info?.finalized);
  } catch {
    return false;
  }
}

// Never let a client-side op hang forever. On public testnet infra a signing or
// broadcast step can stall, and ethers' tx.wait() has NO timeout — so the UI spins
// indefinitely. We race every op against a timeout and, on expiry, throw a clear
// message. The underlying tx MAY still land, so we tell the user to refresh + check
// their balance before retrying (never a silent double-send).
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} is taking too long (>${Math.round(ms / 1000)}s). It may still complete — refresh and check your balance before retrying.`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
const OP_TIMEOUT = 150_000; // deposits/transfers incl. the ~30–90s finalization wait
const APPROVE_TIMEOUT = 60_000;

// Make sure the confidential contract is approved to pull `amount` of the token,
// and — crucially — that the new allowance is READABLE before we deposit. Public
// testnet RPCs are load-balanced, so a fresh approve isn't always visible on the
// next request; the SDK's deposit then estimateGas-reverts with
// "transfer amount exceeds allowance". We approve here and poll until it sticks.
async function ensureAllowance(signer, tokenAddress, amount) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const owner = await signer.getAddress();
  const spender = _cfg.diamondAddress;
  if ((await token.allowance(owner, spender)) >= amount) return;
  const tx = await withTimeout(token.approve(spender, ethers.MaxUint256), APPROVE_TIMEOUT, "Approval");
  await withTimeout(tx.wait(), APPROVE_TIMEOUT, "Approval confirmation");
  for (let i = 0; i < 12; i++) {
    try {
      if ((await token.allowance(owner, spender)) >= amount) return;
    } catch {
      /* transient RPC read — keep polling */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  // fall through — the deposit itself is retried below
}

// Retry ONLY a pre-send estimateGas failure caused by a stale allowance on a
// lagging RPC replica. Safe because estimateGas fails BEFORE any tx is broadcast —
// so there's no risk of double-depositing. We deliberately do NOT retry
// post-send/finalization errors (that could re-send a deposit).
async function withDepositRetry(fn, attempts = 3) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String(e?.message || e);
      const preSendAllowance = /exceeds allowance/i.test(msg) && /estimateGas/i.test(msg);
      if (i < attempts - 1 && preSendAllowance) {
        await new Promise((r) => setTimeout(r, 2500));
        continue;
      }
      throw e;
    }
  }
}

export async function deposit(signer, token, amountStr) {
  const t = normToken(token);
  const amount = ethers.parseUnits(String(amountStr), t.decimals);
  await withTimeout(client().ensureAccount(signer), OP_TIMEOUT, "Account check");
  await ensureAllowance(signer, t.address, amount); // approve + wait until visible (own timeout)
  return await withTimeout(
    withDepositRetry(() => client().confidentialDeposit(signer, t.address, amount)),
    OP_TIMEOUT,
    "Deposit",
  );
}

// Confidential Settlement: treasury confidential → recipient confidential. Amount hidden.
export async function confidentialTransfer(signer, recipient, token, amountStr) {
  const t = normToken(token);
  const amount = ethers.parseUnits(String(amountStr), t.decimals);
  return await withTimeout(
    client().confidentialTransfer(signer, recipient, t.address, amount),
    OP_TIMEOUT,
    "Transfer",
  );
}

// Withdraw treasury confidential → treasury PUBLIC balance.
export async function withdraw(signer, token, amountStr) {
  const t = normToken(token);
  const amount = ethers.parseUnits(String(amountStr), t.decimals);
  return await withTimeout(client().withdraw(signer, t.address, amount), OP_TIMEOUT, "Withdraw");
}

// Direct to wallet: withdraw treasury confidential → treasury public, then ERC20-transfer to
// the recipient's public address. NOTE: unlike Confidential Settlement, the amount becomes
// PUBLIC and the treasury is the visible sender. Two on-chain txs; returns the final receipt.
export async function payDirect(signer, recipient, token, amountStr) {
  const t = normToken(token);
  const amount = ethers.parseUnits(String(amountStr), t.decimals);
  await withTimeout(client().withdraw(signer, t.address, amount), OP_TIMEOUT, "Withdraw"); // confidential -> own public
  const erc20 = new ethers.Contract(t.address, ERC20_ABI, signer);
  const tx = await withTimeout(erc20.transfer(recipient, amount), APPROVE_TIMEOUT, "Transfer");
  return await withTimeout(tx.wait(), APPROVE_TIMEOUT, "Transfer confirmation");
}

export async function publicBalance(address, token) {
  const t = normToken(token);
  const raw = await client().getPublicBalance(address, t.address);
  return ethers.formatUnits(raw, t.decimals);
}

// Decrypt the confidential balance client-side with the account's private key.
export async function confidentialBalance(address, privateKey, token) {
  const t = normToken(token);
  const bal = await client().getConfidentialBalance(address, privateKey, t.address);
  const fmt = (leg) => (leg && leg.amount != null ? ethers.formatUnits(leg.amount, t.decimals) : "0");
  return { available: fmt(bal.available), pending: fmt(bal.pending), raw: bal };
}
