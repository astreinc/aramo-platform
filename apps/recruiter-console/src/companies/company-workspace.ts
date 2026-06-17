import type { CompanyView } from './types';

// Companies workspace — the pure projection/filter layer behind the faceted
// CompaniesListView (mirrors talent-workspace.ts). Everything here is a pure
// function over the LOADED CompanyView set: GET /v1/companies is non-paged
// (capped 50), so segments / facets / counts are CLIENT-SIDE, honestly bounded
// by the cap banner. No @aramo/* edge; binds only to real CompanyView fields.
//
// Field mapping (mockup → real field):
//   relationship ← status   (active→Client · prospect→Prospect ·
//                            inactive→Dormant · do_not_contact→Do-not-contact;
//                            "lead" is NOT a BE status, so it is not modelled)
//   tier         ← client_tier (a→Key · b→Growth · c→Standard; null→untiered)
//   hot          ← is_hot
//   industry / location / owner ← industry / city+state / owner_id
// Health/risk rating, revenue, fill-rate, placements, off-limits and multi-
// person team are NOT backend fields — omitted (never fabricated). "Quiet 30d+"
// is the one derived signal (from last_activity_at), and it is honest.

// ── Relationship (status) ──
export const RELATIONSHIP_LABELS: Record<string, string> = {
  active: 'Client',
  prospect: 'Prospect',
  inactive: 'Dormant',
  do_not_contact: 'Do not contact',
};
export type RelationshipTone = 'ok' | 'info' | 'neutral' | 'danger';
export const RELATIONSHIP_TONES: Record<string, RelationshipTone> = {
  active: 'ok',
  prospect: 'info',
  inactive: 'neutral',
  do_not_contact: 'danger',
};
export function relationshipLabel(status: string): string {
  return RELATIONSHIP_LABELS[status] ?? status;
}

// ── Tier (client_tier) ──
export const TIER_LABELS: Record<string, string> = {
  a: 'Key account',
  b: 'Growth',
  c: 'Standard',
};
export function tierLabel(tier: string | null | undefined): string | null {
  if (tier === null || tier === undefined || tier === '') return null;
  return TIER_LABELS[tier] ?? tier;
}

// ── Derived display helpers ──
export function locationOf(c: CompanyView): string {
  const city = c.city?.trim() ?? '';
  const state = c.state?.trim() ?? '';
  if (city === '' && state === '') return '—';
  if (city === '') return state;
  if (state === '') return city;
  return `${city}, ${state}`;
}

export const QUIET_DAYS = 30;

// Whole-days since the last logged contact. Returns null when never contacted.
export function daysSinceContact(
  c: CompanyView,
  now: number = Date.now(),
): number | null {
  if (c.last_activity_at === null) return null;
  const then = new Date(c.last_activity_at).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now - then) / 86_400_000));
}

// "Quiet" = no contact in QUIET_DAYS or never contacted (the honest derived
// signal; NOT an account-health judgement, which the BE cannot back).
export function isQuiet(c: CompanyView, now: number = Date.now()): boolean {
  const d = daysSinceContact(c, now);
  return d === null || d >= QUIET_DAYS;
}

export function lastContactLabel(
  c: CompanyView,
  now: number = Date.now(),
): string {
  const d = daysSinceContact(c, now);
  if (d === null) return 'No contact';
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  return w < 5 ? `${w}w ago` : `${Math.floor(d / 30)}mo ago`;
}

// ── Scope (client-side; only owner is modelled, so My/All only — there is no
// team-of-companies signal, so the mockup's "Team" tab is intentionally absent). ──
export type ScopeMode = 'mine' | 'all';

export function inScope(
  c: CompanyView,
  scope: ScopeMode,
  myId: string | null,
): boolean {
  if (scope === 'all') return true;
  return myId !== null && c.owner_id === myId;
}

// ── Segments (the "Views" bar; one active at a time, 'all' = none). ──
export type SegmentKey = 'all' | 'key' | 'prospects' | 'quiet' | 'hot';
export const SEGMENTS: readonly { key: SegmentKey; label: string }[] = [
  { key: 'all', label: 'All accounts' },
  { key: 'key', label: 'Key accounts' },
  { key: 'prospects', label: 'Prospects to chase' },
  { key: 'quiet', label: 'Quiet 30d+' },
  { key: 'hot', label: 'Hot clients' },
];

