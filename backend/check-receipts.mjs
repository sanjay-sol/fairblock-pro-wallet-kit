import { initStore, store } from "./store.mjs";
import { ethers } from "ethers";
initStore();
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL, Number(process.env.CHAIN_ID));
const idx = await store.emailIndexGet("sanjaysirangi@gmail.com");
const payouts = await store.listPayouts(idx.subOrgId);
console.log(`treasury ${idx.subOrgId} · ${payouts.length} payouts\n`);
for (const p of payouts) {
  if (!p.txHash) { console.log(`${(p.status || "?").padEnd(10)} ${p.kind.padEnd(9)} (no tx hash)`); continue; }
  const rc = await provider.getTransactionReceipt(p.txHash).catch(() => null);
  const onchain = rc ? (rc.status === 1 ? "SUCCESS ✓" : "REVERTED ✗") : "not found / pending";
  let fixed = "";
  if (rc && rc.status === 1 && p.status !== "completed") { await store.updatePayout(idx.subOrgId, p.id, { status: "completed", error: null }); fixed = "  → reconciled to completed"; }
  else if (rc && rc.status === 0 && p.status !== "failed") { await store.updatePayout(idx.subOrgId, p.id, { status: "failed" }); fixed = "  → reconciled to failed"; }
  console.log(`${(p.status || "?").padEnd(10)} ${p.kind.padEnd(9)} ${p.txHash.slice(0, 14)}… → on-chain: ${onchain}${fixed}`);
}
process.exit(0);
