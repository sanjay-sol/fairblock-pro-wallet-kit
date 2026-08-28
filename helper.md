# Stabletrust Pro — Operations Helper

A practical runbook for this repo: what we changed, how to run/deploy it safely, how to
manage env vars, and every pending task with exact steps so you can do them yourself.

> Everything here is specific to **this** deployment. Copy/paste the commands as-is.

---

## 0. Key facts (fill-in-the-blanks for every command)

| Thing | Value |
| --- | --- |
| GCP project | `custom-mile-457400-e4` |
| Region | `us-central1` |
| Cloud Run service (backend) | `stabletrust-pro-backend` |
| Backend URL | `https://stabletrust-pro-backend-606823284932.us-central1.run.app` |
| Runtime service account | `stabletrust-backend-sa@custom-mile-457400-e4.iam.gserviceaccount.com` |
| Billing account | `0139BB-99CC87-6E4726` |
| Current live revision | `stabletrust-pro-backend-00012-zgk` (rate limiting) |
| Frontend | Vercel — `https://pro.stabletrust.io` + `https://fairblock-pro-wallet-kit.vercel.app` |
| DB | Firestore (project `fairblock-pro-wallet-kit` via the runtime SA / local `serviceAccount.json`) |
| Turnkey parent org | `8007c548…` (env `TURNKEY_ORG_ID`) — 500-signature credit cap (see Pending) |
| Local Node | v22.23.1 (nvm) — `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"` |
| gcloud | `/opt/homebrew/bin/gcloud` |

**Golden rule:** production config lives in the **Cloud Run service** (env vars + Secret Manager),
NOT in files. `backend/.env` and `backend/serviceAccount.json` are **git-ignored AND
`.gcloudignore`-excluded**, so they never ship. Changing a file does nothing to prod until you
deploy or update the service.

---

## 1. Architecture in one minute

- **Backend** (`backend/`, Node + Express) → Cloud Run. Manages Turnkey sub-orgs, relays OTP/OAuth,
  records payouts in Firestore, executes approved payouts on-chain. NOT git-connected — you deploy it
  manually with `gcloud`.
- **Frontend** (`frontend/`, React + Vite) → Vercel, **git-connected** (auto-deploys on push to the
  connected branch). Talks to the backend over HTTPS. All `VITE_*` vars are baked in at build time.
- **Auth:** members sign in (email OTP or Google) → backend mints an HMAC **session token** → the
  browser sends `Authorization: Bearer <token>` on every call. The backend verifies it (see §6).

---

## 2. Run it locally

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"

# Backend (reads backend/.env, serves on http://localhost:8792)
cd backend
node server.mjs           # or: npm run dev   (node --watch, restarts on file save)

# Frontend (new terminal) — opens on http://localhost:5176 (see the URL Vite prints)
cd frontend
npm run dev
```

- Local backend config = `backend/.env`. Local frontend points at the backend via
  `VITE_BACKEND_URL` (defaults to `http://localhost:8792`).
- Local uses **your** Firebase via `backend/serviceAccount.json` (project `fairblock-pro-wallet-kit`).
- Health check while running: `curl http://localhost:8792/api/config`

---

## 3. Deploy the BACKEND (code changes)

Use this whenever you change anything under `backend/` (`.mjs`, `package.json`, `Dockerfile`).

```bash
export PATH="/opt/homebrew/bin:$PATH"
cd /Users/sanjaysirangi/Desktop/fairblock_local/fairblock-pro-wallet-kit

gcloud run deploy stabletrust-pro-backend \
  --source backend/ \
  --region=us-central1 \
  --project=custom-mile-457400-e4 \
  --quiet
```

What this does, and why it's safe:
- Rebuilds the container from `backend/Dockerfile` (`npm ci --omit=dev` installs deps fresh, so any
  new dependency in `package.json` is picked up — `node_modules` is NOT uploaded).
- **Preserves all existing env vars and secrets** (it only touches the image). Verified.
- Deploys as a NEW revision and shifts 100% traffic to it. If the new revision fails to start, Cloud
  Run keeps serving the OLD one — a bad deploy can't take you down.
- `.env` / `serviceAccount.json` are excluded from the upload (`.gcloudignore`).

### Pre-flight (recommended before every deploy)
```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"; cd backend
node --check server.mjs && echo OK          # syntax-check the entry file
npm ci --omit=dev --dry-run                  # confirm package.json + lock are in sync
```

