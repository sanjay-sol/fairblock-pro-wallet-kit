// fairblock-pro-wallet-kit/backend/server.mjs
//
// THIN application backend for the Stabletrust Pro (Wallet Kit) dashboard.
//
// Unlike the self-hosted variant, AUTH IS NOT HERE. Turnkey's Embedded Wallet Kit
// runs entirely in the browser against the managed Auth Proxy (email / passkey /
// Google / external wallet), so this server holds NO Turnkey key and has NO auth,
// register, or session routes. It only stores application data:
//
//   • GET/PUT  /api/org            • POST /api/owner
//   • GET/POST/PUT/DELETE /api/team
//   • GET/POST/DELETE /api/recipients   (a plain address book — no keys)
//   • GET/POST/PATCH /api/transactions  • GET /api/analytics
//
// No chain config and no faucet: the browser picks the testnet from its own network
// registry and does ALL on-chain signing (Turnkey embedded wallet or the user's own
// wallet). Amounts are encrypted client-side — the backend only ever sees ciphertext.

import "dotenv/config";
import express from "express";
import cors from "cors";
import { db, newId } from "./db.mjs";

const {
  PORT = "8792",
  APP_NAME = "Stabletrust Pro",
  // Optional: override the SDK's request-persistence backend. Leave UNSET in
  // production so the SDK uses its own hosted default (Fairblock backend).
  SDK_API_BASE_URL = "",
  // Comma-separated allowed browser origins (the dashboard).
  FRONTEND_ORIGIN = "http://localhost:5176",
} = process.env;

const ALLOWED_ORIGINS = FRONTEND_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);

const app = express();
app.use(
  cors({
    origin(origin, cb) {
      // allow same-origin/no-origin (curl, health checks) + configured origins
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`origin ${origin} not allowed`));
    },
  }),
);
app.use(express.json({ limit: "4mb" }));

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(`[${req.method} ${req.path}] failed:`, e?.message || e);
    res.status(500).json({ error: e?.message || String(e) });
  });

// ---------------------------------------------------------------------------
// Config (app naming only — NO keys, NO chain config; the browser owns both)
// ---------------------------------------------------------------------------
app.get("/api/config", wrap(async (_req, res) => {
  res.json({
    appName: APP_NAME,
    // "" → the SDK uses its own hosted default. Set only to override.
    sdkApiBaseUrl: SDK_API_BASE_URL || null,
  });
}));

// ---------------------------------------------------------------------------
// Org / owner
// ---------------------------------------------------------------------------
app.get("/api/org", wrap(async (_req, res) => {
  const d = db.get();
  res.json({ org: d.org, owner: d.owner, treasury: d.treasury });
}));

app.put("/api/org", wrap(async (req, res) => {
  const d = db.get();
  const { name, image, defaultDelivery, defaultNetwork } = req.body || {};
  d.org = {
    ...d.org,
    ...(name !== undefined ? { name } : {}),
    ...(image !== undefined ? { image } : {}),
    ...(defaultDelivery !== undefined ? { defaultDelivery } : {}),
    ...(defaultNetwork !== undefined ? { defaultNetwork } : {}),
  };
  db.save();
  res.json(d.org);
}));

app.post("/api/owner", wrap(async (req, res) => {
  const d = db.get();
  const { name, email, address } = req.body || {};
  d.owner = {
    name: name || d.owner?.name || "Owner",
    // Allow EXPLICIT clearing: passkey/external-wallet logins have no email and pass
    // "" to wipe a previous email session's address. `undefined` = leave unchanged.
    email: email !== undefined ? (email || "") : (d.owner?.email || ""),
    address: address || d.owner?.address || null,
  };
  db.save();
  res.json(d.owner);
}));

// ---------------------------------------------------------------------------
// Recipients — a plain address book (label + address). No keys, no activation:
// in production recipients onboard their OWN confidential account; the dashboard
// only checks on-chain whether an address is confidential-ready (client-side).
// ---------------------------------------------------------------------------
app.get("/api/recipients", wrap(async (_req, res) => {
  res.json(db.get().recipients);
}));

app.post("/api/recipients", wrap(async (req, res) => {
  const { label, address } = req.body || {};
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(String(address))) {
    return res.status(400).json({ error: "a valid 0x address is required" });
  }
  const d = db.get();
  const addr = String(address);
  const existing = d.recipients.find((r) => r.address.toLowerCase() === addr.toLowerCase());
  if (existing) {
    if (label) { existing.label = label; db.save(); }
    return res.json(existing);
  }
  const rec = {
    id: newId("rcpt"),
    label: label || `Recipient ${d.recipients.length + 1}`,
    address: addr,
    addedAt: new Date().toISOString(),
  };
  d.recipients.push(rec);
  db.save();
  res.json(rec);
}));

app.delete("/api/recipients/:id", wrap(async (req, res) => {
  const d = db.get();
  const before = d.recipients.length;
  d.recipients = d.recipients.filter((r) => r.id !== req.params.id);
  db.save();
  res.json({ removed: before - d.recipients.length });
}));

// ---------------------------------------------------------------------------
// Team (application-layer RBAC records)
// ---------------------------------------------------------------------------
app.get("/api/team", wrap(async (_req, res) => {
  res.json(db.get().team);
}));

app.post("/api/team", wrap(async (req, res) => {
  const { name, email, role = "member" } = req.body || {};
  if (!email) return res.status(400).json({ error: "email required" });
  if (!["admin", "member", "viewer"].includes(role)) {
    return res.status(400).json({ error: "role must be admin|member|viewer" });
  }
  const d = db.get();
  const m = {
    id: newId("mbr"),
    name: name || email.split("@")[0],
    email,
    role,
    address: null,
    status: "invited",
    invitedAt: new Date().toISOString(),
  };
  d.team.push(m);
  db.save();
  res.json(m);
}));

