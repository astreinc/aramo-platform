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

export interface IntakeReviewPayload {
  fields: Record<string, IntakeReviewField>;
  work_history?: unknown[];
  skills?: unknown[];
  education?: unknown[];
  certifications?: unknown[];
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

export function asReviewPayload(value: unknown): IntakeReviewPayload {
  if (value === null || value === undefined || typeof value !== 'object') {
    return emptyIntakeReviewPayload();
  }
  const parsed = value as Partial<IntakeReviewPayload>;
  return {
    fields: parsed.fields ?? {},
    work_history: parsed.work_history,
    skills: parsed.skills,
    education: parsed.education,
    certifications: parsed.certifications,
    resume_provenance: parsed.resume_provenance,
  };
}

// Merge a fresh governed extraction into the persisted review payload WITHOUT
// clobbering recruiter edits. A field already carrying origin RECRUITER is left
// untouched; every other proposed field is (re)written with origin
// RESUME_EXTRACTION. Arrays (work-history/skills/…) are filled from the
// extraction only when the recruiter has not already captured them.
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

  const recruiterTouchedArrays =
    base.work_history !== undefined ||
    base.skills !== undefined ||
    base.education !== undefined ||
    base.certifications !== undefined;

  return {
    fields: mergedFields,
    work_history: recruiterTouchedArrays ? base.work_history : result.work_history,
    skills: recruiterTouchedArrays ? base.skills : result.skills,
    education: recruiterTouchedArrays ? base.education : result.education,
    certifications: recruiterTouchedArrays ? base.certifications : result.certifications,
    resume_provenance: {
      source_map_version: result.source_map_version,
      resume_text_hash: result.resume_text_hash,
    },
  };
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
