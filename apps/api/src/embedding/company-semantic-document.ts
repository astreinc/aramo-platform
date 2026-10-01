import { createHash } from 'node:crypto';

// Enterprise Search GS-2C — the deterministic Company SEMANTIC-SOURCE projection. A compact
// org-facts document (what the company IS, for matching): the same Company state always produces the
// same document + source_hash. Pure function. Commercial/relationship columns (client_tier,
// supplier_status, fee_model, markup, revenue band, exclusivity, off_limits), contact channels
// (address/phone/email/url/zip), policy flags, and recruiter notes are excluded STRUCTURALLY — the
// input type carries none of them. The residual risk is contact material inside the free-text
// description; sanitizeOrgText strips it (email/phone/url) before the doc is built. Null/blank vanish.

export interface CompanySemanticFacts {
  readonly name: string | null;
  readonly industry: string | null;
  readonly description: string | null;
  readonly key_technologies: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly country: string | null;
  readonly ownership_type: string | null;
  readonly employee_count_band: string | null;
}

export interface CompanySemanticDocument {
  readonly document: string;
  readonly source_hash: string;
}

// Light contact-material strip for the free-text description (defense; companies are not PII subjects
// but a description may carry an email/phone/URL). Applied only to the derived projection.
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const PHONE_RE = /(?:\+?\d[\d().\-\s]{8,}\d)/g;

export function sanitizeOrgText(input: string): string {
  return input
    .replace(EMAIL_RE, ' ')
    .replace(URL_RE, ' ')
    .replace(PHONE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nonBlank(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const t = value.replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
}

function locality(city: string | null, state: string | null, country: string | null): string | null {
  const parts = [nonBlank(city), nonBlank(state), nonBlank(country)].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(', ') : null;
}

export function buildCompanySemanticDocument(facts: CompanySemanticFacts): CompanySemanticDocument {
  const lines: string[] = [];

  const name = nonBlank(facts.name);
  if (name !== null) lines.push(`Name: ${name}`);

  const industry = nonBlank(facts.industry);
  if (industry !== null) lines.push(`Industry: ${industry}`);

  const profile = [nonBlank(facts.ownership_type), nonBlank(facts.employee_count_band)].filter(
    (v): v is string => v !== null,
  );
  if (profile.length > 0) lines.push(`Profile: ${profile.join(' · ')}`);

  const tech = nonBlank(facts.key_technologies);
  if (tech !== null) lines.push(`Technologies: ${tech}`);

  const loc = locality(facts.city, facts.state, facts.country);
  if (loc !== null) lines.push(`Location: ${loc}`);

  const descRaw = nonBlank(facts.description);
  if (descRaw !== null) {
    const desc = sanitizeOrgText(descRaw);
    if (desc !== '') lines.push(`Description: ${desc}`);
  }

  const document = lines.join('\n');
  const source_hash = createHash('sha256').update(document).digest('hex');
  return { document, source_hash };
}