export function inSegment(
  c: CompanyView,
  seg: SegmentKey,
  now: number = Date.now(),
): boolean {
  switch (seg) {
    case 'all':
      return true;
    case 'key':
      return c.client_tier === 'a';
    case 'prospects':
      return c.status === 'prospect';
    case 'quiet':
      return isQuiet(c, now);
    case 'hot':
      return c.is_hot;
  }
}

// ── Facets (left rail; AND across groups, OR within a group). ──
export type FacetFlag = 'hot' | 'quiet' | 'exclusive' | 'off_limits';
export interface FacetState {
  readonly relationship: readonly string[]; // status values
  readonly tier: readonly string[]; // a|b|c
  readonly industry: readonly string[];
  readonly flags: readonly FacetFlag[];
}
export const EMPTY_FACETS: FacetState = {
  relationship: [],
  tier: [],
  industry: [],
  flags: [],
};

function flagHolds(c: CompanyView, flag: FacetFlag, now: number): boolean {
  switch (flag) {
    case 'hot':
      return c.is_hot;
    case 'quiet':
      return isQuiet(c, now);
    case 'exclusive':
      return c.exclusivity;
    case 'off_limits':
      return c.off_limits;
  }
}

export function passesFacets(
  c: CompanyView,
  facets: FacetState,
  now: number = Date.now(),
): boolean {
  if (facets.relationship.length > 0 && !facets.relationship.includes(c.status))
    return false;
  if (
    facets.tier.length > 0 &&
    !(c.client_tier !== null && facets.tier.includes(c.client_tier))
  )
    return false;
  if (
    facets.industry.length > 0 &&
    !(c.industry !== null && facets.industry.includes(c.industry))
  )
    return false;
  for (const flag of facets.flags) {
    if (!flagHolds(c, flag, now)) return false;
  }
  return true;
}

// Free-text quick filter — name / industry / city / state / tags (client-side,
// over the loaded set; the BE ?q= name search is a separate capability not used
// here so the experience stays consistent with the client-side facets).
export function matchesText(c: CompanyView, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const hay = [
    c.name,
    c.industry ?? '',
    c.city ?? '',
    c.state ?? '',
    ...(c.tags ?? []),
  ]
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}

