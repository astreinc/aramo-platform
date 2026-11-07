// M-A13 #10 — the sender Documents viewer overlays the envelope's placed fields.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react-native';

import type { AppServices } from '../../../app/services';
import { ServicesProvider } from '../../../app/ServicesContext';
import { workspaceWith } from '../../../features/inbox/__tests__/fixtures';
import type { RecordedRequest } from '../../../testing/fakes';
import { DocumentViewerScreen } from '../DocumentViewerScreen';

jest.mock('react-native-pdf', () => 'Pdf');
const mockSource = jest.fn();
jest.mock('../../../features/editor/sourcePdf', () => ({ fetchSourcePdf: () => mockSource() }));
jest.setTimeout(30_000);

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

let fields: unknown[] = [];
function responder(req: RecordedRequest) {
  if (req.url.endsWith('/v1/sign/sender/envelopes/env-1'))
    return {
      status: 200,
      body: {
        id: 'env-1',
        subject: 'Lease',
        status: 'SENT',
        revision: 2,
        documents: [{ id: 'doc-1', title: 'Lease', ordinal: 0 }],
        recipients: [{ id: 's1', name: 'Jo Signer', email: 'jo@example.com', recipient_kind: 'SIGNER', signing_order: 1 }],
        fields,
      },
    };
  return { status: 404, body: {} };
}

let qc: QueryClient;
afterEach(() => qc?.clear());

function renderViewer() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const { workspace } = workspaceWith(responder);
  const services = {
    workspace,
    env: { apiBaseUrl: 'https://sign.aramo.ai' },
    session: { getAccessToken: async () => 'tok' },
  } as unknown as AppServices;
  const navigation = { setOptions: jest.fn() };
  render(
    <ServicesProvider services={services}>
      <QueryClientProvider client={qc}>
        <DocumentViewerScreen
          {...({
            navigation,
            route: { key: 'k', name: 'DocumentViewer', params: { envelopeId: 'env-1', kind: 'source' } },
          } as unknown as React.ComponentProps<typeof DocumentViewerScreen>)}
        />
      </QueryClientProvider>
    </ServicesProvider>,
  );
}

describe('DocumentViewerScreen (source)', () => {
  it('shows the placed fields read-only with type labels', async () => {
    fields = [
      { id: 'f1', envelope_document_id: 'doc-1', signer_id: 's1', field_type: 'SIGNATURE', page_number: 0, x: 72, y: 100, width: 230, height: 50 },
      { id: 'f2', envelope_document_id: 'doc-1', signer_id: 's1', field_type: 'SIGN_DATE', page_number: 1, x: 72, y: 60, width: 150, height: 22 },
    ];
    mockSource.mockResolvedValue(pdf(2));
    renderViewer();
    await waitFor(() => expect(screen.getByTestId('source-field-f1')).toBeTruthy());
    expect(screen.getByTestId('source-field-f2')).toBeTruthy();
    expect(screen.getByLabelText('Signature, for Jo Signer')).toBeTruthy();
    expect(screen.getByText('Date signed')).toBeTruthy();
  });

  it('no fields: the source is streamed as before, without reading the bytes', async () => {
    fields = [];
    mockSource.mockClear();
    renderViewer();
    await waitFor(() => expect(screen.getByLabelText('Lease, page 1')).toBeTruthy());
    expect(mockSource).not.toHaveBeenCalled();
    expect(screen.queryByTestId('source-field-f1')).toBeNull();
  });
});
