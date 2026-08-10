# Team, real DB (Firestore) & email invites — setup + design

Goal: replace the local `db.json` with a real **Firestore** database, send **real invite
emails** (via GCP/SendGrid, or Gmail for a quick live test) that carry the **role/privileges**
we choose, and store the real mapping of users ↔ orgs ↔ team members ↔ roles ↔ sub-orgs.

This doc is the setup guide + design. Once you produce the credentials in **Part 5**, I'll wire
it up end to end and we test it live.

## Status — BUILT & LIVE-TESTED (2026-08-10)
Firestore (project `fairblock-pro-wallet-kit`) + Gmail SMTP are wired and **validated live**. The
full backend pipeline passes end to end: create org/owner → **invite (a real email is sent)** →
pending-invite listing → **accept (member activated)** → **RBAC 403** for a stranger →
wrong-token / wrong-email rejection. The frontend builds, onboarding is intact, and the new
`/accept` page renders. The only piece left is the **UI round-trip that needs a Turnkey login**
(the owner clicking Invite while signed in; the invitee signing in on `/accept`) — the backend for
both is proven; we'll click through it once the Turnkey signature quota is topped up.

Files added: `backend/store.mjs` (Firestore + memory), `backend/mailer.mjs`, rewritten
`backend/server.mjs`; `frontend/src/pages/AcceptInvite.jsx`; wired `api.js` / `OrgContext.jsx` /
`Team.jsx` / `App.jsx`.

---

## Part 0 — Scope (two stages)

The request has two natural stages; I'll do **Stage 1** first (that's the "invites + real DB +
real email, working end to end" you described), then **Stage 2**.

- **Stage 1 (this pass):** Firestore replaces `db.json`; Owner/Admin invites a member with a
  **role** from the Team page → a real email goes out with a secure accept link → invitee signs
  in and is recorded in the DB as a member with that role. Full data model + RBAC on the backend.
- **Stage 2 (next):** the full *member login experience* — a member signs in and the app renders
  their role's UI (e.g. a Member can only submit payout **requests**; the Owner approves & signs).
  This is a bigger frontend change; I'll flag exactly what it touches.

Nothing is thrown away between stages — Stage 1 lays the DB + roles Stage 2 builds on.

---

## Part 1 — Roles & privileges (what each role can do)

The treasury is a single Turnkey sub-org controlled by the **Owner's** key, so **on-chain
signing is Owner-only** today. Everyone else operates through an app-layer **request → approve**
workflow (approver ≠ signer is a normal treasury pattern). Multi-signer (Admins co-signing via
Turnkey policies) is a later upgrade — noted below.

| Capability | Owner | Admin | Member | Viewer |
|---|:---:|:---:|:---:|:---:|
| View balances, history, analytics | ✅ | ✅ | ✅ | ✅ |
| Create a payout **request** (→ Pending) | ✅ | ✅ | ✅ | — |
| Add recipients (address book) | ✅ | ✅ | ✅ | — |
| Edit/remove recipients | ✅ | ✅ | — | — |
| **Approve / reject** pending requests | ✅ | ✅ | — | — |
| **Sign & send** on-chain (holds treasury key) | ✅ | —¹ | — | — |
| Deposit / withdraw / derive keys | ✅ | —¹ | — | — |
| Invite / remove members, set roles | ✅ | ✅² | — | — |
| Edit org settings | ✅ | ✅ | — | — |
| Delete / disconnect the treasury | ✅ | — | — | — |

