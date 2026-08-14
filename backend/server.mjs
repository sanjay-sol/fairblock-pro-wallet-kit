// ─────────────────────────────────────────────────────────────────────────────
// Model B backend — co-managed (multi-sig) confidential treasuries.
//   • Turnkey management + OTP relay via the parent API key (turnkey.mjs).
//   • Firestore persistence (store.mjs) + one-email-one-treasury invariant.
//   • Payout consensus: clients PROPOSE (submit a Turnkey signing activity) + APPROVE
//     (stamp with their OTP session) directly against Turnkey. This server records the
//     payout, reports live approval status, and EXECUTES (broadcasts the signed tx) once
//     the activity reaches the threshold — the authoritative gate is Turnkey's policy.
//
// Caller identity (POC): x-org-id = treasury subOrgId, x-caller-email = the signed-in
// admin. Production should verify the Turnkey session server-side before trusting these.
// ─────────────────────────────────────────────────────────────────────────────
import "dotenv/config";
import express from "express";
import cors from "cors";
import { ethers } from "ethers";
import { OAuth2Client } from "google-auth-library";
import { store, initStore, storeMode } from "./store.mjs";
import { initTurnkey, createTreasury, addMember, removeMember, setThreshold, otpInit, otpVerify, oauthLogin, getActivity, rootSignTx } from "./turnkey.mjs";
import { initMailer, sendInvite, sendPayoutProposal } from "./mailer.mjs";
import { chainList, getChain, providerFor, explorerTxFor, DEFAULT_CHAIN_ID } from "./chains.mjs";

const {
  PORT = "8792",
  APP_NAME = "Stabletrust Pro",
  APP_URL = "http://localhost:5176",
  FRONTEND_ORIGIN = "http://localhost:5176",
} = process.env;

const ALLOWED = FRONTEND_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);
const cidOf = (v) => (v != null && getChain(v) ? Number(v) : DEFAULT_CHAIN_ID);
const ERC20_ABI = ["function allowance(address,address) view returns (uint256)", "function approve(address,uint256)"];

// Google Sign-In: the client ID is PUBLIC (also embedded in the frontend). Env-overridable; the
// hardcoded fallback keeps prod working without an extra env var. We verify every Google id_token
// server-side (signature + audience + issuer + expiry) before trusting its email for routing.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "79984203938-grkcikcebs9l9ll4ti1mdjb3gvbib7ca.apps.googleusercontent.com";
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
async function verifyGoogleToken(idToken) {
  const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
  const p = ticket.getPayload();
  if (!p?.email) throw new Error("no email in Google token");
  if (p.email_verified === false) throw new Error("your Google email isn't verified");
  return p; // { email, email_verified, sub, name, aud, iss, exp, ... }
}

// Build valid gas-fee fields for ANY chain. Some L2s (e.g. Arbitrum Sepolia) report a
// max fee far below 1 gwei, so a hardcoded priority-fee fallback would exceed it and make
// the tx invalid ("priorityFee cannot be more than maxFee"). We derive from getFeeData and
// ALWAYS keep maxPriorityFeePerGas <= maxFeePerGas; fall back to legacy gasPrice if needed.
async function feeFields(prov) {
  const f = await prov.getFeeData().catch(() => ({}));
  if (f.maxFeePerGas != null) {
    const maxFee = f.maxFeePerGas * 2n; // headroom for base-fee movement
    let priority = f.maxPriorityFeePerGas ?? 0n;
    if (priority > maxFee) priority = maxFee;
    return { type: 2, maxFeePerGas: maxFee, maxPriorityFeePerGas: priority };
  }
  return { type: 0, gasPrice: (f.gasPrice ?? 1000000000n) * 2n }; // legacy chains
}

const dbMode = initStore();
const tkEnabled = initTurnkey();
const mail = initMailer();

const app = express();
app.use(cors({ origin: (o, cb) => (!o || ALLOWED.includes(o)) ? cb(null, true) : cb(new Error(`origin ${o} not allowed`)), allowedHeaders: ["content-type", "x-org-id", "x-caller-email"] }));
app.use(express.json({ limit: "6mb" }));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(`[${req.method} ${req.path}]`, e?.message || e); res.status(500).json({ error: e?.message || String(e) }); });
const orgOf = (req) => req.headers["x-org-id"] || null;
const callerOf = (req) => String(req.headers["x-caller-email"] || "").toLowerCase();
const emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const RANK = { owner: 3, admin: 2 };

