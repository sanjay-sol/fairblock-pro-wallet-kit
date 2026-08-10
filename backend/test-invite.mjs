// End-to-end test of the invite pipeline over HTTP — NO Turnkey / signing needed.
// Exercises: create org+owner → send invite (real email if SMTP is on) → list pending →
// RBAC (a stranger can't invite) → accept by token → wrong-token / wrong-email rejection.
//
//   node test-invite.mjs [inviteeEmail] [ownerEmail]
//
// If the backend's mailer is in SMTP/SendGrid mode, a REAL email is sent to inviteeEmail and
// the raw token isn't returned (by design) — so the accept step is skipped with a note to click
// the emailed link. To auto-test accept too, run the backend with email in console mode
// (unset SMTP_* / SENDGRID_API_KEY) so the token comes back in the response.
const BASE = process.env.BASE || "http://localhost:8792";
const INVITEE = process.argv[2] || "0xsanjay.sol+member@gmail.com";
const OWNER = process.argv[3] || "0xsanjay.sol@gmail.com";
const ORG = `test-suborg-${Date.now().toString(36)}`;        // a throwaway org id for this run
const STRANGER = "nobody@example.com";

const H = (email) => ({ "content-type": "application/json", "x-org-id": ORG, "x-caller-email": email });
async function call(method, path, email, body) {
  const r = await fetch(`${BASE}${path}`, { method, headers: H(email), body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}
const ok = (m) => console.log(`  ✓ ${m}`);
const info = (m) => console.log(`  · ${m}`);
let failed = false;
const must = (cond, m) => { if (cond) ok(m); else { failed = true; console.log(`  ✗ FAIL: ${m}`); } };

console.log(`\nInvite pipeline test → ${BASE}\n  org      ${ORG}\n  owner    ${OWNER}\n  invitee  ${INVITEE}\n`);

// 0. backend health + which mail mode is live
const health = await call("GET", "/healthz", OWNER);
info(`backend db=${health.j.dbMode} · mail=${health.j.mailMode}`);

// 1. create the org by establishing the owner (no role gate)
const owner = await call("POST", "/api/owner", OWNER, { name: "Sanjay (Owner)", email: OWNER, address: "0x1111111111111111111111111111111111111111" });
must(owner.status === 200 && owner.j.email === OWNER.toLowerCase(), `owner + org created (${OWNER})`);

// 2. RBAC: a stranger must NOT be able to invite
const strangerTry = await call("POST", "/api/invites", STRANGER, { email: "x@y.com", role: "member" });
must(strangerTry.status === 403, `stranger blocked from inviting (403)`);

// 3. owner sends the invite — REAL email if SMTP/SendGrid is configured
const inv = await call("POST", "/api/invites", OWNER, { name: "Invited Member", email: INVITEE, role: "member" });
must(inv.status === 200 && inv.j.invite?.id, `invite created for ${INVITEE} as member`);
info(`email transport: ${inv.j.emailed}` + (inv.j.emailed === "smtp" || inv.j.emailed === "sendgrid" ? "  → check the inbox!" : ""));

// 4. it shows up as a pending invite in the team list
const team = await call("GET", "/api/team", OWNER);
const pending = (team.j || []).find((t) => (t.email || "").toLowerCase() === INVITEE.toLowerCase() && t.status === "invited");
must(!!pending, `invite appears in team as "invited"`);

// 5. accept — only possible when the raw token is available (console mail mode returns acceptUrl)
const acceptUrl = inv.j.acceptUrl;
if (!acceptUrl) {
  info(`real email sent → raw token intentionally not returned. Click the link in the inbox to accept,`);
  info(`or re-run with the backend in console mail mode (unset SMTP_*) to auto-test accept.`);
} else {
  const u = new URL(acceptUrl);
  const inviteId = u.searchParams.get("invite");
  const token = u.searchParams.get("token");

  // 5a. wrong token is rejected
  const bad = await call("POST", "/api/invites/accept", INVITEE, { inviteId, token: "deadbeef", email: INVITEE });
  must(bad.status >= 400, `wrong token rejected`);

  // 5b. wrong email is rejected (right token, mismatched signer)
  const badEmail = await call("POST", "/api/invites/accept", "someoneelse@x.com", { inviteId, token, email: "someoneelse@x.com" });
  must(badEmail.status >= 400, `right token but wrong email rejected`);

  // 5c. correct token + email → member activated
  const acc = await call("POST", "/api/invites/accept", INVITEE, { inviteId, token, email: INVITEE, name: "Invited Member" });
  must(acc.status === 200 && acc.j.role === "member", `accepted → joined as member`);

  const team2 = await call("GET", "/api/team", OWNER);
  const active = (team2.j || []).find((t) => (t.email || "").toLowerCase() === INVITEE.toLowerCase() && t.status === "active");
  must(!!active, `invitee now an ACTIVE member`);
}

console.log(`\n${failed ? "❌ some checks failed" : "✅ all checks passed"}\n`);
process.exit(failed ? 1 : 0);
