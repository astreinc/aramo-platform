// COMM-V1 — the canonical call state machine (COMM-B1). This is the SINGLE
// authority for legal call-state transitions; the database stores the state but
// does NOT enforce transitions. Provider events normalize into these states
// inside the provider adapter and are validated here — the domain names no
// vendor (the correlation-identity ruling keeps provider ids as metadata only).
//
// The machine is EXACTLY the locked directive diagram (no invented edges):
//
//   created -+-> initiated -> ringing -+-> failed
//            |                          +-> missed
//            +-> failed  (COMM-B5)      +-> rejected
//                                       +-> connected -> completed
//
// COMM-B5 ratified EXACTLY ONE additional edge — `created -> failed` — so a
// provider launch that fails BEFORE ringing has an auditable terminal outcome
// (a row stranded in `created` would be semantically wrong). `initiated->failed`,
// `connected->failed`, `canceled`, and `busy` remain DEFERRED to COMM-B6
// (admitted only if provider recon confirms distinct semantics). Adding any
// FURTHER edge here is a directive divergence to report, never a silent absorption.

import { CommunicationInvalidStateError } from './errors.js';
import type { CommunicationInteractionStatus } from './communication-enums.js';

/** Adjacency of the canonical machine — the exact locked edge set. */
export const CALL_STATE_TRANSITIONS: Readonly<
  Record<CommunicationInteractionStatus, ReadonlyArray<CommunicationInteractionStatus>>
> = Object.freeze({
  created: ['initiated', 'failed'],
  initiated: ['ringing'],
  ringing: ['connected', 'failed', 'missed', 'rejected'],
  connected: ['completed'],
  completed: [],
  failed: [],
  missed: [],
  rejected: [],
});

/** The terminal states (no outgoing transition). */
export const TERMINAL_CALL_STATES: ReadonlyArray<CommunicationInteractionStatus> = Object.freeze([
  'completed',
  'failed',
  'missed',
  'rejected',
]);

export function isTerminalCallState(state: CommunicationInteractionStatus): boolean {
  return TERMINAL_CALL_STATES.includes(state);
}

/** True iff `to` is a permitted successor of `from`. */
export function canTransition(
  from: CommunicationInteractionStatus,
  to: CommunicationInteractionStatus,
): boolean {
  return CALL_STATE_TRANSITIONS[from].includes(to);
}

/**
 * Assert a transition is legal; throws CommunicationInvalidStateError otherwise.
 * The single guard both the service and (later) the webhook normalizer call.
 */
export function assertTransition(
  from: CommunicationInteractionStatus,
  to: CommunicationInteractionStatus,
): void {
  if (!canTransition(from, to)) {
    throw new CommunicationInvalidStateError(from, to);
  }
}
