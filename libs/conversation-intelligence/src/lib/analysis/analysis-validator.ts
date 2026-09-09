// CI-B6 — strict structured-output validator (directive §12/§15/§17). Rejects
// anything that is not exactly the analysis.v1 contract. The ALLOWLIST posture
// means any extra key (a numeric-ordering / fit / recommendation / confidence
// field a model might volunteer) is refused as a schema mismatch — this module
// never has to name those banned concepts. Also enforces the material-claim
// citation rule and refuses protected-trait content. Detail strings are
// structural only (index/field) — never model content.

import {
  CI_CLAIM_STATUSES,
  CI_CLAIM_STATUSES_REQUIRING_CITATION,
  CI_CLAIM_STATUS_FORBIDS_CITATION,
  type ConversationIntelligenceClaimStatus,
} from '../domain/run-enums.js';
import { CI_PROCESSING_ERROR_CODES, CiAnalysisValidationError } from '../domain/errors.js';

import {
  ANALYSIS_ALLOWED_CITATION_KEYS,
  ANALYSIS_ALLOWED_CLAIM_KEYS,
  ANALYSIS_ALLOWED_DRAFT_KEYS,
  ANALYSIS_ALLOWED_DRAFT_SECTION_KEYS,
  ANALYSIS_ALLOWED_TOP_KEYS,
  CI_ANALYSIS_SCHEMA_VERSION,
  PROTECTED_TRAIT_MARKERS,
  type AnalysisResultV1,
} from './analysis-schema.js';

function mismatch(detail: string): never {
  throw new CiAnalysisValidationError(CI_PROCESSING_ERROR_CODES.MODEL_OUTPUT_SCHEMA_MISMATCH, detail);
}
function invalid(detail: string): never {
  throw new CiAnalysisValidationError(CI_PROCESSING_ERROR_CODES.MODEL_OUTPUT_INVALID, detail);
}

function assertKeysSubset(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) mismatch(`${where} has forbidden key`);
  }
}

const STATUS_SET = new Set<string>(CI_CLAIM_STATUSES);
const REQUIRES_CITATION = new Set<string>(CI_CLAIM_STATUSES_REQUIRING_CITATION);
const FORBIDS_CITATION = new Set<string>(CI_CLAIM_STATUS_FORBIDS_CITATION);

function containsProtectedTrait(text: string): boolean {
  const lower = text.toLowerCase();
  return PROTECTED_TRAIT_MARKERS.some((m) => lower.includes(m));
}

/**
 * Validate + narrow a raw model result to {@link AnalysisResultV1}. Throws
 * {@link CiAnalysisValidationError} (MODEL_OUTPUT_INVALID / MODEL_OUTPUT_SCHEMA_MISMATCH).
 */
export function validateAnalysisResult(raw: unknown): AnalysisResultV1 {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) invalid('result is not an object');
  const root = raw as Record<string, unknown>;
  assertKeysSubset(root, ANALYSIS_ALLOWED_TOP_KEYS, 'result');

  if (root['schema_version'] !== CI_ANALYSIS_SCHEMA_VERSION) mismatch('schema_version mismatch');
  if (!Array.isArray(root['claims'])) mismatch('claims must be an array');

  const claims = root['claims'] as unknown[];
  claims.forEach((c, i) => validateClaim(c, i));

  const draft = root['draft'];
  if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) mismatch('draft must be an object');
  const draftObj = draft as Record<string, unknown>;
  assertKeysSubset(draftObj, ANALYSIS_ALLOWED_DRAFT_KEYS, 'draft');
  if (!Array.isArray(draftObj['sections'])) mismatch('draft.sections must be an array');
  (draftObj['sections'] as unknown[]).forEach((s, i) => {
    if (s === null || typeof s !== 'object' || Array.isArray(s)) mismatch(`draft.sections[${i}] not object`);
    const sec = s as Record<string, unknown>;
    assertKeysSubset(sec, ANALYSIS_ALLOWED_DRAFT_SECTION_KEYS, `draft.sections[${i}]`);
    if (typeof sec['key'] !== 'string') mismatch(`draft.sections[${i}].key not string`);
    if (!Array.isArray(sec['items']) || (sec['items'] as unknown[]).some((it) => typeof it !== 'string')) {
      mismatch(`draft.sections[${i}].items not string[]`);
    }
  });

  return raw as AnalysisResultV1;
}

function validateClaim(c: unknown, i: number): void {
  if (c === null || typeof c !== 'object' || Array.isArray(c)) mismatch(`claims[${i}] not object`);
  const claim = c as Record<string, unknown>;
  assertKeysSubset(claim, ANALYSIS_ALLOWED_CLAIM_KEYS, `claims[${i}]`);

  if (typeof claim['claim_type'] !== 'string' || (claim['claim_type'] as string).length === 0) {
    mismatch(`claims[${i}].claim_type missing`);
  }
  if (typeof claim['statement'] !== 'string' || (claim['statement'] as string).length === 0) {
    mismatch(`claims[${i}].statement missing`);
  }
  const status = claim['status'];
  if (typeof status !== 'string' || !STATUS_SET.has(status)) mismatch(`claims[${i}].status invalid`);
  if (claim['context_ref'] !== undefined && typeof claim['context_ref'] !== 'string') {
    mismatch(`claims[${i}].context_ref not string`);
  }
  if (!Array.isArray(claim['citations'])) mismatch(`claims[${i}].citations must be an array`);
  const citations = claim['citations'] as unknown[];

  // Protected-trait refusal (directive §17): reject a claim asserting one.
  if (containsProtectedTrait(claim['claim_type'] as string) || containsProtectedTrait(claim['statement'] as string)) {
    mismatch(`claims[${i}] asserts a protected/sensitive attribute`);
  }

  // Material-claim citation rule (directive §14).
  if (REQUIRES_CITATION.has(status as ConversationIntelligenceClaimStatus) && citations.length === 0) {
    throw new CiAnalysisValidationError(CI_PROCESSING_ERROR_CODES.CITATION_INVALID, `claims[${i}] material claim without citation`);
  }
  if (FORBIDS_CITATION.has(status as ConversationIntelligenceClaimStatus) && citations.length > 0) {
    mismatch(`claims[${i}] NOT_DISCUSSED must carry no citation`);
  }

  citations.forEach((cit, j) => {
    if (cit === null || typeof cit !== 'object' || Array.isArray(cit)) mismatch(`claims[${i}].citations[${j}] not object`);
    const c2 = cit as Record<string, unknown>;
    assertKeysSubset(c2, ANALYSIS_ALLOWED_CITATION_KEYS, `claims[${i}].citations[${j}]`);
    if (typeof c2['utterance_id'] !== 'string' || (c2['utterance_id'] as string).length === 0) {
      mismatch(`claims[${i}].citations[${j}].utterance_id missing`);
    }
    if (typeof c2['quote'] !== 'string') mismatch(`claims[${i}].citations[${j}].quote missing`);
    for (const off of ['start_offset', 'end_offset'] as const) {
      if (c2[off] !== undefined && (typeof c2[off] !== 'number' || !Number.isInteger(c2[off]) || (c2[off] as number) < 0)) {
        mismatch(`claims[${i}].citations[${j}].${off} invalid`);
      }
    }
  });
}
