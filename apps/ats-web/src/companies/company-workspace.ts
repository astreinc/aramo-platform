import type { CompanyRelationshipView, CompanyView } from './types';

// Companies workspace — the pure projection/filter layer behind the faceted
// CompaniesListView. Everything here is a pure function over the LOADED
// CompanyView set. No @aramo/* edge; binds only to real CompanyView fields.
//
// Company Party/Role (ADR-0032): the relationship dimension is now the real
// `relationships[]` (CLIENT|VENDOR|PARTNER × PROSPECT|ACTIVE|ON_HOLD|INACTIVE),
// NOT the retiring `status` column. Tabs = relationship TYPE; the status pill =
// relationship STATUS.
//   tier   ← client_tier (a→Key · b→Growth · c→Standard; null→untiered)
//   hot    ← is_hot
//   industry / location / owner ← industry / city+state / owner_id

// ── Relationship TYPE (the tabs) ──
export const REL_TYPE_ORDER = ['CLIENT', 'VENDOR', 'PARTNER'] as const;
export const REL_TYPE_LABELS: Record<string, string> = {
  CLIENT: 'Client',
  VENDOR: 'Vendor',
  PARTNER: 'Partner',
};
export type RelationshipTone = 'ok' | 'info' | 'neutral' | 'danger';
export const REL_TYPE_TONES: Record<string, RelationshipTone> = {
  CLIENT: 'info',
  VENDOR: 'danger', // orange family in the prototype
  PARTNER: 'ok', // green family
};
export function relTypeLabel(type: string): string {
  return REL_TYPE_LABELS[type] ?? type;
}

// ── Relationship STATUS (the lifecycle pill) ──
export const REL_STATUS_LABELS: Record<string, string> = {
  PROSPECT: 'Prospect',
  ACTIVE: 'Active',
  ON_HOLD: 'On hold',
  INACTIVE: 'Inactive',
};
export const REL_STATUS_TONES: Record<string, RelationshipTone> = {
  ACTIVE: 'ok',
  PROSPECT: 'info',
  ON_HOLD: 'info',
  INACTIVE: 'neutral',
};
export function relStatusLabel(status: string): string {
  return REL_STATUS_LABELS[status] ?? status;
}

// ── Relationship helpers over a company's relationships[] ──
export function companyTypes(c: CompanyView): readonly string[] {
  const seen = new Set((c.relationships ?? []).map((r) => r.type));
  return REL_TYPE_ORDER.filter((t) => seen.has(t));
}
export function hasType(c: CompanyView, type: string): boolean {
  return (c.relationships ?? []).some((r) => r.type === type);
}
// The representative relationship for a single-status display (Status column):
// CLIENT wins, then VENDOR, then PARTNER, else the first.
export function primaryRelationship(
  c: CompanyView,
): CompanyRelationshipView | null {
  const rels = c.relationships ?? [];
  for (const t of REL_TYPE_ORDER) {
    const found = rels.find((r) => r.type === t);
    if (found !== undefined) return found;
  }
  return rels[0] ?? null;
}
export function primaryStatus(c: CompanyView): string | null {
  return primaryRelationship(c)?.status ?? null;
}
// The status of a company's relationship of a given type (null if absent).
export function relStatusFor(c: CompanyView, type: string): string | null {
  return (c.relationships ?? []).find((r) => r.type === type)?.status ?? null;
}

// ── Relationship TYPE tabs (All / Clients / Vendors / Partners) ──
export type RelationshipTab = 'all' | 'CLIENT' | 'VENDOR' | 'PARTNER';
export const RELATIONSHIP_TABS: readonly { key: RelationshipTab; label: string }[] = [
  { key: 'all', label: 'All companies' },
  { key: 'CLIENT', label: 'Clients' },
  { key: 'VENDOR', label: 'Vendors' },
  { key: 'PARTNER', label: 'Partners' },
];

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

export function daysSinceContact(
  c: CompanyView,
  now: number = Date.now(),
): number | null {
  if (c.last_activity_at === null) return null;
  const then = new Date(c.last_activity_at).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now - then) / 86_400_000));
}

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

// ── Scope (only owner is modelled → My/All). ──
export type ScopeMode = 'mine' | 'all';
export function inScope(
  c: CompanyView,
  scope: ScopeMode,
  myId: string | null,
): boolean {
  if (scope === 'all') return true;
  return myId !== null && c.owner_id === myId;
}