async function ctx(req, res, minRole) {
  const subOrgId = orgOf(req);
  if (!subOrgId) { res.status(400).json({ error: "missing x-org-id" }); return null; }
  const treasury = await store.getTreasury(subOrgId);
  if (!treasury) { res.status(404).json({ error: "treasury not found" }); return null; }
  const caller = callerOf(req);
  const member = caller ? await store.getMember(subOrgId, caller) : null;
  const role = member?.role || null;
  // Every treasury endpoint requires the caller to be a CURRENT member. This is what cuts off a
  // REMOVED member's still-live session — their email is gone from the members list, so they can
  // no longer read payouts/amounts/team or do anything. `minRole` is an extra gate for writes.
  if (!member) { res.status(403).json({ error: "not a member of this treasury" }); return null; }
  if (minRole && RANK[role] < RANK[minRole]) { res.status(403).json({ error: `requires ${minRole}` }); return null; }
  return { subOrgId, treasury, caller, role, member };
}

// Public info (no rootKey) about a treasury + its team.
async function publicTreasury(subOrgId, treasury) {
  const members = (await store.listMembers(subOrgId)).map((m) => ({ email: m.email, name: m.name, role: m.role, status: m.status }));
  return { subOrgId, name: treasury.name, address: treasury.address, chainId: treasury.chainId || DEFAULT_CHAIN_ID, threshold: treasury.threshold, memberCount: members.length, members };
}

// ── config / health ──
app.get("/api/config", (_req, res) => res.json({ appName: APP_NAME, chains: chainList(), defaultChainId: DEFAULT_CHAIN_ID, turnkeyBaseUrl: process.env.TURNKEY_API_BASE_URL || "https://api.turnkey.com", sdkApiBaseUrl: process.env.SDK_API_BASE_URL || null, model: "B", dbMode, mail: mail.mode, tkEnabled }));
app.get("/healthz", (_req, res) => res.json({ ok: true, dbMode, tkEnabled, mail: mail.mode }));

