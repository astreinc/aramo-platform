// Commercial Plans Amendment A1 §3 — the versioned Aramo Sign legal documents.
// The texts live in doc/legal/aramo-sign/*.md; this registry pins each version to
// the SHA-256 of its file (a spec fails if a text changes without a new version),
// so every acceptance record names the exact text that was accepted.
//
// A document becomes APPROVED only by a governed change to this registry after
// legal review and PO approval. While the Business documents are DRAFT:
//   - Business signup shows no terms checkbox and records no acceptance,
//   - checkout records no terms acceptance,
//   - a LIVE-mode checkout is refused (no live charging without approved terms).
//
// Aramo Sign Personal (Free) — the three Personal documents (Personal Terms, the
// Aramo Privacy Notice, the Aramo Acceptable Use Policy) are APPROVED at 1.0 (PO,
// 2026-10-21) and published on the Sign host at
// https://sign.aramo.ai/legal/<slug>/<version>; sign-web bundles the SAME files
// (a sign-web spec asserts the bundled bytes hash to the sha256 pinned here).

export type LegalDocumentKey =
  | 'sign.terms_of_service'
  | 'sign.privacy_policy'
  | 'sign.esign_consent_disclosure'
  | 'sign.retention_policy'
  | 'sign.personal_terms_of_service'
  | 'aramo.privacy_notice'
  | 'aramo.acceptable_use_policy';

export interface LegalDocumentVersion {
  key: LegalDocumentKey;
  version: string;
  status: 'DRAFT' | 'APPROVED';
  path: string;
  sha256: string;
  // Public URL of the published text (only for an APPROVED version).
  url: string | null;
  // Privacy Notice 1.1 Remediation Directive §3 / decision 6 (E-5) — the instant
  // this version takes effect: an ISO 8601 date-time WITH an explicit offset
  // (`Z` or `±hh:mm`; a bare date is refused as ambiguous). null = not scheduled
  // (every DRAFT; an APPROVED version that has no date yet). A value that does not
  // parse is treated as not scheduled (fail closed: never effective).
  effective_from: string | null;
}

export const LEGAL_DOCUMENTS: readonly LegalDocumentVersion[] = [
  {
    key: 'sign.terms_of_service',
    version: '0.1.1',
    status: 'DRAFT',
    path: 'doc/legal/aramo-sign/terms-of-service.md',
    sha256: '2c2ccb95a13137700c8f80935f001e3548060e04eb3750949eeb11352073688b',
    url: null,
    effective_from: null,
  },
  {
    key: 'sign.privacy_policy',
    version: '0.1.0',
    status: 'DRAFT',
    path: 'doc/legal/aramo-sign/privacy-policy.md',
    sha256: 'dde882abe64e0719ee6c60319c6c281707b2689a31f301f780ec211b4111f7a3',
    url: null,
    effective_from: null,
  },
  {
    key: 'sign.esign_consent_disclosure',
    version: '0.1.0',
    status: 'DRAFT',
    path: 'doc/legal/aramo-sign/esign-consent-disclosure.md',
    sha256: '36fe43c7be67a0ecc392577785a8f686c57b5f95a53195174323e3d237ce091b',
    url: null,
    effective_from: null,
  },
  {
    key: 'sign.retention_policy',
    version: '0.1.0',
    status: 'DRAFT',
    path: 'doc/legal/aramo-sign/retention-export-deletion-policy.md',
    sha256: '83248530dfba08dfdd19f5bddc4e9318833270f550d1b69ff8e0061a5d2f4a7b',
    url: null,
    effective_from: null,
  },
  // Aramo Sign Personal (Free) — APPROVED 1.0 (PO, 2026-10-21).
  {
    key: 'sign.personal_terms_of_service',
    version: '1.0',
    status: 'APPROVED',
    path: 'doc/legal/aramo-sign/personal-terms-of-service.md',
    sha256: 'b64ddd3ac08762e5d96eee8744f133cf9e9bf0ad799897a287779bb4c457d26e',
    url: 'https://sign.aramo.ai/legal/personal-terms/1.0',
    // The 1.0 texts took effect on PO approval/publication (2026-10-21); behaviour unchanged.
    effective_from: '2026-10-21T00:00:00Z',
  },
  {
    key: 'aramo.privacy_notice',
    version: '1.0',
    status: 'APPROVED',
    path: 'doc/legal/aramo/privacy-notice.md',
    sha256: '18fcc1aa386a06c0c9a15b8c60232aca6f0fbb1cdc100b288e524617f6e446b6',
    url: 'https://sign.aramo.ai/legal/privacy/1.0',
    // The 1.0 texts took effect on PO approval/publication (2026-10-21); behaviour unchanged.
    effective_from: '2026-10-21T00:00:00Z',
  },
  {
    key: 'aramo.acceptable_use_policy',
    version: '1.0',
    status: 'APPROVED',
    path: 'doc/legal/aramo/acceptable-use-policy.md',
    sha256: '2e64f8eece66c50b99954de8b4c885240bc4ca51fa0f6731a7d800b4706a476e',
    url: 'https://sign.aramo.ai/legal/acceptable-use/1.0',
    // The 1.0 texts took effect on PO approval/publication (2026-10-21); behaviour unchanged.
    effective_from: '2026-10-21T00:00:00Z',
  },
];

/** The documents a Personal account accepts (signup and in-app re-acceptance), in display order. */
export const PERSONAL_LEGAL_DOCUMENT_KEYS = ['sign.personal_terms_of_service', 'aramo.privacy_notice', 'aramo.acceptable_use_policy'] as const satisfies readonly LegalDocumentKey[];

