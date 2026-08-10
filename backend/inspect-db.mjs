// Read-only dump of what's actually stored in Firestore.
//   node inspect-db.mjs           → summarise every org + invites
//   node inspect-db.mjs <orgId>   → just that org
// It never prints a plaintext amount (there shouldn't be any) — for each transaction it shows
// the encrypted blob's presence and loudly flags "⚠ PLAINTEXT" if a cleartext amount ever slipped in.
import { existsSync, readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const svcUrl = new URL("./serviceAccount.json", import.meta.url);
if (!existsSync(svcUrl)) {
  console.error("serviceAccount.json not found next to this script — is this the Firestore backend?");
  process.exit(1);
}
if (!getApps().length) initializeApp({ credential: cert(JSON.parse(readFileSync(svcUrl))) });
const db = getFirestore();

const onlyOrg = process.argv[2] || null;
const bar = "─".repeat(72);
const short = (s, n = 12) => (s ? String(s).slice(0, n) + "…" : "—");

function txLine(t) {
  const enc = t.amountEnc ? `enc(${short(t.amountEnc, 16)})` : "—";
  const plain = t.amount == null ? "null ✓" : `⚠ PLAINTEXT "${t.amount}"`;
  const hash = t.txHash ? ` · tx ${short(t.txHash, 10)}` : "";
  return `      • [${t.status}] ${t.kind} → ${short(t.to)} ${t.tokenSymbol || ""}  amount=${plain}  amountEnc=${enc}${hash}`;
}

async function dumpOrg(id) {
  const o = (await db.doc(`orgs/${id}`).get()).data() || {};
  console.log(bar);
  console.log(`ORG  ${id}`);
  console.log(`  name      ${o.org?.name || "—"}`);
  console.log(`  owner     ${o.owner?.name || "—"}  <${o.ownerEmail || o.owner?.email || "—"}>`);
  console.log(`  treasury  ${o.treasury?.address || "—"}`);
  for (const c of ["members", "recipients", "transactions"]) {
    const docs = (await db.collection(`orgs/${id}/${c}`).get()).docs;
    console.log(`  ${c} (${docs.length})`);
    for (const d of docs) {
      const v = d.data();
      if (c === "transactions") console.log(txLine(v));
      else if (c === "members") console.log(`      • ${v.email} — ${v.role} (${v.status})`);
      else console.log(`      • ${v.label || "?"} — ${v.address}`);
    }
  }
}

const orgIds = onlyOrg
  ? [onlyOrg]
  : (await db.collection("orgs").get()).docs.map((d) => d.id);

if (!orgIds.length) console.log("(no orgs stored yet)");
for (const id of orgIds) await dumpOrg(id);

if (!onlyOrg) {
  const inv = (await db.collection("invites").get()).docs;
  console.log(bar);
  console.log(`INVITES (${inv.length})  — only the token HASH is stored, never the raw token`);
  for (const d of inv) {
    const v = d.data();
    console.log(`  • ${v.email} as ${v.role} — ${v.status}  (org ${short(v.orgId, 10)}, tokenHash ${short(v.tokenHash, 10)})`);
  }
}
console.log(bar);
process.exit(0);
