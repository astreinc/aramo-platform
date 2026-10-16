// Talent 360 (redesign) — presentation mapping only. Every value maps a fact the
// backend composed (GET /v1/talent-360/:id); nothing here decides readiness,
// attention, stage or eligibility. Design authority: platform/Talent 360 CRM.dc.html.

import type { AttentionItemView } from './talent-360-types';

export const SECTION_KEYS = [
  'overview',
  'profile',
  'auth',
  'docs',
  'opps',
  'activity',
  'tasks',
  'lists',
  'notes',
  'trust',
  'ci',
  'ts',
] as const;
export type T360Section = (typeof SECTION_KEYS)[number];

export function isSection(v: string | null): v is T360Section {
  return v !== null && (SECTION_KEYS as readonly string[]).includes(v);
}

export const ICON = {
  overview: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  auth: 'M4 5h16v14H4zM8 10h3M8 14h6M15 9.5h2',
  docs: 'M6 2h9l5 5v15H6zM14 2v6h6',
  opps: 'M3 9h18M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  tasks: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9',
  lists: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  notes: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  trust: 'M12 3l8 3v6c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V6zM9 12l2 2 4-4',
  ci: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  ts: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
  mail: 'M3 5h18v14H3zM3 6l9 7 9-7',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z',
  client: 'M3 21h18M5 21V7l7-4 7 4v14',
  cal: 'M4 5h16v16H4zM4 10h16M8 3v4M16 3v4',
  reqs: 'M9 4h6v3H9zM6 6H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-1M8 12h8M8 16h5',
  chevron: 'M9 6l6 6-6 6',
} as const;

export const SECTION_GROUPS: readonly {
  readonly label: string;
  readonly items: readonly { readonly key: T360Section; readonly label: string; readonly icon: string }[];
}[] = [
  {
    label: 'PERSON',
    items: [
      { key: 'overview', label: 'Overview', icon: ICON.overview },
      { key: 'profile', label: 'Profile', icon: ICON.profile },
      { key: 'auth', label: 'Work authorization', icon: ICON.auth },
      { key: 'docs', label: 'Documents', icon: ICON.docs },
    ],
  },
  {
    label: 'WORK',
    items: [
      { key: 'opps', label: 'Opportunities', icon: ICON.opps },
      { key: 'activity', label: 'Activity', icon: ICON.activity },
      { key: 'tasks', label: 'Tasks', icon: ICON.tasks },
      { key: 'lists', label: 'Lists', icon: ICON.lists },
      { key: 'notes', label: 'Notes', icon: ICON.notes },
    ],
  },
  {
    label: 'EVIDENCE',
    items: [
      { key: 'trust', label: 'Talent Trust', icon: ICON.trust },
      { key: 'ci', label: 'Conversation Intelligence', icon: ICON.ci },
      { key: 'ts', label: 'Technical Screening', icon: ICON.ts },
    ],
  },
];

export function sectionLabel(k: T360Section): string {
  for (const g of SECTION_GROUPS) for (const it of g.items) if (it.key === k) return it.label;
  return '';
}

// ── Stage (server current_journey_stage → 8-step ladder) ──────────────────────
export const STAGES = ['No contact', 'Contacted', 'Talent responded', 'Qualifying', 'Qualified', 'Submitted', 'Interview', 'Offer'] as const;

const STAGE_INDEX: Readonly<Record<string, number>> = {
  SOURCED: 0,
  CONTACTED: 1,
  ENGAGED: 2,
  QUALIFYING: 3,
  QUALIFIED: 4,
  SUBMITTED: 5,
  CLIENT_REVIEW: 5,
  CLIENT_DECLINED: 5,
  INTERVIEW: 6,
  OFFER: 7,
  ACCEPTED_PLACED: 7,
  PRE_START: 7,
  READY: 7,
  STARTED: 7,
  COMPLETED: 7,
};

export function stageIndex(stage: string): number {
  return STAGE_INDEX[stage.toUpperCase()] ?? -1;
}

export type Tone = 'green' | 'blue' | 'amber' | 'grey';

/** Stage pill: label + tone (Interview/Qualified/Offer green, Submitted blue, Qualifying amber, else grey). */
export function stagePill(stage: string): { label: string; tone: Tone } {
  const i = stageIndex(stage);
  if (i < 0) return { label: labelize(stage.toLowerCase()), tone: 'grey' };
  const label = STAGES[i] ?? stage;
  const tone: Tone = i === 6 || i === 4 || i === 7 ? 'green' : i === 5 ? 'blue' : i === 3 ? 'amber' : 'grey';
  return { label, tone };
}

/** Sub-line colour for an opportunity, from the attention projection for its requisition. */
export function oppSubTone(reqId: string, attention: readonly AttentionItemView[] | null): 'waiting' | 'blocking' | 'plain' {
  const a = (attention ?? []).find((x) => x.requisition_id === reqId);
  if (a === undefined) return 'plain';
  if (a.kind === 'blocking') return 'blocking';
  if (a.kind === 'waiting') return 'waiting';
  return 'plain';
}

/** Attention dot: amber time-sensitive/identity, red blocking, brand next step. */
export function attentionDot(kind: string): 'amber' | 'red' | 'brand' {
  if (kind === 'blocking') return 'red';
  if (kind === 'interview' || kind === 'identity') return 'amber';
  return 'brand';
}

// ── Activity categories (server category keys) ────────────────────────────────
export const ACTIVITY_FILTERS: readonly { key: string; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'communications', label: 'Communications' },
  { key: 'requisitions', label: 'Requisitions' },
  { key: 'client', label: 'Client' },
  { key: 'interviews', label: 'Interviews' },
  { key: 'documents', label: 'Documents' },
];

export function activityIcon(category: string, channel: string | null): string {
  if (category === 'communications') return channel === 'voice' || channel === 'phone' || channel === 'call' ? ICON.phone : ICON.mail;
  if (category === 'client') return ICON.client;
  if (category === 'interviews') return ICON.cal;
  if (category === 'documents') return ICON.docs;
  return ICON.reqs;
}

// ── Key facts ─────────────────────────────────────────────────────────────────
const FACT_ORDER = ['availability', 'compensation', 'work authorization', 'location', 'engagement'];

export function orderFacts<T extends { readonly label: string }>(facts: readonly T[]): T[] {
  const key = (l: string): number => {
    const i = FACT_ORDER.indexOf(l.replace(/_/g, ' ').toLowerCase());
    return i < 0 ? FACT_ORDER.length : i;
  };
  return [...facts].sort((a, b) => key(a.label) - key(b.label));
}

// ── Formatting ────────────────────────────────────────────────────────────────
export function labelize(v: string): string {
  return v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
export function relativeDay(iso: string): string {
  const d = new Date(iso);
  const diff = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
/** "Mar 2024" — month-grain dates are stored as UTC midnight, so format in UTC (no TZ shift). */
export function monthYear(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}
/** "Tomorrow" / "Today" / "Oct 17"; `soon` = due tomorrow or sooner. */
export function dueLabel(iso: string): { text: string; soon: boolean } {
  const diff = Math.round((startOfDay(new Date(iso)) - startOfDay(new Date())) / 86_400_000);
  if (diff <= 0) return { text: diff === 0 ? 'Today' : shortDate(iso), soon: true };
  if (diff === 1) return { text: 'Tomorrow', soon: true };
  return { text: shortDate(iso), soon: false };
}
