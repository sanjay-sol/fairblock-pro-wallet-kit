import "./polyfills.js"; // must be first
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import { OrgProvider } from "./state/OrgContext.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import { initTheme } from "./lib/theme.js";
import "./styles.css";

// Model B: auth is our own OTP relay (backend + Turnkey session), so there is NO
// wallet-kit TurnkeyProvider here. The session lives in lib/session.js.
initTheme();

createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <BrowserRouter>
      <OrgProvider>
        <App />
      </OrgProvider>
    </BrowserRouter>
  </ErrorBoundary>,
);
