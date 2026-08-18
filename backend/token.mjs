// ─────────────────────────────────────────────────────────────────────────────
// Session tokens (Model B) — authenticate WHO the caller is, without trusting a header.
//
// Before this, the backend read the caller's identity straight off two request headers
// (x-org-id + x-caller-email). Those are attacker-controlled: anyone could send someone
// else's email + a treasury's subOrgId and be treated as that member (read the team,
// reject payouts, remove members, burn gas via claim/allowance…). Funds were always safe
// (moving them out still needs the N-of-M Turnkey co-sign, which an attacker can't forge),
// but the metadata + management surface was wide open.
//
// The fix: at sign-in (OTP verify / OAuth) we mint a compact token that is HMAC-signed with
// a server-only secret and bound to { subOrgId, email, role, exp }. The client sends it back
// as `Authorization: Bearer <token>`, and ctx() re-derives identity from the VERIFIED token
// instead of the header. A forged/edited token fails the signature check → 401.
//
// The token AUTHENTICATES (proves the caller is `email` in `subOrgId`). AUTHORIZATION stays a
// LIVE DB lookup in ctx() (membership + role) — so a removed member's still-valid token is
// rejected the moment they're gone from the members list, and a role change takes effect
// immediately. The token's `role` is bound for defense-in-depth/logging, never the authority.
//
// Format (JWT-like but dependency-free): base64url(payload) + "." + base64url(HMAC-SHA256).
// Exactly two segments. Stateless: no server-side session store to keep or scale.
// ─────────────────────────────────────────────────────────────────────────────
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

// The signing secret. MUST be set + STABLE in production (Cloud Run env / Secret Manager):
//   • a per-instance random secret would reject tokens minted by a different instance, so
//     with >1 instance (maxScale) logins would randomly 401;
//   • it would also invalidate every session on each restart/redeploy.
// For local dev with no secret set we generate an ephemeral one and warn loudly — good enough
// to develop against (sessions just don't survive a backend restart).
let SECRET = process.env.SESSION_SECRET || "";
if (!SECRET) {
  SECRET = randomBytes(32).toString("hex");
  console.warn("[token] SESSION_SECRET is not set — using an EPHEMERAL secret. Sessions won't survive a restart and WILL break across multiple instances. Set SESSION_SECRET in production.");
} else if (SECRET.length < 16) {
  console.warn("[token] SESSION_SECRET is very short — use at least 32 random bytes (e.g. `openssl rand -hex 32`).");
}

export const TOKEN_TTL_SECONDS = 43200; // 12h — matches the Turnkey session lifetime (sessionSeconds)

const b64urlJson = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const hmac = (data) => createHmac("sha256", SECRET).update(data).digest(); // Buffer

// Mint a signed token bound to the caller's identity. `ttlSeconds` defaults to the 12h session.
export function signToken({ subOrgId, email, role, ttlSeconds = TOKEN_TTL_SECONDS }) {
  if (!subOrgId || !email) throw new Error("signToken: subOrgId and email are required");
  const iat = Math.floor(Date.now() / 1000);
  const payload = { sub: subOrgId, email: String(email).toLowerCase(), role: role || null, iat, exp: iat + ttlSeconds };
  const body = b64urlJson(payload);
  return `${body}.${Buffer.from(hmac(body)).toString("base64url")}`;
}

// Verify signature + expiry and return the payload, or null if anything is off
// (malformed, tampered, wrong secret, or expired). Constant-time signature compare.
export function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!sig || sig.includes(".")) return null; // exactly two segments — reject a 3-part JWT etc.
  let expected, got;
  try {
    expected = hmac(body);                    // Buffer (32 bytes)
    got = Buffer.from(sig, "base64url");        // Buffer
  } catch { return null; }
  // timingSafeEqual throws on a length mismatch — guard first, then constant-time compare.
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (!payload || typeof payload !== "object" || !payload.sub || !payload.email) return null;
  if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null; // expired
  return payload; // { sub, email, role, iat, exp }
}

// Pull the bearer token out of the Authorization header ("Bearer <token>").
export function bearerOf(req) {
  const h = String(req.headers["authorization"] || "");
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}
