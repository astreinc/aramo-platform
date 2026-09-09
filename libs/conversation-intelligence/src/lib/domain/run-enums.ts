// CI-B6 — processing-run + claim status vocabularies (mirror the Prisma enums).

/** Processing lifecycle (directive §20). `completed` == READY_FOR_REVIEW (B7). */
export const CI_RUN_STATUSES = [
  'queued',
  'processing',
  'completed',
  'failed_retryable',
  'intervention_required',
  'failed_terminal',
  'blocked_not_authorized',
] as const;
export type ConversationIntelligenceRunStatus = (typeof CI_RUN_STATUSES)[number];

/**
 * Terminal (immutable) states — no further transition, DB-trigger enforced.
 * `blocked_not_authorized` is NOT here: it is operational and re-drivable (if
 * ai_processing consent later flips to allowed, the same run may re-attempt).
 * Only `completed` (successful evidence) and `failed_terminal` are immutable.
 */
export const CI_RUN_TERMINAL_STATUSES: readonly ConversationIntelligenceRunStatus[] = [
  'completed',
  'failed_terminal',
];

/**
 * AI-claim evidence status (directive §14 vocabulary, verbatim). Describes what
 * the CONVERSATION shows — NEVER a hiring judgment or ordering.
 */
export const CI_CLAIM_STATUSES = [
  'SUPPORTED_BY_STATEMENT',
  'PARTIALLY_SUPPORTED',
  'DISCUSSED_UNCLEAR',
  'NOT_DISCUSSED',
  'CONTRADICTED',
] as const;
export type ConversationIntelligenceClaimStatus = (typeof CI_CLAIM_STATUSES)[number];

/**
 * Statuses that assert something WAS said → require ≥1 valid transcript citation
 * (directive §14 "a material claim without transcript evidence is invalid").
 */
export const CI_CLAIM_STATUSES_REQUIRING_CITATION: readonly ConversationIntelligenceClaimStatus[] =
  ['SUPPORTED_BY_STATEMENT', 'PARTIALLY_SUPPORTED', 'DISCUSSED_UNCLEAR', 'CONTRADICTED'];

/** NOT_DISCUSSED asserts ABSENCE of a statement → MUST carry no citation. */
export const CI_CLAIM_STATUS_FORBIDS_CITATION: readonly ConversationIntelligenceClaimStatus[] =
  ['NOT_DISCUSSED'];
