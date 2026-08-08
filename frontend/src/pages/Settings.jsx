import { useEffect, useState } from "react";
import { useOrg } from "../state/OrgContext.jsx";
import { api } from "../lib/api.js";
import { Icon } from "../components/Icons.jsx";
import { short } from "../lib/format.js";

export default function Settings() {
  const { org, owner, treasury, cfg, reloadOrg, toast, disconnectTreasury, addDevicePasskey, sessionActive, busy } = useOrg();
  const [orgName, setOrgName] = useState("");
  const [delivery, setDelivery] = useState("confidential");
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [savingOrg, setSavingOrg] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);

  useEffect(() => {
    setOrgName(org?.name || "");
    setDelivery(org?.defaultDelivery || "confidential");
    setOwnerName(owner?.name || "");
    setOwnerEmail(owner?.email || "");
  }, [org, owner]);

  async function saveOrg() {
    setSavingOrg(true);
    try { await api.updateOrg({ name: orgName, defaultDelivery: delivery }); await reloadOrg(); toast("Organization saved ✓", "ok"); }
    catch (e) { toast(e.message, "error"); } finally { setSavingOrg(false); }
  }
  async function saveProfile() {
    setSavingProfile(true);
    try { await api.setOwner({ name: ownerName, email: ownerEmail, address: treasury?.address }); await reloadOrg(); toast("Profile saved ✓", "ok"); }
    catch (e) { toast(e.message, "error"); } finally { setSavingProfile(false); }
  }
  async function resetData() {
    if (!confirm("Wipe the local org/team/transaction store? This does NOT touch the chain or your Turnkey wallet.")) return;
    await fetch(`${cfg.backend}/api/admin/reset`, { method: "POST" });
    toast("Local store reset — reloading…", "muted");
    setTimeout(() => window.location.reload(), 800);
  }

  return (
    <div className="page narrow">
      <div className="page-head"><h1>Settings</h1><p>Manage your organization profile and payout preferences.</p></div>

      <div className="card">
        <div className="between" style={{ marginBottom: 14 }}><h3>Organization</h3><button className="btn primary sm" disabled={savingOrg} onClick={saveOrg}>Save changes</button></div>
        <div className="card-row cols-2">
          <div className="field" style={{ margin: 0 }}><label className="fld">Organization name</label><input value={orgName} onChange={(e) => setOrgName(e.target.value)} /></div>
          <div className="field" style={{ margin: 0 }}><label className="fld">Default delivery method</label>
            <select value={delivery} onChange={(e) => setDelivery(e.target.value)}><option value="confidential">Confidential Settlement</option><option value="direct">Direct to wallet</option></select>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="between" style={{ marginBottom: 14 }}><h3>Profile</h3><button className="btn primary sm" disabled={savingProfile} onClick={saveProfile}>Save changes</button></div>
        <div className="card-row cols-2">
          <div className="field" style={{ margin: 0 }}><label className="fld">Profile name</label><input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} /></div>
          <div className="field" style={{ margin: 0 }}><label className="fld">Email</label><input value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} placeholder="you@example.com" /></div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 14 }}>Treasury wallet</h3>
        <div className="table-wrap"><table><tbody>
          <tr><td className="muted">Address</td><td className="right mono">{treasury?.address}</td></tr>
          <tr><td className="muted">Turnkey sub-org</td><td className="right mono">{short(treasury?.subOrgId)}</td></tr>
          <tr><td className="muted">Confidential account</td><td className="right">{treasury?.activated ? <span className="badge ok">activated</span> : <span className="badge warn">not activated</span>}</td></tr>
          <tr><td className="muted">Network</td><td className="right">{cfg?.networkName} · {cfg?.chainId}</td></tr>
        </tbody></table></div>
        {treasury?.userId && (
          <div className="between" style={{ marginTop: 14, gap: 12, flexWrap: "wrap" }}>
            <p className="csub" style={{ margin: 0, maxWidth: 460 }}>
              You're signed in on this device via <b>email</b>. Add this device's Touch/Face&nbsp;ID so next
              time you can unlock in one tap — no email. The same wallet gains an extra passkey; nothing moves.
            </p>
            <button className="btn primary" disabled={busy || !sessionActive}
              title={sessionActive ? "Register this device's passkey" : "Create a session first"}
              onClick={() => addDevicePasskey().catch(() => {})}>
              <Icon.key size={15} /> Add this device
            </button>
          </div>
        )}
      </div>

      <div className="card" style={{ borderColor: "rgba(248,113,113,.3)" }}>
        <h3 style={{ color: "var(--err)" }}>Danger zone</h3>
        <p className="csub">Disconnect removes the treasury from this browser (re-add it by connecting the same passkey). Reset wipes the local demo store only.</p>
        <div className="flex">
          <button className="btn" onClick={disconnectTreasury}><Icon.logout size={15} /> Disconnect treasury</button>
          <button className="btn danger" onClick={resetData}><Icon.trash size={15} /> Reset local data</button>
        </div>
      </div>
    </div>
  );
}
