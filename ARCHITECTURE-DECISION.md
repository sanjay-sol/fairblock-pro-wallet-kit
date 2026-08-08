# fairblock-pro-wallet-kit — Architecture & Trust Research

**Question:** For production (real users, real funds, mainnet), should the confidential-treasury
dashboard keep the **self-hosted backend** model (current `fairblock-pro`) or move to Turnkey's
**Embedded Wallet Kit** (frontend + managed Auth Proxy)? Does either change the trust users must
place in Fairblock?

**Date:** 2026-08-08 · Sibling POC folder; `fairblock-pro` is left untouched as the fallback.

---

## TL;DR — recommendation

Go **Wallet Kit** for the auth/key layer, **keep a thin backend + DB** for org/roles/audit, and
enforce fund-movement rules with **Turnkey's policy engine (enclave-enforced), not browser code**.
Offer **two front-door options**: *Sign in with email/Google* (Turnkey embedded wallet, easy
onboarding) **and** *Connect wallet* (user's own MetaMask, max self-custody — this is what Hinkal
does). Keep `fairblock-pro` (self-hosted) as the reference/fallback.

**Why:** it removes our parent API private key from our own infrastructure (a real win when real
funds are involved), deletes the most security-critical code *we* would otherwise own and audit
(OTP/OAuth/session handling — the exact area where we already hit the nonce/uncompressed-key bug),
and gives us email + Google + external-wallet login for free. It does **not** weaken custody or
confidentiality, because both models are "non-custodial via Turnkey" already.

---

## 0. The reframe: this is NOT "backend vs no backend"

Both options use **Turnkey embedded wallets**, so both are equally non-custodial at the key layer.
The only real differences are:

1. **Where the auth/session orchestration runs** — our server (A) vs Turnkey's Auth Proxy (B).
2. **Who holds the parent-org API private key** — our `.env` (A) vs Turnkey (B).

You keep an **app backend + database either way** — for organizations, members/roles, recipients,
approvals, audit log, analytics. Those are authorization/business rules and must never be enforced
in the browser. (Our current backend already has `/api/team`, `/api/recipients`,
`/api/transactions`, `/api/analytics`, `/api/org` — that layer survives unchanged.)

So the decision is narrowly about the **auth + key-management layer**, not about whether a backend
exists.

---

## 1. How auth & signing actually work

### The invariants (true in BOTH models)

- **Signing keys live in AWS Nitro secure enclaves (TEEs).** Raw private keys are never exposed to
  Turnkey staff, to us, or to any host OS. Keys are decrypted **only inside** an attested enclave
  running Turnkey's QuorumOS unikernel, and only after a valid authenticator is presented. The
  policy engine also runs in-enclave. Enclave code is cryptographically attestable.
- **A user action is required to move funds.** A signature happens only when the end user presents
  their authenticator (passkey / Google OIDC / email OTP / external-wallet signature) and the
  in-enclave policies allow it.
- **The signer never sees confidential amounts.** Fairblock's confidentiality is a *protocol*
  property: the SDK encrypts amounts **client-side before building the transaction**, so Turnkey
  signs opaque ciphertext calldata. Switching wallet models changes nothing here — the wallet layer
  and the confidentiality layer are independent.

### Model A — self-hosted backend (current `fairblock-pro`)

```
Browser ──(OIDC token / OTP + ephemeral target pubkey)──▶ OUR backend  (holds parent API key)
OUR backend ──(parent key stamps mgmt calls)──▶ Turnkey: getSubOrgIds / createSubOrganization / oauth() / otpAuth()
Turnkey enclave ──(credential bundle, encrypted to the browser's ephemeral pubkey)──▶ OUR backend ──▶ Browser
Browser decrypts bundle ▶ session credential (scoped to the USER's sub-org)
Browser ──(session credential stamps a signing request)──▶ Turnkey enclave ──▶ signature ──▶ Browser broadcasts tx
```
- **Parent API private key** is used **only for management/initiation** (create/find sub-org, kick
  off OAuth/OTP). *Verified in code:* the backend performs **no** `signRawPayload` / transaction
  signing — grep returns nothing. User transactions are signed by the **user's own session key**
  in the browser, scoped to their sub-org.

### Model B — Embedded Wallet Kit + Auth Proxy

```
Browser (Wallet Kit UI, config = {organizationId, authProxyConfigId}) ──(OIDC/OTP/passkey)──▶ Turnkey Auth Proxy
Turnkey Auth Proxy (runs the org credential on Turnkey's side) ──▶ Turnkey enclave: create/find sub-org, issue session
Turnkey enclave ──(credential bundle encrypted to the browser's ephemeral pubkey)──▶ Browser
Browser decrypts ▶ session credential ──(stamps signing request)──▶ Turnkey enclave ──▶ signature ──▶ broadcast
```
- **Our parent API private key is not in our infrastructure at all.** Enabling the Auth Proxy in
  the Turnkey dashboard provisions the managed credential on Turnkey's side. The frontend holds only
  a **public** org id + a **public** auth-proxy config id (neither is a secret).
