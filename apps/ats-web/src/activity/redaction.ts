import { formatDate } from '../format/date';

import type { ActivityView } from './types';

// FE mirror of the BE closed vocabulary (libs/activity redaction-reason.ts).
// apps/ats-web cannot import @aramo/activity (a forbidden domain edge), so the
// list is hand-mirrored 1:1 and a drift guard (redaction-drift.spec.ts) reads
// the BE source and fails if the two ever diverge.
export const REDACTION_REASON_CODES = [
  'CONTAINED_SENSITIVE_DATA',
  'FACTUALLY_INCORRECT',
  'ENTERED_IN_ERROR',
  'LEGAL_OR_COMPLIANCE_REQUEST',
] as const;

export type RedactionReasonCode = (typeof REDACTION_REASON_CODES)[number];

// redacted_at is the predicate (Charter §4 Amendment §2). `!= null` treats both
// null and a missing field as not-redacted (defensive against partial shapes).
export function isRedacted(a: ActivityView): boolean {
  return a.redacted_at != null;
}

// The ONLY thing a redacted note renders: attribution + date. Never the reason
// free text (§8), never an empty row. `byName` is the resolved actor name where
// the surface can resolve redacted_by; a generic actor is used otherwise.
export function redactedNoteLabel(
  redactedAt: string | null,
  byName: string | null,
): string {
  const who = byName !== null && byName !== '' ? byName : 'a user';
  const when = redactedAt !== null ? formatDate(redactedAt) : '';
  return when === ''
    ? `Note removed by ${who}`
    : `Note removed by ${who} on ${when}`;
}
