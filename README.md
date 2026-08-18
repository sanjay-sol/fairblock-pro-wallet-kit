# Stabletrust Pro — Confidential Multi-Sig Treasury

Stabletrust Pro is a confidential, multi-signature treasury dashboard for stablecoin payouts. A team
holds a single on-chain wallet whose **balances and payout amounts are encrypted on-chain**, and whose
**spends require N-of-M approvals** from the team — with no browser extension, no seed phrase, and no
per-signature popups.

It combines two independent layers:

| Layer | Provider | Responsibility |
|---|---|---|
| Signing & auth | [Turnkey](https://www.turnkey.com) secure enclaves | Custody of the treasury's EOA private key, N-of-M approval policies, passwordless auth (email OTP / Google) |
| Confidential settlement | [Fairblock](https://www.fairblock.network) `@fairblock/stabletrust` | encrypted ERC-20 balances and transfers on EVM testnets |

Turnkey never learns transaction amounts (they are encrypted before signing); Fairblock never holds
keys (it is signer-agnostic). This document explains how the two are wired together.

---

## Table of contents

1. [Architecture](#architecture)
2. [Model B: how a treasury is structured](#model-b-how-a-treasury-is-structured)
3. [Turnkey: enclaves, sub-orgs, and policies](#turnkey-enclaves-sub-orgs-and-policies)
4. [Signatures: the three signing paths](#signatures-the-three-signing-paths)
5. [Authentication (sessions)](#authentication-sessions)
6. [The confidential balance model](#the-confidential-balance-model)
7. [Nonce management](#nonce-management)
8. [Confirmed vs. settled (two-phase UX)](#confirmed-vs-settled-two-phase-ux)
9. [Repository layout](#repository-layout)
10. [Backend API](#backend-api)
11. [Supported chains](#supported-chains)
12. [Environment variables](#environment-variables)
13. [Local development](#local-development)
14. [Deployment](#deployment)
15. [Security model](#security-model)
16. [References](#references)

---

## Architecture

```
                         Browser (React / Vite)
  ┌──────────────────────────────────────────────────────────────────┐
  │  OrgContext (state hub)                                            │
  │    ├── ConsensusSigner  ── signs via a Turnkey session key ───────┼──► Turnkey enclave
  │    │      (ethers v6 signer, no popups)                            │     (sub-org, N-of-M policy)
  │    └── @fairblock/stabletrust  ── builds ZK proofs (WASM),         │
  │           encrypts amounts, reads/decrypts balances               │
  └───────────────┬──────────────────────────────────┬───────────────┘
                  │ REST (x-org-id, x-caller-email)   │ JSON-RPC (reads, broadcast)
                  ▼                                    ▼
        Backend (Express, thin)                 EVM testnet + Fairblock
          ├── Turnkey parent key                  confidential "diamond" contract
          │     (creates sub-orgs, relays          (encrypted balances, keyshare
          │      OTP/OAuth, per-treasury            finalization off-chain)
          │      root key for fund-neutral ops)
          ├── nonce reservation + ordered executor
          └── Firestore (org / team / recipients / payouts) — amounts stored encrypted
```

Two things never touch the browser: the Turnkey **parent** API key (backend `.env` / Secret Manager)
and each treasury's **root** API key (server-side). Two things never touch the backend: a member's
**session** key (browser only, ephemeral) and the **confidential decryption key** (derived and held
client-side to read amounts).

---

## Model B: how a treasury is structured

Each treasury maps to exactly one Turnkey [sub-organization](https://docs.turnkey.com/concepts/sub-organizations)
and one EOA:

| Component | Where it lives | Role |
|---|---|---|
| Sub-organization | Turnkey | Isolation boundary — one per treasury (tenant) |
| Treasury EOA | Turnkey enclave (private key never exported) | The on-chain wallet; same address on every EVM chain |
| Root API key | Backend (`treasury.rootKey`) | Management (create users, set policies) + fund-neutral signing + relays OTP/OAuth |
| Member users | Turnkey (non-root) | Humans; authenticate with email OTP or Google; cast approvals |
| encryption keypair | Derived client-side per member | Encrypt/decrypt confidential balances and amounts |

"Model B" refers to the co-signing design: the treasury is one shared account, and a payout is a
single transaction that N members co-sign, rather than an on-chain Gnosis-style multisig (a
confidential transfer requires a plain EOA sender, so an on-chain multisig contract cannot be the
signer). See `backend/turnkey.mjs` for the sub-org + policy provisioning.

---

## Turnkey: enclaves, sub-orgs, and policies

Turnkey runs signing inside AWS Nitro [secure enclaves](https://docs.turnkey.com/security/secure-enclaves):
private keys are generated and used only inside the enclave and are never exposed to Turnkey staff,
the host, or us. Every state change is an **activity** governed by **policies**. See the
[Turnkey whitepaper](https://whitepaper.turnkey.com) for the enclave/QOS design.

On treasury creation the backend installs four policies on the sub-org
(`backend/turnkey.mjs` → `makePolicies`, called from `createTreasury`):

| Policy | Turnkey activity type | Consensus | Governs |
|---|---|---|---|
| `SPEND N-of-N` | `ACTIVITY_TYPE_SIGN_TRANSACTION_V2` | `approvers.count() >= threshold` | Payouts (confidential transfer / withdraw) — the money-moving path |
| `READ 1-of-N` | `ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2` | `approvers.count() >= 1` | Deriving the encryption key / decrypting amounts — any single member |
| `APPROVALS` | `ACTIVITY_TYPE_APPROVE_ACTIVITY` | `approvers.count() >= 1` | Letting members cast approval votes |
| `FUND 1-of-N` | `SIGN_TRANSACTION` + selector allow-list | `approvers.count() >= 1` | Fund-neutral calls (deposit, account creation) — any single admin may fund the pool |

The `FUND` policy is a scoped exception to `SPEND`: it matches only specific function selectors sent
to the confidential contract (deposit, create account), so **any one admin can add funds** while
**taking funds out still needs the full N-of-M**. Its condition is built in `fundCondition()`:

```js
// backend/turnkey.mjs
`activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && (<selector matches>) && (<to == diamond>)`
```

Changing the threshold (`PUT /api/threshold`) simply deletes and recreates the `SPEND` policy with a
new `approvers.count() >= n`. See the [policy language reference](https://docs.turnkey.com/concepts/policies/language).

> Note: a Turnkey policy's required approval count is **frozen when an activity is created**. Lowering
> the threshold does not retroactively complete an already-pending activity — it must be re-created.
> This is why the UI locks the threshold while payouts are pending.

---

## Signatures: the three signing paths

All frontend signing goes through `ConsensusSigner` (`frontend/src/signers.js`), an ethers v6
`AbstractSigner` backed by the member's Turnkey session. There are no per-signature popups — the
session key stamps requests directly.

### 1. Deriving the encryption key (`SIGN_RAW_PAYLOAD`, 1-of-M)

The confidential SDK derives a deterministic encryption keypair by asking the signer to sign a fixed
message. `ConsensusSigner.signMessage` submits a `SIGN_RAW_PAYLOAD_V2` activity (the `READ` policy,
1-of-M), and the resulting signature seeds the keypair.

```js
// frontend/src/signers.js
async _signDigest(digest) {
  const r = await getClient().signRawPayload({
    type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
    organizationId: this.subOrgId,
    parameters: { signWith: this.address, payload: digest,
                  encoding: "PAYLOAD_ENCODING_HEXADECIMAL", hashFunction: "HASH_FUNCTION_NO_OP" },
  });
  return assembleSig(r.activity.result.signRawPayloadResult);
}
```

The derived key is cached (SDK `_keyCache` + the browser vault), so this signature happens **once per
chain per session**, not per balance read. Balance decryption thereafter is a local WASM operation —
no Turnkey call, no signature. (See [Signature cost model](#signature-cost-model) below.)

### 2. Co-signing a payout (`SIGN_TRANSACTION`, N-of-M)

`ConsensusSigner.signTransaction` submits a `SIGN_TRANSACTION_V2` activity:

- If the treasury is **1-of-M**, the activity completes immediately and returns a signed transaction,
  which the SDK broadcasts (behaves like a normal wallet).
- If it needs **consensus**, Turnkey returns `ACTIVITY_STATUS_CONSENSUS_NEEDED` and the signer throws
  a `PendingConsensusError` carrying the `activityId`. The frontend records it as a pending payout;
  other admins later call `approveActivity` (an `APPROVE_ACTIVITY` activity). Once the threshold is
  met, the activity completes and the backend executor captures the signed transaction and broadcasts
  it (see [`GET /api/payouts`](#backend-api)).

### 3. Fund-neutral root signing (backend)

Some transactions move no funds out of the treasury and are signed server-side by the **root key**
(`backend/turnkey.mjs` → `rootSignTx`), which bypasses the N-of-M `SPEND` policy by design:

| Operation | Endpoint | Why root-signed |
|---|---|---|
| Set USDC→contract allowance | `POST /api/allowance` | Prerequisite for a deposit; spender hard-coded to the contract |
| Claim (`applyPending()`) | `POST /api/claim` | Moves the treasury's own pending balance into available; funds never leave |
| Nonce-gap fill | executor | A 0-value self-send to clear a nonce reserved by a rejected payout |

These are the only three uses; they are fund-neutral, so a single root signature cannot exfiltrate
funds.

### Signature cost model

Turnkey meters signing operations. Only deliberate actions sign; polling and balance reads do not:

| Action | Turnkey signatures |
|---|---|
| Load dashboard / poll / check balances | 0 |
| Derive confidential keys (activation) | 1 (once per chain, then cached) |
| Deposit | 1 (+1 root for allowance if unset) |
| Send payout (1-of-M) | 1 |
| Propose payout (N-of-M) | 1 by proposer, +1 per approver |
| Claim | 0 member (1 root) |

---

## Authentication (sessions)

Login is passwordless. The backend holds the Turnkey **parent** API key and relays the auth activity;
the browser only ever holds a short-lived **session** key. Sessions default to 12 hours
(`sessionSeconds = 43200`, `frontend/src/lib/session.js`). See
[Turnkey sessions](https://docs.turnkey.com/authentication/sessions).

### Email OTP

```
Browser                         Backend                          Turnkey
  │  newTargetKey() (P-256)                                          │
  │  POST /api/auth/init ─────────►  otpInit(email) ───────────────► initOtpAuth
  │  ◄──────────────── otpId                                         │
  │  POST /api/auth/verify ───────►  otpVerify(otpId, code,          │
  │      (targetPublicKey)             targetPublicKey) ───────────► otpAuth
  │  ◄──── credentialBundle (HPKE-encrypted to targetPublicKey)     │
  │  decrypt → session API key → TurnkeyClient(ApiKeyStamper)        │
```

The `credentialBundle` is HPKE-encrypted to the browser's ephemeral public key, so the backend never
sees the usable session key. `establishSession` decrypts it and builds a `TurnkeyClient` stamped by an
`ApiKeyStamper` (`@turnkey/api-key-stamper`).

### Google (OIDC)

The browser runs an implicit `id_token` popup. Turnkey binds the token to the session key by requiring
the OIDC `nonce` to equal `hex(SHA-256(utf8(targetPublicKeyHex)))` (`frontend/src/lib/googleAuth.js`).
The backend verifies the token (`google-auth-library`) and runs an `oauth` activity, returning the same
kind of `credentialBundle` as OTP. First-time Google login also links the provider to the member
(`createOauthProviders`). See [Turnkey social logins](https://docs.turnkey.com/authentication/social-logins).

Requirements: `VITE_GOOGLE_CLIENT_ID` at build time, and the app origin listed under **Authorized
JavaScript origins** and **Authorized redirect URIs** in the Google Cloud OAuth client.

---

## The confidential balance model

A treasury has three balances (`OrgContext` → `refreshBalances`):

| Balance | Meaning | On-chain visibility |
|---|---|---|
| `public` | Plain ERC-20 (USDC) held by the EOA | Public |
| `confidential.available` | Spendable encrypted balance | Amount encrypted |
| `confidential.pending` | Received-but-not-yet-applied encrypted balance | Amount encrypted |

Operations (`frontend/src/confidential.js` wrapping the SDK):

| Operation | Flow | Amount |
|---|---|---|
| Deposit | public ERC-20 → `available` | Encrypted on entry |
| Confidential transfer | sender `available` → recipient `pending` | Hidden end-to-end |
| Claim (`applyPending`) | `pending` → `available` | — |
| Withdraw | `available` → public ERC-20 | Becomes public |
| Direct-to-wallet | withdraw, then a public ERC-20 transfer | Public |

Received transfers land in `pending`, not `available`. To become spendable they must be applied via
`applyPending()`. Two ways:

1. **Explicit claim** — `POST /api/claim` (root-signed) moves `pending → available`. Required for
   multi-sig treasuries.
2. **Automatic on next op** — the SDK's `confidentialDeposit`/`confidentialTransfer` internally call
   `applyPending` first when pending exists. This works on **1-of-M** treasuries (the internal
   `applyPending` completes immediately). On **N-of-M** treasuries it cannot auto-complete (that
   `applyPending` is itself a `SPEND` op needing approvals), so pending stays until an explicit claim.

> Nonce interaction: because a deposit-with-pending is two transactions (`applyPending` then the
> deposit), the frontend only forces a reserved nonce for **multi-sig** treasuries; for 1-of-M it lets
> the SDK auto-sequence the two nonces via `getTransactionCount`. Forcing one nonce onto both would
> collide. See [Nonce management](#nonce-management).

Finalization is asynchronous: a transaction's receipt confirms it on-chain in seconds, but the
encrypted balance only updates once Fairblock's keyshare network finalizes (`_waitForGlobalState`
polls `getAccountCore().pendingAction`, typically ~30-60s). This is protocol-inherent and independent
of gas.

---

## Nonce management

The treasury is one EOA, so payouts, deposits, and claims contend for sequential nonces. The backend
is the source of truth (`backend/server.mjs`):

- **Reservation** — `GET /api/nonce` returns `max(getTransactionCount(pending), highestReservedInDb + 1)`,
  so a new operation never reuses a nonce that is either spent on-chain or reserved by an in-flight
  payout.
- **Threshold-aware override** — the frontend bakes the reserved nonce into a co-signed transaction
  only for multi-sig (`if (threshold > 1) setNonceOverride(base)`), because co-signed transactions are
  not broadcast until approval and would otherwise all receive the same live nonce. For 1-of-M the SDK
  auto-sequences.
- **Ordered executor** — `executeReadyPayouts` broadcasts approved, signed payouts strictly in nonce
  order, per chain, one executor at a time.
- **Gap fill** — a rejected payout leaves a permanent nonce hole; `fillNonceGap` broadcasts a 0-value
  root-signed self-send to advance the account so higher payouts can settle.

---

## Confirmed vs. settled (two-phase UX)

Because finalization lags the receipt by ~30-60s, single deposits and confidential transfers resolve
at the **receipt** (`waitForFinalization: false`) and then show a background **"settling"** state,
rather than one long spinner. A unified `settling` state in `OrgContext` (kind: deposit / transfer /
claim) drives the UI and blocks a second op until the balance reflects (the account holds one
`pendingAction` at a time). Batches keep `waitForFinalization: true` per row, since each row's proof is
built against the current balance and must finalize before the next.

---

## Repository layout

```
fairblock-pro-wallet-kit/
├── frontend/                 React + Vite (port 5176)
│   └── src/
│       ├── state/OrgContext.jsx   State hub: balances, payouts, ops, polling, settling
│       ├── signers.js             ConsensusSigner (ethers v6 over a Turnkey session)
│       ├── confidential.js        Thin wrapper over @fairblock/stabletrust
│       ├── lib/session.js         Session key: decrypt credentialBundle → TurnkeyClient
│       ├── lib/googleAuth.js      OIDC popup + nonce derivation
│       ├── lib/api.js             Backend REST client (x-org-id / x-caller-email)
│       ├── networks.js            Chain registry (client-side mirror)
│       ├── config.js              Reads /api/config, builds the SDK config
│       ├── vault.js               Per-chain encryption key storage (encrypted IndexedDB)
│       ├── metaCrypto.js          Client-side amount encryption for the DB
│       └── pages/                 Dashboard, Single/Batch Payout, Pending, History, Team, Settings, ...
├── backend/                  Express (port 8792)
│   ├── server.mjs                 API, nonce reservation, ordered executor
│   ├── turnkey.mjs                Sub-orgs, policies, OTP/OAuth relay, rootSignTx
│   ├── store.mjs                  Firestore or in-memory persistence
│   ├── chains.mjs                 Chain registry (RPC / contract addresses)
│   └── mailer.mjs                 SendGrid / SMTP invite + notification emails
├── DEPLOY.md                 Cloud Run + Vercel runbook
└── TEAM-DB-EMAIL-SETUP.md    Firestore + email setup
```

---

## Backend API

Thin Express service. Treasury endpoints require `x-org-id` (sub-org id) and `x-caller-email`
(the signed-in member); `ctx()` rejects non-members with 403.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/config` | Public config: chains, default chain, model, DB mode, mail mode |
| GET | `/healthz` | Health probe (use `/api/config` behind Google Front End) |
| POST | `/api/treasury` | Create a treasury (owner) — provisions the sub-org + policies |
| GET / PUT | `/api/treasury` | Read / rename the treasury |
| POST | `/api/auth/init` | Start email OTP |
| POST | `/api/auth/verify` | Complete email OTP → `credentialBundle` |
| POST | `/api/auth/oauth` | Google login (returns `needsOnboarding` if no org) |
| POST | `/api/auth/oauth/create` | Create an org from a Google identity |
| POST / DELETE | `/api/members` `/api/members/:email` | Invite / remove a member (removal locked while payouts pending) |
| PUT | `/api/threshold` | Change the N-of-M threshold (swaps the SPEND policy) |
| GET | `/api/nonce` | Reserve the next nonce(s) on a chain |
| POST | `/api/allowance` | Ensure the USDC→contract allowance (root-signed) |
| POST | `/api/claim` | `applyPending()` — claim received funds (root-signed) |
| POST / GET | `/api/payouts` | Record / list payouts; the GET also enriches, finalizes, and runs the ordered executor |
| POST | `/api/payouts/:id/rejected` | Reject a pending payout |
| GET / POST / DELETE | `/api/recipients` | Address book |
| POST | `/api/requests` | Optional proxy to the Fairblock relayer (dormant unless `SDK_API_BASE_URL` points here) |

---

## Supported chains

All chains are testnets. The treasury EOA is the same address on each; switching chains re-points the
SDK and provider (`backend/chains.mjs`).

| Chain | Chain ID | Token | Confidential contract |
|---|---|---|---|
| Base Sepolia (recommended) | 84532 | USDC | `0x31Ce72e1D2A499140a95c19accE7bCF5E0664689` |
| Ethereum Sepolia | 11155111 | USDC | `0x7aeb444f608bDA6f922B0dBaDad6F83BCB516338` |
| Arbitrum Sepolia | 421614 | USDC | `0xd180189fa0774736127146a87290B4EeAe545314` |
| Stable Testnet | 2201 | USDC | `0x196f9F80134c2DeBa81E93cb4C8aD37924149A74` |
| Arc Testnet | 5042002 | USDC | `0x2f9EAcE58059592f428C1dE1237ff1D4957548E3` |
| Tempo Testnet | 42431 | USD | `0xE559fB936C69c46E216bf61B07C16bF1a6d444aa` |

Per-chain RPC overrides: set `RPC_<chainId>` in the backend env to replace the public default (e.g.
`RPC_84532=<Alchemy Base Sepolia URL>`). The resolved RPC is served to the browser via `/api/config`.

---

## Environment variables

### Backend (`backend/.env`)

| Variable | Example / default | Notes |
|---|---|---|
| `PORT` | `8792` | |
| `APP_NAME` | `Stabletrust Pro` | |
| `FRONTEND_ORIGIN` | `http://localhost:5176` | Comma-separated CORS allow-list |
| `APP_URL` | `http://localhost:5176` | Base URL for invite links |
| `DB_BACKEND` | `firestore` | Anything else = in-memory |
| `GOOGLE_APPLICATION_CREDENTIALS` | `./serviceAccount.json` | Firebase Admin key (local); prod uses ADC |
| `TURNKEY_API_BASE_URL` | `https://api.turnkey.com` | |
| `TURNKEY_ORG_ID` | `<parent org id>` | Parent organization |
| `TURNKEY_API_PUBLIC_KEY` / `TURNKEY_API_PRIVATE_KEY` | secret | Parent API key — **secret**, never in git |
| `GOOGLE_CLIENT_ID` | `<oauth client id>` | Verifies Google id_tokens (has a code fallback) |
| `RPC_<chainId>` | `RPC_84532=https://...` | Optional per-chain RPC override |
| `SDK_API_BASE_URL` | empty | Empty = SDK posts to its hosted relayer; set to this backend to proxy |
| `SENDGRID_API_KEY` / `SMTP_*` | secret | Email transport (SendGrid preferred; SMTP fallback) |
| `MAIL_FROM` | `Stabletrust Pro <...>` | |

Secrets (`TURNKEY_API_PRIVATE_KEY`, `serviceAccount.json`, `SENDGRID_API_KEY`, `SMTP_PASS`) stay in
gitignored files locally and in Secret Manager in production — never committed.

### Frontend (`frontend/.env`, build-time `VITE_*`)

| Variable | Example | Notes |
|---|---|---|
| `VITE_BACKEND_URL` | `http://localhost:8792` | Backend base URL |
| `VITE_GOOGLE_CLIENT_ID` | `<oauth client id>` | Baked at build time; required for the Google button |

---

## Local development

Two processes (Node 20+ recommended). Ports 5176 / 8792.

```bash
# 1. backend
cd fairblock-pro-wallet-kit/backend
npm install
# create .env (see table above) — Turnkey parent key, DB_BACKEND, RPC overrides, etc.
npm run dev        # node --watch server.mjs -> http://localhost:8792

# 2. frontend
cd fairblock-pro-wallet-kit/frontend
npm install
# create .env with VITE_BACKEND_URL + VITE_GOOGLE_CLIENT_ID
npm run dev        # vite -> http://localhost:5176
```

Open `http://localhost:5176`. With `DB_BACKEND=firestore` and a `serviceAccount.json`, local data
persists to that Firebase project; otherwise it falls back to in-memory (wiped on restart).

Production build check: `cd frontend && npm run build`.

---

## Deployment

See `DEPLOY.md` for the full runbook. Summary:

| Target | Service | How |
|---|---|---|
| Backend | Google Cloud Run | `gcloud run deploy stabletrust-pro-backend --source backend/ --region=us-central1 --project=<project>` (env/secrets persist across redeploys; secrets via Secret Manager) |
| Frontend | Vercel | Git-connected; root `frontend/`, auto-deploys on push. `VITE_*` are build-time — set them in Vercel, then redeploy |
| Database | Firestore | Company project via Application Default Credentials (no key file in prod) |

Notes:
- Cloud Run is not git-connected — a `git push` updates the frontend only; ship backend changes with
  `gcloud run deploy --source backend/`.
- Cloud Run's source upload respects `backend/.gcloudignore`, so `.env` and `serviceAccount.json`
  are excluded from the build context.
- Google OAuth: add the production origin(s) to the OAuth client's Authorized origins + redirect URIs.

---

## Security model

- **Key custody** — the treasury private key never leaves Turnkey's enclave. The Turnkey **parent**
  key and each treasury's **root** key are server-side only. A member's **session** key is browser-only
  and expires (default 12h).
- **Authorization** — spends require N-of-M (`SPEND` policy); funding is 1-of-M (`FUND`); reads /
  approvals are 1-of-M. The root key can only produce **fund-neutral** signatures (allowance,
  applyPending, gap-fill), so a compromised backend cannot move funds out on its own.
- **Confidentiality** — balances and payout amounts are encrypted on-chain; the DB stores only
  encrypted amounts (`metaCrypto.js`); the confidential decryption key is derived and held client-side.
- **Tenant isolation** — every treasury is a separate Turnkey sub-org; every backend endpoint requires
  the caller to be a current member of the org it targets.
- **Removed members** — deletion removes the Turnkey user and cuts backend access immediately (a live
  session is force-logged-out on its next request).

---

## References

Turnkey:
- Documentation — https://docs.turnkey.com
- Sub-organizations — https://docs.turnkey.com/concepts/sub-organizations
- Policies (overview) — https://docs.turnkey.com/concepts/policies/overview
- Policy language (conditions, `approvers.count()`) — https://docs.turnkey.com/concepts/policies/language
- Sessions & credential bundles — https://docs.turnkey.com/authentication/sessions
- Email / OTP auth — https://docs.turnkey.com/authentication/email
- Social logins (OAuth / OIDC) — https://docs.turnkey.com/authentication/social-logins
- Secure enclaves — https://docs.turnkey.com/security/secure-enclaves
- Whitepaper — https://whitepaper.turnkey.com
- SDKs — `@turnkey/sdk-server`, `@turnkey/http`, `@turnkey/api-key-stamper`, `@turnkey/crypto` (https://www.npmjs.com/org/turnkey)

Fairblock:
- Website — https://www.fairblock.network
- Confidential SDK — `@fairblock/stabletrust` (https://www.npmjs.com/package/@fairblock/stabletrust)

Other:
- ethers v6 — https://docs.ethers.org/v6/
- Base Sepolia — https://docs.base.org/chain/network-information
- Vite — https://vite.dev
- Google Cloud Run — https://cloud.google.com/run/docs
