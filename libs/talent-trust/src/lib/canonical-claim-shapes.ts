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

// DEGREE (TR-7 D2): a declared academic credential. institution + degree are
// required (a degree claim is meaningless without them); field of study is
// optional; the conferred date parses ISO-or-null (NEVER guessed) with the raw
// preserved beside it. No verification is implied by the shape — an unverified
// DEGREE sits at its source_class ceiling (the elevation registry gates on class
// AND type together). Mirrors EMPLOYMENT's date discipline exactly.
const degreeShape: ClaimShape = (p) => {
  const errors: string[] = [];
  if (!nonEmptyString(p['institution_raw'])) errors.push('institution_raw must be a non-empty string');
  if (!nonEmptyString(p['degree_raw'])) errors.push('degree_raw must be a non-empty string');
  if (!optionalString(p['field_raw'])) errors.push('field_raw must be a string when present');
  if (!optionalString(p['conferred_date_raw'])) errors.push('conferred_date_raw must be a string when present');
  if (errors.length > 0) return { ok: false, errors };

  const conferredRaw = p['conferred_date_raw'] as string | undefined;
  const canonical: Record<string, unknown> = {
    institution_raw: (p['institution_raw'] as string).trim(),
    degree_raw: (p['degree_raw'] as string).trim(),
    // ISO-or-null; the raw is ALWAYS preserved beside it (never a guessed date).
    conferred_date: parseToIsoDateOrNull(conferredRaw),
  };
  if (nonEmptyString(p['field_raw'])) canonical['field_raw'] = (p['field_raw'] as string).trim();
  if (conferredRaw !== undefined) canonical['conferred_date_raw'] = conferredRaw;
  return { ok: true, canonical };
};

// CERTIFICATION (TR-7 D2): a declared professional certification. name is required;
// issuer and credential reference are optional; issued + expiry dates parse
// ISO-or-null (NEVER guessed) with the raw preserved beside each. Same source-class
// honesty as DEGREE — richer captured claim, not a verified one.
const certificationShape: ClaimShape = (p) => {
  const errors: string[] = [];
  if (!nonEmptyString(p['name_raw'])) errors.push('name_raw must be a non-empty string');
  if (!optionalString(p['issuer_raw'])) errors.push('issuer_raw must be a string when present');
  if (!optionalString(p['credential_ref_raw'])) errors.push('credential_ref_raw must be a string when present');
  if (!optionalString(p['issued_date_raw'])) errors.push('issued_date_raw must be a string when present');
  if (!optionalString(p['expiry_date_raw'])) errors.push('expiry_date_raw must be a string when present');
  if (errors.length > 0) return { ok: false, errors };

  const issuedRaw = p['issued_date_raw'] as string | undefined;
  const expiryRaw = p['expiry_date_raw'] as string | undefined;
  const canonical: Record<string, unknown> = {
    name_raw: (p['name_raw'] as string).trim(),
    issued_date: parseToIsoDateOrNull(issuedRaw),
    expiry_date: parseToIsoDateOrNull(expiryRaw),
  };
  if (nonEmptyString(p['issuer_raw'])) canonical['issuer_raw'] = (p['issuer_raw'] as string).trim();
  if (nonEmptyString(p['credential_ref_raw'])) canonical['credential_ref_raw'] = (p['credential_ref_raw'] as string).trim();
  if (issuedRaw !== undefined) canonical['issued_date_raw'] = issuedRaw;
  if (expiryRaw !== undefined) canonical['expiry_date_raw'] = expiryRaw;
  return { ok: true, canonical };
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

// TIMELINE_GAP (TR-4 B3, DDR §4.3): a CONTINUITY gap signal the consistency
// detector records — the bounding ISO dates of an interior hole plus the ids of
// the two employment records that bound it. A gap is a question, not an
// accusation. Dates are computed by arithmetic (already ISO), validated here as
// ISO-or-reject (NOT parseToIsoDateOrNull — a gap with an unparseable bound is a
// bug, refuse it; the detector only ever produces valid ISO).
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const timelineGapShape: ClaimShape = (p) => {
  const errors: string[] = [];
  if (typeof p['gap_start'] !== 'string' || !ISO_DATE.test(p['gap_start'] as string)) {
    errors.push('gap_start must be an ISO calendar date (YYYY-MM-DD)');
  }
  if (typeof p['gap_end'] !== 'string' || !ISO_DATE.test(p['gap_end'] as string)) {
    errors.push('gap_end must be an ISO calendar date (YYYY-MM-DD)');
  }
  if (!nonEmptyString(p['before_evidence_id'])) errors.push('before_evidence_id required');
  if (!nonEmptyString(p['after_evidence_id'])) errors.push('after_evidence_id required');
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    canonical: {
      gap_start: p['gap_start'] as string,
      gap_end: p['gap_end'] as string,
      before_evidence_id: (p['before_evidence_id'] as string).trim(),
      after_evidence_id: (p['after_evidence_id'] as string).trim(),
    },
  };
};