### After deploy — verify prod
```bash
export PATH="/opt/homebrew/bin:$PATH"
URL=https://stabletrust-pro-backend-606823284932.us-central1.run.app
curl -s -o /dev/null -w '%{http_code}\n' $URL/api/config         # want 200
curl -s -o /dev/null -w '%{http_code}\n' $URL/api/treasury       # want 401 (auth works)
```

### View logs
```bash
gcloud run services logs read stabletrust-pro-backend \
  --region=us-central1 --project=custom-mile-457400-e4 --limit=50
```

### Roll back to a previous revision (instant, no rebuild)
```bash
# list revisions (newest first)
gcloud run revisions list --service=stabletrust-pro-backend \
  --region=us-central1 --project=custom-mile-457400-e4

# send 100% traffic back to a known-good one
gcloud run services update-traffic stabletrust-pro-backend \
  --region=us-central1 --project=custom-mile-457400-e4 \
  --to-revisions=stabletrust-pro-backend-00011-8bw=100
```

---

## 4. Deploy the FRONTEND

The frontend is git-connected to Vercel, so:
```bash
git add -A && git commit -m "..." && git push        # → Vercel auto-builds & deploys
```
- `VITE_*` env vars are **build-time**. If you add/change one, set it in **Vercel → Project →
  Settings → Environment Variables**, then trigger a redeploy (push or "Redeploy" in Vercel).
- `VITE_BACKEND_URL` on Vercel must point at the prod backend URL.
- **Pending:** `VITE_GOOGLE_CLIENT_ID` still needs adding in Vercel for the "Continue with Google"
  button to work in prod (value: `79984203938-grkcikcebs9l9ll4ti1mdjb3gvbib7ca.apps.googleusercontent.com`).

---

## 5. Managing ENV VARS (the part with the footgun)

The service's env vars are the live prod config. Two ways to change them:
- **Console:** Cloud Run → `stabletrust-pro-backend` → *Edit & Deploy New Revision → Variables & Secrets*.
- **CLI:** `gcloud run services update …` (below). This makes a new revision **without rebuilding** (fast).

### Current env vars (plain, unless noted)
| Group | Vars |
| --- | --- |
| App | `APP_NAME`, `APP_URL`, `FRONTEND_ORIGIN`, `DB_BACKEND`, `SDK_API_BASE_URL` |
| RPC | `RPC_84532` (Alchemy Base Sepolia) |
| Turnkey | `TURNKEY_API_BASE_URL`, `TURNKEY_ORG_ID`, `TURNKEY_AUTH_PROXY_CONFIG_ID`, `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY` |
| Email | `MAIL_FROM`, `SENDGRID_API_KEY`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` |
| Session tokens | `SESSION_SECRET` — **Secret Manager-backed** (secret `session-secret`), not plain |

### Add or update a simple value
```bash
gcloud run services update stabletrust-pro-backend \
  --region=us-central1 --project=custom-mile-457400-e4 \
  --update-env-vars=MAIL_FROM=no-reply@stabletrust.io
```

### ⚠️ Update a value that CONTAINS COMMAS (e.g. FRONTEND_ORIGIN)
`gcloud` uses commas to separate one env var from the next. To keep commas **inside** a value, put
`^@^` at the front — it switches the separator to `@`:
```bash
gcloud run services update stabletrust-pro-backend \
  --region=us-central1 --project=custom-mile-457400-e4 \
  --update-env-vars=^@^FRONTEND_ORIGIN=https://pro.stabletrust.io,https://fairblock-pro-wallet-kit.vercel.app,https://new-domain.com
```
(If you forget `^@^`, gcloud will try to read `https://…vercel.app` as a *second* env var and fail.)

### Delete env var(s)
```bash
# one
gcloud run services update stabletrust-pro-backend \
  --region=us-central1 --project=custom-mile-457400-e4 \
  --remove-env-vars=SOME_KEY

# several (comma-separated KEYS is fine here — these are names, not values)
gcloud run services update stabletrust-pro-backend \
  --region=us-central1 --project=custom-mile-457400-e4 \
  --remove-env-vars=SMTP_HOST,SMTP_PORT,SMTP_SECURE,SMTP_USER,SMTP_PASS
```

### See what's currently set (values shown for plain vars)
```bash
gcloud run services describe stabletrust-pro-backend \
  --region=us-central1 --project=custom-mile-457400-e4 \
  --format="value(spec.template.spec.containers[0].env[].name)"
```

> `--update-env-vars` / `--remove-env-vars` are **merges** — they only touch the keys you name and
> leave everything else alone. NEVER use `--set-env-vars` on this service: it **replaces the whole
> set** and would wipe Turnkey/RPC/email config.

