// ─────────────────────────────────────────────────────────────────────────────
// SPIKE: validate Turnkey multi-sig for a confidential treasury, at the signature
// layer (no chain / no funds needed). Proves the three make-or-break claims:
//
//   1. SPEND is 2-of-3: a transaction submitted by one admin sits in
//      CONSENSUS_NEEDED and only produces a signature after a 2nd admin approves.
//   2. READ is 1-of-3: signing a raw payload (the Fairblock ElGamal-key derivation /
//      balance-decrypt path) completes with a SINGLE admin — so any admin can view
//      confidential amounts without full quorum.
//   3. No single-admin spend: one approval is provably insufficient to move funds.
//
// It also demonstrates the sharp edge to design around: because the read gate keys
// off SIGN_RAW_PAYLOAD, an EIP-2612 *permit* (also a raw payload) would inherit the
// 1-of-3 gate → a lone admin could authorise a pull. (Reported at the end.)
//
// Model: one sub-org = one treasury. 1 root-admin (management) + 3 non-root signer
// users (the co-sign admins). Policies enforce the gates on the non-root users.
// ─────────────────────────────────────────────────────────────────────────────
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { Turnkey } from "@turnkey/sdk-server";
import { generateP256KeyPair } from "@turnkey/crypto";
import { ethers } from "ethers";

const { TURNKEY_ORG_ID, TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY } = process.env;
const apiBaseUrl = process.env.TURNKEY_API_BASE_URL || "https://api.turnkey.com";

const log = (...a) => console.log(...a);
const hr = () => log("─".repeat(72));
const ok = (m) => log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => log(`  \x1b[31m✗\x1b[0m ${m}`);

const clientFor = (kp, orgId) =>
  new Turnkey({ apiBaseUrl, apiPublicKey: kp.publicKey, apiPrivateKey: kp.privateKey, defaultOrganizationId: orgId }).apiClient();

const apiKeyOf = (kp) => ({ apiKeyName: `${kp.name}-key`, publicKey: kp.publicKey, curveType: "API_KEY_CURVE_P256" });
const gen = (name) => { const k = generateP256KeyPair(); return { name, publicKey: k.publicKey, privateKey: k.privateKey }; };

// createSubOrganization result lives under a versioned key; be tolerant of the version.
const subResult = (r) =>
  r?.activity?.result?.createSubOrganizationResultV7 ||
  r?.activity?.result?.createSubOrganizationResultV6 ||
  r?.activity?.result?.createSubOrganizationResult || r || {};

let failures = 0;
const assert = (cond, msg) => { if (cond) ok(msg); else { bad(msg); failures++; } };

