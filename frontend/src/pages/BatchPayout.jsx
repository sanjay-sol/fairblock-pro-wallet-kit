import { useState, useRef } from "react";
import { ethers } from "ethers";
import { useOrg } from "../state/OrgContext.jsx";
import { isActivated } from "../confidential.js";
import { Icon } from "../components/Icons.jsx";
import { ProgressBar } from "../components/ui.jsx";
import { short, fmtAmount } from "../lib/format.js";

export default function BatchPayout() {
  const { balances, symbol, token, tokens, busy, runBatch, recipients, org, sessionActive } = useOrg();

  const [view, setView] = useState("build"); // build | run
  const [rows, setRows] = useState([]); // {id, address, amount, label, valid, errors, acct}
  const [delivery, setDelivery] = useState(org?.defaultDelivery || "confidential");
  const [manual, setManual] = useState({ address: "", amount: "", label: "" });

  const [runRows, setRunRows] = useState([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({});
  const [done, setDone] = useState(false);

  const fileRef = useRef(null);
  const ridRef = useRef(0);
  const nextId = () => `r${++ridRef.current}`;

  // Resolve a CSV `token` cell (symbol OR address) against the chain's supported
  // tokens. Empty → the currently-selected token. Unknown → row is invalid.
  function mkRow(address, amount, label, tokenStr = "") {
    const errors = [];
    if (!ethers.isAddress(address)) errors.push("invalid address");
    if (!(Number(amount) > 0)) errors.push("invalid amount");
    let tok = token; // default = selected token
    if (tokenStr) {
      tok = tokens.find(
        (t) =>
          t.symbol.toLowerCase() === tokenStr.toLowerCase() ||
          t.address.toLowerCase() === tokenStr.toLowerCase(),
      );
      if (!tok) errors.push(`unsupported token "${tokenStr}"`);
    }
    return {
      id: nextId(),
      address: address.trim(),
      amount: String(amount).trim(),
      label: (label || "").trim(),
      token: tok || null,
      tokenSymbol: tok?.symbol || tokenStr || null,
      valid: errors.length === 0,
      errors,
      acct: "idle",
    };
  }

  // Check confidential-account existence for a set of rows (only meaningful for confidential delivery).
  async function checkAccounts(list, del = delivery) {
    if (del !== "confidential") return;
    const valids = list.filter((r) => r.valid);
    if (!valids.length) return;
    setRows((rs) => rs.map((x) => valids.some((v) => v.id === x.id) ? { ...x, acct: "checking" } : x));
    await Promise.all(valids.map(async (r) => {
      const ok = await isActivated(r.address);
      setRows((rs) => rs.map((x) => x.id === r.id ? { ...x, acct: ok ? "yes" : "no" } : x));
    }));
  }

  function appendRows(list) {
    if (!list.length) return;
    setRows((rs) => [...rs, ...list]);
    checkAccounts(list);
  }

  function parseCsvAppend(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const hasHeader = /address|recipient/i.test(lines[0]) && /amount/i.test(lines[0]);
    // With a header row, map columns BY NAME (any order, optional `token`). Without
    // one, fall back to the legacy positional layout address,amount,label (no token).
    let idx = { address: 0, amount: 1, token: -1, label: 2 };
    let start = 0;
    if (hasHeader) {
      const cols = lines[0].split(",").map((s) => s.trim().toLowerCase());
      const at = (...names) => cols.findIndex((c) => names.includes(c));
      idx = {
        address: Math.max(at("address", "recipient"), 0),
        amount: Math.max(at("amount"), 1),
        token: at("token"),
        label: at("label", "name", "note"),
      };
      start = 1;
    }
    const parsed = lines.slice(start).map((line) => {
      const cells = line.split(",").map((s) => s.trim());
      return mkRow(
        cells[idx.address] || "",
        cells[idx.amount] || "",
        idx.label >= 0 ? cells[idx.label] || "" : "",
        idx.token >= 0 ? cells[idx.token] || "" : "",
      );
    });
    appendRows(parsed);
  }

  function onFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => parseCsvAppend(String(reader.result || ""));
    reader.readAsText(f);
    e.target.value = ""; // allow re-uploading the same file
  }
  function addManual() {
    if (!ethers.isAddress(manual.address) || !(Number(manual.amount) > 0)) return;
    appendRows([mkRow(manual.address, manual.amount, manual.label)]);
    setManual({ address: "", amount: "", label: "" });
  }
  function loadFromRecipients() {
    appendRows(recipients.map((r, i) => mkRow(r.address, String((i + 1) * 50), r.label)));
  }
  function removeRow(id) { setRows((rs) => rs.filter((r) => r.id !== id)); }
  function removeAllUnready() {
    setRows((rs) => rs.filter((r) => r.valid && (delivery === "direct" || r.acct === "yes")));
  }
  function changeDelivery(d) {
    setDelivery(d);
    if (d === "confidential") checkAccounts(rows.filter((r) => r.acct === "idle" || r.acct === "no"), d);
  }
  function recheckAll() { checkAccounts(rows, delivery); }
  function downloadTemplate() {
    const sym = symbol || "USDC";
    const tmpl =
      "address,amount,token,label\n" +
      `0x0000000000000000000000000000000000000000,100,${sym},Alice\n` +
      `0x0000000000000000000000000000000000000000,250,${sym},Bob\n`;
    const url = URL.createObjectURL(new Blob([tmpl], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = "batch-payout-template.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  const manualValid = ethers.isAddress(manual.address) && Number(manual.amount) > 0;
  const invalidRows = rows.filter((r) => !r.valid);
  const noAcctRows = rows.filter((r) => r.valid && delivery === "confidential" && r.acct === "no");
  const readyRows = rows.filter((r) => r.valid && (delivery === "direct" || r.acct === "yes"));
  const checkingRows = rows.filter((r) => r.valid && delivery === "confidential" && r.acct === "checking");
  // The aggregate total/balance gate is only meaningful when every ready row uses the
  // SELECTED token. Mixed-token or other-token batches skip the gate — each row is
  // checked on-chain at send time (runBatch handles per-row failures).
  const selAddr = (token?.address || "").toLowerCase();
  const allSelected = readyRows.every((r) => (r.token?.address || token?.address || "").toLowerCase() === selAddr);
  const total = readyRows.reduce((s, r) => s + Number(r.amount), 0);
  const enough = !allSelected || total <= Number(balances.confidential.available);

  async function execute() {
    const rr = readyRows;
    setRunRows(rr);
    setProgress({});
    setDone(false);
    setRunning(true);
    setView("run");
    await runBatch(rr, delivery, (i, row, res) => {
      setProgress((p) => ({ ...p, [i]: { ...res } }));
    });
    setRunning(false);
    setDone(true);
  }
  function reset() {
    setRows([]); setRunRows([]); setProgress({}); setDone(false); setView("build");
  }

  const succeeded = Object.values(progress).filter((p) => p.status === "completed").length;
  const failed = Object.values(progress).filter((p) => p.status === "failed").length;

  // status pill per row
  function rowStatus(r) {
    if (!r.valid) return <span className="badge err">{r.errors.join(", ")}</span>;
    if (delivery === "direct") return <span className="badge ok">ready</span>;
    if (r.acct === "checking") return <span className="flex" style={{ gap: 5, color: "var(--muted)" }}><span className="spinner" /> checking…</span>;
    if (r.acct === "yes") return <span className="badge ok"><Icon.check size={12} /> ready</span>;
    if (r.acct === "no") return <span className="badge err"><Icon.x size={12} /> no confidential account</span>;
    return <span className="badge">—</span>;
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Batch Payout</h1>
        <p>Pay many recipients from your treasury. Add them manually or from a CSV (or both). One confidential
          transfer per recipient — each is its own proof + tx.</p>
      </div>

      {view === "build" && (
        <>
          {!sessionActive && (
            <div className="devbar" style={{ background: "var(--brand-bg)", borderColor: "var(--brand)", color: "var(--brand-soft)" }}>
              <b>Create a session</b> once (top-right) and sign every payout seamlessly — no passkey prompt per recipient.
              <a href="https://docs.turnkey.com/authentication/sessions" target="_blank" rel="noreferrer" style={{ color: "var(--brand-soft)", textDecoration: "underline", marginLeft: 4 }}>About sessions ↗</a>
            </div>
          )}
          {/* delivery method */}
          <div className="card">
            <label className="fld">Delivery method</label>
            <div className="choice-grid">
              <div className={`choice ${delivery === "confidential" ? "sel" : ""}`} onClick={() => changeDelivery("confidential")}>
                <div className="ct"><span className="radio" /> Confidential Settlement <span className="badge brand">Recommended</span></div>
                <div className="cd">Each amount hidden on-chain. <b>Recipients must have a confidential account</b> (checked below).</div>
              </div>
              <div className={`choice ${delivery === "direct" ? "sel" : ""}`} onClick={() => changeDelivery("direct")}>
                <div className="ct"><span className="radio" /> Direct to wallet</div>
                <div className="cd">Funds land in each recipient's public wallet; amounts public. Works to any address.</div>
              </div>
            </div>
          </div>

          {/* add recipients */}
          <div className="card">
            <h3>Add recipients</h3>
            <p className="csub">Add one at a time, or import a CSV — you can keep adding after importing.</p>
            <div className="flex wrap" style={{ gap: 8, alignItems: "flex-start" }}>
              <input style={{ flex: "2 1 260px" }} placeholder="0x… recipient address" value={manual.address}
                onChange={(e) => setManual((m) => ({ ...m, address: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && addManual()} />
              <input style={{ flex: "1 1 100px" }} type="number" min="0" placeholder={`Amount`} value={manual.amount}
                onChange={(e) => setManual((m) => ({ ...m, amount: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && addManual()} />
              <input style={{ flex: "1 1 120px" }} placeholder="Label (optional)" value={manual.label}
                onChange={(e) => setManual((m) => ({ ...m, label: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && addManual()} />
              <button className="btn primary" disabled={!manualValid} onClick={addManual}><Icon.plus size={15} /> Add</button>
            </div>

            <div className="flex wrap" style={{ gap: 8, marginTop: 14 }}>
              <button className="btn sm" onClick={() => fileRef.current?.click()}><Icon.upload size={14} /> Import CSV</button>
              <button className="btn sm ghost" onClick={downloadTemplate}><Icon.download size={14} /> Template</button>
              {recipients.length > 0 && (
                <button className="btn sm ghost" onClick={loadFromRecipients}><Icon.team size={14} /> Add {recipients.length} saved recipient(s)</button>
              )}
              <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={onFile} />
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              CSV columns: <span className="mono">address, amount, token, label</span> — <b>token</b> is a symbol
              (e.g. {symbol}) and defaults to the selected token if omitted. Only supported tokens work.
            </p>
          </div>

          {/* recipient list */}
          <div className="card">
            <div className="between" style={{ marginBottom: 12 }}>
              <h3>Recipients ({rows.length})</h3>
              {rows.length > 0 && (
                <div className="flex" style={{ gap: 8 }}>
                  {delivery === "confidential" && <button className="btn sm ghost" onClick={recheckAll}><Icon.refresh size={13} /> Re-check</button>}
                  <button className="btn sm ghost" onClick={() => setRows([])}>Clear all</button>
                </div>
              )}
            </div>

            {rows.length === 0 ? (
              <p className="hint">No recipients yet. Add one above or import a CSV.</p>
            ) : (
              <>
                <div className="table-wrap" style={{ marginBottom: 14 }}>
                  <table>
                    <thead><tr><th>#</th><th>Recipient</th><th>Amount</th><th>Token</th><th>Label</th><th>Status</th><th></th></tr></thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={r.id}>
                          <td className="muted">{i + 1}</td>
                          <td className="mono">{ethers.isAddress(r.address) ? short(r.address) : (r.address || "—")}</td>
                          <td className="nowrap">{r.amount}</td>
                          <td className="nowrap">{r.tokenSymbol || symbol}</td>
                          <td>{r.label || "—"}</td>
                          <td>{rowStatus(r)}</td>
                          <td className="right"><button className="btn sm danger" title="Remove" onClick={() => removeRow(r.id)}><Icon.x size={13} /></button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* summary + warnings */}
                {(invalidRows.length > 0 || noAcctRows.length > 0) && (
                  <div className="flex between wrap" style={{ marginBottom: 12, gap: 8 }}>
                    <p className="hint" style={{ color: "var(--warn)", margin: 0 }}>
                      {invalidRows.length > 0 && <>{invalidRows.length} invalid row(s). </>}
                      {noAcctRows.length > 0 && <>{noAcctRows.length} recipient(s) have no confidential account (Confidential Settlement will skip them). </>}
                    </p>
                    <button className="btn sm" onClick={removeAllUnready}><Icon.trash size={13} /> Remove all not-ready</button>
                  </div>
                )}

                <div className="between">
                  <div>
                    <div className="muted" style={{ fontSize: 12.5 }}>Total ({readyRows.length} ready{checkingRows.length ? `, ${checkingRows.length} checking` : ""})</div>
                    <div style={{ fontSize: 20, fontWeight: 680 }}>{allSelected ? fmtAmount(total, symbol) : `${readyRows.length} payouts · multiple tokens`}</div>
                  </div>
                  <button className="btn primary big" disabled={!readyRows.length || !enough || checkingRows.length > 0}
                    onClick={execute}>
                    <Icon.send size={16} /> Execute {readyRows.length} payout{readyRows.length === 1 ? "" : "s"}
                  </button>
                </div>
                {!enough && readyRows.length > 0 && <p className="hint" style={{ marginTop: 10, color: "var(--warn)" }}>⚠ Total exceeds confidential balance ({fmtAmount(balances.confidential.available, symbol)}).</p>}
                {!sessionActive && <p className="hint" style={{ marginTop: 10 }}>Create a session first — otherwise your passkey prompts on every payout.</p>}
              </>
            )}
          </div>
        </>
      )}

      {view === "run" && (
        <div className="card">
          <h3>{done ? "Batch complete" : "Executing batch…"}</h3>
          <p className="csub">
            {done ? `${succeeded} succeeded${failed ? `, ${failed} failed` : ""}.`
              : `${runRows.length} payouts · ${delivery === "confidential" ? "amounts hidden" : "amounts public"}.`}
          </p>

          <div style={{ margin: "6px 0 18px" }}>
            <ProgressBar value={succeeded + failed} max={runRows.length}
              label={done ? "Complete" : `Processing payout ${Math.min(succeeded + failed + 1, runRows.length)} of ${runRows.length}…`} />
          </div>

          <div className="plist" style={{ marginBottom: 18 }}>
            {runRows.map((r, i) => {
              const p = progress[i];
              const st = p?.status;
              return (
                <div key={r.id} className={`prow ${st === "completed" ? "done" : st === "failed" ? "fail" : running && !p ? "run" : ""}`}>
                  <span className="st">
                    {st === "completed" ? <span style={{ color: "var(--ok)" }}><Icon.check size={16} /></span>
                      : st === "failed" ? <span style={{ color: "var(--err)" }}><Icon.x size={16} /></span>
                      : running ? <span className="spinner" /> : <span className="muted">{i + 1}</span>}
                  </span>
                  <div className="grow">
                    <div className="flex" style={{ gap: 8 }}>
                      <b>{r.label || short(r.address)}</b>
                      <span className="mono muted" style={{ fontSize: 12 }}>{short(r.address)}</span>
                    </div>
                    {p?.error && <div className="hint" style={{ color: "var(--err)" }}>{p.error}</div>}
                    {p?.txHash && <div className="hint mono">{short(p.txHash)}</div>}
                  </div>
                  <div className="nowrap">{fmtAmount(r.amount, symbol)}</div>
                </div>
              );
            })}
          </div>

          {done && (
            <div className="flex">
              <button className="btn grow" onClick={() => setView("build")}><Icon.chevL size={15} /> Back to list</button>
              <button className="btn primary grow" onClick={reset}>Start a new batch</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
