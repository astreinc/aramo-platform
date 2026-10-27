// Start a hosted (in-person) session from the sender's envelope detail (M-A5 §3.2). The
// server decides eligibility (in-person signer, open envelope, their turn, the
// sign.in_person_signing capability); the app gives its reason when it refuses. The
// token goes straight into the in-memory vault: only the opaque handle is returned, so
// the token never reaches navigation params, state, logs or disk.
import { isApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import { stashGuestToken } from '../../links/guestTokenVault';
import type { SenderApi } from '../send/senderApi';

export type HostedStart =
  | { readonly kind: 'session'; readonly handle: string; readonly expiresAt: string }
  | { readonly kind: 'refused'; readonly message: string };

const HOSTED_REFUSAL: Record<string, string> = {
  not_in_person_signer: 'This recipient doesn’t sign in person.',
  signer_not_found: 'This recipient is no longer on the envelope.',
  not_your_turn: 'It’s not this person’s turn to sign yet.',
  signer_ineligible: 'This person can no longer sign this envelope.',
  envelope_not_signable: 'This envelope can’t be signed any more.',
  ESIGN_FEATURE_NOT_AVAILABLE: 'In-person signing isn’t included in your plan.',
};

export function hostedRefusal(e: unknown): string {
  if (isApiError(e)) {
    if (e.isNetwork) return 'You’re offline. Connect to start in-person signing.';
    return HOSTED_REFUSAL[e.reason] ?? HOSTED_REFUSAL[e.code] ?? refusalMessage(e);
  }
  return refusalMessage({ reason: 'unknown', code: 'unknown' });
}

export async function startHosted(
  api: Pick<SenderApi, 'hostedSession'>,
  envelopeId: string,
  signerId: string,
  stash: (token: string) => string = stashGuestToken,
): Promise<HostedStart> {
  try {
    const s = await api.hostedSession(envelopeId, signerId);
    return { kind: 'session', handle: stash(s.token), expiresAt: s.expiresAt };
  } catch (e) {
    return { kind: 'refused', message: hostedRefusal(e) };
  }
}
