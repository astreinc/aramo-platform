import type { TalentRecordPrefill } from '../types/parse-resume.types.js';

// A8-3b — deterministic heuristic field-extraction.
//
// NO LLM (ADR-0015 Decision 10). Pure regex + structural-section matching.
// Best-effort: the recruiter reviews + corrects in the UI. Unparseable
// fields are returned absent (NOT empty string -- the DTO optionality
// is preserved on the consumer side).
//
// The minimal-identity set is { name, email-or-phone }. If both are
// present, parse_status='parsed'; if some fields extract but not the
// minimal set, 'partial'; if extraction itself fails, 'failed' (set
// upstream in the service, not here).

const EMAIL_RE = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/g;
const URL_RE = /(https?:\/\/[^\s)<>]+)/g;
const ZIP_RE = /\b(\d{5}(?:-\d{4})?)\b/;
const US_STATE_RE = /\b(A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b/;

const SKILLS_HEADER_RE = /^[\s]*(skills?|technical\s+skills?|core\s+competencies|competencies)\s*:?\s*$/im;
const EXPERIENCE_HEADER_RE = /^[\s]*(experience|employment(?:\s+history)?|work\s+history|professional\s+experience)\s*:?\s*$/im;
const EDUCATION_HEADER_RE = /^[\s]*(education|academic|qualifications)\s*:?\s*$/im;

function uniq<T>(items: ReadonlyArray<T>): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of items) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

function extractEmails(text: string): string[] {
  const matches = text.match(EMAIL_RE) ?? [];
  return uniq(matches.map((m) => m.toLowerCase()));
}

function extractPhones(text: string): string[] {
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  PHONE_RE.lastIndex = 0;
  while ((m = PHONE_RE.exec(text)) !== null) {
    matches.push(`${m[1]}-${m[2]}-${m[3]}`);
  }
  return uniq(matches);
}

function extractName(text: string, contactLineIdx: number): { first?: string; last?: string } {
  // The name heuristic: walk back from the first contact-info line
  // (email or phone) looking for the most recent non-empty line that
  // looks like a name -- letters + spaces + at most one period/hyphen,
  // 2-4 tokens, no digits, no '@'.
  const lines = text.split('\n');
  const upperBound = contactLineIdx >= 0 ? contactLineIdx : Math.min(lines.length, 10);

  for (let i = upperBound - 1; i >= 0 && i >= upperBound - 6; i--) {
    const line = lines[i]?.trim() ?? '';
    if (line.length === 0) continue;
    if (line.length > 60) continue; // too long to be a name
    if (/[@\d]/.test(line)) continue; // emails / phones / dates
    if (/^[-=*_]+$/.test(line)) continue; // horizontal rules
    const tokens = line.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length < 2 || tokens.length > 5) continue;
    if (!tokens.every((t) => /^[a-zA-ZÀ-ÿ.\-']+$/.test(t))) continue;
    return { first: tokens[0], last: tokens.slice(1).join(' ') };
  }

  return {};
}

function findContactLineIndex(text: string): number {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (EMAIL_RE.test(line)) {
      EMAIL_RE.lastIndex = 0;
      return i;
    }
    EMAIL_RE.lastIndex = 0;
    PHONE_RE.lastIndex = 0;
    if (PHONE_RE.test(line)) {
      PHONE_RE.lastIndex = 0;
      return i;
    }
    PHONE_RE.lastIndex = 0;
  }
  return -1;
}

function extractSection(text: string, headerRe: RegExp): string | undefined {
  const lines = text.split('\n');
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i] ?? '')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return undefined;

  // Collect until the next ALL-CAPS-or-known-header line, blank-run, or EOF.
  const sectionLines: string[] = [];
  let blankRun = 0;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      blankRun++;
      if (blankRun >= 2) break;
      continue;
    }
    blankRun = 0;
    if (
      SKILLS_HEADER_RE.test(raw) ||
      EXPERIENCE_HEADER_RE.test(raw) ||
      EDUCATION_HEADER_RE.test(raw)
    ) {
      if (i !== headerIdx) break;
    }
    sectionLines.push(trimmed);
  }
  const joined = sectionLines.join(' ').trim();
  return joined.length === 0 ? undefined : joined;
}