// ── Aggregate helpers ──
export function deriveIndustries(
  companies: readonly CompanyView[],
): readonly string[] {
  const set = new Set<string>();
  for (const c of companies) {
    if (c.industry !== null && c.industry.trim() !== '') set.add(c.industry);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function countWhere(
  companies: readonly CompanyView[],
  pred: (c: CompanyView) => boolean,
): number {
  let n = 0;
  for (const c of companies) if (pred(c)) n += 1;
  return n;
}

// ── Phase 2 — server-side paged contract (hand-mirrored from
// libs/company/src/lib/dto/company-search.dto.ts; flat shapes — no drift spec). ──
export interface CompanyFacetBucket {
  readonly value: string;
  readonly count: number;
}
export interface CompanyFacets {
  readonly relationship: readonly CompanyFacetBucket[]; // status
  readonly tier: readonly CompanyFacetBucket[]; // client_tier
  readonly industry: readonly CompanyFacetBucket[];
  readonly hot: number;
  readonly off_limits: number;
  readonly exclusivity: number;
  readonly quiet: number;
}
export interface CompanySearchPage {
  readonly items: readonly CompanyView[];
  readonly next_cursor: string | null;
  readonly facets: CompanyFacets;
  readonly total: number;
}

// Translate the workspace state (scope + one segment + facet selections) into the
// server query params. The in-list TEXT box stays client-side (it filters the
// loaded page; it does NOT send ?q=, so the surface never needs company:search).
export interface BuildQueryInput {
  readonly scope: ScopeMode;
  readonly segment: SegmentKey;
  readonly facets: FacetState;
  readonly cursor?: string | null;
  readonly pageSize?: number;
}
export function buildCompanyQuery(i: BuildQueryInput): URLSearchParams {
  const p = new URLSearchParams();
  p.set('paged', 'true');
  if (i.scope === 'mine') p.set('scope', 'mine');
  // relationship = facet selection ∪ the prospects segment.
  const status = new Set(i.facets.relationship);
  if (i.segment === 'prospects') status.add('prospect');
  if (status.size > 0) p.set('status', [...status].join(','));
  // tier = facet selection ∪ the key-accounts segment.
  const tier = new Set(i.facets.tier);
  if (i.segment === 'key') tier.add('a');
  if (tier.size > 0) p.set('client_tier', [...tier].join(','));
  if (i.facets.industry.length > 0)
    p.set('industry', i.facets.industry.join(','));
  if (i.facets.flags.includes('hot') || i.segment === 'hot')
    p.set('is_hot', 'true');
  if (i.facets.flags.includes('quiet') || i.segment === 'quiet')
    p.set('quiet', 'true');
  if (i.facets.flags.includes('off_limits')) p.set('off_limits', 'true');
  if (i.facets.flags.includes('exclusive')) p.set('exclusivity', 'true');
  if (i.cursor != null && i.cursor !== '') p.set('cursor', i.cursor);
  if (i.pageSize !== undefined) p.set('page_size', String(i.pageSize));
  return p;
}

// ── Phase 3 — per-company metrics (hand-mirrored from
// libs/reporting/src/lib/dto/report.view.ts CompanyMetricsView). ──
export interface CompanyMetrics {
  readonly company_id: string;
  readonly open_reqs: number;
  readonly active_placements: number;
  readonly submitted: number;
  readonly openings: number;
  readonly filled: number;
  readonly fill_rate: number | null; // percent 0-100, null when no openings
}
export interface CompanyMetricsResponse {
  readonly items: readonly CompanyMetrics[];
}

// ── Phase 4 — account team + placements (hand-mirrored from the BE views). ──
export interface CompanyTeam {
  readonly owner_id: string | null;
  readonly member_user_ids: readonly string[];
}
export interface CompanyPlacement {
  readonly pipeline_id: string;
  readonly talent_record_id: string;
  readonly requisition_id: string;
  readonly requisition_title: string;
}
export interface CompanyPlacementsResponse {
  readonly items: readonly CompanyPlacement[];
}

// Rule-based account briefing — a deterministic summary built from REAL fields +
// metrics. NOT AI, not an ordinal rating (R10/ADR-0019 clean): it only restates
// counts and last-contact, and suggests a transparent next move. Aramo Core adds
// richer reasoning later via the ReservedSeam beneath it.
export function accountBriefing(
  c: CompanyView,
  metrics: CompanyMetrics | null,
  now: number = Date.now(),
): string {
  const rel = relationshipLabel(c.status);
  const last = lastContactLabel(c, now);
  if (metrics === null) {
    return `${c.name} is a ${rel.toLowerCase()} account. Last contact ${last}.`;
  }
  const bits: string[] = [];
  bits.push(
    `${metrics.open_reqs} open req${metrics.open_reqs === 1 ? '' : 's'}`,
  );
  if (metrics.submitted > 0)
    bits.push(`${metrics.submitted} submitted in pipeline`);
  if (metrics.active_placements > 0)
    bits.push(
      `${metrics.active_placements} active placement${metrics.active_placements === 1 ? '' : 's'}`,
    );
  const head = `${c.name} has ${bits.join(', ')}.`;
  const tail = isQuiet(c, now)
    ? ` Last contact ${last} — suggested: a check-in to keep momentum.`
    : metrics.submitted > 0
      ? ` Suggested: chase the pending submittals.`
      : ` Last contact ${last}.`;
  return head + tail;
}

// Segment count badges, derived from the server facets (stable; base-where).
export function segmentCountFrom(
  facets: CompanyFacets | null,
  total: number,
  key: SegmentKey,
): number | null {
  if (facets === null) return key === 'all' ? total : null;
  switch (key) {
    case 'all':
      return total;
    case 'key':
      return facets.tier.find((b) => b.value === 'a')?.count ?? 0;
    case 'prospects':
      return facets.relationship.find((b) => b.value === 'prospect')?.count ?? 0;
    case 'quiet':
      return facets.quiet;
    case 'hot':
      return facets.hot;
  }
}
