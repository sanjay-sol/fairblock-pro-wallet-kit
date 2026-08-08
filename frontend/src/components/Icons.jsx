// Minimal inline SVG icons (no external icon dep). stroke = currentColor.
const S = ({ children, size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);

export const Icon = {
  dashboard: (p) => <S {...p}><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></S>,
  single: (p) => <S {...p}><path d="M12 19V5"/><path d="M6 11l6-6 6 6"/></S>,
  batch: (p) => <S {...p}><rect x="3" y="4" width="8" height="7" rx="1.5"/><path d="M15 6h6M15 10h6M3 15h18M3 19h18"/></S>,
  receive: (p) => <S {...p}><path d="M12 5v14"/><path d="M6 13l6 6 6-6"/></S>,
  analytics: (p) => <S {...p}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></S>,
  pending: (p) => <S {...p}><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/></S>,
  history: (p) => <S {...p}><path d="M3 3v6h6"/><path d="M3.5 9a9 9 0 106-6L3 9"/><path d="M12 8v4l3 2"/></S>,
  team: (p) => <S {...p}><circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0112 0"/><path d="M16 5.2a3.2 3.2 0 010 5.6M18 20a6 6 0 00-2.5-4.9"/></S>,
  settings: (p) => <S {...p}><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2.4"/><circle cx="8" cy="17" r="2.4"/></S>,
  lock: (p) => <S {...p}><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 018 0v3.5"/></S>,
  unlock: (p) => <S {...p}><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 017.7-1.5"/></S>,
  shield: (p) => <S {...p}><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/><path d="M9.2 12l2 2 3.6-4"/></S>,
  copy: (p) => <S {...p}><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></S>,
  ext: (p) => <S {...p}><path d="M14 5h5v5"/><path d="M19 5l-8 8"/><path d="M18 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h4"/></S>,
  plus: (p) => <S {...p}><path d="M12 5v14M5 12h14"/></S>,
  trash: (p) => <S {...p}><path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13"/></S>,
  refresh: (p) => <S {...p}><path d="M20 11a8 8 0 10-2.3 6.3L20 15"/><path d="M20 20v-5h-5"/></S>,
  check: (p) => <S {...p}><path d="M5 12l5 5L20 6"/></S>,
  x: (p) => <S {...p}><path d="M6 6l12 12M18 6L6 18"/></S>,
  upload: (p) => <S {...p}><path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2"/></S>,
  download: (p) => <S {...p}><path d="M12 4v12"/><path d="M7 11l5 5 5-5"/><path d="M4 19h16"/></S>,
  wallet: (p) => <S {...p}><rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M16 12h3"/><path d="M3 9h13a2 2 0 012 2"/></S>,
  logout: (p) => <S {...p}><path d="M10 19H6a2 2 0 01-2-2V7a2 2 0 012-2h4"/><path d="M16 15l3-3-3-3"/><path d="M19 12H10"/></S>,
  send: (p) => <S {...p}><path d="M21 3L10 14"/><path d="M21 3l-7 18-4-8-8-4z"/></S>,
  chevL: (p) => <S {...p}><path d="M15 6l-6 6 6 6"/></S>,
  chevR: (p) => <S {...p}><path d="M9 6l6 6-6 6"/></S>,
  coin: (p) => <S {...p}><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5A2.5 2.5 0 0114 10M9.5 14.5A2.5 2.5 0 0014 14M12 7v10"/></S>,
  sun: (p) => <S {...p}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></S>,
  moon: (p) => <S {...p}><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></S>,
  mail: (p) => <S {...p}><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M4 7l8 6 8-6"/></S>,
  key: (p) => <S {...p}><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3M17 6l2 2M14 9l2 2"/></S>,
};
