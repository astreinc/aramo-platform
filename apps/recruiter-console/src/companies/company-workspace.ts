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
export type FacetFlag = 'hot' | 'quiet' | 'exclusive' | 'website';
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
    case 'website':
      return c.url !== null && c.url.trim() !== '';
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
