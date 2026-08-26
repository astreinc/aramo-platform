import { describe, expect, it } from 'vitest';

import {
  CALL_STATE_TRANSITIONS,
  TERMINAL_CALL_STATES,
  assertTransition,
  canTransition,
  isTerminalCallState,
} from '../lib/domain/call-state-machine.js';
import { CommunicationInvalidStateError } from '../lib/domain/errors.js';
import {
  COMMUNICATION_INTERACTION_STATES,
  type CommunicationInteractionStatus,
} from '../lib/domain/communication-enums.js';

// COMM-B1 — the canonical call state machine is the SINGLE transition authority.
// These prove the EXACT locked edge set (no invented edges) and that illegal
// transitions raise CommunicationInvalidStateError.

const LEGAL: ReadonlyArray<[CommunicationInteractionStatus, CommunicationInteractionStatus]> = [
  ['created', 'initiated'],
  // COMM-B5 — the ONLY edge added in B5: an auditable terminal outcome when
  // provider launch fails before ringing. `initiated->failed`/`connected->failed`
  // and `busy`/`canceled` remain B6 recon items and are NOT added here.
  ['created', 'failed'],
  ['initiated', 'ringing'],
  ['ringing', 'connected'],
  ['ringing', 'failed'],
  ['ringing', 'missed'],
  ['ringing', 'rejected'],
  ['connected', 'completed'],
];

describe('canonical call state machine', () => {
  it('permits EXACTLY the locked edge set and nothing else', () => {
    const legalSet = new Set(LEGAL.map(([f, t]) => `${f}->${t}`));
    for (const from of COMMUNICATION_INTERACTION_STATES) {
      for (const to of COMMUNICATION_INTERACTION_STATES) {
        const expected = legalSet.has(`${from}->${to}`);
        expect(canTransition(from, to), `${from}->${to}`).toBe(expected);
      }
    }
  });

  it.each(LEGAL)('allows legal transition %s -> %s', (from, to) => {
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it('rejects self-loops and skips (e.g. created->ringing, created->completed)', () => {
    expect(canTransition('created', 'ringing')).toBe(false);
    expect(canTransition('created', 'completed')).toBe(false);
    expect(canTransition('initiated', 'connected')).toBe(false);
    expect(canTransition('ringing', 'completed')).toBe(false);
  });

  it('assertTransition throws CommunicationInvalidStateError on an illegal edge', () => {
    expect(() => assertTransition('completed', 'initiated')).toThrowError(
      CommunicationInvalidStateError,
    );
    try {
      assertTransition('connected', 'ringing');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CommunicationInvalidStateError);
      expect((err as CommunicationInvalidStateError).from).toBe('connected');
      expect((err as CommunicationInvalidStateError).to).toBe('ringing');
    }
  });

  it('terminal states have no outgoing transition', () => {
    for (const state of TERMINAL_CALL_STATES) {
      expect(isTerminalCallState(state)).toBe(true);
      expect(CALL_STATE_TRANSITIONS[state]).toHaveLength(0);
    }
    expect(isTerminalCallState('created')).toBe(false);
    expect(isTerminalCallState('ringing')).toBe(false);
  });

  it('COMM-B5: created->failed is legal, but no OTHER ->failed edge is added', () => {
    expect(canTransition('created', 'failed')).toBe(true);
    // The B5 edge is narrow: launch failure BEFORE ringing only.
    expect(canTransition('initiated', 'failed')).toBe(false);
    expect(canTransition('connected', 'failed')).toBe(false);
    // created's successors are now exactly {initiated, failed} — nothing else.
    expect([...CALL_STATE_TRANSITIONS.created].sort()).toEqual(['failed', 'initiated']);
  });

  it('does NOT admit canceled/busy in B1 (deferred to B6)', () => {
    // The locked B1 state set is exactly 8 values; canceled/busy are absent.
    expect(COMMUNICATION_INTERACTION_STATES).toHaveLength(8);
    expect(COMMUNICATION_INTERACTION_STATES as readonly string[]).not.toContain('canceled');
    expect(COMMUNICATION_INTERACTION_STATES as readonly string[]).not.toContain('busy');
  });
});
