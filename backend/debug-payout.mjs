import { initStore, store } from "./store.mjs";
import { initTurnkey, getActivity } from "./turnkey.mjs";
initStore(); initTurnkey();
const idx = await store.emailIndexGet("sanjaysirangi@gmail.com");
console.log("treasury subOrg:", idx?.subOrgId);
const t = await store.getTreasury(idx.subOrgId);
const payouts = await store.listPayouts(idx.subOrgId);
console.log("stored payouts:", payouts.map((p) => ({ id: p.id, status: p.status, activityId: p.activityId?.slice(0, 8), fingerprint: p.fingerprint })));
for (const p of payouts.filter((p) => p.status === "pending" && p.activityId)) {
  const a = await getActivity({ rootKey: t.rootKey, activityId: p.activityId });
  console.log("\nactivity", p.activityId?.slice(0, 8), "top-level keys:", Object.keys(a).join(", "));
  console.log("  status     :", a.status);
  console.log("  fingerprint:", a.fingerprint);
  console.log("  canApprove :", a.canApprove);
  console.log("  votes      :", JSON.stringify(a.votes)?.slice(0, 400));
}
process.exit(0);
