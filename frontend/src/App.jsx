import { useState } from "react";
import { Routes, Route } from "react-router-dom";
import { useOrg } from "./state/OrgContext.jsx";
import Sidebar from "./components/Sidebar.jsx";
import Topbar from "./components/Topbar.jsx";
import Toasts from "./components/Toasts.jsx";
import Onboard from "./pages/Onboard.jsx";
import { TopProgressBar } from "./components/ui.jsx";

import Dashboard from "./pages/Dashboard.jsx";
import SinglePayout from "./pages/SinglePayout.jsx";
import BatchPayout from "./pages/BatchPayout.jsx";
import Fund from "./pages/Fund.jsx";
import Analytics from "./pages/Analytics.jsx";
import PendingPayouts from "./pages/PendingPayouts.jsx";
import TransactionHistory from "./pages/TransactionHistory.jsx";
import Team from "./pages/Team.jsx";
import Settings from "./pages/Settings.jsx";
import NotFound from "./pages/NotFound.jsx";

export default function App() {
  const { ready, bootError, treasury, authed } = useOrg();
  const [collapsed, setCollapsed] = useState(false);

  if (bootError) {
    return (
      <div className="gate"><div className="box">
        <img className="logo-lg" src="/Logo.png" alt="" />
        <h1>Backend unreachable</h1><p>{bootError}</p>
        <p className="hint">Start it: <span className="mono">cd backend && node server.mjs</span></p>
      </div></div>
    );
  }
  if (!ready) return <div className="gate"><div className="box"><img className="logo-lg" src="/Logo.png" alt="" /><p>Loading…</p></div></div>;
  if (!treasury || !authed) return (<><TopProgressBar /><Onboard /><Toasts /></>);

  return (
    <div className={`shell ${collapsed ? "collapsed" : ""}`}>
      <TopProgressBar />
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <div className="main">
        <Topbar />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/single" element={<SinglePayout />} />
          <Route path="/batch" element={<BatchPayout />} />
          <Route path="/fund" element={<Fund />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/pending" element={<PendingPayouts />} />
          <Route path="/history" element={<TransactionHistory />} />
          <Route path="/team" element={<Team />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </div>
      <Toasts />
    </div>
  );
}
