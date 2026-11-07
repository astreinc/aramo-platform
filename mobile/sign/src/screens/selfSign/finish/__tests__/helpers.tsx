// Shared render helper for the M-A14 finish tests (not a test file: no .test suffix).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import { createGuestSigningClient } from '../../../../api/guestSigningClient';
import type { AppServices } from '../../../../app/services';
import { ServicesProvider } from '../../../../app/ServicesContext';
import { ToastProvider } from '../../../../components/Toast';
import { BASE, workspaceWith } from '../../../../features/inbox/__tests__/fixtures';
import { memoryKv, type Responder } from '../../../../testing/fakes';

export function renderWith(ui: ReactElement, responder: Responder) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const { net, workspace } = workspaceWith(responder);
  const guest = createGuestSigningClient({ baseUrl: BASE, fetch: net.fetch });
  const services = {
    workspace,
    guest,
    kv: memoryKv(),
    env: { apiBaseUrl: BASE },
    session: {},
  } as unknown as AppServices;
  const utils = render(
    <ServicesProvider services={services}>
      <QueryClientProvider client={qc}>
        <ToastProvider>{ui}</ToastProvider>
      </QueryClientProvider>
    </ServicesProvider>,
  );
  return { ...utils, net, qc };
}

export const pathOf = (url: string) => url.replace(BASE, '').split('?')[0];

/** Let pending query work finish inside act (no stray state updates after a test). */
export async function settle(ms = 20): Promise<void> {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
}
