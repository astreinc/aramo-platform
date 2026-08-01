// Charter §4 Amendment — Activity Redaction Fields v1.0 LOCKED §3.
// Closed vocabulary for `redaction_reason_code`. String + membership check —
// NOT a Prisma enum (§4 pattern rule 1). The FE mirrors this list 1:1, guarded
// by a drift test (§4 pattern rule 5).
export const REDACTION_REASON_CODES = [
  'CONTAINED_SENSITIVE_DATA',
  'FACTUALLY_INCORRECT',
  'ENTERED_IN_ERROR',
  'LEGAL_OR_COMPLIANCE_REQUEST',
] as const;

export type RedactionReasonCode = (typeof REDACTION_REASON_CODES)[number];

export function isRedactionReasonCode(v: unknown): v is RedactionReasonCode {
  return (
    typeof v === 'string' &&
    (REDACTION_REASON_CODES as readonly string[]).includes(v)
  );
}
