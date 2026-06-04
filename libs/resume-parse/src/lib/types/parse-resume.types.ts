// A8-3b — résumé parse-to-prefill types.
//
// The shape mirrors the structurally-relevant subset of
// CreateTalentRecordRequestDto (libs/talent-record). Defining it locally
// keeps libs/resume-parse free of a back-edge into talent-record (the
// E2 controller LIVES in talent-record and imports this lib; if this
// lib imported talent-record, that would be a cycle). The talent-record
// controller passes the prefill through to the recruiter, who reviews
// + commits via the existing POST /v1/talent-records.

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
}

/**
 * The parse-status reported back to the recruiter:
 *   - `parsed` — the parser extracted at least the minimal identity set
 *                (a name AND a contact-channel email or phone).
 *   - `partial` — text-extraction succeeded but the heuristics extracted
 *                 some fields but not the minimal identity set. The
 *                 recruiter fills the gaps.
 *   - `failed` — text-extraction itself failed (encrypted PDF, corrupt
 *                file, unsupported format). The recruiter creates the
 *                TalentRecord manually with an empty prefill.
 *
 * NOTE: `failed` is NOT a 5xx outcome. The E2 endpoint returns 200 with
 * `{ prefill: {}, parse_status: 'failed' }`; the create flow continues.
 * This is the "parse-failure is non-blocking" semantic (the directive
 * §3 framing, the proof §4.4).
 */
export type ParseStatus = 'parsed' | 'partial' | 'failed';

export interface ParseResumeInput {
  storage_key: string;
  requestId: string;
}

export interface ParseResumeResult {
  prefill: TalentRecordPrefill;
  parse_status: ParseStatus;
}
