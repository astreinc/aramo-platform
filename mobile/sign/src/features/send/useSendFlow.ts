// React adapter for the Send flow controller: builds it once from the app services,
// opens the requested draft, and re-renders on every state change.
import { onlineManager } from '@tanstack/react-query';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { useServices } from '../../app/ServicesContext';
import { randomId } from '../../util/ids';
import { fetchSourcePdf } from '../editor/sourcePdf';
import { createDocumentBytesStore } from './documentBytes';
import { markDraftOpen, pendingDraftSyncIdle } from './pendingDraftSync';
import { createSenderApi } from './senderApi';
import { SendFlowController, type OpenParams, type SendFlowState } from './sendFlowController';

export function useSendFlow(
  params: OpenParams,
  opts: {
    /** A messaging feature is available (GET …/messaging is refused otherwise). */
    readonly messaging?: boolean;
  } = {},
): {
  readonly controller: SendFlowController;
  readonly state: SendFlowState;
} {
  const services = useServices();
  const [controller] = useState(() => {
    const api = createSenderApi(services.workspace);
    return new SendFlowController({
        drafts: services.drafts,
        bytes: createDocumentBytesStore(services.store),
        api,
        loadMessaging: (envelopeId) => api.messaging(envelopeId),
        fetchSource: (envelopeId, documentId) =>
          fetchSourcePdf(
            {
              baseUrl: services.env.apiBaseUrl,
              fetch: (u, i) => fetch(u, i),
              session: services.session,
            },
            envelopeId,
            documentId,
          ),
        isOnline: () => onlineManager.isOnline(),
        newId: randomId,
      });
  });
  // Declared before the open effect, so a server draft opens with the current flags.
  useEffect(() => {
    controller.setMessagingEnabled(opts.messaging === true);
  }, [controller, opts.messaging]);
  const state = useSyncExternalStore(
    controller.subscribe,
    () => controller.snapshot,
    () => controller.snapshot,
  );
  const key = useMemo(
    () => `${params.localDraftId ?? ''}|${params.envelopeId ?? ''}|${params.step ?? ''}`,
    [params.localDraftId, params.envelopeId, params.step],
  );
  useEffect(() => {
    // UAT AND-12 — a draft being synced in the background is opened after that sync,
    // so the screen starts from the server copy instead of creating a second envelope.
    const release = params.localDraftId ? markDraftOpen(params.localDraftId) : null;
    void pendingDraftSyncIdle().then(() => controller.open(params));
    return () => release?.();
    // Open once per route target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, key]);
  // The open draft is the Send flow's: the background sync leaves it alone.
  const openLocalId = state.draft?.localId ?? null;
  useEffect(() => (openLocalId ? markDraftOpen(openLocalId) : undefined), [openLocalId]);
  return { controller, state };
}
