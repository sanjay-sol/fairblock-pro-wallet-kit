// Validate ONE combined 1-of-M policy covering (deposit OR createConfidentialAccount)
// across ALL chain diamonds — so a single policy handles multi-chain funding+activation,
// while withdraw/transfer AND calls to unknown contracts still need N-of-M.
import { config } from "dotenv";
import { Turnkey } from "@turnkey/sdk-server";
import { generateP256KeyPair } from "@turnkey/crypto";
import { ethers } from "ethers";

config({ path: new URL(".env.keys", import.meta.url).pathname });
const apiBaseUrl = process.env.TURNKEY_API_BASE_URL || "https://api.turnkey.com";
const ORG = process.env.SET2_ORG_ID, PUB = process.env.SET2_PUBLIC_KEY, PRIV = process.env.SET2_PRIVATE_KEY;
const clientFor = (pub, priv, org) => new Turnkey({ apiBaseUrl, apiPublicKey: pub, apiPrivateKey: priv, defaultOrganizationId: org, activityPoller: { intervalMs: 500, numRetries: 3 } }).apiClient();
const subResult = (r) => r?.activity?.result?.createSubOrganizationResultV7 || r?.activity?.result?.createSubOrganizationResult || r || {};
const apiKeyOf = (kp, name) => ({ apiKeyName: name, publicKey: kp.publicKey, curveType: "API_KEY_CURVE_P256" });
const userRow = (name, kp) => ({ userName: name, userEmail: `${name}-${Date.now().toString(36)}@ex.com`, apiKeys: [apiKeyOf(kp, name)], authenticators: [], oauthProviders: [], userTags: [] });
const G = (s) => `\x1b[32m${s}\x1b[0m`, R = (s) => `\x1b[31m${s}\x1b[0m`;

const DIAMONDS = [
  "0x31Ce72e1D2A499140a95c19accE7bCF5E0664689", "0x7aeb444f608bDA6f922B0dBaDad6F83BCB516338",
  "0xd180189fa0774736127146a87290B4EeAe545314", "0x196f9F80134c2DeBa81E93cb4C8aD37924149A74",
  "0x2f9EAcE58059592f428C1dE1237ff1D4957548E3", "0xE559fB936C69c46E216bf61B07C16bF1a6d444aa",
];
const SEL_DEPOSIT = ethers.id("deposit(address,uint256)").slice(0, 10);
const SEL_CREATE = ethers.id("createConfidentialAccount(bytes)").slice(0, 10);
const SEL_WITHDRAW = ethers.id("withdraw(address,uint256,bytes,bool)").slice(0, 10);
console.log(`deposit=${SEL_DEPOSIT} createAcct=${SEL_CREATE} withdraw=${SEL_WITHDRAW}`);

const toList = DIAMONDS.map((d) => `eth.tx.to == '${d.toLowerCase()}'`).join(" || ");
const selList = `eth.tx.data[0..10] == '${SEL_DEPOSIT}' || eth.tx.data[0..10] == '${SEL_CREATE}'`;
const COND = `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && (${selList}) && (${toList})`;

const parent = clientFor(PUB, PRIV, ORG);
const rk = generateP256KeyPair(), u1 = generateP256KeyPair(), u2 = generateP256KeyPair();
const created = await parent.createSubOrganization({ subOrganizationName: `probe2-${Date.now().toString(36)}`, rootUsers: [{ userName: "root", apiKeys: [apiKeyOf(rk, "root")], authenticators: [], oauthProviders: [] }], rootQuorumThreshold: 1, wallet: { walletName: "w", accounts: [{ curve: "CURVE_SECP256K1", pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/60'/0'/0/0", addressFormat: "ADDRESS_FORMAT_ETHEREUM" }] } });
const subOrgId = subResult(created).subOrganizationId, address = subResult(created).wallet?.addresses?.[0];
const root = clientFor(rk.publicKey, rk.privateKey, subOrgId);
await root.createUsers({ organizationId: subOrgId, users: [userRow("u1", u1), userRow("u2", u2)] });
await root.createPolicy({ organizationId: subOrgId, policyName: "SPEND 2", effect: "EFFECT_ALLOW", consensus: "approvers.count() >= 2", condition: "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2'", notes: "p" });
await root.createPolicy({ organizationId: subOrgId, policyName: "APPROVALS", effect: "EFFECT_ALLOW", consensus: "approvers.count() >= 1", condition: "activity.type == 'ACTIVITY_TYPE_APPROVE_ACTIVITY'", notes: "p" });
try {
  await root.createPolicy({ organizationId: subOrgId, policyName: "FUND 1", effect: "EFFECT_ALLOW", consensus: "approvers.count() >= 1", condition: COND, notes: "p" });
  console.log(G("✓ combined createPolicy accepted"));
} catch (e) { console.log(R("✗ combined condition rejected: ") + String(e?.message || e).slice(0, 200)); process.exit(2); }

const u1c = clientFor(u1.publicKey, u1.privateKey, subOrgId);
const common = { nonce: 0, gasLimit: 200000n, maxFeePerGas: ethers.parseUnits("1", "gwei"), maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"), chainId: 84532, type: 2, value: 0 };
const mk = (to, data) => ethers.Transaction.from({ ...common, to, data }).unsignedSerialized.slice(2);
const dep = mk(DIAMONDS[0], SEL_DEPOSIT + ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], ["0x036CbD53842c5426634e7929541eC2318f3dCF7e", 1n]).slice(2));
const crt = mk(DIAMONDS[2], SEL_CREATE + ethers.AbiCoder.defaultAbiCoder().encode(["bytes"], ["0x1234"]).slice(2));
const wd = mk(DIAMONDS[0], SEL_WITHDRAW + ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256", "bytes", "bool"], ["0x036CbD53842c5426634e7929541eC2318f3dCF7e", 1n, "0x", false]).slice(2));
const depElsewhere = mk("0x1111111111111111111111111111111111111111", SEL_DEPOSIT + ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], ["0x036CbD53842c5426634e7929541eC2318f3dCF7e", 1n]).slice(2));

const sign = async (label, unsigned, expect) => {
  try {
    const r = await u1c.signTransaction({ organizationId: subOrgId, signWith: address, type: "TRANSACTION_TYPE_ETHEREUM", unsignedTransaction: unsigned });
    const done = r?.activity?.status === "ACTIVITY_STATUS_COMPLETED";
    const ok = expect === "complete" ? done : !done;
    console.log(`  ${ok ? G("✓") : R("✗")} ${label}: ${r?.activity?.status} (want ${expect})`);
    return ok;
  } catch (e) { const c = /consensus/i.test(String(e?.message)); const ok = expect === "consensus" && c; console.log(`  ${ok ? G("✓") : R("✗")} ${label}: ${c ? "CONSENSUS(thrown)" : String(e?.message).slice(0, 80)} (want ${expect})`); return ok; }
};
console.log("gating as u1 alone:");
const r1 = await sign("deposit → diamond[0]      ", dep, "complete");
const r2 = await sign("createAccount → diamond[2]", crt, "complete");
const r3 = await sign("withdraw → diamond[0]     ", wd, "consensus");
const r4 = await sign("deposit → UNKNOWN contract", depElsewhere, "consensus");
const all = r1 && r2 && r3 && r4;
console.log(all ? G("\n✅ ONE combined FUND policy works across all chains + both safe selectors; spends & unknown targets stay N-of-M.") : R("\n❌ unexpected — inspect above"));
process.exit(all ? 0 : 1);
