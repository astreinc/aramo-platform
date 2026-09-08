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

  it('B3 acquisition states/edges are intact after the CI-B4 additive extension', () => {
    // The 8 acquisition states remain, unchanged; B4 only ADDED states/edges.
    for (const s of [
      'waiting_for_source',
      'source_available',
      'acquiring',
      'source_ready',
      'expired',
      'failed_retryable',
      'intervention_required',
      'failed_terminal',
    ] as const) {
      expect(TRANSCRIPT_STATES).toContain(s);
    }
    // Acquisition edges unchanged: source_ready never re-enters acquisition.
    expect(canTranscriptTransition('source_ready', 'acquiring')).toBe(false);
  });

  it('CI-B4 normalization states are present and reachable from source_ready', () => {
    for (const s of [
      'normalizing',
      'normalized',
      'normalization_failed_retryable',
      'normalization_intervention_required',
      'normalization_failed_terminal',
    ] as const) {
      expect(TRANSCRIPT_STATES).toContain(s);
    }
    // The additive normalization entry edge.
    expect(canTranscriptTransition('source_ready', 'normalizing')).toBe(true);
    expect(canTranscriptTransition('normalizing', 'normalized')).toBe(true);
    // Acquisition failures and normalization failures are distinct states.
    expect(canTranscriptTransition('acquiring', 'normalization_failed_terminal')).toBe(false);
  });

  it('assertTranscriptTransition throws a typed error on an illegal edge', () => {
    expect(() => assertTranscriptTransition('source_ready', 'acquiring')).toThrow(
      TranscriptInvalidStateError,
    );
  });
});