// LONGITUDINAL_PRESENCE (TR-5 B2, DDR §3.1): the positive CONTINUITY signal a
// contact identifier proves by recurring across arrivals — "this identity
// persisted". Deterministic derived payload (the consistency deriver is the only
// writer): anchor_kind + the ISO window it spanned + an observation count + the
// basis evidence ids. Dates are already ISO (computed from collected_at), so
// ISO-or-reject (a non-ISO bound is a deriver bug). count ≥ 2 (a single arrival
// is no persistence). basis_evidence_ids: a non-empty string list.
const longitudinalPresenceShape: ClaimShape = (p) => {
  const errors: string[] = [];
  if (typeof p['anchor_kind'] !== 'string' || (p['anchor_kind'] as string).trim() === '') {
    errors.push('anchor_kind must be a non-empty string');
  }
  if (typeof p['first_seen'] !== 'string' || !ISO_DATE.test(p['first_seen'] as string)) {
    errors.push('first_seen must be an ISO calendar date (YYYY-MM-DD)');
  }
  if (typeof p['last_seen'] !== 'string' || !ISO_DATE.test(p['last_seen'] as string)) {
    errors.push('last_seen must be an ISO calendar date (YYYY-MM-DD)');
  }
  if (typeof p['observation_count'] !== 'number' || !Number.isInteger(p['observation_count']) || (p['observation_count'] as number) < 2) {
    errors.push('observation_count must be an integer ≥ 2');
  }
  const basis = p['basis_evidence_ids'];
  if (!Array.isArray(basis) || basis.length < 2 || !basis.every((b) => typeof b === 'string' && b !== '')) {
    errors.push('basis_evidence_ids must be a list of ≥ 2 non-empty strings');
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    canonical: {
      anchor_kind: (p['anchor_kind'] as string).trim(),
      first_seen: p['first_seen'] as string,
      last_seen: p['last_seen'] as string,
      observation_count: p['observation_count'] as number,
      basis_evidence_ids: [...(basis as string[])].sort(),
    },
  };
};

// HISTORY_SPAN (TR-5 B2, DDR §3.2): fully-dated employment covering ≥ 24 months
// with zero open gaps — the positive mirror of TIMELINE_GAP. span_months a
// non-negative integer; earliest/latest ISO; open_gap_count present (the deriver
// only writes it as 0, but the shape validates it as a non-negative integer).
const historySpanShape: ClaimShape = (p) => {
  const errors: string[] = [];
  if (typeof p['span_months'] !== 'number' || !Number.isInteger(p['span_months']) || (p['span_months'] as number) < 0) {
    errors.push('span_months must be a non-negative integer');
  }
  if (typeof p['earliest'] !== 'string' || !ISO_DATE.test(p['earliest'] as string)) {
    errors.push('earliest must be an ISO calendar date (YYYY-MM-DD)');
  }
  if (typeof p['latest'] !== 'string' || !ISO_DATE.test(p['latest'] as string)) {
    errors.push('latest must be an ISO calendar date (YYYY-MM-DD)');
  }
  if (typeof p['open_gap_count'] !== 'number' || !Number.isInteger(p['open_gap_count']) || (p['open_gap_count'] as number) < 0) {
    errors.push('open_gap_count must be a non-negative integer');
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    canonical: {
      span_months: p['span_months'] as number,
      earliest: p['earliest'] as string,
      latest: p['latest'] as string,
      open_gap_count: p['open_gap_count'] as number,
    },
  };
};

