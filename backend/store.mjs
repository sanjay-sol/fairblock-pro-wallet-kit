// ─────────────────────────────────────────────────────────────────────────────
// Pluggable, multi-tenant data store.
//   DB_BACKEND=firestore + serviceAccount.json  → Firebase Firestore (persistent)
//   otherwise                                    → in-memory (dev; non-persistent)
//
// Model (org-scoped — each treasury is its own org):
//   orgs/{orgId}                       org + owner + treasury
//   orgs/{orgId}/members/{id}          active team members (role, uid, subOrgId)
//   orgs/{orgId}/recipients/{id}       address book
//   orgs/{orgId}/transactions/{id}     audit trail (amounts client-encrypted)
//   invites/{inviteId}   (top-level)   pending invites (role + token hash) — direct
//                                      get-by-id on accept, no query/index needed.
// Access is server-side only via the Admin SDK, so Firestore rules stay locked and
// this backend enforces RBAC.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
const nowIso = () => new Date().toISOString();
const rid = (p) => `${p}_${randomBytes(7).toString("hex")}`;
const lc = (s) => String(s || "").trim().toLowerCase();

let mode = "memory";
let fs = null;

export function initStore() {
  const wantFs = String(process.env.DB_BACKEND || "").toLowerCase() === "firestore";
  const svcUrl = new URL("./serviceAccount.json", import.meta.url);
  if (wantFs && existsSync(svcUrl)) {
    const svc = JSON.parse(readFileSync(svcUrl));
    if (!getApps().length) initializeApp({ credential: cert(svc) });
    fs = getFirestore();
    impl = firestoreImpl;
    mode = "firestore";
  } else {
    impl = memoryImpl;
    mode = "memory";
  }
  return mode;
}
export const storeMode = () => mode;

// Merge an active-members list + pending-invites list into the unified "team" view
// the frontend renders (invite rows get a synthetic "invite:<id>" id + status "invited").
function mergeTeam(members, invites) {
  const active = members.map((m) => ({ ...m, kind: "member" }));
  const pend = invites
    .filter((i) => i.status === "pending")
    .map((i) => ({
      id: `invite:${i.id}`,
      name: i.name || i.email.split("@")[0],
      email: i.email,
      role: i.role,
      status: "invited",
      invitedAt: i.createdAt,
      kind: "invite",
    }));
  return [...active, ...pend];
}

const OWNER = { name: "Owner", email: "", address: null };

// ─────────────────────────── in-memory impl ───────────────────────────
const mem = { orgs: new Map(), invites: new Map() };
function memOrg(orgId) {
  if (!mem.orgs.has(orgId)) {
    mem.orgs.set(orgId, { id: orgId, org: {}, owner: null, treasury: null, members: [], recipients: [], transactions: [] });
  }
  return mem.orgs.get(orgId);
}

