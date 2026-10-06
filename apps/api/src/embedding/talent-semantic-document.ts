import { createHash } from 'node:crypto';

// Enterprise Search GS-2 P3 — the deterministic, PII-minimized Talent SEMANTIC-SOURCE projection.
// It is a compact recruiting-facts document (NOT a persisted resume representation): the same
// authoritative Talent state always produces the same document + source_hash, so the version-aware
// embedding pipeline regenerates only on a real change. This is a PURE function — the caller
// (the P5 worker) fetches the authoritative facts and feeds them in; nothing here reads a repo,
// mutates a source field, or persists anything.
//
// Frozen v1 field set (directive P3 rulings): TalentRecord.{title, key_skills, current_employer,
// city, state} + authoritative TalentWorkHistoryEntry.{role_title, employer_name} +
// SANITIZED experience_summary (only if safe/non-empty) + COARSE-NORMALIZED work-history location
// (only if it normalizes; else omit). description_text is EXCLUDED with NO fallback. Canonical
// skills are deferred (key_skills is the v1 skill source). Null/blank values simply disappear —
// never a placeholder such as "unknown".

export interface TalentWorkHistoryFact {
  readonly role_title: string;
  readonly employer_name: string;
  readonly experience_summary: string | null;
  readonly location: string | null;
  // For deterministic ordering only — never embedded. ISO date string or null.
  readonly start_date: string | null;
  readonly id: string;
}

export interface TalentSemanticFacts {
  readonly title: string | null;
  readonly key_skills: string | null;
  readonly current_employer: string | null;
  readonly city: string | null;
  readonly state: string | null;
  // Caller MUST pass only authoritative (is_authoritative = true), live-Talent entries.
  readonly work_history: readonly TalentWorkHistoryFact[];
}

export interface TalentSemanticDocument {
  readonly document: string;
  readonly source_hash: string;
}

// ── deterministic free-text sanitizer ────────────────────────────────────────
// Applied ONLY to the derived embedding projection (never to the authoritative source field),
// and ONLY to the free-text values the P3 ruling admits with sanitization (experience_summary).
// Removes obvious contact/identity-style material before it can enter the semantic document. The
// principal residual PII risk is contact data embedded INSIDE an allowed text value, so this is
// the load-bearing guard (proved by a hostile fixture, not just by excluded column names).
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
// US-style + generic long digit runs (phones, SSNs, zip+4, account-like numbers).
const PHONE_RE = /(?:\+?\d[\d().\-\s]{8,}\d)/g;
const SSN_RE = /\b\d{3}[-. ]\d{2}[-. ]\d{4}\b/g;
const LONG_DIGITS_RE = /\b\d{9,}\b/g;
const STREET_RE =
  /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){0,4}(?:st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|way|ct|court|pl|place|ter|terrace|cir|circle|hwy|highway|pkwy|parkway)\b\.?/gi;

export function sanitizeSemanticText(input: string): string {
  return input
    .replace(EMAIL_RE, ' ')
    .replace(URL_RE, ' ')
    .replace(SSN_RE, ' ')
    .replace(STREET_RE, ' ')
    .replace(PHONE_RE, ' ')
    .replace(LONG_DIGITS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function nonBlank(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const t = normalizeWhitespace(value);
  return t === '' ? null : t;
}

// TalentRecord city/state are separate structured columns → "City, State" directly (either alone
// if the other is blank; null if both blank).
function talentLocality(city: string | null, state: string | null): string | null {
  const c = nonBlank(city);
  const s = nonBlank(state);
  if (c !== null && s !== null) return `${c}, ${s}`;
  return c ?? s ?? null;
}

// Work-history location is FREE TEXT → included only if it deterministically normalizes to a
// coarse "City, State" locality; otherwise omitted (never embed an arbitrary raw value).
export function coarseLocality(raw: string | null): string | null {
  const t = nonBlank(raw);
  if (t === null) return null;
  const m = t.match(/^([A-Za-z][A-Za-z .'-]*),\s*([A-Za-z]{2}|[A-Za-z][A-Za-z .]+)$/);
  if (m === null) return null;
  // Both capture groups are guaranteed present when the anchored pattern matches.
  const city = normalizeWhitespace(m[1] ?? '');
  const region = normalizeWhitespace(m[2] ?? '');
  return `${city}, ${region}`;
}

// Deterministic ordering: start_date DESC (nulls last), id ASC as the stable tie-break.
function orderWorkHistory(entries: readonly TalentWorkHistoryFact[]): TalentWorkHistoryFact[] {
  return [...entries].sort((a, b) => {
    if (a.start_date !== b.start_date) {
      if (a.start_date === null) return 1;
      if (b.start_date === null) return -1;
      return a.start_date < b.start_date ? 1 : -1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function buildTalentSemanticDocument(facts: TalentSemanticFacts): TalentSemanticDocument {
  const lines: string[] = [];

  const title = nonBlank(facts.title);
  if (title !== null) lines.push(`Title: ${title}`);

  const skills = nonBlank(facts.key_skills);
  if (skills !== null) lines.push(`Skills: ${skills}`);

  const employer = nonBlank(facts.current_employer);
  if (employer !== null) lines.push(`Current employer: ${employer}`);

  const locality = talentLocality(facts.city, facts.state);
  if (locality !== null) lines.push(`Location: ${locality}`);

  const experienceLines: string[] = [];
  for (const entry of orderWorkHistory(facts.work_history)) {
    const role = nonBlank(entry.role_title);
    const emp = nonBlank(entry.employer_name);
    // role_title + employer_name are the required structured anchor; skip a malformed entry.
    if (role === null || emp === null) continue;
    let line = `${role} @ ${emp}`;
    const summaryRaw = nonBlank(entry.experience_summary);
    if (summaryRaw !== null) {
      const summary = sanitizeSemanticText(summaryRaw);
      if (summary !== '') line += ` — ${summary}`;
    }
    const loc = coarseLocality(entry.location);
    if (loc !== null) line += ` (${loc})`;
    experienceLines.push(`- ${line}`);
  }
  if (experienceLines.length > 0) {
    lines.push('Experience:', ...experienceLines);
  }

  const document = lines.join('\n');
  const source_hash = createHash('sha256').update(document).digest('hex');
  return { document, source_hash };
}
