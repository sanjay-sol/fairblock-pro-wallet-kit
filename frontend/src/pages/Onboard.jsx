import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useOrg } from "../state/OrgContext.jsx";
import { Icon } from "../components/Icons.jsx";
import GoogleSignInButton from "../components/GoogleSignInButton.jsx";
import { getTheme, toggleTheme } from "../lib/theme.js";
import { initialsOf } from "../lib/format.js";

// Entry point. Three views: the start card (Sign in / Create organisation + Google), the email OTP
// code step, and — when you Continue with Google on an account that has NO org yet — a one-field
// "set up your organisation" step (no email re-entry; Google already gave us the verified email).
export default function Onboard() {
  const { createTreasury, beginOtp, completeOtp, completeGoogle, createOrgWithGoogle, busy, cfg } = useOrg();
  const [sp] = useSearchParams();
  const [mode, setMode] = useState("signin"); // signin | create
  const [email, setEmail] = useState(sp.get("email") || "");
  const [orgName, setOrgName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [pending, setPending] = useState(null); // email OTP step
  const [gpending, setGpending] = useState(null); // { email, oidcToken, targetPublicKey, ephemeralPrivateKey }
  const [code, setCode] = useState("");
  const [err, setErr] = useState(null);
  const [theme, setTheme] = useState(getTheme());

  useEffect(() => { if (sp.get("email")) setMode("signin"); }, [sp]);

  const guard = (fn) => async (...args) => { setErr(null); try { await fn(...args); } catch (e) { setErr(e?.message || String(e)); } };

  const sendCode = guard(async () => {
    if (mode === "create") await createTreasury({ name: orgName || "Organisation", ownerEmail: email, ownerName, threshold: 1 });
    setPending(await beginOtp(email));
  });
  const verify = guard(async () => { await completeOtp(pending, code.trim()); });
  const onGoogle = guard(async (payload) => {
    const r = await completeGoogle(payload);
    if (r?.needsOnboarding) setGpending({ ...payload, email: r.email }); // → collect org name only
  });
  const createGoogleOrg = guard(async () => { await createOrgWithGoogle({ ...gpending, orgName, ownerName }); });
  const backToStart = () => { setPending(null); setGpending(null); setCode(""); setErr(null); };

  const Spin = () => <span className="spinner" style={{ margin: 0 }} />;

  return (
    <div className="gate">
      <button className="iconbtn" style={{ position: "fixed", top: 20, right: 20 }} onClick={() => setTheme(toggleTheme())} title="Toggle theme">
        {theme === "dark" ? <Icon.sun size={17} /> : <Icon.moon size={17} />}
      </button>

      <div className="box auth-box">
        <img className="auth-logo" src="/Logo.png" alt="Stabletrust Pro" />
        <h1 className="auth-title">{cfg?.appName || "Stabletrust Pro"}</h1>
        <p className="auth-sub">Confidential payouts for your organisation.</p>

        {gpending ? (
          /* ── Google onboarding: org name + your name only ── */
          <div className="card auth-card">
            <h3 style={{ margin: "0 0 4px" }}>Set up your organisation</h3>
            <br />
            <div className="auth-chip">
              <div className="av">{initialsOf(gpending.email)}</div>
              <div><div className="who">Signed in with Google</div><div className="whoe">{gpending.email}</div></div>
            </div>
            <label className="fld">Organisation name*</label>
            <input value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="" autoFocus onKeyDown={(e) => e.key === "Enter" && orgName.trim() && createGoogleOrg()} />
            <label className="fld" style={{ marginTop: 12 }}>Your name*</label>
            <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="" onKeyDown={(e) => e.key === "Enter" && orgName.trim() && createGoogleOrg()} />
            <button className="btn primary big block" style={{ marginTop: 16 }} disabled={busy || !orgName.trim()} onClick={createGoogleOrg}>
              {busy ? <Spin /> : <>Create organisation <Icon.chevR size={16} /></>}
            </button>
            <p className="auth-foot"> <br /> <span className="auth-link" onClick={backToStart}>← Use a different account</span></p>
          </div>
        ) : pending ? (
          /* ── email OTP code ── */
          <div className="card auth-card">
            <h3 style={{ margin: "0 0 4px" }}>Check your email</h3>
            <p className="csub" style={{ marginBottom: 16 }}>We sent a one-time code to <b style={{ color: "var(--ink)" }}>{pending.email}</b>.</p>
            <label className="fld">Enter the code</label>
            <input value={code} onChange={(e) => setCode(e.target.value.replace(/\s/g, "").slice(0, 9))} placeholder="6-digit code" autoFocus style={{ letterSpacing: "0.3em", fontSize: 18, textAlign: "center" }} onKeyDown={(e) => e.key === "Enter" && code.length >= 6 && verify()} />
            <button className="btn primary big block" style={{ marginTop: 14 }} disabled={busy || code.length < 6} onClick={verify}>
              {busy ? <Spin /> : <><Icon.shield size={16} /> {mode === "create" ? "Create & sign in" : "Sign in"}</>}
            </button>
            <p className="auth-foot"><span className="auth-link" onClick={backToStart}>← Use a different email</span></p>
          </div>
        ) : (
          /* ── start: tabs + form + google ── */
          <div className="card auth-card">
            <div className="seg">
              <button className={mode === "signin" ? "on" : ""} onClick={() => { setMode("signin"); setErr(null); }}>Sign in</button>
              <button className={mode === "create" ? "on" : ""} onClick={() => { setMode("create"); setErr(null); }}>Create organisation</button>
            </div>

            {mode === "create" && (
              <>
                <label className="fld">Organisation name</label>
                <input value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Organisation name" />
                <label className="fld" style={{ marginTop: 12 }}>Your name</label>
                <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="Your name" />
                <label className="fld" style={{ marginTop: 12 }}>Email</label>
              </>
            )}
            {mode === "signin" && <label className="fld">Email</label>}
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" type="email" onKeyDown={(e) => e.key === "Enter" && email && sendCode()} />
            <button className="btn primary big block" style={{ marginTop: 14 }} disabled={busy || !email} onClick={sendCode}>
              {busy ? <Spin /> : <>{mode === "create" ? "Create organisation" : "Continue with email"} <Icon.chevR size={16} /></>}
            </button>

            <div className="or-div">or</div>
            <GoogleSignInButton onCredential={onGoogle} onError={setErr} disabled={busy} />

            <p className="auth-foot">
              {mode === "create"
                ? "You'll be the owner. Add team members + set the approval threshold after setup."
                : ""}
            </p>
          </div>
        )}

        {err && <p className="hint" style={{ marginTop: 14, color: "var(--err)" }}>{err}</p>}
      </div>
    </div>
  );
}
