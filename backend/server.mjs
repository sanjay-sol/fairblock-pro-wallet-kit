// fairblock-pro-wallet-kit/backend/server.mjs
//
// Multi-tenant application backend for Stabletrust Pro (Wallet Kit).
//   • Persistence: Firestore (DB_BACKEND=firestore) or in-memory fallback — see store.mjs.
//   • Real team invites: creates an invite (role + token) and emails an accept link — mailer.mjs.
//   • RBAC: every request is scoped to an org via the `x-org-id` header; mutating routes check
//     the caller's role (owner > admin > member > viewer).
//
// Auth model note (POC): the caller asserts its identity via headers (x-org-id = the caller's
// own Turnkey sub-org, x-caller-email). That's fine for a demo; production should verify the
// Turnkey session server-side before trusting these. NO signing keys live here.

import "dotenv/config";
import express from "express";
import cors from "cors";
import { store, initStore, acceptInvite, sha256 } from "./store.mjs";
import { initMailer, sendInvite } from "./mailer.mjs";

const {
  PORT = "8792",
  APP_NAME = "Stabletrust Pro",
  APP_URL = "http://localhost:5176",
  SDK_API_BASE_URL = "",
  FRONTEND_ORIGIN = "http://localhost:5176",
} = process.env;

const ALLOWED_ORIGINS = FRONTEND_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);

const dbMode = initStore();
const mail = initMailer();

const app = express();
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`origin ${origin} not allowed`));
    },
    allowedHeaders: ["content-type", "x-org-id", "x-caller-email"],
  }),
);
app.use(express.json({ limit: "4mb" }));

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(`[${req.method} ${req.path}] failed:`, e?.message || e);
    res.status(500).json({ error: e?.message || String(e) });
  });

// ── org scoping + RBAC ──────────────────────────────────────────────────────
const orgOf = (req) => req.headers["x-org-id"] || null;
const callerOf = (req) => String(req.headers["x-caller-email"] || "").toLowerCase();
const RANK = { owner: 4, admin: 3, member: 2, viewer: 1 };

// The org holder (whoever presents x-org-id = their own sub-org, or the stored owner email)
// is the owner; a caller whose email matches an active member gets that member's role.
async function roleFor(orgId, callerEmail) {
  if (!orgId) return null;
  const { owner } = await store.getOrgBundle(orgId);
  const oe = String(owner?.email || "").toLowerCase();
  if (!callerEmail || !oe || callerEmail === oe) return "owner";
  const team = await store.listTeam(orgId);
  const m = team.find((t) => String(t.email || "").toLowerCase() === callerEmail && t.status === "active");
  return m ? m.role : null;
}
function requireOrg(req, res) {
  const o = orgOf(req);
  if (!o) { res.status(400).json({ error: "missing x-org-id header" }); return null; }
  return o;
}
async function requireRole(req, res, min) {
  const orgId = requireOrg(req, res);
  if (!orgId) return null;
  const role = await roleFor(orgId, callerOf(req));
  if (!role || RANK[role] < RANK[min]) { res.status(403).json({ error: `requires ${min} role` }); return null; }
  return { orgId, role };
}
function pickOrg(b = {}) {
  const out = {};
  for (const k of ["name", "image", "defaultDelivery", "defaultNetwork"]) if (b[k] !== undefined) out[k] = b[k];
  return out;
}

// ── config / health ─────────────────────────────────────────────────────────
app.get("/api/config", (_req, res) =>
  res.json({ appName: APP_NAME, sdkApiBaseUrl: SDK_API_BASE_URL || null, dbMode, mailMode: mail.mode }));
app.get("/healthz", (_req, res) => res.json({ ok: true, dbMode, mailMode: mail.mode }));

// ── org / owner ─────────────────────────────────────────────────────────────
app.get("/api/org", wrap(async (req, res) => {
  const o = requireOrg(req, res); if (!o) return;
  res.json(await store.getOrgBundle(o));
}));
app.put("/api/org", wrap(async (req, res) => {
  const c = await requireRole(req, res, "admin"); if (!c) return;
  res.json(await store.updateOrg(c.orgId, pickOrg(req.body)));
}));
// Establishing the owner also creates the org (the org holder = owner) — no role gate.
app.post("/api/owner", wrap(async (req, res) => {
  const o = requireOrg(req, res); if (!o) return;
  await store.ensureOrg(o, { ownerSubOrgId: o });
  res.json(await store.setOwner(o, req.body || {}));
}));

