import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Icon } from "./Icons.jsx";
import { useOrg } from "../state/OrgContext.jsx";
import { short, secsToClock, countdown } from "../lib/format.js";
import { getTheme, toggleTheme } from "../lib/theme.js";

const TITLES = {
  "/": "Dashboard",
  "/single": "Single Payout",
  "/batch": "Batch Payout",
  "/fund": "Fund Wallet",
  "/analytics": "Analytics",
  "/pending": "Pending Payouts",
  "/history": "Transaction History",
  "/team": "Team",
  "/settings": "Settings",
};

function NetworkPicker() {
  const { networks, chainId, network, switchNetwork, busy } = useOrg();
  const [open, setOpen] = useState(false);
  return (
    <div className="netpick">
      <span className="chainpill" onClick={() => setOpen((o) => !o)} title="Switch network">
        <span className="netdot" /> {network?.name || "Network"} <Icon.chevR size={12} />
      </span>
      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 190 }} onClick={() => setOpen(false)} />
          <div className="netmenu">
            {networks.map((n) => (
              <button
                key={n.chainId}
                className={`netitem ${n.chainId === chainId ? "active" : ""}`}
                disabled={busy}
                onClick={() => { setOpen(false); switchNetwork(n.chainId); }}
              >
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
  const { treasury, sessionActive, isExternal, now, startSession, lock, busy } = useOrg();
  const title = TITLES[pathname] || "Stabletrust Pro";
  const secs = sessionActive && treasury?.sessionExpiresAt ? countdown(treasury.sessionExpiresAt, now) : 0;
  const [theme, setTheme] = useState(getTheme());

  return (
    <div className="topbar">
      {pathname !== "/" && (
        <button className="back" onClick={() => nav(-1)} title="Back"><Icon.chevL size={18} /></button>
      )}
      <h2>{title}</h2>
      <div className="spacer" />

      <button className="iconbtn" onClick={() => setTheme(toggleTheme())} title={theme === "dark" ? "Switch to light" : "Switch to dark"}>
        {theme === "dark" ? <Icon.sun size={17} /> : <Icon.moon size={17} />}
      </button>

      <NetworkPicker />

      {/* Self-custody wallets sign on demand (no session); embedded wallets show a session timer. */}
      {treasury && isExternal && (
        <span className="btn sm" title="You sign every transaction with your own wallet">
          <Icon.wallet size={15} /> Self-custody
        </span>
      )}

      {treasury && !isExternal && (
        sessionActive ? (
          <button className="btn sm" onClick={lock} disabled={busy} title="End session (sign out)">
            <Icon.unlock size={15} /> Session · {secsToClock(secs)}
          </button>
        ) : (
          <button className="btn sm primary" onClick={() => startSession()} disabled={busy} title="Sign in again to create a session">
            <Icon.lock size={15} /> Create session
          </button>
        )
      )}

      {treasury && (
        <span className="walletchip" title={treasury.address}>
          <span className={`dot ${sessionActive ? "live" : ""}`} />
          {short(treasury.address)}
        </span>
      )}
    </div>
  );
}