try {
  const parent = clientFor({ publicKey: TURNKEY_API_PUBLIC_KEY, privateKey: TURNKEY_API_PRIVATE_KEY }, TURNKEY_ORG_ID);

  const rootAdmin = gen("root-admin");
  const signers = [gen("signer-1"), gen("signer-2"), gen("signer-3")];

  hr();
  log("STEP 1 — create the treasury sub-org (1 root-admin + an Ethereum wallet)");
  const created = await parent.createSubOrganization({
    subOrganizationName: `cosign-spike-${Date.now().toString(36)}`,
    rootUsers: [{ userName: rootAdmin.name, apiKeys: [apiKeyOf(rootAdmin)], authenticators: [], oauthProviders: [] }],
    rootQuorumThreshold: 1,
    wallet: {
      walletName: "Treasury",
      accounts: [{ curve: "CURVE_SECP256K1", pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/60'/0'/0/0", addressFormat: "ADDRESS_FORMAT_ETHEREUM" }],
    },
  });
  const sr = subResult(created);
  const subOrgId = sr.subOrganizationId;
  const treasury = sr.wallet?.addresses?.[0];
  if (!subOrgId || !treasury) { log("  raw:", JSON.stringify(created).slice(0, 500)); throw new Error("could not read subOrgId/treasury from result"); }
  log(`  subOrgId : ${subOrgId}`);
  log(`  treasury : ${treasury}`);

  const root = clientFor(rootAdmin, subOrgId);

  hr();
  log("STEP 2 — add the 3 co-sign admins as NON-root users");
  await root.createUsers({
    organizationId: subOrgId,
    users: signers.map((s) => ({ userName: s.name, apiKeys: [apiKeyOf(s)], authenticators: [], oauthProviders: [], userTags: [] })),
  });
  ok(`added ${signers.map((s) => s.name).join(", ")}`);

  hr();
  log("STEP 3 — set policies:  SPEND = 2-of-3 (sign tx)   READ = 1-of-3 (sign raw payload)");
  await root.createPolicy({ organizationId: subOrgId, policyName: "SPEND 2-of-3 (sign transaction)", effect: "EFFECT_ALLOW", consensus: "approvers.count() >= 2", condition: "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2'", notes: "spike" });
  await root.createPolicy({ organizationId: subOrgId, policyName: "READ 1-of-3 (sign raw payload)", effect: "EFFECT_ALLOW", consensus: "approvers.count() >= 1", condition: "activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2'", notes: "spike" });
  // Non-root users must also be permitted to cast an approval vote.
  await root.createPolicy({ organizationId: subOrgId, policyName: "allow approvals", effect: "EFFECT_ALLOW", consensus: "approvers.count() >= 1", condition: "activity.type == 'ACTIVITY_TYPE_APPROVE_ACTIVITY'", notes: "spike" });
  ok("policies created");

  const [c1, c2] = [clientFor(signers[0], subOrgId), clientFor(signers[1], subOrgId)];

  // Persist non-secret state for inspection (keys stay out — file is gitignored anyway).
  writeFileSync(new URL("./.spike-state.json", import.meta.url), JSON.stringify({ subOrgId, treasury, signers: signers.map((s) => s.name) }, null, 2));

  hr();
  log("TEST 1 — READ (ElGamal-derive analog): one admin signs a raw payload → should COMPLETE");
  const raw = await c1.signRawPayload({
    organizationId: subOrgId, signWith: treasury,
    payload: "0x" + "ab".repeat(32), encoding: "PAYLOAD_ENCODING_HEXADECIMAL", hashFunction: "HASH_FUNCTION_NO_OP",
  });
  const rawStatus = raw.activity?.status;
  const rawSig = raw.activity?.result?.signRawPayloadResult;
  log(`  status after 1 admin: ${rawStatus}`);
  assert(rawStatus === "ACTIVITY_STATUS_COMPLETED" && !!rawSig?.r, "1-of-3 read works — a single admin can derive keys / view amounts");

  hr();
  log("TEST 2 — SPEND: one admin submits a transaction → should be CONSENSUS_NEEDED (not signed)");
  const unsigned = ethers.Transaction.from({
    to: "0x000000000000000000000000000000000000dEaD", value: 0n, nonce: 0,
    gasLimit: 21000n, maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 1000000000n, chainId: 84532, type: 2,
  }).unsignedSerialized;
  const tx = await c1.signTransaction({
    organizationId: subOrgId, signWith: treasury, unsignedTransaction: unsigned.slice(2), type: "TRANSACTION_TYPE_ETHEREUM",
  });
  const pendStatus = tx.activity?.status;
  const activityId = tx.activity?.id;
  const fingerprint = tx.activity?.fingerprint;
  log(`  status after 1 admin: ${pendStatus}   activityId=${activityId?.slice(0, 8)}…`);
  assert(pendStatus === "ACTIVITY_STATUS_CONSENSUS_NEEDED", "1 approval is NOT enough to move funds (no signature yet)");

  hr();
  log("TEST 3 — a 2nd admin approves → the SAME transaction should COMPLETE with a signature");
  await c2.approveActivity({ organizationId: subOrgId, fingerprint });
  const final = await c1.getActivity({ organizationId: subOrgId, activityId });
  const finalStatus = final.activity?.status;
  const signedTx = final.activity?.result?.signTransactionResult?.signedTransaction;
  log(`  status after 2 admins: ${finalStatus}`);
  log(`  signedTransaction    : ${signedTx ? signedTx.slice(0, 26) + "…" : "(none)"}`);
  assert(finalStatus === "ACTIVITY_STATUS_COMPLETED" && !!signedTx, "2-of-3 approval produced a signature");

  // Prove the signature is REAL and broadcastable: the signed tx must recover to the treasury.
  let recovered = null;
  try { recovered = ethers.Transaction.from((signedTx.startsWith("0x") ? "" : "0x") + signedTx).from; } catch { /* ignore */ }
  assert(recovered && recovered.toLowerCase() === treasury.toLowerCase(), `signature recovers to the treasury address (${recovered || "?"}) — it's a valid on-chain payout`);

  hr();
  if (failures === 0) {
    log("\x1b[32m✅ SPIKE PASSED\x1b[0m — Turnkey natively supports 2-of-3 spend + 1-of-3 read on one shared treasury sub-org.");
    log("   → the pending/approve flow maps directly to your Pending Payouts screen (who signed / your turn to sign).");
  } else {
    log(`\x1b[31m❌ ${failures} check(s) failed\x1b[0m`);
  }
  log("");
  log("⚠ DESIGN NOTE (the sharp edge): the READ gate keys off SIGN_RAW_PAYLOAD, so an EIP-2612");
  log("  permit (also a raw payload) would inherit the 1-of-3 gate — a lone admin could authorise a");
  log("  token pull. Mitigation in the real build: restrict raw-payload signing to the exact ElGamal");
  log("  derivation message, and/or disable permit. Flagged for the Fairblock-SDK integration.");
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  bad(`spike error: ${e?.message || e}`);
  if (e?.cause) log("  cause:", JSON.stringify(e.cause).slice(0, 400));
  process.exit(1);
}