const memoryImpl = {
  async ensureOrg(orgId, seed = {}) {
    const o = memOrg(orgId);
    if (!o.createdAt) { o.createdAt = nowIso(); Object.assign(o, seed); }
    return o.id;
  },
  async getOrgBundle(orgId) {
    const o = memOrg(orgId);
    return { org: o.org || {}, owner: o.owner, treasury: o.treasury };
  },
  async updateOrg(orgId, patch) {
    const o = memOrg(orgId);
    o.org = { ...(o.org || {}), ...patch };
    return o.org;
  },
  async setOwner(orgId, { name, email, address } = {}) {
    const o = memOrg(orgId);
    const cur = o.owner || { ...OWNER };
    o.owner = {
      name: name || cur.name || "Owner",
      email: email !== undefined ? lc(email) : cur.email || "",
      address: address || cur.address || null,
    };
    if (o.owner.address) o.treasury = { subOrgId: orgId, address: o.owner.address };
    return o.owner;
  },
  async listTeam(orgId) {
    const o = memOrg(orgId);
    const invites = [...mem.invites.values()].filter((i) => i.orgId === orgId);
    return mergeTeam(o.members, invites);
  },
  async addActiveMember(orgId, m) {
    const o = memOrg(orgId);
    const email = lc(m.email);
    let existing = o.members.find((x) => lc(x.email) === email);
    if (existing) { Object.assign(existing, { ...m, email, status: "active", acceptedAt: nowIso() }); return existing; }
    const rec = { id: rid("mbr"), status: "active", invitedAt: nowIso(), acceptedAt: nowIso(), ...m, email };
    o.members.push(rec);
    return rec;
  },
  async setTeamRole(orgId, id, role) {
    if (id.startsWith("invite:")) { const i = mem.invites.get(id.slice(7)); if (i) i.role = role; return; }
    const o = memOrg(orgId); const m = o.members.find((x) => x.id === id); if (m) m.role = role;
  },
  async removeTeamEntry(orgId, id) {
    if (id.startsWith("invite:")) { mem.invites.delete(id.slice(7)); return; }
    const o = memOrg(orgId); o.members = o.members.filter((x) => x.id !== id);
  },
  async findMembershipsByEmail(email) {
    const e = lc(email); const out = [];
    for (const o of mem.orgs.values()) {
      if (o.owner && lc(o.owner.email) === e) out.push({ orgId: o.id, role: "owner", orgName: o.org?.name || "", status: "active" });
      for (const m of o.members) if (lc(m.email) === e) out.push({ orgId: o.id, role: m.role, orgName: o.org?.name || "", status: m.status });
    }
    return out;
  },
  async listRecipients(orgId) { return memOrg(orgId).recipients; },
  async addRecipient(orgId, { label, address, addedBy }) {
    const o = memOrg(orgId);
    const existing = o.recipients.find((r) => lc(r.address) === lc(address));
    if (existing) { if (label) existing.label = label; return existing; }
    const rec = { id: rid("rcpt"), label: label || `Recipient ${o.recipients.length + 1}`, address, addedBy: addedBy || null, addedAt: nowIso() };
    o.recipients.push(rec); return rec;
  },
  async removeRecipient(orgId, id) { const o = memOrg(orgId); const b = o.recipients.length; o.recipients = o.recipients.filter((r) => r.id !== id); return b - o.recipients.length; },
  async listTransactions(orgId) { return [...memOrg(orgId).transactions].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); },
  async addTransaction(orgId, tx) { const o = memOrg(orgId); const rec = { id: rid("tx"), createdAt: nowIso(), ...tx }; o.transactions.push(rec); return rec; },
  async patchTransaction(orgId, id, patch) { const o = memOrg(orgId); const t = o.transactions.find((x) => x.id === id); if (!t) return null; Object.assign(t, patch); return t; },
  async createInvite(orgId, { email, name, role, invitedBy, invitedByEmail, orgName }) {
    const rawToken = randomBytes(24).toString("hex");
    const inv = { id: rid("inv"), orgId, email: lc(email), name: name || "", role, tokenHash: sha256(rawToken), status: "pending",
      invitedBy: invitedBy || null, invitedByEmail: lc(invitedByEmail), orgName: orgName || "", createdAt: nowIso(), expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString() };
    mem.invites.set(inv.id, inv);
    return { invite: inv, rawToken };
  },
  async getInvite(inviteId) { return mem.invites.get(inviteId) || null; },
  async updateInvite(inviteId, patch) { const i = mem.invites.get(inviteId); if (i) Object.assign(i, patch); return i; },
  async reset(orgId) { mem.orgs.delete(orgId); for (const [k, v] of mem.invites) if (v.orgId === orgId) mem.invites.delete(k); },
};

// ─────────────────────────── Firestore impl ───────────────────────────
const orgRef = (orgId) => fs.doc(`orgs/${orgId}`);
const sub = (orgId, name) => fs.collection(`orgs/${orgId}/${name}`);
const inviteRef = (id) => fs.doc(`invites/${id}`);
const withId = (snap) => (snap.exists ? { id: snap.id, ...snap.data() } : null);
const listDocs = async (q) => (await q.get()).docs.map((d) => ({ id: d.id, ...d.data() }));

