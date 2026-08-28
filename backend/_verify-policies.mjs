// Read-only: dump the FUND policies of the "test" (2-of-3) treasury to confirm the
// redeploy policy's condition contains the NEW diamonds. Gitignored (_*.mjs).
import "dotenv/config";
import { initStore, store } from "./store.mjs";
import { initTurnkey, listPolicies } from "./turnkey.mjs";

initStore();
if (!initTurnkey()) { console.error("Turnkey not configured"); process.exit(1); }
const ts = await store.listTreasuries();
const t = ts.find((x) => x.name === "test") || ts[0];
const rk = t.rootKey;
const rootKey = { publicKey: rk.publicKey, privateKey: rk.privateKey, subOrgId: rk.subOrgId || t.id };
try {
  const pols = await listPolicies({ rootKey });
  console.log(`treasury "${t.name}" ${t.id} (threshold ${t.threshold}) — ${pols.length} policies:\n`);
  for (const p of pols) {
    console.log(`• ${p.policyName}  [${p.notes || "-"}]  consensus=${p.consensus}`);
    if (/FUND/i.test(p.policyName || "")) console.log(`    condition: ${p.condition}`);
  }
} catch (e) {
  console.error("listPolicies (getPolicies) failed:", e?.message || e);
  console.error("→ policies were still created (migration returned real IDs); retry derive-keys to confirm.");
}
process.exit(0);