### Secret-backed vars (recommended for sensitive values)
`SESSION_SECRET` is stored in Secret Manager (secret `session-secret`) instead of plain text. To do
the same for another value:
```bash
# 1. create the secret (value piped in, never printed). Skip if the secret already exists.
printf 'THE_SECRET_VALUE' | gcloud secrets create my-secret \
  --data-file=- --replication-policy=automatic --project=custom-mile-457400-e4

# 2. let the runtime SA read ONLY this secret
gcloud secrets add-iam-policy-binding my-secret \
  --member="serviceAccount:stabletrust-backend-sa@custom-mile-457400-e4.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" --project=custom-mile-457400-e4

# 3. point the env var at the secret.
#    - If MY_ENV_VAR does NOT already exist as a plain var: this alone is enough.
#    - If it DOES exist as a plain var (e.g. converting TURNKEY_API_PRIVATE_KEY): remove the plain
#      one in the SAME command so there is never a revision missing the value:
gcloud run services update stabletrust-pro-backend \
  --region=us-central1 --project=custom-mile-457400-e4 \
  --remove-env-vars=MY_ENV_VAR \
  --update-secrets=MY_ENV_VAR=my-secret:latest
```
To rotate a secret later: `gcloud secrets versions add my-secret --data-file=-` then redeploy/update
(the service reads `:latest` at instance start, so it picks up the new version on the next revision).

---

## 6. What we changed (security hardening changelog)

All three are **done and deployed**. Funds were never at risk in any of these — every payout still
needs the N-of-M Turnkey signatures.

### P0 — removed an unauthenticated DB-wipe  *(done, rev …-00010)*
`POST /api/admin/reset` had no auth and erased the entire Firestore DB. Deleted the route and the
underlying `store.reset()` in `backend/server.mjs` + `backend/store.mjs`.

### P1-b — session tokens (real authentication)  *(done, rev …-00011)*
Before, the backend trusted `x-caller-email` / `x-org-id` headers — anyone could impersonate a member.
Now `backend/token.mjs` mints an **HMAC-signed** token bound to `{subOrgId, email, role, exp}` at
sign-in; `ctx()` verifies it and derives identity from the token (membership/role are still a live DB
lookup). Frontend sends `Authorization: Bearer`. Prod secret = `session-secret` in Secret Manager.
- Verify the old attack is dead:
  ```bash
  curl -i -H 'x-org-id: x' -H 'x-caller-email: a@b.com' \
    https://stabletrust-pro-backend-606823284932.us-central1.run.app/api/treasury   # → 401
  ```

### P1-a — rate limiting  *(done, rev …-00012)*
`backend/ratelimit.mjs` (express-rate-limit) + `app.set('trust proxy', 1)`:
| Scope | Key | Limit |
| --- | --- | --- |
| everything (flood net) | IP | 600 / min |
| `/api/auth/init` | IP / email | 10 / 15 min each |
| `/api/auth/verify` | IP | 20 / 15 min |
| `/api/auth/oauth` (+create) | IP | 20 / 15 min |
| `POST /api/treasury` | IP | 10 / hour |
| all org creation | global | 100 / hour |
| all logged-in routes | token identity | 240 / min |

