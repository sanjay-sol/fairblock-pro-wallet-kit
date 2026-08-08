import "./polyfills.js"; // must be first
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { TurnkeyProvider } from "@turnkey/react-wallet-kit";
import "@turnkey/react-wallet-kit/styles.css";
import App from "./App.jsx";
import { OrgProvider } from "./state/OrgContext.jsx";
import { initTheme } from "./lib/theme.js";
import "./styles.css";

initTheme(); // set light/dark before first paint

// Embedded Wallet Kit config. organizationId + authProxyConfigId are the ONLY required
// fields — the managed Auth Proxy (configured in Mani's Turnkey dashboard) runs the
// email/passkey/OAuth/wallet flows, so there is NO parent API private key in this app.
// Which methods actually work is ultimately gated by the dashboard's auth-proxy config;
// we enable them here so they appear in the modal when the proxy allows them.
const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || undefined;
// OAuth (Google/Apple/…) needs a redirect URI that email/passkey/wallet do NOT.
// Google uses the implicit id_token flow: it redirects back to this URI with the
// token in the URL hash, and the app (TurnkeyProvider) completes sign-in on load.
// Default = this app's origin; override with VITE_OAUTH_REDIRECT_URI if you host a
// dedicated callback page. This URI must be an Authorized redirect URI on the Google
// client (or Google can be enabled in the Turnkey dashboard, which supplies its own).
const oauthRedirectUri =
  import.meta.env.VITE_OAUTH_REDIRECT_URI ||
  (typeof window !== "undefined" ? window.location.origin : undefined);
const turnkeyConfig = {
  organizationId: import.meta.env.VITE_TURNKEY_ORG_ID,
  authProxyConfigId: import.meta.env.VITE_TURNKEY_AUTH_PROXY_CONFIG_ID,
  auth: {
    oauthConfig: {
      oauthRedirectUri,
      ...(googleClientId ? { google: { primaryClientId: googleClientId } } : {}),
    },
  },
  ui: {
    authModal: {
      methods: {
        emailOtpAuthEnabled: true,
        passkeyAuthEnabled: true,
        walletAuthEnabled: true, // "external wallet" as a login method inside the modal
        googleOauthEnabled: true,
      },
      methodOrder: ["email", "passkey", "socials", "wallet"],
      oauthOrder: ["google"],
    },
  },
};

// No StrictMode: it double-invokes effects in dev (double config load / double calls).
createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <TurnkeyProvider
      config={turnkeyConfig}
      callbacks={{
        onError: (e) => console.warn("[turnkey]", e?.message || e),
      }}
    >
      <OrgProvider>
        <App />
      </OrgProvider>
    </TurnkeyProvider>
  </BrowserRouter>,
);
