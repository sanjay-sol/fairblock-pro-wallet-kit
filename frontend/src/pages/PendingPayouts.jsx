import { useOrg } from "../state/OrgContext.jsx";
import { Icon } from "../components/Icons.jsx";
import { EmptyState, AsyncButton } from "../components/ui.jsx";
import { short, fmtAmount, fmtDate } from "../lib/format.js";

export default function PendingPayouts() {
  const { payouts, approvePayout, rejectPayout, threshold, members, session, treasury, busy } = useOrg();
  const pending = payouts.filter((p) => p.status === "pending");
  const myEmail = (session?.email || "").toLowerCase();
  const canApprove = treasury?.role === "owner" || treasury?.role === "admin";
  const signerCount = members.filter((m) => m.status === "active").length;

  return (
    <div className="page">
      <div className="page-head"><h1>Pending Payouts</h1><p>Payouts awaiting co-signer approval — each needs <b>{threshold} of {signerCount}</b> admins to approve, then it settles on-chain automatically.</p></div>

      {pending.length === 0 ? (
        <div className="card"><EmptyState icon={<Icon.pending size={24} />} title="No pending payouts">Proposed payouts will appear here for you and your team to co-sign.</EmptyState></div>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          {pending.map((p) => {
            const approvals = (p.approvals || []).map((a) => String(a).toLowerCase());
            const iApproved = approvals.includes(myEmail);
            const count = approvals.length;
            return (
              <div key={p.id} className="card">
                <div className="between" style={{ flexWrap: "wrap", gap: 12 }}>
                  <div>
                    <div className="flex" style={{ gap: 8 }}>
                      <b style={{ fontSize: 17 }}>{fmtAmount(p.amount, p.tokenSymbol)}</b>
                      <span className="badge brand">{p.delivery === "confidential" ? "Confidential" : "Direct"}</span>
                    </div>
                    <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>→ {p.recipientLabel ? `${p.recipientLabel} · ` : ""}<span className="mono">{short(p.recipient)}</span></div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Proposed by {p.createdByName || p.createdBy} · {fmtDate(p.createdAt)}{p.note ? ` · ${p.note}` : ""}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div className="flex" style={{ gap: 5, justifyContent: "flex-end", marginBottom: 8, alignItems: "center" }}>
                      {Array.from({ length: signerCount }).map((_, i) => <span key={i} className="dot" style={{ background: i < count ? "var(--ok)" : "var(--card-3)", width: 9, height: 9 }} />)}
                      <span className="muted" style={{ fontSize: 12.5, marginLeft: 4 }}>{count}/{threshold} approved</span>
                    </div>
                    <div className="flex" style={{ justifyContent: "flex-end" }}>
                      <AsyncButton className="btn sm" onClick={() => rejectPayout(p)} disabled={busy}><Icon.x size={13} /> Reject</AsyncButton>
                      {canApprove && (iApproved
                        ? <span className="btn sm" style={{ opacity: .6, pointerEvents: "none" }}><Icon.check size={13} /> You approved</span>
                        : <AsyncButton className="btn sm primary" onClick={() => approvePayout(p)} disabled={busy} loadingText="Signing…"><Icon.check size={13} /> Approve &amp; sign</AsyncButton>)}
                    </div>
                  </div>
                </div>
                {approvals.length > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 10, borderTop: "1px solid var(--line)", paddingTop: 10 }}>Signed by: {approvals.join(", ")}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
