// ES-1 — the envelope lifecycle status sets (§10 / R-3-3). Pure values.
// Client Rule Consolidation C2-4 — moved here from libs/sign/src/lib/domain/
// envelope-lifecycle.ts, which keeps assertTransition (it throws a libs/sign domain
// error) and re-exports these. The database compare-and-set
// (EsignRepository.transitionEnvelopeIn) still decides whether a transition wins.

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

export function isTerminalEnvelopeStatus(status: string): boolean {
  return TERMINAL_ENVELOPE_STATUSES.includes(status);
}

// The statuses from which `to` is reachable in one step.
export function predecessorsOf(to: string): string[] {
  return Object.entries(ENVELOPE_TRANSITIONS)
    .filter(([, next]) => next.includes(to))
    .map(([from]) => from);
}
