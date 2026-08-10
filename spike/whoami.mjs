// Connectivity check: does the parent-org API key authenticate, and which org/user is it?
// Free call — no signing quota consumed.
import "dotenv/config";
import { Turnkey } from "@turnkey/sdk-server";

const {
  TURNKEY_API_BASE_URL = "https://api.turnkey.com",
  TURNKEY_ORG_ID,
  TURNKEY_API_PUBLIC_KEY,
  TURNKEY_API_PRIVATE_KEY,
} = process.env;

const turnkey = new Turnkey({
  apiBaseUrl: TURNKEY_API_BASE_URL,
  apiPublicKey: TURNKEY_API_PUBLIC_KEY,
  apiPrivateKey: TURNKEY_API_PRIVATE_KEY,
  defaultOrganizationId: TURNKEY_ORG_ID,
});

const client = turnkey.apiClient();
try {
  const who = await client.getWhoami({ organizationId: TURNKEY_ORG_ID });
  console.log("✓ API key authenticates.");
  console.log("  organizationId  :", who.organizationId);
  console.log("  organizationName:", who.organizationName);
  console.log("  userId          :", who.userId);
  console.log("  username        :", who.username);
} catch (e) {
  console.error("✗ whoami failed:", e?.message || e);
  process.exit(1);
}
