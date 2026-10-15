import { EnvelopeIllegalTransitionError } from './errors.js';

// ES-1 — the single source of truth for the envelope lifecycle (§10 / R-3-3).
// Every status change is applied as a compare-and-set against the allowed
// predecessors below (EsignRepository.transitionEnvelopeIn), so the database —
// not an in-memory read — decides whether a transition wins.

export const ENVELOPE_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  DRAFT: ['SENT', 'VOIDED'],
  SENT: ['IN_PROGRESS', 'DECLINED', 'VOIDED', 'EXPIRED'],
  IN_PROGRESS: ['COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED'],
  COMPLETED: [],
  DECLINED: [],
  VOIDED: [],
  EXPIRED: [],
};

// Terminal: no outgoing transition; every signer action is refused.
export const TERMINAL_ENVELOPE_STATUSES: readonly string[] = ['COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED'];

// Signable: a signer capability may act (exchange, disclose, fill, complete, decline).
export const SIGNABLE_ENVELOPE_STATUSES: readonly string[] = ['SENT', 'IN_PROGRESS'];

// A signing session that still carries signing authority.
export const LIVE_SESSION_STATUSES: readonly string[] = ['ISSUED', 'EXCHANGED', 'ACTIVE'];

export function isTerminalEnvelopeStatus(status: string): boolean {
  return TERMINAL_ENVELOPE_STATUSES.includes(status);
}

// The statuses from which `to` is reachable in one step.
export function predecessorsOf(to: string): string[] {
  return Object.entries(ENVELOPE_TRANSITIONS)
    .filter(([, next]) => next.includes(to))
    .map(([from]) => from);
}

export function assertTransition(from: string, to: string): void {
  if (!(ENVELOPE_TRANSITIONS[from] ?? []).includes(to)) {
    throw new EnvelopeIllegalTransitionError(from, to);
  }
}
