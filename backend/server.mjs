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
import { store, initStore, storeMode } from "./store.mjs";
import { initTurnkey, createTreasury, addMember, removeMember, setThreshold, otpInit, otpVerify, getActivity, rootSignTx } from "./turnkey.mjs";
import { initMailer, sendInvite } from "./mailer.mjs";
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
  if (minRole && (!role || RANK[role] < RANK[minRole])) { res.status(403).json({ error: `requires ${minRole}` }); return null; }
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
  if (m.userId) await removeMember({ rootKey: c.treasury.rootKey, userId: m.userId }).catch((e) => console.error("[removeMember tk]", e?.message));
  await store.removeMember(c.subOrgId, email);
  await store.emailIndexDel(email);
  res.json({ ok: true });
}));

// ── threshold (owner) ──
app.put("/api/threshold", wrap(async (req, res) => {
  const c = await ctx(req, res, "owner"); if (!c) return;
  const threshold = Number(req.body?.threshold);
  const members = await store.listMembers(c.subOrgId);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > members.length) return res.status(400).json({ error: `threshold must be 1..${members.length}` });
  // A threshold change swaps the SPEND policy, which Turnkey evaluates LIVE — so it would
  // retroactively change what already-pending payouts need. Block it until they clear.
  const pend = (await store.listPayouts(c.subOrgId)).filter((p) => p.status === "pending");
  if (pend.length) return res.status(409).json({ error: `Resolve the ${pend.length} pending payout(s) first — changing the threshold now would retroactively change how many approvals they need.` });
  const spendPolicyId = await setThreshold({ rootKey: c.treasury.rootKey, threshold, spendPolicyId: c.treasury.spendPolicyId });
  await store.updateTreasury(c.subOrgId, { threshold, spendPolicyId });
  res.json({ threshold });
}));

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

// Broadcast approved-and-signed payouts STRICTLY in nonce order, PER CHAIN (nonces are
// independent per chain, so a batch = K consecutive nonces on ONE chain). A gap — e.g. a
// rejected/failed payout — pauses that chain's queue until it's filled. Idempotent:
// "already known / nonce too low" just means the tx is already out there.
async function executeReadyPayouts(treasury, list) {
  const ready = list.filter((p) => p.status === "pending" && p.signedTx && !p.txHash && p.nonce != null);
  if (!ready.length || executing.has(treasury.subOrgId)) return;
  executing.add(treasury.subOrgId);
  try {
    const byChain = {};
    for (const p of ready) (byChain[cidOf(p.chainId)] ||= []).push(p);
    for (const [cid, items] of Object.entries(byChain)) {
      const prov = providerFor(cid); if (!prov) continue;
      const sorted = items.sort((a, b) => a.nonce - b.nonce);
      let expected = await prov.getTransactionCount(treasury.address, "pending");
      for (const p of sorted) {
        if (p.nonce < expected) continue;   // already in the mempool / mined
        if (p.nonce > expected) break;       // a lower nonce isn't ready yet — hold the queue in order
        const hash = ethers.Transaction.from(p.signedTx).hash;
        try {
          await prov.broadcastTransaction(p.signedTx);
          console.log(`[payout ${p.id}] broadcast chain=${cid} nonce=${p.nonce} ${hash}`);
        } catch (e) {
          const m = String(e?.message || "").toLowerCase();
          if (!/already known|nonce too low|replacement|already imported|known transaction|transaction already exists/.test(m)) {
            await store.updatePayout(treasury.subOrgId, p.id, { status: "failed", error: e?.message?.slice(0, 180) });
            break; // couldn't broadcast this nonce → stop (the rest would gap)
          }
        }
        await store.updatePayout(treasury.subOrgId, p.id, { status: "submitted", txHash: hash, explorerUrl: explorerTxFor(cid, hash) });
        expected++;
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
  const [onchain, list, fee] = await Promise.all([prov.getTransactionCount(c.treasury.address, "pending"), store.listPayouts(c.subOrgId), prov.getFeeData()]);
  const reserved = list.filter((p) => ["pending", "submitted"].includes(p.status) && p.nonce != null && cidOf(p.chainId) === cid).map((p) => Number(p.nonce));
  const nonce = Math.max(onchain, reserved.length ? Math.max(...reserved) + 1 : 0);
  const tx = {
    to: chain.usdcAddress, data: token.interface.encodeFunctionData("approve", [chain.diamondAddress, ethers.MaxUint256]),
    nonce, chainId: cid, type: 2, value: 0n, gasLimit: 90000n,
    maxFeePerGas: fee.maxFeePerGas || ethers.parseUnits("1", "gwei"),
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas || ethers.parseUnits("1", "gwei"),
  };
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
