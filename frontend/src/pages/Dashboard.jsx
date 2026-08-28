import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useOrg } from "../state/OrgContext.jsx";
import { Icon } from "../components/Icons.jsx";
import { Stat, EmptyState, StatusBadge, KindBadge, CopyBtn, AsyncButton, TokenSelect } from "../components/ui.jsx";
import { short, fmtAmount, fmtUsd, fmtDate } from "../lib/format.js";

export default function Dashboard() {
  const nav = useNavigate();
  const { treasury, balances, nativeBalance, symbol, nativeSymbol, network, payouts, analytics, busy, threshold, signerCount, activateTreasury, depositToConfidential, claimPending, settling, refreshBalances, reloadPayouts } = useOrg();
  const settleVerb = settling && (settling.kind === "deposit" ? "deposited" : settling.kind === "transfer" ? "sent" : "claimed");
  const [depAmt, setDepAmt] = useState("100");

  const hasGas = Number(nativeBalance) > 0;
  const hasToken = Number(balances.public) > 0;
  const hasConfidential = Number(balances.confidential.available) > 0;
  const needsFunding = !hasGas || (!hasToken && !hasConfidential);
  const recent = payouts.slice(0, 6);
  const pending = payouts.filter((p) => p.status === "pending").length;
  const refreshAll = async () => { await reloadPayouts(); await refreshBalances(); };

  // Live getting-started guide — highlights the step you're on; each is clickable.
  const funded = hasGas && (hasToken || hasConfidential);
  const setupCurrent = !funded ? 0 : !treasury.activated ? 1 : !hasConfidential ? 2 : 3;
  const setupSteps = [
    { label: "Deposit", done: funded, go: () => nav("/fund") },
    { label: "Derive confidential keys", done: treasury.activated, go: () => { if (!treasury.activated) activateTreasury(); } },
    { label: "Load confidential balance", done: hasConfidential, go: () => document.getElementById("deposit-card")?.scrollIntoView({ behavior: "smooth", block: "center" }) },
    { label: "Send a payout", done: false, go: () => nav("/single") },
  ];

  return (
    <div className="page">
      <div className="card" style={{ marginBottom: 16, padding: "12px 16px" }}>
        <div className="flex between" style={{ marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
          {/* <b style={{ fontSize: 11.5, letterSpacing: ".4px", textTransform: "uppercase", color: "var(--muted)" }}>Getting started</b> */}
        </div>
        <div className="stepper" style={{ marginBottom: 0, flexWrap: "wrap" }}>
          {setupSteps.map((s, i) => (
            <div key={s.label} style={{ display: "contents" }}>
              <button className={`step ${i === setupCurrent ? "active" : ""} ${s.done ? "done" : ""}`} onClick={s.go} title={s.label} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit" }}>
                <span className="n">{s.done ? <Icon.check size={13} /> : i + 1}</span>
                <span>{s.label}</span>
              </button>
              {i < setupSteps.length - 1 && <span className="bar" />}
            </div>
          ))}
        </div>
      </div>

      {needsFunding && (
        <div className="card" style={{ marginBottom: 16, borderColor: "var(--brand)", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <Icon.wallet size={20} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <b>Fund your treasury to get started</b>
            <p className="csub" style={{ margin: "4px 0 0" }}>{!hasGas ? `Add ${nativeSymbol} for gas` : `Add ${symbol}`} on {network?.name}</p>
          </div>
          <button className="btn primary" onClick={() => nav("/fund")}><Icon.receive size={15} /> Deposit</button>
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

          {/* Any confirmed op (deposit / transfer / claim) settles on-chain ~30-60s after its receipt —
              show a "settling" state during that window. Otherwise, received funds sitting in `pending`
              get a Claim CTA. Only one of these shows at a time. */}
          {settling ? (
            <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 10, border: "1px solid var(--brand)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <span className="spinner" />
              <div style={{ flex: 1, minWidth: 150 }}>
                <div>{settling.amountLabel ? <><b>{fmtAmount(settling.amountLabel, symbol)}</b> {settleVerb}</> : <b style={{ textTransform: "capitalize" }}>{settleVerb}</b>} - settling onchain</div>
                {/* <p className="hint" style={{ margin: "2px 0 0" }}>Other operations are paused until it settles.</p> */}
              </div>
            </div>
          ) : Number(balances.confidential.pending) > 0 ? (
            <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 10, border: "1px solid var(--brand)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <span style={{ color: "var(--brand)", display: "flex" }}><Icon.download size={18} /></span>
              <div style={{ flex: 1, minWidth: 150 }}>
                <div><b>{fmtAmount(balances.confidential.pending, symbol)}</b> received &amp; pending</div>
                <p className="hint" style={{ margin: "2px 0 0" }}>{threshold > 1 ? "Claim it to move it into your spendable confidential balance." : "Claim it now, or it will be applied automatically on your next deposit or transfer."}</p>
              </div>
              <AsyncButton className="btn sm primary" onClick={claimPending} disabled={busy} loadingText="Claiming…"><Icon.download size={14} /> Claim</AsyncButton>
            </div>
          ) : null}

          <div className="flex wrap" style={{ marginTop: 16 }}>
            <button className="btn sm" onClick={() => nav("/fund")}><Icon.receive size={14} /> Deposit</button>
            {!treasury.activated && <AsyncButton className="btn sm primary" onClick={activateTreasury} disabled={busy} loadingText="Deriving…"><Icon.shield size={14} /> Derive confidential keys</AsyncButton>}
            <AsyncButton className="btn sm ghost" onClick={refreshAll} disabled={busy}><Icon.refresh size={14} /> Refresh</AsyncButton>
          </div>
        </div>

        <div className="card" id="deposit-card">
          <h3>Load confidential balance</h3>
          <p className="csub">Move public {symbol} into the treasury's confidential balance.</p>
          <label className="fld" style={{ marginTop: 12 }}>Token</label>
          <TokenSelect />
          <label className="fld" style={{ marginTop: 12 }}>Amount ({symbol})</label>
          <div className="inline">
            <input value={depAmt} onChange={(e) => setDepAmt(e.target.value)} />
            <AsyncButton className="btn primary" style={{ flex: "0 0 auto" }} disabled={busy || !!settling || !treasury.activated || !(Number(depAmt) > 0)} onClick={() => depositToConfidential(depAmt)} loadingText="Depositing…"><Icon.download size={15} /> Deposit</AsyncButton>
          </div>
          {settling && <p className="hint" style={{ marginTop: 10 }}>An operation is settling onchain - you can deposit again once it finishes.</p>}
          {!treasury.activated && <p className="hint" style={{ marginTop: 10 }}>Derive your confidential keys first.</p>}
          {threshold > 1 && <p className="hint" style={{ marginTop: 10 }}>Any single admin can fund the pool (deposits are <b>1-of-{signerCount}</b>). Only payouts require <b>{threshold}-of-{signerCount}</b> approval.</p>}
        </div>
      </div>

      <div className="stats" style={{ marginBottom: 16 }}>
        <Stat k="Total payout volume" icon="analytics">{fmtUsd(analytics?.totalVolume)}</Stat>
        <Stat k="Total payouts" icon="single">{analytics?.totalPayouts ?? 0}</Stat>
        <Stat k="Team signers" icon="team">{signerCount}</Stat>
        <Stat k="Pending approvals" icon="pending">{pending}</Stat>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 14, marginBottom: 16 }}>
        <button className="card" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => nav("/single")}>
          <div className="between"><h3><Icon.single size={16} /> &nbsp;Single Payout</h3><Icon.chevR size={16} /></div>
          <p className="csub" style={{ margin: "8px 0 0" }}>Send (or propose) a confidential payment.</p>
        </button>
        <button className="card" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => nav("/batch")}>
          <div className="between"><h3><Icon.batch size={16} /> &nbsp;Batch Payout</h3><Icon.chevR size={16} /></div>
          <p className="csub" style={{ margin: "8px 0 0" }}>Pay many recipients at once.</p>
        </button>
        <button className="card" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => nav("/pending")}>
          <div className="between"><h3><Icon.pending size={16} /> &nbsp;Pending Payouts</h3><Icon.chevR size={16} /></div>
          <p className="csub" style={{ margin: "8px 0 0" }}>Review requests awaiting approval.</p>
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
                  <td className="nowrap">{["deposit", "claim", "received"].includes(t.kind) ? "+" : "−"}{fmtAmount(t.amount, t.tokenSymbol)}</td>
                  <td>{settling && t.txHash && t.txHash === settling.txHash ? <span className="badge warn">Settling…</span> : <StatusBadge status={t.status} />}</td>
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