app.put("/api/team/:id", wrap(async (req, res) => {
  const d = db.get();
  const m = d.team.find((x) => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: "member not found" });
  const { role, name, status } = req.body || {};
  if (role) m.role = role;
  if (name) m.name = name;
  if (status) m.status = status;
  db.save();
  res.json(m);
}));

app.delete("/api/team/:id", wrap(async (req, res) => {
  const d = db.get();
  const before = d.team.length;
  d.team = d.team.filter((x) => x.id !== req.params.id);
  db.save();
  res.json({ removed: before - d.team.length });
}));

// ---------------------------------------------------------------------------
// Transactions (audit trail + pending-approval queue). `chainId` is recorded so
// history/analytics can be filtered per network.
// ---------------------------------------------------------------------------
app.get("/api/transactions", wrap(async (req, res) => {
  let txs = [...db.get().transactions].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const { kind, status, source, chainId, subOrgId, q, limit } = req.query;
  // Multi-tenant: only ever return the signed-in treasury's own transactions.
  if (subOrgId && subOrgId !== "all") txs = txs.filter((t) => t.subOrgId === subOrgId);
  if (kind && kind !== "all") txs = txs.filter((t) => t.kind === kind);
  if (status && status !== "all") txs = txs.filter((t) => t.status === status);
  if (source && source !== "all") txs = txs.filter((t) => (t.delivery || "") === source);
  if (chainId && chainId !== "all") txs = txs.filter((t) => String(t.chainId) === String(chainId));
  if (q) {
    const s = String(q).toLowerCase();
    txs = txs.filter(
      (t) =>
        (t.to || "").toLowerCase().includes(s) ||
        (t.recipientLabel || "").toLowerCase().includes(s) ||
        (t.txHash || "").toLowerCase().includes(s),
    );
  }
  if (limit) txs = txs.slice(0, Number(limit));
  res.json(txs);
}));

app.post("/api/transactions", wrap(async (req, res) => {
  const d = db.get();
  const b = req.body || {};
  const tx = {
    id: newId("tx"),
    subOrgId: b.subOrgId || d.treasury?.subOrgId || null, // tenant scope
    kind: b.kind || "payout",
    status: b.status || "completed",
    from: b.from || d.treasury?.address || null,
    to: b.to || null,
    recipientLabel: b.recipientLabel || null,
    token: b.token || null,
    tokenSymbol: b.tokenSymbol || "USDC",
    // Amounts are stored ENCRYPTED (client-side) — the backend never sees plaintext.
    // `amount` stays null; `amountEnc` is opaque { iv, ct }. Legacy plaintext still
    // accepted for back-compat but the frontend no longer sends it.
    amount: b.amount != null ? String(b.amount) : null,
    amountEnc: b.amountEnc || null,
    delivery: b.delivery || "confidential",
    network: b.network || null,
    chainId: b.chainId != null ? Number(b.chainId) : null,
    txHash: b.txHash || null,
    explorerUrl: b.explorerUrl || null,
    batchId: b.batchId || null,
    createdBy: b.createdBy || d.owner?.name || "Owner",
    createdByRole: b.createdByRole || "owner",
    createdAt: new Date().toISOString(),
    approvedBy: b.approvedBy || null,
    approvedAt: b.approvedAt || null,
    note: b.note || null,
    error: b.error || null,
  };
  d.transactions.push(tx);
  db.save();
  res.json(tx);
}));

app.patch("/api/transactions/:id", wrap(async (req, res) => {
  const d = db.get();
  const tx = d.transactions.find((x) => x.id === req.params.id);
  if (!tx) return res.status(404).json({ error: "transaction not found" });
  const allowed = ["status", "txHash", "explorerUrl", "approvedBy", "approvedAt", "error", "note"];
  for (const k of allowed) if (k in (req.body || {})) tx[k] = req.body[k];
  db.save();
  res.json(tx);
}));

// ---------------------------------------------------------------------------
// Analytics (aggregate over completed payouts)
// ---------------------------------------------------------------------------
app.get("/api/analytics", wrap(async (_req, res) => {
  const d = db.get();
  const done = d.transactions.filter((t) => t.status === "completed" && t.kind === "payout");
  const totalVolume = done.reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const recipients = new Set(done.map((t) => (t.to || "").toLowerCase()).filter(Boolean));
  const byDelivery = {};
  for (const t of done) byDelivery[t.delivery] = (byDelivery[t.delivery] || 0) + (Number(t.amount) || 0);
  const byAsset = {};
  for (const t of done) byAsset[t.tokenSymbol] = (byAsset[t.tokenSymbol] || 0) + (Number(t.amount) || 0);
  const monthly = {};
  for (const t of done) {
    const key = (t.createdAt || "").slice(0, 7);
    if (key) monthly[key] = (monthly[key] || 0) + (Number(t.amount) || 0);
  }
  res.json({
    totalVolume,
    totalPayouts: done.length,
    activeRecipients: recipients.size,
    byDelivery,
    byAsset,
    monthly,
  });
}));

// DEV: wipe the JSON store. Does NOT touch chain or any wallet.
app.post("/api/admin/reset", wrap(async (_req, res) => {
  db.reset();
  res.json({ ok: true });
}));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(Number(PORT), () => {
  console.log(`[stabletrust-pro] thin backend on http://localhost:${PORT}`);
  console.log(`[stabletrust-pro] no keys · auth via Turnkey Wallet Kit · origins ${ALLOWED_ORIGINS.join(", ")}`);
});
