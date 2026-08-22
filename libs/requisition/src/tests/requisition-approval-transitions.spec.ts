import { describe, expect, it } from 'vitest';

import {
  GATED_RECRUITING_STATUS_VALUES,
  SELECTABLE_RECRUITING_STATUS_VALUES,
  isGatedRecruitingStatus,
} from '../lib/dto/requisition-status.js';
import {
  TRANSITION_ACTIONS,
  governingAction,
} from '../lib/dto/requisition-transitions.js';

// Requisition Approval sub-workflow — Boundary 1 (D1 un-gate + D2 edge re-key).
// LOCKED: Aramo-Requisition-Approval-Subworkflow-Directive-v1_0 (Amendment B).
//
// Amendment B re-keys the governing-action resolution from the TARGET alone
// (governingActionForTarget(to)) to the (from, to) EDGE (governingAction), so
// APPROVE and REOPEN can legitimately converge on `open` and be disambiguated by
// the from-status. This proof:
//   (a) REGRESSION — the four pre-existing edges resolve to their SAME actions
//       after the re-key (behaviour preserved);
//   (b) the three approval edges resolve to their ratified actions, including the
//       `* → open` disambiguation that motivated Amendment B;
//   (c) draft + pending_approval are UN-GATED (archived stays gated).

describe('Approval sub-workflow — governingAction(from, to) edge re-key', () => {
  it('REGRESSION — the four existing governed edges keep their exact actions', () => {
    // These resolved via governingActionForTarget(to) before the re-key; they
    // MUST still resolve to the identical action edge-keyed.
    expect(governingAction('open', 'closed')).toBe('CLOSE');
    expect(governingAction('submittals_closed', 'closed')).toBe('CLOSE');
    expect(governingAction('closed', 'open')).toBe('REOPEN');
    expect(governingAction('on_hold', 'open')).toBe('REOPEN');
    expect(governingAction('open', 'on_hold')).toBe('PUT_ON_HOLD');
    expect(governingAction('open', 'canceled')).toBe('CANCEL');
  });

  it('REGRESSION — ungoverned targets remain ordinary edits (null)', () => {
    // submittals_closed + lead have NO governing action (R8 boundary) — ordinary
    // version-CAS edits, not policy-gated. Unchanged.
    expect(governingAction('open', 'submittals_closed')).toBeNull();
    expect(governingAction('open', 'lead')).toBeNull();
    expect(governingAction('lead', 'submittals_closed')).toBeNull();
  });

  it('the three approval edges resolve to their ratified actions', () => {
    expect(governingAction('draft', 'pending_approval')).toBe('SUBMIT_FOR_APPROVAL');
    expect(governingAction('pending_approval', 'open')).toBe('APPROVE');
    expect(governingAction('pending_approval', 'draft')).toBe('REJECT');
  });

  it('APPROVE and REOPEN converge on `open`, disambiguated by from-status', () => {
    // The exact collision that motivated Amendment B: same target, different edge.
    expect(governingAction('pending_approval', 'open')).toBe('APPROVE');
    expect(governingAction('closed', 'open')).toBe('REOPEN');
    expect(governingAction('pending_approval', 'open')).not.toBe(
      governingAction('closed', 'open'),
    );
  });

  it('non-approval edges INTO draft/pending_approval remain ordinary (null)', () => {
    // Entering the chain (lead → draft) is an ordinary edit; only the specific
    // approval edges are governed.
    expect(governingAction('lead', 'draft')).toBeNull();
    expect(governingAction('open', 'pending_approval')).toBeNull();
  });

  it('the three approval actions are registered in TRANSITION_ACTIONS', () => {
    expect(TRANSITION_ACTIONS).toContain('SUBMIT_FOR_APPROVAL');
    expect(TRANSITION_ACTIONS).toContain('APPROVE');
    expect(TRANSITION_ACTIONS).toContain('REJECT');
  });

  it('draft + pending_approval are UN-GATED; archived stays gated', () => {
    expect(isGatedRecruitingStatus('draft')).toBe(false);
    expect(isGatedRecruitingStatus('pending_approval')).toBe(false);
    expect(isGatedRecruitingStatus('archived')).toBe(true);
    expect([...GATED_RECRUITING_STATUS_VALUES]).toEqual(['archived']);
    expect(SELECTABLE_RECRUITING_STATUS_VALUES).toContain('draft');
    expect(SELECTABLE_RECRUITING_STATUS_VALUES).toContain('pending_approval');
  });
});