// ── recipients ──────────────────────────────────────────────────────────────
app.get("/api/recipients", wrap(async (req, res) => {
  const o = requireOrg(req, res); if (!o) return;
  res.json(await store.listRecipients(o));
}));
app.post("/api/recipients", wrap(async (req, res) => {
  const c = await requireRole(req, res, "member"); if (!c) return;
  const { label, address } = req.body || {};
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(String(address))) return res.status(400).json({ error: "a valid 0x address is required" });
  res.json(await store.addRecipient(c.orgId, { label, address, addedBy: callerOf(req) || null }));
}));
app.delete("/api/recipients/:id", wrap(async (req, res) => {
  const c = await requireRole(req, res, "admin"); if (!c) return;
  res.json({ removed: await store.removeRecipient(c.orgId, req.params.id) });
}));

// ── team ────────────────────────────────────────────────────────────────────
app.get("/api/team", wrap(async (req, res) => {
  const o = requireOrg(req, res); if (!o) return;
  res.json(await store.listTeam(o));
}));
app.put("/api/team/:id", wrap(async (req, res) => {
  const c = await requireRole(req, res, "admin"); if (!c) return;
  const { role } = req.body || {};
  if (!["admin", "member", "viewer"].includes(role)) return res.status(400).json({ error: "role must be admin|member|viewer" });
  await store.setTeamRole(c.orgId, req.params.id, role);
  res.json({ ok: true });
}));
app.delete("/api/team/:id", wrap(async (req, res) => {
  const c = await requireRole(req, res, "admin"); if (!c) return;
  await store.removeTeamEntry(c.orgId, req.params.id);
  res.json({ ok: true });
}));

// ── invites (create + email, view, accept) ───────────────────────────────────
app.post("/api/invites", wrap(async (req, res) => {
  const c = await requireRole(req, res, "admin"); if (!c) return;
  const { email, name, role = "member" } = req.body || {};
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "a valid email is required" });
  if (!["admin", "member", "viewer"].includes(role)) return res.status(400).json({ error: "role must be admin|member|viewer" });

  const { org, owner } = await store.getOrgBundle(c.orgId);
  const orgName = org?.name || "your organization";
  const inviterEmail = owner?.email || callerOf(req) || "A treasury owner";
  const { invite, rawToken } = await store.createInvite(c.orgId, { email, name, role, invitedBy: c.orgId, invitedByEmail: inviterEmail, orgName });
  const acceptUrl = `${APP_URL}/accept?invite=${invite.id}&token=${rawToken}`;

  let emailed = { mode: "none" };
  try { emailed = await sendInvite({ to: email, orgName, role, inviterEmail, acceptUrl }); }
  catch (e) { console.error("[invite email] failed:", e?.message || e); emailed = { mode: "failed" }; }

  console.log(`[invite] ${email} as ${role} to org ${String(c.orgId).slice(0, 10)}… (email: ${emailed.mode})`);
  res.json({
    invite: { id: invite.id, email: invite.email, role: invite.role, status: invite.status, createdAt: invite.createdAt, expiresAt: invite.expiresAt },
    emailed: emailed.mode,
    acceptUrl: emailed.mode !== "smtp" && emailed.mode !== "sendgrid" ? acceptUrl : undefined, // surfaced only when email didn't send
  });
}));

app.get("/api/invites/:id", wrap(async (req, res) => {
  const inv = await store.getInvite(req.params.id);
  if (!inv) return res.status(404).json({ error: "invite not found" });
  if (!req.query.token || inv.tokenHash !== sha256(req.query.token)) return res.status(403).json({ error: "invalid invite link" });
  const expired = Date.now() > new Date(inv.expiresAt).getTime();
  res.json({ orgName: inv.orgName, role: inv.role, email: inv.email, invitedByEmail: inv.invitedByEmail, status: expired ? "expired" : inv.status, expired });
}));

app.post("/api/invites/accept", wrap(async (req, res) => {
  const { inviteId, token, email, name, subOrgId } = req.body || {};
  if (!inviteId || !token || !email) return res.status(400).json({ error: "inviteId, token and email are required" });
  const result = await acceptInvite({ inviteId, token, email, name, subOrgId });
  console.log(`[invite accepted] ${email} joined org ${String(result.orgId).slice(0, 10)}… as ${result.role}`);
  res.json(result);
}));

