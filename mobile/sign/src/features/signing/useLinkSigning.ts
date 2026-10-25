// An emailed /s/ or /d/ link's token, taken ONCE from the in-memory vault (M-A2 §2.1,
// §3.4). It opens the guest session and, when the user is signed in, can be presented
// once to POST /v1/sign/inbox/claim (a workspace call by contract, M-A2 §1 "first
// association"). The token lives only in this hook's closure: never in state, params,
// the query cache, logs or storage; it is dropped when the screen unmounts.
import { useCallback, useEffect, useState } from 'react';

import { isApiError } from '../../api/errors';
import type { GuestSigningSession } from '../../api/guestSigningClient';
import { useServices } from '../../app/ServicesContext';
import { takeGuestToken } from '../../links/guestTokenVault';
import { claimFromLink, inboxRefusalCopy } from '../inbox/inboxSigning';
import { signKeys } from '../inbox/queries';

export interface LinkSigning {
  readonly session: GuestSigningSession | null;
  /** Claim into the inbox; resolves null on success, else the copy to show. */
  readonly claim: () => Promise<string | null>;
}

export function useLinkSigning(handle: string): LinkSigning {
  const { guest, workspace, queryClient } = useServices();
  // Created once. The token is held only inside this closure (not as a state value).
  const [held] = useState(() => {
    let token = takeGuestToken(handle);
    return {
      session: token ? guest.open(token) : null,
      token: () => token,
      drop: () => {
        token = null;
      },
    };
  });
  const session = held.session;
  useEffect(
    () => () => {
      held.session?.discard();
      held.drop();
    },
    [held],
  );
  const claim = useCallback(async (): Promise<string | null> => {
    const token = held.token();
    if (!token)
      return inboxRefusalCopy({
        reason: 'SIGNING_SESSION_INVALID',
        code: 'SIGNING_SESSION_INVALID',
      });
    try {
      await claimFromLink(workspace, token);
      void queryClient.invalidateQueries({ queryKey: signKeys.inbox });
      return null;
    } catch (e) {
      return isApiError(e)
        ? inboxRefusalCopy(e)
        : inboxRefusalCopy({ reason: 'unknown', code: 'unknown' });
    }
  }, [workspace, queryClient, held]);
  return { session, claim };
}
