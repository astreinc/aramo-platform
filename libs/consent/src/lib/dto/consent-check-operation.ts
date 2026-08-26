// Closed enum mirror of openapi/common.yaml ConsentCheckOperation schema (PR-4).
// 8 values, derived from Group 2 §2.7 Enforcement Points table (lines 2374-2382)
// + COMM-B2 `communication` (Aramo-COMM-V1 R-COMM-CONSENT-OP). The OpenAPI schema
// is the source of truth; this TypeScript representation is the program-side
// mirror used in DTOs and resolver code (drift-guarded by the TS↔OpenAPI parity
// test consent-check-operation-parity.spec.ts). Adding a value requires Architect
// approval per doc/02-claude-code-discipline.md Rule 4.
//
// This is the 7th closed enum in the program (joining ConsentScope,
// ConsentDecisionAction, ConsentCapturedMethod, ContactChannel, ErrorCode,
// ConsumerType).

export const CONSENT_CHECK_OPERATIONS = [
  'ingestion',
  'matching',
  'examination',
  'selection',
  'packaging',
  'submittal',
  'cross_tenant',
  'communication',
] as const;

export type ConsentCheckOperation = (typeof CONSENT_CHECK_OPERATIONS)[number];

// Operation→required-scope mapping (Decision C). Locked from §2.7 Enforcement
// Points. This is a constant lookup, not runtime derivation.
export const OPERATION_SCOPE_MAP = {
  ingestion: 'profile_storage',
  matching: 'matching',
  examination: 'matching',
  selection: 'contacting',
  packaging: 'contacting',
  submittal: 'contacting',
  cross_tenant: 'cross_tenant_visibility',
  // COMM-B2 (R-COMM-CONSENT-OP): the voice/communication contactability gate.
  // operation=communication + channel=phone reuses the existing `contacting`
  // machinery; the gate is invoked from apps/api (composition root), never from
  // libs/communications (no communications→consent nx edge).
  communication: 'contacting',
} as const satisfies Record<ConsentCheckOperation, string>;
