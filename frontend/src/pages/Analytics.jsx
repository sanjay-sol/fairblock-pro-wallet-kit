import { useOrg } from "../state/OrgContext.jsx";
import { Stat, EmptyState } from "../components/ui.jsx";
import { fmtUsd, fmtAmount } from "../lib/format.js";

function BarList({ data, symbol }) {
  const entries = Object.entries(data || {});
  if (!entries.length) return <EmptyState icon="📈" title="No data yet" />;
  const max = Math.max(...entries.map(([, v]) => v)) || 1;
  return (
    <div className="barlist">
      {entries.map(([k, v]) => (
        <div className="barrow" key={k}>
          <div className="bl"><span>{k}</span><span className="muted">{fmtAmount(v, symbol)}</span></div>
          <div className="bartrack"><div className="barfill" style={{ width: `${(v / max) * 100}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

function MonthlyChart({ monthly, symbol }) {
  const entries = Object.entries(monthly || {}).sort(([a], [b]) => (a < b ? -1 : 1));
  if (!entries.length) return <EmptyState icon="📊" title="No payout volume yet">Confidential payouts will chart here.</EmptyState>;
  const max = Math.max(...entries.map(([, v]) => v)) || 1;
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 10, height: 200, paddingTop: 12 }}>
      {entries.map(([k, v]) => (
        <div key={k} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: 11 }} className="muted">{fmtAmount(v, symbol)}</div>
          <div style={{ width: "100%", maxWidth: 46, height: `${Math.max(4, (v / max) * 150)}px`, background: "linear-gradient(180deg,var(--brand),#b06dff)", borderRadius: "6px 6px 0 0" }} />
          <div style={{ fontSize: 11 }} className="muted">{k.slice(5)}/{k.slice(2, 4)}</div>
        </div>
      ))}
    </div>
  );
}

export default function Analytics() {
  const { analytics, symbol } = useOrg();
  const privacyMix = analytics?.byDelivery
    ? {
        Confidential: analytics.byDelivery.confidential || 0,
        Direct: analytics.byDelivery.direct || 0,
      }
    : {};

  return (
    <div className="page">
      <div className="page-head"><h1>Analytics</h1><p>Confidential payout activity across your organization's treasury.</p></div>

      <div className="stats" style={{ marginBottom: 16 }}>
        <Stat k="Total volume" icon="analytics" accent>{fmtUsd(analytics?.totalVolume)}</Stat>
        <Stat k="Total payouts" icon="single">{analytics?.totalPayouts ?? 0}</Stat>
        <Stat k="Active recipients" icon="team">{analytics?.activeRecipients ?? 0}</Stat>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="between" style={{ marginBottom: 6 }}><h3>Payout volume</h3><span className="muted" style={{ fontSize: 12.5 }}>Last 12 months</span></div>
        <MonthlyChart monthly={analytics?.monthly} symbol={symbol} />
      </div>

      <div className="card-row cols-2">
        <div className="card"><h3 style={{ marginBottom: 16 }}>Asset distribution</h3><BarList data={analytics?.byAsset} symbol={symbol} /></div>
        <div className="card"><h3 style={{ marginBottom: 16 }}>Privacy mix</h3><BarList data={privacyMix} symbol={symbol} /></div>
      </div>
    </div>
  );
}
