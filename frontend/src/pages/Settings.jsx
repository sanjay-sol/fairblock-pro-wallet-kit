import { useEffect, useState } from "react";
import { useOrg } from "../state/OrgContext.jsx";
import { Icon } from "../components/Icons.jsx";
import { short } from "../lib/format.js";

export default function Settings() {
  const { treasury, cfg, members, threshold, saveName, setThreshold, logout, busy } = useOrg();
  const [name, setName] = useState("");
  const [th, setTh] = useState(threshold);
  const isOwner = treasury?.role === "owner";
  const signers = members.filter((m) => m.status === "active");

  useEffect(() => { setName(treasury?.name || ""); setTh(threshold); }, [treasury, threshold]);

  return (
    <div className="page narrow">
      <div className="page-head"><h1>Settings</h1><p>Manage your treasury and its co-signing policy.</p></div>

      <div className="card">
        <div className="between" style={{ marginBottom: 14 }}><h3>Treasury</h3>{isOwner && <button className="btn primary sm" disabled={busy || !name.trim()} onClick={() => saveName(name.trim())}>Save</button>}</div>
        <label className="fld">Treasury name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} disabled={!isOwner} />
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 6 }}>Approval policy</h3>
        <p className="csub">How many co-signers must approve each payout. Enforced by Turnkey — no single admin can move funds alone.</p>
        <div className="flex" style={{ gap: 12, alignItems: "center", marginTop: 12 }}>
          <select value={th} disabled={!isOwner} onChange={(e) => setTh(Number(e.target.value))} style={{ maxWidth: 90 }}>
            {Array.from({ length: signers.length }).map((_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
          </select>
          <span className="muted">of {signers.length} co-signer{signers.length === 1 ? "" : "s"} must approve</span>
          {isOwner && th !== threshold && <button className="btn primary sm" disabled={busy} onClick={() => setThreshold(th)}>Update to {th}-of-{signers.length}</button>}
        </div>
        {!isOwner && <p className="hint" style={{ marginTop: 10 }}>Only the owner can change the threshold.</p>}
        {th > 1 && signers.length < th && <p className="hint" style={{ marginTop: 10, color: "var(--warn)" }}>Add more co-signers on the Team page first.</p>}
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
        <button className="btn" onClick={logout}><Icon.logout size={15} /> Sign out</button>
      </div>
    </div>
  );
}
