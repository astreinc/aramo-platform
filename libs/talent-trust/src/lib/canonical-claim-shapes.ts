import { v5 as uuidv5 } from 'uuid';

// TR-4 B1 (DDR §2.1/§2.2) — the CANONICAL CLAIM-SHAPE registry.
//
// The OPEN-6 pattern extended from *band elevation* to *payload shape*: a pure,
// deterministic, per-assertion_type contract that validates + normalizes the
// `assertion_payload` a REGISTERED type must carry. The write path (recordEvidence
// / recordDeclaredEvidenceForSubject) runs the registered type's shape and refuses
// a non-conforming payload with CLAIM_SHAPE_INVALID (422). An UNregistered type is
// left untouched (@IsObject passthrough) — admission stays open; registering a type
// is the deliberate act that buys comparability (B3's detectors compare over these
// canonical fields, never over free-form mush).
//
// LANDED COLD in B1: EMPLOYMENT / SKILL have no ledger producer yet (B2 routes
// talent-extraction in). The IDENTITY contact shapes DO have live writers — the
// canary convergence (DDR §2.3) makes them all emit canonical key `value`.
//
// DETERMINISTIC-ONLY (ADR-0015 D10): no LLM, no fuzzy matching, no entity guessing.
// Dates parse through a fixed table → ISO or null (NEVER a guessed date); the raw
// string is always preserved beside the normalized field (I10 spirit — normalization
// adds, never destroys). Employer normalization is equality-normalization ONLY
// (lowercase + whitespace-collapse + a small documented suffix/punctuation strip) —
// explicitly NOT entity resolution (open-world; deferred out of v1 per DDR §1).

export interface ClaimShapeResult {
  ok: boolean;
  // The normalized payload to persist (present iff ok). Adds normalized fields;
  // never drops caller-supplied keys (provenance travels through).
  canonical?: Record<string, unknown>;
  // Human-readable reasons the payload failed its contract (present iff !ok).
  errors?: string[];
}

type ClaimShape = (payload: Record<string, unknown>) => ClaimShapeResult;

// ---- deterministic date parse table (ISO-or-null; NEVER guessed) ----------
//
// Only UNAMBIGUOUS formats parse. Anything ambiguous (e.g. `01/02/2020` — Jan 2
// or Feb 1?) or unrecognized returns null — the raw is preserved by the caller.
// Output is a calendar date string `YYYY-MM-DD` (day defaults to 01 for month- or
// year-granularity inputs; that is a documented granularity floor, not a guess).

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function isoOrNull(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (year < 1000 || year > 9999) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

// Parse an arbitrary date-ish string to an ISO calendar date, or null. Pure +
// deterministic — the same input always yields the same result, no locale, no
// Date() guessing. Exported for the acceptance property cases.
export function parseToIsoDateOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s.length === 0) return null;

  // YYYY-MM-DD (optionally with a time suffix we ignore) — full ISO.
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s);
  if (m !== null) return isoOrNull(+m[1]!, +m[2]!, +m[3]!);

  // YYYY-MM — month granularity.
  m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m !== null) return isoOrNull(+m[1]!, +m[2]!, 1);

  // MM/YYYY — unambiguous (a 4-digit year on the right).
  m = /^(\d{1,2})\/(\d{4})$/.exec(s);
  if (m !== null) return isoOrNull(+m[2]!, +m[1]!, 1);

  // YYYY — year granularity.
  m = /^(\d{4})$/.exec(s);
  if (m !== null) return isoOrNull(+m[1]!, 1, 1);

  // "Mon YYYY" / "Month YYYY" — a named month + year.
  m = /^([A-Za-z]+)\.?\s+(\d{4})$/.exec(s);
  if (m !== null) {
    const month = MONTH_NAMES[m[1]!.toLowerCase()];
    if (month !== undefined) return isoOrNull(+m[2]!, month, 1);
  }

  // Unrecognized / ambiguous → null (raw preserved by the caller; never guessed).
  return null;
}

// ---- employer equality-normalization (NOT entity resolution) --------------
// A small, DOCUMENTED strip so two spellings of the same employer compare equal
// under normalized-string equality (DDR §1): lowercase, collapse whitespace, drop
// surrounding punctuation, and strip a fixed set of trailing corporate suffixes.
// This is deliberately NOT open-world entity resolution — "Acme" and "Acme Inc."
// converge; "Acme" and "Acme Corp of Ohio" do not. Conservative by construction.
const CORP_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'l.l.c', 'ltd', 'limited', 'corp', 'corporation',
  'co', 'company', 'gmbh', 'plc', 'sa', 'ag', 'nv', 'bv',
]);

function normalizeEmployer(raw: string): string {
  let s = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  // Strip surrounding punctuation on the whole string.
  s = s.replace(/^[\s.,;:&/-]+|[\s.,;:&/-]+$/g, '');
  // Drop trailing corporate suffixes (repeatedly — "Foo Co., Ltd." → "foo").
  let changed = true;
  while (changed) {
    changed = false;
    const tokens = s.split(' ');
    if (tokens.length > 1) {
      const last = tokens[tokens.length - 1]!.replace(/[.,]/g, '');
      if (CORP_SUFFIXES.has(last)) {
        tokens.pop();
        s = tokens.join(' ').replace(/[\s.,;:&/-]+$/g, '');
        changed = true;
      }
    }
  }
  return s;
}

