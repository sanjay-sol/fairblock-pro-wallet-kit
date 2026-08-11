import { useOrg } from "../state/OrgContext.jsx";
import { Icon } from "../components/Icons.jsx";
import { EmptyState, AsyncButton, ChainBadge } from "../components/ui.jsx";
import { short, fmtAmount, fmtDate } from "../lib/format.js";

const Dots = ({ total, count }) => (
  <>{Array.from({ length: total }).map((_, i) => <span key={i} className="dot" style={{ background: i < count ? "var(--ok)" : "var(--card-3)", width: 9, height: 9 }} />)}</>
);

export default function PendingPayouts() {
  const { payouts, approvePayout, approveBatch, rejectPayout, threshold, signerCount, session, treasury, busy } = useOrg();
  const pending = payouts.filter((p) => p.status === "pending");
  const myEmail = (session?.email || "").toLowerCase();
  const canApprove = treasury?.role === "owner" || treasury?.role === "admin";
  const has = (p) => (p.approvals || []).map((a) => String(a).toLowerCase()).includes(myEmail);

  const batches = {}; const singles = [];
  for (const p of pending) { if (p.batchId) (batches[p.batchId] ||= []).push(p); else singles.push(p); }
  const batchGroups = Object.entries(batches);

  return (
    <div className="page">
      <div className="page-head"><h1>Pending Payouts</h1><p>Awaiting co-signer approval — each needs <b>{threshold} of {signerCount}</b> admins, then it settles on-chain automatically.</p></div>

      {pending.length === 0 ? (
        <div className="card"><EmptyState icon={<Icon.pending size={24} />} title="No pending payouts">Proposed payouts (single or batch) appear here for you and your team to co-sign.</EmptyState></div>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          {batchGroups.map(([bid, list]) => {
            const count = Math.min(...list.map((p) => (p.approvals || []).length)); // batch = its weakest payout
            const total = list.reduce((s, p) => s + (Number(p.amount) || 0), 0);
            const mine = list.filter((p) => !has(p));
            const iApprovedAll = mine.length === 0;
            return (
              <div key={bid} className="card">
                <div className="between" style={{ flexWrap: "wrap", gap: 12 }}>
                  <div>
                    <div className="flex" style={{ gap: 8, alignItems: "center" }}><span className="badge brand">Batch</span><b style={{ fontSize: 16 }}>{list.length} payments</b><span className="muted">· {fmtAmount(total, list[0].tokenSymbol)}</span><ChainBadge chainId={list[0].chainId} /></div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Proposed by {list[0].createdByName || list[0].createdBy} · {fmtDate(list[0].createdAt)}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div className="flex" style={{ gap: 5, justifyContent: "flex-end", marginBottom: 8, alignItems: "center" }}><Dots total={signerCount} count={count} /><span className="muted" style={{ fontSize: 12.5, marginLeft: 4 }}>{count}/{threshold} approved</span></div>
                    <div className="flex" style={{ justifyContent: "flex-end" }}>
                      <AsyncButton className="btn sm" onClick={() => Promise.allSettled(list.map((p) => rejectPayout(p)))} disabled={busy}><Icon.x size={13} /> Reject</AsyncButton>
                      {canApprove && (iApprovedAll
                        ? <span className="btn sm" style={{ opacity: .6, pointerEvents: "none" }}><Icon.check size={13} /> You approved</span>
                        : <AsyncButton className="btn sm primary" onClick={() => approveBatch(mine)} disabled={busy} loadingText="Signing…"><Icon.check size={13} /> Approve batch ({mine.length})</AsyncButton>)}
                    </div>
                  </div>
                </div>
                <div className="table-wrap" style={{ marginTop: 12 }}>
                  <table>
                    <thead><tr><th>Recipient</th><th>Amount</th><th className="right">Approved</th></tr></thead>
                    <tbody>{list.map((p) => (<tr key={p.id}><td>{p.recipientLabel || ""}<div className="mono muted" style={{ fontSize: 12 }}>{short(p.recipient)}</div></td><td className="nowrap">{fmtAmount(p.amount, p.tokenSymbol)}</td><td className="right muted">{(p.approvals || []).length}/{threshold}</td></tr>))}</tbody>
                  </table>
                </div>
              </div>
            );
          })}

          {singles.map((p) => {
            const approvals = (p.approvals || []).map((a) => String(a).toLowerCase());
            const count = approvals.length;
            return (
              <div key={p.id} className="card">
                <div className="between" style={{ flexWrap: "wrap", gap: 12 }}>
                  <div>
                    <div className="flex" style={{ gap: 8 }}><b style={{ fontSize: 17 }}>{fmtAmount(p.amount, p.tokenSymbol)}</b><span className="badge brand">{p.delivery === "confidential" ? "Confidential" : "Direct"}</span><ChainBadge chainId={p.chainId} /></div>
                    <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>→ {p.recipientLabel ? `${p.recipientLabel} · ` : ""}<span className="mono">{short(p.recipient)}</span></div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Proposed by {p.createdByName || p.createdBy} · {fmtDate(p.createdAt)}{p.note ? ` · ${p.note}` : ""}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div className="flex" style={{ gap: 5, justifyContent: "flex-end", marginBottom: 8, alignItems: "center" }}><Dots total={signerCount} count={count} /><span className="muted" style={{ fontSize: 12.5, marginLeft: 4 }}>{count}/{threshold} approved</span></div>
                    <div className="flex" style={{ justifyContent: "flex-end" }}>
                      <AsyncButton className="btn sm" onClick={() => rejectPayout(p)} disabled={busy}><Icon.x size={13} /> Reject</AsyncButton>
                      {canApprove && (has(p)
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
