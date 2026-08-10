import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Icon } from "./Icons.jsx";
import { useOrg } from "../state/OrgContext.jsx";
import { short, secsToClock, countdown } from "../lib/format.js";
import { getTheme, toggleTheme } from "../lib/theme.js";

const TITLES = {
  "/": "Dashboard", "/single": "Single Payout", "/fund": "Fund Wallet", "/analytics": "Analytics",
  "/pending": "Pending Payouts", "/history": "Transaction History", "/team": "Team", "/settings": "Settings",
};

export default function Topbar() {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const { treasury, session, now, network, threshold, members } = useOrg();
  const title = TITLES[pathname] || "Stabletrust Pro";
  const [theme, setTheme] = useState(getTheme());
  const secs = session?.expiry ? countdown(session.expiry, now) : 0;
  const signerCount = members.filter((m) => m.status === "active").length;

  return (
    <div className="topbar">
      {pathname !== "/" && <button className="back" onClick={() => nav(-1)} title="Back"><Icon.chevL size={18} /></button>}
      <h2>{title}</h2>
      <div className="spacer" />

      <button className="iconbtn" onClick={() => setTheme(toggleTheme())} title={theme === "dark" ? "Light" : "Dark"}>{theme === "dark" ? <Icon.sun size={17} /> : <Icon.moon size={17} />}</button>

      <span className="chainpill" title="Network"><span className="netdot" /> {network?.name || "Base Sepolia"}</span>

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
