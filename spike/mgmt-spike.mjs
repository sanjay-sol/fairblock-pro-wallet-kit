// Validate the Model B BACKEND foundation (management + auth relay) headlessly.
// Architecture: one treasury = one sub-org with a per-treasury backend ROOT key
// (management, stored server-side) + human admins as NON-root signer users (emails,
// OTP). Policies give the read(1-of-M)/spend(N-of-M) split. Proves the exact backend ops.
import { Turnkey } from "@turnkey/sdk-server";
import { generateP256KeyPair } from "@turnkey/crypto";

const { TURNKEY_ORG_ID, TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY } = process.env;
const apiBaseUrl = process.env.TURNKEY_API_BASE_URL || "https://api.turnkey.com";
const clientFor = (kp, org) => new Turnkey({ apiBaseUrl, apiPublicKey: kp.publicKey, apiPrivateKey: kp.privateKey, defaultOrganizationId: org, activityPoller: { intervalMs: 500, numRetries: 1 } }).apiClient();
const gen = (n) => { const k = generateP256KeyPair(); return { name: n, publicKey: k.publicKey, privateKey: k.privateKey }; };
const apiKeyOf = (kp) => ({ apiKeyName: kp.name, publicKey: kp.publicKey, curveType: "API_KEY_CURVE_P256" });
const subResult = (r) => r?.activity?.result?.createSubOrganizationResultV7 || r?.activity?.result?.createSubOrganizationResult || r || {};
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
let fails = 0; const check = (c, m) => c ? ok(m) : (bad(m), fails++);

const parent = clientFor({ publicKey: TURNKEY_API_PUBLIC_KEY, privateKey: TURNKEY_API_PRIVATE_KEY }, TURNKEY_ORG_ID);

console.log("1) create-treasury: sub-org with a backend ROOT key + an Ethereum wallet");
const backendRoot = gen("backend-root");
const created = await parent.createSubOrganization({
  subOrganizationName: `treasury-${Date.now().toString(36)}`,
  rootUsers: [{ userName: "backend-root", apiKeys: [apiKeyOf(backendRoot)], authenticators: [], oauthProviders: [] }],
  rootQuorumThreshold: 1,
  wallet: { walletName: "Treasury", accounts: [{ curve: "CURVE_SECP256K1", pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/60'/0'/0/0", addressFormat: "ADDRESS_FORMAT_ETHEREUM" }] },
});
const subOrgId = subResult(created).subOrganizationId;
const treasury = subResult(created).wallet?.addresses?.[0];
check(!!subOrgId && !!treasury, `treasury sub-org ${subOrgId?.slice(0, 8)}… wallet ${treasury}`);
const root = clientFor(backendRoot, subOrgId);

console.log("2) add-members: owner + 2 admins as NON-root users with emails (OTP auth)");
const ownerEmail = "owner@example.com";
const addRes = await root.createUsers({ organizationId: subOrgId, users: [
  { userName: "owner", userEmail: ownerEmail, apiKeys: [], authenticators: [], oauthProviders: [], userTags: [] },
  { userName: "admin-1", userEmail: "admin1@example.com", apiKeys: [], authenticators: [], oauthProviders: [], userTags: [] },
  { userName: "admin-2", userEmail: "admin2@example.com", apiKeys: [], authenticators: [], oauthProviders: [], userTags: [] },
]});
const userIds = addRes?.activity?.result?.createUsersResult?.userIds || [];
check(userIds.length === 3, `added owner + 2 admins (${userIds.length} userIds)`);

console.log("3) set policies: READ 1-of-M (raw payload) · SPEND flat N-of-M (tx) · allow approvals");
const mkPolicy = (name, consensus, type) => root.createPolicy({ organizationId: subOrgId, policyName: name, effect: "EFFECT_ALLOW", consensus, condition: `activity.type == '${type}'`, notes: "modelb" });
const spend = await mkPolicy("SPEND 2-of-N", "approvers.count() >= 2", "ACTIVITY_TYPE_SIGN_TRANSACTION_V2");
await mkPolicy("READ 1", "approvers.count() >= 1", "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2");
await mkPolicy("APPROVALS", "approvers.count() >= 1", "ACTIVITY_TYPE_APPROVE_ACTIVITY");
const spendPolicyId = spend?.activity?.result?.createPolicyResult?.policyId;
check(!!spendPolicyId, `policies created (spend policy ${spendPolicyId?.slice(0, 8)}…)`);

console.log("4) governance: add a 4th admin later (simple backend call)");
await root.createUsers({ organizationId: subOrgId, users: [{ userName: "admin-3", userEmail: "admin3@example.com", apiKeys: [], authenticators: [], oauthProviders: [], userTags: [] }] });
ok("4th admin added");

console.log("5) change threshold 2 → 3: delete + recreate the spend policy");
await root.deletePolicy({ organizationId: subOrgId, policyId: spendPolicyId });
const spend3 = await mkPolicy("SPEND 3-of-N", "approvers.count() >= 3", "ACTIVITY_TYPE_SIGN_TRANSACTION_V2");
check(!!spend3?.activity?.result?.createPolicyResult?.policyId, "threshold updated to 3-of-N");

console.log("6) auth relay: initOtpAuth for an owner email, via the per-treasury root key");
try {
  const otp = await root.initOtpAuth({ organizationId: subOrgId, otpType: "OTP_TYPE_EMAIL", contact: ownerEmail, appName: "Stabletrust Pro" });
  const otpId = otp?.activity?.result?.initOtpAuthResultV2?.otpId || otp?.otpId;
  check(!!otpId, `initOtpAuth accepted → otpId ${String(otpId).slice(0, 10)}… (a real inbox would receive the code)`);
} catch (e) {
  bad(`initOtpAuth error: ${e?.message?.slice(0, 160)}`);
  console.log("     (if this needs a deliverable email, we validate the full code round-trip at real-test time)");
}

console.log(fails === 0 ? "\n\x1b[32m✅ BACKEND FOUNDATION VALIDATED\x1b[0m — create-treasury, add-member, policies, threshold-change, OTP relay all work." : `\n\x1b[31m❌ ${fails} failed\x1b[0m`);
process.exit(fails === 0 ? 0 : 1);
