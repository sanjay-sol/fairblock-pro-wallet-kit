import { useState } from "react";
import { useOrg } from "../state/OrgContext.jsx";
import { Icon } from "../components/Icons.jsx";
import { EmptyState } from "../components/ui.jsx";
import { initialsOf } from "../lib/format.js";

export default function Team() {
  const { members, treasury, addMember, removeMember, threshold, busy, payouts, appBatches } = useOrg();
  const [show, setShow] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const canManage = treasury?.role === "owner" || treasury?.role === "admin";
  const isOwner = treasury?.role === "owner";
  const signers = members.filter((m) => m.status === "active");
  // Count both single/Turnkey payouts AND app-approval batches still awaiting approval — removing a
  // co-signer mid-approval can strand either (a payout can't reach its threshold; a batch either).
  const pendingCount = payouts.filter((p) => p.status === "pending").length
    + (appBatches || []).filter((b) => b.status === "pending_approval").length;
  const removalLocked = pendingCount > 0;

  async function invite() {
    if (!email.trim()) return;
    try { await addMember({ email: email.trim().toLowerCase(), name: name.trim() }); setName(""); setEmail(""); setShow(false); } catch { /* toast */ }
  }

  return (
    <div className="page">
      <div className="page-head between">
        <div><h1>Team</h1><p>Add members to this Organisation. Payouts right now configured to <b>{threshold} of {signers.length}</b> members approval.</p></div>
        {canManage && <button className="btn primary" onClick={() => setShow((s) => !s)}><Icon.plus size={15} /> Invite Member</button>}
      </div>

      {show && (
        <div className="card">
          <h3>Add a Member</h3>
          <p className="csub">They'll get an email to sign in with this address. They can view balances and approve payouts.</p>
          <div className="card-row cols-2">
            <div className="field" style={{ margin: 0 }}><label className="fld">Name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Member 1" /></div>
            <div className="field" style={{ margin: 0 }}><label className="fld">Email</label><input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="member1@company.com" onKeyDown={(e) => e.key === "Enter" && invite()} /></div>
          </div>
          <div className="flex" style={{ marginTop: 12 }}>
            <button className="btn ghost" onClick={() => setShow(false)}>Cancel</button>
            <button className="btn primary" disabled={busy || !email.trim()} onClick={invite}>Send invite</button>
          </div>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginBottom: 14 }}>Members ({signers.length})</h3>
        {isOwner && removalLocked && <p className="hint" style={{ marginTop: -6, marginBottom: 14, color: "var(--warn)" }}> Removing members is locked while {pendingCount} approval{pendingCount === 1 ? " is" : "s are"} pending - resolve or reject them first.</p>}
        {signers.length === 0 ? (
          <EmptyState icon={<Icon.team size={24} />} title="No team yet">Add organisation members so payouts require multiple approvals.</EmptyState>
        ) : (
          <div className="table-wrap"><table>
            <thead><tr><th>Member</th><th>Email</th><th>Role</th><th>Status</th><th className="right">Action</th></tr></thead>
            <tbody>
              {signers.map((m) => (
                <tr key={m.email}>
                  <td><div className="flex"><div className="avatar" style={{ width: 30, height: 30, fontSize: 12, borderRadius: "50%", background: "var(--card-3)", color: "var(--ink)", display: "grid", placeItems: "center", fontWeight: 700 }}>{initialsOf(m.name || m.email)}</div>{m.name || "—"}</div></td>
                  <td className="muted">{m.email}</td>
                  <td><span className={`badge ${m.role === "owner" ? "owner" : "ok"}`} style={{ textTransform: "capitalize" }}>{m.role}</span></td>
                  <td><span className="badge ok">{m.status}</span></td>
                  <td className="right">{isOwner && m.role !== "owner" ? <button className="btn sm danger" disabled={busy || removalLocked} title={removalLocked ? "Resolve pending payouts before removing members" : "Remove member"} onClick={() => removeMember(m.email)}><Icon.trash size={13} /></button> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
