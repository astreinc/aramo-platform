// "Signed in with Google/Microsoft/Apple" (handoff §4.9; directive B-11; Apple Go-Live R-2).
// The provider comes from GET /v1/sign/sender/context `user.identity_provider`; null means
// unknown and the line is hidden (the server never guesses, and neither does the app).
import type { SenderContext } from '../inbox/types';

// `apple` is added by Apple Go-Live W1 (sign.yaml enum); widened here until the generated
// types are regenerated.
export type IdentityProvider = SenderContext['user']['identity_provider'] | 'apple';

export function signedInWithLabel(provider: IdentityProvider | undefined): string | null {
  if (provider === 'google') return 'Signed in with Google';
  if (provider === 'microsoft') return 'Signed in with Microsoft';
  if (provider === 'apple') return 'Signed in with Apple';
  return null;
}
