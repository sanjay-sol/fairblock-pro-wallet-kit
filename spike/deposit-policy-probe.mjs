// ─────────────────────────────────────────────────────────────────────────────
// TASK 1 mechanism probe: can a Turnkey policy allow a DEPOSIT transaction at
// 1-of-M while a WITHDRAW (spend) still needs N-of-M — distinguished purely by the
// function selector in the calldata? If yes, deposits can be non-custodial + 1-of-M
// via a scoped SIGN_TRANSACTION policy (deposit credits the caller's OWN confidential
// balance, so it can't exfiltrate; withdraw/transfer move funds → stay N-of-M).
//
// We create a throwaway sub-org with 2 non-root API-key users, install:
//   SPEND   : sign_tx                              → approvers.count() >= 2
//   DEPOSIT : sign_tx AND to==diamond AND selector==deposit(address,uint256) → >= 1
// then, as ONE user (u1, the sole approver), try to sign:
//   • a deposit-shaped tx  → EXPECT COMPLETED (DEPOSIT policy allows at 1)
//   • a withdraw-shaped tx → EXPECT CONSENSUS_NEEDED (only SPEND matches, needs 2)
// We probe several calldata-condition syntaxes to find one Turnkey accepts.
// ─────────────────────────────────────────────────────────────────────────────
import { config } from "dotenv";
import { Turnkey } from "@turnkey/sdk-server";
import { generateP256KeyPair } from "@turnkey/crypto";
import { ethers } from "ethers";

config({ path: new URL(".env.keys", import.meta.url).pathname });
const apiBaseUrl = process.env.TURNKEY_API_BASE_URL || "https://api.turnkey.com";
const ORG = process.env.SET2_ORG_ID, PUB = process.env.SET2_PUBLIC_KEY, PRIV = process.env.SET2_PRIVATE_KEY;

const clientFor = (pub, priv, org) => new Turnkey({ apiBaseUrl, apiPublicKey: pub, apiPrivateKey: priv, defaultOrganizationId: org, activityPoller: { intervalMs: 500, numRetries: 3 } }).apiClient();
const subResult = (r) => r?.activity?.result?.createSubOrganizationResultV7 || r?.activity?.result?.createSubOrganizationResultV6 || r?.activity?.result?.createSubOrganizationResult || r || {};
const apiKeyOf = (kp, name) => ({ apiKeyName: name, publicKey: kp.publicKey, curveType: "API_KEY_CURVE_P256" });
const userRow = (name, kp) => ({ userName: name, userEmail: `${name}-${Date.now().toString(36)}@example.com`, apiKeys: [apiKeyOf(kp, name)], authenticators: [], oauthProviders: [], userTags: [] });
const G = (s) => `\x1b[32m${s}\x1b[0m`, R = (s) => `\x1b[31m${s}\x1b[0m`, Y = (s) => `\x1b[33m${s}\x1b[0m`;

// selectors
const DIAMOND = "0x31Ce72e1D2A499140a95c19accE7bCF5E0664689"; // Base Sepolia diamond
const SEL_DEPOSIT = ethers.id("deposit(address,uint256)").slice(0, 10);
const SEL_WITHDRAW = ethers.id("withdraw(address,uint256,bytes,bool)").slice(0, 10);
console.log(`selectors  deposit=${SEL_DEPOSIT}  withdraw=${SEL_WITHDRAW}`);

const parent = clientFor(PUB, PRIV, ORG);

