# Stabletrust Pro — Wallet Kit POC

The **Embedded Wallet Kit** variant of the confidential-treasury dashboard. Same product and
features as `fairblock-pro`, but the **auth + key layer** is Turnkey's managed **Embedded Wallet
Kit** (`@turnkey/react-wallet-kit`) instead of our own backend — plus a new **self-custody
"Connect wallet"** door. `fairblock-pro` is left untouched as the self-hosted fallback.

See [`ARCHITECTURE-DECISION.md`](./ARCHITECTURE-DECISION.md) for the why.

---

## What changed vs. fairblock-pro

| | fairblock-pro (self-hosted) | this POC (Wallet Kit) |
|---|---|---|
| Auth orchestration | our backend (`@turnkey/sdk-server` + OTP/OAuth/session code) | Turnkey **Auth Proxy** (managed, in the browser) |
| Parent API private key | in our backend `.env` | **not in our infra** — held by Turnkey |
| Login methods | email · passkey · Google (hand-rolled) | email · passkey · Google · **external wallet** — one modal |
| Extra door | — | **Connect wallet (self-custody)** — sign with your own MetaMask, nobody holds keys |
| Backend | Turnkey key + auth routes + DB | **thin DB only** (org/team/recipients/transactions) — no keys, no auth routes |

Everything else — multi-token, confidential deposit/transfer/withdraw, direct-to-wallet, batch CSV,
pending-approval queue, per-treasury tenant scoping, client-side amount encryption, multi-testnet —
is inherited unchanged (the Fairblock SDK is signer-agnostic).

## The two doors

1. **Embedded** — `Sign in / Sign up` opens the wallet-kit modal (email OTP, passkey/Touch ID,
   Google, or an existing wallet). Turnkey creates/holds an embedded wallet in a secure enclave.
2. **Self-custody** — `Connect wallet` uses the browser's own wallet (MetaMask) as the signer.
   Turnkey holds nothing, Stabletrust holds nothing. This is the Hinkal-style path.

Both produce an ethers v6 signer that the SDK consumes identically. The embedded signer
(`src/signers.js` → `WalletKitSigner`) is **headless** — it routes signing to the wallet-kit
session (`tk.signTransaction` / `tk.signMessage`), so there is **no modal per signature**; it mirrors
`@turnkey/ethers`' serialization so signatures are byte-identical to a normal wallet.

---

## Run it

Two processes. Ports are **5176 / 8792** so it runs side by side with fairblock-pro (5175/8791).

```bash
# 1. thin backend (no keys)
cd fairblock-pro-wallet-kit/backend
npm install        # first time
npm run dev        # → http://localhost:8792

# 2. frontend
cd fairblock-pro-wallet-kit/frontend
npm install        # first time
npm run dev        # → http://localhost:5176
```

Open **http://localhost:5176**.

Config lives in `.env` files (all values are PUBLIC — no secrets):
- `frontend/.env` — `VITE_TURNKEY_ORG_ID` (8007c548…), `VITE_TURNKEY_AUTH_PROXY_CONFIG_ID`
  (e42e9c24…), `VITE_GOOGLE_CLIENT_ID`, `VITE_BACKEND_URL`.
- `backend/.env` — `PORT`, `APP_NAME`, `FRONTEND_ORIGIN`.

---

## Dashboard prerequisites (the external dependency)

Auth runs through Turnkey's **managed Auth Proxy**, so which login methods actually work is
controlled by **Mani's Turnkey dashboard**, not this code. For org `8007c548` / config `e42e9c24`,
in **Wallet Kit → Configuration**, confirm:

1. **Enabled auth methods**: Email OTP, Passkey, Google (OAuth), External wallet — enable the ones
   you want to demo. (This code enables all four in the modal, but the proxy config is the gate.)
2. **Allowed origin**: `http://localhost:5176` must be on the auth-proxy's allowlist (origin
   changes can take minutes to propagate — same as the Google-origin gotcha before).
3. **Google** (OAuth) needs a **redirect URI** that email/passkey/wallet do not. Google uses the
   implicit `id_token` flow: it redirects back to `oauthRedirectUri` (set in `main.jsx`, default
   `http://localhost:5176`) with the token in the URL hash. Two ways to make it work:
   - **Self-managed (your Google client):** in Google Cloud Console → your OAuth client
     (`79984203938-…`) → add `http://localhost:5176` to **Authorized redirect URIs** *and*
     **Authorized JavaScript origins** → Save (propagation takes a few minutes). Else Google
     returns `redirect_uri_mismatch`.
   - **Dashboard-managed (cleaner):** enable Google in the Turnkey dashboard's Wallet Kit config;
     the proxy then supplies its own redirect + client, and you skip the Google-console step.

If a method isn't enabled in the dashboard, it simply won't appear in the modal.

---

## Verification status (2026-08-08)

Verified automatically (headless):
- ✅ Frontend production build passes (`npm run build`).
- ✅ App mounts with **zero page errors / warnings**; all three doors render.
- ✅ Thin backend serves `/api/config` (no Turnkey fields) + all DB routes; starts with **no keys**.
- ✅ Wallet-kit `clientState` reaches **Ready** and the Auth Proxy handshake succeeds —
  `GET https://authproxy.turnkey.com/v1/wallet_kit_config → 200` for org `8007c548` /
  config `e42e9c24`. **The org + config id are valid and live.**

Needs a human + the dashboard prerequisites above (cannot be automated):
- ▢ Complete an actual login (email OTP / passkey / Google / external wallet).
- ▢ Run a confidential deposit/transfer on a testnet (needs funds + the redeployed diamonds).

---

## Key files

- `frontend/src/main.jsx` — `TurnkeyProvider` (org + auth-proxy config, method toggles).
- `frontend/src/signers.js` — `WalletKitSigner` (embedded) + injected-wallet helpers (self-custody).
- `frontend/src/state/OrgContext.jsx` — derives the treasury from the wallet-kit session; all
  treasury ops (deposit/transfer/withdraw/batch/tokens) preserved.
- `frontend/src/components/ConnectGate.jsx` — the two-door onboarding.
- `backend/server.mjs` — thin DB backend (no keys, no auth routes).
# fairblock-pro-wallet-kit
