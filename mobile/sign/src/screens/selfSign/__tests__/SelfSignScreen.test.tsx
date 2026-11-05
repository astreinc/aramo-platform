// M-A12 W1-A / W1-B — "Sign a document": the documents step shows each document's page
// count with Rename, Move up / down and Remove; Next creates a `mode: "self"` envelope and
// uploads (no Recipients step, nobody is named by the client).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { createGuestSigningClient } from '../../../api/guestSigningClient';
import type { AppServices } from '../../../app/services';
import { ServicesProvider } from '../../../app/ServicesContext';
import { ToastProvider } from '../../../components/Toast';
import { workspaceWith } from '../../../features/inbox/__tests__/fixtures';
import type { RecordedRequest } from '../../../testing/fakes';
import { memoryKv } from '../../../testing/fakes';
import { SelfSignScreen } from '../SelfSignScreen';

jest.mock('react-native-pdf', () => 'Pdf');
jest.mock('react-native-view-shot', () => ({ captureRef: jest.fn() }));
const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack }),
}));
const mockPick = jest.fn();
jest.mock('../../../features/send/sources', () => ({ scanToPdf: jest.fn(), pickPdf: () => mockPick() }));
jest.mock('../../../features/send/photos', () => ({ pickPhotosToPdf: jest.fn() }));
jest.setTimeout(30_000);
const WAIT = { timeout: 10_000 } as const;

const pdf = (pages: number) =>
  new Uint8Array(
    Buffer.from(
      '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
        `2 0 obj << /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(' ')}] /Count ${pages} >> endobj\n` +
        Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\n`).join('') +
        'trailer << /Root 1 0 R >>\nstartxref\n0\n%%EOF\n',
      'latin1',
    ),
  );

let revision = 1;
beforeEach(() => {
  revision = 1;
});

function responder(req: RecordedRequest) {
  const path = req.url.replace('https://sign.aramo.ai', '');
  if (path === '/v1/sign/sender/context')
    return { status: 200, body: { user: { id: 'u1', email: 'me@example.com', display_name: 'Priya Raman' }, tenant: { kind: 'PERSONAL' }, can_send: false } };
  if (path === '/v1/sign/me/profile') return { status: 404, body: { reason: 'not_found', code: 'not_found' } };
  if (path === '/v1/sign/me/settings') return { status: 200, body: { date_format: 'MM/DD/YYYY', default_field_size: 'M' } };
  if (req.method === 'POST' && path === '/v1/sign/sender/envelopes') return { status: 201, body: { id: 'env-1' } };
  if (path === '/v1/sign/sender/envelopes/env-1')
    return { status: 200, headers: { etag: `"env-1.${revision}"` }, body: { id: 'env-1', revision, status: 'DRAFT', documents: [], recipients: [{ id: 'r-self' }], fields: [] } };
  if (path.endsWith('/documents')) {
    revision += 1;
    return { status: 201, body: { id: 'srv-1', title: 'x', pages: [{ width: 612, height: 792 }] } };
  }
  return { status: 200, body: {} };
}

let qc: QueryClient;
afterEach(() => qc?.clear());

function renderScreen() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const { net, workspace } = workspaceWith(responder);
  const guest = createGuestSigningClient({ baseUrl: 'https://sign.aramo.ai', fetch: net.fetch });
  const services = { workspace, guest, kv: memoryKv() } as unknown as AppServices;
  render(
    <ServicesProvider services={services}>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <SelfSignScreen />
        </ToastProvider>
      </QueryClientProvider>
    </ServicesProvider>,
  );
  return net;
}

async function addFile(title: string, pages: number) {
  mockPick.mockResolvedValueOnce({ kind: 'document', title, filename: `${title}.pdf`, bytes: pdf(pages) });
  fireEvent.press(screen.getByTestId('self-add'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('self-source-files'));
  });
}

describe('Sign a document', () => {
  it('documents: page counts, Rename, Move up and Remove; no Recipients step', async () => {
    renderScreen();
    expect(screen.getByTestId('self-next').props.accessibilityState).toMatchObject({ disabled: true });
    await addFile('Lease', 2);
    await waitFor(() => expect(screen.getByText('2 pages · Files')).toBeTruthy(), WAIT);
    await addFile('Addendum', 1);
    await waitFor(() => expect(screen.getByText('1 page · Files')).toBeTruthy(), WAIT);

    fireEvent.press(screen.getByTestId('self-doc-menu-1'));
    fireEvent.press(screen.getByTestId('self-doc-up'));
    expect(screen.getByTestId('self-doc-0')).toHaveTextContent(/Addendum/);

    fireEvent.press(screen.getByTestId('self-doc-menu-0'));
    fireEvent.press(screen.getByTestId('self-doc-rename'));
    fireEvent.changeText(screen.getByTestId('self-rename-input'), 'Addendum A');
    fireEvent.press(screen.getByTestId('self-rename-save'));
    expect(screen.getByText('Addendum A')).toBeTruthy();

    fireEvent.press(screen.getByTestId('self-doc-menu-0'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('self-doc-remove'));
    });
    expect(screen.queryByText('Addendum A')).toBeNull();
    expect(screen.queryByText(/Recipients/)).toBeNull();
  });

  it('"no sends left" never blocks it: Next creates a self envelope and uploads', async () => {
    const net = renderScreen();
    await addFile('Lease', 2);
    await waitFor(() => expect(screen.getByTestId('self-next').props.accessibilityState).toMatchObject({ disabled: false }), WAIT);
    await act(async () => {
      fireEvent.press(screen.getByTestId('self-next'));
    });
    await waitFor(() => expect(screen.getByTestId('self-place')).toBeTruthy(), WAIT);
    const create = net.calls.find((c) => c.method === 'POST' && c.url.endsWith('/v1/sign/sender/envelopes'));
    expect(create?.body).toEqual({ subject: 'Lease', mode: 'self' });
    expect(net.calls.some((c) => c.url.includes('/recipients'))).toBe(false);
    expect(net.calls.some((c) => c.url.endsWith('/env-1/documents'))).toBe(true);
  });
});