// ── Confidential SDK relayer proxy ──
// The SDK fires a FIRE-AND-FORGET "request row" POST to Fairblock's relayer
// (stabletrust-backend-api.fairblock.network/api/requests) at the END of every
// deposit/transfer — AFTER the op already settled on-chain (it's indexing/telemetry, not
// settlement). That relayer has an Origin allowlist that 403s browser origins ("Origin not
// allowed"), so in-browser the call fails and spams the console (cosmetic). Point the SDK
// here via SDK_API_BASE_URL and we forward it server-to-server (no browser Origin header →
// passes the allowlist), keeping the console clean. We never error the caller — the SDK
// treats this as fire-and-forget anyway, and the on-chain op is already done.
const RELAYER_URL = process.env.SDK_RELAYER_URL || "https://stabletrust-backend-api.fairblock.network";
app.post("/api/requests", async (req, res) => {
  try {
    const r = await fetch(`${RELAYER_URL}/api/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req.body || {}),
    });
    const body = await r.text();
    console.log(`[relayer-proxy] POST /api/requests → upstream ${r.status}`);
    res.status(r.status).type(r.headers.get("content-type") || "application/json").send(body);
  } catch (e) {
    console.warn("[relayer-proxy] forward failed:", e?.message || e);
    res.status(202).json({ ok: false, proxied: false });
  }
});

// ── create a treasury (owner) ──
app.post("/api/treasury", wrap(async (req, res) => {
  const { ownerEmail, name, ownerName, threshold = 1 } = req.body || {};
  if (!ownerEmail || !emailRe.test(ownerEmail)) return res.status(400).json({ error: "a valid ownerEmail is required" });
  const inUse = await store.emailIndexGet(ownerEmail);
  if (inUse) return res.status(409).json({ error: "This email already belongs to a treasury. One email can be part of only one treasury." });
  const t = await createTreasury({ name: name || "Treasury", ownerEmail: ownerEmail.toLowerCase(), ownerName, threshold: Number(threshold) || 1 });
  await store.createTreasury({ subOrgId: t.subOrgId, name: name || "Treasury", ownerEmail: ownerEmail.toLowerCase(), address: t.address, chainId: DEFAULT_CHAIN_ID, threshold: Number(threshold) || 1, spendPolicyId: t.spendPolicyId, rootKey: t.rootKey });
  await store.addMember(t.subOrgId, { email: ownerEmail.toLowerCase(), name: ownerName || "Owner", role: "owner", userId: t.ownerUserId, status: "active" });
  await store.emailIndexSet(ownerEmail, { subOrgId: t.subOrgId, role: "owner" });
  console.log(`[treasury] created ${t.subOrgId.slice(0, 10)}… owner ${ownerEmail}`);
  res.json({ subOrgId: t.subOrgId, address: t.address, name: name || "Treasury" });
}));

// ── OTP auth relay (email → session in the treasury sub-org) ──
app.post("/api/auth/init", wrap(async (req, res) => {
  const { email } = req.body || {};
  if (!email || !emailRe.test(email)) return res.status(400).json({ error: "a valid email is required" });
  const idx = await store.emailIndexGet(email);
  if (!idx) return res.status(404).json({ error: "No treasury for this email. Create one, or ask an admin to invite you." });
  const treasury = await store.getTreasury(idx.subOrgId);
  const otpId = await otpInit({ rootKey: treasury.rootKey, email: email.toLowerCase() });
  res.json({ otpId, subOrgId: idx.subOrgId });
}));

app.post("/api/auth/verify", wrap(async (req, res) => {
  const { email, otpId, otpCode, targetPublicKey } = req.body || {};
  if (!email || !otpId || !otpCode || !targetPublicKey) return res.status(400).json({ error: "email, otpId, otpCode, targetPublicKey are required" });
  const idx = await store.emailIndexGet(email);
  if (!idx) return res.status(404).json({ error: "no treasury for this email" });
  const treasury = await store.getTreasury(idx.subOrgId);
  const { credentialBundle, userId } = await otpVerify({ rootKey: treasury.rootKey, otpId, otpCode, targetPublicKey, sessionSeconds: 43200 });
  if (!credentialBundle) return res.status(401).json({ error: "invalid or expired code" });
  const member = await store.getMember(idx.subOrgId, email);
  if (member) await store.updateMember(idx.subOrgId, email, { status: "active", userId: userId || member.userId, joinedAt: new Date().toISOString() });
  const memberCount = (await store.listMembers(idx.subOrgId)).length;
  res.json({ credentialBundle, subOrgId: idx.subOrgId, address: treasury.address, name: treasury.name, threshold: treasury.threshold, memberCount, chainId: treasury.chainId || DEFAULT_CHAIN_ID, role: member?.role || "admin", email: email.toLowerCase(), userId: userId || member?.userId });
}));

// ── OAuth (Google) sign-in relay — a verified Google id_token → the same session bundle as OTP ──
// One step (no "send a code"): Google IS the challenge. We verify the token, route by its email
// (same one-email-one-treasury invariant), then Turnkey mints the session (linking the Google
// provider on first login). Response shape is IDENTICAL to /api/auth/verify.
app.post("/api/auth/oauth", wrap(async (req, res) => {
  const { oidcToken, targetPublicKey } = req.body || {};
  if (!oidcToken || !targetPublicKey) return res.status(400).json({ error: "oidcToken and targetPublicKey are required" });
  let email;
  try { email = String((await verifyGoogleToken(oidcToken)).email).toLowerCase(); }
  catch (e) { return res.status(401).json({ error: `Google sign-in couldn't be verified — ${e?.message || "invalid token"}` }); }
  const idx = await store.emailIndexGet(email);
  // No org for this verified Google account yet → NOT an error. Tell the client to collect just an
  // org name + the owner's name (email is already known + verified) and finish via /api/auth/oauth/create.
  if (!idx) return res.json({ needsOnboarding: true, email });
  const treasury = await store.getTreasury(idx.subOrgId);
  const member = await store.getMember(idx.subOrgId, email);
  const { credentialBundle, userId } = await oauthLogin({ rootKey: treasury.rootKey, userId: member?.userId, oidcToken, targetPublicKey, sessionSeconds: 43200 });
  if (!credentialBundle) return res.status(401).json({ error: "Google sign-in failed" });
  if (member) await store.updateMember(idx.subOrgId, email, { status: "active", userId: userId || member.userId, joinedAt: new Date().toISOString() });
  const memberCount = (await store.listMembers(idx.subOrgId)).length;
  res.json({ credentialBundle, subOrgId: idx.subOrgId, address: treasury.address, name: treasury.name, threshold: treasury.threshold, memberCount, chainId: treasury.chainId || DEFAULT_CHAIN_ID, role: member?.role || "admin", email, userId: userId || member?.userId });
}));

// Create a new organisation for a Google-verified user (no email step — Google gave us the email).
// Only org name + owner name are collected client-side; we re-verify the SAME token here and sign in.
app.post("/api/auth/oauth/create", wrap(async (req, res) => {
  const { oidcToken, targetPublicKey, orgName, ownerName } = req.body || {};
  if (!oidcToken || !targetPublicKey) return res.status(400).json({ error: "oidcToken and targetPublicKey are required" });
  let email, googleName;
  try { const p = await verifyGoogleToken(oidcToken); email = String(p.email).toLowerCase(); googleName = p.name; }
  catch (e) { return res.status(401).json({ error: `Google sign-in couldn't be verified — ${e?.message || "invalid token"}` }); }
  const inUse = await store.emailIndexGet(email);
  if (inUse) return res.status(409).json({ error: "This Google account already belongs to an organisation — sign in instead." });
  const name = (orgName || "").trim() || "Organisation";
  const owner = (ownerName || "").trim() || googleName || "Owner";
  const t = await createTreasury({ name, ownerEmail: email, ownerName: owner, threshold: 1 });
  await store.createTreasury({ subOrgId: t.subOrgId, name, ownerEmail: email, address: t.address, chainId: DEFAULT_CHAIN_ID, threshold: 1, spendPolicyId: t.spendPolicyId, rootKey: t.rootKey });
  await store.addMember(t.subOrgId, { email, name: owner, role: "owner", userId: t.ownerUserId, status: "active" });
  await store.emailIndexSet(email, { subOrgId: t.subOrgId, role: "owner" });
  console.log(`[treasury] created via Google ${t.subOrgId.slice(0, 10)}… owner ${email}`);
  const { credentialBundle, userId } = await oauthLogin({ rootKey: t.rootKey, userId: t.ownerUserId, oidcToken, targetPublicKey, sessionSeconds: 43200 });
  if (!credentialBundle) return res.status(401).json({ error: "Signed up, but Google session couldn't be minted — try signing in." });
  res.json({ credentialBundle, subOrgId: t.subOrgId, address: t.address, name, threshold: 1, memberCount: 1, chainId: DEFAULT_CHAIN_ID, role: "owner", email, userId });
}));

// ── treasury context + team ──
app.get("/api/treasury", wrap(async (req, res) => {
  const c = await ctx(req, res); if (!c) return;
  res.json({ ...(await publicTreasury(c.subOrgId, c.treasury)), role: c.role });
}));

app.put("/api/treasury", wrap(async (req, res) => {
  const c = await ctx(req, res, "admin"); if (!c) return;
  const patch = {};
  for (const k of ["name"]) if (req.body?.[k] !== undefined) patch[k] = req.body[k];
  res.json(await store.updateTreasury(c.subOrgId, patch));
}));

// ── members (add / remove) ──
app.post("/api/members", wrap(async (req, res) => {
  const c = await ctx(req, res, "admin"); if (!c) return;
  const { email, name } = req.body || {};
  if (!email || !emailRe.test(email)) return res.status(400).json({ error: "a valid email is required" });
  const inUse = await store.emailIndexGet(email);
  if (inUse) return res.status(409).json({ error: inUse.subOrgId === c.subOrgId ? "already a member of this treasury" : "This email already belongs to another treasury." });
  const userId = await addMember({ rootKey: c.treasury.rootKey, email: email.toLowerCase(), name });
  const member = await store.addMember(c.subOrgId, { email: email.toLowerCase(), name: name || email, role: "admin", userId, status: "active", invitedBy: c.caller });
  await store.emailIndexSet(email, { subOrgId: c.subOrgId, role: "admin" });
  let emailed = { mode: "none" };
  try { emailed = await sendInvite({ to: email, orgName: c.treasury.name, role: "admin", inviterEmail: c.caller, acceptUrl: `${APP_URL}/?email=${encodeURIComponent(email)}` }); } catch (e) { console.error("[invite email]", e?.message); }
  res.json({ member, emailed: emailed.mode });
}));

app.delete("/api/members/:email", wrap(async (req, res) => {
  const c = await ctx(req, res, "admin"); if (!c) return;
  const email = req.params.email.toLowerCase();
  const m = await store.getMember(c.subOrgId, email);
  if (!m) return res.status(404).json({ error: "member not found" });
  if (m.role === "owner") return res.status(400).json({ error: "cannot remove the owner" });
  // Removing a member is LOCKED while ANY payout is pending. Removal deletes their Turnkey user,
  // which orphans any vote they cast (a payout its creator approved collapses to 0 approvals and can
  // no longer be signed), and can drop the team below the approval threshold. Keeping the team stable
  // until all payouts settle or are rejected avoids that whole class of edge cases.
  const pend = (await store.listPayouts(c.subOrgId)).filter((p) => p.status === "pending");
  if (pend.length) return res.status(409).json({ error: `Resolve the ${pend.length} pending payout(s) first — you can't remove a member while payouts are awaiting approval.` });
  const remaining = (await store.listMembers(c.subOrgId)).length - 1; // members left after this removal (owner always stays)
  const threshold = c.treasury.threshold || 1;
  if (m.userId) await removeMember({ rootKey: c.treasury.rootKey, userId: m.userId }).catch((e) => console.error("[removeMember tk]", e?.message));
  await store.removeMember(c.subOrgId, email);
  await store.emailIndexDel(email);
  let newThreshold = threshold;
  if (threshold > remaining) { // clamp down so it stays valid (owner always remains → remaining >= 1)
    newThreshold = Math.max(1, remaining);
    const spendPolicyId = await setThreshold({ rootKey: c.treasury.rootKey, threshold: newThreshold, spendPolicyId: c.treasury.spendPolicyId });
    await store.updateTreasury(c.subOrgId, { threshold: newThreshold, spendPolicyId });
    console.log(`[threshold] auto-lowered ${threshold}→${newThreshold} after removing ${email}`);
  }
  res.json({ ok: true, threshold: newThreshold, thresholdLowered: newThreshold !== threshold });
}));

// ── threshold (owner) ──
app.put("/api/threshold", wrap(async (req, res) => {
  const c = await ctx(req, res, "owner"); if (!c) return;
  const threshold = Number(req.body?.threshold);
  const members = await store.listMembers(c.subOrgId);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > members.length) return res.status(400).json({ error: `threshold must be 1..${members.length}` });
  // A threshold change swaps the SPEND policy, which Turnkey evaluates LIVE — so it would
  // retroactively change what already-pending payouts need. Block it until they clear. EXCEPTION:
  // if the current threshold is already INVALID (> member count — e.g. a member left), a decrease
  // to a valid value is CORRECTIVE (it only makes stuck payouts reachable), so we allow it.
  const cur = c.treasury.threshold || 1;
  const correcting = cur > members.length && threshold < cur;
  const pend = (await store.listPayouts(c.subOrgId)).filter((p) => p.status === "pending");
  if (pend.length && !correcting) return res.status(409).json({ error: `Resolve the ${pend.length} pending payout(s) first — changing the threshold now would retroactively change how many approvals they need.` });
  const spendPolicyId = await setThreshold({ rootKey: c.treasury.rootKey, threshold, spendPolicyId: c.treasury.spendPolicyId });
  await store.updateTreasury(c.subOrgId, { threshold, spendPolicyId });
  res.json({ threshold });
}));

