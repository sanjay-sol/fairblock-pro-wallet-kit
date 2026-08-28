// One-off migration (gitignored `_*.mjs`): after the diamond REDEPLOY, existing treasuries'
// Turnkey FUND policy still lists the OLD diamonds, so createConfidentialAccount + deposit to a
// NEW diamond fall through to the SPEND (N-of-M) policy → PENDING_CONSENSUS at threshold>1
// (derive-keys / deposit break on multi-sig treasuries). This adds a FUND policy covering the
// CURRENT diamond set to every treasury, restoring the intended 1-of-M for fund-neutral ops.
//
//   cd backend && node _migrate-fund-policy.mjs
//
// Idempotent: skips a treasury that already has the redeploy FUND policy.
import "dotenv/config";
import { initStore, store, storeMode } from "./store.mjs";
import { initTurnkey, addFundPolicy, listPolicies } from "./turnkey.mjs";
import { allDiamonds } from "./chains.mjs";

initStore();
console.log("store:", storeMode());
if (!initTurnkey()) { console.error("✗ Turnkey not configured (check backend/.env)"); process.exit(1); }
console.log("current diamonds:", allDiamonds().join(", "));

const treasuries = await store.listTreasuries();
console.log(`found ${treasuries.length} treasuries\n`);

let fixed = 0, skipped = 0, failed = 0;
for (const t of treasuries) {
  const label = `${String(t.id || "").slice(0, 10)}… "${t.name || ""}" ${t.ownerEmail || ""} (${t.threshold || 1}-of-N)`;
  const rk = t.rootKey;
  if (!rk?.privateKey || !rk?.publicKey) { console.log("• skip (no rootKey):", label); skipped++; continue; }
  const rootKey = { publicKey: rk.publicKey, privateKey: rk.privateKey, subOrgId: rk.subOrgId || t.id };
  try {
    let already = false;
    try {
      const pols = await listPolicies({ rootKey });
      already = pols.some((p) => (p.policyName || "").includes("redeploy") || p.notes === "modelb-fund-redeploy");
    } catch { /* getPolicies unavailable — just create (harmless) */ }
    if (already) { console.log("• already migrated:", label); skipped++; continue; }
    const pid = await addFundPolicy({ rootKey });
    console.log("✓ added FUND(redeploy):", pid, "→", label);
    fixed++;
  } catch (e) {
    console.error("✗ FAILED:", label, "—", e?.message || e);
    failed++;
  }
}
console.log(`\nDONE — fixed ${fixed}, skipped ${skipped}, failed ${failed}`);
process.exit(failed ? 1 : 0);
