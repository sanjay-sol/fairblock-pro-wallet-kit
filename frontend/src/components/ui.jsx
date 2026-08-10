import { useState } from "react";
import { Icon } from "./Icons.jsx";
import { useOrg } from "../state/OrgContext.jsx";

// A small inline spinner (inherits currentColor).
export function Spinner({ size = 14 }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden />;
}

// A button that manages its OWN loading state: it shows a spinner on THIS button
// while its async onClick runs (so the right control shows progress, not every
// disabled button). Errors are swallowed here — actions surface their own toasts.
export function AsyncButton({ onClick, children, className = "btn", disabled, loadingText, title, style, type }) {
  const [loading, setLoading] = useState(false);
  const handle = async (e) => {
    if (loading || disabled) return;
    setLoading(true);
    try {
      await onClick?.(e);
    } catch {
      /* surfaced by the action (toast) */
    } finally {
      setLoading(false);
    }
  };
  return (
    <button className={className} disabled={disabled || loading} onClick={handle} title={title} style={style} type={type}>
      {loading ? <Spinner /> : null}
      {loading && loadingText ? loadingText : children}
    </button>
  );
}

// Global indeterminate progress stripe pinned to the very top — visible whenever
// a context action (run()) is in flight.
export function TopProgressBar() {
  const { busy } = useOrg();
  return <div className={`topprogress ${busy ? "on" : ""}`} aria-hidden />;
}

// Determinate progress bar (batch payouts, multi-step flows).
export function ProgressBar({ value = 0, max = 1, label }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div>
      {label && (
        <div className="between" style={{ marginBottom: 6 }}>
          <span className="csub" style={{ margin: 0 }}>{label}</span>
          <span className="mono muted">{value}/{max}</span>
        </div>
      )}
      <div className="progressbar"><div className="fill" style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export function Stepper({ steps, current }) {
  return (
    <div className="stepper">
      {steps.map((s, i) => (
        <div key={s} style={{ display: "contents" }}>
          <div className={`step ${i === current ? "active" : ""} ${i < current ? "done" : ""}`}>
            <span className="n">{i < current ? <Icon.check size={13} /> : i + 1}</span>
            <span>{s}</span>
          </div>
          {i < steps.length - 1 && <span className="bar" />}
        </div>
      ))}
    </div>
  );
}

// `icon` may be an Icon element (preferred) or an emoji string — either renders inside
// the animated orb (floating icon + emanating rings).
export function EmptyState({ icon = "📭", title, children }) {
  return (
    <div className="empty">
      <div className="empty-orb">
        <span className="ring" aria-hidden="true" />
        <span className="ring" aria-hidden="true" />
        <span className="ring" aria-hidden="true" />
        <span className="empty-ico">{icon}</span>
      </div>
      {title && <div className="big">{title}</div>}
      {children && <div className="hint" style={{ maxWidth: 380, margin: "4px auto 0" }}>{children}</div>}
    </div>
  );
}

export function Stat({ k, icon, children, accent }) {
  const I = icon ? Icon[icon] : null;
  return (
    <div className={`stat ${accent ? "accent" : ""}`}>
      <div className="k">{I && <I size={14} />}{k}</div>
      <div className="v">{children}</div>
    </div>
  );
}

export function CopyBtn({ value, label = "Copy" }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn sm ghost"
      onClick={() => {
        navigator.clipboard?.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? <Icon.check size={14} /> : <Icon.copy size={14} />} {done ? "Copied" : label}
    </button>
  );
}

export function StatusBadge({ status }) {
  const map = {
    completed: ["ok", "Completed"],
    submitted: ["warn", "Settling"],
    pending: ["warn", "Pending"],
    failed: ["err", "Failed"],
    rejected: ["", "Rejected"],
  };
  const [cls, txt] = map[status] || ["", status];
  return <span className={`badge ${cls}`}>{txt}</span>;
}

export function KindBadge({ kind }) {
  const map = {
    payout: ["brand", "Payout"],
    deposit: ["", "Deposit"],
    withdraw: ["", "Withdraw"],
  };
  const [cls, txt] = map[kind] || ["", kind];
  return <span className={`badge ${cls}`}>{txt}</span>;
}

// Confidential-token selector. Lists the tokens supported on the current chain
// (registry + user-added) and lets the user add another by address — validated
// on-chain (the diamond only accepts admin-whitelisted tokens). Self-contained:
// reads/writes the globally-selected token via OrgContext.
export function TokenSelect() {
  const { token, tokens, switchToken, addCustomToken, busy } = useOrg();
  const [adding, setAdding] = useState(false);
  const [addr, setAddr] = useState("");

  const onSelect = (e) => {
    const v = e.target.value;
    if (v === "__add__") { setAdding(true); return; }
    switchToken(v);
  };

  const submitAdd = async () => {
    try {
      await addCustomToken(addr.trim()); // rejects unsupported tokens (toast)
      setAdding(false);
      setAddr("");
    } catch { /* surfaced by the action (toast) */ }
  };

  return (
    <div>
      <select value={token?.address || ""} onChange={onSelect} disabled={busy}>
        {tokens.map((t) => (
          <option key={t.address} value={t.address}>{t.symbol}</option>
        ))}
        <option value="__add__">+ Add token…</option>
      </select>
      {adding && (
        <div className="flex" style={{ gap: 6, marginTop: 8 }}>
          <input
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            placeholder="0x… token contract address"
            style={{ flex: 1 }}
            onKeyDown={(e) => e.key === "Enter" && addr.trim() && submitAdd()}
          />
          <button className="btn sm primary" disabled={!addr.trim() || busy} onClick={submitAdd}>Add</button>
          <button className="btn sm ghost" onClick={() => { setAdding(false); setAddr(""); }}>Cancel</button>
        </div>
      )}
    </div>
  );
}
