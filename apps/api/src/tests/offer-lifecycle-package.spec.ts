import { describe, expect, it } from 'vitest';
import { evaluate, validatePackage, type PolicyContext } from '@aramo/policy-engine';
import {
  OFFER_LIFECYCLE_PACKAGE_NAME,
  OFFER_TRANSITION_ACTIONS,
  governingOfferAction,
  OFFER_STATES,
  type OfferState,
} from '@aramo/placement';

import { OFFER_LIFECYCLE_PACKAGE } from '../policy/offer-lifecycle.package.js';

// Offer Lifecycle — D3 (the ADR-0024 policy DATA, unit tier). The matrix is
// DERIVED from the offer registry (governingOfferAction), so this spec proves
// the published DATA agrees with the state machine: a cell (action, state) is
// ALLOW iff that action governs a legal edge out of `state`, else DENY.

const ACTION_TARGET: Readonly<Record<string, OfferState>> = {
  SEND: 'SENT', REVISE: 'SENT', NEGOTIATE: 'NEGOTIATION',
  ACCEPT: 'ACCEPTED', DECLINE: 'DECLINED', EXPIRE: 'EXPIRED', RESCIND: 'RESCINDED',
};

function ctx(state: string, action: string): PolicyContext {
  return {
    tenant_id: 't',
    resource: 'OFFER',
    action,
    resource_state: { declared: { state }, derived: {} },
    principal_capabilities: {},
    request_metadata: { correlation_id: 'c', origin: 'ui' },
    environment: 'test',
    time: new Date('2026-01-01T00:00:00Z').toISOString(),
    attributes: {},
  };
}

describe('OFFER_LIFECYCLE_PACKAGE v1.0.0 — offer-state-keyed matrix DATA', () => {
  it('is a structurally valid package named for the retrieval key, default ALLOW', () => {
    expect(() => validatePackage(OFFER_LIFECYCLE_PACKAGE)).not.toThrow();
    expect(OFFER_LIFECYCLE_PACKAGE.name).toBe(OFFER_LIFECYCLE_PACKAGE_NAME);
    expect(OFFER_LIFECYCLE_PACKAGE.version).toBe('1.0.0');
    expect(OFFER_LIFECYCLE_PACKAGE.default_disposition.decision).toBe('ALLOW');
    expect([...OFFER_LIFECYCLE_PACKAGE.registry.actions].sort()).toEqual([...OFFER_TRANSITION_ACTIONS].sort());
  });

  // EVERY (action, state) cell evaluated through the engine, checked against the
  // registry's own governingOfferAction — the two must agree.
  for (const action of OFFER_TRANSITION_ACTIONS) {
    for (const state of OFFER_STATES) {
      const expected = governingOfferAction(state, ACTION_TARGET[action]!) === action ? 'ALLOW' : 'DENY';
      it(`cell ${action} · from ${state} -> ${expected}`, () => {
        expect(evaluate(OFFER_LIFECYCLE_PACKAGE, ctx(state, action)).decision).toBe(expected);
      });
    }
  }

  it('ACCEPT fires only from SENT / NEGOTIATION; never from a terminal or DRAFT', () => {
    for (const s of ['DRAFT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'RESCINDED'] as const) {
      expect(evaluate(OFFER_LIFECYCLE_PACKAGE, ctx(s, 'ACCEPT')).decision, `accept·${s}`).toBe('DENY');
    }
    for (const s of ['SENT', 'NEGOTIATION'] as const) {
      expect(evaluate(OFFER_LIFECYCLE_PACKAGE, ctx(s, 'ACCEPT')).decision, `accept·${s}`).toBe('ALLOW');
    }
  });
});
