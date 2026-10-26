// Aramo Sign Personal (Free) — the published legal documents on the Sign host:
//   /legal/<slug>/<version>   one exact version (stable URL; the registry's `url`)
//   /legal/<slug>             the version IN EFFECT now (never merely the last entry)
//   /legal/third-party-notices  attributions (not a registry document)
//   /legal/subprocessors        the Aramo Sign subprocessor list (not a registry document)
// Metadata only (no texts): pages that LINK to a document import this module; the
// texts load only with the legal page (./texts.ts, a separate chunk). Each entry
// mirrors an APPROVED, scheduled entry of the legal registry in @aramo/subscription
// — a build-time spec (legal.spec.tsx) asserts the bundled text's SHA-256, key,
// version, URL and effective_from equal the registry's, so the served text never
// drifts from the text people accepted.
//
// Privacy Notice 1.1 Remediation Directive §3 / decision 6 (E-5) — a published
// version is, at an instant `now`:
//   upcoming    effective_from > now   (served with an "Upcoming" banner)
//   effective   the latest effective_from <= now (ties: the later catalog entry)
//   superseded  an earlier one, retained for historical access
// An approved but unscheduled version is not in this catalog at all (not served).
// The same rule as effectiveLegalDocument() in the registry.

export type LegalSlug = 'personal-terms' | 'privacy' | 'acceptable-use';

export interface LegalCatalogEntry {
  slug: LegalSlug;
  key: string;
  version: string;
  title: string;
  // Who it binds: `personal` = Personal accounts only; `all` = every Aramo Sign account.
  audience: 'personal' | 'all';
  // When this version takes effect: ISO 8601 date-time with an explicit offset.
  effective_from: string;
}

export const LEGAL_CATALOG: readonly LegalCatalogEntry[] = [
  { slug: 'personal-terms', key: 'sign.personal_terms_of_service', version: '1.0', title: 'Aramo Sign Personal Terms of Service', audience: 'personal', effective_from: '2026-10-21T00:00:00Z' },
  { slug: 'privacy', key: 'aramo.privacy_notice', version: '1.0', title: 'Aramo Privacy Notice', audience: 'all', effective_from: '2026-10-21T00:00:00Z' },
  { slug: 'acceptable-use', key: 'aramo.acceptable_use_policy', version: '1.0', title: 'Aramo Acceptable Use Policy', audience: 'all', effective_from: '2026-10-21T00:00:00Z' },
];

export const PUBLIC_SIGN_ORIGIN = 'https://sign.aramo.ai';
export const THIRD_PARTY_NOTICES_PATH = '/legal/third-party-notices';
export const SUBPROCESSORS_SLUG = 'subprocessors';
export const SUBPROCESSORS_PATH = `/legal/${SUBPROCESSORS_SLUG}`;

// ── effective-date resolution ────────────────────────────────────────────────

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** An effective_from as epoch ms; null when unset or not an unambiguous ISO date-time (never in effect). */
export function effectiveTime(effective_from: string | null): number | null {
  if (effective_from === null || !ISO_WITH_OFFSET.test(effective_from)) return null;
  const t = Date.parse(effective_from);
  return Number.isNaN(t) ? null : t;
}

/** "2026-11-25 00:00 UTC" / "2026-11-25 00:00 UTC-05:00" — the instant as it was authored. */
export function formatEffective(effective_from: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})[^Z+-]*(Z|[+-]\d{2}:\d{2})$/.exec(effective_from);
  if (m === null) return effective_from;
  return `${m[1]} ${m[2]} UTC${m[3] === 'Z' ? '' : m[3]}`;
}

export type LegalEntryState = 'upcoming' | 'effective' | 'superseded';

export interface LegalEntryStatus {
  state: LegalEntryState;
  /** superseded only: the entry that replaced it (its effective_from is when this one stopped applying). */
  superseded_by: LegalCatalogEntry | null;
}

