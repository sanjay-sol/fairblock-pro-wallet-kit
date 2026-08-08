import { useState } from "react";
import { useTurnkey, ClientState } from "@turnkey/react-wallet-kit";
import { useOrg } from "../state/OrgContext.jsx";
import { Icon } from "./Icons.jsx";
import { getTheme, toggleTheme } from "../lib/theme.js";

// Two doors (per the architecture decision):
//   • Embedded  — Turnkey Embedded Wallet Kit modal: email · passkey · Google · wallet.
//                 Turnkey holds the keys in a secure enclave; smooth onboarding.
//   • Self-custody — the user's OWN wallet (MetaMask) signs directly; nobody else
//                 holds anything. This is the Hinkal-style "connect your wallet" path.
export default function ConnectGate() {
  const { cfg, connectEmbedded, connectGoogle, connectWallet, busy } = useOrg();
  const { clientState } = useTurnkey();
  const [theme, setTheme] = useState(getTheme());
  const [err, setErr] = useState(null);
  const loading = clientState !== ClientState.Ready;

  const guard = (fn) => async () => {
    setErr(null);
    try { await fn(); } catch (e) { setErr(e?.message || String(e)); }
  };

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

        <div className="card" style={{ textAlign: "left" }}>
          <button
            className="btn primary big block"
            disabled={busy || loading}
            onClick={guard(connectEmbedded)}
          >
            <Icon.shield size={18} /> Sign in / Sign up
          </button>
          <p className="hint" style={{ marginTop: 10 }}>
            Email, passkey (Touch/Face&nbsp;ID), Google, or an existing wallet — an embedded
            treasury wallet is created and secured by Turnkey.
          </p>

          <button
            className="btn big block"
            style={{ marginTop: 14 }}
            disabled={busy || loading}
            onClick={guard(connectGoogle)}
          >
            <Icon.mail size={16} /> Continue with Google
          </button>

          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0", color: "var(--muted)", fontSize: 12 }}>
            <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
            or bring your own wallet
            <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
          </div>

          <button
            className="btn big block"
            disabled={busy}
            onClick={guard(connectWallet)}
          >
            <Icon.wallet size={16} /> Connect wallet (self-custody)
          </button>
          <p className="hint" style={{ marginTop: 10 }}>
            Sign with your own MetaMask — Turnkey and Stabletrust hold nothing. Best for
            crypto-native treasuries.
          </p>
        </div>

        {err && <p className="hint" style={{ marginTop: 14, color: "var(--err)" }}>{err}</p>}
        {loading && <p className="hint" style={{ marginTop: 14 }}>Starting secure wallet…</p>}
        {!cfg && <p className="hint" style={{ marginTop: 8 }}>Connecting to backend…</p>}
      </div>
    </div>
  );
}
