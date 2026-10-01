import { createHash } from 'node:crypto';

// Enterprise Search GS-2B P7 — the deterministic Requisition SEMANTIC-SOURCE projection with a
// COMMERCIAL-EXCLUSION guard. A compact recruiting-facts document (NOT a commercial/rate sheet):
// the same Requisition state always produces the same document + source_hash, so the version-aware
// embedding pipeline regenerates only on a real change. Pure function — the caller feeds the facts;
// nothing here reads a repo or persists.
//
// Structural exclusion (P7): the input type carries NO commercial field — pay/bill rate, salary,
// placement fee, margin/markup targets, rate card, advertised pay, compensation model, rate type are
// all absent by construction, so no commercial VALUE can ever reach the embedding. The residual risk
// is a commercial FIGURE embedded in the free-text `description`; sanitizeCommercialText strips those
// (currency amounts, per-period rate expressions, and comp-context numbers) before the doc is built.
// Recruiter free-text `notes` is excluded entirely (like Talent notes). Null/blank values vanish —
// never a placeholder.

export interface RequisitionSemanticFacts {
  readonly title: string | null;
  readonly description: string | null;
  readonly type: string | null; // engagement type (e.g. contract / permanent)
  readonly job_type: string | null; // contract | contract_to_hire | direct_perm | …
  readonly role_family: string | null;
  readonly labor_category: string | null;
  readonly seniority_level: string | null;
  readonly work_arrangement: string | null; // onsite | hybrid | remote
  readonly work_authorization: string | null; // constraint (us_citizen | gc | h1b_ok | any)
  readonly city: string | null;
  readonly state: string | null;
}

export interface RequisitionSemanticDocument {
  readonly document: string;
  readonly source_hash: string;
}

// ── deterministic commercial-figure sanitizer ────────────────────────────────
// Strips commercial numbers that may appear inside the free-text description. Applied ONLY to the
// derived embedding projection (never to the source column). Proven by a hostile fixture, not just
// by the absence of commercial COLUMNS.
const CURRENCY_RE = /[$€£]\s?\d[\d,]*(?:\.\d{1,2})?\s?(?:[kKmM]\b)?/g;
// A number attached to a pay period (per hour / /hr / annually / a year …).
const RATE_PERIOD_RE =
  /\b\d[\d,]*(?:\.\d+)?\s*(?:\/|per\s+)\s*(?:hr|hour|hrs|hours|yr|year|annum|day|wk|week|mo|month)\b/gi;
// A comp-context keyword followed (within a short window) by a number/percent — e.g. "margin 25%",
// "salary of 180000", "bill rate 150", "markup 1.6". Bare percentages elsewhere (e.g. "20% travel")
// are NOT commercial context and survive.
const COMP_CONTEXT_RE =
  /\b(?:salary|pay|bill|rate|margin|markup|fee|comp(?:ensation)?|budget|wage|stipend)\b[^.\n]{0,24}?\d[\d,]*(?:\.\d+)?\s?%?/gi;

// Orphan "/hr" / "per year" left after a preceding number was stripped, and a lone currency symbol.
const ORPHAN_PERIOD_RE =
  /(?:\/|per\s+)\s*(?:hr|hour|hrs|hours|yr|year|annum|day|wk|week|mo|month)\b/gi;
const LONE_CURRENCY_RE = /[$€£]/g;

export function sanitizeCommercialText(input: string): string {
  return input
    // Rate-period BEFORE currency so "$150/hr" is consumed as a whole rate, not split into "$150"+"/hr".
    .replace(RATE_PERIOD_RE, ' ')
    .replace(CURRENCY_RE, ' ')
    .replace(COMP_CONTEXT_RE, ' ')
    .replace(ORPHAN_PERIOD_RE, ' ')
    .replace(LONE_CURRENCY_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nonBlank(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const t = value.replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
}

function locality(city: string | null, state: string | null): string | null {
  const c = nonBlank(city);
  const s = nonBlank(state);
  if (c !== null && s !== null) return `${c}, ${s}`;
  return c ?? s ?? null;
}

export function buildRequisitionSemanticDocument(
  facts: RequisitionSemanticFacts,
): RequisitionSemanticDocument {
  const lines: string[] = [];

  const title = nonBlank(facts.title);
  if (title !== null) lines.push(`Title: ${title}`);

  // Compact role classifiers on one line (deterministic order; blanks dropped).
  const classifiers = [
    nonBlank(facts.type),
    nonBlank(facts.job_type),
    nonBlank(facts.seniority_level),
    nonBlank(facts.role_family),
    nonBlank(facts.labor_category),
    nonBlank(facts.work_arrangement),
  ].filter((v): v is string => v !== null);
  if (classifiers.length > 0) lines.push(`Role: ${classifiers.join(' · ')}`);

  const loc = locality(facts.city, facts.state);
  if (loc !== null) lines.push(`Location: ${loc}`);

  const auth = nonBlank(facts.work_authorization);
  if (auth !== null) lines.push(`Work authorization: ${auth}`);

  const descRaw = nonBlank(facts.description);
  if (descRaw !== null) {
    const desc = sanitizeCommercialText(descRaw);
    if (desc !== '') lines.push(`Description: ${desc}`);
  }

  const document = lines.join('\n');
  const source_hash = createHash('sha256').update(document).digest('hex');
  return { document, source_hash };
}