// TR-9 B1 (DDR §D2) — the reference-attestation shape (web-of-trust v1). A
// recruiter records a reference they already lawfully hold; the platform
// contacts no one (attester contact/verification is TR-9-B, counsel-gated). The
// attester DESCRIPTOR is the load-bearing key — the independence-collapse group
// (D3) and the future verified-attester axis both key on it, captured from day
// one. R10 STRUCTURAL: there is NO rating field — a reference with a number
// is a review, not evidence; the shape cannot hold the concept. Named
// ATTESTATION as the assertion_type (the web-of-trust evidence type); distinct
// from the recruiter submittal "attestations" (a different domain).

// The statement's class — chosen by the recruiter, closed vocab. SKILL/WORK
// accrue in CLAIMS; TENURE in CONTINUITY (the capture service maps it).
export const STATEMENT_CLASSES = ['SKILL', 'WORK', 'TENURE'] as const;
export type StatementClass = (typeof STATEMENT_CLASSES)[number];
export const STATEMENT_CLASS_DIMENSION: Record<StatementClass, 'CLAIMS' | 'CONTINUITY'> = {
  SKILL: 'CLAIMS',
  WORK: 'CLAIMS',
  TENURE: 'CONTINUITY',
};

// Email normalization — the matcher's convention exactly (trim + lowercase), so
// an attester email_norm keys against SubjectAnchor.normalized_value (D4).
function normalizeEmailForAttester(raw: string): string {
  return raw.trim().toLowerCase();
}

const attestationShape: ClaimShape = (p) => {
  const errors: string[] = [];
  const attesterIn = (p['attester'] ?? {}) as Record<string, unknown>;
  if (!nonEmptyString(attesterIn['name_raw']))
    errors.push('attester.name_raw must be a non-empty string');
  if (!optionalString(attesterIn['email_raw']))
    errors.push('attester.email_raw must be a string when present');
  if (!optionalString(attesterIn['company_raw']))
    errors.push('attester.company_raw must be a string when present');
  if (!optionalString(attesterIn['role_raw']))
    errors.push('attester.role_raw must be a string when present');
  if (!nonEmptyString(p['relationship_raw']))
    errors.push('relationship_raw must be a non-empty string');
  if (!nonEmptyString(p['statement_raw']))
    errors.push('statement_raw must be a non-empty string');
  const statementClass = p['statement_class'];
  if (
    typeof statementClass !== 'string' ||
    !(STATEMENT_CLASSES as readonly string[]).includes(statementClass)
  ) {
    errors.push(`statement_class must be one of ${STATEMENT_CLASSES.join('|')}`);
  }
  const periodIn = (p['period'] ?? {}) as Record<string, unknown>;
  if (!optionalString(periodIn['start_raw']))
    errors.push('period.start_raw must be a string when present');
  if (!optionalString(periodIn['end_raw']))
    errors.push('period.end_raw must be a string when present');
  if (errors.length > 0) return { ok: false, errors };

  const emailRaw = optionalString(attesterIn['email_raw'])
    ? (attesterIn['email_raw'] as string)
    : undefined;
  const attester: Record<string, unknown> = { name_raw: (attesterIn['name_raw'] as string).trim() };
  if (emailRaw !== undefined && emailRaw.trim().length > 0)
    attester['email_norm'] = normalizeEmailForAttester(emailRaw);
  if (typeof attesterIn['company_raw'] === 'string')
    attester['company_raw'] = attesterIn['company_raw'].trim();
  if (typeof attesterIn['role_raw'] === 'string')
    attester['role_raw'] = attesterIn['role_raw'].trim();

  const startRaw = optionalString(periodIn['start_raw'])
    ? (periodIn['start_raw'] as string)
    : undefined;
  const endRaw = optionalString(periodIn['end_raw']) ? (periodIn['end_raw'] as string) : undefined;

  return {
    ok: true,
    canonical: {
      attester,
      relationship_raw: (p['relationship_raw'] as string).trim(),
      statement_class: statementClass as string,
      statement_raw: (p['statement_raw'] as string).trim(),
      // Dates null-never-guessed; the raw is preserved beside the parsed ISO.
      period: {
        start_raw: startRaw ?? null,
        end_raw: endRaw ?? null,
        start: parseToIsoDateOrNull(startRaw),
        end: parseToIsoDateOrNull(endRaw),
      },
    },
  };
};

