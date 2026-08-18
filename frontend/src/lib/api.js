// Model B API client. Every request carries the signed session token as `Authorization:
// Bearer <token>` — the backend verifies it (HMAC) and derives the caller's identity from it,
// so identity can't be spoofed via a header. The token is set from the session by setApiContext().
import { BACKEND_URL } from "../config.js";

let ctx = { subOrgId: null, email: null, token: null };
export function setApiContext(c = {}) { ctx = { ...ctx, ...c }; }

// The OrgProvider registers a handler so a 401 (token missing/expired/invalid) triggers a
// clean sign-out instead of surfacing as a raw error on every call.
let onAuthError = null;
export function setAuthErrorHandler(fn) { onAuthError = fn; }

async function j(path, opts = {}) {
  const headers = { "content-type": "application/json", ...(opts.headers || {}) };
  if (ctx.token) headers["authorization"] = `Bearer ${ctx.token}`;
  const r = await fetch(`${BACKEND_URL}${path}`, { ...opts, headers });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401) { try { onAuthError?.(body); } catch { /* ignore */ } }
    throw new Error(body.error || `${path} → ${r.status}`);
  }
  return body;
}

export const api = {
  config: () => j("/api/config"),
  // treasury lifecycle + auth
  createTreasury: (p) => j("/api/treasury", { method: "POST", body: JSON.stringify(p) }),
  authInit: (email) => j("/api/auth/init", { method: "POST", body: JSON.stringify({ email }) }),
  authVerify: (p) => j("/api/auth/verify", { method: "POST", body: JSON.stringify(p) }),
  authOauth: (p) => j("/api/auth/oauth", { method: "POST", body: JSON.stringify(p) }),
  authOauthCreate: (p) => j("/api/auth/oauth/create", { method: "POST", body: JSON.stringify(p) }),
  getTreasury: () => j("/api/treasury"),
  updateTreasury: (patch) => j("/api/treasury", { method: "PUT", body: JSON.stringify(patch) }),
  // members
  addMember: (m) => j("/api/members", { method: "POST", body: JSON.stringify(m) }),
  removeMember: (email) => j(`/api/members/${encodeURIComponent(email)}`, { method: "DELETE" }),
  setThreshold: (threshold) => j("/api/threshold", { method: "PUT", body: JSON.stringify({ threshold }) }),
  // payouts (consensus)
  listPayouts: () => j("/api/payouts"),
  nonce: (count = 1, chainId) => j(`/api/nonce?count=${count}${chainId ? `&chainId=${chainId}` : ""}`),
  ensureAllowance: (chainId) => j("/api/allowance", { method: "POST", body: JSON.stringify({ chainId }) }),
  claim: (chainId) => j("/api/claim", { method: "POST", body: JSON.stringify({ chainId }) }),
  proposePayout: (p) => j("/api/payouts", { method: "POST", body: JSON.stringify(p) }),
  rejectPayout: (id) => j(`/api/payouts/${id}/rejected`, { method: "POST" }),
  // recipients
  recipients: () => j("/api/recipients"),
  addRecipient: (label, address) => j("/api/recipients", { method: "POST", body: JSON.stringify({ label, address }) }),
  removeRecipient: (id) => j(`/api/recipients/${id}`, { method: "DELETE" }),
};