// ── transactions ──────────────────────────────────────────────────────────────
app.get("/api/transactions", wrap(async (req, res) => {
  const o = requireOrg(req, res); if (!o) return;
  let txs = await store.listTransactions(o);
  const { kind, status, source, chainId, q, limit } = req.query;
  if (kind && kind !== "all") txs = txs.filter((t) => t.kind === kind);
  if (status && status !== "all") txs = txs.filter((t) => t.status === status);
  if (source && source !== "all") txs = txs.filter((t) => (t.delivery || "") === source);
  if (chainId && chainId !== "all") txs = txs.filter((t) => String(t.chainId) === String(chainId));
  if (q) {
    const s = String(q).toLowerCase();
    txs = txs.filter((t) => (t.to || "").toLowerCase().includes(s) || (t.recipientLabel || "").toLowerCase().includes(s) || (t.txHash || "").toLowerCase().includes(s));
  }
  if (limit) txs = txs.slice(0, Number(limit));
  res.json(txs);
}));
app.post("/api/transactions", wrap(async (req, res) => {
  const c = await requireRole(req, res, "member"); if (!c) return;
  const b = req.body || {};
  const tx = {
    subOrgId: c.orgId,
    kind: b.kind || "payout",
    status: b.status || "completed",
    from: b.from || null,
    to: b.to || null,
    recipientLabel: b.recipientLabel || null,
    token: b.token || null,
    tokenSymbol: b.tokenSymbol || "USDC",
    amount: b.amount != null ? String(b.amount) : null,   // amounts are client-encrypted (amountEnc)
    amountEnc: b.amountEnc || null,
    delivery: b.delivery || "confidential",
    network: b.network || null,
    chainId: b.chainId != null ? Number(b.chainId) : null,
    txHash: b.txHash || null,
    explorerUrl: b.explorerUrl || null,
    batchId: b.batchId || null,
    createdBy: b.createdBy || callerOf(req) || "Owner",
    createdByRole: b.createdByRole || c.role,
    approvedBy: b.approvedBy || null,
    approvedAt: b.approvedAt || null,
    note: b.note || null,
    error: b.error || null,
  };
  res.json(await store.addTransaction(c.orgId, tx));
}));
app.patch("/api/transactions/:id", wrap(async (req, res) => {
  const c = await requireRole(req, res, "admin"); if (!c) return;
  const allowed = ["status", "txHash", "explorerUrl", "approvedBy", "approvedAt", "error", "note"];
  const patch = {};
  for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
  const t = await store.patchTransaction(c.orgId, req.params.id, patch);
  if (!t) return res.status(404).json({ error: "transaction not found" });
  res.json(t);
}));

// ── analytics (aggregate; amounts encrypted → the app computes real figures client-side) ──
app.get("/api/analytics", wrap(async (req, res) => {
  const o = requireOrg(req, res); if (!o) return;
  const txs = await store.listTransactions(o);
  const done = txs.filter((t) => t.status === "completed" && t.kind === "payout");
  const totalVolume = done.reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const recipients = new Set(done.map((t) => (t.to || "").toLowerCase()).filter(Boolean));
  const byDelivery = {}, byAsset = {}, monthly = {};
  for (const t of done) {
    byDelivery[t.delivery] = (byDelivery[t.delivery] || 0) + (Number(t.amount) || 0);
    byAsset[t.tokenSymbol] = (byAsset[t.tokenSymbol] || 0) + (Number(t.amount) || 0);
    const k = (t.createdAt || "").slice(0, 7);
    if (k) monthly[k] = (monthly[k] || 0) + (Number(t.amount) || 0);
  }
  res.json({ totalVolume, totalPayouts: done.length, activeRecipients: recipients.size, byDelivery, byAsset, monthly });
}));

// ── memberships (Stage-2 org switcher: "which orgs is this email in?") ──
app.get("/api/memberships", wrap(async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: "email query required" });
  res.json(await store.findMembershipsByEmail(email));
}));

// ── dev reset (this org only) ──
app.post("/api/admin/reset", wrap(async (req, res) => {
  const o = requireOrg(req, res); if (!o) return;
  await store.reset(o);
  res.json({ ok: true });
}));

app.listen(Number(PORT), () => {
  console.log(`[stabletrust-pro] backend on http://localhost:${PORT}`);
  console.log(`[stabletrust-pro] db=${dbMode} · mail=${mail.mode} · origins ${ALLOWED_ORIGINS.join(", ")}`);
});