// TR-9 B1 (D3) — the attester independence-collapse key. Deterministic: the
// normalized email where present, else normalized name+company. Attestations
// sharing this key collapse to ONE independence group (five references from one
// person are one signal, not five). Computed at capture, stored in
// source_ref.attester_key, read by the derivation's independenceKey — so the
// band derivation needs no assertion_payload.
export function attesterDescriptorKey(attesterCanonical: Record<string, unknown>): string {
  const email = attesterCanonical['email_norm'];
  if (typeof email === 'string' && email.length > 0) return `email:${email}`;
  const name = typeof attesterCanonical['name_raw'] === 'string' ? attesterCanonical['name_raw'] : '';
  const company =
    typeof attesterCanonical['company_raw'] === 'string' ? attesterCanonical['company_raw'] : '';
  const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');
  return `nameco:${norm(name)}|${norm(company)}`;
}

// The registry: assertion_type → its canonical shape. Membership here IS the
// "registered" predicate the write gate checks. Adding a type is a DDR-amendment-
// level act (like AUTHORITATIVE_ASSERTION_TYPES), never a silent extension.
//
// TR-5 B2 (§1) — the two-registries distinction: LONGITUDINAL_PRESENCE and
// HISTORY_SPAN register HERE (comparability — their payloads validate), but they
// are DELIBERATELY absent from AUTHORITATIVE_ASSERTION_TYPES.CONTINUITY (which
// stays ∅). Comparability is not elevation: the top CONTINUITY bands stay
// honestly unreachable because nothing authoritative asserts continuity yet.
export const CANONICAL_CLAIM_SHAPES: Record<string, ClaimShape> = {
  EMPLOYMENT: employmentShape,
  SKILL: skillShape,
  // TR-7 D2 — the credential-claim capture (already in AUTHORITATIVE_ASSERTION_
  // TYPES.CLAIMS since the TR-3 seed; registered HERE now buys payload comparability.
  // Today's captures are THIRD_PARTY_UNVERIFIED/DOCUMENT — they do NOT elevate).
  DEGREE: degreeShape,
  CERTIFICATION: certificationShape,
  EMAIL: contactShape,
  PHONE: contactShape,
  PROFILE_URL: contactShape,
  // TR-4 B3 — the consistency detector's CONTINUITY gap signal.
  TIMELINE_GAP: timelineGapShape,
  // TR-5 B2 — the two positive CONTINUITY derivers' shapes.
  LONGITUDINAL_PRESENCE: longitudinalPresenceShape,
  HISTORY_SPAN: historySpanShape,
  // TR-9 B1 (D2) — reference-attestation. Registered HERE for payload
  // comparability; DELIBERATELY ABSENT from AUTHORITATIVE_ASSERTION_TYPES — a v1
  // attestation is THIRD_PARTY_UNVERIFIED and MUST NOT elevate. The verified-
  // attester elevation is TR-9-B, by amendment, never by drift.
  ATTESTATION: attestationShape,
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
