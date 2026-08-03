// Closed-registry value tuples + type-guards for ClientTalentRestriction
// (Track 3 / E7). Const-plus-type-guard precedent: VALID_OVERRIDE_TYPES
// (libs/examination). Every list is closed at compile time and at runtime.
//
// These mirror the Prisma enums in prisma/schema.prisma. An out-of-list
// value must surface as the E7-mandated domain refusal at the controller
// boundary, NOT as a generic class-validator 400 — so the guards are used
// for the load-bearing R10 tripwires (restriction_type especially).

// RestrictionType — FIXED by ADR-0027 §4. A fifth value requires an ADR
// amendment (E7 §6). This is the R10-load-bearing closed registry.
export const RESTRICTION_TYPE_VALUES = [
  'CLIENT_DO_NOT_RESUBMIT',
  'CLIENT_NOT_ELIGIBLE_FOR_REENGAGEMENT',
  'CLIENT_SITE_ACCESS_RESTRICTED',
  'VMS_SUBMITTAL_RESTRICTED',
] as const;
export type RestrictionTypeValue = (typeof RESTRICTION_TYPE_VALUES)[number];
export function isRestrictionType(v: unknown): v is RestrictionTypeValue {
  return typeof v === 'string' && (RESTRICTION_TYPE_VALUES as readonly string[]).includes(v);
}

// AssertedByType — WHO made the external assertion (§3b correction 1).
export const ASSERTED_BY_TYPE_VALUES = [
  'CLIENT',
  'MSP',
  'VMS',
  'CLIENT_LEGAL_COMPLIANCE',
] as const;
export type AssertedByTypeValue = (typeof ASSERTED_BY_TYPE_VALUES)[number];
export function isAssertedByType(v: unknown): v is AssertedByTypeValue {
  return typeof v === 'string' && (ASSERTED_BY_TYPE_VALUES as readonly string[]).includes(v);
}

// SourceSystem — the CHANNEL the assertion (or closure) arrived through
// (§3b correction 1). NOT the asserter.
export const SOURCE_SYSTEM_VALUES = [
  'FIELDGLASS',
  'BEELINE',
  'WORKDAY_VNDLY',
  'COUPA',
  'ORACLE',
  'CLIENT_EMAIL',
  'CLIENT_PORTAL',
  'MANUAL_TRANSCRIPTION',
] as const;
export type SourceSystemValue = (typeof SOURCE_SYSTEM_VALUES)[number];
export function isSourceSystem(v: unknown): v is SourceSystemValue {
  return typeof v === 'string' && (SOURCE_SYSTEM_VALUES as readonly string[]).includes(v);
}

// CloseReasonCode — closed registry for WHY a restriction was explicitly
// closed early (§3b correction 3). Value set flagged for Lead ratification
// (the directive left it unspecified).
export const CLOSE_REASON_CODE_VALUES = [
  'CLIENT_WITHDRAWN',
  'CLIENT_RESCINDED',
  'SUPERSEDED_BY_NEW_ASSERTION',
  'RECORDED_IN_ERROR',
] as const;
export type CloseReasonCodeValue = (typeof CLOSE_REASON_CODE_VALUES)[number];
export function isCloseReasonCode(v: unknown): v is CloseReasonCodeValue {
  return typeof v === 'string' && (CLOSE_REASON_CODE_VALUES as readonly string[]).includes(v);
}

// Governed source_reference (§3b correction 2). REQUIRED at every layer,
// and NEVER free narrative text: the reference must lead to, or identify,
// the source evidence. Structural governance: an uppercase governed token,
// a colon, then a non-empty reference body — e.g. `CLIENT_EMAIL:<message-id>`,
// `CLIENT_CALL:<activity-id>`, `MANUAL_NOTICE:<external-fact-record-id>`,
// `FIELDGLASS:<vms-record-id>`. `source_reference = "client told me"` is
// rejected (lowercase, no governed prefix, no colon).
const GOVERNED_SOURCE_REFERENCE = /^[A-Z][A-Z0-9_]{1,63}:\S.{0,510}$/;
export function isGovernedSourceReference(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const trimmed = v.trim();
  return trimmed.length > 0 && trimmed.length <= 576 && GOVERNED_SOURCE_REFERENCE.test(trimmed);
}
