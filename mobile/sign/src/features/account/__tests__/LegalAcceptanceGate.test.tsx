// ToS v2.0 (PO 2026-11-01) — the blocking legal acceptance after sign-in: shown only while the
// backend lists pending documents; accept needs the unticked box and echoes the exact
// versions; a refusal keeps the gate with a message and reloads; Sign out is always offered.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';

import type { AppServices } from '../../../app/services';
import { ServicesProvider } from '../../../app/ServicesContext';
import { LegalAcceptanceGate } from '../LegalAcceptanceGate';

jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => undefined) }));

const WAIT = { timeout: 10_000 } as const;
jest.setTimeout(30_000);

const V20 = { key: 'sign.terms_of_service', version: '2.0', url: 'https://sign.aramo.ai/legal/terms-of-service/2.0', title: 'Aramo Sign Terms of Service' };

let qc: QueryClient;
afterEach(() => qc?.clear());

function renderGate(statuses: { pending: (typeof V20)[] }[], acceptResult: () => Promise<unknown>) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  let reads = 0;
  const call = jest.fn(async (path: string, method: string) => {
    if (path === '/v1/sign/legal/status' && method === 'get') return statuses[Math.min(reads++, statuses.length - 1)];
    if (path === '/v1/sign/legal/accept' && method === 'post') return acceptResult();
    throw new Error(`unexpected ${path}`);
  });
  const signOut = jest.fn(async () => undefined);
  const services = { workspace: { call }, signOut } as unknown as AppServices;
  render(
    <ServicesProvider services={services}>
      <QueryClientProvider client={qc}>
        <LegalAcceptanceGate />
      </QueryClientProvider>
    </ServicesProvider>,
  );
  return { call, signOut };
}

describe('LegalAcceptanceGate (ToS v2.0)', () => {
  it('nothing pending → nothing shown', async () => {
    const { call } = renderGate([{ pending: [] }], async () => ({ pending: [] }));
    await waitFor(() => expect(call).toHaveBeenCalledWith('/v1/sign/legal/status', 'get', {}), WAIT);
    expect(screen.queryByTestId('legal-gate-docs')).toBeNull();
  });

  it('pending → blocking gate; the document opens; accept needs the box and sends the exact versions', async () => {
    const { call } = renderGate([{ pending: [V20] }], async () => ({ pending: [] }));
    expect(await screen.findByTestId('legal-gate-docs', undefined, WAIT)).toBeTruthy();
    fireEvent.press(screen.getByTestId('legal-gate-doc-sign.terms_of_service'));
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith(V20.url);
    expect(screen.getByText('Aramo Sign Terms of Service (version 2.0)')).toBeTruthy();
    fireEvent.press(screen.getByTestId('legal-gate-accept'));
    expect(call).not.toHaveBeenCalledWith('/v1/sign/legal/accept', 'post', expect.anything());
    fireEvent.press(screen.getByTestId('legal-gate-check'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('legal-gate-accept'));
    });
    expect(call).toHaveBeenCalledWith('/v1/sign/legal/accept', 'post', { body: { accept: [{ key: 'sign.terms_of_service', version: '2.0' }] } });
    await waitFor(() => expect(screen.queryByTestId('legal-gate-docs')).toBeNull(), WAIT);
  });

  it('a refused acceptance keeps the gate with a message and reloads the list; Sign out signs out', async () => {
    const { call, signOut } = renderGate([{ pending: [V20] }], async () => {
      throw new Error('stale');
    });
    fireEvent.press(await screen.findByTestId('legal-gate-check', undefined, WAIT));
    await act(async () => {
      fireEvent.press(screen.getByTestId('legal-gate-accept'));
    });
    expect(await screen.findByTestId('legal-gate-error', undefined, WAIT)).toHaveTextContent('We couldn’t record your acceptance. Try again.');
    expect(screen.getByTestId('legal-gate-docs')).toBeTruthy();
    await waitFor(() => expect(call.mock.calls.filter((c) => c[0] === '/v1/sign/legal/status')).toHaveLength(2), WAIT);
    fireEvent.press(screen.getByTestId('legal-gate-sign-out'));
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
