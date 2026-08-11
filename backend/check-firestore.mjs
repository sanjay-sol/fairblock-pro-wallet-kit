// One-shot probe: is the Firebase/Firestore daily quota available again?
// Does a SINGLE minimal read (limit 1) and reports quota state. Independent of DB_BACKEND.
import { existsSync, readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const svcUrl = new URL("./serviceAccount.json", import.meta.url);
if (!existsSync(svcUrl)) { console.log("✗ no serviceAccount.json in backend/"); process.exit(1); }
if (!getApps().length) initializeApp({ credential: cert(JSON.parse(readFileSync(svcUrl))) });
const fs = getFirestore();

try {
  const snap = await fs.collection("treasuries").limit(1).get();
  console.log(`✓ Firestore READ OK — quota is AVAILABLE again. (treasuries docs seen: ${snap.size})`);
  process.exit(0);
} catch (e) {
  const quota = /RESOURCE_EXHAUSTED|quota/i.test(String(e?.message || e));
  console.log(`✗ Firestore read failed${quota ? " — STILL OVER DAILY QUOTA" : ""}: ${String(e?.message || e).slice(0, 160)}`);
  process.exit(quota ? 2 : 1);
}