### Re-run the verification scripts (saved in the scratchpad)
```bash
bash /private/tmp/claude-501/-Users-sanjaysirangi-Desktop-fairblock-local/2d95a2d2-a53d-48ec-8e2b-7080abb27023/scratchpad/spoof-test.sh
bash /private/tmp/claude-501/-Users-sanjaysirangi-Desktop-fairblock-local/2d95a2d2-a53d-48ec-8e2b-7080abb27023/scratchpad/ratelimit-test.sh
```
(These hit `localhost:8792`, so start the backend locally first. The scratchpad is session-temporary —
if it's gone, the tests are easy to recreate; the assertions are documented in memory.)

---

## 7. PENDING WORK — how to do each one yourself

### 7.1 Turnkey — move off the credit cap (billing)
**Why:** the parent org `8007c548…` is on a limited credit (topped to 500 signatures). Every payout
signature, session mint, and management action burns credits; when they run out, signing fails with
"allotted quota / signing is disabled" (the app shows a friendly version of this). Sessions don't
reduce the per-signature cost.
**How:**
1. Sign in to the Turnkey dashboard (`https://app.turnkey.com`) with the account that owns org `8007c548…`.
2. Open that organization → **Billing / Plan** (settings area). Add a payment method / upgrade from the
   free credit tier to a paid plan. For production volume, Turnkey usually wants you to talk to them —
   use the "contact / upgrade" option in the dashboard.
3. No code or env change is needed to lift the cap — it's tied to the same org. If you instead switch
   to a **different** Turnkey org/API key, you must update `TURNKEY_ORG_ID`, `TURNKEY_API_PUBLIC_KEY`,
   and `TURNKEY_API_PRIVATE_KEY` (§5) and redeploy. Existing treasuries were created under the current
   org, so prefer upgrading the current org over switching.

### 7.2 SendGrid — domain authentication (fix email deliverability)
**Why:** prod sends email via SendGrid, but `MAIL_FROM` is a `@gmail.com` address. You can't
legitimately send "as gmail.com" through SendGrid, so those emails get spam-filtered or rejected.
Authenticating your own domain (`stabletrust.io`) fixes deliverability.
**How:**
1. SendGrid dashboard → **Settings → Sender Authentication → Authenticate Your Domain**.
2. Pick your DNS host and enter `stabletrust.io`. SendGrid gives you a set of **CNAME** records
   (DKIM + link branding).
3. Add those CNAMEs at your domain's DNS provider (wherever `stabletrust.io` is managed).
4. Back in SendGrid, click **Verify**. (DNS can take up to a few hours to propagate.)
5. Change the sender to your authenticated domain and redeploy the env:
   ```bash
   gcloud run services update stabletrust-pro-backend \
     --region=us-central1 --project=custom-mile-457400-e4 \
     --update-env-vars=MAIL_FROM=no-reply@stabletrust.io
   ```
   Optionally also verify a single sender address in SendGrid if you want a specific reply-to.

### 7.3 Changing email or Turnkey settings (general)
These are plain env vars, so no rebuild — just update the service and it rolls a new revision:
```bash
# email transport examples
gcloud run services update stabletrust-pro-backend --region=us-central1 --project=custom-mile-457400-e4 \
  --update-env-vars=SENDGRID_API_KEY=SG.new_key_here
gcloud run services update stabletrust-pro-backend --region=us-central1 --project=custom-mile-457400-e4 \
  --update-env-vars=MAIL_FROM=no-reply@stabletrust.io

# Turnkey key rotation (all three usually change together)
gcloud run services update stabletrust-pro-backend --region=us-central1 --project=custom-mile-457400-e4 \
  --update-env-vars=TURNKEY_ORG_ID=...,TURNKEY_API_PUBLIC_KEY=...,TURNKEY_API_PRIVATE_KEY=...
```
> The mailer auto-detects transport: if `SENDGRID_API_KEY` is set it uses SendGrid; else if `SMTP_*`
> is set it uses SMTP; else it just logs to console. To force SMTP, remove `SENDGRID_API_KEY`
> (`--remove-env-vars=SENDGRID_API_KEY`).
>
> **Better (optional):** `TURNKEY_API_PRIVATE_KEY`, `SMTP_PASS`, `SENDGRID_API_KEY` are currently
> **plain** env vars, but matching Secret Manager secrets already exist (`turnkey-api-private-key`,
> `smtp-pass`, `sendgrid-api-key`). You can wire them in with §5's secret steps. ⚠️ **First confirm the
> secret's value equals the current working value** — `gcloud secrets versions access latest
> --secret=turnkey-api-private-key --project=custom-mile-457400-e4` — or you'll break signing/email.

### 7.4 Cloud Run — max instances (P1-c) + why we waited
**Why:** today `maxScale=1` — a spike beyond ~80 concurrent requests can overwhelm the single
instance. Raising it gives autoscale headroom. We did **rate limiting first** on purpose (otherwise
more instances just means a flood costs more instead of being blocked).
```bash
gcloud run services update stabletrust-pro-backend \
  --region=us-central1 --project=custom-mile-457400-e4 \
  --max-instances=3 --min-instances=1
```
**Multi-instance caveats (all low-impact for this app — reviewed in detail):**
- Firestore is the shared source of truth, so data stays consistent.
- The payout executor is **idempotent** across instances (re-broadcasting the same signed tx is
  swallowed), so concurrent execution is safe.
- Cosmetic: batch-approval emails may send up to N times (in-memory dedup is per-instance); rate-limit
  counters are per-instance so the effective limit becomes ~N× the numbers.
- One real-but-pre-existing race: **nonce reservation** isn't atomic, so two admins proposing on the
  same treasury at the same instant can collide → one payout fails and must be re-proposed (never a
  double-spend; the on-chain nonce rule guards it). This already exists at `maxScale=1` because
  `concurrency=80`. The proper fix is a Firestore-transaction nonce counter (§7.6). Start with
  `--max-instances=3`; do §7.6 before heavy concurrent multi-admin load.
- Keep `DB_BACKEND=firestore` — the in-memory fallback would give each instance a different DB.

### 7.5 Billing alerts (spend smoke-detector)
**Important:** a GCP budget **alerts**, it does not **cap**. Google never auto-stops spending. Your
real cost ceilings are `--max-instances` (bounds compute) + rate limiting (bounds load); the budget
just emails you early.

**Easiest — Console:** Billing → **Budgets & alerts** → *Create budget* → scope to project
`custom-mile-457400-e4` → amount (e.g. $50/mo) → thresholds 50% / 90% / 100% → pick email recipients.

**CLI:** first enable the API (one-time), then create it:
```bash
gcloud services enable billingbudgets.googleapis.com --project=custom-mile-457400-e4

gcloud billing budgets create \
  --billing-account=0139BB-99CC87-6E4726 \
  --display-name="stabletrust-pro monthly" \
  --filter-projects="projects/custom-mile-457400-e4" \
  --budget-amount=50USD \
  --threshold-rule=percent=0.5 \
  --threshold-rule=percent=0.9 \
  --threshold-rule=percent=1.0 \
  --threshold-rule=percent=1.0,basis=forecasted
```
Needs the `billing.budgets.create` permission on the billing account. `basis=forecasted` warns you
mid-month if you're *trending* over. Tune the amount to sit comfortably above normal spend (a testnet
here is usually a few dollars/month).

### 7.6 Nonce reservation — make it atomic (reliability, recommended before scaling load)
Small, self-contained backend change: replace the "read max nonce, add 1" logic in `/api/nonce`,
`/api/claim`, `/api/allowance` with a Firestore **transaction** on a per-treasury-per-chain counter
doc, so two concurrent proposals can never get the same nonce. Fixes the race for any number of
instances AND improves reliability today. Ask me to implement when ready.

### 7.7 Later backlog (from the security review)
- **P2-a — Lock the Alchemy RPC key** (dashboard task): the RPC key ships to browsers via `/api/config`
  (unavoidable — the SDK reads chain state client-side). In the Alchemy dashboard, restrict the key to
  Base Sepolia + your domains and set a usage alert. Doesn't fully hide it (a backend RPC proxy would),
  but stops casual reuse.
- **P2-b — Firestore read caching:** cache the treasury doc + member list in backend memory with a
  short TTL to cut Firestore reads from the polling loop. (Per-instance cache; fine at this scale.)
- **P3 — Edge/DDoS + key-at-rest:** Cloud Armor in front of Cloud Run for real DDoS protection; move
  the remaining plain secrets to Secret Manager / KMS (see §7.3 note).

---

## 8. Cheat sheet

```bash
# --- setup every shell ---
export PATH="/opt/homebrew/bin:$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
PROJECT=custom-mile-457400-e4 ; REGION=us-central1 ; SVC=stabletrust-pro-backend

# run locally
cd backend && node server.mjs            # backend  :8792
cd frontend && npm run dev               # frontend :5176

# deploy backend (code change)
cd /Users/sanjaysirangi/Desktop/fairblock_local/fairblock-pro-wallet-kit
gcloud run deploy $SVC --source backend/ --region=$REGION --project=$PROJECT --quiet

# env: add/update / delete / list
gcloud run services update $SVC --region=$REGION --project=$PROJECT --update-env-vars=KEY=value
gcloud run services update $SVC --region=$REGION --project=$PROJECT --update-env-vars=^@^KEY=val,with,commas
gcloud run services update $SVC --region=$REGION --project=$PROJECT --remove-env-vars=KEY1,KEY2
gcloud run services describe $SVC --region=$REGION --project=$PROJECT --format="value(spec.template.spec.containers[0].env[].name)"

# logs / revisions / rollback
gcloud run services logs read $SVC --region=$REGION --project=$PROJECT --limit=50
gcloud run revisions list --service=$SVC --region=$REGION --project=$PROJECT
gcloud run services update-traffic $SVC --region=$REGION --project=$PROJECT --to-revisions=<REVISION>=100

# scale (P1-c)
gcloud run services update $SVC --region=$REGION --project=$PROJECT --max-instances=3 --min-instances=1

# frontend
git push        # → Vercel auto-deploys
```

_Last updated: 2026-08-18 (after P1-a rate limiting deploy, rev …-00012)._
