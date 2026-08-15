import { useMemo, useState } from "react";
import { useOrg } from "../state/OrgContext.jsx";
import { Icon } from "../components/Icons.jsx";
import { EmptyState, StatusBadge, KindBadge, ChainBadge } from "../components/ui.jsx";
import { short, fmtAmount, fmtDate } from "../lib/format.js";
import { explorerTx } from "../networks.js";

export default function TransactionHistory() {
  const { payouts, settling } = useOrg();
  const [status, setStatus] = useState("all");
  const [q, setQ] = useState("");

  const filtered = useMemo(() => payouts.filter((t) => {
    if (status !== "all" && t.status !== status) return false;
    if (q) { const s = q.toLowerCase(); if (!(`${t.recipient || ""} ${t.recipientLabel || ""} ${t.txHash || ""}`.toLowerCase().includes(s))) return false; }
    return true;
  }), [payouts, status, q]);

  return (
    <div className="page">
      <div className="page-head between"><div><h1>Transaction History</h1><p> Amounts are decrypted locally with your key.</p></div></div>

      <div className="card" style={{ padding: 14, marginBottom: 14 }}>
        <div className="flex wrap">
          <input placeholder="Search address / label / tx" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 160 }}>
            <option value="all">All statuses</option><option value="completed">Completed</option><option value="pending">Pending</option><option value="rejected">Rejected</option><option value="failed">Failed</option>
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card"><EmptyState icon={<Icon.history size={24} />} title="No activity yet">Payouts and deposits will appear here.</EmptyState></div>
      ) : (
        <div className="table-wrap"><table>
          <thead><tr><th>Type</th><th>Recipient</th><th>Amount</th><th>Network</th><th>Delivery</th><th>Status</th><th>Tx</th><th>When</th></tr></thead>
          <tbody>
            {filtered.map((t) => (
              <tr key={t.id}>
                <td><KindBadge kind={t.kind} /></td>
                <td>{t.recipientLabel || ""}<div className="mono muted" style={{ fontSize: 12 }}>{short(t.recipient)}</div></td>
                <td className="nowrap">{["deposit", "claim", "received"].includes(t.kind) ? "+" : "−"}{fmtAmount(t.amount, t.tokenSymbol)}</td>
                <td><ChainBadge chainId={t.chainId} /></td>
                <td>{t.delivery === "confidential" ? <span className="badge brand">Confidential</span> : <span className="badge">Direct</span>}</td>
                <td>{settling && t.txHash && t.txHash === settling.txHash ? <span className="badge warn">Settling…</span> : <StatusBadge status={t.status} />}</td>
                <td>{t.txHash ? <a className="mono muted" href={t.explorerUrl || explorerTx(t.chainId, t.txHash)} target="_blank" rel="noreferrer">{short(t.txHash)}</a> : t.error ? <span className="badge err" title={t.error}>error</span> : "—"}</td>
                <td className="muted nowrap">{fmtDate(t.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  );
}
