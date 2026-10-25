// "Signed in with Google/Microsoft" (handoff §4.9; directive B-11). The provider comes
// from GET /v1/sign/sender/context `user.identity_provider`; null means unknown and the
// line is hidden (the server never guesses, and neither does the app).
import type { SenderContext } from '../inbox/types';

export type IdentityProvider = SenderContext['user']['identity_provider'];

export function signedInWithLabel(provider: IdentityProvider | undefined): string | null {
  if (provider === 'google') return 'Signed in with Google';
  if (provider === 'microsoft') return 'Signed in with Microsoft';
  return null;
}
