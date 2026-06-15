// Talent workspace — the pure filter/facet/token model behind the faceted
// Talent page. Kept framework-free so it is unit-tested in isolation
// (talent-workspace.spec.ts) and the view stays a thin renderer.
//
// SUBSTRATE REALITY (audited; see the page's gap report): the backend talent
// list (GET /v1/talent-records) takes only `q`/`resume_q` and returns a capped
// (≤50) page with NO server-side facets/sort/pagination, and TalentRecordView
// has NO status / availability / numeric-rate / tags / engagement-type /
// last-activity fields. So every facet/token here operates CLIENT-SIDE over the
// loaded page and counts are "within the loaded set" — never fabricated. Facets
// that need absent fields are declared STUB and rendered disabled by the view.

import {
  ACTIVE_FLOW_COLUMNS,
  PIPELINE_STATUS_LABELS,
  type PipelineStatus,
} from '../pipeline/types';

import type { TalentRecordView } from './types';

// ── Segment 3 enrichment vocab (composed fields) ─────────────────────────────
// consent_summary mirrors libs/consent ConsentSummary (3 values; BE-typed on
// the wire). stage uses the pipeline funnel labels. recency buckets are FE
// presentational over last_activity_at.
export const CONSENT_SUMMARY_VALUES = [
  'contactable',
  'expiring_lt_30d',
  'do_not_contact',
] as const;
export const CONSENT_LABELS: Record<string, string> = {
  contactable: 'Contactable',
  expiring_lt_30d: 'Expiring < 30d',
  do_not_contact: 'Do-not-contact',
};
export const STAGE_FACET_VALUES: readonly PipelineStatus[] = ACTIVE_FLOW_COLUMNS;
export const STAGE_LABELS = PIPELINE_STATUS_LABELS;

export type Recency = '' | 'today' | '7d' | '30d' | 'stale';
export const RECENCY_OPTIONS: readonly { key: Recency; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'stale', label: 'No activity 90 days+' },
];

