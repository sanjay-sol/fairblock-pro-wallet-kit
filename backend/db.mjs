// Tiny JSON-file "database" for the enterprise dashboard.
//
// This is intentionally a flat file (data/db.json) so the whole demo is
// self-contained and inspectable. In production this layer would be swapped for
// Postgres/Mongo — every access goes through the small API below, so only this
// file changes.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "data", "db.json");

const DEFAULTS = () => ({
  org: {
    name: "Organization",
    image: null,
    defaultDelivery: "confidential", // 'confidential' | 'direct'
    defaultNetwork: "all",
    createdAt: new Date().toISOString(),
  },
  owner: null, // { name, email, address }
  treasury: null, // { subOrgId, address, label, email }
  // Every treasury sub-org we've created, keyed for cross-device email sign-in.
  // A NEW device (that never saw the passkey) looks its wallet up here by email,
  // then does Turnkey email-OTP against that sub-org. [{ subOrgId, address, label, email, createdAt }]
  wallets: [],
  team: [], // [{ id, name, email, role, address, status, invitedAt }]
  recipients: [], // address book: [{ id, label, address, addedAt }]
  transactions: [], // full audit trail (see server for shape)
});

let _db = null;

function load() {
  if (_db) return _db;
  try {
    _db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    // shallow-merge new default keys onto older files
    _db = { ...DEFAULTS(), ..._db };
  } catch {
    _db = DEFAULTS();
    persist();
  }
  return _db;
}

let _timer = null;
function persist() {
  clearTimeout(_timer);
  _timer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(_db, null, 2));
  }, 50);
}
function persistNow() {
  clearTimeout(_timer);
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(_db, null, 2));
}

export const db = {
  get: () => load(),
  save: () => {
    persist();
    return _db;
  },
  saveNow: () => {
    persistNow();
    return _db;
  },
  reset: () => {
    _db = DEFAULTS();
    persistNow();
    return _db;
  },
};

// Monotonic-ish id without Date.now()/Math.random dependence issues in tests.
let _seq = 0;
export function newId(prefix = "id") {
  _seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${_seq.toString(36)}`;
}
