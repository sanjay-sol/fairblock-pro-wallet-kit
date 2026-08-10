// Decisive routing check for Model B auth: if the backend creates a shared treasury
// sub-org and registers a user's EMAIL in it, can that email be resolved back to the
// sub-org? (getSubOrgIds = backend routing; the Auth-Proxy lookup = wallet-kit routing.)
// No OTP email is sent here — createSubOrganization + list_suborgs don't deliver mail.
import { Turnkey } from "@turnkey/sdk-server";

const { TURNKEY_ORG_ID, TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, TURNKEY_AUTH_PROXY_CONFIG_ID } = process.env;
const apiBaseUrl = process.env.TURNKEY_API_BASE_URL || "https://api.turnkey.com";
const parent = new Turnkey({ apiBaseUrl, apiPublicKey: TURNKEY_API_PUBLIC_KEY, apiPrivateKey: TURNKEY_API_PRIVATE_KEY, defaultOrganizationId: TURNKEY_ORG_ID }).apiClient();
const subResult = (r) => r?.activity?.result?.createSubOrganizationResultV7 || r?.activity?.result?.createSubOrganizationResult || r || {};
const email = `modelb-routing-${Date.now().toString(36)}@example.com`;

console.log("1) create a shared sub-org with an OWNER email (OTP-auth enabled by default)");
let created;
try {
  created = await parent.createSubOrganization({
    subOrganizationName: `authcheck-${Date.now().toString(36)}`,
    rootUsers: [{ userName: "owner", userEmail: email, apiKeys: [], authenticators: [], oauthProviders: [] }],
    rootQuorumThreshold: 1,
    wallet: { walletName: "Treasury", accounts: [{ curve: "CURVE_SECP256K1", pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/60'/0'/0/0", addressFormat: "ADDRESS_FORMAT_ETHEREUM" }] },
  });
} catch (e) {
  console.log("   email-only root user rejected → retrying with a placeholder API key + email:", e?.message?.slice(0, 120));
  const { generateP256KeyPair } = await import("@turnkey/crypto");
  const k = generateP256KeyPair();
  created = await parent.createSubOrganization({
    subOrganizationName: `authcheck-${Date.now().toString(36)}`,
    rootUsers: [{ userName: "owner", userEmail: email, apiKeys: [{ apiKeyName: "boot", publicKey: k.publicKey, curveType: "API_KEY_CURVE_P256" }], authenticators: [], oauthProviders: [] }],
    rootQuorumThreshold: 1,
    wallet: { walletName: "Treasury", accounts: [{ curve: "CURVE_SECP256K1", pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/60'/0'/0/0", addressFormat: "ADDRESS_FORMAT_ETHEREUM" }] },
  });
}
const subOrgId = subResult(created).subOrganizationId;
console.log("   created sub-org:", subOrgId, "for", email);

console.log("2) getSubOrgIds by EMAIL (backend routing — Path 2)");
const byEmail = await parent.getSubOrgIds({ organizationId: TURNKEY_ORG_ID, filterType: "EMAIL", filterValue: email });
console.log("   →", JSON.stringify(byEmail), byEmail.organizationIds?.includes(subOrgId) ? "✓ resolves to the sub-org" : "✗ did NOT resolve");

console.log("3) Auth-Proxy account lookup by email (wallet-kit routing — Path 1)");
try {
  const r = await fetch("https://authproxy.turnkey.com/v1/account", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Auth-Proxy-Config-ID": TURNKEY_AUTH_PROXY_CONFIG_ID },
    body: JSON.stringify({ filterType: "EMAIL", filterValue: email }),
  });
  console.log("   status", r.status, "→", (await r.text()).slice(0, 300));
} catch (e) {
  console.log("   auth-proxy lookup error:", e?.message);
}
