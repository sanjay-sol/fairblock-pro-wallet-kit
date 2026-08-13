import { Component } from "react";

// Last-resort guard: if any render throws, React unmounts the whole tree and the user
// sees a blank page. This catches it and shows a recover-able message instead. We keep it
// deliberately dependency-free (no context/hooks) so it can never fail to render.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("[app crash]", error, info?.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="gate">
        <div className="box">
          <img className="logo-lg" src="/Logo.png" alt="" />
          <h1>Something went wrong</h1>
          <p className="hint" style={{ color: "var(--err)" }}>{String(this.state.error?.message || this.state.error)}</p>
          <button className="btn primary" style={{ marginTop: 16 }} onClick={() => { this.setState({ error: null }); window.location.assign("/"); }}>
            Reload the app
          </button>
        </div>
      </div>
    );
  }
}