- "No backend" means **no *our* backend in the auth path** — the browser talks to *Turnkey's*
  servers directly. Our app backend still exists for org/roles/audit, just off the auth path.

### Side-by-side

| | Model A (self-hosted) | Model B (Wallet Kit) |
|---|---|---|
| Wallet signing keys | Turnkey enclave | Turnkey enclave |
| Who can move funds | user's authenticator, enclave-enforced | same |
| **Parent API private key** | **our backend `.env`** | **Turnkey (managed proxy)** |
| Auth/session orchestration | our server code | Turnkey Auth Proxy |
| Sees confidential amounts | no one (client-side encryption) | no one |
| Login methods | what we build (today: email, Google, passkey) | email, Google/socials, SMS, passkey, **external wallet** — toggles |
| App backend for org/roles/audit | yes (exists today) | yes (still needed) |
| Security-critical auth code we own | **a lot** (OTP/OAuth/session/nonce) | **almost none** |
| Login uptime depends on | our server + Turnkey | Turnkey (proxy) |

---

## 2. Does it change the trust assumptions on Fairblock?

Short answer: **it does not weaken them, and it modestly reduces trust in *us*.** Break it down by
what a user's funds and privacy actually depend on:

| Trust dimension | Who you trust | A → B change |
|---|---|---|
| **Custody** (can someone steal funds?) | Turnkey enclaves + the user's own authenticator. In our sub-org config the **parent org is *not* a root user** (`rootUsers = [end user]`, `rootQuorumThreshold = 1`), so **our backend key cannot satisfy the quorum to sign.** | Unchanged. B additionally removes our parent key from our infra, shrinking *our* attack surface. |
| **Confidentiality** (who sees amounts?) | The Fairblock protocol (client-side encryption + threshold decryption). The signer sees only ciphertext. | Unchanged — independent of the wallet layer. |
| **Recovery** (lost device) | The user's email / OAuth provider. The parent (A) or the proxy (B) can only *initiate* recovery; completing it requires the user's email/OAuth possession. | Moves the "initiate" power from our server to Turnkey's proxy. |
| **Liveness** (can I always transact?) | Turnkey core API + the chain. | Login path: A depends on our server too; B depends on Turnkey's proxy. Signing depends on Turnkey either way. |
| **Frontend integrity** | Whoever ships the JS (us). A malicious bundle could swap the signer. | Unchanged — inherent to any web wallet, both models. |

**The nuance you asked about — "does it remove trust on Fairblock?"**
- Today, users **already don't have to trust our backend to hold their keys** — it can't sign.
- Model B goes one step further: it removes even the *parent key custody* and the *auth-flow
  correctness* from us and hands both to Turnkey. So yes, it **reduces the surface where a Fairblock
  server compromise could matter** — at the cost of leaning harder on Turnkey (whom you already
  trust for the keys). Net: fewer distinct trusted parties, not more.
- **Maximum trust removal** is a third option, below.

### The most trust-minimized option: external wallet as the *signer*

Our SDK is **signer-agnostic** — it takes any ethers signer. We already proved this: the
`confidential-wallet-cli` runs on Base Sepolia with a **raw MetaMask private key and no Turnkey at
all.** So we can offer **"Connect wallet"** where the user's *own* MetaMask/hardware wallet signs
the confidential transactions directly:

- Turnkey holds **nothing**; Fairblock holds **nothing**. Pure self-custody.
- This is exactly **Hinkal Prime's** model (see §3).
- Trade-off: worse onboarding (user must already have a funded EVM wallet and understand signing),
  which is why it complements — rather than replaces — embedded email/Google login.

**So the production ideal is a two-door front:** embedded (email/Google, Turnkey) for mainstream
users **and** connect-wallet (self-custody) for crypto-native treasuries. Wallet Kit bundles both
behind one config; alternatively we add a plain wagmi "Connect wallet" path ourselves.

---

## 3. What Hinkal and the industry actually do