// Email every co-signer (except the proposer) when a payout needs approval. A K-row batch fires K
// rapid POSTs, so we de-dupe by batchId in-memory (single instance) → ONE email per batch, not K.
// Fire-and-forget: never blocks or fails the payout POST. No amount is included (it's encrypted).
const notifiedBatches = new Map();
async function notifyAdminsOfPayout(c, payout) {
  try {
    if (payout.batchId) {
      const now = Date.now();
      if (now - (notifiedBatches.get(payout.batchId) || 0) < 120000) return; // already emailed this batch
      notifiedBatches.set(payout.batchId, now);
      if (notifiedBatches.size > 500) for (const [k, t] of notifiedBatches) if (now - t > 600000) notifiedBatches.delete(k);
    }
    const members = await store.listMembers(c.subOrgId);
    const others = members.filter((m) => m.status === "active" && m.email && m.email !== c.caller);
    if (!others.length) return;
    const approvals = `${c.treasury.threshold}-of-${members.length}`;
    const proposerName = c.member?.name || c.caller;
    const reviewUrl = `${APP_URL}/pending`;
    await Promise.all(others.map((m) => sendPayoutProposal({ to: m.email, orgName: c.treasury.name, proposerName, approvals, reviewUrl, isBatch: !!payout.batchId })
      .catch((e) => console.error("[payout notify]", m.email, e?.message))));
  } catch (e) { console.error("[payout notify]", e?.message); }
}

