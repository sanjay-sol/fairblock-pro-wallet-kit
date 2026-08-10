import { useEffect, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useOrg } from "../state/OrgContext.jsx";
import { api } from "../lib/api.js";
import { Icon } from "../components/Icons.jsx";
import { getTheme, toggleTheme } from "../lib/theme.js";

// The invitee lands here from the email link (/accept?invite=…&token=…). We show the
// invitation, have them sign in with the invited email (OTP), then accept — which records
// them in the org with the role the owner chose.
export default function AcceptInvite() {
  const [sp] = useSearchParams();
  const inviteId = sp.get("invite");
  const token = sp.get("token");
  const { treasury, beginEmailOtp, completeEmailOtp, acceptInvite, busy } = useOrg();

  const [theme, setTheme] = useState(getTheme());
  const [invite, setInvite] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState(null);
  const [done, setDone] = useState(null);
  const [err, setErr] = useState(null);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(null);

  useEffect(() => {
    (async () => {
      if (!inviteId || !token) { setLoadErr("This invitation link is incomplete."); setLoading(false); return; }
      try { setInvite(await api.getInvite(inviteId, token)); }
      catch (e) { setLoadErr(e?.message || "This invitation is invalid or expired."); }
      finally { setLoading(false); }
    })();
  }, [inviteId, token]);

  const inviteEmail = (invite?.email || "").toLowerCase();
  const signedInEmail = (treasury?.email || "").toLowerCase();
  const emailMatches = !!signedInEmail && signedInEmail === inviteEmail;

  const accept = async () => {
    setErr(null);
    try { setDone(await acceptInvite({ inviteId, token })); }
    catch (e) { setErr(e?.message || String(e)); }
  };
  const sendCode = async () => {
    setErr(null);
    try { setPending(await beginEmailOtp(inviteEmail)); }
    catch (e) { setErr(e?.message || String(e)); }
  };
  const verify = async () => {
    setErr(null);
    try { await completeEmailOtp(pending, code.trim()); } // treasury builds → emailMatches flips true
    catch (e) { setErr(e?.message || String(e)); }
  };

  return (
    <div className="gate">
      <button className="iconbtn" style={{ position: "fixed", top: 20, right: 20 }} onClick={() => setTheme(toggleTheme())} title="Toggle theme">
        {theme === "dark" ? <Icon.sun size={17} /> : <Icon.moon size={17} />}
      </button>
      <div className="box">
        <img className="logo-lg" src="/Logo.png" alt="Stabletrust Pro" />
        <h1>Team invitation</h1>

        {loading ? (
          <p className="hint">Loading your invitation…</p>
        ) : loadErr ? (
          <div className="card">
            <p className="hint" style={{ color: "var(--err)", marginTop: 0 }}>{loadErr}</p>
            <Link className="btn block" to="/" style={{ marginTop: 12 }}>Go to sign in</Link>
          </div>
        ) : done ? (
          <div className="card" style={{ textAlign: "center", padding: 28 }}>
            <div style={{ width: 52, height: 52, borderRadius: "50%", margin: "0 auto 12px", display: "grid", placeItems: "center", background: "var(--ok-bg)", color: "var(--ok)" }}><Icon.check size={26} /></div>
            <h3>You're in!</h3>
            <p className="hint" style={{ marginTop: 6 }}>You joined <b>{done.orgName || invite.orgName}</b> as <b style={{ textTransform: "capitalize" }}>{done.role}</b>.</p>
            <Link className="btn primary block" to="/" style={{ marginTop: 16 }}>Continue →</Link>
          </div>
        ) : (
          <div className="card" style={{ textAlign: "left" }}>
            <p style={{ marginTop: 0, lineHeight: 1.55 }}>
              <b>{invite.invitedByEmail || "A treasury owner"}</b> invited you to join{" "}
              <b>{invite.orgName || "their organization"}</b> as{" "}
              <b style={{ color: "var(--brand-soft)", textTransform: "capitalize" }}>{invite.role}</b>.
            </p>
            <p className="hint">Invitation for <b>{invite.email}</b>.</p>

            {invite.expired || invite.status !== "pending" ? (
              <p className="hint" style={{ marginTop: 12, color: "var(--err)" }}>This invitation is {invite.status}. Ask the owner for a new one.</p>
            ) : emailMatches ? (
              <button className="btn primary big block" style={{ marginTop: 14 }} disabled={busy} onClick={accept}>
                <Icon.check size={16} /> Accept &amp; join as {invite.role}
              </button>
            ) : treasury ? (
              <p className="hint" style={{ marginTop: 12, color: "var(--warn)" }}>
                You're signed in as <b>{treasury.email || treasury.address}</b>, but this invite is for <b>{invite.email}</b>.
                Disconnect and sign in with {invite.email} to accept.
              </p>
            ) : !pending ? (
              <>
                <p className="hint" style={{ marginTop: 12 }}>Sign in as <b>{invite.email}</b> to accept:</p>
                <button className="btn primary big block" style={{ marginTop: 10 }} disabled={busy} onClick={sendCode}>
                  <Icon.mail size={16} /> Email me a sign-in code
                </button>
              </>
            ) : (
              <>
                <label className="fld" style={{ marginTop: 14 }}>Enter the code sent to {invite.email}</label>
                <div className="flex" style={{ gap: 8 }}>
                  <input value={code} onChange={(e) => setCode(e.target.value.replace(/\s/g, "").slice(0, 6))} placeholder="6-char code" autoFocus
                    style={{ flex: 1, letterSpacing: "0.3em", fontSize: 18 }} onKeyDown={(e) => e.key === "Enter" && code.length >= 6 && verify()} />
                  <button className="btn primary" disabled={busy || code.length < 6} onClick={verify}><Icon.shield size={16} /> Sign in</button>
                </div>
              </>
            )}
            {err && <p className="hint" style={{ marginTop: 12, color: "var(--err)" }}>{err}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