- **Hinkal Prime** (the product we're mirroring): users **authenticate with the wallets they
  already use** — "requests are signed by the caller's EVM wallet… without passwords or custodial
  key handling." Address screening (Chainalysis KYT) gates funds. So Hinkal is **bring-your-own
  external wallet**, *not* embedded custody. Their trust story: they hold no keys because you sign
  with your own wallet.
- **Everyone else (embedded-wallet apps):** use a provider — **Turnkey, Privy, Dynamic, Magic,
  Web3Auth, Coinbase WaaS** — and increasingly the provider's **managed/frontend auth** (Turnkey
  Wallet Kit, Privy's hosted flow) rather than hand-rolling OTP/OAuth. A **thin backend + DB**
  stores app data (orgs, roles, audit); the provider owns keys/signing. Self-hosting the auth
  backend is reserved for teams with strict control/compliance needs.

**Reading for us:** match Hinkal's "connect your wallet" for the crypto-native treasury crowd,
*and* keep embedded email/Google for everyone else. That's the Wallet-Kit two-door setup.

---

## 4. Team treasury: where do roles & approvals get enforced?

A shared treasury with **admin/member** roles and **approval workflows** for real funds must be
enforced where the browser can't cheat. Two layers:

- **Fund authority → Turnkey policy engine (in-enclave), model-agnostic.** Turnkey policies are
  JSON `{ effect, consensus, condition }`:
  - **N-of-M approvals:** `consensus` can require multiple approvers (quorum) before a signing
    activity is allowed.
  - **Per-user roles/limits:** scope non-root members with policies (e.g. can only sign to
    whitelisted recipients: `condition: "eth.tx.to == '<addr>'"`; caps; specific wallet only).
  - **Careful:** **root users bypass all policies.** So *don't* make every teammate a root user —
    reserve root for a small admin quorum, add members as **non-root users governed by policies**.
- **Org relationships & UX → our thin backend + DB.** Membership, display roles, recipient book,
  audit log, analytics, payout drafts/queue. Metadata and orchestration — never the final authority
  to move funds.

This split is the same whether we pick A or B, which is another reason the auth-layer choice (A vs
B) is lower-stakes than it first appears.

---

## 5. UX comparison

| | Model A (self-hosted) | Model B (Wallet Kit) | Connect-wallet (self-custody) |
|---|---|---|---|
| First-time onboarding | email/Google, no seed phrase | email/Google/socials/passkey, no seed phrase | must already have a funded EVM wallet |
| Cross-device | yes (email/OAuth re-auth) | yes (managed) | yes (their wallet) |
| Prebuilt login UI | we build/maintain it | Turnkey ships it | wallet's own modal (wagmi/RainbowKit) |
| Best for | — | mainstream users | crypto-native treasuries (Hinkal crowd) |
| Our maintenance | high | low | low |

---

## 6. When Model A (self-hosted) is still the right call

- Hard requirement to keep **all auth logic in-house** (on-prem / strict compliance / data
  residency), or
- You need a login flow the Auth Proxy doesn't expose and want to call the raw Turnkey API, or
- You want **zero third-party dependency in the login path** (accepting that signing still depends
  on Turnkey).

For a startup shipping a confidential treasury to real users quickly, none of these outweigh the
security + velocity wins of B. Keep A as the fallback.

---

## 7. POC plan — `fairblock-pro-wallet-kit`

1. **Scaffold** a Vite React app (copy the working confidential/networks/token/UI layers from
   `fairblock-pro`, which are wallet-agnostic).
2. **Auth layer → `@turnkey/react-wallet-kit`**: `TurnkeyProvider` with `{ organizationId,
   authProxyConfigId }` (the "Config Id" Mani sent, once the org id is confirmed). Enable email +
   Google + passkey + **external wallet** in the dashboard config.
3. **Signer bridge:** adapt the Wallet-Kit session into an ethers signer the SDK accepts (mirror
   how `fairblock-pro` builds its `TurnkeySigner` / session signer), **plus** a plain wagmi
   "Connect wallet" signer for the self-custody door.
4. **Thin backend + DB (reused from `fairblock-pro`):** org, members/roles, recipients, audit,
   analytics — **off** the auth path. No parent API private key in it anymore.
5. **Treasury governance:** wire Turnkey **policies/quorum** for admin/member + payout approvals
   (enclave-enforced), backed by the DB for metadata.
6. **Confidentiality unchanged:** same `@fairblock/stabletrust` SDK, same client-side encryption,
   same diamonds.
7. **Compare** side-by-side with `fairblock-pro` on: onboarding, cross-device, approvals, and the
   "what does a server compromise expose" threat model.

**STATUS — BUILT (2026-08-08).** The POC is implemented end-to-end in this folder (org
`8007c548` + auth-proxy config `e42e9c24`). Build passes, app mounts with zero errors, all three
doors render, and the Auth Proxy handshake succeeds (`wallet_kit_config → 200`) — so the org +
config id are valid and live. See [`README.md`](./README.md) for run steps, the dashboard
prerequisites (enable methods + allowlist `http://localhost:5176`), and the verification status.
Remaining = a human completing a real login + a testnet transaction.

---

## Sources

- Turnkey — Non-custodial key management: https://docs.turnkey.com/security/non-custodial-key-mgmt
- Turnkey — Sub-organizations (custody / root users / quorum): https://docs.turnkey.com/concepts/sub-organizations
- Turnkey — Sub-organizations as wallets: https://docs.turnkey.com/integration-guides/sub-organizations-as-wallets
- Turnkey — Policy engine overview: https://docs.turnkey.com/concepts/policies/overview
- Turnkey — React Wallet Kit getting started (config fields): https://docs.turnkey.com/sdks/react/getting-started
- Turnkey — External wallet authentication: https://docs.turnkey.com/solutions/embedded-wallets/integration-guide/react/using-external-wallets/authentication
- Turnkey — Embedded Wallet Kit launch: https://www.turnkey.com/blog/turnkey-launches-new-embedded-wallet-kit
- Hinkal — Best privacy infra for institutional DeFi (BYO-wallet auth): https://www.hinkal.io/blog/best-privacy-infrastructure-for-institutional-defi-platforms-in-2026
