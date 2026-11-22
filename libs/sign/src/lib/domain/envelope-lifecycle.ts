// ES-1 — the single source of truth for the envelope lifecycle (§10 / R-3-3).
// Every status change is applied as a compare-and-set against the allowed
// predecessors (EsignRepository.transitionEnvelopeIn), so the database —
// not an in-memory read — decides whether a transition wins.
// Client Rule Consolidation C2-4 — the status sets live in @aramo/sign-client (one copy
// for the server and both Sign clients) and are re-exported here.
import { ENVELOPE_TRANSITIONS } from '@aramo/sign-client';

import { EnvelopeIllegalTransitionError } from './errors.js';

export {
  ENVELOPE_TRANSITIONS,
  TERMINAL_ENVELOPE_STATUSES,
  SIGNABLE_ENVELOPE_STATUSES,
  isTerminalEnvelopeStatus,
  predecessorsOf,
} from '@aramo/sign-client';

// A signing session that still carries signing authority (server-only).
export const LIVE_SESSION_STATUSES: readonly string[] = ['ISSUED', 'EXCHANGED', 'ACTIVE'];

export function assertTransition(from: string, to: string): void {
  if (!(ENVELOPE_TRANSITIONS[from] ?? []).includes(to)) {
    throw new EnvelopeIllegalTransitionError(from, to);
  }
}