// ── payouts: propose / list (with live consensus + auto-execute) / reject ──
app.post("/api/payouts", wrap(async (req, res) => {
  const c = await ctx(req, res, "admin"); if (!c) return;
  const b = req.body || {};
  if (!b.activityId && !b.txHash) return res.status(400).json({ error: "activityId (pending) or txHash (completed) is required" });
  const completed = !b.activityId && !!b.txHash; // solo (threshold 1) settles synchronously client-side
  const payout = await store.addPayout(c.subOrgId, {
    activityId: b.activityId || null, fingerprint: b.fingerprint || null, chainId: cidOf(b.chainId),
    nonce: b.nonce != null ? Number(b.nonce) : null, batchId: b.batchId || null,
    kind: b.kind || "transfer", recipient: b.recipient || null, recipientLabel: b.recipientLabel || null,
    amountEnc: b.amountEnc || null, tokenSymbol: b.tokenSymbol || "USDC", token: b.token || null, delivery: b.delivery || "confidential",
    note: b.note || null, status: completed ? "completed" : "pending", txHash: b.txHash || null, explorerUrl: b.explorerUrl || null,
    createdBy: c.caller, createdByName: c.member?.name || c.caller,
  });
  // Notify co-signers only when it actually needs approval (pending/multi-sig) — not solo/completed.
  if (!completed && payout.status === "pending") notifyAdminsOfPayout(c, payout); // fire-and-forget
  res.json(payout);
}));

