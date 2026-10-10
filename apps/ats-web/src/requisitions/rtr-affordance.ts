import type { BoardCardView } from './requisition-talent-board-api';

// Requisition Talent (in play / Talent tab) — the ONE shared Send-RTR affordance
// mapping, used verbatim by the List (RTR column) and the Board (chip row) so the
// two surfaces agree. This is PRESENTATION composed from already-authoritative
// facts — the pipeline stage (owner / owner_state) and the Board's RTR chip
// (rtr_status), which carries the canonical three-way effective requirement. It
// adds NO readiness authority and is NEVER a mutation: "Send RTR" opens the governed
// Documents/RTR request→send lifecycle, which stays the mutation authority and
// re-authorizes server-side.
//
//   rtr_status === null ('UNGOVERNED', requirement unspecified) → 'hidden'   render nothing
//   rtr_status === 'NOT_REQUIRED' (policy EXPLICITLY relaxed)    → 'none'     "Not required"
//   rtr_status === 'CONFIRMED'                                   → 'signed'   "✓ Signed" + View
//   rtr_status === 'SENT'                                        → 'awaiting' "Awaiting signature" + reminder
//   rtr_status === 'NOT_SENT' (required, not sent):
//     no_contact / contacted (pre-responded)                     → 'due'      "Due before qualifying" (muted)
//     talent_responded / qualifying / qualified …                → 'send'     "Send RTR" (actionable)
//
// CRITICAL (canonical UNGOVERNED ≠ NOT_REQUIRED): only an EXPLICIT NOT_REQUIRED earns the
// affirmative "Not required" statement; an ungoverned/unspecified requisition (null) renders
// NOTHING ('hidden') — never an affirmative "Not required" claim. NOT_SENT = required-not-sent.

export type RtrAffordanceKind = 'hidden' | 'none' | 'due' | 'send' | 'awaiting' | 'signed';

// Recruiting stages that are still PRE-responded — RTR is due but not yet
// actionable (the talent must respond first). Everything at/after talent_responded
// is actionable when RTR is required and nothing has been sent.
const PRE_RESPONDED_STATES: ReadonlySet<string> = new Set(['no_contact', 'contacted']);

export function rtrAffordanceKind(
  card: Pick<BoardCardView, 'rtr_status' | 'owner' | 'owner_state'>,
): RtrAffordanceKind {
  const status = card.rtr_status;
  if (status === null) return 'hidden'; // UNGOVERNED — requirement unspecified → no chip
  if (status === 'NOT_REQUIRED') return 'none'; // EXPLICITLY relaxed → "Not required"
  if (status === 'CONFIRMED') return 'signed';
  if (status === 'SENT') return 'awaiting';
  // status === 'NOT_SENT' — required but nothing sent to the talent yet.
  if (card.owner === 'pipeline' && PRE_RESPONDED_STATES.has(card.owner_state)) return 'due';
  return 'send';
}
