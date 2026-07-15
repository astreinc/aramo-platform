// Subdomain-Identity Directive A — tenant subdomain-slug normalization + the
// DNS-safe-charset validation that the tenant-creation invariant consumes.
//
// PLACEMENT: a leaf util in libs/identity, mirroring email-domain.ts's
// deriveAllowedDomainOrThrow. The slug is the <slug> in <slug>.aramo.ai and the
// single source of truth for "is this a valid subdomain" (the public ask-
// endpoint looks a host up by it). The validation lives HERE so the service
// spine (TenantService.provisionTenant — where the invariant belongs so every
// creation path inherits it) and any future caller (Directive B self-service
// signup) share ONE implementation: the charset rule + error code can never
// drift between call sites.
//
// The slug is also a key, so normalization matters: DNS is case-insensitive and
// the column is UNIQUE, so 'Astre' and 'astre' MUST collide — we lowercase
// (+ trim) to a canonical form BEFORE validating, mirroring normalizeEmail.

import { AramoError } from '@aramo/common';

// A DNS label: lowercase alphanumerics + internal hyphens, no leading/trailing
// hyphen (RFC 1123). The subdomain charset; the same shape Caddy will see as the
// host label. Single-char labels (e.g. a one-letter tenant) are allowed.
const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// DNS label length ceiling (RFC 1035). A subdomain label cannot exceed 63 chars;
// enforce it so a slug can never produce an invalid hostname.
const SLUG_MAX_LENGTH = 63;

// Platform-Console Increment-2 PR-1 (workstream F) — reserved subdomain labels
// (doc Part III host architecture). These are platform/system hosts that a
// tenant must never claim (admin.aramo.ai is the platform console; www/api/auth/
// app/support/status/mail/docs/assets are platform-owned front doors). Enforced
// HERE at the single-source slug gate, so the public cert-eligibility ask-
// endpoint inherits it transitively — a reserved slug never enters Tenant.slug,
// so findActiveBySlug returns null and the ask 404s it. No second list needed.
//
// Portal P1 PR-3 (§PR-3.3, Portal DDR reserved-slug rider) — 'candidate' (the
// portal host candidate.aramo.ai) and 'portal' join the canonical set. This IS
// the canonical list from this merge; the platform-console integration branch
// carries its own reserved-slug guard and reconciles forward on its next R-SYNC
// (no divergent duplicate). The directive's minimum tuple {candidate, admin,
// www, api, auth, portal, platform} is a subset of this set (the extra
// platform-owned front doors are retained — the DDR list is "at minimum").
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'candidate',
  'admin',
  'www',
  'api',
  'auth',
  'app',
  'portal',
  'platform',
  'support',
  'status',
  'mail',
  'docs',
  'assets',
]);

// Canonical form: trim surrounding whitespace + lowercase. The single source of
// the normalization rule — applied before validation AND before persistence so
// the stored slug is exactly what an inbound host label (also lowercased by DNS)
// will match against.
export function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

// Subdomain-Identity Directive A — the SINGLE-SOURCE slug gate at tenant
// creation. Given a raw slug, returns the normalized (trim+lowercase) DNS-safe
// label, or throws a 4xx VALIDATION_ERROR:
//   - empty after normalization                 → reason 'invalid_slug'
//   - longer than 63 chars (DNS label ceiling)  → reason 'invalid_slug'
//   - not [a-z0-9] with internal hyphens only    → reason 'invalid_slug'
//
// Mirrors deriveAllowedDomainOrThrow: the invariant lives where the tenant is
// born, so every creation path inherits DNS-safe-slug enforcement with zero new
// validation logic. The normalized return is what gets persisted to Tenant.slug
// (UNIQUE), so 'Astre' and 'astre' canonicalize to the same key.
export function deriveSlugOrThrow(rawSlug: string, requestId: string): string {
  const slug = normalizeSlug(rawSlug);
  if (
    slug.length === 0 ||
    slug.length > SLUG_MAX_LENGTH ||
    !SLUG_PATTERN.test(slug)
  ) {
    throw new AramoError(
      'VALIDATION_ERROR',
      'Tenant slug must be a DNS-safe label (lowercase letters, digits, and internal hyphens)',
      400,
      { requestId, details: { reason: 'invalid_slug' } },
    );
  }
  // Platform-Console Increment-2 PR-1 (workstream F) — refuse reserved/platform
  // subdomains (checked AFTER charset so the error is specific).
  if (RESERVED_SLUGS.has(slug)) {
    throw new AramoError(
      'VALIDATION_ERROR',
      `Tenant slug "${slug}" is reserved`,
      400,
      { requestId, details: { reason: 'reserved_slug' } },
    );
  }
  return slug;
}

// Subdomain-Identity Directive A — extract the single tenant slug label from a
// host, anchored to the platform root domain. Returns the normalized label for a
// host shaped EXACTLY `<slug>.<rootDomain>` (one label under the apex), or null
// for anything else.
//
// Anchoring to rootDomain is the security boundary for the cert-eligibility
// ask-endpoint: WITHOUT it, `astre.attacker.com` would yield slug 'astre' and
// (if Astre exists) greenlight a cert for an attacker-controlled host. Requiring
// the host to end in `.aramo.ai` AND carry exactly one label before it means the
// endpoint can only ever vouch for true `<slug>.aramo.ai` subdomains. A multi-
// label host (`a.b.aramo.ai`), the bare apex (`aramo.ai`), a port-only/empty
// host, or a different domain all return null → the caller treats it as
// not-eligible (404), never an error.
//
// This is a pure parse (no charset throw): an inbound label that isn't DNS-safe
// simply won't match any stored slug, so the lookup returns not-eligible. Reused
// by Directive B's host→tenant routing on the same column.
export function extractTenantSlugFromHost(
  host: string,
  rootDomain: string,
): string | null {
  // DNS is case-insensitive and Caddy may include the listening port — strip it.
  // split() always yields ≥1 element; the ?? '' satisfies noUncheckedIndexedAccess.
  const hostname = host.trim().toLowerCase().split(':')[0] ?? '';
  const suffix = `.${rootDomain.trim().toLowerCase()}`;
  if (hostname.length === 0 || !hostname.endsWith(suffix)) {
    return null;
  }
  const label = hostname.slice(0, -suffix.length);
  // Exactly ONE label under the apex: no dots (rejects a.b.aramo.ai), non-empty.
  if (label.length === 0 || label.includes('.')) {
    return null;
  }
  return label;
}
