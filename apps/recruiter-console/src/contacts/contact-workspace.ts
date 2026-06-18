import type { ContactView } from '../companies/types';

// Contacts workspace — the pure projection/query layer behind the faceted
// ContactsListView (mirrors company-workspace.ts). The BE list is SERVER-PAGED
// (GET /v1/contacts?paged=true → keyset cursor + server facet counts), so scope
// (My/All), segments, the facet rail, and the cold-call mode are SERVER query
// params built by buildContactQuery(). The in-list text box filters the LOADED
// page client-side (so it never needs contact:search). Every value binds to a
// real ContactView field — nothing fabricated.
//
// Field mapping (mockup → real field):
//   relationship role ← relationship_role (closed vocab; categorical FUNCTION,
//                        never an ordinal/quality rating — R10)
//   communication     ← preference (contactable | limited | do_not_contact)
//   company           ← company_id (+ company_name enrichment)
//   hot               ← is_hot · former ← left_company · quiet ← last_activity_at
// The mockup's "primary contact" flag, per-contact "open reqs", and Department
// facet are NOT backend fields → omitted (never faked).

export const FULL_NAME = (c: ContactView): string =>
  `${c.first_name} ${c.last_name}`.trim();

// ── Relationship role (categorical function — NOT a quality rating) ──
export const ROLE_LABELS: Record<string, string> = {
  decision_maker: 'Decision maker',
  hiring_manager: 'Hiring manager',
  champion: 'Champion',
  influencer: 'Influencer',
  gatekeeper: 'Gatekeeper',
  billing_contact: 'Billing contact',
};
export const ROLE_ORDER: readonly string[] = [
  'decision_maker',
  'hiring_manager',
  'champion',
  'influencer',
  'gatekeeper',
  'billing_contact',
];
export type RoleTone = 'brand' | 'info' | 'ok' | 'neutral' | 'warn';
export const ROLE_TONES: Record<string, RoleTone> = {
  decision_maker: 'brand',
  hiring_manager: 'info',
  champion: 'ok',
  influencer: 'neutral',
  gatekeeper: 'warn',
  billing_contact: 'neutral',
};
export function roleLabel(role: string | null | undefined): string | null {
  if (role === null || role === undefined || role === '') return null;
  return ROLE_LABELS[role] ?? role;
}

// ── Communication preference ──
export const PREFERENCE_LABELS: Record<string, string> = {
  contactable: 'Contactable',
  limited: 'Limited',
  do_not_contact: 'Do not contact',
};
export const PREFERENCE_ORDER: readonly string[] = [
  'contactable',
  'limited',
  'do_not_contact',
];
export type PreferenceTone = 'ok' | 'warn' | 'danger';
export const PREFERENCE_TONES: Record<string, PreferenceTone> = {
  contactable: 'ok',
  limited: 'warn',
  do_not_contact: 'danger',
};
// null preference DISPLAYS as contactable (the amendment: null displays
// contactable but stores null — no fabricated grant).
export function preferenceLabel(p: string | null | undefined): string {
  if (p === null || p === undefined || p === '') return 'Contactable';
  return PREFERENCE_LABELS[p] ?? p;
}
export function preferenceTone(p: string | null | undefined): PreferenceTone {
  if (p === null || p === undefined || p === '') return 'ok';
  return PREFERENCE_TONES[p] ?? 'ok';
}
// The contactability gate — the preference MUST be honored by contact
// affordances, not merely displayed. do_not_contact blocks call/email/sequence.
export function isContactable(c: ContactView): boolean {
  return c.preference !== 'do_not_contact';
}

