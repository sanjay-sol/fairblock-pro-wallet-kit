import { useEffect, useState } from "react";
import { useOrg } from "../state/OrgContext.jsx";
import { Icon } from "../components/Icons.jsx";
import { short } from "../lib/format.js";

export default function Settings() {
  const { treasury, cfg, members, threshold, payouts, saveName, setThreshold, logout, busy } = useOrg();
  const [name, setName] = useState("");
  const [th, setTh] = useState(threshold);
  const isOwner = treasury?.role === "owner";
  const signers = members.filter((m) => m.status === "active");
  const pendingCount = payouts.filter((p) => p.status === "pending").length;
  const maxTh = Math.max(signers.length, 1);
  const invalidThreshold = threshold > signers.length; // impossible N-of-M — e.g. after a member was removed
  // Threshold changes are blocked while payouts are pending — UNLESS we're correcting an already-
  // impossible threshold (lowering it only lets stuck payouts settle; it never weakens a valid policy).
  const locked = pendingCount > 0 && !invalidThreshold;

  useEffect(() => { setName(treasury?.name || ""); setTh(Math.min(threshold, maxTh)); }, [treasury, threshold, maxTh]);

  return (
    <div className="page narrow">
      <div className="page-head"><h1>Settings</h1><p>Manage your treasury and policies.</p></div>

      <div className="card">
        <div className="between" style={{ marginBottom: 14 }}><h3>Treasury</h3>{isOwner && <button className="btn primary sm" disabled={busy || !name.trim()} onClick={() => saveName(name.trim())}>Save</button>}</div>
        <label className="fld">Treasury name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} disabled={!isOwner} />
      </div>

      <div className="card">
        <div className="between" style={{ marginBottom: 6 }}>
          <h3>Approval policy</h3>
          {isOwner && invalidThreshold ? <span className="badge err">⚠ Threshold above team size</span> : isOwner && locked ? <span className="badge warn"><Icon.lock size={12} /> Locked while payouts pending</span> : null}
        </div>
        <p className="csub">How many organisation members must approve each payout. No single admin can move funds alone.</p>
        <div className="flex" style={{ gap: 12, alignItems: "center", marginTop: 12 }}>
          <select value={th} disabled={!isOwner || locked} onChange={(e) => setTh(Number(e.target.value))} style={{ maxWidth: 90 }}>
            {Array.from({ length: maxTh }).map((_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
          </select>
          <span className="muted">of {signers.length} member{signers.length === 1 ? "" : "s"} must approve{invalidThreshold ? ` (set to ${threshold} now — impossible)` : ""}</span>
          {isOwner && th !== threshold && <button className="btn primary sm" disabled={busy || locked} onClick={() => setThreshold(th)}>Update to {th}-of-{signers.length}</button>}
        </div>
        {!isOwner && <p className="hint" style={{ marginTop: 10 }}>Only the owner can change the threshold.</p>}
        {isOwner && locked && <p className="hint" style={{ marginTop: 10, color: "var(--warn)" }}> Resolve the {pendingCount} pending payout{pendingCount === 1 ? "" : "s"} first. The lock lifts automatically once they settle or are rejected.</p>}
        {isOwner && invalidThreshold && <p className="hint" style={{ marginTop: 10, color: "var(--err)" }}>⚠ Your approval threshold ({threshold}) is higher than your team size ({signers.length}), so no payout can ever reach it. Lower it to {maxTh} or below to fix this{pendingCount > 0 ? ` — this also lets the stuck pending payout${pendingCount === 1 ? "" : "s"} settle` : ""}.</p>}
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 14 }}>Treasury wallet</h3>
        <div className="table-wrap"><table><tbody>
          <tr><td className="muted">Address</td><td className="right mono">{treasury?.address}</td></tr>
          <tr><td className="muted">Turnkey sub-org</td><td className="right mono">{short(treasury?.subOrgId)}</td></tr>
          <tr><td className="muted">Confidential account</td><td className="right">{treasury?.activated ? <span className="badge ok">activated</span> : <span className="badge warn">not activated</span>}</td></tr>
          <tr><td className="muted">Network</td><td className="right">{cfg?.networkName} · {cfg?.chainId}</td></tr>
          <tr><td className="muted">Your role</td><td className="right" style={{ textTransform: "capitalize" }}>{treasury?.role}</td></tr>
        </tbody></table></div>
      </div>

      <div className="card" style={{ borderColor: "rgba(248,113,113,.3)" }}>
        <h3 style={{ color: "var(--err)" }}>Session</h3>
        <p className="csub">Sign out of this device. Your session key is removed from this browser; the treasury and its funds are untouched.</p>
        <button className="btn" onClick={() => logout()}><Icon.logout size={15} /> Sign out</button>
      </div>
    </div>
  );
}
