// Closed enum mirror of openapi/common.yaml ConsentScopeStatus schema (PR-5).
// 4 values, derived state per scope (distinct from ConsentDecisionAction
// which represents the action recorded on a write event). The OpenAPI
// schema is the source of truth; this TypeScript representation is the
// program-side mirror used in DTOs and resolver code. Adding a value
// requires Architect approval per doc/02-claude-code-discipline.md Rule 4.
//
// This is the 8th closed enum in the program (joining ConsentScope,
// ConsentDecisionAction, ConsentCapturedMethod, ContactChannel, ErrorCode,
// ConsumerType, ConsentCheckOperation).
//
// `no_grant` is unique to derivation — there is no TalentConsentEvent with
// action: "no_grant". This is why ConsentScopeStatus is a separate enum
// from ConsentDecisionAction, not a superset.

export const CONSENT_SCOPE_STATUSES = [
  'granted',
  'revoked',
  'expired',
  'no_grant',
] as const;

export type ConsentScopeStatus = (typeof CONSENT_SCOPE_STATUSES)[number];
