// Talent workspace — the pure model behind the faceted Talent page. Kept
// framework-free so it is unit-tested in isolation (talent-workspace.spec.ts)
// and the view stays a thin renderer.
//
// SEGMENT 4d — the filter / facet / sort / pagination model is now SERVER-SIDE.
// buildTalentQuery() turns the UI state into the ?paged=true query string the BE
// resolves (4a native filters/sort/keyset cursor · 4b full-set cross-facet
// counts · 4c presets + My-team scope). The only thing still computed CLIENT-
// SIDE is the Skills facet COUNT (within the loaded page) — skills FILTER is
// full-set on the server, but skills COUNTS wait for Skills Taxonomy. Every
// other facet count comes from the server response.

import { PIPELINE_STATUS_LABELS } from '../pipeline/types';

import type { TalentRecordView } from './types';

// ── Enrichment vocab (composed fields; labels for the cross-facet displays) ──
export const CONSENT_LABELS: Record<string, string> = {
  contactable: 'Contactable',
  expiring_lt_30d: 'Expiring < 30d',
  do_not_contact: 'Do-not-contact',
};
export const STAGE_LABELS = PIPELINE_STATUS_LABELS;

// Recency buckets mirror the BE cross_facets.recency keys (4b).
export type Recency = '' | 'today' | '7d' | '30d' | 'stale';
export const RECENCY_OPTIONS: readonly { key: Exclude<Recency, ''>; label: string }[] =
  [
    { key: 'today', label: 'Today' },
    { key: '7d', label: 'Last 7 days' },
    { key: '30d', label: 'Last 30 days' },
    { key: 'stale', label: 'No activity 90 days+' },
  ];

// Re-export the stated-field vocab so consumers have one workspace import.
export {
  AVAILABILITY_STATUS_VALUES,
  ENGAGEMENT_TYPE_VALUES,
  AVAILABILITY_LABELS,
  ENGAGEMENT_LABELS,
  type AvailabilityStatus,
  type EngagementType,
} from './stated-fields';

// 'mine' → owner-is-me (native owner param) · 'team' → ?scope=my_team (4c) ·
// 'all' → no owner filter. The trio is mutually exclusive.
export type ScopeMode = 'mine' | 'team' | 'all';

// ── Token search ────────────────────────────────────────────────────────────
// Grammar: `key:value` tokens + free text. Supported keys map to SERVER params
// (name→q, skill→skills, loc→location); unsupported keys surface as flagged,
// non-filtering chips (kept visible so nothing is silently dropped).
export type TokenKey = 'skill' | 'loc' | 'name';
export const SUPPORTED_TOKEN_KEYS: readonly TokenKey[] = ['skill', 'loc', 'name'];
// Recognized in the prototype grammar but NOT backable as a server filter:
// kept as flagged, non-filtering chips. `owner:` joins these — the scope tabs
// (owner-is-me / My team) are the backed owner filter, not a name match.
export const UNSUPPORTED_TOKEN_KEYS = ['status', 'intouch', 'owner'] as const;

export interface SearchToken {
  readonly key: TokenKey | (typeof UNSUPPORTED_TOKEN_KEYS)[number];
  readonly value: string;
  readonly supported: boolean;
}

export interface ParsedQuery {
  readonly tokens: readonly SearchToken[];
  readonly free: string;
}

const KEY_RE = /^([a-zA-Z]+):(.*)$/;

export function parseQuery(input: string): ParsedQuery {
  const tokens: SearchToken[] = [];
  const free: string[] = [];
  for (const part of input.split(/\s+/)) {
    if (part === '') continue;
    const m = KEY_RE.exec(part);
    if (m === null) {
      free.push(part);
      continue;
    }
    const rawKey = (m[1] ?? '').toLowerCase();
    const value = m[2] ?? '';
    if (value === '') {
      free.push(part);
      continue;
    }
    if ((SUPPORTED_TOKEN_KEYS as readonly string[]).includes(rawKey)) {
      tokens.push({ key: rawKey as TokenKey, value, supported: true });
    } else if ((UNSUPPORTED_TOKEN_KEYS as readonly string[]).includes(rawKey)) {
      tokens.push({
        key: rawKey as (typeof UNSUPPORTED_TOKEN_KEYS)[number],
        value,
        supported: false,
      });
    } else {
      free.push(part);
    }
  }
  return { tokens, free: free.join(' ') };
}

// ── Facet state — only the SERVER-FILTERABLE (native) facets live here ───────
export type SkillMatch = 'any' | 'all';

export interface FacetState {
  readonly skills: readonly string[];
  readonly skillMatch: SkillMatch;
  readonly sources: readonly string[];
  readonly hotOnly: boolean;
  readonly location: string;
  readonly availability: readonly string[];
  readonly engagementTypes: readonly string[];
}

export const EMPTY_FACETS: FacetState = {
  skills: [],
  skillMatch: 'any',
  sources: [],
  hotOnly: false,
  location: '',
  availability: [],
  engagementTypes: [],
};

// ── Render helpers over the (free-text) talent fields ────────────────────────
export function fullName(t: TalentRecordView): string {
  const n = `${t.first_name} ${t.last_name}`.trim();
  return n === '' ? '—' : n;
}