function extractKeySkills(text: string): string | undefined {
  return extractSection(text, SKILLS_HEADER_RE);
}

function extractCurrentEmployer(text: string): string | undefined {
  const section = extractSection(text, EXPERIENCE_HEADER_RE);
  if (section === undefined) return undefined;
  // First "non-throwaway" token-run before a date or punctuation cluster.
  // Heuristic: take the first ~80 chars before any date-like substring.
  const dateRe = /\b(20\d{2}|19\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i;
  const cutIdx = section.search(dateRe);
  const extracted = (cutIdx === -1 ? section : section.slice(0, cutIdx)).trim();
  if (extracted.length === 0) return undefined;
  // Trim to a reasonable employer-name length (max 80 chars).
  const truncated = extracted.length > 80 ? extracted.slice(0, 80).trim() : extracted;
  return truncated;
}

function extractWebSite(text: string, emails: ReadonlyArray<string>): string | undefined {
  const urls = text.match(URL_RE) ?? [];
  const emailDomains = new Set(emails.map((e) => e.split('@')[1] ?? '').filter((d) => d.length > 0));
  for (const url of urls) {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (!emailDomains.has(host)) {
      return url;
    }
  }
  return undefined;
}

function extractZip(text: string): string | undefined {
  const m = text.match(ZIP_RE);
  return m === null ? undefined : m[1];
}

function extractState(text: string): string | undefined {
  const m = text.match(US_STATE_RE);
  return m === null ? undefined : m[1];
}

/**
 * Run the heuristic field-extraction over plain text. Pure function
 * (no IO; no LLM; no AsyncIterables).
 */
export function extractFields(text: string): TalentRecordPrefill {
  const emails = extractEmails(text);
  const phones = extractPhones(text);
  const contactLineIdx = findContactLineIndex(text);
  const name = extractName(text, contactLineIdx);

  const prefill: TalentRecordPrefill = {};

  if (name.first !== undefined) prefill.first_name = name.first;
  if (name.last !== undefined) prefill.last_name = name.last;

  if (emails[0] !== undefined) prefill.email1 = emails[0];
  if (emails[1] !== undefined) prefill.email2 = emails[1];

  if (phones[0] !== undefined) prefill.phone_cell = phones[0];
  if (phones[1] !== undefined) prefill.phone_home = phones[1];
  if (phones[2] !== undefined) prefill.phone_work = phones[2];

  const zip = extractZip(text);
  if (zip !== undefined) prefill.zip = zip;
  const state = extractState(text);
  if (state !== undefined) prefill.state = state;

  const skills = extractKeySkills(text);
  if (skills !== undefined) prefill.key_skills = skills;

  const employer = extractCurrentEmployer(text);
  if (employer !== undefined) prefill.current_employer = employer;

  const website = extractWebSite(text, emails);
  if (website !== undefined) prefill.web_site = website;

  return prefill;
}

/**
 * Determine whether the extracted fields meet the minimal-identity set
 * (a name AND at least one contact channel). The service uses this to
 * report parse_status='parsed' vs 'partial'.
 */
export function meetsMinimalIdentity(prefill: TalentRecordPrefill): boolean {
  const hasName =
    typeof prefill.first_name === 'string' && prefill.first_name.length > 0 &&
    typeof prefill.last_name === 'string' && prefill.last_name.length > 0;
  const hasContact =
    (typeof prefill.email1 === 'string' && prefill.email1.length > 0) ||
    (typeof prefill.phone_cell === 'string' && prefill.phone_cell.length > 0);
  return hasName && hasContact;
}