// ── payout execution: approvals → capture signed tx → broadcast in NONCE ORDER → finalize ──
const executing = new Set(); // at most one ordered executor per treasury at a time

// Update a payout's live approval state; when its Turnkey activity completes, CAPTURE the
// signed tx (but don't broadcast here — the ordered executor does that so nonces stay sequential).
async function enrichPayout(treasury, members, p) {
  if (p.status !== "pending" || !p.activityId) return p;
  let activity;
  try { activity = await getActivity({ rootKey: treasury.rootKey, activityId: p.activityId }); } catch { return p; }
  const byUser = Object.fromEntries(members.filter((m) => m.userId).map((m) => [m.userId, m]));
  const approvals = [...new Set((activity?.votes || [])
    .filter((v) => !v.selection || v.selection === "VOTE_SELECTION_APPROVED")
    .map((v) => (v.user?.userEmail || byUser[v.userId]?.email || "").toLowerCase()).filter(Boolean))];
  const patch = { approvals, tkStatus: activity?.status, fingerprint: activity?.fingerprint || p.fingerprint || null };
  if (activity?.status === "ACTIVITY_STATUS_COMPLETED" && !p.signedTx) {
    const signed = activity.result?.signTransactionResult?.signedTransaction;
    if (signed) patch.signedTx = signed.startsWith("0x") ? signed : `0x${signed}`;
  } else if (activity?.status === "ACTIVITY_STATUS_REJECTED" || activity?.status === "ACTIVITY_STATUS_FAILED") {
    patch.status = "failed"; patch.error = "rejected/failed at Turnkey";
  }
  return store.updatePayout(treasury.subOrgId, p.id, patch);
}

const BROADCAST_OK = /already known|nonce too low|replacement|already imported|known transaction|transaction already exists/;

// Clear a DEAD nonce — one reserved by a payout that was rejected (or failed) BEFORE it ever
// broadcast, so its slot is a permanent hole that blocks every higher-nonce payout behind it.
// We fill it with a 0-value self-transfer signed by the backend ROOT key. This is fund-neutral
// (to == the treasury itself — money never leaves), matching rootSignTx's contract; it just
// advances the account nonce so the approved payouts queued behind the hole can settle.
// Idempotent: if a prior poll already filled it, "already known / nonce too low" is swallowed.
async function fillNonceGap(treasury, cid, nonce) {
  const prov = providerFor(cid); if (!prov) return false;
  let gasLimit = 21000n;
  try { gasLimit = (await prov.estimateGas({ from: treasury.address, to: treasury.address, value: 0n })) * 12n / 10n; } catch { /* keep 21000 */ }
  const fees = await feeFields(prov);
  const tx = { to: treasury.address, value: 0n, nonce, chainId: cid, gasLimit, ...fees };
  const unsigned = ethers.Transaction.from(tx).unsignedSerialized.slice(2);
  const signed = await rootSignTx({ rootKey: treasury.rootKey, address: treasury.address, unsignedTransaction: unsigned });
  try {
    const sent = await prov.broadcastTransaction(signed);
    console.log(`[nonce-gap] chain=${cid} filled dead nonce ${nonce} via self-send ${sent.hash}`);
  } catch (e) {
    if (!BROADCAST_OK.test(String(e?.message || "").toLowerCase())) throw e;
    console.log(`[nonce-gap] chain=${cid} nonce ${nonce} already filled`);
  }
  return true;
}