// ---- skill_id derivation (mirror of talent-extraction/skill-id.ts) --------
// Replicated LOCALLY (no @aramo/talent-extraction edge — DDR §4 "no new edges"):
// the SAME fixed namespace + normalize, so the derived skill_id is byte-identical
// to the producer's. Keep in sync with libs/talent-extraction/src/lib/skill-id.ts
// (fixed namespace — changing it re-keys every derived id). B2's dual-write relies
// on this parity for cross-store dedup.
const ARAMO_SKILL_NAMESPACE = 'a5f1c0de-5c11-4a5e-9b00-5ec0de5ec0de';

function normalizeSkillSurfaceForm(surfaceForm: string): string {
  return surfaceForm.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function deriveSkillIdCanonical(surfaceForm: string): string {
  return uuidv5(normalizeSkillSurfaceForm(surfaceForm), ARAMO_SKILL_NAMESPACE);
}

// ---- shape helpers --------------------------------------------------------

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function optionalString(v: unknown): v is string | undefined {
  return v === undefined || typeof v === 'string';
}

// ---- the registered shapes ------------------------------------------------

// EMPLOYMENT (DDR §2.1): typed employer/title + ISO-or-null date window. employer
// and role_title are required (a claim of employment is meaningless without them);
// dates and employment_type are optional. Raw preserved beside every normalized field.
const employmentShape: ClaimShape = (p) => {
  const errors: string[] = [];
  if (!nonEmptyString(p['employer_raw'])) errors.push('employer_raw must be a non-empty string');
  if (!nonEmptyString(p['role_title_raw'])) errors.push('role_title_raw must be a non-empty string');
  if (!optionalString(p['start_date_raw'])) errors.push('start_date_raw must be a string when present');
  if (!optionalString(p['end_date_raw'])) errors.push('end_date_raw must be a string when present');
  if (!optionalString(p['employment_type_raw'])) errors.push('employment_type_raw must be a string when present');
  if (errors.length > 0) return { ok: false, errors };

  const employerRaw = (p['employer_raw'] as string).trim();
  const startRaw = p['start_date_raw'] as string | undefined;
  const endRaw = p['end_date_raw'] as string | undefined;
  const canonical: Record<string, unknown> = {
    employer_raw: employerRaw,
    employer_norm: normalizeEmployer(employerRaw),
    role_title_raw: (p['role_title_raw'] as string).trim(),
    // ISO-or-null; the raw is ALWAYS preserved beside it (never a guessed date).
    start_date: parseToIsoDateOrNull(startRaw),
    end_date: parseToIsoDateOrNull(endRaw),
  };
  if (startRaw !== undefined) canonical['start_date_raw'] = startRaw;
  if (endRaw !== undefined) canonical['end_date_raw'] = endRaw;
  if (p['employment_type_raw'] !== undefined) {
    canonical['employment_type_raw'] = p['employment_type_raw'];
  }
  return { ok: true, canonical };
};

// SKILL (DDR §2.1): the raw surface form + its deterministic skill_id. skill_id is
// DERIVED (never trusted from the caller) so it is always parity-correct.
const skillShape: ClaimShape = (p) => {
  if (!nonEmptyString(p['value_raw'])) {
    return { ok: false, errors: ['value_raw must be a non-empty string'] };
  }
  const valueRaw = (p['value_raw'] as string).trim();
  return { ok: true, canonical: { value_raw: valueRaw, skill_id: deriveSkillIdCanonical(valueRaw) } };
};

// IDENTITY contact shapes (DDR §2.3): the canary — a single normalized identifier
// under canonical key `value`. Required: `value` (non-empty). Provenance keys
// (raw_source / source_channel / payload_id / raw) travel through untouched.
const contactShape: ClaimShape = (p) => {
  if (!nonEmptyString(p['value'])) {
    return { ok: false, errors: ['value must be a non-empty string (the normalized identifier)'] };
  }
  return { ok: true, canonical: { ...p, value: (p['value'] as string) } };
};

// The registry: assertion_type → its canonical shape. Membership here IS the
// "registered" predicate the write gate checks. Adding a type is a DDR-amendment-
// level act (like AUTHORITATIVE_ASSERTION_TYPES), never a silent extension.
export const CANONICAL_CLAIM_SHAPES: Record<string, ClaimShape> = {
  EMPLOYMENT: employmentShape,
  SKILL: skillShape,
  EMAIL: contactShape,
  PHONE: contactShape,
  PROFILE_URL: contactShape,
};

export function isRegisteredAssertionType(assertionType: string): boolean {
  return Object.prototype.hasOwnProperty.call(CANONICAL_CLAIM_SHAPES, assertionType);
}

// The write-path helper. A REGISTERED type validates+normalizes; an UNregistered
// type passes through untouched (admission open). Callers persist `canonical`.
export function validateClaimShape(
  assertionType: string,
  payload: unknown,
): ClaimShapeResult {
  const shape = CANONICAL_CLAIM_SHAPES[assertionType];
  if (shape === undefined) {
    // Unregistered — passthrough, exactly the pre-TR-4 posture.
    return { ok: true, canonical: (payload ?? {}) as Record<string, unknown> };
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, errors: ['assertion_payload must be an object'] };
  }
  return shape(payload as Record<string, unknown>);
}