/** The entries of a slug that have taken effect at `now`, in the order they took effect. */
function inForce(slug: string, catalog: readonly LegalCatalogEntry[], now: Date): LegalCatalogEntry[] {
  return catalog
    .map((d, i) => ({ d, i, t: effectiveTime(d.effective_from) }))
    .filter((x) => x.d.slug === slug && x.t !== null && x.t <= now.getTime())
    .sort((a, b) => a.t! - b.t! || a.i - b.i)
    .map((x) => x.d);
}

/** The version of a document in effect at `now` (null while none is). */
export function currentLegal(slug: string, catalog: readonly LegalCatalogEntry[] = LEGAL_CATALOG, now: Date = new Date()): LegalCatalogEntry | null {
  const order = inForce(slug, catalog, now);
  return order.length === 0 ? null : order[order.length - 1]!;
}

export function legalEntryStatus(d: LegalCatalogEntry, catalog: readonly LegalCatalogEntry[] = LEGAL_CATALOG, now: Date = new Date()): LegalEntryStatus {
  const t = effectiveTime(d.effective_from);
  if (t === null || t > now.getTime()) return { state: 'upcoming', superseded_by: null };
  const order = inForce(d.slug, catalog, now);
  const i = order.findIndex((x) => x.version === d.version);
  if (i === order.length - 1) return { state: 'effective', superseded_by: null };
  return { state: 'superseded', superseded_by: order[i + 1]! };
}

/** One exact version, or — with no version — the version in effect at `now`. */
export function findLegal(slug: string, version?: string, catalog: readonly LegalCatalogEntry[] = LEGAL_CATALOG, now: Date = new Date()): LegalCatalogEntry | null {
  if (version === undefined) return currentLegal(slug, catalog, now);
  return catalog.find((d) => d.slug === slug && d.version === version) ?? null;
}

/** The stable path of a version (the version in effect when no version is given). */
export function legalPath(slug: LegalSlug, version?: string, catalog: readonly LegalCatalogEntry[] = LEGAL_CATALOG, now: Date = new Date()): string {
  const d = findLegal(slug, version, catalog, now);
  return d === null ? `/legal/${slug}` : `/legal/${d.slug}/${d.version}`;
}

/** The version in effect of every document, optionally limited to those binding Business accounts too. */
export function footerLegalLinks(personal: boolean, catalog: readonly LegalCatalogEntry[] = LEGAL_CATALOG, now: Date = new Date()): { label: string; href: string }[] {
  const label: Record<LegalSlug, string> = { 'personal-terms': 'Terms', privacy: 'Privacy', 'acceptable-use': 'Acceptable Use' };
  const slugs = [...new Set(catalog.map((d) => d.slug))];
  return slugs
    .map((s) => currentLegal(s, catalog, now))
    .filter((d): d is LegalCatalogEntry => d !== null)
    .filter((d) => personal || d.audience === 'all')
    .map((d) => ({ label: label[d.slug], href: legalPath(d.slug, d.version, catalog, now) }));
}

// ── subprocessors (E-7) ──────────────────────────────────────────────────────
//
// Privacy Notice 1.1 Remediation Directive decision 8 (E-7). The list is versioned
// with the same effective-date rule as the documents: the CURRENT list is the
// scheduled list with the latest effective_from <= now; the page also shows the
// next scheduled list as "Upcoming changes, effective {date}". A list whose
// effective_from is null is UNSCHEDULED: it is never shown. A list may be
// scheduled only once its counsel items are resolved (`pending_review` empty) and
// its publication date is set (`updated`) — a spec enforces both.

export interface Subprocessor {
  name: string;
  purpose: string;
  location: string;
  /** A per-row qualification shown under the purpose. */
  note?: string;
}

export interface SubprocessorList {
  id: string;
  /** null = unscheduled (not shown); else ISO 8601 date-time with an explicit offset. */
  effective_from: string | null;
  /** The "Last updated" date shown while this list is current (the publication date). */
  updated: string | null;
  /** Whose personal information it covers: "…for {scope}, on our instructions." */
  scope: string;
  rows: readonly Subprocessor[];
  /** Open counsel items; must be empty before effective_from is set. */
  pending_review: readonly string[];
}

