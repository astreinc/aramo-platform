// CI-B3 — the canonical transcript ACQUISITION state machine (directive §20).
// Every state transition is explicit; illegal transitions throw. Mirrors the
// communications call-state-machine PATTERN. B3 stops at `source_ready` — the
// stable success state CI-B4 (normalization) continues from. Normalization
// states are intentionally absent (added additively by B4).

import type { TranscriptState } from './transcript-enums.js';
import { TranscriptInvalidStateError } from './errors.js';

/**
 * Allowed forward transitions. A transcript is created at `waiting_for_source`
 * (aggregate exists, provider source not yet signalled available) or directly
 * at `source_available` when the availability signal is already known.
 */
export const TRANSCRIPT_STATE_TRANSITIONS: Readonly<
  Record<TranscriptState, readonly TranscriptState[]>
> = {
  waiting_for_source: ['source_available', 'expired', 'failed_terminal'],
  source_available: ['acquiring', 'expired', 'failed_terminal'],
  acquiring: [
    'source_ready',
    'failed_retryable',
    'intervention_required',
    'failed_terminal',
  ],
  failed_retryable: [
    'acquiring',
    'intervention_required',
    'failed_terminal',
    'expired',
  ],
  intervention_required: ['acquiring', 'failed_terminal', 'expired'],
  source_ready: ['expired'],
  // Terminal states — no outgoing transitions.
  expired: [],
  failed_terminal: [],
} as const;

/** States with no outgoing transition (directive §20 terminal conditions). */
export const TERMINAL_TRANSCRIPT_STATES: readonly TranscriptState[] = [
  'expired',
  'failed_terminal',
];

export function isTerminalTranscriptState(state: TranscriptState): boolean {
  return TERMINAL_TRANSCRIPT_STATES.includes(state);
}

export function canTranscriptTransition(
  from: TranscriptState,
  to: TranscriptState,
): boolean {
  return TRANSCRIPT_STATE_TRANSITIONS[from].includes(to);
}

/** Assert a legal transition; throws {@link TranscriptInvalidStateError}. */
export function assertTranscriptTransition(
  from: TranscriptState,
  to: TranscriptState,
): void {
  if (!canTranscriptTransition(from, to)) {
    throw new TranscriptInvalidStateError(from, to);
  }
}