// ── Facets (horizontal filter pills; AND across groups). ──
export type FacetFlag = 'hot' | 'quiet' | 'exclusive' | 'off_limits';
export interface FacetState {
  readonly relationship_type: readonly string[]; // CLIENT|VENDOR|PARTNER (from the tab)
  readonly relationship_status: readonly string[]; // PROSPECT|ACTIVE|ON_HOLD|INACTIVE
  readonly tier: readonly string[]; // a|b|c
  readonly industry: readonly string[];
  readonly flags: readonly FacetFlag[];
}
export const EMPTY_FACETS: FacetState = {
  relationship_type: [],
  relationship_status: [],
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

// Client-side facet pass (secondary filter over the loaded page). Relationship
// type/status apply some-relationship semantics matching the BE.
export function passesFacets(
  c: CompanyView,
  facets: FacetState,
  now: number = Date.now(),
): boolean {
  if (
    facets.relationship_type.length > 0 &&
    !facets.relationship_type.some((t) => hasType(c, t))
  )
    return false;
  if (
    facets.relationship_status.length > 0 &&
    !(c.relationships ?? []).some((r) =>
      facets.relationship_status.includes(r.status),
    )
  )
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

// ── Server-side paged contract (hand-mirrored from
// libs/company/src/lib/dto/company-search.dto.ts). ──
export interface CompanyFacetBucket {
  readonly value: string;
  readonly count: number;
}
export interface CompanyFacets {
  // Company Party/Role (ADR-0032, VR5) — real relationship dimensions.
  readonly relationship_type: readonly CompanyFacetBucket[]; // CLIENT|VENDOR|PARTNER
  readonly relationship_status: readonly CompanyFacetBucket[]; // PROSPECT|ACTIVE|ON_HOLD|INACTIVE
  readonly tier: readonly CompanyFacetBucket[];
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

// Translate workspace state (scope + tab + facet pills) into server query params.
export interface BuildQueryInput {
  readonly scope: ScopeMode;
  readonly tab: RelationshipTab;
  readonly facets: FacetState;
  readonly cursor?: string | null;
  readonly pageSize?: number;
}
export function buildCompanyQuery(i: BuildQueryInput): URLSearchParams {
  const p = new URLSearchParams();
  p.set('paged', 'true');
  if (i.scope === 'mine') p.set('scope', 'mine');
  // relationship_type = the active tab ∪ any explicit type-facet selection.
  const types = new Set(i.facets.relationship_type);
  if (i.tab !== 'all') types.add(i.tab);
  if (types.size > 0) p.set('relationship_type', [...types].join(','));
  if (i.facets.relationship_status.length > 0)
    p.set('relationship_status', i.facets.relationship_status.join(','));
  const tier = new Set(i.facets.tier);
  if (tier.size > 0) p.set('client_tier', [...tier].join(','));
  if (i.facets.industry.length > 0)
    p.set('industry', i.facets.industry.join(','));
  if (i.facets.flags.includes('hot')) p.set('is_hot', 'true');
  if (i.facets.flags.includes('quiet')) p.set('quiet', 'true');
  if (i.facets.flags.includes('off_limits')) p.set('off_limits', 'true');
  if (i.facets.flags.includes('exclusive')) p.set('exclusivity', 'true');
  if (i.cursor != null && i.cursor !== '') p.set('cursor', i.cursor);
  if (i.pageSize !== undefined) p.set('page_size', String(i.pageSize));
  return p;
}

// Tab count badges, derived from the server facets (stable; base-where).
export function tabCountFrom(
  facets: CompanyFacets | null | undefined,
  total: number,
  tab: RelationshipTab,
): number | null {
  if (facets === null || facets === undefined) {
    return tab === 'all' ? total : null;
  }
  if (tab === 'all') return total;
  // Tolerate a facets payload without the relationship_type dimension (older /
  // legacy {items}-only responses) — drop the badge rather than throw.
  return facets.relationship_type?.find((b) => b.value === tab)?.count ?? 0;
}

// ── Per-company metrics (hand-mirrored from CompanyMetricsView). ──
export interface CompanyMetrics {
  readonly company_id: string;
  readonly open_reqs: number;
  readonly active_placements: number;
  readonly submitted: number;
  readonly openings: number;
  readonly filled: number;
  readonly fill_rate: number | null;
}
export interface CompanyMetricsResponse {
  readonly items: readonly CompanyMetrics[];
}

// ── Account team + placements (hand-mirrored from the BE views). ──
export interface CompanyTeam {
  readonly owner_id: string | null;
  readonly member_user_ids: readonly string[];
}
export interface CompanyPlacement {
  readonly placement_process_id: string;
  readonly pipeline_id?: string;
  readonly talent_record_id: string;
  readonly requisition_id: string;
  readonly requisition_title: string;
}
export interface CompanyPlacementsResponse {
  readonly items: readonly CompanyPlacement[];
}

// Account briefing — a deterministic restatement of REAL facts only. Carries NO
// evaluative verdict (R10; no health/at-risk/quality judgement, no suggested
// move). Aramo Core supplies richer reasoning later via the ReservedSeam.
export function accountBriefing(
  c: CompanyView,
  metrics: CompanyMetrics | null,
  now: number = Date.now(),
): string {
  const last = lastContactLabel(c, now);
  if (metrics === null) {
    return `${c.name} — last contact ${last}.`;
  }
  const parts: string[] = [
    `${metrics.open_reqs} open req${metrics.open_reqs === 1 ? '' : 's'}`,
    `${metrics.submitted} submitted`,
    `${metrics.active_placements} active placement${metrics.active_placements === 1 ? '' : 's'}`,
  ];
  if (metrics.fill_rate !== null) parts.push(`${metrics.fill_rate}% fill rate`);
  return `${c.name}: ${parts.join(' · ')}. Last contact ${last}.`;
}
