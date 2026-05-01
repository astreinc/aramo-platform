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
// dependency violations on /consent/check (PR-4). Total: 7 codes.

export const ERROR_CODES = [
  'AUTH_REQUIRED',
  'INVALID_TOKEN',
  'TENANT_ACCESS_DENIED',
  'VALIDATION_ERROR',
  'IDEMPOTENCY_KEY_CONFLICT',
  'INTERNAL_ERROR',
  'INVALID_SCOPE_COMBINATION',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
