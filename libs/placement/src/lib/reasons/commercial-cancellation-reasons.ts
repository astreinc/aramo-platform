// Track 6 / T6-B3 — the closed cancellation-reason vocabulary for
// AssignmentRateVersion cancellation (directive §10). Persisted as TEXT on
// AssignmentRateVersion.cancellation_reason_code — NO Postgres enum, NO
// reason-detail column, NO OTHER. Kept here in @aramo/placement so BOTH the write
// boundary (PlacementRepository) and the HTTP DTO (@RequireScopes controller) draw
// from the SAME source; there is no second list.
//
// Two disjoint classes:
//   user-selectable — the only codes an explicit cancellation API request may carry;
//   reserved-internal — set ONLY by server-side reconciliation, never accepted from
//   a user request. The explicit-cancellation API MUST reject a request carrying a
//   reserved code (§10: "The explicit cancellation API must reject ASSIGNMENT_ENDED").

// The four user-selectable cancellation reasons (§10). Order is presentation-stable.
export const USER_CANCELLATION_REASON_CODES = [
  'SCHEDULE_WITHDRAWN',
  'CLIENT_REQUEST',
  'WORKER_REQUEST',
  'DATA_CORRECTION',
] as const;

export type UserCancellationReasonCode = (typeof USER_CANCELLATION_REASON_CODES)[number];

// The reserved, internal-only reason. Applied by assignment-END reconciliation to
// every future commercial version it cancels (§16.5). NEVER user-supplied.
export const ASSIGNMENT_ENDED_CANCELLATION_REASON = 'ASSIGNMENT_ENDED' as const;

export type CancellationReasonCode =
  | UserCancellationReasonCode
  | typeof ASSIGNMENT_ENDED_CANCELLATION_REASON;

// True only for a code an explicit user cancellation request may carry. The reserved
// ASSIGNMENT_ENDED and any unknown string return false (fail-closed).
export function isUserCancellationReasonCode(value: unknown): value is UserCancellationReasonCode {
  return (
    typeof value === 'string' &&
    (USER_CANCELLATION_REASON_CODES as readonly string[]).includes(value)
  );
}
