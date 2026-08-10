// Isolate the approve bug: is the fingerprint from getActivity usable to approve, the same
// as the one from the submit response? (Frontend uses getActivity's; spikes used submit's.)
import { Turnkey } from "@turnkey/sdk-server";
import { generateP256KeyPair } from "@turnkey/crypto";
import { ethers } from "ethers";

const { TURNKEY_ORG_ID, TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY } = process.env;
const apiBaseUrl = process.env.TURNKEY_API_BASE_URL || "https://api.turnkey.com";
const clientFor = (kp, org) => new Turnkey({ apiBaseUrl, apiPublicKey: kp.publicKey, apiPrivateKey: kp.privateKey, defaultOrganizationId: org, activityPoller: { intervalMs: 500, numRetries: 1 } }).apiClient();
const gen = (n) => { const k = generateP256KeyPair(); return { name: n, publicKey: k.publicKey, privateKey: k.privateKey }; };
const apiKeyOf = (kp) => ({ apiKeyName: kp.name, publicKey: kp.publicKey, curveType: "API_KEY_CURVE_P256" });
const subRes = (r) => r?.activity?.result?.createSubOrganizationResultV7 || r || {};

const parent = clientFor({ publicKey: TURNKEY_API_PUBLIC_KEY, privateKey: TURNKEY_API_PRIVATE_KEY }, TURNKEY_ORG_ID);
const root = gen("root"), s1 = gen("s1"), s2 = gen("s2");
const created = await parent.createSubOrganization({
  subOrganizationName: `fp-test-${Date.now().toString(36)}`,
  rootUsers: [{ userName: "root", apiKeys: [apiKeyOf(root)], authenticators: [], oauthProviders: [] }],
  rootQuorumThreshold: 1,
  wallet: { walletName: "T", accounts: [{ curve: "CURVE_SECP256K1", pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/60'/0'/0/0", addressFormat: "ADDRESS_FORMAT_ETHEREUM" }] },
});
const subOrgId = subRes(created).subOrganizationId;
const treasury = subRes(created).wallet.addresses[0];
const rc = clientFor(root, subOrgId);
await rc.createUsers({ organizationId: subOrgId, users: [s1, s2].map((s) => ({ userName: s.name, apiKeys: [apiKeyOf(s)], authenticators: [], oauthProviders: [], userTags: [] })) });
const mk = (name, consensus, type) => rc.createPolicy({ organizationId: subOrgId, policyName: name, effect: "EFFECT_ALLOW", consensus, condition: `activity.type == '${type}'`, notes: "t" });
await mk("SPEND 2", "approvers.count() >= 2", "ACTIVITY_TYPE_SIGN_TRANSACTION_V2");
await mk("APPROVE", "approvers.count() >= 1", "ACTIVITY_TYPE_APPROVE_ACTIVITY");

const c1 = clientFor(s1, subOrgId), c2 = clientFor(s2, subOrgId);
const unsigned = ethers.Transaction.from({ to: "0x000000000000000000000000000000000000dEaD", value: 0n, nonce: 0, gasLimit: 21000n, maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 1000000000n, chainId: 84532, type: 2 }).unsignedSerialized;
const sub = await c1.signTransaction({ organizationId: subOrgId, signWith: treasury, unsignedTransaction: unsigned.slice(2), type: "TRANSACTION_TYPE_ETHEREUM" });
const activityId = sub.activity.id;
const fpSubmit = sub.activity.fingerprint;
const q = await c1.getActivity({ organizationId: subOrgId, activityId });
const fpQuery = q.activity.fingerprint;
console.log("fingerprint (submit) :", fpSubmit);
console.log("fingerprint (query)  :", fpQuery);
console.log("SAME:", fpSubmit === fpQuery);

console.log("\napprove with the QUERY fingerprint (what the frontend uses)…");
try {
  await c2.approveActivity({ organizationId: subOrgId, fingerprint: fpQuery });
  const fin = await c1.getActivity({ organizationId: subOrgId, activityId });
  console.log("  status after approve:", fin.activity.status, fin.activity.status === "ACTIVITY_STATUS_COMPLETED" ? "✓ query fingerprint WORKS" : "");
} catch (e) {
  console.log("  ✗ approve with query fingerprint FAILED:", e?.message?.slice(0, 200));
}
process.exit(0);