/** Display titles (the documents' own headings). */
export const LEGAL_DOCUMENT_TITLES: Readonly<Record<LegalDocumentKey, string>> = {
  'sign.terms_of_service': 'Aramo Sign Terms of Service',
  'sign.privacy_policy': 'Aramo Sign Privacy Policy',
  'sign.esign_consent_disclosure': 'Electronic Signature Consent Disclosure',
  'sign.retention_policy': 'Aramo Sign Retention, Export and Deletion Policy',
  'sign.personal_terms_of_service': 'Aramo Sign Personal Terms of Service',
  'aramo.privacy_notice': 'Aramo Privacy Notice',
  'aramo.acceptable_use_policy': 'Aramo Acceptable Use Policy',
};

export const LEGAL_DOCUMENT_REGISTRY = 'LEGAL_DOCUMENT_REGISTRY';

// ── E-5: future-effective versions ──────────────────────────────────────────
//
// The latest registry entry is NOT automatically the version in force. A version
// is in exactly one of these states at an instant `now`:
//   draft                   status DRAFT (never offered, never served)
//   approved_not_effective  APPROVED but not scheduled for publication (no URL or
//                           no effective_from) — not served, not offered
//   upcoming                APPROVED, published (URL) and effective_from > now —
//                           served with an "Upcoming" banner, never offered for
//                           acceptance, never the current version
//   effective               the APPROVED published version with the latest
//                           effective_from <= now (ties: the later registry entry)
//   superseded              APPROVED, published, effective_from <= now but a later
//                           one is in force — retained for historical access
// Boundary: a version is effective AT its effective_from instant (inclusive).

export type LegalVersionState = 'draft' | 'approved_not_effective' | 'upcoming' | 'effective' | 'superseded';

export interface LegalVersionStatus {
  state: LegalVersionState;
  /** The parsed effective_from (null while not scheduled). */
  effective_from: Date | null;
  /** superseded only: when the version that replaced it took effect. */
  superseded_at: Date | null;
}

/** The time source for every "current version" decision (tests inject a fixed clock). */
export type LegalClock = () => Date;
export const LEGAL_CLOCK = Symbol('LEGAL_CLOCK');
export const systemLegalClock: LegalClock = () => new Date();

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** effective_from as epoch ms, or null when unset or not an unambiguous ISO date-time. */
export function legalEffectiveFrom(d: Pick<LegalDocumentVersion, 'effective_from'>): number | null {
  if (d.effective_from === null || !ISO_WITH_OFFSET.test(d.effective_from)) return null;
  const t = Date.parse(d.effective_from);
  return Number.isNaN(t) ? null : t;
}

/** APPROVED, with a public URL and a valid effective_from: servable at /legal/<slug>/<version>. */
function scheduled(d: LegalDocumentVersion): d is LegalDocumentVersion & { url: string } {
  return d.status === 'APPROVED' && d.url !== null && legalEffectiveFrom(d) !== null;
}

/** The versions of a key in force at some instant <= now, ordered by when they took effect (ties: registry order). */
function inForceOrder(key: LegalDocumentKey, registry: readonly LegalDocumentVersion[], now: Date): LegalDocumentVersion[] {
  return registry
    .map((d, i) => ({ d, i, t: legalEffectiveFrom(d) }))
    .filter((x) => x.d.key === key && scheduled(x.d) && x.t! <= now.getTime())
    .sort((a, b) => a.t! - b.t! || a.i - b.i)
    .map((x) => x.d);
}

/** The version of a document in effect at `now`, or null while none is. */
export function effectiveLegalDocument(key: LegalDocumentKey, registry: readonly LegalDocumentVersion[] = LEGAL_DOCUMENTS, now: Date = new Date()): LegalDocumentVersion | null {
  const order = inForceOrder(key, registry, now);
  return order.length === 0 ? null : order[order.length - 1]!;
}

/**
 * The version of a document that applies now (offered for acceptance, linked as
 * "current") — the EFFECTIVE version, never merely the latest approved entry. An
 * upcoming approved version is not returned until its effective_from.
 */
export function approvedLegalDocument(key: LegalDocumentKey, registry: readonly LegalDocumentVersion[] = LEGAL_DOCUMENTS, now: Date = new Date()): LegalDocumentVersion | null {
  return effectiveLegalDocument(key, registry, now);
}

/** The state of one registry version at `now` (see the table above). */
export function legalVersionStatus(d: LegalDocumentVersion, registry: readonly LegalDocumentVersion[] = LEGAL_DOCUMENTS, now: Date = new Date()): LegalVersionStatus {
  const t = legalEffectiveFrom(d);
  const at = t === null ? null : new Date(t);
  if (d.status === 'DRAFT') return { state: 'draft', effective_from: at, superseded_at: null };
  if (!scheduled(d)) return { state: 'approved_not_effective', effective_from: at, superseded_at: null };
  if (t! > now.getTime()) return { state: 'upcoming', effective_from: at, superseded_at: null };
  const order = inForceOrder(d.key, registry, now);
  const i = order.findIndex((x) => x.version === d.version);
  if (i === order.length - 1) return { state: 'effective', effective_from: at, superseded_at: null };
  return { state: 'superseded', effective_from: at, superseded_at: new Date(legalEffectiveFrom(order[i + 1]!)!) };
}

/** The reference stored with an acceptance: key@version#sha256. */
export function legalRef(d: LegalDocumentVersion): string {
  return `${d.key}@${d.version}#${d.sha256}`;
}
