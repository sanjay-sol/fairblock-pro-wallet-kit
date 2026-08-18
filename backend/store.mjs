// ─────────────────────────────────────────────────────────────────────────────
// Model B store — Firestore (or in-memory) persistence for co-managed treasuries.
//
//   treasuries/{subOrgId}                 name, ownerEmail, address, chainId, threshold,
//                                         spendPolicyId, rootKey{publicKey,privateKey}, timestamps
//   treasuries/{subOrgId}/members/{email} email, name, role(owner|admin), userId, status, timestamps
//   treasuries/{subOrgId}/payouts/{id}    activityId, kind, recipient, amountEnc, tokenSymbol,
//                                         status(pending|completed|failed|rejected), unsignedTx, nonce,
//                                         createdBy, createdAt, txHash, note
//   treasuries/{subOrgId}/recipients/{id} label, address, addedBy, addedAt
//   emailIndex/{email}                    subOrgId, role   ← one email = one treasury (invariant + routing)
//
// The per-treasury `rootKey` is sensitive (controls the sub-org). It lives server-side only;
// for a testnet v1 it's stored in Firestore (prod: envelope-encrypt with a KMS).
// ─────────────────────────────────────────────────────────────────────────────
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const nowIso = () => new Date().toISOString();
const rid = (p) => `${p}_${randomBytes(7).toString("hex")}`;
const lc = (s) => String(s || "").trim().toLowerCase();

let mode = "memory";
let fs = null;
let impl = null;

export function initStore() {
  const wantFs = String(process.env.DB_BACKEND || "").toLowerCase() === "firestore";
  const svcUrl = new URL("./serviceAccount.json", import.meta.url);
  if (wantFs) {
    try {
      if (!getApps().length) {
        // Local dev: use the service-account JSON if present. On Cloud Run (or any GCP
        // runtime) there is NO file — initializeApp() with no args uses Application
        // Default Credentials (the runtime service account), so no secret JSON to ship.
        if (existsSync(svcUrl)) initializeApp({ credential: cert(JSON.parse(readFileSync(svcUrl))) });
        else initializeApp();
      }
      fs = getFirestore();
      impl = firestoreImpl;
      mode = "firestore";
      return mode;
    } catch (e) {
      console.error("[store] firestore init failed — falling back to in-memory:", e?.message || e);
    }
  }
  impl = memoryImpl;
  mode = "memory";
  return mode;
}
export const storeMode = () => mode;

// ─────────────────────────── in-memory impl (tests) ───────────────────────────
const mem = { treasuries: new Map(), emailIndex: new Map() };
const memT = (id) => {
  if (!mem.treasuries.has(id)) mem.treasuries.set(id, { id, doc: {}, members: new Map(), payouts: new Map(), recipients: new Map() });
  return mem.treasuries.get(id);
};
const memoryImpl = {
  async createTreasury(t) { const o = memT(t.subOrgId); o.doc = { ...t, createdAt: nowIso() }; return o.doc; },
  async getTreasury(id) { return mem.treasuries.has(id) ? { ...memT(id).doc } : null; },
  async updateTreasury(id, patch) { const o = memT(id); o.doc = { ...o.doc, ...patch, updatedAt: nowIso() }; return o.doc; },
  async emailIndexGet(email) { return mem.emailIndex.get(lc(email)) || null; },
  async emailIndexSet(email, v) { mem.emailIndex.set(lc(email), v); },
  async emailIndexDel(email) { mem.emailIndex.delete(lc(email)); },
  async addMember(id, m) { const o = memT(id); const rec = { ...m, email: lc(m.email), createdAt: nowIso() }; o.members.set(lc(m.email), rec); return rec; },
  async getMember(id, email) { return memT(id).members.get(lc(email)) || null; },
  async listMembers(id) { return [...memT(id).members.values()]; },
  async updateMember(id, email, patch) { const o = memT(id); const m = o.members.get(lc(email)); if (m) o.members.set(lc(email), { ...m, ...patch }); return o.members.get(lc(email)); },
  async removeMember(id, email) { memT(id).members.delete(lc(email)); },
  async addPayout(id, p) { const o = memT(id); const rec = { id: rid("po"), createdAt: nowIso(), ...p }; o.payouts.set(rec.id, rec); return rec; },
  async getPayout(id, pid) { return memT(id).payouts.get(pid) || null; },
  async listPayouts(id) { return [...memT(id).payouts.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); },
  async updatePayout(id, pid, patch) { const o = memT(id); const p = o.payouts.get(pid); if (p) o.payouts.set(pid, { ...p, ...patch }); return o.payouts.get(pid); },
  async addRecipient(id, r) { const o = memT(id); const rec = { id: rid("rc"), addedAt: nowIso(), ...r }; o.recipients.set(rec.id, rec); return rec; },
  async listRecipients(id) { return [...memT(id).recipients.values()]; },
  async removeRecipient(id, rid2) { memT(id).recipients.delete(rid2); },
};

// ─────────────────────────── Firestore impl ───────────────────────────
const tRef = (id) => fs.doc(`treasuries/${id}`);
const sub = (id, c) => fs.collection(`treasuries/${id}/${c}`);
const eRef = (email) => fs.doc(`emailIndex/${lc(email)}`);
const withId = (s) => (s.exists ? { id: s.id, ...s.data() } : null);
const listDocs = async (q) => (await q.get()).docs.map((d) => ({ id: d.id, ...d.data() }));

const firestoreImpl = {
  async createTreasury(t) { await tRef(t.subOrgId).set({ ...t, createdAt: nowIso() }); return t; },
  async getTreasury(id) { return withId(await tRef(id).get()); },
  async updateTreasury(id, patch) { await tRef(id).set({ ...patch, updatedAt: nowIso() }, { merge: true }); return this.getTreasury(id); },
  async emailIndexGet(email) { return withId(await eRef(email).get()); },
  async emailIndexSet(email, v) { await eRef(email).set(v); },
  async emailIndexDel(email) { await eRef(email).delete().catch(() => {}); },
  async addMember(id, m) { const email = lc(m.email); const rec = { ...m, email, createdAt: nowIso() }; await sub(id, "members").doc(email).set(rec, { merge: true }); return rec; },
  async getMember(id, email) { return withId(await sub(id, "members").doc(lc(email)).get()); },
  async listMembers(id) { return listDocs(sub(id, "members")); },
  async updateMember(id, email, patch) { await sub(id, "members").doc(lc(email)).set(patch, { merge: true }); return this.getMember(id, email); },
  async removeMember(id, email) { await sub(id, "members").doc(lc(email)).delete().catch(() => {}); },
  async addPayout(id, p) { const ref = await sub(id, "payouts").add({ createdAt: nowIso(), ...p }); return { id: ref.id, createdAt: nowIso(), ...p }; },
  async getPayout(id, pid) { return withId(await sub(id, "payouts").doc(pid).get()); },
  async listPayouts(id) { return (await listDocs(sub(id, "payouts"))).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); },
  async updatePayout(id, pid, patch) { await sub(id, "payouts").doc(pid).set(patch, { merge: true }); return this.getPayout(id, pid); },
  async addRecipient(id, r) { const ref = await sub(id, "recipients").add({ addedAt: nowIso(), ...r }); return { id: ref.id, ...r }; },
  async listRecipients(id) { return listDocs(sub(id, "recipients")); },
  async removeRecipient(id, rid2) { await sub(id, "recipients").doc(rid2).delete().catch(() => {}); },
};

export const store = new Proxy({}, { get: (_t, k) => (...a) => impl[k](...a) });
