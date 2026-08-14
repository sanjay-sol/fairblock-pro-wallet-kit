import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Icon } from "./Icons.jsx";
import { useOrg } from "../state/OrgContext.jsx";
import { short, secsToClock, countdown } from "../lib/format.js";
import { getTheme, toggleTheme } from "../lib/theme.js";

const TITLES = {
  "/": "Dashboard", "/single": "Single Payout", "/batch": "Batch Payout", "/fund": "Fund Wallet", "/analytics": "Analytics",
  "/pending": "Pending Payouts", "/history": "Transaction History", "/team": "Team", "/settings": "Settings",
};

// Real-time network switcher — the treasury wallet is the same address on every EVM chain;
// switching re-points the confidential SDK + provider at the selected chain (task 5).
function NetworkPicker() {
  const { networks, chainId, network, switchNetwork, busy } = useOrg();
  const [open, setOpen] = useState(false);
  if (!networks?.length) return null;
  return (
    <div className="netpick">
      <span className="chainpill" onClick={() => setOpen((o) => !o)} title="Switch network"><span className="netdot" /> {network?.name || "Network"} <Icon.chevR size={12} /></span>
      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 190 }} onClick={() => setOpen(false)} />
          <div className="netmenu">
            {networks.map((n) => (
              <button key={n.chainId} className={`netitem ${n.chainId === chainId ? "active" : ""}`} disabled={busy} onClick={() => { setOpen(false); switchNetwork(n.chainId); }}>
                <span className="netdot" style={{ opacity: n.chainId === chainId ? 1 : 0.35 }} />
                <span className="nn">{n.name}</span>
                <span className="nc">{n.chainId}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function Topbar() {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const { treasury, session, now, threshold, signerCount } = useOrg();
  const title = TITLES[pathname] || "Page not found"; // every real route is in TITLES → fallback = 404
  const [theme, setTheme] = useState(getTheme());
  const secs = session?.expiry ? countdown(session.expiry, now) : 0;

  return (
    <div className="topbar">
      {pathname !== "/" && <button className="back" onClick={() => nav(-1)} title="Back"><Icon.chevL size={18} /></button>}
      <h2>{title}</h2>
      <div className="spacer" />

      <button className="iconbtn" onClick={() => setTheme(toggleTheme())} title={theme === "dark" ? "Light" : "Dark"}>{theme === "dark" ? <Icon.sun size={17} /> : <Icon.moon size={17} />}</button>

      <NetworkPicker />

      <span className="btn sm" title={`Payouts require ${threshold} of ${signerCount} approvals`}>
        <Icon.shield size={15} /> {threshold}-of-{signerCount}
      </span>

      {session && secs > 0 && (
        <span className="btn sm" title="Session expiry"><Icon.unlock size={15} /> {secsToClock(secs)}</span>
      )}

      {treasury && (
        <span className="walletchip" title={treasury.address}>
          <span className="dot live" /> {short(treasury.address)}
        </span>
      )}
    </div>
  );
}
