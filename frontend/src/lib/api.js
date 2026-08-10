// Model B API client. Requests are scoped by x-org-id (treasury subOrgId) + x-caller-email
// (the signed-in admin), set from the session via setApiContext().
import { BACKEND_URL } from "../config.js";

let ctx = { subOrgId: null, email: null };
export function setApiContext(c = {}) { ctx = { ...ctx, ...c }; }

async function j(path, opts = {}) {
  const headers = { "content-type": "application/json", ...(opts.headers || {}) };
  if (ctx.subOrgId) headers["x-org-id"] = ctx.subOrgId;
  if (ctx.email) headers["x-caller-email"] = ctx.email;
  const r = await fetch(`${BACKEND_URL}${path}`, { ...opts, headers });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${path} → ${r.status}`);
  return body;
}

export const api = {
  config: () => j("/api/config"),
  // treasury lifecycle + auth
  createTreasury: (p) => j("/api/treasury", { method: "POST", body: JSON.stringify(p) }),
  authInit: (email) => j("/api/auth/init", { method: "POST", body: JSON.stringify({ email }) }),
  authVerify: (p) => j("/api/auth/verify", { method: "POST", body: JSON.stringify(p) }),
  getTreasury: () => j("/api/treasury"),
  updateTreasury: (patch) => j("/api/treasury", { method: "PUT", body: JSON.stringify(patch) }),
  // members
  addMember: (m) => j("/api/members", { method: "POST", body: JSON.stringify(m) }),
  removeMember: (email) => j(`/api/members/${encodeURIComponent(email)}`, { method: "DELETE" }),
  setThreshold: (threshold) => j("/api/threshold", { method: "PUT", body: JSON.stringify({ threshold }) }),
  // payouts (consensus)
  listPayouts: () => j("/api/payouts"),
  nonce: (count = 1) => j(`/api/nonce?count=${count}`),
  proposePayout: (p) => j("/api/payouts", { method: "POST", body: JSON.stringify(p) }),
  rejectPayout: (id) => j(`/api/payouts/${id}/rejected`, { method: "POST" }),
  // recipients
  recipients: () => j("/api/recipients"),
  addRecipient: (label, address) => j("/api/recipients", { method: "POST", body: JSON.stringify({ label, address }) }),
  removeRecipient: (id) => j(`/api/recipients/${id}`, { method: "DELETE" }),
};
