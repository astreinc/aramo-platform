import { describe, expect, it } from 'vitest';

import {
  TRANSCRIPT_STATE_TRANSITIONS,
  TERMINAL_TRANSCRIPT_STATES,
  assertTranscriptTransition,
  canTranscriptTransition,
  isTerminalTranscriptState,
} from '../lib/domain/transcript-state-machine.js';
import { TranscriptInvalidStateError } from '../lib/domain/errors.js';
import { TRANSCRIPT_STATES } from '../lib/domain/transcript-enums.js';

describe('CI-B3 transcript acquisition state machine', () => {
  it('every state in the enum has a transition entry', () => {
    for (const s of TRANSCRIPT_STATES) {
      expect(TRANSCRIPT_STATE_TRANSITIONS[s]).toBeDefined();
    }
  });

  it('terminal states have no outgoing transitions', () => {
    for (const t of TERMINAL_TRANSCRIPT_STATES) {
      expect(TRANSCRIPT_STATE_TRANSITIONS[t]).toEqual([]);
      expect(isTerminalTranscriptState(t)).toBe(true);
    }
  });

  it('the canonical acquisition happy path is legal', () => {
    expect(canTranscriptTransition('source_available', 'acquiring')).toBe(true);
    expect(canTranscriptTransition('acquiring', 'source_ready')).toBe(true);
  });

  it('retry + park path is legal; success is not reachable from a terminal', () => {
    expect(canTranscriptTransition('acquiring', 'failed_retryable')).toBe(true);
    expect(canTranscriptTransition('failed_retryable', 'acquiring')).toBe(true);
    expect(canTranscriptTransition('failed_retryable', 'intervention_required')).toBe(true);
    expect(canTranscriptTransition('intervention_required', 'acquiring')).toBe(true);
    expect(canTranscriptTransition('failed_terminal', 'acquiring')).toBe(false);
  });

  it('B3 does NOT model normalization states (deferred to CI-B4)', () => {
    // No normalizing/normalized token exists — B4 adds them additively.
    expect(TRANSCRIPT_STATES).not.toContain('normalizing');
    expect(TRANSCRIPT_STATES).not.toContain('normalized');
  });

  it('assertTranscriptTransition throws a typed error on an illegal edge', () => {
    expect(() => assertTranscriptTransition('source_ready', 'acquiring')).toThrow(
      TranscriptInvalidStateError,
    );
  });
});