// Broadcast approved-and-signed payouts STRICTLY in nonce order, PER CHAIN (nonces are
// independent per chain, so a batch = K consecutive nonces on ONE chain). We walk the account
// nonce forward from what the chain expects up to the highest ready payout, and at each slot:
//   • a ready (approved+signed) payout → broadcast it;
//   • a DEAD slot (rejected/failed-before-broadcast payout) → fill it so the queue continues;
//   • a still-pending (unapproved) payout → STOP (it legitimately owns that nonce, wait for it).
// This is what makes a rejected payout no longer deadlock the ones behind it. Idempotent.
async function executeReadyPayouts(treasury, list) {
  if (executing.has(treasury.subOrgId)) return;
  const byChain = {};
  for (const p of list) if (p.nonce != null) (byChain[cidOf(p.chainId)] ||= []).push(p);
  // Only touch chains that actually have an approved-and-signed payout waiting to go out.
  const chains = Object.entries(byChain).filter(([, items]) => items.some((p) => p.status === "pending" && p.signedTx && !p.txHash));
  if (!chains.length) return;
  executing.add(treasury.subOrgId);
  try {
    for (const [cidStr, items] of chains) {
      const cid = Number(cidStr);
      const prov = providerFor(cid); if (!prov) continue;
      const maxReady = Math.max(...items.filter((p) => p.status === "pending" && p.signedTx && !p.txHash).map((p) => Number(p.nonce)));
      let expected = await prov.getTransactionCount(treasury.address, "pending");
      while (expected <= maxReady) {
        // A nonce can be REUSED (rejecting a payout frees its nonce for a later proposal), so one
        // slot may hold several payout rows. Resolve to what that nonce ACTUALLY is, preferring a
        // live payout over a dead duplicate — never fill a slot a real payout is waiting to use.
        const here = items.filter((p) => Number(p.nonce) === expected);
        const ready = here.find((p) => p.status === "pending" && p.signedTx && !p.txHash);
        const already = here.find((p) => p.txHash);                              // already broadcast/mined at this nonce
        const liveWait = here.find((p) => p.status === "pending" && !p.signedTx); // still awaiting approval
        const allDead = here.length > 0 && here.every((p) => !p.txHash && (p.status === "rejected" || p.status === "failed"));
        if (ready) {
          const hash = ethers.Transaction.from(ready.signedTx).hash;
          try {
            await prov.broadcastTransaction(ready.signedTx);
            console.log(`[payout ${ready.id}] broadcast chain=${cid} nonce=${expected} ${hash}`);
          } catch (e) {
            if (!BROADCAST_OK.test(String(e?.message || "").toLowerCase())) {
              await store.updatePayout(treasury.subOrgId, ready.id, { status: "failed", error: e?.message?.slice(0, 180) });
              break; // this nonce won't broadcast → a later poll fills it as a dead slot
            }
          }
          await store.updatePayout(treasury.subOrgId, ready.id, { status: "submitted", txHash: hash, explorerUrl: explorerTxFor(cid, hash) });
          expected++;
        } else if (already) {
          expected++; // nonce already spent on-chain — step past it
        } else if (liveWait) {
          break; // a lower-nonce payout is still awaiting approval — hold the queue in order
        } else if (allDead) {
          const filled = await fillNonceGap(treasury, cid, expected).catch((e) => { console.error(`[nonce-gap ${cid}/${expected}]`, e?.message || e); return false; });
          if (!filled) break; // couldn't clear the hole this round — retry next poll
          expected++;
        } else {
          break; // unknown hole (no payout row owns this nonce) — wait
        }
      }
    }
  } finally { executing.delete(treasury.subOrgId); }
}

// Finalize broadcast payouts from their on-chain receipt (each on its own chain).
async function finalizeSubmitted(treasury, list) {
  await Promise.all(list.filter((p) => p.status === "submitted" && p.txHash).map(async (p) => {
    const prov = providerFor(cidOf(p.chainId)); if (!prov) return;
    const rc = await prov.getTransactionReceipt(p.txHash).catch(() => null);
    if (rc) await store.updatePayout(treasury.subOrgId, p.id, rc.status === 1 ? { status: "completed", error: null } : { status: "failed", error: "reverted on-chain" });
  }));
}

// Reserve the next nonce(s) on a given chain: max(on-chain pending, highest reserved-in-DB + 1).
app.get("/api/nonce", wrap(async (req, res) => {
  const c = await ctx(req, res, "admin"); if (!c) return;
  const cid = cidOf(req.query.chainId);
  const prov = providerFor(cid); if (!prov) return res.status(400).json({ error: `unsupported chainId ${req.query.chainId}` });
  const count = Math.max(1, Math.min(Number(req.query.count) || 1, 200));
  const [onchain, list] = await Promise.all([prov.getTransactionCount(c.treasury.address, "pending"), store.listPayouts(c.subOrgId)]);
  const reserved = list.filter((p) => ["pending", "submitted"].includes(p.status) && p.nonce != null && cidOf(p.chainId) === cid).map((p) => Number(p.nonce));
  const base = Math.max(onchain, reserved.length ? Math.max(...reserved) + 1 : 0);
  res.json({ base, count, chainId: cid });
}));

