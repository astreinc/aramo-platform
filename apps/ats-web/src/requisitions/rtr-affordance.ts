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
//   rtr_status === null (no verdict computed)                      → 'hidden'   render nothing
//   rtr_status === 'POLICY_UNRESOLVED' (v1.2 §4.7, not configured) → 'policy_unresolved'
//                                                                     "RTR policy not set" (actionable)
//   rtr_status === 'NOT_REQUIRED' (policy EXPLICITLY relaxed)    → 'none'     "Not required"
//   rtr_status === 'CONFIRMED'                                   → 'signed'   "✓ Signed" + View
//   rtr_status === 'SENT'                                        → 'awaiting' "Awaiting signature" + reminder
//   rtr_status === 'NOT_SENT' (required, not sent):
//     no_contact / contacted (pre-responded)                     → 'due'      "Due before qualifying" (muted)
//     talent_responded / qualifying / qualified …                → 'send'     "Send RTR" (actionable)
//
// CRITICAL (UNRESOLVED ≠ NOT_REQUIRED): only an EXPLICIT NOT_REQUIRED earns the affirmative
// "Not required" statement; an UNRESOLVED requirement (not configured) is an ACTIONABLE state —
// Qualify is withheld — never "Not required" and never silent. NOT_SENT = required-not-sent.

export type RtrAffordanceKind = 'hidden' | 'none' | 'policy_unresolved' | 'due' | 'send' | 'awaiting' | 'signed';

// Recruiting stages that are still PRE-responded — RTR is due but not yet
// actionable (the talent must respond first). Everything at/after talent_responded
// is actionable when RTR is required and nothing has been sent.
const PRE_RESPONDED_STATES: ReadonlySet<string> = new Set(['no_contact', 'contacted']);

export function rtrAffordanceKind(
  card: Pick<BoardCardView, 'rtr_status' | 'owner' | 'owner_state'>,
): RtrAffordanceKind {
  const status = card.rtr_status;
  if (status === null) return 'hidden'; // no verdict computed → no chip
  if (status === 'POLICY_UNRESOLVED') return 'policy_unresolved'; // v1.2 §4.7 — not configured
  if (status === 'NOT_REQUIRED') return 'none'; // EXPLICITLY relaxed → "Not required"
  if (status === 'CONFIRMED') return 'signed';
  if (status === 'SENT') return 'awaiting';
  // status === 'NOT_SENT' — required but nothing sent to the talent yet. Pipeline & RTR Recon
  // Remediation Directive v1.0 R2 (DEF-12) — DECLINED / EXPIRED: the last RTR ended unsigned, so a
  // new one is needed; it follows the same due / send rule (rtrEndedLabel adds the outcome).
  if (card.owner === 'pipeline' && PRE_RESPONDED_STATES.has(card.owner_state)) return 'due';
  return 'send';
}

// Talent Lifecycle R1–R5 Impl Directive v1.2 §4.7 — the actionable not-configured copy,
// shared by the Board chip, the List cell and the Talent × Requisition 360 page.
export const RTR_POLICY_UNRESOLVED_LABEL = 'RTR · Policy not set';
export const RTR_POLICY_UNRESOLVED_DETAIL =
  "Right to Represent policy isn't set for this client. Ask an admin to set it in the client's submittal policy before qualifying.";

// R2 (DEF-12; RTR-TEMPLATE-1 §18 backend-derived state) — the outcome of an RTR that ended
// unsigned, shown next to the Send RTR affordance. Null when the last RTR did not end that way.
export function rtrEndedLabel(card: Pick<BoardCardView, 'rtr_status'>): string | null {
  if (card.rtr_status === 'DECLINED') return 'RTR · Declined by the talent';
  if (card.rtr_status === 'EXPIRED') return 'RTR · Expired unsigned';
  return null;
}