// ── Recency (cold-call + quiet) ──
export const QUIET_DAYS = 14;
export function daysSinceContact(
  c: ContactView,
  now: number = Date.now(),
): number | null {
  if (c.last_activity_at === null) return null;
  const then = new Date(c.last_activity_at).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now - then) / 86_400_000));
}
export function isQuiet(c: ContactView, now: number = Date.now()): boolean {
  const d = daysSinceContact(c, now);
  return d === null || d >= QUIET_DAYS;
}
export function lastContactLabel(
  c: ContactView,
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

// ── Scope (server-enforced owner predicate). Only owner is modelled, so
// My/All — the mockup's "Team" tab has no team-of-contacts signal → absent. ──
export type ScopeMode = 'mine' | 'all';

// ── Mode (Directory | Cold-call list). Cold-call is a REAL server filter+sort
// (contactable + has work phone, ordered by who you haven't spoken to longest)
// — the amendment added last_activity_at precisely so it need not be a seam. ──
export type ListMode = 'directory' | 'cold';

// ── Segments (one active at a time; 'all' = none). ──
// 'My contacts' is the scope TAB (top of the view), not a segment — so it is
// intentionally absent here to avoid a duplicate control/label.
export type SegmentKey = 'all' | 'decision' | 'champions' | 'quiet' | 'former';
export const SEGMENTS: readonly { key: SegmentKey; label: string }[] = [
  { key: 'all', label: 'All contacts' },
  { key: 'decision', label: 'Decision makers' },
  { key: 'champions', label: 'Champions' },
  { key: 'quiet', label: 'Going quiet 14d+' },
  { key: 'former', label: 'Former contacts' },
];

// ── Facets (left rail; AND across groups, OR within a group). ──
export type FacetFlag = 'hot' | 'quiet' | 'former';
export interface FacetState {
  readonly role: readonly string[]; // relationship_role values
  readonly preference: readonly string[];
  readonly company: readonly string[]; // company_id values
  readonly flags: readonly FacetFlag[];
}
export const EMPTY_FACETS: FacetState = {
  role: [],
  preference: [],
  company: [],
  flags: [],
};

// ── Server paged contract (hand-mirrored from libs/contact/src/lib/dto/
// contact-search.dto.ts; flat shapes — no drift spec, per the rule-of-three). ──
export interface ContactFacetBucket {
  readonly value: string;
  readonly count: number;
}
export interface ContactFacets {
  readonly relationship_role: readonly ContactFacetBucket[];
  readonly preference: readonly ContactFacetBucket[];
  readonly company: readonly ContactFacetBucket[]; // value = company_id
  readonly hot: number;
  readonly quiet: number;
  readonly former: number;
}
export interface ContactSearchPage {
  readonly items: readonly ContactView[];
  readonly next_cursor: string | null;
  readonly facets: ContactFacets;
  readonly total: number;
}

// Translate the workspace state into server query params. The TEXT box stays
// client-side (filters the loaded page; never sends ?q=, so the surface never
// needs contact:search).
export interface BuildQueryInput {
  readonly scope: ScopeMode;
  readonly segment: SegmentKey;
  readonly mode: ListMode;
  readonly facets: FacetState;
  readonly cursor?: string | null;
  readonly pageSize?: number;
}
export function buildContactQuery(i: BuildQueryInput): URLSearchParams {
  const p = new URLSearchParams();
  p.set('paged', 'true');
  // scope=mine → server owner predicate (the "My contacts" scope tab).
  if (i.scope === 'mine') p.set('scope', 'mine');

  // Cold-call mode = a distinct REAL server filter + sort.
  if (i.mode === 'cold') {
    p.set('cold_callable', 'true');
    p.set('sort', 'last_activity');
    p.set('dir', 'asc');
  }

  // relationship_role = facet selection ∪ the decision/champions segments.
  const role = new Set(i.facets.role);
  if (i.segment === 'decision') {
    role.add('decision_maker');
    role.add('champion');
  }
  if (i.segment === 'champions') role.add('champion');
  if (role.size > 0) p.set('relationship_role', [...role].join(','));

  if (i.facets.preference.length > 0)
    p.set('preference', i.facets.preference.join(','));
  if (i.facets.company.length > 0) p.set('company_id', i.facets.company.join(','));

  if (i.facets.flags.includes('hot')) p.set('is_hot', 'true');
  if (i.facets.flags.includes('quiet') || i.segment === 'quiet')
    p.set('quiet', 'true');
  if (i.facets.flags.includes('former') || i.segment === 'former')
    p.set('former', 'true');

  if (i.cursor != null && i.cursor !== '') p.set('cursor', i.cursor);
  if (i.pageSize !== undefined) p.set('page_size', String(i.pageSize));
  return p;
}

// The in-list text filter (client-side, over the loaded page) — name / title /
// email / company name.
export function matchesText(c: ContactView, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const hay = [
    FULL_NAME(c),
    c.title ?? '',
    c.email1 ?? '',
    c.company_name ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}

// Segment count badges, derived from the server facets (stable; base-where).
export function segmentCountFrom(
  facets: ContactFacets | null | undefined,
  total: number,
  key: SegmentKey,
): number | null {
  if (facets === null || facets === undefined) {
    return key === 'all' ? total : null;
  }
  const roleCount = (v: string): number =>
    facets.relationship_role.find((b) => b.value === v)?.count ?? 0;
  switch (key) {
    case 'all':
      return total;
    case 'decision':
      return roleCount('decision_maker') + roleCount('champion');
    case 'champions':
      return roleCount('champion');
    case 'quiet':
      return facets.quiet;
    case 'former':
      return facets.former;
  }
}

// Relationship briefing — FACTS-ONLY (Companies-briefing ruling). A
// deterministic restatement of REAL fields: role, company, last-contact
// recency, preference. NO evaluative/relationship-quality verdict, NO
// "AI-assisted" framing, NO suggested next move. Aramo Core supplies richer
// reasoning later (beneath the ReservedSeam).
export function contactBriefing(c: ContactView, now: number = Date.now()): string {
  const who = FULL_NAME(c);
  const role = roleLabel(c.relationship_role);
  const co = c.company_name ?? 'their company';
  const roleClause = role !== null ? ` · ${role}` : '';
  if (c.left_company) {
    return `${who}${roleClause} at ${co} — marked as a former contact.`;
  }
  const last = lastContactLabel(c, now);
  const pref =
    c.preference === 'do_not_contact'
      ? ' Marked do-not-contact.'
      : c.preference === 'limited'
        ? ' Prefers limited contact.'
        : '';
  return `${who}${roleClause} at ${co}. Last contact ${last}.${pref}`;
}
