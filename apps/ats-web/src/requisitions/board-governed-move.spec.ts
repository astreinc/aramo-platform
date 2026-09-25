import { describe, expect, it } from 'vitest';

import { resolveGovernedMove, governedDropTargets, DRAG_CEILING_COLUMN } from './board-governed-move';
import type { BoardCardView, BoardColumnKey, BoardNextAction } from './requisition-talent-board-api';

// TB-5 — the GOVERNED drag/drop resolver. Drag is never free movement: a drop is accepted only
// when it maps to the card's own projected TB-3 governed action, moves the card FORWARD, and
// does not cross the §3.2 handoff ceiling (Client Selected). These tests pin that governance.

const COLUMN_ORDER: readonly BoardColumnKey[] = [
  'pipeline', 'contacted', 'qualified', 'submitted', 'interview', 'selected', 'offer', 'accepted', 'prestart', 'ready', 'started',
];

function action(key: string, scope: string): BoardNextAction {
  return { key, label: key, owner: 'pipeline', command_route: 'POST /x', required_scope: scope };
}
function card(column: BoardColumnKey, next: BoardNextAction[]): BoardCardView {
  return {
    talent_record_id: 't', pipeline_id: 'p', column, owner: 'pipeline', source_object_id: 'p', owner_state: 's',
    resume: { resume_edition_id: null, source: 'none', locked: false },
    rtr_state: null, readiness: null, days_in_stage: null, stage_entered_at: null, assigned_recruiter_user_id: null,
    next_actions: next,
  };
}

const move = (c: BoardCardView, target: BoardColumnKey, scopes: string[]) =>
  resolveGovernedMove({ card: c, targetColumn: target, columnOrder: COLUMN_ORDER, scopes });

describe('resolveGovernedMove (TB-5 governance)', () => {
  it('accepts a forward drop matching the card’s projected governed action', () => {
    const c = card('pipeline', [action('pipeline.contact', 'pipeline:change-status')]);
    const r = move(c, 'contacted', ['pipeline:change-status']);
    expect(r).toEqual({ ok: true, action: c.next_actions[0], target: 'contacted' });
  });

  it('accepts the marquee interview → Client Selected move (mark_selected)', () => {
    const c = card('interview', [action('client_selection.mark_selected', 'client-selection:transition')]);
    expect(move(c, 'selected', ['client-selection:transition']).ok).toBe(true);
  });

  it('rejects a drop that maps to no governed action for the card', () => {
    const c = card('pipeline', [action('pipeline.contact', 'pipeline:change-status')]);
    expect(move(c, 'qualified', ['pipeline:change-status'])).toEqual({ ok: false, reason: 'no_governed_action' });
  });

  it('rejects Create offer as a drag — it is the §3.2 handoff, not a governed drag target', () => {
    // offer.create is intentionally absent from the draggable action→column map.
    const c = card('selected', [action('offer.create', 'offer:create')]);
    expect(move(c, 'offer', ['offer:create'])).toEqual({ ok: false, reason: 'no_governed_action' });
  });

  it('rejects a non-forward (same-column) drop', () => {
    const c = card('selected', [action('client_selection.mark_selected', 'client-selection:transition')]);
    expect(move(c, 'selected', ['client-selection:transition'])).toEqual({ ok: false, reason: 'not_forward' });
  });

  it('rejects when the actor lacks the action’s scope', () => {
    const c = card('pipeline', [action('pipeline.contact', 'pipeline:change-status')]);
    expect(move(c, 'contacted', [])).toEqual({ ok: false, reason: 'scope_missing' });
  });

  it('never offers a drop target past the Client Selected ceiling', () => {
    // A card with every conceivable action still cannot be dragged past the ceiling.
    const c = card('interview', [
      action('client_selection.mark_selected', 'client-selection:transition'),
      action('offer.create', 'offer:create'),
    ]);
    const targets = governedDropTargets(c, COLUMN_ORDER, ['client-selection:transition', 'offer:create']);
    const ceilingOrdinal = COLUMN_ORDER.indexOf(DRAG_CEILING_COLUMN);
    for (const t of targets) expect(COLUMN_ORDER.indexOf(t)).toBeLessThanOrEqual(ceilingOrdinal);
    expect(targets.has('selected')).toBe(true);
    expect(targets.has('offer')).toBe(false); // downstream — handoff only
  });
});
