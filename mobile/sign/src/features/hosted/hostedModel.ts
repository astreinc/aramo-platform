// Locked hosted (in-person) signing mode (M-A5 §3.3). The host starts a HOSTED session
// for an in-person signer and hands the device over; while the mode is active nothing in
// the workspace can be reached (no back, no tabs, no side menu, no deep link or push
// navigation). Leaving it — after the signer finishes, declines, the session expires, or
// the host cancels — requires the host's device authentication (hostAuth.ts) before the
// workspace shows again.
//
//   handoff  ── BEGIN ──────────────▶ signing
//   signing  ── SIGNER_DONE ────────▶ handback
//   handoff | signing ── EXPIRED ───▶ handback (expired)
//   any but exited ── REQUEST_EXIT ─▶ verifying (remembers where to return)
//   verifying ── AUTH_OK ───────────▶ exited (the only unlocked phase)
//   verifying ── AUTH_FAILED ───────▶ back where it was, still locked
//   BACK (gesture / hardware back) never changes anything.

export type HostedPhase = 'handoff' | 'signing' | 'handback' | 'verifying' | 'exited';
export type HostedEnd = 'finished' | 'expired' | 'cancelled';

export interface HostedState {
  readonly phase: HostedPhase;
  /** Why the signing part ended (null while it hasn't). */
  readonly end: HostedEnd | null;
  /** Where a failed or cancelled authentication returns to. */
  readonly resume: Exclude<HostedPhase, 'verifying' | 'exited'> | null;
  /** The last authentication failure, for the host. */
  readonly authError: string | null;
}

export type HostedEvent =
  | { readonly type: 'BEGIN' }
  | { readonly type: 'SIGNER_DONE' }
  | { readonly type: 'EXPIRED' }
  | { readonly type: 'REQUEST_EXIT' }
  | { readonly type: 'AUTH_OK' }
  | { readonly type: 'AUTH_FAILED'; readonly message: string }
  | { readonly type: 'BACK' };

export const initialHostedState: HostedState = {
  phase: 'handoff',
  end: null,
  resume: null,
  authError: null,
};

export function hostedReducer(s: HostedState, e: HostedEvent): HostedState {
  switch (e.type) {
    case 'BEGIN':
      return s.phase === 'handoff' ? { ...s, phase: 'signing' } : s;
    case 'SIGNER_DONE':
      return s.phase === 'signing' ? { ...s, phase: 'handback', end: 'finished' } : s;
    case 'EXPIRED':
      if (s.phase === 'handoff' || s.phase === 'signing')
        return { ...s, phase: 'handback', end: 'expired' };
      // Expiry while the host authenticates: return to the hand-back screen afterwards.
      if (s.phase === 'verifying' && s.resume !== 'handback')
        return { ...s, end: 'expired', resume: 'handback' };
      return s;
    case 'REQUEST_EXIT':
      if (s.phase === 'exited' || s.phase === 'verifying') return s;
      return {
        ...s,
        phase: 'verifying',
        resume: s.phase,
        end: s.end ?? 'cancelled',
        authError: null,
      };
    case 'AUTH_OK':
      return s.phase === 'verifying' ? { ...s, phase: 'exited', resume: null, authError: null } : s;
    case 'AUTH_FAILED':
      return s.phase === 'verifying'
        ? { ...s, phase: s.resume ?? 'handback', resume: null, authError: e.message }
        : s;
    case 'BACK':
      return s;
  }
}

/** The workspace stays hidden in every phase but `exited`. */
export function isLocked(s: HostedState): boolean {
  return s.phase !== 'exited';
}

/** Milliseconds until the session's expiry (0 when past or unreadable). */
export function msUntil(expiresAt: string, now: number = Date.now()): number {
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) ? Math.max(0, t - now) : 0;
}

export const HOSTED_COPY = {
  handoffTitle: (name: string) => `Give the device to ${name}`,
  handoffBody:
    'They review the documents and sign on this device. You can’t reach your workspace until you hand it back and confirm it’s you.',
  handbackTitle: 'Hand the device back',
  handbackBody: {
    finished: 'Thanks. Please give the device back to the person who handed it to you.',
    expired: 'This in-person signing session ended. Please give the device back.',
    cancelled: 'Please give the device back.',
  } satisfies Record<HostedEnd, string>,
  exitButton: 'I have the device back',
  authPrompt: 'Confirm it’s you to leave in-person signing',
  authFailed: 'Couldn’t confirm it’s you. Try again.',
  noDeviceAuth:
    'This device has no passcode or biometrics, so leaving in-person signing signs you out of Aramo Sign. Sign in again to continue.',
} as const;
