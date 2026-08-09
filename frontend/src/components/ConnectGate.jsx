import { useState } from "react";
import { useTurnkey, ClientState, AuthState } from "@turnkey/react-wallet-kit";
import { useOrg } from "../state/OrgContext.jsx";
import { Icon } from "./Icons.jsx";
import { getTheme, toggleTheme } from "../lib/theme.js";

// Inline onboarding — all four methods live directly on the page (no wall-kit modal):
//   1. email OTP   2. passkey   3. Google   4. connect wallet (self-custody)
// After any method authenticates, the treasury is provisioned by OrgContext and the app
// swaps to the dashboard; we show a "Setting up…" state in the gap.
function Divider({ label }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0", color: "var(--muted)", fontSize: 12 }}>
      <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
      {label}
      <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
    </div>
  );
}

export default function ConnectGate() {
  const { cfg, beginEmailOtp, completeEmailOtp, connectPasskey, connectGoogle, connectWallet, busy } = useOrg();
  const tk = useTurnkey();
  const [theme, setTheme] = useState(getTheme());
  const [err, setErr] = useState(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(null); // { otpId, otpEncryptionTargetBundle, email }

  const loading = tk.clientState !== ClientState.Ready;
  const authed = tk.authState === AuthState.Authenticated; // auth done, treasury being built

  const guard = (fn) => async () => {
    setErr(null);
    try { await fn(); } catch (e) { setErr(e?.message || String(e)); }
  };
  const sendCode = guard(async () => setPending(await beginEmailOtp(email.trim().toLowerCase())));
  const verifyCode = guard(async () => { await completeEmailOtp(pending, code.trim()); });

  return (
    <div className="gate">
      <button className="iconbtn" style={{ position: "fixed", top: 20, right: 20 }}
        onClick={() => setTheme(toggleTheme())} title="Toggle theme">
        {theme === "dark" ? <Icon.sun size={17} /> : <Icon.moon size={17} />}
      </button>

      <div className="box">
        <img className="logo-lg" src="/Logo.png" alt="Stabletrust Pro" />
        <h1>Stabletrust Pro</h1>
        <p>Confidential treasury payouts on Fairblock.</p>

        {authed ? (
          <div className="card" style={{ textAlign: "center", padding: 28 }}>
            <span className="spinner" style={{ margin: "0 auto 14px", width: 22, height: 22 }} />
            <p>Setting up your treasury…</p>
            <p className="hint" style={{ marginTop: 12 }}>
              <a className="link" onClick={guard(() => tk.logout())}>Cancel</a>
            </p>
          </div>
        ) : (
          <div className="card" style={{ textAlign: "left" }}>
            {/* 1 — Email OTP */}
            {!pending ? (
              <>
                <label className="fld">Continue with email</label>
                <div className="flex" style={{ gap: 8, alignItems: "stretch" }}>
                  <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com"
                    type="email" style={{ flex: 1 }}
                    onKeyDown={(e) => e.key === "Enter" && email.trim() && sendCode()} />
                  <button className="btn primary" style={{ flex: "none", padding: "0 16px" }}
                    disabled={busy || loading || !email.trim()} onClick={sendCode} title="Email me a sign-in code">
                    {busy ? <span className="spinner" style={{ margin: 0 }} /> : <Icon.chevR size={18} />}
                  </button>
                </div>
              </>
            ) : (
              <>
                <label className="fld">Enter the code sent to {pending.email}</label>
                <div className="flex" style={{ gap: 8 }}>
                  <input value={code} onChange={(e) => setCode(e.target.value.replace(/\s/g, "").slice(0, 6))}
                    placeholder="6-char code" autoFocus style={{ flex: 1, letterSpacing: "0.3em", fontSize: 18 }}
                    onKeyDown={(e) => e.key === "Enter" && code.length >= 6 && verifyCode()} />
                  <button className="btn primary" disabled={busy || code.length < 6} onClick={verifyCode}>
                    <Icon.shield size={16} /> Sign in
                  </button>
                </div>
                <p className="hint" style={{ marginTop: 8 }}>
                  <a className="link" onClick={() => { setPending(null); setCode(""); setErr(null); }}>Use a different email</a>
                </p>
              </>
            )}

            <Divider label="or" />

            {/* 2 — Passkey */}
            <button className="btn big block" disabled={busy || loading} onClick={guard(connectPasskey)}>
              <Icon.key size={16} /> Continue with passkey
            </button>

            {/* 3 — Google */}
            <button className="btn big block" style={{ marginTop: 10 }} disabled={busy || loading} onClick={guard(connectGoogle)}>
              <Icon.shield size={16} /> Continue with Google
            </button>

            <Divider label="or bring your own wallet" />

            {/* 4 — Self-custody wallet */}
            <button className="btn big block" disabled={busy} onClick={guard(connectWallet)}>
              <Icon.wallet size={16} /> Connect wallet (self-custody)
            </button>
            {/* <p className="hint" style={{ marginTop: 10 }}>
              Sign with your own MetaMask — Turnkey and Stabletrust hold nothing. Best for
              crypto-native treasuries.
            </p> */}
          </div>
        )}

        {err && <p className="hint" style={{ marginTop: 14, color: "var(--err)" }}>{err}</p>}
        {loading && !authed && <p className="hint" style={{ marginTop: 14 }}>Starting secure wallet…</p>}
        {!cfg && <p className="hint" style={{ marginTop: 8 }}>Connecting to backend…</p>}
      </div>
    </div>
  );
}
