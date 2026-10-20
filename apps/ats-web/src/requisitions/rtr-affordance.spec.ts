import { describe, expect, it } from 'vitest';

import { rtrAffordanceKind, RTR_POLICY_UNRESOLVED_LABEL } from './rtr-affordance';
import { rtrPresentation } from './talent-requisition-360/tr360-model';
import type { BoardCardView } from './requisition-talent-board-api';

// Talent Lifecycle R1–R5 Implementation Directive v1.2 §4.7 — the RTR requirement has three
// business states: REQUIRED (signing status), NOT_REQUIRED (explicit relaxation) and
// UNRESOLVED ('POLICY_UNRESOLVED', not configured). UNRESOLVED is ACTIONABLE — Qualify is
// withheld — so it is never rendered as "Not required" and never as the silent no-chip state.

type Card = Pick<BoardCardView, 'rtr_status' | 'owner' | 'owner_state'>;
const card = (rtr_status: BoardCardView['rtr_status'], owner_state = 'qualifying'): Card => ({
  rtr_status,
  owner: 'pipeline',
  owner_state,
});

describe('rtrAffordanceKind (v1.2 §4.7)', () => {
  it("POLICY_UNRESOLVED → 'policy_unresolved' (actionable), never 'none' or 'hidden'", () => {
    expect(rtrAffordanceKind(card('POLICY_UNRESOLVED'))).toBe('policy_unresolved');
    expect(rtrAffordanceKind(card('POLICY_UNRESOLVED', 'no_contact'))).toBe('policy_unresolved');
  });

  it("explicit NOT_REQUIRED → 'none'; no verdict (null) → 'hidden'", () => {
    expect(rtrAffordanceKind(card('NOT_REQUIRED'))).toBe('none');
    expect(rtrAffordanceKind(card(null))).toBe('hidden');
  });

  it('required: NOT_SENT pre-responded → due; after responded → send; SENT → awaiting; CONFIRMED → signed', () => {
    expect(rtrAffordanceKind(card('NOT_SENT', 'contacted'))).toBe('due');
    expect(rtrAffordanceKind(card('NOT_SENT', 'qualifying'))).toBe('send');
    expect(rtrAffordanceKind(card('SENT'))).toBe('awaiting');
    expect(rtrAffordanceKind(card('CONFIRMED'))).toBe('signed');
  });

  it('the shared not-configured copy names the policy, not "Not required"', () => {
    expect(RTR_POLICY_UNRESOLVED_LABEL).toBe('RTR · Policy not set');
  });
});

describe('rtrPresentation — Talent × Requisition 360 row (v1.2 §4.7)', () => {
  it('POLICY_UNRESOLVED → amber "Policy not set", not done', () => {
    expect(rtrPresentation(card('POLICY_UNRESOLVED') as BoardCardView)).toEqual({
      pill: 'Policy not set',
      tone: 'amber',
      fact: 'Policy not set',
      done: false,
    });
  });

  it('NOT_REQUIRED stays the affirmative "Not required" (done)', () => {
    expect(rtrPresentation(card('NOT_REQUIRED') as BoardCardView)?.fact).toBe('Not required');
  });
});
