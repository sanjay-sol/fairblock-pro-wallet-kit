export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

export const fmtDur = (s) =>
  s % 3600 === 0 && s >= 3600 ? `${s / 3600}h` : s >= 60 ? `${Math.round(s / 60)} min` : `${s}s`;

export const fmtAmount = (v, symbol = "") => {
  // null/undefined = an encrypted amount we couldn't decrypt (no key) → hide it
  if (v == null) return symbol ? `••• ${symbol}` : "•••";
  const n = Number(v);
  if (!isFinite(n)) return `0 ${symbol}`.trim();
  const s = n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return symbol ? `${s} ${symbol}` : s;
};

export const fmtUsd = (v) =>
  `$${Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export const fmtDate = (iso) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
};

export const countdown = (expiresAt, now) => Math.max(0, Math.ceil((expiresAt - now) / 1000));

export const secsToClock = (s) => {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
};

export const initialsOf = (name = "") =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase() || "?";
