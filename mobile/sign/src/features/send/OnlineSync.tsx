// UAT AND-12 — what the app does whenever it is signed in and online (at start and on every
// reconnect), so the offline Send flow works and its results reach the web:
//   1. drafts saved on the phone while offline are written to the server (pendingDraftSync);
//   2. the sender's contacts are read into the encrypted offline cache, so the recipient
//      picker lists them offline even if it was never opened online.
// Renders nothing.
import { onlineManager, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { useServices, useSession } from '../../app/ServicesContext';
import { CONTACTS_QUERY_KEY, createContactsApi } from '../contacts/contactsApi';
import { signKeys } from '../inbox/queries';
import { createDocumentBytesStore } from './documentBytes';
import { syncPendingDrafts } from './pendingDraftSync';
import { createSenderApi } from './senderApi';

export function OnlineSync(): null {
  const services = useServices();
  const qc = useQueryClient();
  const session = useSession();
  const signedIn = session.status === 'signedIn';
  const deps = useMemo(
    () => ({
      drafts: services.drafts,
      api: createSenderApi(services.workspace),
      bytes: createDocumentBytesStore(services.store),
      contacts: createContactsApi(services.workspace),
    }),
    [services],
  );

  useEffect(() => {
    if (!signedIn) return undefined;
    const whenOnline = () => {
      if (!onlineManager.isOnline()) return;
      void syncPendingDrafts({ ...deps, isOnline: () => onlineManager.isOnline() }).then((n) => {
        if (n > 0) {
          void qc.invalidateQueries({ queryKey: signKeys.localDrafts });
          void qc.invalidateQueries({ queryKey: signKeys.senderList });
        }
      });
      void qc
        .prefetchQuery({
          queryKey: CONTACTS_QUERY_KEY,
          queryFn: () => deps.contacts.list(),
          meta: { persist: true },
        })
        .catch(() => undefined);
    };
    whenOnline();
    return onlineManager.subscribe((online) => {
      if (online) whenOnline();
    });
  }, [signedIn, deps, qc]);

  return null;
}
