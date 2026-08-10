// Thin client for the multi-tenant backend. Every request is scoped to the current org
// via the `x-org-id` header (the signed-in treasury's sub-org / address) plus the caller's
// email for RBAC — set by OrgContext through setApiContext().
import { BACKEND_URL } from "../config.js";

let ctx = { orgId: null, callerEmail: null };
export function setApiContext({ orgId = null, callerEmail = null } = {}) {
  ctx = { orgId, callerEmail };
}

async function j(path, opts = {}) {
  const headers = { "content-type": "application/json", ...(opts.headers || {}) };
  if (ctx.orgId) headers["x-org-id"] = ctx.orgId;
  if (ctx.callerEmail) headers["x-caller-email"] = ctx.callerEmail;
  const r = await fetch(`${BACKEND_URL}${path}`, { ...opts, headers });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${path} → ${r.status}`);
  return body;
}

export const api = {
  // recipients address book
  recipients: () => j("/api/recipients"),
  addRecipient: (label, address) =>
    j("/api/recipients", { method: "POST", body: JSON.stringify({ label, address }) }),
  removeRecipient: (id) => j(`/api/recipients/${id}`, { method: "DELETE" }),

  // org / owner
  getOrg: () => j("/api/org"),
  updateOrg: (patch) => j("/api/org", { method: "PUT", body: JSON.stringify(patch) }),
  setOwner: (owner) => j("/api/owner", { method: "POST", body: JSON.stringify(owner) }),

  // team + invites
  getTeam: () => j("/api/team"),
  updateMember: (id, patch) => j(`/api/team/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(patch) }),
  removeMember: (id) => j(`/api/team/${encodeURIComponent(id)}`, { method: "DELETE" }),
  invite: (m) => j("/api/invites", { method: "POST", body: JSON.stringify(m) }),
  getInvite: (inviteId, token) => j(`/api/invites/${inviteId}?token=${encodeURIComponent(token)}`),
  acceptInvite: (payload) => j("/api/invites/accept", { method: "POST", body: JSON.stringify(payload) }),
  memberships: (email) => j(`/api/memberships?email=${encodeURIComponent(email)}`),

  // transactions
  getTransactions: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null && v !== ""),
    ).toString();
    return j(`/api/transactions${qs ? `?${qs}` : ""}`);
  },
  addTransaction: (tx) => j("/api/transactions", { method: "POST", body: JSON.stringify(tx) }),
  patchTransaction: (id, patch) =>
    j(`/api/transactions/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  analytics: () => j("/api/analytics"),
};
