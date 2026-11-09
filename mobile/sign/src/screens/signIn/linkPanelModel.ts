// The pending-link panels' pure model (Apple Go-Live A1 L-2, L-3, L-7). A native sign-in
// denied with user_not_provisioned or idp_identity_conflict may carry a pending-link handle
// in `error.details`; the panel then lets the user prove the account (another provider, or
// an email code) so the new provider is attached. The handle lives in component state
// only: never stored, never logged, gone when the screen is left.
import type { ApiError } from '../../api/errors';
import { isProvider, PROVIDER_NAMES, type Provider } from '../../auth/authorize';

export interface PendingLink {
  readonly handle: string;
  /** The provider the user just tried (the one to be attached). */
  readonly idp: Provider;
  /** Path 3 (conflict: the email matches an account) or path 2 (no account matches). */
  readonly kind: 'conflict' | 'unmatched';
}

const HANDLE = /^[A-Za-z0-9_-]{16,256}$/;

/** A pending link from a sign-in refusal, or null when the refusal carries none. */
export function pendingLinkFrom(
  err: Pick<ApiError, 'reason' | 'details'> | null,
  attempted: Provider,
): PendingLink | null {
  if (err === null) return null;
  if (err.reason !== 'user_not_provisioned' && err.reason !== 'idp_identity_conflict') return null;
  const handle = err.details['link_handle'];
  if (typeof handle !== 'string' || !HANDLE.test(handle)) return null;
  const idp = isProvider(err.details['idp']) ? err.details['idp'] : attempted;
  return { handle, idp, kind: err.reason === 'idp_identity_conflict' ? 'conflict' : 'unmatched' };
}

/** The providers that can prove the account (proof (a)): every one except the new one. */
export function proofProviders(link: PendingLink, order: readonly Provider[]): Provider[] {
  return order.filter((p) => p !== link.idp);
}

export const LINK_COPY = {
  conflictTitle: 'You already have an Aramo account. Confirm it’s you.',
  conflictBody: (p: Provider) =>
    `Sign in the way you usually do, or get a code by email. Then ${PROVIDER_NAMES[p]} is added as a way to sign in.`,
  unmatchedTitle: (p: Provider) => `No Aramo account uses this ${PROVIDER_NAMES[p]} account yet`,
  unmatchedBody: 'Connect it to the account you already have, or create a new account.',
  // Apple Go-Live R-3: a relay address never matches a Business account.
  appleRelayHint:
    'Your Apple ID didn’t share your work email. Choose Share My Email, or sign in with Google or Microsoft.',
  connect: 'I already have an account. Connect it',
  createNew: 'Create a new account',
  proveWith: (p: Provider) => `Sign in with ${PROVIDER_NAMES[p]}`,
  emailCode: 'Email me a code',
  emailLabel: 'Your Aramo account email',
  emailInvalid: 'Enter your email address.',
  sendCode: 'Send code',
  codeTitle: 'Check your email',
  codeSentConflict: 'We sent a 6-digit code to your account’s email. It works for 10 minutes.',
  codeSentTyped: (email: string) =>
    `If an Aramo account uses ${email}, we sent it a 6-digit code. It works for 10 minutes.`,
  codeLabel: '6-digit code',
  verify: 'Confirm',
  resend: 'Send a new code',
  resent: 'We sent a new code.',
  linkedTitle: (p: Provider) => `${PROVIDER_NAMES[p]} is connected`,
  linkedBody: (p: Provider) => `Sign in with ${PROVIDER_NAMES[p]} to continue.`,
  continueWith: (p: Provider) => `Continue with ${PROVIDER_NAMES[p]}`,
  expired: (p: Provider) =>
    `This request expired. Sign in with ${PROVIDER_NAMES[p]} again to start over.`,
  cancel: 'Cancel',
  generic: 'Something went wrong. Try again.',
} as const;

/** An email-code refusal (A1 L-4 proof (b)) in words the person can act on. */
export function linkCodeFailure(
  err: Pick<ApiError, 'status' | 'reason' | 'details'>,
  idp: Provider,
): { message: string; restart: boolean } {
  switch (err.reason) {
    case 'link_expired':
      return { message: LINK_COPY.expired(idp), restart: true };
    case 'code_attempts_exceeded':
      return { message: 'Too many wrong codes. Send a new code.', restart: false };
    case 'code_expired':
      return { message: 'This code has expired. Send a new code.', restart: false };
    case 'code_invalid': {
      const left = err.details['attempts_remaining'];
      return typeof left === 'number'
        ? {
            message: `That code isn’t right. ${left} ${left === 1 ? 'try' : 'tries'} left.`,
            restart: false,
          }
        : { message: 'That code isn’t right. Check the code and try again.', restart: false };
    }
    default:
      return err.status === 429
        ? { message: 'Too many tries. Wait a minute and try again.', restart: false }
        : { message: LINK_COPY.generic, restart: false };
  }
}
