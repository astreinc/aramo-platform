// Closed enum mirror of openapi/common.yaml ConsentCheckOperation schema (PR-4).
// 7 values, derived from Group 2 §2.7 Enforcement Points table (lines 2374-2382).
// The OpenAPI schema is the source of truth; this TypeScript representation
// is the program-side mirror used in DTOs and resolver code. Adding a value
// requires Architect approval per doc/02-claude-code-discipline.md Rule 4.
//
// This is the 7th closed enum in the program (joining ConsentScope,
// ConsentDecisionAction, ConsentCapturedMethod, ContactChannel, ErrorCode,
// ConsumerType).

export const CONSENT_CHECK_OPERATIONS = [
  'ingestion',
  'matching',
  'examination',
  'engagement',
  'packaging',
  'submittal',
  'cross_tenant',
] as const;

export type ConsentCheckOperation = (typeof CONSENT_CHECK_OPERATIONS)[number];

// Operation→required-scope mapping (Decision C). Locked from §2.7 Enforcement
// Points. This is a constant lookup, not runtime derivation.
export const OPERATION_SCOPE_MAP = {
  ingestion: 'profile_storage',
  matching: 'matching',
  examination: 'matching',
  engagement: 'contacting',
  packaging: 'contacting',
  submittal: 'contacting',
  cross_tenant: 'cross_tenant_visibility',
} as const satisfies Record<ConsentCheckOperation, string>;
