// ─────────────────────────────────────────────────────────────────────────────
// Model B client session. Auth is our own OTP relay (not wallet-kit): the client
// generates an ephemeral P-256 key, the backend runs otpAuth targeting the treasury
// sub-org and returns an HPKE-encrypted credentialBundle, we decrypt it to the session
// API key and drive a TurnkeyClient (ApiKeyStamper) that stamps proposals/approvals
// directly against Turnkey — non-custodial. The session is scoped to the signed-in
// admin's user inside the shared treasury sub-org.
// ─────────────────────────────────────────────────────────────────────────────
import { generateP256KeyPair, decryptCredentialBundle, getPublicKey } from "@turnkey/crypto";
import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import { TurnkeyClient } from "@turnkey/http";

const SKEY = "fbp-mb-session";
const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");

let _session = null; // { subOrgId, address, email, role, name, threshold, chainId, token, sessionPublicKey, sessionPrivateKey, expiry, baseUrl }
let _client = null;

export const getSession = () => _session;
export const getClient = () => _client;
export const sessionActive = () => !!_session && _session.expiry > Date.now();

function buildClient(sess) {
  const stamper = new ApiKeyStamper({ apiPublicKey: sess.sessionPublicKey, apiPrivateKey: sess.sessionPrivateKey });
  return new TurnkeyClient({ baseUrl: sess.baseUrl }, stamper);
}

// Step 1 (before OTP verify): the ephemeral target key. Send publicKeyUncompressed to the backend.
export function newTargetKey() {
  const eph = generateP256KeyPair();
  return { targetPublicKey: eph.publicKeyUncompressed, ephemeralPrivateKey: eph.privateKey };
}

// Step 2 (after backend returns credentialBundle): decrypt → session key → client → persist.
export function establishSession({ credentialBundle, ephemeralPrivateKey, subOrgId, address, email, role, name, threshold, memberCount, chainId, token, baseUrl, sessionSeconds = 43200 }) {
  const sessionPrivateKey = decryptCredentialBundle(credentialBundle, ephemeralPrivateKey);
  const sessionPublicKey = toHex(getPublicKey(sessionPrivateKey, true)); // compressed hex
  _session = { subOrgId, address, email, role, name, threshold, memberCount, chainId, token, sessionPublicKey, sessionPrivateKey, baseUrl, expiry: Date.now() + sessionSeconds * 1000 };
  _client = buildClient(_session);
  try { localStorage.setItem(SKEY, JSON.stringify(_session)); } catch { /* ignore */ }
  return _session;
}

export function restoreSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SKEY) || "null");
    if (!s?.expiry || s.expiry < Date.now()) { clearSession(); return null; }
    // A session persisted before session tokens existed has no `token` → force a fresh sign-in
    // (every API call would 401 otherwise). New sessions always carry one.
    if (!s.token) { clearSession(); return null; }
    _session = s;
    _client = buildClient(s);
    return s;
  } catch { return null; }
}

export function patchSession(patch) {
  if (!_session) return null;
  _session = { ..._session, ...patch };
  try { localStorage.setItem(SKEY, JSON.stringify(_session)); } catch { /* ignore */ }
  return _session;
}

export function clearSession() {
  _session = null; _client = null;
  try { localStorage.removeItem(SKEY); } catch { /* ignore */ }
}
