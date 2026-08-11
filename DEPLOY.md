# Deploy — Stabletrust Pro (Model B)

**Backend → Google Cloud Run · Frontend → Vercel · DB → Firestore.**

Deploy order matters: **backend first** (its URL is baked into the frontend at build time),
then frontend, then update the backend's CORS with the frontend URL.

> Values live in `backend/.env` (gitignored). Copy them into the commands below — the
> **private key + SMTP password go to Secret Manager**, everything else is a plain env var.
> Turnkey org ID / public key / config ID are non-secret and fine as env vars.

---

## Prerequisites
- `gcloud` CLI installed + `gcloud auth login`, and a GCP project (same one as your Firebase/Firestore).
- Firestore enabled (Native mode) on that project — **upgrade it to the Blaze plan** for prod.
- A Vercel account (dashboard or `vercel` CLI).
- Working Turnkey creds (currently Set 1, org `8007c548`).

```bash
export PROJECT_ID=your-gcp-project        # same project as Firestore
export REGION=us-central1                 # pick a region near your users
gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com firestore.googleapis.com
```

---

## Part A — Backend → Cloud Run

### A1. Dedicated service account + Firestore access
⚠️ In a SHARED project (yours also runs the fairycloak VMs), do NOT reuse the default Compute
Engine SA — your VMs run as that one, so granting it DB/secret access would expose those to
every VM. Give the backend its own isolated identity:
```bash
gcloud iam service-accounts create fairblock-backend-sa \
  --display-name="Fairblock treasury backend" --project="$PROJECT_ID"
export BACKEND_SA="fairblock-backend-sa@${PROJECT_ID}.iam.gserviceaccount.com"
```

**Option A (recommended) — Firestore in the SAME project → ADC, no JSON key.**
```bash
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${BACKEND_SA}" --role="roles/datastore.user"
```

**Option B — Firestore in a DIFFERENT project (e.g. personal Firebase) → mount its JSON key.**
Skip the datastore binding above; instead store the key as a secret (the KEY grants DB access):
```bash
gcloud secrets create firebase-sa --data-file=backend/serviceAccount.json
gcloud secrets add-iam-policy-binding firebase-sa \
  --member="serviceAccount:${BACKEND_SA}" --role="roles/secretmanager.secretAccessor"
```
…then in the **A3 deploy command, add** `/app/serviceAccount.json=firebase-sa:latest` to
`--set-secrets` (store.mjs finds the key there automatically).

### A2. Put the two secrets in Secret Manager (readable only by the backend SA)
```bash
# read straight from backend/.env — nothing printed
grep -E '^TURNKEY_API_PRIVATE_KEY=' backend/.env | cut -d= -f2- | tr -d '\r\n' | gcloud secrets create turnkey-api-private-key --data-file=-
grep -E '^SMTP_PASS=' backend/.env | cut -d= -f2- | tr -d '\r\n' | gcloud secrets create smtp-pass --data-file=-
for S in turnkey-api-private-key smtp-pass; do
  gcloud secrets add-iam-policy-binding "$S" \
    --member="serviceAccount:${BACKEND_SA}" --role="roles/secretmanager.secretAccessor"
done
```