const firestoreImpl = {
  async ensureOrg(orgId, seed = {}) {
    const ref = orgRef(orgId);
    const snap = await ref.get();
    if (!snap.exists) await ref.set({ createdAt: nowIso(), org: {}, owner: null, treasury: null, ...seed });
    return orgId;
  },
  async getOrgBundle(orgId) {
    const d = withId(await orgRef(orgId).get());
    return { org: d?.org || {}, owner: d?.owner || null, treasury: d?.treasury || null };
  },
  async updateOrg(orgId, patch) {
    const ref = orgRef(orgId); await this.ensureOrg(orgId);
    const cur = (await ref.get()).data()?.org || {};
    const org = { ...cur, ...patch };
    await ref.set({ org, updatedAt: nowIso() }, { merge: true });
    return org;
  },
  async setOwner(orgId, { name, email, address } = {}) {
    const ref = orgRef(orgId); await this.ensureOrg(orgId);
    const data = (await ref.get()).data() || {};
    const cur = data.owner || { ...OWNER };
    const owner = {
      name: name || cur.name || "Owner",
      email: email !== undefined ? lc(email) : cur.email || "",
      address: address || cur.address || null,
    };
    const patch = { owner, ownerSubOrgId: orgId, updatedAt: nowIso() };
    if (owner.email) patch.ownerEmail = owner.email;
    if (owner.address) patch.treasury = { subOrgId: orgId, address: owner.address };
    await ref.set(patch, { merge: true });
    return owner;
  },
  async listTeam(orgId) {
    const [members, invites] = await Promise.all([
      listDocs(sub(orgId, "members")),
      listDocs(fs.collection("invites").where("orgId", "==", orgId)),
    ]);
    return mergeTeam(members, invites);
  },
  async addActiveMember(orgId, m) {
    const email = lc(m.email);
    const dup = await listDocs(sub(orgId, "members").where("email", "==", email));
    if (dup[0]) { await sub(orgId, "members").doc(dup[0].id).set({ ...m, email, status: "active", acceptedAt: nowIso() }, { merge: true }); return { ...dup[0], ...m, email, status: "active" }; }
    const rec = { status: "active", invitedAt: nowIso(), acceptedAt: nowIso(), ...m, email };
    const ref = await sub(orgId, "members").add(rec);
    return { id: ref.id, ...rec };
  },
  async setTeamRole(orgId, id, role) {
    if (id.startsWith("invite:")) { await inviteRef(id.slice(7)).set({ role }, { merge: true }); return; }
    await sub(orgId, "members").doc(id).set({ role }, { merge: true });
  },
  async removeTeamEntry(orgId, id) {
    if (id.startsWith("invite:")) { await inviteRef(id.slice(7)).set({ status: "revoked" }, { merge: true }); return; }
    await sub(orgId, "members").doc(id).delete();
  },
  async findMembershipsByEmail(email) {
    const e = lc(email);
    // NOTE: the collectionGroup("members") query needs a one-time collection-group index
    // (Firestore prints a create-link on first run). Only used by Stage-2 org-switching.
    const [ownerSnap, memberSnap] = await Promise.all([
      fs.collection("orgs").where("ownerEmail", "==", e).get(),
      fs.collectionGroup("members").where("email", "==", e).get(),
    ]);
    const out = ownerSnap.docs.map((d) => ({ orgId: d.id, role: "owner", orgName: d.data().org?.name || "", status: "active" }));
    for (const d of memberSnap.docs) {
      out.push({ orgId: d.ref.parent.parent?.id || null, role: d.data().role, orgName: "", status: d.data().status, memberId: d.id });
    }
    return out;
  },
  async listRecipients(orgId) { return listDocs(sub(orgId, "recipients")); },
  async addRecipient(orgId, { label, address, addedBy }) {
    await this.ensureOrg(orgId);
    const dup = await listDocs(sub(orgId, "recipients").where("address", "==", address));
    if (dup[0]) { if (label) await sub(orgId, "recipients").doc(dup[0].id).set({ label }, { merge: true }); return { ...dup[0], label: label || dup[0].label }; }
    const rec = { label: label || "Recipient", address, addedBy: addedBy || null, addedAt: nowIso() };
    const ref = await sub(orgId, "recipients").add(rec);
    return { id: ref.id, ...rec };
  },
  async removeRecipient(orgId, id) { await sub(orgId, "recipients").doc(id).delete(); return 1; },
  async listTransactions(orgId) {
    const txs = await listDocs(sub(orgId, "transactions"));
    return txs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  },
  async addTransaction(orgId, tx) { await this.ensureOrg(orgId); const rec = { createdAt: nowIso(), ...tx }; const ref = await sub(orgId, "transactions").add(rec); return { id: ref.id, ...rec }; },
  async patchTransaction(orgId, id, patch) { const ref = sub(orgId, "transactions").doc(id); const s = await ref.get(); if (!s.exists) return null; await ref.set(patch, { merge: true }); return { id, ...s.data(), ...patch }; },
  async createInvite(orgId, { email, name, role, invitedBy, invitedByEmail, orgName }) {
    await this.ensureOrg(orgId);
    const rawToken = randomBytes(24).toString("hex");
    const id = rid("inv");
    const invite = { orgId, email: lc(email), name: name || "", role, tokenHash: sha256(rawToken), status: "pending",
      invitedBy: invitedBy || null, invitedByEmail: lc(invitedByEmail), orgName: orgName || "", createdAt: nowIso(), expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString() };
    await inviteRef(id).set(invite);
    return { invite: { id, ...invite }, rawToken };
  },
  async getInvite(inviteId) { return withId(await inviteRef(inviteId).get()); },
  async updateInvite(inviteId, patch) { await inviteRef(inviteId).set(patch, { merge: true }); return this.getInvite(inviteId); },
  async reset(orgId) {
    const del = async (c) => { const docs = (await c.get()).docs; await Promise.all(docs.map((d) => d.ref.delete())); };
    await Promise.all([del(sub(orgId, "members")), del(sub(orgId, "recipients")), del(sub(orgId, "transactions")), del(fs.collection("invites").where("orgId", "==", orgId))]);
    await orgRef(orgId).delete().catch(() => {});
  },
};

