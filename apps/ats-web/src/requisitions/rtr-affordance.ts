import type { BoardCardView } from './requisition-talent-board-api';

// Requisition Talent (in play / Talent tab) — the ONE shared Send-RTR affordance
// mapping, used verbatim by the List (RTR column) and the Board (chip row) so the
// two surfaces agree. This is PRESENTATION composed from already-authoritative
// facts — the pipeline stage (owner / owner_state) and the Board's 3-state RTR
// signing status (rtr_status). It adds NO readiness authority and is NEVER a
// mutation: "Send RTR" opens the governed Documents/RTR request→send lifecycle,
// which stays the mutation authority and re-authorizes server-side.
//
//   rtr_status === null (RTR not required)           → 'none'      "Not required"
//   rtr_status === 'CONFIRMED'                        → 'signed'    "✓ Signed" + View
//   rtr_status === 'SENT'                             → 'awaiting'  "Awaiting signature" + reminder
//   rtr_status === 'NOT_SENT' (required, not sent):
//     no_contact / contacted (pre-responded)          → 'due'       "Due before qualifying" (muted)
//     talent_responded / qualifying / qualified …     → 'send'      "Send RTR" (actionable)
//
// CRITICAL: getCurrentRtr()===null alone cannot tell not-required from not-requested;
// the Board's rtr_status does (null = not required vs NOT_SENT = required-not-sent).

export type RtrAffordanceKind = 'none' | 'due' | 'send' | 'awaiting' | 'signed';

// Recruiting stages that are still PRE-responded — RTR is due but not yet
// actionable (the talent must respond first). Everything at/after talent_responded
// is actionable when RTR is required and nothing has been sent.
const PRE_RESPONDED_STATES: ReadonlySet<string> = new Set(['no_contact', 'contacted']);

export function rtrAffordanceKind(
  card: Pick<BoardCardView, 'rtr_status' | 'owner' | 'owner_state'>,
): RtrAffordanceKind {
  const status = card.rtr_status;
  if (status === null) return 'none';
  if (status === 'CONFIRMED') return 'signed';
  if (status === 'SENT') return 'awaiting';
  // status === 'NOT_SENT' — required but nothing sent to the talent yet.
  if (card.owner === 'pipeline' && PRE_RESPONDED_STATES.has(card.owner_state)) return 'due';
  return 'send';
}
