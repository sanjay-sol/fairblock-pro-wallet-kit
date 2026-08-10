import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useOrg } from "../state/OrgContext.jsx";
import { Icon } from "../components/Icons.jsx";
import { getTheme, toggleTheme } from "../lib/theme.js";

// Entry point: sign in (email OTP into your treasury sub-org) or create a new treasury.
export default function Onboard() {
  const { createTreasury, beginOtp, completeOtp, busy, cfg } = useOrg();
  const [sp] = useSearchParams();
  const [mode, setMode] = useState("signin"); // signin | create
  const [email, setEmail] = useState(sp.get("email") || "");
  const [name, setName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [pending, setPending] = useState(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState(null);
  const [theme, setTheme] = useState(getTheme());

  useEffect(() => { if (sp.get("email")) setMode("signin"); }, [sp]);

  const sendCode = async () => {
    setErr(null);
    try {
      if (mode === "create") await createTreasury({ name: name || "Treasury", ownerEmail: email, ownerName, threshold: 1 });
      setPending(await beginOtp(email));
    } catch (e) { setErr(e?.message || String(e)); }
  };
  const verify = async () => {
    setErr(null);
    try { await completeOtp(pending, code.trim()); } // treasury builds → App renders the shell
    catch (e) { setErr(e?.message || String(e)); }
  };

  return (
    <div className="gate">
      <button className="iconbtn" style={{ position: "fixed", top: 20, right: 20 }} onClick={() => setTheme(toggleTheme())}>{theme === "dark" ? <Icon.sun size={17} /> : <Icon.moon size={17} />}</button>
      <div className="box">
        <img className="logo-lg" src="/Logo.png" alt="Stabletrust Pro" />
        <h1>{cfg?.appName || "Stabletrust Pro"}</h1>
        <p className="hint" style={{ marginTop: -4 }}>Confidential, co-managed treasury payouts on Fairblock.</p>

        {!pending ? (
          <div className="card" style={{ textAlign: "left", marginTop: 8 }}>
            <div className="flex" style={{ marginBottom: 14 }}>
              <button className={`btn sm ${mode === "signin" ? "primary" : "ghost"}`} onClick={() => setMode("signin")}>Sign in</button>
              <button className={`btn sm ${mode === "create" ? "primary" : "ghost"}`} onClick={() => setMode("create")}>Create a treasury</button>
            </div>
            {mode === "create" && (
              <>
                <label className="fld">Treasury name</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Finance" />
                <label className="fld" style={{ marginTop: 10 }}>Your name</label>
                <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="Jane Doe" />
              </>
            )}
            <label className="fld" style={{ marginTop: 10 }}>Email</label>
            <div className="flex" style={{ gap: 8 }}>
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" style={{ flex: 1 }} onKeyDown={(e) => e.key === "Enter" && email && sendCode()} />
              <button className="btn primary" disabled={busy || !email} onClick={sendCode} title="Email me a code"><Icon.chevR size={16} /></button>
            </div>
            <p className="hint" style={{ marginTop: 10 }}>
              {mode === "create" ? "You'll be the owner. Add co-signers + set the approval threshold after setup." : "We'll email a one-time code. Members: use the email you were invited with."}
            </p>
          </div>
        ) : (
          <div className="card" style={{ textAlign: "left", marginTop: 8 }}>
            <label className="fld">Enter the code sent to {pending.email}</label>
            <div className="flex" style={{ gap: 8 }}>
              <input value={code} onChange={(e) => setCode(e.target.value.replace(/\s/g, "").slice(0, 9))} placeholder="6-digit code" autoFocus style={{ flex: 1, letterSpacing: "0.25em", fontSize: 18 }} onKeyDown={(e) => e.key === "Enter" && code.length >= 6 && verify()} />
              <button className="btn primary" disabled={busy || code.length < 6} onClick={verify}><Icon.shield size={16} /> Sign in</button>
            </div>
            <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={() => { setPending(null); setCode(""); }}>← Use a different email</button>
          </div>
        )}
        {err && <p className="hint" style={{ marginTop: 12, color: "var(--err)" }}>{err}</p>}
      </div>
    </div>
  );
}
