import { describe, expect, it } from 'vitest';

import {
  OFFER_STATES,
  OFFER_INITIAL_STATE,
  OFFER_STATE_POSITION,
  OFFER_TRANSITIONS,
  LEGAL_OFFER_TRANSITIONS,
  OFFER_TRANSITION_TERMINAL,
  OFFER_ACCEPTED_STATES,
  OFFER_ONE_LIVE_GUARD_INACTIVE,
  OFFER_TRANSITION_ACTIONS,
  governingOfferAction,
} from '../lib/lifecycle/offer-lifecycle.js';

// Offer Lifecycle — D1 (the registry, unit tier). Directive:
// Aramo-Offer-Lifecycle-Subworkflow-Directive-v1_0-LOCKED.
//
// The Offer aggregate is the DEDICATED pre-placement offer state machine
// (Option B): DRAFT → SENT → NEGOTIATION → ACCEPTED / DECLINED / EXPIRED /
// RESCINDED, mirroring the PlacementProcess registry idiom (positions as data;
// terminal + one-live-guard sets DERIVED from position, never hand-authored).
// This proves the registry shape before the generated SQL trigger (D2) consumes it.

describe('Offer lifecycle registry (D1)', () => {
  it('is the closed 7-state set with DRAFT initial', () => {
    expect([...OFFER_STATES]).toEqual([
      'DRAFT', 'SENT', 'NEGOTIATION', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'RESCINDED',
    ]);
    expect(OFFER_INITIAL_STATE).toBe('DRAFT');
  });

  it('declares the exact legal edges (12) — the dedicated state machine', () => {
    expect(OFFER_TRANSITIONS.DRAFT).toEqual(['SENT', 'RESCINDED']);
    expect(OFFER_TRANSITIONS.SENT).toEqual(['NEGOTIATION', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'RESCINDED']);
    expect(OFFER_TRANSITIONS.NEGOTIATION).toEqual(['SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'RESCINDED']);
    // terminals have no outgoing edge (frozen).
    for (const t of ['ACCEPTED', 'DECLINED', 'EXPIRED', 'RESCINDED'] as const) {
      expect(OFFER_TRANSITIONS[t]).toEqual([]);
    }
    expect(LEGAL_OFFER_TRANSITIONS).toHaveLength(12);
  });

  it('positions classify OPEN / ACCEPTED / CLOSED, and terminal DERIVES from position', () => {
    expect(OFFER_STATE_POSITION.DRAFT).toBe('OPEN');
    expect(OFFER_STATE_POSITION.SENT).toBe('OPEN');
    expect(OFFER_STATE_POSITION.NEGOTIATION).toBe('OPEN');
    expect(OFFER_STATE_POSITION.ACCEPTED).toBe('ACCEPTED');
    expect(OFFER_STATE_POSITION.DECLINED).toBe('CLOSED');
    expect(OFFER_STATE_POSITION.EXPIRED).toBe('CLOSED');
    expect(OFFER_STATE_POSITION.RESCINDED).toBe('CLOSED');
    // transition-terminal = ACCEPTED ∪ CLOSED (the 4 states with no outgoing edge).
    expect([...OFFER_TRANSITION_TERMINAL].sort()).toEqual(['ACCEPTED', 'DECLINED', 'EXPIRED', 'RESCINDED']);
  });

  it('ACCEPTED is the distinguished placement-precondition set', () => {
    // The placement-create re-point (D6) keys on this: only an ACCEPTED offer
    // may become a placement.
    expect([...OFFER_ACCEPTED_STATES]).toEqual(['ACCEPTED']);
  });

  it('the one-live guard releases on ANY terminal (a new offer may follow a closed one)', () => {
    // ≤1 non-terminal offer per (tenant, submittal); every terminal state frees it.
    expect([...OFFER_ONE_LIVE_GUARD_INACTIVE].sort()).toEqual(['ACCEPTED', 'DECLINED', 'EXPIRED', 'RESCINDED']);
  });

  it('governingOfferAction resolves each legal edge to its action; illegal edges → null', () => {
    // every legal edge has a governing action, and it is one of the 7 actions.
    for (const { from, to } of LEGAL_OFFER_TRANSITIONS) {
      const action = governingOfferAction(from, to);
      expect(action).not.toBeNull();
      expect(OFFER_TRANSITION_ACTIONS).toContain(action);
    }
    // the shared-action edges (ACCEPT/DECLINE fire from both SENT and NEGOTIATION).
    expect(governingOfferAction('SENT', 'ACCEPTED')).toBe('ACCEPT');
    expect(governingOfferAction('NEGOTIATION', 'ACCEPTED')).toBe('ACCEPT');
    expect(governingOfferAction('DRAFT', 'SENT')).toBe('SEND');
    expect(governingOfferAction('NEGOTIATION', 'SENT')).toBe('REVISE');
    // an illegal edge is not governed.
    expect(governingOfferAction('DRAFT', 'ACCEPTED')).toBeNull();
    expect(governingOfferAction('ACCEPTED', 'SENT')).toBeNull();
  });

  it('every legal edge lands on a real state and no terminal has an outgoing edge', () => {
    const states = new Set<string>(OFFER_STATES);
    for (const { from, to } of LEGAL_OFFER_TRANSITIONS) {
      expect(states.has(from)).toBe(true);
      expect(states.has(to)).toBe(true);
      expect(OFFER_TRANSITION_TERMINAL.includes(from)).toBe(false);
    }
  });
});
