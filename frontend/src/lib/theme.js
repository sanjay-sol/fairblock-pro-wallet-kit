// Light/dark theme, persisted in localStorage. Applied as <html data-theme="...">.
const KEY = "fbe-theme";

export function getTheme() {
  const saved = localStorage.getItem(KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(t) {
  document.documentElement.dataset.theme = t;
}

// Call once, before render, to avoid a flash of the wrong theme.
export function initTheme() {
  applyTheme(getTheme());
}

export function toggleTheme() {
  const next = getTheme() === "dark" ? "light" : "dark";
  localStorage.setItem(KEY, next);
  applyTheme(next);
  return next;
}
