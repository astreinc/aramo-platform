// "Sign a document" (M-A4 §6.3; M-A5 §4). The Send flow pre-adds the signed-in user as
// a SIGNER with Assign to me (the server binds them only when the email is their
// verified account email, §4.1); after Send succeeds, this asks the server for a SELF
// session and hands its token to the in-memory vault. The caller navigates with the
// opaque handle only: the token never reaches navigation params, state, logs or disk.
// It never signs on an email match alone (§4.5): no binding, no session.
import { isApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import { stashGuestToken } from '../../links/guestTokenVault';
import type { SenderApi } from './senderApi';

export type SelfSignStart =
  | { readonly kind: 'session'; readonly handle: string }
  | { readonly kind: 'refused'; readonly message: string };

const SELF_SIGN_COPY: Record<string, string> = {
  not_bound_to_you:
    'This envelope isn’t assigned to you, so it can’t be signed here. It was sent by email.',
  email_not_verified:
    'Verify your account email to sign here. The envelope was sent, and the signing email is on its way.',
  not_your_turn: 'It’s not your turn to sign yet. You’ll get an email when it is.',
};

export function selfSignRefusal(e: unknown): string {
  if (isApiError(e)) {
    if (e.isNetwork)
      return 'The envelope was sent, but signing couldn’t start. Check your connection and open it from Agreements.';
    return SELF_SIGN_COPY[e.reason] ?? refusalMessage(e);
  }
  return refusalMessage({ reason: 'unknown', code: 'unknown' });
}

/** Start the self-sign session for a sent envelope. */
export async function startSelfSign(
  api: Pick<SenderApi, 'selfSignSession'>,
  envelopeId: string,
  signerId: string | null,
  stash: (token: string) => string = stashGuestToken,
): Promise<SelfSignStart> {
  try {
    const s = await api.selfSignSession(envelopeId, signerId ?? undefined);
    return { kind: 'session', handle: stash(s.token) };
  } catch (e) {
    return { kind: 'refused', message: selfSignRefusal(e) };
  }
}
