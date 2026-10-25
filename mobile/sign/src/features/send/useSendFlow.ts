// React adapter for the Send flow controller: builds it once from the app services,
// opens the requested draft, and re-renders on every state change.
import { onlineManager } from '@tanstack/react-query';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { useServices } from '../../app/ServicesContext';
import { randomId } from '../../util/ids';
import { fetchSourcePdf } from '../editor/sourcePdf';
import { createDocumentBytesStore } from './documentBytes';
import { createSenderApi } from './senderApi';
import { SendFlowController, type OpenParams, type SendFlowState } from './sendFlowController';

export function useSendFlow(params: OpenParams): {
  readonly controller: SendFlowController;
  readonly state: SendFlowState;
} {
  const services = useServices();
  const [controller] = useState(
    () =>
      new SendFlowController({
        drafts: services.drafts,
        bytes: createDocumentBytesStore(services.store),
        api: createSenderApi(services.workspace),
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
      }),
  );
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
    void controller.open(params);
    // Open once per route target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, key]);
  return { controller, state };
}
