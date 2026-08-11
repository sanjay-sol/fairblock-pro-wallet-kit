// Validate a single Turnkey key set (SET3 by default) actually has SIGNING credits.
// Reads creds from gitignored .env.keys — no secret inline. whoami → createSubOrg → signRawPayload.
import { config } from "dotenv";
import { Turnkey } from "@turnkey/sdk-server";
import { generateP256KeyPair } from "@turnkey/crypto";
config({ path: new URL(".env.keys", import.meta.url).pathname });

const P = (process.argv[2] || "SET3").toUpperCase();
const apiBaseUrl = process.env.TURNKEY_API_BASE_URL || "https://api.turnkey.com";
const ORG = process.env[`${P}_ORG_ID`], PUB = process.env[`${P}_PUBLIC_KEY`], PRIV = process.env[`${P}_PRIVATE_KEY`];
const clientFor = (pub, priv, org) => new Turnkey({ apiBaseUrl, apiPublicKey: pub, apiPrivateKey: priv, defaultOrganizationId: org, activityPoller: { intervalMs: 500, numRetries: 3 } }).apiClient();
const subResult = (r) => r?.activity?.result?.createSubOrganizationResultV7 || r?.activity?.result?.createSubOrganizationResult || r || {};
const G = (s) => `\x1b[32m${s}\x1b[0m`, R = (s) => `\x1b[31m${s}\x1b[0m`;

if (!ORG || !PRIV) { console.log(R(`✗ ${P} not found in .env.keys`)); process.exit(1); }
console.log(`Validating ${P}  org ${ORG?.slice(0, 8)}…`);
const parent = clientFor(PUB, PRIV, ORG);
try {
  const who = await parent.getWhoami({ organizationId: ORG });
  console.log(`  ${G("✓")} authenticates · org "${who.organizationName}"`);
} catch (e) { console.log(`  ${R("✗")} whoami failed: ${String(e?.message).slice(0, 160)}`); process.exit(1); }

const rk = generateP256KeyPair();
const created = await parent.createSubOrganization({
  subOrganizationName: `keycheck-${Date.now().toString(36)}`,
  rootUsers: [{ userName: "root", apiKeys: [{ apiKeyName: "root", publicKey: rk.publicKey, curveType: "API_KEY_CURVE_P256" }], authenticators: [], oauthProviders: [] }],
  rootQuorumThreshold: 1,
  wallet: { walletName: "w", accounts: [{ curve: "CURVE_SECP256K1", pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/60'/0'/0/0", addressFormat: "ADDRESS_FORMAT_ETHEREUM" }] },
});
const subOrgId = subResult(created).subOrganizationId, address = subResult(created).wallet?.addresses?.[0];
console.log(`  ${G("✓")} createSubOrganization · ${subOrgId?.slice(0, 8)}…`);
const root = clientFor(rk.publicKey, rk.privateKey, subOrgId);
let lastErr = null;
for (let i = 0; i < 6; i++) {
  try {
    await root.signRawPayload({ organizationId: subOrgId, signWith: address, payload: "0x" + "ab".repeat(32), encoding: "PAYLOAD_ENCODING_HEXADECIMAL", hashFunction: "HASH_FUNCTION_NO_OP" });
    console.log(`  ${G("✓ signRawPayload SUCCEEDED — this org HAS signing credits ✅")}`);
    process.exit(0);
  } catch (e) {
    lastErr = e;
    if (/quota|resource exhausted|signing is disabled/i.test(String(e?.message))) break; // quota won't fix with retry
    await new Promise((r) => setTimeout(r, 2500)); // sub-org propagation lag — retry
  }
}
const quota = /quota|resource exhausted|signing is disabled/i.test(String(lastErr?.message));
console.log(`  ${R("✗")} signRawPayload failed${quota ? " (OVER QUOTA)" : ""}: ${String(lastErr?.message).slice(0, 200)}`);
process.exit(2);