¹ On-chain actions need the treasury key. In the single-owner model only the Owner signs; an
Admin's **approval** authorizes a request, and it settles when an on-chain signer (the Owner
today; Admin co-signers once we add Turnkey policies) executes it.
² An Admin can only invite/manage roles **at or below Admin** (can't create another Owner).

**Plain-English summary**
- **Owner** — the treasury creator. Holds the wallet, signs everything, full control. Exactly one.
- **Admin** — trusted operator: runs the team, recipients, settings, and approves requests. Can't
  unilaterally move funds (no key) until we enable Turnkey co-signers.
- **Member** — submits payout **requests** for approval + manages recipients. Can't approve/send.
- **Viewer** — read-only (auditor/accountant).

---

## Part 2 — Firestore data model

Access is **server-side only** via the Firebase Admin SDK (the backend), so security rules can
stay locked — the Admin SDK bypasses them and our backend enforces RBAC.

```
orgs/{orgId}
  name, ownerUid, ownerEmail, treasuryAddress, treasurySubOrgId,
  defaultDelivery, defaultNetwork, createdAt, updatedAt

orgs/{orgId}/members/{memberId}
  email (lowercased), name, role: "owner"|"admin"|"member"|"viewer",
  status: "invited"|"active"|"removed",
  uid, subOrgId,               // filled when they accept + sign in
  invitedBy, invitedAt, acceptedAt

orgs/{orgId}/invites/{inviteId}
  email, role, tokenHash,      // sha256(token); the raw token only ever goes in the email link
  status: "pending"|"accepted"|"revoked"|"expired",
  invitedBy, invitedByEmail, createdAt, expiresAt (7 days), acceptedAt

orgs/{orgId}/recipients/{recipientId}
  label, address, addedBy, addedAt

orgs/{orgId}/transactions/{txId}
  kind, status, to, recipientLabel, amountEnc (client-encrypted — never plaintext),
  tokenSymbol, token, delivery, network, chainId, txHash, explorerUrl, batchId,
  createdBy, createdByRole, approvedBy, approvedAt, note, error, createdAt

users/{uid}
  email, name, subOrgId, authMethods[], createdAt, lastLoginAt
```

**Relationships**
- One **org** ⇄ one Owner + many **members** (each with a role) + its **invites**, **recipients**,
  **transactions**.
- A **user** (by email) can belong to several orgs — found with a Firestore *collection-group*
  query on `members where email == …` (so on login we know "who is this + what can they do").
- An **invite** carries the role; on accept it becomes/updates a **member** (role + uid + subOrgId).
- Amounts stay **client-encrypted** (`amountEnc`) exactly as today — Firestore never sees plaintext.

---

## Part 3 — Firebase setup (your personal account, ~5 min)

1. Go to **https://console.firebase.google.com** → **Add project** → name it e.g.
   `stabletrust-pro-dev` → you can **disable** Google Analytics → **Create project**.
2. Left nav → **Build → Firestore Database** → **Create database** → **Start in production mode**
   (locked is fine — we use the Admin SDK) → pick a location (e.g. `nam5 (us-central)`) → **Enable**.
3. Gear icon → **Project settings** → **Service accounts** tab → **Node.js** → **Generate new
   private key** → **Generate key** → it downloads a JSON like
   `stabletrust-pro-dev-firebase-adminsdk-xxxxx.json`.
4. Rename it to **`serviceAccount.json`** and drop it in **`fairblock-pro-wallet-kit/backend/`**.
   (It's a **secret** — it'll be gitignored; never commit it.)

That's all Firebase needs. No client-side Firebase config — the browser never talks to Firestore,
only our backend does.

---

## Part 4 — Email setup

GCP note (since you asked): **GCP has no native transactional-email API**, and Compute
Engine / Cloud Run **block outbound SMTP ports** (25/465/587) to stop spam. Google's documented
answer is a partner API — **SendGrid** (also on GCP Marketplace), Mailgun, or Mailjet — called
over **HTTPS**. So "email on GCP" = SendGrid's HTTP API. For a 5-minute live test today you can
use **Gmail** instead (works from your local backend). The code supports both; pick per env.

### Option A — Gmail App Password (fastest, for testing today)
1. Your Google account → **Security** → turn on **2-Step Verification** (required).
2. Then **Security → App passwords** (https://myaccount.google.com/apppasswords) → create one,
   name it "Stabletrust backend" → copy the **16-character** password.
3. Add to `backend/.env`:
   ```
   MAIL_FROM="Stabletrust Pro <youremail@gmail.com>"
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_SECURE=true
   SMTP_USER=youremail@gmail.com
   SMTP_PASS=your16charapppassword
   ```
   Limits ~500/day; fine for testing (first few may hit spam — mark "not spam").

### Option B — SendGrid (production, GCP-aligned)
1. **https://sendgrid.com** → sign up (free tier 100 emails/day) — or GCP Console → **Marketplace**
   → search **SendGrid** → subscribe (links a SendGrid account).
2. **Settings → Sender Authentication → Verify a Single Sender** (your from-email). For real
   deliverability later, verify a **domain** instead (adds DKIM/SPF DNS records).
3. **Settings → API Keys → Create API Key** → *Restricted → Mail Send* → copy `SG.xxxxx`.
4. Add to `backend/.env`:
   ```
   MAIL_FROM="Stabletrust Pro <verified-sender@yourdomain.com>"
   SENDGRID_API_KEY=SG.xxxxxxxxxxxxxxxx
   ```
   Sent via `@sendgrid/mail` (HTTPS) — works from GCP with no port issues.

**The email module auto-selects:** if `SENDGRID_API_KEY` is set → SendGrid (HTTP); else if
`SMTP_*` is set → Gmail/SMTP; else it logs the invite link to the console (dev fallback, so
nothing breaks before you configure email).

---

## Part 5 — Credentials checklist (what I need from you)

All go in **gitignored** files under `fairblock-pro-wallet-kit/backend/` — never committed, and I
never store secrets in notes.

1. **`backend/serviceAccount.json`** — the Firebase Admin key from Part 3.
2. **`backend/.env`** additions:
   ```
   DB_BACKEND=firestore
   APP_URL=http://localhost:5176        # base for invite links
   # email — Option A (Gmail) OR Option B (SendGrid):
   MAIL_FROM="Stabletrust Pro <you@gmail.com>"
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_SECURE=true
   SMTP_USER=you@gmail.com
   SMTP_PASS=xxxxxxxxxxxxxxxx
   # (or) SENDGRID_API_KEY=SG.xxxx
   ```

Tell me which email option you did, drop those two files in, and I'll build + test live.

---

## Part 6 — Invite → accept flow (how it works end to end)

1. Owner/Admin (signed in) → **Team → Invite** → email + role → `POST /api/invites`
   (backend checks the caller is owner/admin) → creates an invite (random token, stores only its
   hash, 7-day expiry) → emails the invitee a link: `${APP_URL}/accept?token=…`.
2. Invitee opens the link → the app's **Accept invite** view shows "You've been invited as
   `<role>`" → they sign in with that email (email OTP → their own Turnkey sub-org) →
   `POST /api/invites/accept` with the token → backend verifies token+email+not-expired → creates
   the **member** (role, uid, subOrgId, status=active); invite → accepted.
3. They're now a member with that role (Stage 2 renders their role-scoped UI).

**Security:** invites expire; only the token *hash* is stored; accept requires the signed-in email
to match the invite; role changes require owner/admin; every mutating route re-checks the caller's
role server-side (never trust the client).

---

## Migration & safety
- The backend gets a pluggable store: `DB_BACKEND=firestore` uses Firestore; unset/`file` keeps the
  JSON store — so nothing breaks if credentials aren't present yet.
- New backend deps: `firebase-admin`, `nodemailer`, and (optional) `@sendgrid/mail`.
- `serviceAccount.json` + `.env` are gitignored. I don't commit or push (you do).