// Ensure the treasury's USDC→diamond allowance on a chain (root-signed, spender hard-coded
// to the diamond). This lets deposits be a SINGLE 1-of-M call (no client approve to co-sign).
app.post("/api/allowance", wrap(async (req, res) => {
  const c = await ctx(req, res, "admin"); if (!c) return;
  const cid = cidOf(req.body?.chainId);
  const chain = getChain(cid), prov = providerFor(cid);
  if (!chain || !prov) return res.status(400).json({ error: `unsupported chainId ${req.body?.chainId}` });
  const token = new ethers.Contract(chain.usdcAddress, ERC20_ABI, prov);
  const cur = await token.allowance(c.treasury.address, chain.diamondAddress).catch(() => 0n);
  if (cur >= ethers.MaxUint256 / 2n) return res.json({ ok: true, already: true });
  const data = token.interface.encodeFunctionData("approve", [chain.diamondAddress, ethers.MaxUint256]);
  const [onchain, list, fees] = await Promise.all([prov.getTransactionCount(c.treasury.address, "pending"), store.listPayouts(c.subOrgId), feeFields(prov)]);
  const reserved = list.filter((p) => ["pending", "submitted"].includes(p.status) && p.nonce != null && cidOf(p.chainId) === cid).map((p) => Number(p.nonce));
  const nonce = Math.max(onchain, reserved.length ? Math.max(...reserved) + 1 : 0);
  let gasLimit = 120000n; // per-chain estimate (Arbitrum needs more than a fixed 90k)
  try { gasLimit = (await prov.estimateGas({ from: c.treasury.address, to: chain.usdcAddress, data, value: 0n })) * 12n / 10n; } catch { /* keep fallback */ }
  const tx = { to: chain.usdcAddress, data, nonce, chainId: cid, value: 0n, gasLimit, ...fees };
  const unsigned = ethers.Transaction.from(tx).unsignedSerialized.slice(2);
  const signed = await rootSignTx({ rootKey: c.treasury.rootKey, address: c.treasury.address, unsignedTransaction: unsigned });
  const sent = await prov.broadcastTransaction(signed);
  await sent.wait();
  console.log(`[allowance] chain=${cid} approved diamond for ${c.treasury.address.slice(0, 10)}… ${sent.hash}`);
  res.json({ ok: true, txHash: sent.hash });
}));

app.get("/api/payouts", wrap(async (req, res) => {
  const c = await ctx(req, res); if (!c) return;
  const treasury = { ...c.treasury, subOrgId: c.subOrgId };
  const members = await store.listMembers(c.subOrgId);
  await Promise.all((await store.listPayouts(c.subOrgId)).map((p) => enrichPayout(treasury, members, p)));
  const afterEnrich = await store.listPayouts(c.subOrgId);
  await finalizeSubmitted(treasury, afterEnrich);
  await executeReadyPayouts(treasury, afterEnrich);
  const final = await store.listPayouts(c.subOrgId);
  res.json(final.map(({ signedTx, unsignedTx, ...rest }) => rest)); // don't ship raw signed/unsigned tx
}));

app.post("/api/payouts/:id/rejected", wrap(async (req, res) => {
  const c = await ctx(req, res, "admin"); if (!c) return;
  const p = await store.getPayout(c.subOrgId, req.params.id);
  if (!p) return res.status(404).json({ error: "payout not found" });
  // Only a still-pending payout can be rejected. Once it's broadcast/settled the nonce is spent
  // on-chain — flipping it to "rejected" would be a lie AND make the executor try to "fill" a
  // nonce that's already used. (The UI only offers Reject on pending, but guard the API too.)
  if (p.status !== "pending") return res.status(409).json({ error: `can only reject a pending payout (this one is already ${p.status})` });
  res.json(await store.updatePayout(c.subOrgId, req.params.id, { status: "rejected" }));
}));

// ── recipients address book ──
app.get("/api/recipients", wrap(async (req, res) => { const c = await ctx(req, res); if (!c) return; res.json(await store.listRecipients(c.subOrgId)); }));
app.post("/api/recipients", wrap(async (req, res) => {
  const c = await ctx(req, res, "admin"); if (!c) return;
  const { label, address } = req.body || {};
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ error: "a valid 0x address is required" });
  res.json(await store.addRecipient(c.subOrgId, { label: label || "Recipient", address, addedBy: c.caller }));
}));
app.delete("/api/recipients/:id", wrap(async (req, res) => { const c = await ctx(req, res, "admin"); if (!c) return; await store.removeRecipient(c.subOrgId, req.params.id); res.json({ ok: true }); }));

// ── dev reset ──
app.post("/api/admin/reset", wrap(async (_req, res) => { await store.reset(); res.json({ ok: true }); }));

app.listen(Number(PORT), () => {
  console.log(`[stabletrust-pro · Model B] backend on http://localhost:${PORT}`);
  console.log(`[stabletrust-pro · Model B] db=${dbMode} · turnkey=${tkEnabled ? "on" : "OFF"} · mail=${mail.mode} · chains=${chainList().map((c) => c.chainId).join(",")}`);
});
