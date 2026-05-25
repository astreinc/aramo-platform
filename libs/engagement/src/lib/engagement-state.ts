// EngagementState — closed-list runtime const tuple + derived type +
// state-machine guard primitive for TalentJobEngagement (M5 PR-1).
//
// Per M5 PR-1 Directive Amendment v1.1 §2 (11-state enum verbatim Group
// 2 §2.3b Part 2 Loops 1-5) and §4 (canTransition 11x11 matrix, 10
// legal transitions). Both supersede Directive v1.0 Rulings 4 and 7.
//
// Closed-list discipline (M3 PR-9 + M4 PR-7 precedent): exporting a
// runtime const tuple alongside the Prisma enum lets application-layer
// validators close the list at compile time and at runtime.
//
// canTransition is a pure function placed in the entity's lib rather
// than libs/common per Directive v1.0 Ruling 7 (single-change-
// discipline). HTTP-bound state-transition enforcement is M5 PR-4
// territory; PR-1 ships the primitive only.

export const ENGAGEMENT_STATE_VALUES = [
  'surfaced',
  'evaluated',
  'engaged',
  'maybe',
  'passed',
  'awaiting_response',
  'responded',
  'in_conversation',
  'not_interested',
  'ready_for_submittal',
  'submitted',
] as const;

export type EngagementStateValue = (typeof ENGAGEMENT_STATE_VALUES)[number];

// Legal transition matrix per Group 2 §2.3b Part 2 Loops 1-5
// (Amendment v1.1 §3 / §4). 10 legal transitions; terminal states
// `maybe`, `passed`, `not_interested`, `submitted` have empty arrays.
//
//   1. surfaced            -> evaluated                          (Loop 1 + Loop 2 source)
//   2. evaluated           -> engaged                            (Loop 2 branch)
//   3. evaluated           -> maybe                              (Loop 2 branch)
//   4. evaluated           -> passed                             (Loop 2 branch)
//   5. engaged             -> awaiting_response                  (Loop 3)
//   6. awaiting_response   -> responded                          (Loop 4)
//   7. responded           -> in_conversation                    (Loop 4)
//   8. in_conversation     -> not_interested                     (Loop 4 branch)
//   9. in_conversation     -> ready_for_submittal                (Loop 4 branch)
//  10. ready_for_submittal -> submitted                          (Loop 5 TalentJobEngagement)
export function canTransition(
  from: EngagementStateValue,
  to: EngagementStateValue,
): boolean {
  const ALLOWED: Record<EngagementStateValue, EngagementStateValue[]> = {
    surfaced: ['evaluated'],
    evaluated: ['engaged', 'maybe', 'passed'],
    engaged: ['awaiting_response'],
    maybe: [],
    passed: [],
    awaiting_response: ['responded'],
    responded: ['in_conversation'],
    in_conversation: ['not_interested', 'ready_for_submittal'],
    not_interested: [],
    ready_for_submittal: ['submitted'],
    submitted: [],
  };
  return ALLOWED[from]?.includes(to) ?? false;
}
