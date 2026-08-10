// Does re-submitting the IDENTICAL sign_transaction (2nd signer) aggregate stamps and
// complete consensus? If yes, that's the co-signing mechanism we should use for approvals
// (it reuses sign_transaction, which OTP sessions are proven to do — unlike approve_activity).
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
  subOrganizationName: `resub-${Date.now().toString(36)}`,
  rootUsers: [{ userName: "root", apiKeys: [apiKeyOf(root)], authenticators: [], oauthProviders: [] }],
  rootQuorumThreshold: 1,
  wallet: { walletName: "T", accounts: [{ curve: "CURVE_SECP256K1", pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/60'/0'/0/0", addressFormat: "ADDRESS_FORMAT_ETHEREUM" }] },
});
const subOrgId = subRes(created).subOrganizationId;
const treasury = subRes(created).wallet.addresses[0];
const rc = clientFor(root, subOrgId);
await rc.createUsers({ organizationId: subOrgId, users: [s1, s2].map((s) => ({ userName: s.name, apiKeys: [apiKeyOf(s)], authenticators: [], oauthProviders: [], userTags: [] })) });
await rc.createPolicy({ organizationId: subOrgId, policyName: "SPEND 2", effect: "EFFECT_ALLOW", consensus: "approvers.count() >= 2", condition: "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2'", notes: "t" });
await new Promise((r) => setTimeout(r, 3000)); // let the policy propagate before submitting

const c1 = clientFor(s1, subOrgId), c2 = clientFor(s2, subOrgId);
const unsigned = ethers.Transaction.from({ to: "0x000000000000000000000000000000000000dEaD", value: 0n, nonce: 0, gasLimit: 21000n, maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 1000000000n, chainId: 84532, type: 2 }).unsignedSerialized;
const params = { organizationId: subOrgId, signWith: treasury, unsignedTransaction: unsigned.slice(2), type: "TRANSACTION_TYPE_ETHEREUM" };

const a1 = await c1.signTransaction(params);
console.log("s1 submit → status:", a1.activity.status, "id:", a1.activity.id.slice(0, 8), "fp:", a1.activity.fingerprint.slice(7, 19));

console.log("\ns2 RE-SUBMITS the identical sign_transaction (same params, new timestamp)…");
const a2 = await c2.signTransaction(params);
console.log("s2 resubmit → status:", a2.activity.status, "id:", a2.activity.id.slice(0, 8), "fp:", a2.activity.fingerprint.slice(7, 19));
const sameActivity = a2.activity.id === a1.activity.id;
const signed = a2.activity?.result?.signTransactionResult?.signedTransaction;
console.log("\nsame activity id:", sameActivity, "| completed:", a2.activity.status === "ACTIVITY_STATUS_COMPLETED", "| signed tx:", signed ? signed.slice(0, 20) + "…" : "(none)");
if (a2.activity.status === "ACTIVITY_STATUS_COMPLETED" && signed) console.log("\n✅ RE-SUBMIT aggregates stamps → consensus completes. Use this for approvals.");
else console.log("\n⚠ re-submit did NOT complete it (status " + a2.activity.status + ") — approve_activity is the only path.");
process.exit(0);
