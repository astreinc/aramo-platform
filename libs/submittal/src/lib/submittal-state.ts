// SubmittalState — canonical 5-state value tuple + derived type +
// state-machine guard primitive for TalentSubmittalRecord (M5 PR-8b2).
//
// PR-8b1 shipped the M4-name-aware tuple + canTransition primitive as
// substrate-only. PR-8b2 (rename + cutover phase per Q9 split) replaces
// the M4 3-value matrix with the canonical 5-state chain (Group 2
// §2.3b Loop 5) plus the sibling lifecycle-exit `revoked`. F37 closes
// at PR-8b2 merge.
//
// Mainline chain (4 transitions):
//   created -> handoff_draft -> ready_for_review -> submitted_to_ats
//   -> confirmed
//
// Sibling lifecycle-exit (Q3 + Ruling 5): revocable from `created`,
// `handoff_draft`, `ready_for_review`, `submitted_to_ats`. NOT
// revocable from `confirmed` (terminal — ATS confirmation closes the
// workflow lifecycle).
//
// Closed-list discipline (M3 PR-9 + M4 PR-7 + M5 PR-1 precedent):
// exporting a runtime const tuple alongside the Prisma enum lets
// application-layer validators close the list at compile time and at
// runtime. canTransition is the application-layer guard atop the DB
// trigger (defense-in-depth: the trigger would also reject, but the
// guard returns a structured error before the SQL UPDATE attempt).

export const SUBMITTAL_STATE_VALUES = [
  'created',
  'handoff_draft',
  'ready_for_review',
  'submitted_to_ats',
  'confirmed',
  'revoked',
] as const;

export type SubmittalStateValue = (typeof SUBMITTAL_STATE_VALUES)[number];

// Legal transition matrix per M5 PR-8b2 §4.4 + Ruling C1 (sibling-revoke
// enumerated explicitly for symmetry with the DB trigger; single source
// of truth across TS + DB layers). 8 legal moves total:
//
//   Mainline (4):
//     1. created          -> handoff_draft
//     2. handoff_draft    -> ready_for_review
//     3. ready_for_review -> submitted_to_ats   (confirmed_at populated)
//     4. submitted_to_ats -> confirmed
//
//   Sibling-revoke (4; Q3 + Ruling 5):
//     5. created          -> revoked
//     6. handoff_draft    -> revoked
//     7. ready_for_review -> revoked
//     8. submitted_to_ats -> revoked
//
// Terminal states (no outgoing transitions): `confirmed`, `revoked`.
export function canTransition(
  from: SubmittalStateValue,
  to: SubmittalStateValue,
): boolean {
  const ALLOWED: Record<SubmittalStateValue, SubmittalStateValue[]> = {
    created: ['handoff_draft', 'revoked'],
    handoff_draft: ['ready_for_review', 'revoked'],
    ready_for_review: ['submitted_to_ats', 'revoked'],
    submitted_to_ats: ['confirmed', 'revoked'],
    confirmed: [],
    revoked: [],
  };
  return ALLOWED[from]?.includes(to) ?? false;
}
