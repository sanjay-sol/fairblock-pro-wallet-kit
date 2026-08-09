import { useMemo, useState } from "react";
import { useOrg } from "../state/OrgContext.jsx";
import { Icon } from "../components/Icons.jsx";
import { EmptyState, StatusBadge, KindBadge } from "../components/ui.jsx";
import { short, fmtAmount, fmtDate } from "../lib/format.js";

export default function TransactionHistory() {
  const { txs, cfg } = useOrg();
  const [kind, setKind] = useState("all");
  const [status, setStatus] = useState("all");
  const [source, setSource] = useState("all");
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    return txs.filter((t) => {
      if (kind !== "all" && t.kind !== kind) return false;
      if (status !== "all" && t.status !== status) return false;
      if (source !== "all" && (t.delivery || "") !== source) return false;
      if (q) {
        const s = q.toLowerCase();
        if (!(`${t.to || ""} ${t.recipientLabel || ""} ${t.txHash || ""}`.toLowerCase().includes(s))) return false;
      }
      return true;
    });
  }, [txs, kind, status, source, q]);

  function exportCsv() {
    const cols = ["createdAt", "kind", "status", "recipientLabel", "to", "amount", "tokenSymbol", "delivery", "txHash", "batchId", "note"];
    const head = cols.join(",");
    const body = filtered.map((t) => cols.map((c) => `"${String(t[c] ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([head + "\n" + body], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = "transactions.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  function reset() { setKind("all"); setStatus("all"); setSource("all"); setQ(""); }

  return (
    <div className="page">
      <div className="page-head between">
        <div><h1>Transaction History</h1><p>Full audit trail of all organization payouts, deposits, and withdrawals.</p></div>
        <button className="btn" onClick={exportCsv}><Icon.download size={15} /> Export CSV</button>
      </div>

      <div className="card" style={{ padding: 14, marginBottom: 14 }}>
        <div className="flex wrap">
          <input placeholder="Search address / label / tx" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />
          <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ maxWidth: 150 }}>
            <option value="all">All types</option><option value="payout">Payout</option><option value="deposit">Deposit</option><option value="withdraw">Withdraw</option>
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 150 }}>
            <option value="all">All statuses</option><option value="completed">Completed</option><option value="pending">Pending</option><option value="failed">Failed</option>
          </select>
          <select value={source} onChange={(e) => setSource(e.target.value)} style={{ maxWidth: 170 }}>
            <option value="all">All delivery</option><option value="confidential">Confidential</option><option value="direct">Direct</option>
          </select>
          <button className="btn sm ghost" onClick={reset}>Reset filters</button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card"><EmptyState icon={<Icon.history size={24} />} title="No activity yet">Payouts, deposits, and withdrawals will appear here.</EmptyState></div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Type</th><th>Recipient</th><th>Amount</th><th>Delivery</th><th>Status</th><th>Tx</th><th>When</th></tr>
            </thead>
            <tbody>
              {filtered.map((t) => (
                <tr key={t.id}>
                  <td><KindBadge kind={t.kind} />{t.batchId && <span className="badge" style={{ marginLeft: 6 }}>batch</span>}</td>
                  <td>{t.recipientLabel || ""}<div className="mono muted" style={{ fontSize: 12 }}>{short(t.to)}</div></td>
                  <td className="nowrap">{t.kind === "deposit" ? "+" : t.kind === "payout" ? "−" : ""}{fmtAmount(t.amount, t.tokenSymbol)}</td>
                  <td>{t.delivery === "confidential" ? <span className="badge brand">Confidential</span> : <span className="badge">Direct</span>}</td>
                  <td><StatusBadge status={t.status} /></td>
                  <td>{t.txHash ? <span className="mono muted">{short(t.txHash)}</span> : t.error ? <span className="badge err" title={t.error}>error</span> : "—"}</td>
                  <td className="muted nowrap">{fmtDate(t.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