const PUSH_NOTE = 'Used only when notifications are switched on.';

export const SUBPROCESSOR_LISTS: readonly SubprocessorList[] = [
  // The list in force since 2026-10-22 (Privacy Notice 1.0 §7) — unchanged.
  {
    id: '2026-10-22',
    effective_from: '2026-10-22T00:00:00Z',
    updated: '2026-10-22',
    scope: 'Aramo Sign Personal accounts',
    rows: [
      { name: 'Amazon Web Services', purpose: 'Hosting, storage and email delivery', location: 'United States' },
      { name: 'Cloudflare', purpose: 'Robot check on the signup page', location: 'Global' },
      { name: 'Google', purpose: 'Sign-in with Google', location: "The person's own Google account" },
      { name: 'Text-message (SMS) provider', purpose: 'Not yet selected; no phone numbers are shared until one is', location: '—' },
    ],
    pending_review: [],
  },
  // E-7 — the list proposed with Privacy Notice 1.1 (validation report §6.1). NOT
  // scheduled: it is published together with 1.1 once counsel and the PO approve
  // (the registry-flip PR sets effective_from and updated, and clears pending_review).
  {
    id: 'privacy-1.1',
    effective_from: null,
    updated: null,
    scope: 'Aramo Sign (personal and business accounts, signers and the Aramo Sign mobile app)',
    rows: [
      { name: 'Amazon Web Services', purpose: 'Hosting, storage and email delivery', location: 'United States' },
      { name: 'Cloudflare', purpose: 'Robot check on the signup page', location: 'Global' },
      { name: 'Google', purpose: 'Sign-in with Google (web and mobile app)', location: "The person's own Google account" },
      { name: 'Microsoft', purpose: 'Sign-in with Microsoft for organizations (web and mobile app)', location: "The organization's own Microsoft account" },
      {
        name: 'Apple',
        purpose: 'Apple Push Notification service: delivers notifications to iPhones running the Aramo Sign app, when the user allows notifications',
        location: 'United States',
        note: PUSH_NOTE,
      },
      {
        name: 'Google',
        purpose: 'Firebase Cloud Messaging: delivers notifications to Android phones running the Aramo Sign app, when the user allows notifications',
        location: 'To be confirmed',
        note: PUSH_NOTE,
      },
      { name: 'Text-message (SMS) provider', purpose: 'Not yet selected; no phone numbers are shared until one is', location: '—' },
    ],
    pending_review: [
      'Apple: exact legal entity and region (CD-08)',
      'Google Firebase Cloud Messaging: region',
      "Microsoft: confirm the row (1.0 §7 names Microsoft; the 2026-10-22 page does not) and its location wording",
    ],
  },
];

function scheduledLists(lists: readonly SubprocessorList[]) {
  return lists
    .map((l, i) => ({ l, i, t: effectiveTime(l.effective_from) }))
    .filter((x): x is { l: SubprocessorList; i: number; t: number } => x.t !== null)
    .sort((a, b) => a.t - b.t || a.i - b.i);
}

/** The subprocessor list in force at `now` (null while none is). */
export function currentSubprocessors(lists: readonly SubprocessorList[] = SUBPROCESSOR_LISTS, now: Date = new Date()): SubprocessorList | null {
  const inForceLists = scheduledLists(lists).filter((x) => x.t <= now.getTime());
  return inForceLists.length === 0 ? null : inForceLists[inForceLists.length - 1]!.l;
}

/** The next scheduled list after `now` (an unscheduled list is never returned). */
export function upcomingSubprocessors(lists: readonly SubprocessorList[] = SUBPROCESSOR_LISTS, now: Date = new Date()): SubprocessorList | null {
  return scheduledLists(lists).find((x) => x.t > now.getTime())?.l ?? null;
}

/** GeoLite2 licence attribution (required wherever the data is used). */
export const MAXMIND_ATTRIBUTION = 'This product includes GeoLite2 data created by MaxMind, available from https://www.maxmind.com.';
export const MAXMIND_URL = 'https://www.maxmind.com';
