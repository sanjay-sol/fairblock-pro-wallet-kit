// ─────────────────────────────────────────────────────────────────────────────
// Model B — Turnkey management layer (server-side, uses the parent-org API key).
//
// A treasury = ONE Turnkey sub-organization with ONE Ethereum wallet, controlled by:
//   • a per-treasury BACKEND ROOT key (this server holds it) → does management + OTP
//     relay. It's the sole root user (rootQuorumThreshold 1).
//   • the human OWNER + ADMINS as NON-root "signer" users (email/OTP). They never bypass
//     policies, so the read/spend split holds.
//
// Policies on the sub-org:
//   • SPEND  (ACTIVITY_TYPE_SIGN_TRANSACTION_V2)  → approvers.count() >= threshold  (flat N-of-M)
//   • READ   (ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2)  → approvers.count() >= 1           (any admin derives the ElGamal key / views amounts)
//   • APPROVE (ACTIVITY_TYPE_APPROVE_ACTIVITY)    → approvers.count() >= 1           (admins may cast approval votes)
//
// Signing itself (proposing + approving payouts) is done CLIENT-SIDE with each admin's
// OTP session — this layer never signs a payout. Every mechanism here is proven by the
// spikes in ../spike (consensus, on-chain confidential under 2-of-3, this mgmt flow).
// ─────────────────────────────────────────────────────────────────────────────
import { Turnkey } from "@turnkey/sdk-server";
import { generateP256KeyPair } from "@turnkey/crypto";
import { ethers } from "ethers";
import { allDiamonds } from "./chains.mjs";

