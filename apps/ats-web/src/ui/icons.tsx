// Inline stroke icons for the Confident Blue design system. Hand-built (no
// icon dependency) at 24×24 with currentColor strokes — they inherit size
// and colour from the component that renders them. Phase 1 ships only the
// glyphs the base components and the gallery use.

import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const base: IconProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
};

export function IconLogo(props: IconProps) {
  return (
    <svg {...base} strokeWidth={2.2} {...props}>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
    </svg>
  );
}

export function IconDesk(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3 11l9-8 9 8" />
      <path d="M5 10v10h14V10" />
    </svg>
  );
}

export function IconRequisitions(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

export function IconTalent(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <path d="M16 5.5a3 3 0 0 1 0 5.5M18 20c0-2.5-1-4.7-2.5-6" />
    </svg>
  );
}

export function IconCompanies(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M9 8h2M9 12h2M13 8h2M13 12h2M9 21v-4h6v4" />
    </svg>
  );
}

export function IconContacts(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="11" r="2" />
      <path d="M5.5 16c.6-1.7 2-2.5 3.5-2.5s2.9.8 3.5 2.5M15 9h3M15 13h3" />
    </svg>
  );
}

export function IconTasks(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

export function IconActivity(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3 12h4l2 6 4-14 2 8h6" />
    </svg>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4-4" />
    </svg>
  );
}

export function IconBell(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </svg>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <svg {...base} strokeWidth={2.4} {...props}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <svg {...base} strokeWidth={3} {...props}>
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

export function IconClock(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function IconReply(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 5h16v11H8l-4 3z" />
    </svg>
  );
}

export function IconAlert(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 9v4M12 17h.01M10.3 4.3l-8 14A1.5 1.5 0 0 0 3.7 21h16.6a1.5 1.5 0 0 0 1.3-2.7l-8-14a1.5 1.5 0 0 0-2.6 0z" />
    </svg>
  );
}

export function IconLogout(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
      <path d="M10 17l-5-5 5-5M5 12h11" />
    </svg>
  );
}

export function IconFlame(props: IconProps) {
  return (
    <svg {...base} fill="currentColor" stroke="none" {...props}>
      <path d="M12 3c2 3 4 4.5 4 8a4 4 0 0 1-8 0c0-1.5.5-2.5 1-3 0 2 1 2.5 2 2.5C10.5 9 12 6 12 3z" />
    </svg>
  );
}

export function IconPencil(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 20h4L18 10l-4-4L4 16z" />
      <path d="M13.5 6.5l4 4" />
    </svg>
  );
}

// ── Faceted-workspace glyphs (Talent page) ──
export function IconX(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <svg {...base} strokeWidth={2.4} {...props}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function IconChevronLeft(props: IconProps) {
  return (
    <svg {...base} strokeWidth={2.4} {...props}>
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}

export function IconFilter(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 6h16M7 12h10M10 18h4" />
    </svg>
  );
}

export function IconSort(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3" />
    </svg>
  );
}

export function IconColumns(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M15 4v16" />
    </svg>
  );
}

export function IconDensity(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

export function IconDots(props: IconProps) {
  return (
    <svg {...base} fill="currentColor" stroke="none" {...props}>
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconBookmark(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6 4h12v16l-6-4-6 4z" />
    </svg>
  );
}

export function IconBriefcase(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18" />
    </svg>
  );
}

export function IconShield(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

export function IconList(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
    </svg>
  );
}

export function IconTag(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3 12l9-9h7v7l-9 9z" />
      <circle cx="15.5" cy="8.5" r="1.3" />
    </svg>
  );
}

export function IconUserPlus(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M18 8v6M15 11h6" />
    </svg>
  );
}

export function IconMessage(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 5h16v11H8l-4 3z" />
    </svg>
  );
}

export function IconOpen(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M14 4h6v6M20 4l-9 9M18 13v6H5V6h6" />
    </svg>
  );
}

export function IconBolt(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M13 3L5 13h6l-1 8 8-10h-6z" />
    </svg>
  );
}

export function IconBan(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M6 6l12 12" />
    </svg>
  );
}

export function IconPin(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11z" />
      <circle cx="12" cy="10" r="2.5" />
    </svg>
  );
}

export function IconInfo(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v.01M11 12h1v4h1" />
    </svg>
  );
}

export function IconFile(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

export function IconUpload(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 15V3M7 8l5-5 5 5M5 21h14" />
    </svg>
  );
}

export function IconEye(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function IconMail(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m2 6 10 7L22 6" />
    </svg>
  );
}

export function IconGraduation(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M22 10 12 5 2 10l10 5 10-5z" />
      <path d="M6 12v5c0 1 2.7 3 6 3s6-2 6-3v-5" />
    </svg>
  );
}

export function IconUser(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20a8 8 0 0 1 16 0" />
    </svg>
  );
}

// ── Settings Rebuild Directive 1 — section-rail glyphs ──

export function IconBuilding(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="3" width="18" height="18" rx="1.5" />
      <path d="M9 21V9h6v12M7 7h.01M12 7h.01M17 7h.01" />
    </svg>
  );
}

export function IconBranch(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="9" r="2.5" />
      <path d="M6 8.5v7M8.5 6.5h5a3 3 0 0 1 3 3" />
    </svg>
  );
}

export function IconGlobe(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.5 3.5 6 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-6-3.5-9s1-6.5 3.5-9z" />
    </svg>
  );
}

export function IconUsers(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13A4 4 0 0 1 16 11" />
    </svg>
  );
}

export function IconShieldCheck(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3l8 3v6c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

export function IconLock(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

export function IconBrowser(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M2 9h20M6 6.5h.01M9 6.5h.01" />
    </svg>
  );
}

export function IconForm(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="4" y="2" width="16" height="20" rx="2" />
      <path d="M8 7h8M8 11h8M8 15h5" />
    </svg>
  );
}

export function IconSliders(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
    </svg>
  );
}

export function IconCard(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
    </svg>
  );
}

export function IconHistory(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3 3v6h6" />
      <path d="M3.5 9A9 9 0 1 0 6 5.3L3 9" />
      <path d="M12 8v4l3 2" />
    </svg>
  );
}

export function IconDownload(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
    </svg>
  );
}

export function IconPlug(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0z M12 17v5" />
    </svg>
  );
}

// Sourcing — a funnel narrowing the pool to a promotable subject.
export function IconSourcing(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3 5h18l-7 8v6l-4 2v-8z" />
    </svg>
  );
}
