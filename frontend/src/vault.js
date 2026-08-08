// Encrypted-at-rest persistence so a page reload does NOT force re-unlock /
// re-derive within the session window (improvement 2, done securely).
//
// WHAT is persisted: the Turnkey read-write SESSION key (chain-independent) and
// the per-chain ElGamal keys. WHY it's safe:
//   • Everything is encrypted with an AES-GCM key that is generated NON-EXTRACTABLE
//     in WebCrypto and kept as a CryptoKey object in IndexedDB. Page script can use
//     it to decrypt in-place but can NEVER export the raw key, so an attacker who
//     dumps localStorage/IndexedDB can't decrypt the vault offline.
//   • The vault lifetime is bound to the Turnkey session expiry: once the session
//     lapses, loadVault() returns null and we wipe it → fresh auth required.
//
// Threat model note: a live XSS with code-exec on the page can still USE the AES
// key (and thus the session) during its window — that is inherent to any browser
// wallet. The stronger option (non-extractable *signing* keys via IndexedDbStamper
// + Turnkey login sessions) is a documented follow-up; it requires reworking the
// auth path to the JWT-session flow.

const DB_NAME = "fbp-vault";
const STORE = "kv";
const AES_ID = "aes-master";
const VAULT_ID = "vault";

function idb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no IndexedDB"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    tx.onsuccess = () => resolve(tx.result);
    tx.onerror = () => reject(tx.error);
  });
}
function idbPut(db, key, val) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite").objectStore(STORE).put(val, key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
function idbDel(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite").objectStore(STORE).delete(key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Get (or lazily create) the non-extractable AES-GCM master key.
async function masterKey(db) {
  const existing = await idbGet(db, AES_ID);
  if (existing) return existing; // a CryptoKey object survives in IndexedDB
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, /* extractable */ false, [
    "encrypt",
    "decrypt",
  ]);
  await idbPut(db, AES_ID, key);
  return key;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// Persist a plain object (encrypted). Returns true on success, false if
// persistence is unavailable (private mode, no WebCrypto, etc.) — callers treat
// persistence as best-effort and never depend on it for correctness.
export async function saveVault(obj) {
  try {
    const db = await idb();
    const key = await masterKey(db);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj)));
    await idbPut(db, VAULT_ID, { iv: Array.from(iv), ct: Array.from(new Uint8Array(ct)) });
    return true;
  } catch {
    return false;
  }
}

// Load + decrypt the vault. Returns null if absent, unreadable, or (when
// `notExpired` is given) past expiry — and wipes it in the expired case.
export async function loadVault() {
  try {
    const db = await idb();
    const rec = await idbGet(db, VAULT_ID);
    if (!rec?.ct) return null;
    const key = await masterKey(db);
    const iv = new Uint8Array(rec.iv);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, new Uint8Array(rec.ct));
    return JSON.parse(dec.decode(pt));
  } catch {
    return null;
  }
}

export async function clearVault() {
  try {
    const db = await idb();
    await idbDel(db, VAULT_ID);
  } catch {
    /* ignore */
  }
}