const ETH_ACCOUNT = { curve: "CURVE_SECP256K1", pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/60'/0'/0/0", addressFormat: "ADDRESS_FORMAT_ETHEREUM" };
export const ACTIVITY = {
  SPEND: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
  READ: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
  APPROVE: "ACTIVITY_TYPE_APPROVE_ACTIVITY",
};

// FUND-shaped calldata that ANY single admin may sign (1-of-M) — these are FUND-NEUTRAL:
// they move value into the treasury's OWN confidential balance or register its account.
// They can never send funds out, so gating them at N-of-M is pure friction. Everything
// else (withdraw/transfer/… → SPEND) stays N-of-M. Validated in spike/deposit-policy-probe2.
const SELECTOR = {
  deposit: ethers.id("deposit(address,uint256)").slice(0, 10),               // 0x47e7ef24
  createAccount: ethers.id("createConfidentialAccount(bytes)").slice(0, 10), // 0x3ee60d15
};

let parent = null;
let cfg = null;

export function initTurnkey() {
  cfg = {
    apiBaseUrl: process.env.TURNKEY_API_BASE_URL || "https://api.turnkey.com",
    orgId: process.env.TURNKEY_ORG_ID,
    appName: process.env.APP_NAME || "Stabletrust Pro",
  };
  const enabled = !!(process.env.TURNKEY_API_PRIVATE_KEY && process.env.TURNKEY_ORG_ID);
  if (enabled) {
    parent = new Turnkey({
      apiBaseUrl: cfg.apiBaseUrl, defaultOrganizationId: cfg.orgId,
      apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY, apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY,
    }).apiClient();
  }
  return enabled;
}

// A client stamped by a treasury's own backend-root key (has write access to that sub-org).
// `rootKey` = { publicKey, privateKey, subOrgId } — persisted per treasury by the store.
function rootClient(rootKey) {
  return new Turnkey({
    apiBaseUrl: cfg.apiBaseUrl, defaultOrganizationId: rootKey.subOrgId,
    apiPublicKey: rootKey.publicKey, apiPrivateKey: rootKey.privateKey,
    activityPoller: { intervalMs: 500, numRetries: 2 },
  }).apiClient();
}

const apiKeyOf = (kp, name) => ({ apiKeyName: name, publicKey: kp.publicKey, curveType: "API_KEY_CURVE_P256" });
const subRes = (r) => r?.activity?.result?.createSubOrganizationResultV7 || r?.activity?.result?.createSubOrganizationResultV6 || r?.activity?.result?.createSubOrganizationResult || r || {};
const userIdsOf = (r) => r?.activity?.result?.createUsersResult?.userIds || [];
const policyIdOf = (r) => r?.activity?.result?.createPolicyResult?.policyId;
const userRow = (email, name) => ({ userName: name || email, userEmail: email, apiKeys: [], authenticators: [], oauthProviders: [], userTags: [] });

// The FUND policy condition: a single admin (>=1) may sign a fund-neutral call
// (deposit OR createConfidentialAccount) to ANY known chain diamond. Anything else —
// a spend, or the same selector to an unknown contract — falls through to SPEND (N-of-M).
function fundCondition() {
  const sels = `eth.tx.data[0..10] == '${SELECTOR.deposit}' || eth.tx.data[0..10] == '${SELECTOR.createAccount}'`;
  const tos = allDiamonds().map((d) => `eth.tx.to == '${d.toLowerCase()}'`).join(" || ");
  return `activity.type == '${ACTIVITY.SPEND}' && (${sels}) && (${tos})`;
}

async function makePolicies(root, subOrgId, threshold) {
  const mkType = (name, consensus, type) =>
    root.createPolicy({ organizationId: subOrgId, policyName: name, effect: "EFFECT_ALLOW", consensus, condition: `activity.type == '${type}'`, notes: "modelb" });
  const spend = await mkType(`SPEND ${threshold}-of-N`, `approvers.count() >= ${threshold}`, ACTIVITY.SPEND);
  await mkType("READ 1-of-N", "approvers.count() >= 1", ACTIVITY.READ);
  await mkType("APPROVALS", "approvers.count() >= 1", ACTIVITY.APPROVE);
  await root.createPolicy({ organizationId: subOrgId, policyName: "FUND 1-of-N", effect: "EFFECT_ALLOW", consensus: "approvers.count() >= 1", condition: fundCondition(), notes: "modelb-fund" });
  return policyIdOf(spend);
}

// Create a treasury: sub-org + backend-root key + Ethereum wallet + owner (non-root) + policies.
// Returns { subOrgId, address, rootKey, ownerUserId, spendPolicyId }. The caller persists rootKey.
export async function createTreasury({ name, ownerEmail, ownerName, threshold = 1 }) {
  const rk = generateP256KeyPair();
  const created = await parent.createSubOrganization({
    subOrganizationName: `${(name || "Treasury").slice(0, 40)}-${Date.now().toString(36)}`,
    rootUsers: [{ userName: "backend-root", apiKeys: [apiKeyOf(rk, "backend-root")], authenticators: [], oauthProviders: [] }],
    rootQuorumThreshold: 1,
    wallet: { walletName: "Treasury", accounts: [ETH_ACCOUNT] },
  });
  const subOrgId = subRes(created).subOrganizationId;
  const address = subRes(created).wallet?.addresses?.[0];
  if (!subOrgId || !address) throw new Error("createTreasury: could not read subOrgId/address");
  const rootKey = { publicKey: rk.publicKey, privateKey: rk.privateKey, subOrgId };
  const root = rootClient(rootKey);
  const ownerUserId = userIdsOf(await root.createUsers({ organizationId: subOrgId, users: [userRow(ownerEmail, ownerName || "Owner")] }))[0];
  const spendPolicyId = await makePolicies(root, subOrgId, threshold);
  return { subOrgId, address, rootKey, ownerUserId, spendPolicyId };
}

// Add a co-signing admin (non-root user, email/OTP). Returns their Turnkey userId.
export async function addMember({ rootKey, email, name }) {
  const root = rootClient(rootKey);
  return userIdsOf(await root.createUsers({ organizationId: rootKey.subOrgId, users: [userRow(email, name)] }))[0];
}

// Remove a member (delete their user from the sub-org).
export async function removeMember({ rootKey, userId }) {
  const root = rootClient(rootKey);
  await root.deleteUsers({ organizationId: rootKey.subOrgId, userIds: [userId] });
}

// Change the flat N-of-M threshold: swap the SPEND policy. Returns the new policyId.
export async function setThreshold({ rootKey, threshold, spendPolicyId }) {
  const root = rootClient(rootKey);
  if (spendPolicyId) await root.deletePolicy({ organizationId: rootKey.subOrgId, policyId: spendPolicyId }).catch(() => {});
  const spend = await root.createPolicy({ organizationId: rootKey.subOrgId, policyName: `SPEND ${threshold}-of-N`, effect: "EFFECT_ALLOW", consensus: `approvers.count() >= ${threshold}`, condition: `activity.type == '${ACTIVITY.SPEND}'`, notes: "modelb" });
  return policyIdOf(spend);
}

// ── OTP auth relay (email → session in the treasury sub-org) ──
// Step 1: send a code to the member's email (registered in the sub-org).
export async function otpInit({ rootKey, email }) {
  const root = rootClient(rootKey);
  const res = await root.initOtpAuth({ organizationId: rootKey.subOrgId, otpType: "OTP_TYPE_EMAIL", contact: email, appName: cfg.appName });
  return res?.activity?.result?.initOtpAuthResultV2?.otpId;
}
// Step 2: verify the code + mint a session. `targetPublicKey` is the client's ephemeral
// P-256 public key; Turnkey returns an HPKE-encrypted `credentialBundle` the client decrypts
// to get its session API key (then it stamps proposals/approvals directly, non-custodially).
export async function otpVerify({ rootKey, otpId, otpCode, targetPublicKey, sessionSeconds }) {
  const root = rootClient(rootKey);
  const res = await root.otpAuth({
    organizationId: rootKey.subOrgId, otpId, otpCode, targetPublicKey,
    ...(sessionSeconds ? { expirationSeconds: String(sessionSeconds) } : {}),
  });
  const r = res?.activity?.result?.otpAuthResult || {};
  return { credentialBundle: r.credentialBundle, userId: r.userId, apiKeyId: r.apiKeyId };
}

// Sign a raw Ethereum tx with the treasury's BACKEND ROOT key. Root bypasses the N-of-M
// SPEND policy, so this is used ONLY for a fixed, fund-neutral op the backend fully
// controls: the one-time USDC→diamond allowance approve (spender is hard-coded to the
// diamond, so it can't be abused to approve an attacker). Never used to move funds out.
export async function rootSignTx({ rootKey, address, unsignedTransaction }) {
  const root = rootClient(rootKey);
  const r = await root.signTransaction({ organizationId: rootKey.subOrgId, signWith: address, type: "TRANSACTION_TYPE_ETHEREUM", unsignedTransaction });
  const signed = r?.activity?.result?.signTransactionResult?.signedTransaction;
  if (!signed) throw new Error(`root signTransaction not completed (${r?.activity?.status})`);
  return signed.startsWith("0x") ? signed : `0x${signed}`;
}

// Read a Turnkey activity (payout consensus status: who approved, completed?, the signed tx).
export async function getActivity({ rootKey, activityId }) {
  const root = rootClient(rootKey);
  return (await root.getActivity({ organizationId: rootKey.subOrgId, activityId })).activity;
}

// Look up which sub-orgs a verified email belongs to (defense-in-depth for the invariant;
// primary routing is our own DB). Requires the parent key.
export async function whoami() {
  return parent.getWhoami({ organizationId: cfg.orgId });
}
export const turnkeyConfig = () => ({ ...cfg });
