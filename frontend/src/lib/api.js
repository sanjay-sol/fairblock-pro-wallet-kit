// Thin client for the backend JSON-store + Turnkey endpoints.
import { BACKEND_URL } from "../config.js";

async function j(path, opts) {
  const r = await fetch(`${BACKEND_URL}${path}`, {
    headers: { "content-type": "application/json" },
    ...opts,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${path} → ${r.status}`);
  return body;
}

export const api = {
  // treasury onboarding
  register: (payload) => j("/api/register", { method: "POST", body: JSON.stringify(payload) }),

  // recipients address book
  recipients: () => j("/api/recipients"),
  addRecipient: (label, address) =>
    j("/api/recipients", { method: "POST", body: JSON.stringify({ label, address }) }),
  removeRecipient: (id) => j(`/api/recipients/${id}`, { method: "DELETE" }),

  // org / owner
  getOrg: () => j("/api/org"),
  updateOrg: (patch) => j("/api/org", { method: "PUT", body: JSON.stringify(patch) }),
  setOwner: (owner) => j("/api/owner", { method: "POST", body: JSON.stringify(owner) }),

  // team
  getTeam: () => j("/api/team"),
  addMember: (m) => j("/api/team", { method: "POST", body: JSON.stringify(m) }),
  updateMember: (id, patch) => j(`/api/team/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  removeMember: (id) => j(`/api/team/${id}`, { method: "DELETE" }),

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
