// Google sign-in via an OAuth 2.0 OIDC popup (so we can use our OWN button, styled to match the app,
// instead of Google's fixed iframe button). The popup returns a Google id_token in the URL fragment;
// index.html relays it back to us via postMessage and closes.
//
// Turnkey binds the token to our ephemeral session key: the token's `nonce` MUST equal the SHA-256
// (hex) of the Turnkey target public key. Turnkey re-derives it from the `targetPublicKey` we pass to
// the oauth activity and rejects any mismatch — preventing a token minted for one key being replayed.
import { newTargetKey } from "./session.js";

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
export const googleConfigured = () => !!CLIENT_ID;

// nonce = hex( SHA-256( utf8(targetPublicKeyHex) ) ) — matches Turnkey's OIDC nonce convention.
export async function oauthNonce(targetPublicKeyHex) {
  const bytes = new TextEncoder().encode(targetPublicKeyHex);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const randHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

// Opens the Google account picker in a popup and resolves with the id_token + the ephemeral target
// key (whose hash is the token's nonce). Rejects on cancel / blocked popup / error.
export function signInWithGoogle() {
  return new Promise((resolve, reject) => {
    (async () => {
      if (!CLIENT_ID) throw new Error("Google sign-in isn't configured");
      const key = newTargetKey(); // { targetPublicKey, ephemeralPrivateKey }
      const nonce = await oauthNonce(key.targetPublicKey);
      const state = randHex(16);
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: window.location.origin, // must be an Authorized redirect URI in the Google console
        response_type: "id_token",
        scope: "openid email profile",
        nonce, state, prompt: "select_account",
      });
      const W = 500, H = 650;
      const left = window.screenX + Math.max(0, (window.outerWidth - W) / 2);
      const top = window.screenY + Math.max(0, (window.outerHeight - H) / 2);
      const popup = window.open(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, "stabletrust-google", `width=${W},height=${H},left=${left},top=${top}`);
      if (!popup) throw new Error("Popup blocked — allow popups for this site and try again.");

      let settled = false;
      const cleanup = () => { settled = true; window.removeEventListener("message", onMsg); clearInterval(poll); };
      const onMsg = (e) => {
        if (e.origin !== window.location.origin || e.data?.type !== "google-oauth" || e.data.state !== state) return;
        cleanup();
        try { popup.close(); } catch { /* ignore */ }
        if (e.data.id_token) resolve({ oidcToken: e.data.id_token, targetPublicKey: key.targetPublicKey, ephemeralPrivateKey: key.ephemeralPrivateKey });
        else reject(new Error(e.data.error === "access_denied" ? "Google sign-in was cancelled." : (e.data.error || "Google sign-in failed.")));
      };
      window.addEventListener("message", onMsg);
      const poll = setInterval(() => { if (popup.closed && !settled) { cleanup(); reject(new Error("Google sign-in was cancelled.")); } }, 600);
    })().catch(reject);
  });
}
