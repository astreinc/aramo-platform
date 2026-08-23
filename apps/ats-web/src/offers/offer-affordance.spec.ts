import { describe, expect, it } from 'vitest';

import { offerActionsFor } from './offer-affordance';

// Offer Lifecycle (D7) — the named offer affordances the panel renders, computed
// purely from (current offer state × actor scopes). Mirrors the BE governed edges
// + RBAC; COSMETIC (the BE fail-closed policy + DB trigger are authoritative).
//   - DRAFT + offer:transition → Send, Rescind
//   - SENT + offer:transition → Negotiate, Accept, Decline, Expire, Rescind
//   - NEGOTIATION + offer:transition → Revise, Accept, Decline, Expire, Rescind
//   - terminals → nothing

const T = ['offer:transition'];
const NONE = ['offer:create'];

describe('offerActionsFor', () => {
  it('DRAFT + offer:transition → Send / Rescind', () => {
    expect(offerActionsFor('DRAFT', T).map((a) => a.toState)).toEqual(['SENT', 'RESCINDED']);
  });

  it('SENT + offer:transition → Negotiate / Accept / Decline / Expire / Rescind', () => {
    expect(offerActionsFor('SENT', T).map((a) => a.toState)).toEqual(['NEGOTIATION', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'RESCINDED']);
  });

  it('NEGOTIATION + offer:transition → Revise / Accept / Decline / Expire / Rescind', () => {
    expect(offerActionsFor('NEGOTIATION', T).map((a) => a.toState)).toEqual(['SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'RESCINDED']);
  });

  it('without offer:transition → nothing (affordances are scope-gated)', () => {
    expect(offerActionsFor('SENT', NONE)).toEqual([]);
    expect(offerActionsFor('DRAFT', NONE)).toEqual([]);
  });

  it('terminals → nothing (frozen)', () => {
    for (const s of ['ACCEPTED', 'DECLINED', 'EXPIRED', 'RESCINDED'] as const) {
      expect(offerActionsFor(s, T)).toEqual([]);
    }
  });

  it('the ACCEPT affordance is labelled and targets ACCEPTED (the placement precondition)', () => {
    const accept = offerActionsFor('SENT', T).find((a) => a.toState === 'ACCEPTED');
    expect(accept?.label).toBe('Accept');
    expect(accept?.action).toBe('ACCEPT');
  });
});
