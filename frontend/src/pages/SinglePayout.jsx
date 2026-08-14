import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ethers } from "ethers";
import { useOrg } from "../state/OrgContext.jsx";
import { isActivated } from "../confidential.js";
import { Icon } from "../components/Icons.jsx";
import { Stepper, AsyncButton } from "../components/ui.jsx";
import { short, fmtAmount } from "../lib/format.js";
import { explorerTx } from "../networks.js";

export default function SinglePayout() {
  const nav = useNavigate();
  const { balances, symbol, recipients, startSend, clearSend, activeSend, threshold, signerCount, busy, treasury } = useOrg();
  const [step, setStep] = useState(0);
  const [recipMode, setRecipMode] = useState(recipients.length ? "known" : "address");
  const [recipId, setRecipId] = useState(recipients[0]?.id || "");
  const [address, setAddress] = useState("");
  const [amount, setAmount] = useState("100");
  const [delivery, setDelivery] = useState("confidential");
  const [note, setNote] = useState("");
  const [acct, setAcct] = useState("idle");

  const known = recipients.find((r) => r.id === recipId);
  const recipient = recipMode === "known" ? known?.address : address.trim();
  const recipientLabel = recipMode === "known" ? known?.label : null;
  const validAddr = recipient && ethers.isAddress(recipient);
  const validAmt = Number(amount) > 0;
  const enough = Number(amount) <= Number(balances.confidential.available);
  const willPropose = threshold > 1;

  useEffect(() => {
    if (delivery !== "confidential" || !validAddr) { setAcct("idle"); return; }
    setAcct("checking"); let cancelled = false;
    const t = setTimeout(async () => { const ok = await isActivated(recipient); if (!cancelled) setAcct(ok ? "yes" : "no"); }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [recipient, delivery, validAddr]);
  const blockedByAcct = delivery === "confidential" && acct === "no";

  // Hand the send to OrgContext; it survives navigation + the result stays visible on return.
  function confirm() { startSend({ recipient, amount, delivery, recipientLabel, note }); }
  function newPayout() { clearSend(); setStep(0); }

  // ── result / status view (context-owned, so returning to this page shows it) ──
  if (activeSend) {
    const s = activeSend;
    const head = s.status === "sending" ? (s.willPropose ? "Proposing payout…" : "Sending payment…")
      : s.status === "completed" ? "Payment sent"
      : s.status === "pending" ? "Proposed for approval"
      : "Payment failed";
    const tone = s.status === "failed" ? "err" : s.status === "sending" ? "muted" : "ok";
    return (
      <div className="page narrow">
        <div className="page-head"><h1>Single Payout</h1></div>
        <div className="card">
          <div className="flex" style={{ gap: 10, alignItems: "center", marginBottom: 6 }}>
            {s.status === "sending" ? <span className="spinner" />
              : s.status === "failed" ? <span style={{ color: "var(--err)" }}><Icon.x size={20} /></span>
              : s.status === "pending" ? <span style={{ color: "var(--warn)" }}><Icon.pending size={20} /></span>
              : <span style={{ color: "var(--ok)" }}><Icon.check size={20} /></span>}
            <h3 style={{ margin: 0, color: `var(--${tone})` }}>{head}</h3>
          </div>
          <p className="csub" style={{ marginBottom: 16 }}>
            {s.status === "sending" ? ""
              : s.status === "pending" ? `Awaiting ${threshold} of ${signerCount} approvals, then it settles onchain automatically.`
              : s.status === "failed" ? "Nothing was recorded. Check the message below and try again."
              : "Settled onchain."}
          </p>

          <div className="table-wrap" style={{ marginBottom: 16 }}><table><tbody>
            <tr><td className="muted">Recipient</td><td className="right">{s.recipientLabel ? `${s.recipientLabel} · ` : ""}<span className="mono">{short(s.recipient)}</span></td></tr>
            <tr><td className="muted">Amount</td><td className="right"><b>{fmtAmount(s.amount, s.symbol)}</b></td></tr>
            <tr><td className="muted">Delivery</td><td className="right">{s.delivery === "confidential" ? "Confidential (amount hidden)" : "Direct (amount public)"}</td></tr>
            {s.txHash && <tr><td className="muted">Transaction</td><td className="right"><a className="mono" href={explorerTx(s.chainId, s.txHash)} target="_blank" rel="noreferrer">{short(s.txHash)}</a></td></tr>}
          </tbody></table></div>

          {s.status === "failed" && <p className="hint" style={{ color: "var(--err)", marginBottom: 16 }}>{s.error}</p>}

          {s.status !== "sending" && (
            <div className="flex">
              <button className="btn grow" onClick={newPayout}>{s.status === "failed" ? "Try again" : "New payout"}</button>
              {s.status === "pending"
                ? <button className="btn primary grow" onClick={() => nav("/pending")}>Go to Pending Payouts <Icon.chevR size={15} /></button>
                : <button className="btn primary grow" onClick={() => nav("/history")}>View history <Icon.chevR size={15} /></button>}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="page narrow">
      <div className="page-head"><h1>Single Payout</h1></div>
      <Stepper steps={["Payment details", "Preview & Confirm"]} current={step} />

      {step === 0 && (
        <div className="card">
          <div className="card-row cols-2">
            <div className="field" style={{ margin: 0 }}>
              <label className="fld">Pay from</label>
              <select disabled><option>Confidential Balance</option></select>
              <p className="hint" style={{ marginTop: 6 }}>Available: {fmtAmount(balances.confidential.available, symbol)}</p>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label className="fld">Recipient</label>
              {recipients.length > 0 && (
                <div className="flex" style={{ marginBottom: 8 }}>
                  <button className={`btn sm ${recipMode === "known" ? "primary" : "ghost"}`} onClick={() => setRecipMode("known")}>Saved</button>
                  <button className={`btn sm ${recipMode === "address" ? "primary" : "ghost"}`} onClick={() => setRecipMode("address")}>Address</button>
                </div>
              )}
              {recipMode === "known" && recipients.length > 0 ? (
                <select value={recipId} onChange={(e) => setRecipId(e.target.value)}>{recipients.map((r) => <option key={r.id} value={r.id}>{r.label} · {short(r.address)}</option>)}</select>
              ) : (
                <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x… recipient wallet address" />
              )}
              {validAddr && delivery === "confidential" && (
                <div style={{ marginTop: 8, fontSize: 12.5 }}>
                  {acct === "checking" && <span className="flex" style={{ gap: 6, color: "var(--muted)" }}><span className="spinner" /> checking…</span>}
                  {acct === "yes" && <span className="badge ok"><Icon.check size={12} /> confidential account ready</span>}
                  {acct === "no" && <span className="badge err"><Icon.x size={12} /> no confidential account</span>}
                </div>
              )}
            </div>
          </div>

          <div className="card-row cols-2" style={{ marginTop: 18 }}>
            <div className="field" style={{ margin: 0 }}><label className="fld">Amount ({symbol})</label><input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></div>
            <div className="field" style={{ margin: 0 }}><label className="fld">Note (optional)</label><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. July invoice #1024" /></div>
          </div>

          <label className="fld" style={{ marginTop: 18 }}>Delivery method</label>
          <div className="choice-grid">
            <div className={`choice ${delivery === "confidential" ? "sel" : ""}`} onClick={() => setDelivery("confidential")}>
              <div className="ct"><span className="radio" /> Confidential Settlement <span className="badge brand">Recommended</span></div>
              <div className="cd">To the recipient's private balance. <b>Amount encrypted onchain.</b> Recipient needs a confidential account.</div>
            </div>
            <div className={`choice ${delivery === "direct" ? "sel" : ""}`} onClick={() => setDelivery("direct")}>
              <div className="ct"><span className="radio" /> Direct to wallet</div>
              <div className="cd">To the recipient's public wallet.</div>
            </div>
          </div>

          {blockedByAcct && <p className="hint" style={{ marginTop: 12, color: "var(--err)" }}>✗ Recipient has no confidential account — switch to Direct, or have them onboard.</p>}
          {!enough && validAmt && <p className="hint" style={{ marginTop: 12, color: "var(--warn)" }}>⚠ Amount exceeds confidential balance ({fmtAmount(balances.confidential.available, symbol)}).</p>}

          <button className="btn primary big block" style={{ marginTop: 18 }} disabled={!validAddr || !validAmt || !enough || blockedByAcct} onClick={() => setStep(1)}>Continue <Icon.chevR size={16} /></button>
        </div>
      )}

      {step === 1 && (
        <div className="card">
          <h3>Preview & Confirm</h3>
          <p className="csub">{willPropose ? `This treasury requires ${threshold} of ${signerCount} approvals.` : "You're the sole signer - this settles immediately."}</p>
          <div className="table-wrap" style={{ marginBottom: 18 }}><table><tbody>
            <tr><td className="muted">Recipient</td><td className="right">{recipientLabel ? `${recipientLabel} · ` : ""}<span className="mono">{short(recipient)}</span></td></tr>
            <tr><td className="muted">Amount</td><td className="right"><b>{fmtAmount(amount, symbol)}</b></td></tr>
            <tr><td className="muted">Delivery</td><td className="right">{delivery === "confidential" ? "Confidential (amount hidden)" : "Direct (amount public)"}</td></tr>
            {note && <tr><td className="muted">Note</td><td className="right">{note}</td></tr>}
          </tbody></table></div>
          <div className="flex">
            <button className="btn ghost" onClick={() => setStep(0)} disabled={busy}><Icon.chevL size={15} /> Back</button>
            <AsyncButton className="btn primary big grow" onClick={confirm} disabled={busy} loadingText={willPropose ? "Proposing…" : "Sending…"}>
              {willPropose ? <><Icon.pending size={16} /> Propose for approval</> : <><Icon.send size={16} /> Send payment</>}
            </AsyncButton>
          </div>
        </div>
      )}
    </div>
  );
}
