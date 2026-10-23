import { createHash } from 'node:crypto';

import type { DraftFromResumeResponse } from '../dto/draft-from-resume.response.js';

// Durable Async Talent Intake — the persisted recruiter-review payload shape and
// the field-authority merge. Backend-owned so reopening from another session or
// device is correct. The merge invariant (directive I7): extraction may populate
// only fields the recruiter has NOT edited; a recruiter-edited value is never
// overwritten by a later/again extraction.

export type IntakeFieldOrigin = 'RESUME_EXTRACTION' | 'RECRUITER';

export interface IntakeReviewField {
  value: string | boolean | null;
  origin: IntakeFieldOrigin;
}

// The reviewable evidence arrays the recruiter can edit on the Add-Talent form.
// `skills` is NOT among them: the structured skills list is extraction-owned and
// carried verbatim (the recruiter edits the free-text key_skills scalar instead).
export const REVIEW_ARRAY_KEYS = ['work_history', 'education', 'certifications'] as const;
export type ReviewArrayKey = (typeof REVIEW_ARRAY_KEYS)[number];

export interface IntakeReviewPayload {
  fields: Record<string, IntakeReviewField>;
  work_history?: unknown[];
  skills?: unknown[];
  education?: unknown[];
  certifications?: unknown[];
  // ATS-QA-1 I-3 (Durable-Async I7 / §8.5 conformance) — per-array origin, owned
  // by the backend: RECRUITER once a review save carried that array (the
  // recruiter edited it), RESUME_EXTRACTION when the governed extraction wrote
  // it. Absent on drafts saved before this field existed.
  array_origin?: Partial<Record<ReviewArrayKey, IntakeFieldOrigin>>;
  resume_provenance?: {
    source_map_version?: string;
    resume_text_hash?: string;
  };
}

// The scalar prefill keys the governed extraction may propose. The admission
// fields (first_name, last_name, email1, phone_cell) are among these.
const PREFILL_SCALAR_KEYS = [
  'first_name',
  'last_name',
  'address',
  'city',
  'state',
  'zip',
  'country',
  'email1',
  'email2',
  'phone_cell',
  'phone_home',
  'phone_work',
  'current_employer',
  'title',
  'key_skills',
] as const;

