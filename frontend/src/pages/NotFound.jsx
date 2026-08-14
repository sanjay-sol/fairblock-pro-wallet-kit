import { useNavigate, useLocation } from "react-router-dom";
import { Icon } from "../components/Icons.jsx";

// Catch-all route — renders inside the app shell (sidebar + topbar stay) so an unknown URL
// isn't just a blank canvas. Animated: a floating gradient "404" over a slow-pulsing brand orb.
export default function NotFound() {
  const nav = useNavigate();
  const { pathname } = useLocation();
  return (
    <div className="page nf">
      <div className="nf-wrap">
        <div className="nf-orb" aria-hidden="true" />
        <div className="nf-404">404</div>
        <h1 className="nf-title">Page not found</h1>
        <p className="nf-sub">We couldn't find <span className="mono">{pathname}</span>. It may have been moved, or it never existed.</p>
        <div className="nf-actions">
          <button className="btn primary" onClick={() => nav("/")}><Icon.dashboard size={15} /> Back to Dashboard</button>
          <button className="btn" onClick={() => nav(-1)}><Icon.chevL size={15} /> Go back</button>
        </div>
      </div>
    </div>
  );
}
