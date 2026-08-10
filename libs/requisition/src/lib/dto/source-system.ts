// source_system canonical-key guard — T8 VMS Integration Directive v1.0 §4.
//
// The backend provenance identifier for a VMS-originated requisition. The
// directive rules OUT a closed Postgres enum built from the FE 7-provider
// example list ("that list is not architecture"): a new provider must NOT
// require a DB enum migration. Instead source_system is a VALIDATED, EXTENSIBLE
// canonical string — a stable lowercase provider/source key.
//
// Convention mirrors rate-type.ts / iso-4217-currency.ts: a runtime guard at
// the persistence boundary (not a Prisma enum), stored as TEXT. This module is
// PURE (no @aramo/common dependency, like its dto/ siblings); the throwing
// validator lives in external-identity-validation.ts.
//
// Canonical form is deterministic (trim + lowercase). Determinism is
// load-bearing for the (tenant_id, source_system, external_req_id) idempotency
// invariant: 'Fieldglass' and 'fieldglass' MUST collapse to one key, else the
// same external requisition would bypass the uniqueness index.

export const MAX_SOURCE_SYSTEM_LENGTH = 64;

// Lowercase alphanumeric segments joined by single underscores (e.g. 'manual',
// 'fieldglass', 'workday_vndly'). No leading/trailing/doubled underscore, no
// spaces, punctuation, or uppercase — "no uncontrolled arbitrary display text".
const CANONICAL_SOURCE_SYSTEM_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

// Deterministic canonical representation of a raw source_system string.
export function normalizeSourceSystem(raw: string): string {
  return raw.trim().toLowerCase();
}

// Whether a value is ALREADY a canonical source-system key (post-normalization
// shape check). Callers normalize first, then validate the result.
export function isCanonicalSourceSystemKey(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_SOURCE_SYSTEM_LENGTH &&
    CANONICAL_SOURCE_SYSTEM_RE.test(value)
  );
}
