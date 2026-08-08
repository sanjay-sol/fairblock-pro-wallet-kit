import { useOrg } from "../state/OrgContext.jsx";
import { Icon } from "../components/Icons.jsx";
import { EmptyState } from "../components/ui.jsx";
import { short, fmtAmount, fmtDate } from "../lib/format.js";

export default function PendingPayouts() {
  const { txs, approvePayout, rejectPayout, busy, sessionActive } = useOrg();
  const pending = txs.filter((t) => t.status === "pending");

  return (
    <div className="page">
      <div className="page-head">
        <h1>Pending Payouts</h1>
        <p>Payout requests from your team awaiting review and approval. Approving signs and settles it on-chain.</p>
      </div>

      {!sessionActive && pending.length > 0 && (
        <div className="devbar"><Icon.lock size={15} /> Create a session (top-right) to approve without a passkey prompt per payout.</div>
      )}

      {pending.length === 0 ? (
        <div className="card"><EmptyState icon="✅" title="No pending payouts">Requests submitted by team members will appear here for your review and approval.</EmptyState></div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Requested by</th><th>Recipient</th><th>Amount</th><th>Delivery</th><th>Note</th><th>Requested</th><th className="right">Action</th></tr>
            </thead>
            <tbody>
              {pending.map((t) => (
                <tr key={t.id}>
                  <td>{t.createdBy}<div className="muted" style={{ fontSize: 11 }}>{t.createdByRole}</div></td>
                  <td>{t.recipientLabel || ""}<div className="mono muted" style={{ fontSize: 12 }}>{short(t.to)}</div></td>
                  <td className="nowrap"><b>{fmtAmount(t.amount, t.tokenSymbol)}</b></td>
                  <td>{t.delivery === "confidential" ? <span className="badge brand">Confidential</span> : <span className="badge">Direct</span>}</td>
                  <td className="muted">{t.note || "—"}</td>
                  <td className="muted nowrap">{fmtDate(t.createdAt)}</td>
                  <td className="right nowrap">
                    <button className="btn sm" disabled={busy} onClick={() => rejectPayout(t)} style={{ marginRight: 6 }}><Icon.x size={13} /> Reject</button>
                    <button className="btn sm primary" disabled={busy} onClick={() => approvePayout(t)}><Icon.check size={13} /> Approve & pay</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
