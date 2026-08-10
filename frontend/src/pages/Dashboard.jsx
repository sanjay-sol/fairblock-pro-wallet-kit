import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useOrg } from "../state/OrgContext.jsx";
import { Icon } from "../components/Icons.jsx";
import { Stat, EmptyState, StatusBadge, KindBadge, CopyBtn, AsyncButton } from "../components/ui.jsx";
import { short, fmtAmount, fmtUsd, fmtDate } from "../lib/format.js";

export default function Dashboard() {
  const nav = useNavigate();
  const { treasury, balances, nativeBalance, symbol, nativeSymbol, network, payouts, analytics, busy, threshold, members, activateTreasury, depositToConfidential, refreshBalances } = useOrg();
  const [depAmt, setDepAmt] = useState("100");

  const hasGas = Number(nativeBalance) > 0;
  const hasToken = Number(balances.public) > 0;
  const hasConfidential = Number(balances.confidential.available) > 0;
  const needsFunding = !hasGas || (!hasToken && !hasConfidential);
  const recent = payouts.slice(0, 6);
  const pending = payouts.filter((p) => p.status === "pending").length;
  const signerCount = members.filter((m) => m.status === "active").length;

  return (
    <div className="page">
      {needsFunding && (
        <div className="card" style={{ marginBottom: 16, borderColor: "var(--brand)", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <Icon.wallet size={20} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <b>Fund your treasury to get started</b>
            <p className="csub" style={{ margin: "4px 0 0" }}>{!hasGas ? `Add ${nativeSymbol} for gas` : `Add ${symbol}`} on {network?.name} — from a faucet or another wallet.</p>
          </div>
          <button className="btn primary" onClick={() => nav("/fund")}><Icon.receive size={15} /> Fund wallet</button>
        </div>
      )}

      <div className="card-row cols-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="between">
            <h3>Treasury</h3>
            <span className={`badge ${treasury.activated ? "ok" : "warn"}`}>{treasury.activated ? "confidential ready" : "not activated"}</span>
          </div>
          <div className="flex" style={{ margin: "10px 0 16px" }}><span className="mono muted">{short(treasury.address)}</span><CopyBtn value={treasury.address} label="" /></div>
          <div className="stats" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <Stat k="Public balance" icon="wallet">{fmtAmount(balances.public)} <small>{symbol}</small></Stat>
            <Stat k="Confidential (available)" icon="shield" accent>{fmtAmount(balances.confidential.available)} <small>{symbol}</small></Stat>
          </div>
          <div className="stats" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 10 }}>
            <Stat k={`Gas (${nativeSymbol})`} icon="coin">{fmtAmount(nativeBalance)}</Stat>
            <Stat k="Approvals" icon="team">{threshold}-of-{signerCount}</Stat>
          </div>
          <div className="flex wrap" style={{ marginTop: 16 }}>
            <button className="btn sm" onClick={() => nav("/fund")}><Icon.receive size={14} /> Deposit</button>
            {!treasury.activated && <AsyncButton className="btn sm primary" onClick={activateTreasury} disabled={busy} loadingText="Deriving…"><Icon.shield size={14} /> Derive confidential keys</AsyncButton>}
            <AsyncButton className="btn sm ghost" onClick={() => refreshBalances()} disabled={busy}><Icon.refresh size={14} /> Refresh</AsyncButton>
          </div>
        </div>

        <div className="card">
          <h3>Load confidential balance</h3>
          <p className="csub">Move public {symbol} into the treasury's confidential balance — the pool payouts draw from.</p>
          <label className="fld" style={{ marginTop: 12 }}>Amount ({symbol})</label>
          <div className="inline">
            <input value={depAmt} onChange={(e) => setDepAmt(e.target.value)} />
            <AsyncButton className="btn primary" style={{ flex: "0 0 auto" }} disabled={busy || !treasury.activated || !(Number(depAmt) > 0)} onClick={() => depositToConfidential(depAmt)} loadingText="Depositing…"><Icon.download size={15} /> Deposit</AsyncButton>
          </div>
          {!treasury.activated && <p className="hint" style={{ marginTop: 10 }}>Derive your confidential keys first.</p>}
          {threshold > 1 && <p className="hint" style={{ marginTop: 10 }}>Tip: activate + fund while the treasury is <b>1-of-1</b>, then raise the approval threshold for payouts.</p>}
        </div>
      </div>

      <div className="stats" style={{ marginBottom: 16 }}>
        <Stat k="Total payout volume" icon="analytics">{fmtUsd(analytics?.totalVolume)}</Stat>
        <Stat k="Total payouts" icon="single">{analytics?.totalPayouts ?? 0}</Stat>
        <Stat k="Team signers" icon="team">{signerCount}</Stat>
        <Stat k="Pending approvals" icon="pending">{pending}</Stat>
      </div>

      <div className="card-row cols-2" style={{ marginBottom: 16 }}>
        <button className="card" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => nav("/single")}>
          <div className="between"><h3><Icon.single size={16} /> &nbsp;Single Payout</h3><Icon.chevR size={16} /></div>
          <p className="csub" style={{ margin: "8px 0 0" }}>Send (or propose) a confidential payment.</p>
        </button>
        <button className="card" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => nav("/pending")}>
          <div className="between"><h3><Icon.pending size={16} /> &nbsp;Pending Payouts</h3><Icon.chevR size={16} /></div>
          <p className="csub" style={{ margin: "8px 0 0" }}>Review + co-sign requests awaiting approval.</p>
        </button>
      </div>

      <div className="card">
        <div className="between" style={{ marginBottom: 14 }}><h3>Recent activity</h3><button className="btn sm ghost" onClick={() => nav("/history")}>View all <Icon.chevR size={14} /></button></div>
        {recent.length === 0 ? (
          <EmptyState icon={<Icon.history size={24} />} title="No activity yet">Deposits and payouts will show up here.</EmptyState>
        ) : (
          <div className="table-wrap"><table>
            <thead><tr><th>Type</th><th>Recipient</th><th>Amount</th><th>Status</th><th>When</th></tr></thead>
            <tbody>
              {recent.map((t) => (
                <tr key={t.id}>
                  <td><KindBadge kind={t.kind} /></td>
                  <td>{t.recipientLabel || <span className="mono">{short(t.recipient)}</span>}</td>
                  <td className="nowrap">{t.kind === "deposit" ? "+" : "−"}{fmtAmount(t.amount, t.tokenSymbol)}</td>
                  <td><StatusBadge status={t.status} /></td>
                  <td className="muted nowrap">{fmtDate(t.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