export function daysSinceActivity(t: TalentRecordView): number | null {
  const iso = t.last_activity_at;
  if (iso === undefined || iso === null) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

function matchesRecency(t: TalentRecordView, recency: Recency): boolean {
  if (recency === '') return true;
  const d = daysSinceActivity(t);
  if (recency === 'stale') return d === null || d >= 90; // no activity counts as stale
  if (d === null) return false;
  if (recency === 'today') return d === 0;
  if (recency === '7d') return d <= 7;
  return d <= 30; // '30d'
}

// Re-export the stated-field vocab so consumers have one workspace import.
export {
  AVAILABILITY_STATUS_VALUES,
  ENGAGEMENT_TYPE_VALUES,
  AVAILABILITY_LABELS,
  ENGAGEMENT_LABELS,
  type AvailabilityStatus,
  type EngagementType,
} from './stated-fields';

export type ScopeMode = 'mine' | 'team' | 'all';

// ── Token search ────────────────────────────────────────────────────────────
// Grammar: `key:value` tokens + free text. Backable keys filter client-side
// over the loaded page; unsupported keys are surfaced as flagged chips (kept
// visible so the recruiter sees they were ignored — never silently dropped).
export type TokenKey = 'skill' | 'loc' | 'owner' | 'name';
export const SUPPORTED_TOKEN_KEYS: readonly TokenKey[] = [
  'skill',
  'loc',
  'owner',
  'name',
];
// Recognized in the prototype grammar but NOT backable (no field server- or
// client-side): kept as flagged, non-filtering chips.
export const UNSUPPORTED_TOKEN_KEYS = ['status', 'intouch'] as const;

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
    } else if (
      (UNSUPPORTED_TOKEN_KEYS as readonly string[]).includes(rawKey)
    ) {
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

// ── Facet state ───────────────────────────────────────────────────────────
export type SkillMatch = 'any' | 'all';

export interface FacetState {
  readonly skills: readonly string[];
  readonly skillMatch: SkillMatch;
  readonly sources: readonly string[];
  readonly hotOnly: boolean;
  readonly location: string;
  // Talent-stated facets (stated-fields amendment). availability holds the
  // selected buckets (the 'unknown' bucket matches both null AND 'unknown').
  readonly availability: readonly string[];
  readonly engagementTypes: readonly string[];
  // Segment 3 enrichment facets (now real per-row).
  readonly consentSummaries: readonly string[];
  readonly stages: readonly string[];
  readonly recency: Recency;
}

export const EMPTY_FACETS: FacetState = {
  skills: [],
  skillMatch: 'any',
  sources: [],
  hotOnly: false,
  location: '',
  availability: [],
  engagementTypes: [],
  consentSummaries: [],
  stages: [],
  recency: '',
};

// The "Unknown" availability bucket matches BOTH null (never captured) and the
// explicit 'unknown' stated value (§4.1) — null collapses to 'unknown' here.
export function effectiveAvailability(t: TalentRecordView): string {
  return t.availability_status ?? 'unknown';
}

// ── Helpers over the (free-text) talent fields ──────────────────────────────
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

// ── Facet counts — derived from the LOADED page only (honest) ────────────────
export interface FacetCount {
  readonly value: string;
  readonly count: number;
}

function tally(values: readonly string[]): FacetCount[] {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export interface DerivedFacets {
  readonly skills: readonly FacetCount[];
  readonly sources: readonly FacetCount[];
  readonly hot: number;
  readonly availability: readonly FacetCount[];
  readonly engagement: readonly FacetCount[];
  readonly consent: readonly FacetCount[];
  readonly stage: readonly FacetCount[];
  readonly recency: Readonly<Record<Recency, number>>;
}

export function deriveFacets(
  talent: readonly TalentRecordView[],
): DerivedFacets {
  const skills: string[] = [];
  const sources: string[] = [];
  const availability: string[] = [];
  const engagement: string[] = [];
  const consent: string[] = [];
  const stage: string[] = [];
  const recency: Record<Recency, number> = {
    '': 0,
    today: 0,
    '7d': 0,
    '30d': 0,
    stale: 0,
  };
  let hot = 0;
  for (const t of talent) {
    for (const s of skillsOf(t)) skills.push(s);
    if (t.source !== null && t.source.trim() !== '') sources.push(t.source);
    if (t.is_hot) hot += 1;
    availability.push(effectiveAvailability(t)); // null collapses to 'unknown'
    if (t.engagement_type !== null) engagement.push(t.engagement_type);
    if (t.consent_summary !== undefined && t.consent_summary !== null) {
      consent.push(t.consent_summary);
    }
    if (t.current_stage != null) stage.push(t.current_stage.stage);
    // recency bucket counts (a talent counts toward each window it satisfies).
    if (matchesRecency(t, 'today')) recency.today += 1;
    if (matchesRecency(t, '7d')) recency['7d'] += 1;
    if (matchesRecency(t, '30d')) recency['30d'] += 1;
    if (matchesRecency(t, 'stale')) recency.stale += 1;
  }
  return {
    skills: tally(skills),
    sources: tally(sources),
    hot,
    availability: tally(availability),
    engagement: tally(engagement),
    consent: tally(consent),
    stage: tally(stage),
    recency,
  };
}

// ── Filtering ───────────────────────────────────────────────────────────────
export interface FilterInput {
  readonly facets: FacetState;
  readonly query: ParsedQuery;
  readonly scope: ScopeMode;
  readonly sessionSub: string | null;
  /** owner_id → display name, for `owner:` token matching. */
  readonly ownerNames: Record<string, string>;
}

function matchesQuery(
  t: TalentRecordView,
  q: ParsedQuery,
  ownerNames: Record<string, string>,
): boolean {
  for (const tok of q.tokens) {
    if (!tok.supported) continue; // flagged, non-filtering
    const v = tok.value.toLowerCase();
    if (tok.key === 'skill') {
      if (!skillsOf(t).some((s) => s.toLowerCase().includes(v))) return false;
    } else if (tok.key === 'loc') {
      if (!locationOf(t).toLowerCase().includes(v)) return false;
    } else if (tok.key === 'owner') {
      const ownerName = t.owner_id ? (ownerNames[t.owner_id] ?? '') : '';
      const ownerMatch =
        v === 'me'
          ? false // resolved by scope, not here
          : ownerName.toLowerCase().includes(v);
      if (!ownerMatch) return false;
    } else if (tok.key === 'name') {
      if (!fullName(t).toLowerCase().includes(v)) return false;
    }
  }
  if (q.free.trim() !== '') {
    const hay =
      `${fullName(t)} ${t.key_skills ?? ''} ${locationOf(t)}`.toLowerCase();
    if (!hay.includes(q.free.trim().toLowerCase())) return false;
  }
  return true;
}

export function applyFilters(
  talent: readonly TalentRecordView[],
  input: FilterInput,
): readonly TalentRecordView[] {
  const { facets, query, scope, sessionSub, ownerNames } = input;
  const skillNeedles = facets.skills.map((s) => s.toLowerCase());
  return talent.filter((t) => {
    // scope tabs — 'team' is a STUB (no team tier); treated as 'all'.
    if (scope === 'mine' && t.owner_id !== sessionSub) return false;
    if (facets.hotOnly && !t.is_hot) return false;
    if (facets.sources.length > 0) {
      if (t.source === null || !facets.sources.includes(t.source)) return false;
    }
    if (facets.location.trim() !== '') {
      if (!locationOf(t).toLowerCase().includes(facets.location.trim().toLowerCase()))
        return false;
    }
    if (facets.availability.length > 0) {
      if (!facets.availability.includes(effectiveAvailability(t))) return false;
    }
    if (facets.engagementTypes.length > 0) {
      // null engagement (not stated) drops out when filtering by a type.
      if (t.engagement_type === null || !facets.engagementTypes.includes(t.engagement_type))
        return false;
    }
    if (facets.consentSummaries.length > 0) {
      if (
        t.consent_summary === undefined ||
        t.consent_summary === null ||
        !facets.consentSummaries.includes(t.consent_summary)
      )
        return false;
    }
    if (facets.stages.length > 0) {
      if (t.current_stage == null || !facets.stages.includes(t.current_stage.stage))
        return false;
    }
    if (!matchesRecency(t, facets.recency)) return false;
    if (skillNeedles.length > 0) {
      const have = skillsOf(t).map((s) => s.toLowerCase());
      const test = (needle: string) => have.some((h) => h.includes(needle));
      if (facets.skillMatch === 'all') {
        if (!skillNeedles.every(test)) return false;
      } else if (!skillNeedles.some(test)) return false;
    }
    if (!matchesQuery(t, query, ownerNames)) return false;
    return true;
  });
}

// ── Saved views (smart-lists) ───────────────────────────────────────────────
// Only views expressible over the loaded page + real fields are BACKABLE; the
// prototype's recency/pipeline views need absent fields (last-activity,
// availability, per-talent stage) → STUB (disabled + "connects later" note).
export interface SavedView {
  readonly key: string;
  readonly label: string;
  readonly backable: boolean;
  /** carry note shown on disabled (stub) views */
  readonly note?: string;
}

export const SAVED_VIEWS: readonly SavedView[] = [
  { key: 'all', label: 'All', backable: true },
  { key: 'mine', label: 'My talent', backable: true },
  { key: 'hot', label: 'Hot list', backable: true },
  {
    key: 'available',
    label: 'Available now',
    backable: false,
    note: 'Needs an availability field on the talent record (carry).',
  },
  {
    key: 'intouch',
    label: 'In touch < 6 mo',
    backable: false,
    note: 'Needs a bulk last-activity read (carry — currently per-talent N+1).',
  },
  {
    key: 'followup',
    label: 'Needs follow-up',
    backable: false,
    note: 'Needs a bulk last-activity read (carry).',
  },
  {
    key: 'submitted',
    label: 'Submitted · this week',
    backable: false,
    note: 'Needs a submitted-this-week pipeline rollup (carry).',
  },
];

export function applyView(
  key: string,
  talent: readonly TalentRecordView[],
  sessionSub: string | null,
): readonly TalentRecordView[] {
  if (key === 'mine') return talent.filter((t) => t.owner_id === sessionSub);
  if (key === 'hot') return talent.filter((t) => t.is_hot);
  return talent; // 'all' and any non-backable view fall back to the full pool
}

// ── Sort ────────────────────────────────────────────────────────────────────
export type SortKey = 'name' | 'rate' | 'location' | 'owner' | 'last_activity';
export type SortDir = 'asc' | 'desc';

export function sortTalent(
  talent: readonly TalentRecordView[],
  key: SortKey,
  dir: SortDir,
  ownerNames: Record<string, string> = {},
): readonly TalentRecordView[] {
  const sign = dir === 'asc' ? 1 : -1;
  const ownerOf = (t: TalentRecordView): string | null =>
    t.owner_id ? (ownerNames[t.owner_id] ?? '') : null;
  return [...talent].sort((a, b) => {
    switch (key) {
      case 'name':
        return sign * fullName(a).localeCompare(fullName(b));
      case 'rate':
        return sign * statedRate(a).localeCompare(statedRate(b));
      case 'location':
        return sign * locationOf(a).localeCompare(locationOf(b));
      case 'owner': {
        const ao = ownerOf(a);
        const bo = ownerOf(b);
        // Unowned always sorts last, regardless of direction.
        if (ao === null && bo === null) return 0;
        if (ao === null) return 1;
        if (bo === null) return -1;
        return sign * ao.localeCompare(bo);
      }
      case 'last_activity': {
        // ISO strings compare chronologically; no-activity always sorts last.
        const al = a.last_activity_at ?? null;
        const bl = b.last_activity_at ?? null;
        if (al === null && bl === null) return 0;
        if (al === null) return 1;
        if (bl === null) return -1;
        return sign * al.localeCompare(bl);
      }
    }
  });
}
