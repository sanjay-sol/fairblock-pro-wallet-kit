// ─────────────────────────────────────────────────────────────────────────────
// Model B signer. An ethers v6 signer backed by the admin's Turnkey OTP session:
//   • signMessage / signTypedData → signRawPayload (READ, 1-of-M) — derives the
//     treasury ElGamal key + decrypts amounts; any single admin can do it.
//   • signTransaction → submit a SIGN_TRANSACTION activity (SPEND). If the treasury is
//     1-of-N it COMPLETES immediately (the SDK broadcasts, like a normal signer). If it
//     needs consensus it throws PendingConsensusError carrying the activityId — OrgContext
//     records it as a pending payout for the other admins to approve.
// Mirrors the on-chain spike's ConsensusSigner (proven on Base Sepolia).
// ─────────────────────────────────────────────────────────────────────────────
import { AbstractSigner, Transaction, Signature, TypedDataEncoder, hashMessage, copyRequest, resolveProperties, resolveAddress, getAddress } from "ethers";
import { getClient, getSession } from "./lib/session.js";

const assembleSig = ({ r, s, v }) => Signature.from({ r: `0x${r}`, s: `0x${s}`, v: parseInt(v, 10) + 27 }).serialized;
const now = () => String(Date.now());

export class PendingConsensusError extends Error {
  constructor(info) { super("PENDING_CONSENSUS"); this.name = "PendingConsensusError"; this.pendingConsensus = true; Object.assign(this, info); }
}
// The Fairblock SDK may catch/rethrow our error mid-op, so we also stash the last pending
// activity here; OrgContext reads it after a caught op to know it was proposed, not failed.
let _lastPending = null;
export const takeLastPending = () => { const p = _lastPending; _lastPending = null; return p; };

// Batch/queue support: force a specific nonce onto the next signed tx. K batch payouts must get
// consecutive nonces (N, N+1, …) even though none is broadcast yet — otherwise the SDK populates
// the SAME on-chain nonce for all of them. Set before each op, clear after.
let _nonceOverride = null;
export const setNonceOverride = (n) => { _nonceOverride = n == null ? null : Number(n); };
export const clearNonceOverride = () => { _nonceOverride = null; };

export class ConsensusSigner extends AbstractSigner {
  constructor(provider) {
    super(provider);
    const s = getSession();
    if (!s) throw new Error("Sign in first");
    this.address = getAddress(s.address);
    this.subOrgId = s.subOrgId;
  }
  async getAddress() { return this.address; }
  connect(provider) { return new ConsensusSigner(provider); }

  async _signDigest(digest) {
    const r = await getClient().signRawPayload({
      type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2", timestampMs: now(), organizationId: this.subOrgId,
      parameters: { signWith: this.address, payload: digest, encoding: "PAYLOAD_ENCODING_HEXADECIMAL", hashFunction: "HASH_FUNCTION_NO_OP" },
    });
    const res = r?.activity?.result?.signRawPayloadResult;
    if (r?.activity?.status !== "ACTIVITY_STATUS_COMPLETED" || !res) throw new Error(`key derivation not completed (${r?.activity?.status})`);
    return assembleSig(res);
  }
  async signMessage(message) { return this._signDigest(hashMessage(message)); }
  async signTypedData(domain, types, value) {
    const p = await TypedDataEncoder.resolveNames(domain, types, value, async (n) => (await this.provider?.resolveName(n)) ?? "");
    return this._signDigest(TypedDataEncoder.hash(p.domain, types, p.value));
  }

  async signTransaction(transaction) {
    const { from, to, ...txn } = copyRequest(transaction);
    if (_nonceOverride != null) txn.nonce = _nonceOverride; // consecutive nonces for a batch
    const resolved = await resolveProperties({ to: transaction.to ? resolveAddress(transaction.to, this.provider) : undefined });
    const tx = Transaction.from({ ...txn, ...(resolved.to ? { to: resolved.to } : {}) });
    const r = await getClient().signTransaction({
      type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2", timestampMs: now(), organizationId: this.subOrgId,
      parameters: { signWith: this.address, unsignedTransaction: tx.unsignedSerialized.slice(2), type: "TRANSACTION_TYPE_ETHEREUM" },
    });
    const a = r.activity;
    if (a.status === "ACTIVITY_STATUS_COMPLETED") {
      const s = a.result.signTransactionResult.signedTransaction;
      return s.startsWith("0x") ? s : `0x${s}`;
    }
    if (a.status === "ACTIVITY_STATUS_CONSENSUS_NEEDED") {
      _lastPending = { activityId: a.id, fingerprint: a.fingerprint };
      throw new PendingConsensusError({ activityId: a.id, fingerprint: a.fingerprint });
    }
    throw new Error(`transaction not completed (${a.status})`);
  }
}

export function makeConsensusSigner(provider) { return new ConsensusSigner(provider); }

// Cast this admin's approval vote on a pending payout activity. We fetch the activity's
// CURRENT fingerprint with THIS admin's own session first (fingerprints are intent+timestamp
// hashes; using a fresh one avoids any staleness, and confirms the session can read the org).
export async function approveActivity(activityId) {
  const s = getSession();
  const client = getClient();
  const act = await client.getActivity({ activityId, organizationId: s.subOrgId });
  const fingerprint = act?.activity?.fingerprint;
  if (!fingerprint) throw new Error("could not read the activity's fingerprint");
  return client.approveActivity({ type: "ACTIVITY_TYPE_APPROVE_ACTIVITY", timestampMs: now(), organizationId: s.subOrgId, parameters: { fingerprint } });
}