// ─── dispatch to the active impl ───
let impl = memoryImpl;
export const store = new Proxy({}, { get: (_t, k) => (...args) => impl[k](...args) });

// ─── shared: accept an invite (verify token + email, then activate the member) ───
export async function acceptInvite({ inviteId, token, email, name, subOrgId, uid }) {
  const inv = await store.getInvite(inviteId);
  if (!inv) throw new Error("Invite not found");
  if (inv.status !== "pending") throw new Error(`Invite already ${inv.status}`);
  if (Date.now() > new Date(inv.expiresAt).getTime()) { await store.updateInvite(inviteId, { status: "expired" }); throw new Error("Invite expired"); }
  if (inv.tokenHash !== sha256(token)) throw new Error("Invalid invite token");
  if (lc(email) !== lc(inv.email)) throw new Error(`This invite is for ${inv.email} — sign in with that email`);
  const member = await store.addActiveMember(inv.orgId, {
    email: lc(email), name: name || inv.name || "", role: inv.role,
    uid: uid || null, subOrgId: subOrgId || null, invitedBy: inv.invitedBy, invitedByEmail: inv.invitedByEmail, invitedAt: inv.createdAt,
  });
  await store.updateInvite(inviteId, { status: "accepted", acceptedAt: nowIso() });
  return { orgId: inv.orgId, role: inv.role, orgName: inv.orgName, member };
}
