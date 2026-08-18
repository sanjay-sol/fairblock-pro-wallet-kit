// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting (Model B) — protects against floods, OTP-bombing, junk-org spam, and the
// runaway-cost paths (Turnkey quota + email + Firestore/RPC reads). No limits existed before.
//
// A limiter counts requests PER KEY inside a rolling window. The KEY decides the scope:
//   • keyed by IP        → per device/network        (logged-out traffic)
//   • keyed by identity  → per signed-in user        (logged-in traffic; from the Bearer token)
//   • keyed by a constant→ ONE bucket for everyone    (a deliberate global cap)
//
// Behind Cloud Run the real client IP is in X-Forwarded-For, so server.mjs sets
// `trust proxy` — without it every caller looks like one IP and a per-IP limit would
// accidentally become global. Counters are in-memory PER INSTANCE (fine at ~1 instance;
// with maxScale>1 the effective limit is N×instances — a shared store would be the upgrade).
// OPTIONS (CORS preflight) is never counted.
// ─────────────────────────────────────────────────────────────────────────────
import { rateLimit, ipKeyGenerator, MINUTE, HOUR } from "express-rate-limit";
import { verifyToken, bearerOf } from "./token.mjs";

const skipPreflight = (req) => req.method === "OPTIONS";

// Shared factory: consistent JSON 429 body ({error, code:"RATE_LIMITED"}) so the frontend's
// api.js surfaces a friendly message, plus a warn log that prints the keyed IP — that makes a
// false-positive on a shared office/VPN IP easy to spot and confirms trust-proxy resolves the
// real client IP (not Google's front-end). `keyGenerator` undefined → the library default
// (client IP, IPv6-safe).
function make({ label, windowMs, limit, keyGenerator, skip, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    skip: skip || skipPreflight,
    message: { error: message, code: "RATE_LIMITED" },
    handler: (req, res, _next, options) => {
      console.warn(`[ratelimit] 429 ${label} ${req.method} ${req.originalUrl} ip=${req.ip}`);
      res.status(429).json(options.message);
    },
  });
}

// ── Layer 0: loose catch-all on ALL requests, per IP. Backstops the otherwise-unlimited
//    cheap public endpoints (/api/config, /healthz, /api/requests). Deliberately loose so a
//    small office/VPN sharing one IP is never hit; still catches a real flood. Tunable.
export const globalIpLimiter = make({
  label: "global-ip", windowMs: MINUTE, limit: 600,
  message: "Too many requests — please slow down and try again shortly.",
});

// ── Layer 1: strict limits on the LOGGED-OUT endpoints (the abusable ones) ──
// Email a sign-in code: cap per IP (one person retrying) AND per target email (stop bombing
// one victim from many IPs). The handler 404s an unknown email before Turnkey, but the limiter
// runs first regardless, so it also caps enumeration.
export const authInitIpLimiter = make({
  label: "auth-init-ip", windowMs: 15 * MINUTE, limit: 10,
  message: "Too many sign-in code requests — wait a few minutes and try again.",
});
export const authInitEmailLimiter = make({
  label: "auth-init-email", windowMs: 15 * MINUTE, limit: 10,
  keyGenerator: (req) => String(req.body?.email || "").trim().toLowerCase() || ipKeyGenerator(req.ip),
  skip: (req) => req.method === "OPTIONS" || !req.body?.email,
  message: "Too many sign-in codes requested for this email — wait a few minutes and try again.",
});
// Verify an OTP code: cap code-guessing per IP (Turnkey also expires/limits codes).
export const authVerifyLimiter = make({
  label: "auth-verify-ip", windowMs: 15 * MINUTE, limit: 20,
  message: "Too many code attempts — wait a few minutes and try again.",
});
// Google sign-in (login + create): each needs a fresh verified Google token, but createSubOrg is costly.
export const oauthLimiter = make({
  label: "oauth-ip", windowMs: 15 * MINUTE, limit: 20,
  message: "Too many Google sign-in attempts — wait a few minutes and try again.",
});
// Create a treasury (email path): createSubOrg burns Turnkey quota; legit use is once per org.
export const createOrgIpLimiter = make({
  label: "create-org-ip", windowMs: HOUR, limit: 10,
  message: "Too many organizations created from here — please try again later.",
});

// ── Layer 2: GLOBAL backstop on ALL org creation across the whole app (email + Google-create
//    paths). A constant key → ONE shared bucket, on purpose: a hard ceiling on Turnkey sub-org
//    creation no matter the source.
export const orgCreationGlobalLimiter = make({
  label: "org-create-global", windowMs: HOUR, limit: 100,
  keyGenerator: () => "org-creation",
  message: "The service is creating organizations too quickly right now — please try again shortly.",
});

// ── Layer 3: LOGGED-IN traffic, keyed PER IDENTITY (subOrgId:email from the verified token;
//    falls back to IP if a token is somehow present but invalid). Generous — a runaway/abuse
//    backstop sized well above heavy multi-tab polling + a large batch, so it never bites
//    legitimate use but stops a thousands-per-minute loop or a hijacked session.
export const authedLimiter = make({
  label: "authed-identity", windowMs: MINUTE, limit: 240,
  keyGenerator: (req) => {
    const c = verifyToken(bearerOf(req));
    return c ? `id:${c.sub}:${c.email}` : ipKeyGenerator(req.ip);
  },
  message: "You're doing that too quickly — wait a moment and try again.",
});
