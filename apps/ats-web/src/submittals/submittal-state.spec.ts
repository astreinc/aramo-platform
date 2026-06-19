import { describe, expect, it } from 'vitest';

import {
  canRevoke,
  canTransition,
  isTerminal,
  LEGAL_TRANSITIONS,
  nextMainlineState,
} from './submittal-state';
import { SUBMITTAL_STATE_VALUES } from './types';

describe('submittal-state helpers', () => {
  describe('canTransition', () => {
    it('permits the 4 mainline forward moves', () => {
      expect(canTransition('created', 'handoff_draft')).toBe(true);
      expect(canTransition('handoff_draft', 'ready_for_review')).toBe(true);
      expect(canTransition('ready_for_review', 'submitted_to_ats')).toBe(true);
      expect(canTransition('submitted_to_ats', 'confirmed')).toBe(true);
    });

    it('permits the 4 sibling-revoke moves', () => {
      expect(canTransition('created', 'revoked')).toBe(true);
      expect(canTransition('handoff_draft', 'revoked')).toBe(true);
      expect(canTransition('ready_for_review', 'revoked')).toBe(true);
      expect(canTransition('submitted_to_ats', 'revoked')).toBe(true);
    });

    it('rejects backward moves', () => {
      expect(canTransition('handoff_draft', 'created')).toBe(false);
      expect(canTransition('ready_for_review', 'handoff_draft')).toBe(false);
    });

    it('rejects from terminal states', () => {
      expect(canTransition('confirmed', 'revoked')).toBe(false);
      expect(canTransition('revoked', 'confirmed')).toBe(false);
    });

    it('rejects skips', () => {
      expect(canTransition('created', 'ready_for_review')).toBe(false);
      expect(canTransition('created', 'confirmed')).toBe(false);
    });
  });

  describe('isTerminal', () => {
    it('marks confirmed + revoked as terminal', () => {
      expect(isTerminal('confirmed')).toBe(true);
      expect(isTerminal('revoked')).toBe(true);
    });

    it('marks the 4 in-flight states as non-terminal', () => {
      expect(isTerminal('created')).toBe(false);
      expect(isTerminal('handoff_draft')).toBe(false);
      expect(isTerminal('ready_for_review')).toBe(false);
      expect(isTerminal('submitted_to_ats')).toBe(false);
    });
  });

  describe('nextMainlineState', () => {
    it('walks the chain forward', () => {
      expect(nextMainlineState('created')).toBe('handoff_draft');
      expect(nextMainlineState('handoff_draft')).toBe('ready_for_review');
      expect(nextMainlineState('ready_for_review')).toBe('submitted_to_ats');
      expect(nextMainlineState('submitted_to_ats')).toBe('confirmed');
    });

    it('returns null at terminal states', () => {
      expect(nextMainlineState('confirmed')).toBeNull();
      expect(nextMainlineState('revoked')).toBeNull();
    });
  });

  describe('canRevoke', () => {
    it('permits revoke from the 4 non-terminal in-flight states', () => {
      expect(canRevoke('created')).toBe(true);
      expect(canRevoke('handoff_draft')).toBe(true);
      expect(canRevoke('ready_for_review')).toBe(true);
      expect(canRevoke('submitted_to_ats')).toBe(true);
    });

    it('forbids revoke from terminal states', () => {
      expect(canRevoke('confirmed')).toBe(false);
      expect(canRevoke('revoked')).toBe(false);
    });
  });

  describe('LEGAL_TRANSITIONS shape', () => {
    it('has an entry for every SubmittalStateValue', () => {
      expect(Object.keys(LEGAL_TRANSITIONS).sort()).toEqual(
        [...SUBMITTAL_STATE_VALUES].sort(),
      );
    });

    it('non-terminal entries carry exactly 2 targets (forward + revoke)', () => {
      expect(LEGAL_TRANSITIONS.created).toHaveLength(2);
      expect(LEGAL_TRANSITIONS.handoff_draft).toHaveLength(2);
      expect(LEGAL_TRANSITIONS.ready_for_review).toHaveLength(2);
      expect(LEGAL_TRANSITIONS.submitted_to_ats).toHaveLength(2);
    });

    it('terminal entries carry zero targets', () => {
      expect(LEGAL_TRANSITIONS.confirmed).toEqual([]);
      expect(LEGAL_TRANSITIONS.revoked).toEqual([]);
    });
  });
});
