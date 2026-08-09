import { useRef } from "react";
import { NavLink } from "react-router-dom";
import { Icon } from "./Icons.jsx";
import { useOrg } from "../state/OrgContext.jsx";
import { initialsOf, short } from "../lib/format.js";

const NAV = [
  { to: "/", label: "Dashboard", icon: "dashboard", end: true },
  { to: "/single", label: "Single Payout", icon: "single" },
  { to: "/batch", label: "Batch Payout", icon: "batch" },
  { to: "/fund", label: "Fund Wallet", icon: "receive" },
  { to: "/analytics", label: "Analytics", icon: "analytics" },
  { to: "/pending", label: "Pending Payouts", icon: "pending" },
  { to: "/history", label: "Transaction History", icon: "history" },
  { to: "/team", label: "Team", icon: "team" },
  { to: "/settings", label: "Settings", icon: "settings" },
];

export default function Sidebar({ collapsed, onToggle }) {
  const { org, owner, txs, treasury, disconnectTreasury } = useOrg();
  const pendingCount = txs.filter((t) => t.status === "pending").length;

  // Glide the hover highlight to whatever nav item the cursor is over; fade it out when
  // the cursor leaves the nav (the active item keeps its own tint). The eased transition
  // is what makes it feel a touch slower than the cursor.
  const indRef = useRef(null);
  const moveHover = (el) => {
    const ind = indRef.current;
    if (!ind || !el) return;
    ind.style.transform = `translateY(${el.offsetTop}px)`;
    ind.style.height = `${el.offsetHeight}px`;
    ind.style.opacity = "1";
  };
  const hideHover = () => { if (indRef.current) indRef.current.style.opacity = "0"; };

  return (
    <aside className="sidebar">
      <div className="brand">
        <img className="logo" src="/Logo.png" alt="" />
        <div>
          <div className="bt">{org?.name || "Organization"}</div>
          <div className="bs">Stabletrust Pro</div>
        </div>
      </div>

      <nav className="nav" onMouseLeave={hideHover}>
        <span className="nav-hover" ref={indRef} aria-hidden="true" />
        {NAV.map((n) => {
          const I = Icon[n.icon];
          return (
            <NavLink key={n.to} to={n.to} end={n.end} title={n.label} onMouseEnter={(e) => moveHover(e.currentTarget)}>
              <span className="ic"><I size={17} /></span>
              <span className="lbl">{n.label}</span>
              {n.to === "/pending" && pendingCount > 0 && (
                <span className="badge warn" style={{ marginLeft: "auto" }}>{pendingCount}</span>
              )}
            </NavLink>
          );
        })}
      </nav>

      <button className="collapse-btn" onClick={onToggle} title="Collapse">
        {collapsed ? <Icon.chevR size={15} /> : <Icon.chevL size={15} />}
      </button>

      <div className="sidefoot">
        <div className="who">
          <div className="avatar">{initialsOf(owner?.name || "Owner")}</div>
          <div className="whoinfo">
            <div className="wn">{owner?.name || "Treasury Owner"}</div>
            <div className="we">{owner?.email || (treasury?.address ? short(treasury.address) : "no email set")}</div>
          </div>
          <button className="out" title="Disconnect" onClick={disconnectTreasury}>
            <Icon.logout size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}
