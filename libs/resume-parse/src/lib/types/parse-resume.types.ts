// Résumé draft prefill types — the recruiter-facing prefill + status shape.
//
// Governed LLM is the SOLE production résumé fact extractor (…-TI-1F-…-v1_0-
// LOCKED §4-D); the governed orchestrator (libs/talent-record) builds a
// TalentRecordPrefill + ParseStatus from its grounded proposal. The shape
// mirrors the structurally-relevant subset of CreateTalentRecordRequestDto and
// is defined locally to keep libs/resume-parse free of a back-edge into
// talent-record. The controller passes the prefill to the recruiter, who
// reviews + commits via the existing POST /v1/talent-records.

/**
 * The recruiter-facing prefill. Every field is optional; unparseable
 * fields are simply absent (NOT empty strings -- preserves the DTO's
 * optionality on the consumer side). The recruiter reviews + corrects;
 * the prefill is convenience, not authority.
 */
export interface TalentRecordPrefill {
  first_name?: string;
  last_name?: string;
  email1?: string;
  email2?: string;
  phone_home?: string;
  phone_cell?: string;
  phone_work?: string;
  address?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  key_skills?: string;
  current_employer?: string;
  web_site?: string;
  // B1 — professional title (most-recent role). Optional; the extractor
  // proposes it only when a role line is confidently isolated (never a noisy
  // guess). Absent otherwise; the recruiter fills it on review.
  title?: string;
  // The governed extractor may propose country (grounded). Optional — additive,
  // backward-compatible.
  country?: string;
}

/**
 * The parse-status reported back to the recruiter:
 *   - `parsed` — the governed extraction produced at least the minimal
 *                identity set (a name).
 *   - `partial` — extraction ran but did not yield the minimal identity set
 *                 (or a technical extraction failure); the recruiter fills the
 *                 gaps.
 *   - `failed` — text-extraction itself failed (encrypted PDF, corrupt file,
 *                unsupported format) or governed extraction could not run. The
 *                recruiter creates the TalentRecord manually with an empty prefill.
 *
 * NOTE: `failed` is NOT a 5xx outcome. draft-from-resume returns 200 with
 * `{ prefill: {}, parse_status: 'failed' }`; the create flow continues
 * (parse-failure is non-blocking).
 */
export type ParseStatus = 'parsed' | 'partial' | 'failed';

export interface ParseResumeInput {
  storage_key: string;
  requestId: string;
}
