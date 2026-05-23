// Closed subset of the locked 36-code error registry (API Contracts Phase 5).
// Drawn incrementally; adding a new code requires Architect approval per
// doc/02-claude-code-discipline.md Rule 4.
//
// This list MUST stay in sync with the ErrorCode enum in openapi/common.yaml.
// The CI gate `error-codes:check` (currently a placeholder) will enforce
// equality once it is wired in a later PR.
//
// INTERNAL_ERROR is the registry's catch-all for unexpected 5xx server
// failures (Phase 5 "System & Processing" category, aramo-API-contract.md
// line 1372). It is the default code emitted by AramoExceptionFilter for
// 5xx HttpExceptions and for any unhandled Error.
//
// PR-3.2 adds INVALID_SCOPE_COMBINATION (HTTP 422) for consent scope
// dependency violations on /consent/check (PR-4).
//
// PR-8.0a-Reground adds TENANT_SELECTION_REQUIRED (HTTP 409) for /callback
// when a user has >1 active membership, and REFRESH_TOKEN_INVALID (HTTP 401)
// for /refresh failures (cookie missing, token expired/revoked, consumer
// mismatch, reuse detected, rotation race). Total: 9 codes.
//
// M3 PR-8 adds INVALID_REQUEST (HTTP 400) for malformed match-list request
// input (job_id UUID, limit, cursor) and INSUFFICIENT_PERMISSIONS (HTTP
// 403) for per-route consumer_type checks on the recruiter-facing
// match-list endpoint. Both codes are named explicitly in the M3 PR-8
// directive §4.1 (matching the API Contracts error catalogue); Lead
// authority is the §2 Lead engineering basis. Total: 11 codes.
//
// M3 PR-9 adds NOT_FOUND (HTTP 404) for the portal self-profile endpoint
// when the talent has no per-tenant overlay (i.e., they exist as a Talent
// but are not associated with the JWT's tenant). M3 PR-9 directive §4.5
// authorizes the addition (matching the API Contracts error catalogue);
// Lead authority is the directive's §2 Ruling 3 (refusal verification —
// not-found vs. data leakage is the security-posture choice that
// PortalController makes). Total: 12 codes.
//
// M4 PR-2 adds SUBMITTAL_STRETCH_BLOCKED (HTTP 422) for the evidence-
// package builder's Stretch-tier refusal (R9 enforcement at the substrate
// layer per Plan v1.5 §M4 Track A item 4). Per Aramo-M4-PR-2-Directive-
// v1_0-LOCKED.md §4.3 the code registers at builder construction. The
// ErrorCode enum in openapi/common.yaml gets the matching value addition
// for tuple/yaml parity (the closed-list parity test in libs/common/src/
// tests/error-codes.spec.ts enforces this); no UnprocessableEntity
// response component is added at PR-2 — the consuming endpoint PR (F33
// submittal-create) adds that component when the endpoint emits the
// code. Lead authority is the directive's §2 Ruling 4 (Stretch-blocking
// lives in the builder). Total: 13 codes.
//
// M4 PR-3 adds JUSTIFICATION_REQUIRED (HTTP 422) for the future
// submittal-confirm endpoint (F34) enforcement of Worth Considering
// submittals (per Plan v1.5 §M4 Track B item 4 + Exit Criteria: "Worth
// Considering submittal requires justification text + failed criteria
// acknowledgment"). Per Aramo-M4-PR-3-Directive-v1_0-LOCKED.md §4.5 the
// code is pre-registered at PR-3 (the same pattern as
// SUBMITTAL_STRETCH_BLOCKED was pre-registered at PR-2) to avoid
// contention at the consuming PR. PR-3's create endpoint accepts
// `justification` + `failed_criterion_acknowledgments` as optional
// fields and persists them verbatim; it does NOT enforce. F34 enforces:
// missing on Worth Considering returns 422 JUSTIFICATION_REQUIRED. Lead
// authority is the directive's §2 Ruling 5. Total: 14 codes.

export const ERROR_CODES = [
  'AUTH_REQUIRED',
  'INVALID_TOKEN',
  'TENANT_ACCESS_DENIED',
  'VALIDATION_ERROR',
  'IDEMPOTENCY_KEY_CONFLICT',
  'INTERNAL_ERROR',
  'INVALID_SCOPE_COMBINATION',
  'TENANT_SELECTION_REQUIRED',
  'REFRESH_TOKEN_INVALID',
  'INVALID_REQUEST',
  'INSUFFICIENT_PERMISSIONS',
  'NOT_FOUND',
  'SUBMITTAL_STRETCH_BLOCKED',
  'JUSTIFICATION_REQUIRED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