export function skillsOf(t: TalentRecordView): readonly string[] {
  if (t.key_skills === null) return [];
  return t.key_skills
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function locationOf(t: TalentRecordView): string {
  const place = [t.city, t.state].filter(Boolean).join(', ');
  return place === '' ? '—' : place;
}

export function statedRate(t: TalentRecordView): string {
  return t.current_pay ?? t.desired_pay ?? '—';
}

// The "Unknown" availability bucket = null (never captured) OR the explicit
// 'unknown' stated value — null collapses to 'unknown' for display.
export function effectiveAvailability(t: TalentRecordView): string {
  return t.availability_status ?? 'unknown';
}

// ── Skills facet count — the ONE remaining within-loaded count ───────────────
export interface FacetCount {
  readonly value: string;
  readonly count: number;
}

export function deriveSkillCounts(
  talent: readonly TalentRecordView[],
): FacetCount[] {
  const m = new Map<string, number>();
  for (const t of talent) for (const s of skillsOf(t)) m.set(s, (m.get(s) ?? 0) + 1);
  return [...m.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

// ── Views ─────────────────────────────────────────────────────────────────────
// The Views bar (one active at a time). 'all' = no view filter. 'available_now'
// and 'my_hot_list' are NATIVE (availability / is_hot); the other three are the
// cross-schema presets resolved server-side (4c). Each maps to query params in
// buildTalentQuery — there is no separate "preset" param concept above this.
export type ViewKey =
  | 'all'
  | 'available_now'
  | 'in_touch_6mo'
  | 'needs_follow_up'
  | 'my_hot_list'
  | 'submitted_this_week';

export const VIEWS: readonly { key: ViewKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'available_now', label: 'Available now' },
  { key: 'in_touch_6mo', label: 'In touch < 6 mo' },
  { key: 'needs_follow_up', label: 'Needs follow-up' },
  { key: 'my_hot_list', label: 'My hot list' },
  { key: 'submitted_this_week', label: 'Submitted · this week' },
];

// Views resolved server-side via the ?preset= cross-schema path (4c).
export const CROSS_SCHEMA_VIEWS: readonly ViewKey[] = [
  'in_touch_6mo',
  'needs_follow_up',
  'submitted_this_week',
];

// ── Sort — NATIVE columns only (4a buildOrderBy). NO rate (free-text, never an
// ordering — R10) and NO last_activity (cross-schema sort, not BE-backed). ────
export type SortKey = 'name' | 'location';
export type SortDir = 'asc' | 'desc';

// ── The server query builder ─────────────────────────────────────────────────
export interface TalentQueryInput {
  readonly facets: FacetState;
  readonly query: ParsedQuery;
  readonly scope: ScopeMode;
  readonly view: ViewKey;
  readonly sort: SortKey;
  readonly dir: SortDir;
  readonly cursor: string | null;
  readonly sessionSub: string | null;
  readonly pageSize?: number;
}

export function buildTalentQuery(i: TalentQueryInput): URLSearchParams {
  const p = new URLSearchParams();
  p.set('paged', 'true');

  // q ← name: tokens + free text (server: first/last ILIKE).
  const qterms = [
    ...i.query.tokens
      .filter((t) => t.supported && t.key === 'name')
      .map((t) => t.value),
    i.query.free.trim(),
  ].filter((s) => s !== '');
  if (qterms.length > 0) p.set('q', qterms.join(' '));

  // skills ← facet skills + skill: tokens (server: key_skills contains, any/all).
  const skills = [
    ...i.facets.skills,
    ...i.query.tokens
      .filter((t) => t.supported && t.key === 'skill')
      .map((t) => t.value),
  ];
  if (skills.length > 0) {
    p.set('skills', skills.join(','));
    p.set('skill_match', i.facets.skillMatch);
  }

  // availability — the Available-now view is a native availability shortcut.
  const availability = [...i.facets.availability];
  if (i.view === 'available_now' && !availability.includes('available_now')) {
    availability.push('available_now');
  }
  if (availability.length > 0) p.set('availability', availability.join(','));

  if (i.facets.engagementTypes.length > 0)
    p.set('engagement', i.facets.engagementTypes.join(','));
  if (i.facets.sources.length > 0) p.set('source', i.facets.sources.join(','));
  // hot — the My-hot-list view is a native is_hot shortcut.
  if (i.facets.hotOnly || i.view === 'my_hot_list') p.set('hot', 'true');

  // location ← facet text + loc: token (server: city/state ILIKE).
  const locTok = i.query.tokens.find((t) => t.supported && t.key === 'loc');
  const location = i.facets.location.trim() || (locTok?.value ?? '');
  if (location !== '') p.set('location', location);

  // scope → owner-is-me (native owner param) or ?scope=my_team (4c).
  if (i.scope === 'mine' && i.sessionSub !== null) p.set('owner', i.sessionSub);
  else if (i.scope === 'team') p.set('scope', 'my_team');

  // cross-schema views resolve via ?preset= (native views already folded in).
  if (CROSS_SCHEMA_VIEWS.includes(i.view)) p.set('preset', i.view);

  p.set('sort', i.sort);
  p.set('dir', i.dir);
  if (i.cursor !== null) p.set('cursor', i.cursor);
  if (i.pageSize !== undefined) p.set('page_size', String(i.pageSize));
  return p;
}
