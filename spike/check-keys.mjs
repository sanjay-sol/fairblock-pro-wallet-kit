// ─────────────────────────────────────────────────────────────────────────────
// Validate which candidate Turnkey parent-org API key set has SIGNATURE CREDITS.
//
// "Credits" in Turnkey are consumed by signing activities (signRawPayload /
// signTransaction). A read like whoami is free and only proves the key authenticates
// — it does NOT prove the org can still sign. So for each set we:
//   1) whoami            → key valid? which org?
//   2) createSubOrg      → org can create (activity)
//   3) signRawPayload    → THE credit test (this is what ran out before)
// We test Set 1 first (team claims 500 credits); only if its signing step fails do we
// fall through to Set 2, so we don't burn Set 2's quota needlessly.
// ─────────────────────────────────────────────────────────────────────────────
import { config } from "dotenv";
import { Turnkey } from "@turnkey/sdk-server";
import { generateP256KeyPair } from "@turnkey/crypto";

config({ path: new URL(".env.keys", import.meta.url).pathname });

const apiBaseUrl = process.env.TURNKEY_API_BASE_URL || "https://api.turnkey.com";
const clientFor = (pub, priv, org) =>
  new Turnkey({ apiBaseUrl, apiPublicKey: pub, apiPrivateKey: priv, defaultOrganizationId: org, activityPoller: { intervalMs: 500, numRetries: 2 } }).apiClient();
const subResult = (r) => r?.activity?.result?.createSubOrganizationResultV7 || r?.activity?.result?.createSubOrganizationResultV6 || r?.activity?.result?.createSubOrganizationResult || r || {};
const apiKeyOf = (kp, name) => ({ apiKeyName: name, publicKey: kp.publicKey, curveType: "API_KEY_CURVE_P256" });
const G = (s) => `\x1b[32m${s}\x1b[0m`, R = (s) => `\x1b[31m${s}\x1b[0m`, D = (s) => `\x1b[2m${s}\x1b[0m`;

const SETS = [
  { key: "SET1", label: process.env.SET1_LABEL, org: process.env.SET1_ORG_ID, cfg: process.env.SET1_CONFIG_ID, pub: process.env.SET1_PUBLIC_KEY, priv: process.env.SET1_PRIVATE_KEY },
  { key: "SET2", label: process.env.SET2_LABEL, org: process.env.SET2_ORG_ID, cfg: process.env.SET2_CONFIG_ID, pub: process.env.SET2_PUBLIC_KEY, priv: process.env.SET2_PRIVATE_KEY },
];

async function testSet(s) {
  console.log(`\n── ${s.label}  ${D(`org ${s.org?.slice(0, 8)}…`)}`);
  const out = { ...s, authOk: false, orgName: null, createOk: false, signOk: false, error: null };
  const parent = clientFor(s.pub, s.priv, s.org);

  // 1) whoami — free, proves the key authenticates against the org
  try {
    const who = await parent.getWhoami({ organizationId: s.org });
    out.authOk = true; out.orgName = who.organizationName;
    console.log(`  ${G("✓")} authenticates · org "${who.organizationName}" · user ${who.username || who.userId?.slice(0, 8)}`);
  } catch (e) {
    out.error = e?.message || String(e);
    console.log(`  ${R("✗")} whoami failed — key/org invalid: ${out.error?.slice(0, 160)}`);
    return out; // no point going further
  }

  // 2) createSubOrganization — creates a throwaway treasury-shaped sub-org w/ a root key + wallet
  let subOrgId, address, rootKey;
  try {
    rootKey = generateP256KeyPair();
    const created = await parent.createSubOrganization({
      subOrganizationName: `credit-check-${Date.now().toString(36)}`,
      rootUsers: [{ userName: "root", apiKeys: [apiKeyOf(rootKey, "root")], authenticators: [], oauthProviders: [] }],
      rootQuorumThreshold: 1,
      wallet: { walletName: "w", accounts: [{ curve: "CURVE_SECP256K1", pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/60'/0'/0/0", addressFormat: "ADDRESS_FORMAT_ETHEREUM" }] },
    });
    subOrgId = subResult(created).subOrganizationId;
    address = subResult(created).wallet?.addresses?.[0];
    out.createOk = !!(subOrgId && address);
    console.log(`  ${out.createOk ? G("✓") : R("✗")} createSubOrganization · sub-org ${subOrgId?.slice(0, 8)}… wallet ${address}`);
  } catch (e) {
    out.error = e?.message || String(e);
    console.log(`  ${R("✗")} createSubOrganization failed: ${out.error?.slice(0, 200)}`);
    return out;
  }

  // 3) signRawPayload — THE credit test (this is the op that runs out of quota)
  try {
    const root = clientFor(rootKey.publicKey, rootKey.privateKey, subOrgId);
    const res = await root.signRawPayload({
      organizationId: subOrgId,
      signWith: address,
      payload: "0x" + "ab".repeat(32), // 32-byte digest
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_NO_OP",
    });
    const sig = res?.activity?.result?.signRawPayloadResult || res?.r ? true : !!res;
    out.signOk = !!sig;
    console.log(`  ${G("✓")} signRawPayload SUCCEEDED — this org HAS signature credits ✅`);
  } catch (e) {
    out.error = e?.message || String(e);
    const quota = /quota|credit|limit|exceed|payment|billing|plan/i.test(out.error);
    console.log(`  ${R("✗")} signRawPayload failed${quota ? " (looks like QUOTA/credits exhausted)" : ""}: ${out.error?.slice(0, 220)}`);
  }
  return out;
}

const r1 = await testSet(SETS[0]);
let chosen = r1.signOk ? r1 : null;
let r2 = null;
if (!chosen) {
  console.log(`\n${D("Set 1 can't sign — falling through to Set 2…")}`);
  r2 = await testSet(SETS[1]);
  chosen = r2.signOk ? r2 : null;
}

console.log("\n════════════════════════════════════════════════");
if (chosen) {
  console.log(G(`✅ USE ${chosen.label}`));
  console.log(`   TURNKEY_ORG_ID=${chosen.org}`);
  console.log(`   TURNKEY_AUTH_PROXY_CONFIG_ID=${chosen.cfg}`);
  console.log(`   TURNKEY_API_PUBLIC_KEY=${chosen.pub}`);
  console.log(`   (private key stays in the gitignored .env)`);
} else {
  console.log(R("❌ Neither set can sign. Both may be out of credits or invalid — see errors above."));
}
console.log("════════════════════════════════════════════════");
process.exit(chosen ? 0 : 1);
