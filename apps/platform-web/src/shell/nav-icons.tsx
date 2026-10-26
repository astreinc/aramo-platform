import type { NavIconKey } from './nav';

// PLATFORM-UX-1 F-2 — the rail glyphs, copied from Platform Admin.dc.html (IC):
// 19px, 24-unit viewBox, 1.7 stroke, currentColor.

const PATH: Readonly<Record<NavIconKey, string>> = {
  dash: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  tenants: 'M4 21V6a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v15M14 10h5a1 1 0 0 1 1 1v10M2 21h20M8 9h2M8 13h2M8 17h2',
  shield: 'M12 3l8 3v6c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V6zM9 12l2 2 4-4',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  layers: 'M12 3 2 8l10 5 10-5zM2 13l10 5 10-5',
  inbox: 'M3 13h5l2 3h4l2-3h5M5.5 5h13L21 13v6H3v-6z',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6',
  sliders: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
  doc: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M8 13h8M8 17h5',
  braces:
    'M8 4c-2 0-3 1-3 3v2c0 1-1 2-2 3 1 1 2 2 2 3v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1 1 2 2 3-1 1-2 2-2 3v2c0 2-1 3-3 3',
  key: 'M14.5 4a5.5 5.5 0 1 1-4.6 8.5L3 19.4V21h3v-2h2v-2h2l1.3-1.3A5.5 5.5 0 0 1 14.5 4zM16 8.5h.01',
  // CCP-B1 — Commercial Control Plane v1.0.dc.html IC (check, repeat, tag, contract, scale, audit).
  check: 'M9 12l2 2 4-4M4 4h16v16H4z',
  repeat: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3',
  tag: 'M3 3h8l10 10-8 8L3 11zM7.5 7.5h.01',
  contract: 'M14 3H6v18h12V7zM14 3v4h4M9 17c1.5-2 2.5-2 3 0s1.5 1 3-1',
  scale: 'M12 3v18M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0zM8 21h8',
  audit: 'M8 4h11v14a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-2h11v2a3 3 0 0 0 3 3M8 4a3 3 0 0 0-3 3v9M11 8h5M11 12h5',
  // CCP-UI-V12 — Commercial Control Plane v1.2.dc.html IC (bell, cal, renew, due, rec, bars, pulse).
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
  cal: 'M3 5h18v16H3zM16 3v4M8 3v4M3 10h18M12 13v5M9.5 15.5h5',
  renew: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
  due: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  rec: 'M7 7h10l-3-3M17 17H7l3 3',
  bars: 'M3 21h18M6 17v-5M11 17V7M16 17v-8M21 17V4',
  pulse: 'M3 12h4l3-8 4 16 3-8h4',
};

export function NavIcon({ name }: { readonly name: NavIconKey }) {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATH[name]} />
    </svg>
  );
}

/** The collapse-sidebar glyph (rail header). */
export function PanelIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <line x1="9.5" y1="4.5" x2="9.5" y2="19.5" />
    </svg>
  );
}

/** The search glyph (⌘K trigger 15px, palette input 16px). */
export function SearchIcon({ size }: { readonly size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

/** The account-menu chevron (12px, #5C6770 via CSS). */
export function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