// 1) sub-org + wallet + 2 non-root API-key users
const rk = generateP256KeyPair(), u1 = generateP256KeyPair(), u2 = generateP256KeyPair();
const created = await parent.createSubOrganization({
  subOrganizationName: `depprobe-${Date.now().toString(36)}`,
  rootUsers: [{ userName: "root", apiKeys: [apiKeyOf(rk, "root")], authenticators: [], oauthProviders: [] }],
  rootQuorumThreshold: 1,
  wallet: { walletName: "w", accounts: [{ curve: "CURVE_SECP256K1", pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/60'/0'/0/0", addressFormat: "ADDRESS_FORMAT_ETHEREUM" }] },
});
const subOrgId = subResult(created).subOrganizationId;
const address = subResult(created).wallet?.addresses?.[0];
console.log(`sub-org ${subOrgId?.slice(0, 10)}…  wallet ${address}`);
const root = clientFor(rk.publicKey, rk.privateKey, subOrgId);
const addUsers = await root.createUsers({ organizationId: subOrgId, users: [userRow("u1", u1), userRow("u2", u2)] });
const [u1id, u2id] = addUsers?.activity?.result?.createUsersResult?.userIds || [];
console.log(`users u1=${u1id?.slice(0, 8)} u2=${u2id?.slice(0, 8)}`);

// 2) SPEND >= 2 (catch-all)
await root.createPolicy({ organizationId: subOrgId, policyName: "SPEND 2", effect: "EFFECT_ALLOW", consensus: "approvers.count() >= 2", condition: "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2'", notes: "probe" });
await root.createPolicy({ organizationId: subOrgId, policyName: "APPROVALS", effect: "EFFECT_ALLOW", consensus: "approvers.count() >= 1", condition: "activity.type == 'ACTIVITY_TYPE_APPROVE_ACTIVITY'", notes: "probe" });

// 3) DEPOSIT >= 1 — probe calldata-condition syntaxes until one is accepted
const dl = DIAMOND.toLowerCase();
const CANDIDATES = [
  { name: "data[0..10] slice", cond: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && eth.tx.to == '${dl}' && eth.tx.data[0..10] == '${SEL_DEPOSIT}'` },
  { name: "data[0:10] slice",  cond: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && eth.tx.to == '${dl}' && eth.tx.data[0:10] == '${SEL_DEPOSIT}'` },
  { name: "data.startsWith",   cond: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && eth.tx.to == '${dl}' && eth.tx.data.startsWith('${SEL_DEPOSIT}')` },
  { name: "data no-0x slice",  cond: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && eth.tx.to == '${dl}' && eth.tx.data[0..8] == '${SEL_DEPOSIT.slice(2)}'` },
  { name: "contract_call",     cond: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && eth.tx.to == '${dl}' && eth.tx.contract_call_selector == '${SEL_DEPOSIT}'` },
];
let acceptedSyntax = null;
for (const c of CANDIDATES) {
  try {
    await root.createPolicy({ organizationId: subOrgId, policyName: `DEPOSIT via ${c.name}`, effect: "EFFECT_ALLOW", consensus: "approvers.count() >= 1", condition: c.cond, notes: "probe" });
    console.log(`  ${G("✓ createPolicy accepted")}: ${c.name}`);
    acceptedSyntax = c; break;
  } catch (e) {
    console.log(`  ${Y("✗ rejected")} ${c.name}: ${String(e?.message || e).slice(0, 120)}`);
  }
}
if (!acceptedSyntax) { console.log(R("\n❌ Turnkey did NOT accept ANY calldata-selector condition syntax → non-custodial 1-of-M deposit via policy is NOT viable. Use backend-root deposits instead.")); process.exit(2); }

// 4) build deposit-shaped + withdraw-shaped unsigned txns
const common = { nonce: 0, gasLimit: 200000n, maxFeePerGas: ethers.parseUnits("1", "gwei"), maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"), chainId: 84532, type: 2, value: 0 };
const depData = SEL_DEPOSIT + ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], ["0x036CbD53842c5426634e7929541eC2318f3dCF7e", 1000000n]).slice(2);
const wdData = SEL_WITHDRAW + ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256", "bytes", "bool"], ["0x036CbD53842c5426634e7929541eC2318f3dCF7e", 1000000n, "0x", false]).slice(2);
const depTx = ethers.Transaction.from({ ...common, to: DIAMOND, data: depData }).unsignedSerialized.slice(2);
const wdTx = ethers.Transaction.from({ ...common, to: DIAMOND, data: wdData }).unsignedSerialized.slice(2);

const u1c = clientFor(u1.publicKey, u1.privateKey, subOrgId);
const trySign = async (label, unsigned, expect) => {
  try {
    const r = await u1c.signTransaction({ organizationId: subOrgId, signWith: address, type: "TRANSACTION_TYPE_ETHEREUM", unsignedTransaction: unsigned });
    const st = r?.activity?.status;
    const done = st === "ACTIVITY_STATUS_COMPLETED";
    const ok = expect === "complete" ? done : !done;
    console.log(`  ${ok ? G("✓") : R("✗")} ${label}: status=${st} (expected ${expect})`);
    return ok;
  } catch (e) {
    // CONSENSUS_NEEDED sometimes surfaces as a thrown "requires consensus" — that's the withdraw expectation
    const msg = String(e?.message || e);
    const consensus = /consensus/i.test(msg);
    const ok = expect === "consensus" && consensus;
    console.log(`  ${ok ? G("✓") : R("✗")} ${label}: ${consensus ? "CONSENSUS_NEEDED (thrown)" : "error " + msg.slice(0, 120)} (expected ${expect})`);
    return ok;
  }
};

console.log("\n5) gating test as u1 alone (1 approver):");
const a = await trySign("deposit-shaped  (want 1-of-M complete)", depTx, "complete");
const b = await trySign("withdraw-shaped (want needs consensus)", wdTx, "consensus");

console.log("\n════════════════════════════════════════════════");
if (a && b) {
  console.log(G("✅ MECHANISM WORKS") + ` — deposit completes at 1-of-M, withdraw needs N-of-M.`);
  console.log(`   Use condition syntax: ${acceptedSyntax.name}`);
  console.log(`   DEPOSIT policy condition:\n     ${acceptedSyntax.cond}`);
} else {
  console.log(R("❌ gating did not behave as expected — inspect statuses above. Fall back to backend-root deposits."));
}
console.log("════════════════════════════════════════════════");
process.exit(a && b ? 0 : 1);
