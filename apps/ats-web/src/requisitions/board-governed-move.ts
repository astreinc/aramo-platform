import type { BoardCardView, BoardColumnKey, BoardNextAction } from './requisition-talent-board-api';

// Requisition Talent Board (TB-5) — the GOVERNED drag/drop resolver. A drag is NEVER free
// movement: a drop is accepted ONLY when it maps to the card's own projected TB-3 next action
// (the same governed command), the target is a FORWARD column, and it does not cross the §3.2
// handoff boundary — drag ENDS at Client Selected. Everything past Selected (Offer, Pre-Start,
// Employment) is downstream/handoff and is never drag-movable (done via the governed surface).
// This module is PURE (no I/O) so the governance is unit-testable; the actual mutation still
// flows through the existing governed command path (the drawer surface), never a Board write.

// The forward column each TB-3 next-action lands the card in. Actions that do not change the
// card's column (same-column transitions like mark_responded / qualify / advance_interview /
// offer.transition) are intentionally ABSENT — a drag must represent a visible forward move.
const NEXT_ACTION_TARGET_COLUMN: Readonly<Record<string, BoardColumnKey>> = {
  'pipeline.contact': 'contacted',
  'pipeline.start_qualification': 'qualified',
  'client_selection.mark_selected': 'selected',
};

// The drag ceiling — the last column a governed drag may move a card INTO (§3.2). Columns at
// or before this ordinal are drag targets; anything beyond is handoff-only.
export const DRAG_CEILING_COLUMN: BoardColumnKey = 'selected';

export type GovernedMove =
  | { readonly ok: true; readonly action: BoardNextAction; readonly target: BoardColumnKey }
  | { readonly ok: false; readonly reason: 'no_governed_action' | 'not_forward' | 'past_handoff_ceiling' | 'scope_missing' };

// Resolve whether dropping `card` onto `targetColumn` is a governed move. `columnOrder` is the
// canonical left-to-right order; `scopes` gate the action (the same scope-gate as the TB-3 menu
// — the server re-authorizes on execution). Returns the governed action to run, or a typed
// rejection (the card snaps back).
export function resolveGovernedMove(args: {
  card: BoardCardView;
  targetColumn: BoardColumnKey;
  columnOrder: readonly BoardColumnKey[];
  scopes: readonly string[];
}): GovernedMove {
  const { card, targetColumn, columnOrder, scopes } = args;
  const ceilingOrdinal = columnOrder.indexOf(DRAG_CEILING_COLUMN);
  const targetOrdinal = columnOrder.indexOf(targetColumn);
  const currentOrdinal = columnOrder.indexOf(card.column);

  // The card's projected governed action whose forward target is exactly this column.
  const action = card.next_actions.find((a) => NEXT_ACTION_TARGET_COLUMN[a.key] === targetColumn);
  if (action === undefined) return { ok: false, reason: 'no_governed_action' };

  // Forward-only: never a governed drag backwards or onto the same column.
  if (targetOrdinal <= currentOrdinal) return { ok: false, reason: 'not_forward' };

  // The §3.2 ceiling — drag ends at Client Selected; downstream is handoff-only.
  if (targetOrdinal > ceilingOrdinal) return { ok: false, reason: 'past_handoff_ceiling' };

  // Scope-gate the affordance (server stays authoritative on execution).
  if (!scopes.includes(action.required_scope)) return { ok: false, reason: 'scope_missing' };

  return { ok: true, action, target: targetColumn };
}

// The set of columns a card CAN be governed-dragged into (for the UI to highlight valid drop
// targets). Empty when the card has no forward governed move.
export function governedDropTargets(
  card: BoardCardView,
  columnOrder: readonly BoardColumnKey[],
  scopes: readonly string[],
): Set<BoardColumnKey> {
  const out = new Set<BoardColumnKey>();
  for (const key of columnOrder) {
    if (resolveGovernedMove({ card, targetColumn: key, columnOrder, scopes }).ok) out.add(key);
  }
  return out;
}
