// Aramo Sign Personal (Free) — the published legal documents on the Sign host:
//   /legal/<slug>/<version>   one exact version (stable URL; the registry's `url`)
//   /legal/<slug>             the latest published version
//   /legal/third-party-notices  attributions (not a registry document)
//   /legal/subprocessors        the Aramo Sign Personal subprocessor list (not a registry document)
// Metadata only (no texts): pages that LINK to a document import this module; the
// texts load only with the legal page (./texts.ts, a separate chunk). Each entry
// mirrors an APPROVED entry of the legal registry in @aramo/subscription — a
// build-time spec (legal.spec.tsx) asserts the bundled text's SHA-256, key,
// version and URL equal the registry's, so the served text never drifts from the
// text people accepted.

export type LegalSlug = 'personal-terms' | 'privacy' | 'acceptable-use';

export interface LegalCatalogEntry {
  slug: LegalSlug;
  key: string;
  version: string;
  title: string;
  // Who it binds: `personal` = Personal accounts only; `all` = every Aramo Sign account.
  audience: 'personal' | 'all';
}

/** Oldest first per slug; the last entry of a slug is its latest version. */
export const LEGAL_CATALOG: readonly LegalCatalogEntry[] = [
  { slug: 'personal-terms', key: 'sign.personal_terms_of_service', version: '1.0', title: 'Aramo Sign Personal Terms of Service', audience: 'personal' },
  { slug: 'privacy', key: 'aramo.privacy_notice', version: '1.0', title: 'Aramo Privacy Notice', audience: 'all' },
  { slug: 'acceptable-use', key: 'aramo.acceptable_use_policy', version: '1.0', title: 'Aramo Acceptable Use Policy', audience: 'all' },
];

export const PUBLIC_SIGN_ORIGIN = 'https://sign.aramo.ai';
export const THIRD_PARTY_NOTICES_PATH = '/legal/third-party-notices';
export const SUBPROCESSORS_SLUG = 'subprocessors';
export const SUBPROCESSORS_PATH = `/legal/${SUBPROCESSORS_SLUG}`;

export interface Subprocessor {
  name: string;
  purpose: string;
  location: string;
}

/** The service providers that process personal information for Aramo Sign Personal accounts (Privacy Notice §7). */
export const SUBPROCESSORS: readonly Subprocessor[] = [
  { name: 'Amazon Web Services', purpose: 'Hosting, storage and email delivery', location: 'United States' },
  { name: 'Cloudflare', purpose: 'Robot check on the signup page', location: 'Global' },
  { name: 'Google', purpose: 'Sign-in with Google', location: "The person's own Google account" },
  { name: 'Text-message (SMS) provider', purpose: 'Not yet selected; no phone numbers are shared until one is', location: '—' },
];
export const SUBPROCESSORS_UPDATED = '2026-10-22';

/** GeoLite2 licence attribution (required wherever the data is used). */
export const MAXMIND_ATTRIBUTION = 'This product includes GeoLite2 data created by MaxMind, available from https://www.maxmind.com.';
export const MAXMIND_URL = 'https://www.maxmind.com';

export function latestLegal(slug: string): LegalCatalogEntry | null {
  const all = LEGAL_CATALOG.filter((d) => d.slug === slug);
  return all.length === 0 ? null : all[all.length - 1]!;
}

export function findLegal(slug: string, version?: string): LegalCatalogEntry | null {
  if (version === undefined) return latestLegal(slug);
  return LEGAL_CATALOG.find((d) => d.slug === slug && d.version === version) ?? null;
}

/** The stable path of a version (the latest when no version is given). */
export function legalPath(slug: LegalSlug, version?: string): string {
  const d = findLegal(slug, version);
  return d === null ? `/legal/${slug}` : `/legal/${d.slug}/${d.version}`;
}

/** The latest version of every document, optionally limited to those binding Business accounts too. */
export function footerLegalLinks(personal: boolean): { label: string; href: string }[] {
  const label: Record<LegalSlug, string> = { 'personal-terms': 'Terms', privacy: 'Privacy', 'acceptable-use': 'Acceptable Use' };
  const slugs = [...new Set(LEGAL_CATALOG.map((d) => d.slug))];
  return slugs
    .map((s) => latestLegal(s)!)
    .filter((d) => personal || d.audience === 'all')
    .map((d) => ({ label: label[d.slug], href: legalPath(d.slug, d.version) }));
}
