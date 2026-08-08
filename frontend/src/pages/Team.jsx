import { useState } from "react";
import { useOrg } from "../state/OrgContext.jsx";
import { api } from "../lib/api.js";
import { Icon } from "../components/Icons.jsx";
import { EmptyState } from "../components/ui.jsx";
import { initialsOf, fmtDate } from "../lib/format.js";

const ROLES = [
  { v: "admin", label: "Admin", desc: "Create + approve payouts, manage team" },
  { v: "member", label: "Member", desc: "Create payout requests (need approval)" },
  { v: "viewer", label: "Viewer", desc: "Read-only: analytics + history" },
];

export default function Team() {
  const { team, owner, reloadTeam, toast } = useOrg();
  const [show, setShow] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [saving, setSaving] = useState(false);

  async function invite() {
    if (!email.trim()) return;
    setSaving(true);
    try {
      await api.addMember({ name: name.trim(), email: email.trim(), role });
      await reloadTeam();
      setName(""); setEmail(""); setRole("member"); setShow(false);
      toast("Member invited ✓", "ok");
    } catch (e) { toast(e.message, "error"); } finally { setSaving(false); }
  }
  async function changeRole(id, r) { await api.updateMember(id, { role: r }); await reloadTeam(); }
  async function remove(id) { await api.removeMember(id); await reloadTeam(); toast("Member removed", "muted"); }

  return (
    <div className="page">
      <div className="page-head between">
        <div><h1>Team</h1><p>Permissioned, multi-user access so finance can operate together with roles.</p></div>
        <button className="btn primary" onClick={() => setShow((s) => !s)}><Icon.plus size={15} /> Invite member</button>
      </div>

      {show && (
        <div className="card">
          <h3>Invite a team member</h3>
          <div className="card-row cols-3">
            <div className="field" style={{ margin: 0 }}><label className="fld">Name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" /></div>
            <div className="field" style={{ margin: 0 }}><label className="fld">Email</label><input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@example.com" /></div>
            <div className="field" style={{ margin: 0 }}><label className="fld">Role</label>
              <select value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}</select>
            </div>
          </div>
          <p className="hint">{ROLES.find((r) => r.v === role)?.desc}</p>
          <div className="flex" style={{ marginTop: 12 }}>
            <button className="btn ghost" onClick={() => setShow(false)}>Cancel</button>
            <button className="btn primary" disabled={saving || !email.trim()} onClick={invite}>Send invite</button>
          </div>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginBottom: 14 }}>Organization owner</h3>
        <div className="flex between" style={{ background: "var(--card-2)", padding: "14px 16px", borderRadius: 12 }}>
          <div className="flex">
            <div className="avatar" style={{ width: 40, height: 40, borderRadius: "50%", background: "linear-gradient(135deg,#3ecf8e,#1f9d6b)", display: "grid", placeItems: "center", color: "#06210f", fontWeight: 800 }}>{initialsOf(owner?.name || "Owner")}</div>
            <div><div style={{ fontWeight: 600 }}>{owner?.name || "Treasury Owner"} <span className="badge owner">Owner</span></div><div className="muted" style={{ fontSize: 12.5 }}>{owner?.email || "no email set"}</div></div>
          </div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 14 }}>Team members</h3>
        {team.length === 0 ? (
          <EmptyState icon="👥" title="No team members yet">Invite people to your organization so they can collaborate with you.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Member</th><th>Email</th><th>Role</th><th>Status</th><th>Invited</th><th className="right">Action</th></tr></thead>
              <tbody>
                {team.map((m) => (
                  <tr key={m.id}>
                    <td><div className="flex"><div className="avatar" style={{ width: 30, height: 30, fontSize: 12, borderRadius: "50%", background: "var(--card-3)", color: "var(--ink)", display: "grid", placeItems: "center", fontWeight: 700 }}>{initialsOf(m.name)}</div>{m.name}</div></td>
                    <td className="muted">{m.email}</td>
                    <td><select value={m.role} onChange={(e) => changeRole(m.id, e.target.value)} style={{ maxWidth: 130, padding: "6px 28px 6px 10px" }}>{ROLES.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}</select></td>
                    <td><span className="badge warn">{m.status}</span></td>
                    <td className="muted nowrap">{fmtDate(m.invitedAt)}</td>
                    <td className="right"><button className="btn sm danger" onClick={() => remove(m.id)}><Icon.trash size={13} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
