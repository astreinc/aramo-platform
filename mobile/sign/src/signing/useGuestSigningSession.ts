// Opens a guest signing session from a vault handle (links/guestTokenVault.ts) and
// discards the token when the screen goes away (M-A2 §2.1: memory only, for the
// duration of the signing task). For inbox signing, call `services.guest.open(token)`
// with the token minted by POST /v1/sign/inbox/:id/sign and discard it the same way.
import { useEffect, useState } from 'react';

import type { GuestSigningSession } from '../api/guestSigningClient';
import { useServices } from '../app/ServicesContext';
import { takeGuestToken } from '../links/guestTokenVault';

export function useGuestSigningSession(handle: string): GuestSigningSession | null {
  const { guest } = useServices();
  const [session] = useState<GuestSigningSession | null>(() => {
    const token = takeGuestToken(handle);
    return token ? guest.open(token) : null;
  });
  useEffect(() => () => session?.discard(), [session]);
  return session;
}
