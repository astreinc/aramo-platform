// SubmittalState — closed-list runtime const tuple + derived type +
// state-machine guard primitive for TalentSubmittalRecord (M5 PR-8b1).
//
// Per Lead-Rulings Brief v1.0 §10 Q9 split + PR-8b1 Directive §4.4:
// PR-8b1 ships the M4-name-aware tuple + canTransition primitive as
// substrate-only. PR-8b2 will replace this matrix with the canonical
// 5-state (Group 2 §2.3b Loop 5) chain at the rename + cutover phase.
//
// PR-8b1 substrate-only discipline (Lead-Q-PR-8b1-B1 = Option a):
// canTransition is exported but NOT yet wired into submittal.repository
// .ts methods. M4 endpoints (/confirm, /revoke) continue to enforce
// transitions via the DB-trigger layer only. PR-8b2 wires canTransition
// into repository methods at the rename phase.
//
// Closed-list discipline (M3 PR-9 + M4 PR-7 + M5 PR-1 precedent):
// exporting a runtime const tuple alongside the Prisma enum lets
// application-layer validators close the list at compile time and at
// runtime.

export const SUBMITTAL_STATE_VALUES = [
  'draft',
  'submitted',
  'revoked',
] as const;

export type SubmittalStateValue = (typeof SUBMITTAL_STATE_VALUES)[number];

// Legal transition matrix per M4 PR-3 + PR-4 + PR-7 substrate. Two
// legal transitions; terminal state `revoked` has an empty array.
//
//   1. draft     -> submitted  (M4 PR-4 /confirm endpoint; Transition A)
//   2. submitted -> revoked    (M4 PR-7 /revoke endpoint; Transition B)
//
// PR-8b2 will replace this matrix with the canonical 5-state Group 2
// §2.3b Loop 5 chain: created -> handoff_draft -> ready_for_review ->
// submitted_to_ats -> confirmed (plus revoked as sibling lifecycle).
export function canTransition(
  from: SubmittalStateValue,
  to: SubmittalStateValue,
): boolean {
  const ALLOWED: Record<SubmittalStateValue, SubmittalStateValue[]> = {
    draft: ['submitted'],
    submitted: ['revoked'],
    revoked: [],
  };
  return ALLOWED[from]?.includes(to) ?? false;
}