export function emptyIntakeReviewPayload(): IntakeReviewPayload {
  return { fields: {} };
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asArrayOrigin(value: unknown): IntakeReviewPayload['array_origin'] {
  if (value === null || typeof value !== 'object') return undefined;
  const out: Partial<Record<ReviewArrayKey, IntakeFieldOrigin>> = {};
  for (const key of REVIEW_ARRAY_KEYS) {
    const v = (value as Record<string, unknown>)[key];
    if (v === 'RECRUITER' || v === 'RESUME_EXTRACTION') out[key] = v;
  }
  return out;
}

export function asReviewPayload(value: unknown): IntakeReviewPayload {
  if (value === null || value === undefined || typeof value !== 'object') {
    return emptyIntakeReviewPayload();
  }
  const parsed = value as Partial<Record<keyof IntakeReviewPayload, unknown>>;
  const fields =
    parsed.fields !== null && typeof parsed.fields === 'object'
      ? (parsed.fields as Record<string, IntakeReviewField>)
      : {};
  const arrayOrigin = asArrayOrigin(parsed.array_origin);
  return {
    fields,
    work_history: asArray(parsed.work_history),
    skills: asArray(parsed.skills),
    education: asArray(parsed.education),
    certifications: asArray(parsed.certifications),
    ...(arrayOrigin !== undefined ? { array_origin: arrayOrigin } : {}),
    resume_provenance: parsed.resume_provenance as IntakeReviewPayload['resume_provenance'],
  };
}

// Is this persisted array recruiter-owned (never replaced by extraction)?
//   - origin RECRUITER                → yes (the recruiter edited it);
//   - origin RESUME_EXTRACTION        → no;
//   - no origin recorded (a draft saved before origins existed) → owned only
//     when it actually holds entries. The old client saved every array on every
//     autosave, so an EMPTY legacy array is not a recruiter decision; a
//     non-empty one may be, and is kept.
function isRecruiterOwned(base: IntakeReviewPayload, key: ReviewArrayKey): boolean {
  const origin = base.array_origin?.[key];
  if (origin !== undefined) return origin === 'RECRUITER';
  const current = base[key];
  return current !== undefined && current.length > 0;
}

// Merge a fresh governed extraction into the persisted review payload WITHOUT
// clobbering recruiter edits (directive I7 / §8.5):
//   - a scalar field already carrying origin RECRUITER is left untouched; every
//     other proposed field is (re)written with origin RESUME_EXTRACTION;
//   - each array is replaced by the extraction ONLY when the recruiter has not
//     edited THAT array (per-array, backend-owned origin) — editing work history
//     never freezes education, and vice versa;
//   - nothing disappears: an extraction that returns no entries for an array
//     (partial / repeated / failed) keeps whatever the draft already holds.
export function mergeExtractionIntoReview(
  existing: unknown,
  result: DraftFromResumeResponse,
): IntakeReviewPayload {
  const base = asReviewPayload(existing);
  const mergedFields: Record<string, IntakeReviewField> = { ...base.fields };

  const prefill = result.prefill as Record<string, unknown>;
  for (const key of PREFILL_SCALAR_KEYS) {
    const proposed = prefill[key];
    if (proposed === undefined) {
      continue;
    }
    const current = mergedFields[key];
    if (current !== undefined && current.origin === 'RECRUITER') {
      // Recruiter edit wins — never overwritten by extraction (I7).
      continue;
    }
    mergedFields[key] = {
      value: typeof proposed === 'boolean' ? proposed : String(proposed),
      origin: 'RESUME_EXTRACTION',
    };
  }

  const merged: IntakeReviewPayload = {
    fields: mergedFields,
    // Structured skills are extraction-owned: a newer non-empty result replaces
    // them; otherwise the draft keeps what it has.
    skills:
      result.skills !== undefined && result.skills.length > 0 ? result.skills : base.skills,
    resume_provenance:
      result.source_map_version !== undefined || result.resume_text_hash !== undefined
        ? {
            source_map_version: result.source_map_version,
            resume_text_hash: result.resume_text_hash,
          }
        : base.resume_provenance,
  };
  const origin: Partial<Record<ReviewArrayKey, IntakeFieldOrigin>> = { ...base.array_origin };
  for (const key of REVIEW_ARRAY_KEYS) {
    const proposed = result[key] as unknown[] | undefined;
    if (isRecruiterOwned(base, key) || proposed === undefined || proposed.length === 0) {
      merged[key] = base[key];
      continue;
    }
    merged[key] = proposed;
    origin[key] = 'RESUME_EXTRACTION';
  }
  if (Object.keys(origin).length > 0) merged.array_origin = origin;
  return merged;
}

// Apply a recruiter review save onto the persisted payload (backend-owned field
// authority — I7 / §8.5). The client sends:
//   - the scalar fields it holds; only RECRUITER-origin values are authoritative
//     from the client. A RESUME_EXTRACTION value from the client never replaces
//     the persisted one (the backend owns extraction values — a tab holding an
//     older extraction cannot roll back a newer one);
//   - an array ONLY when the recruiter edited it. A sent array becomes
//     recruiter-owned (origin RECRUITER); an omitted array keeps the persisted
//     value and origin, so a save can never wipe extracted work history,
//     education or certifications.
// Skills and résumé provenance are backend-owned; a client value is used only
// when the draft has none (older clients sent them back verbatim).
export function applyRecruiterReview(existing: unknown, patch: unknown): IntakeReviewPayload {
  const base = asReviewPayload(existing);
  const incoming = asReviewPayload(patch);

  const fields: Record<string, IntakeReviewField> = { ...base.fields };
  for (const [key, cell] of Object.entries(incoming.fields)) {
    if (cell === null || typeof cell !== 'object') continue;
    const current = fields[key];
    if (cell.origin === 'RECRUITER' || current === undefined) {
      fields[key] = {
        value: cell.value ?? null,
        origin: cell.origin === 'RESUME_EXTRACTION' ? 'RESUME_EXTRACTION' : 'RECRUITER',
      };
    }
  }

  const merged: IntakeReviewPayload = {
    fields,
    skills: base.skills ?? incoming.skills,
    resume_provenance: base.resume_provenance ?? incoming.resume_provenance,
  };
  const origin: Partial<Record<ReviewArrayKey, IntakeFieldOrigin>> = { ...base.array_origin };
  for (const key of REVIEW_ARRAY_KEYS) {
    const sent = incoming[key];
    if (sent !== undefined) {
      merged[key] = sent;
      origin[key] = 'RECRUITER';
    } else {
      merged[key] = base[key];
    }
  }
  if (Object.keys(origin).length > 0) merged.array_origin = origin;
  return merged;
}

// D6 — the evidence arrays a Save materializes (the recruiter-editable ones plus
// the backend-owned structured skills).
export const SAVE_EVIDENCE_ARRAY_KEYS = ['work_history', 'skills', 'education', 'certifications'] as const;

// Canonical JSON (object keys sorted at every depth): JSONB does not preserve
// key order, so the hash must not depend on it.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// D6 — SHA-256 over the reviewed evidence arrays. Stamped with a Save's step-1
// materialization; a resumed Save whose current payload hashes differently
// re-materializes (an absent array hashes the same as an empty one).
export function reviewEvidencePayloadHash(review: IntakeReviewPayload): string {
  const arrays = Object.fromEntries(SAVE_EVIDENCE_ARRAY_KEYS.map((k) => [k, review[k] ?? []]));
  return createHash('sha256').update(canonicalJson(arrays)).digest('hex');
}

// D6 — does a merged review save change any persisted VALUE (a scalar field's
// value or a reviewed array)? Origin-only changes and an unchanged autosave do
// not count.
export function reviewValuesChanged(existing: unknown, merged: IntakeReviewPayload): boolean {
  const base = asReviewPayload(existing);
  const keys = new Set([...Object.keys(base.fields), ...Object.keys(merged.fields)]);
  for (const key of keys) {
    if ((base.fields[key]?.value ?? null) !== (merged.fields[key]?.value ?? null)) return true;
  }
  return reviewEvidencePayloadHash(base) !== reviewEvidencePayloadHash(merged);
}

// Governed technical-failure statuses — the extraction ran but produced no
// reviewable result. Distinct from a readable résumé that simply states few
// facts (that is a successful PARTIAL, never FAILED).
const EXTRACTION_FAILURE_STATUSES: ReadonlySet<string> = new Set([
  'provider_truncated',
  'invalid_structured_output',
  'provider_failure',
]);

export interface IntakeExtractionOutcome {
  processing_status: 'READY' | 'PARTIAL' | 'FAILED';
  failure_code?: string;
}

// Map the shared orchestrator result to the intake processing dimension.
export function classifyIntakeOutcome(
  result: DraftFromResumeResponse,
): IntakeExtractionOutcome {
  if (
    result.extraction_status !== undefined &&
    EXTRACTION_FAILURE_STATUSES.has(result.extraction_status)
  ) {
    return { processing_status: 'FAILED', failure_code: result.extraction_status };
  }
  if (result.parse_status === 'failed') {
    return { processing_status: 'FAILED', failure_code: 'RESUME_UNREADABLE' };
  }
  if (result.parse_status === 'partial') {
    return { processing_status: 'PARTIAL' };
  }
  return { processing_status: 'READY' };
}