### A3. Deploy (build from the Dockerfile in backend/) — AS the dedicated SA
`^##^` sets `##` as the delimiter so values with commas/spaces work. Fill in the values
from `backend/.env`. Leave `FRONTEND_ORIGIN`/`APP_URL` as a placeholder for now — you'll set
them in Part C once you have the Vercel URL. (If it errors on `actAs`, run
`gcloud iam service-accounts add-iam-policy-binding "$BACKEND_SA" --member="user:YOU@gmail.com" --role="roles/iam.serviceAccountUser"` and retry.)
```bash
gcloud run deploy fairblock-backend \
  --source backend/ --region="$REGION" --allow-unauthenticated \
  --service-account="$BACKEND_SA" \
  --max-instances=1 --min-instances=1 --timeout=300 --memory=512Mi \
  --set-secrets="TURNKEY_API_PRIVATE_KEY=turnkey-api-private-key:latest,SMTP_PASS=smtp-pass:latest" \
  --set-env-vars="^##^DB_BACKEND=firestore##APP_NAME=Stabletrust Pro##TURNKEY_API_BASE_URL=https://api.turnkey.com##TURNKEY_ORG_ID=PASTE_ORG_ID##TURNKEY_AUTH_PROXY_CONFIG_ID=PASTE_CONFIG_ID##TURNKEY_API_PUBLIC_KEY=PASTE_PUBLIC_KEY##SMTP_HOST=smtp.gmail.com##SMTP_PORT=465##SMTP_SECURE=true##SMTP_USER=PASTE_SMTP_USER##MAIL_FROM=Stabletrust Pro <PASTE_SMTP_USER>##SDK_API_BASE_URL=##FRONTEND_ORIGIN=https://TEMP.vercel.app##APP_URL=https://TEMP.vercel.app"
```
Copy the printed **Service URL** from the deploy output (e.g.
`https://<service>-<projectnumber>.us-central1.run.app`). ⚠️ Use **that** one — NOT
`gcloud run services describe … --format='value(status.url)'`, which can hand back a stale
legacy `.a.run.app` URL that 404s on everything.

**Verify with `/api/config`** (NOT `/healthz` — Google's front-end reserves the exact path
`/healthz` and returns its own 404 before it reaches your app):
```bash
curl -s "https://<service>-<projectnumber>.us-central1.run.app/api/config" | head -c 200
```
→ JSON starting `{"appName":"Stabletrust Pro","chains":[…` with `"dbMode":"firestore"` and
`"tkEnabled":true` further in. That's a fully working backend.

---

## Part B — Frontend → Vercel
1. Import the repo in Vercel → set **Root Directory = `frontend`** (framework auto-detects as Vite).
2. Add an env var: **`VITE_BACKEND_URL` = the Cloud Run Service URL from Part A**.
3. Deploy. → you get your public link, e.g. `https://your-app.vercel.app`.

(CLI equivalent: from `frontend/`, `vercel --prod` and set `VITE_BACKEND_URL` when prompted.)
`vercel.json` already handles SPA routing.

---

## Part C — Point the backend at the real frontend URL (CORS)
One command, new revision, ~seconds, no rebuild:
```bash
gcloud run services update fairblock-backend --region="$REGION" \
  --update-env-vars="^##^FRONTEND_ORIGIN=https://your-app.vercel.app##APP_URL=https://your-app.vercel.app"
```
Now the Vercel link works end-to-end for anyone.

---

## After deploy

**Swap to the paid Turnkey org (tomorrow) — one command, no rebuild:**
```bash
# update the org/public key env vars…
gcloud run services update fairblock-backend --region="$REGION" \
  --update-env-vars="^##^TURNKEY_ORG_ID=NEW_ORG##TURNKEY_API_PUBLIC_KEY=NEW_PUBKEY"
# …and the private key secret (new version)
printf '%s' 'NEW_PRIVATE_KEY' | gcloud secrets versions add turnkey-api-private-key --data-file=-
gcloud run services update fairblock-backend --region="$REGION" \
  --update-secrets="TURNKEY_API_PRIVATE_KEY=turnkey-api-private-key:latest"
```

**Still on the pre-prod checklist (not blocking v1):**
- **Blaze plan** on Firestore (avoid the daily free cap).
- **Backend read-caching** (the pending item) before real traffic.
- **Envelope-encrypt the per-treasury root key** with Cloud KMS before mainnet funds.
- Keep `--max-instances=1` (the nonce-ordered executor assumes a single instance).
- The Turnkey dashboard **"Allowed origins"** is for the Auth Proxy — **we don't use it**, leave it open.

## Local dev (unchanged)
`backend/serviceAccount.json` + `backend/.env` still drive local Firestore; `DB_BACKEND=memory`
runs without Firebase. Cloud Run ignores both (secrets via Secret Manager, Firestore via ADC).
