// M-A12 W1-A / W1-B, rebuilt for M-A14 "Sign a Document" v2 (§1 items 3–4, 8; §3 gates):
//   - Add Documents: "N Pages" cards with Rename, Move up and Remove; Next creates a
//     `mode: "self"` envelope and uploads (no Recipients step);
//   - R-3: suggestions placed with the green banner; Undo removes them, ✕ keeps them;
//     the switch (stored on this device, default on) turns them off;
//   - Finish without a signature: the toast and the Signature tool armed;
//   - R-6: one tool row in the prototype order, then Last Name and Email;
//   - R-1: Finishing… during the real calls, You've Signed never before COMPLETED, Try
//     again on failure, IN_PROGRESS keeps "ready shortly", Done → Agreements + Sign Next;
//   - R-7: no Email / cloud tiles and no AI controls.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Pressable, Text, View } from 'react-native';

import { createGuestSigningClient } from '../../../api/guestSigningClient';
import type { AppServices } from '../../../app/services';
import { ServicesProvider } from '../../../app/ServicesContext';
import { ToastProvider } from '../../../components/Toast';
import { workspaceWith } from '../../../features/inbox/__tests__/fixtures';
import { AUTO_SUGGEST_KEY } from '../../../features/selfSign/fieldSuggestions';
import { dismissSignNext, putPendingSelfDoc, signNextRequested } from '../../../features/selfSign/selfSignHandoff';
import type { RecordedRequest } from '../../../testing/fakes';
import { memoryKv } from '../../../testing/fakes';
import { SelfSignScreen, signFileName, suggestionBannerText } from '../SelfSignScreen';

jest.mock('react-native-pdf', () => 'Pdf');
jest.mock('react-native-view-shot', () => ({ captureRef: jest.fn() }));
const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
let mockParams: { start?: 'templates' } | undefined;
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack }),
  useRoute: () => ({ key: 'SelfSign', name: 'SelfSign', params: mockParams }),
}));
const mockPick = jest.fn();
jest.mock('../../../features/send/sources', () => ({ scanToPdf: jest.fn(), pickPdf: () => mockPick() }));
jest.mock('../../../features/send/photos', () => ({ pickPhotosToPdf: jest.fn() }));
const mockSource = jest.fn();
jest.mock('../../../features/editor/sourcePdf', () => ({ fetchSourcePdf: () => mockSource() }));
jest.mock('../../../auth/biometric', () => ({
  biometricConfirmPref: { get: async () => false },
  biometricCapability: async () => null,
  confirmLocally: async () => true,
}));
// The completion chain: the real calls are exercised in selfSignFlow.test.ts; here only
// the order the screens appear in matters (R-1).
const mockSendAndOpen = jest.fn();
const mockComplete = jest.fn();
jest.mock('../../../features/selfSign/selfSignFlow', () => ({
  ...jest.requireActual('../../../features/selfSign/selfSignFlow'),
  sendAndOpen: (...a: unknown[]) => mockSendAndOpen(...a),
  acceptFillComplete: (...a: unknown[]) => mockComplete(...a),
}));
// Mobile B's screens, reduced to their contract (props) so the wiring is what is tested.
jest.mock('../finish', () => {
  const { Pressable: P, Text: T, View: V } = jest.requireActual('react-native');
  return {
    FinishingScreen: (p: { state: string; message?: string; onRetry: () => void; onCancel: () => void }) => (
      <V testID={`finishing-${p.state}`}>
        <T>Finishing…</T>
        {p.message ? <T>{p.message}</T> : null}
        <P testID="finishing-retry" onPress={p.onRetry} />
        <P testID="finishing-cancel" onPress={p.onCancel} />
      </V>
    ),
    AlmostThereScreen: (p: { envelopeId: string; documentTitle: string; onFinishSigning: () => void }) => (
      <V testID="almost-there">
        <T>{`You're almost there · ${p.envelopeId} · ${p.documentTitle}`}</T>
        <P testID="almost-finish" onPress={p.onFinishSigning} />
      </V>
    ),
    YouSignedScreen: (p: { envelopeId: string; onViewSigned: () => void; onViewCertificate: () => void; onDone: () => void }) => (
      <V testID="you-signed">
        <T>{`You've Signed · ${p.envelopeId}`}</T>
        <P testID="ys-view-signed" onPress={p.onViewSigned} />
        <P testID="ys-done" onPress={p.onDone} />
      </V>
    ),
    SignNextModal: () => null,
  };
});
// Keep the unused imports referenced (the mock factory requires its own copies).
void Pressable;
void Text;
void View;
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

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const DISCLOSURE = { disclosure_version: '1.0', text: 'Electronic records text.', text_sha256: 'abc', message: null };

let revision = 1;
let templatesOn = false;
let suggestions: unknown[] = [];
beforeEach(() => {
  revision = 1;
  templatesOn = false;
  suggestions = [];
  mockParams = undefined;
  mockSendAndOpen.mockReset();
  mockComplete.mockReset();
  dismissSignNext();
  jest
    .mocked(jest.requireMock('react-native-view-shot').captureRef)
    .mockResolvedValue(PNG);
});

function responder(req: RecordedRequest) {
  const path = req.url.replace('https://sign.aramo.ai', '');
  if (path === '/v1/sign/sender/context')
    return {
      status: 200,
      body: {
        user: { id: 'u1', email: 'me@example.com', display_name: 'Sam Example' },
        tenant: { kind: 'PERSONAL' },
        can_send: false,
        features: { templates: templatesOn },
        permissions: { templates: templatesOn },
      },
    };
  if (path === '/v1/sign/sender/templates')
    return {
      status: 200,
      body: {
        items: [{ template_id: 'tpl-1', name: 'Lease template', document_type: { name: 'Lease' }, variables: [] }],
        unavailable: [],
      },
    };
  if (path === '/v1/sign/sender/envelopes/from-template')
    return {
      status: 201,
      body: {
        envelope: {
          id: 'env-t',
          revision: 1,
          status: 'DRAFT',
          documents: [{ id: 'doc-t', title: 'Lease' }],
          recipients: [{ id: 'r-self' }],
          fields: [{ id: 'f1', envelope_document_id: 'doc-t', signer_id: 'r-self', field_type: 'SIGNATURE', page_number: 0, x: 100, y: 600, width: 230, height: 50, required: true }],
        },
      },
    };
  if (path === '/v1/sign/me/profile') return { status: 404, body: { reason: 'not_found', code: 'not_found' } };
  if (path === '/v1/sign/me/settings') return { status: 200, body: { date_format: 'MM/DD/YYYY', default_field_size: 'M' } };
  if (req.method === 'POST' && path === '/v1/sign/sender/envelopes') return { status: 201, body: { id: 'env-1' } };
  if (path === '/v1/sign/sender/envelopes/env-1')
    return { status: 200, headers: { etag: `"env-1.${revision}"` }, body: { id: 'env-1', revision, status: 'DRAFT', documents: [], recipients: [{ id: 'r-self' }], fields: [] } };
  if (path.endsWith('/field-suggestions')) return { status: 200, body: { suggestions } };
  if (path.endsWith('/documents')) {
    revision += 1;
    return { status: 201, body: { id: 'srv-1', title: 'x', pages: [{ width: 612, height: 792 }] } };
  }
  return { status: 200, body: {} };
}

let qc: QueryClient;
afterEach(() => qc?.clear());

function renderScreen(kv = memoryKv()) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const { net, workspace } = workspaceWith(responder);
  const guest = createGuestSigningClient({ baseUrl: 'https://sign.aramo.ai', fetch: net.fetch });
  const services = {
    workspace,
    guest,
    kv,
    env: { apiBaseUrl: 'https://sign.aramo.ai' },
    session: {},
  } as unknown as AppServices;
  render(
    <ServicesProvider services={services}>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <SelfSignScreen />
        </ToastProvider>
      </QueryClientProvider>
    </ServicesProvider>,
  );
  return { net, kv };
}

async function addFile(title: string, pages: number) {
  mockPick.mockResolvedValueOnce({ kind: 'document', title, filename: `${title}.pdf`, bytes: pdf(pages) });
  fireEvent.press(screen.getByTestId('self-add'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('self-source-files'));
  });
}

async function toPlace() {
  await addFile('Lease', 2);
  await waitFor(() => expect(screen.getByTestId('self-next').props.accessibilityState).toMatchObject({ disabled: false }), WAIT);
  await act(async () => {
    fireEvent.press(screen.getByTestId('self-next'));
  });
  await waitFor(() => expect(screen.getByTestId('self-place')).toBeTruthy(), WAIT);
}

async function toPlaceWithTemplate() {
  templatesOn = true;
  mockSource.mockResolvedValue(pdf(1));
  mockParams = { start: 'templates' };
  const r = renderScreen();
  await waitFor(() => expect(screen.getByText('Lease template')).toBeTruthy(), WAIT);
  fireEvent.press(screen.getByTestId('template-0'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('self-template-use'));
  });
  await waitFor(() => expect(screen.getByTestId('self-place')).toBeTruthy(), WAIT);
  return r;
}

/** Adopt a signature from the Signature tool (M-A13 #3 places it at the centre). */
async function adoptSignature() {
  fireEvent.press(screen.getByLabelText('Signature field'));
  await waitFor(() => expect(screen.getByText('Adopt your signature')).toBeTruthy(), WAIT);
  await act(async () => {
    fireEvent.press(screen.getByTestId('adopt-confirm'));
  });
  await waitFor(() => expect(screen.getByTestId('field-remove')).toBeTruthy(), WAIT);
}

const placedFields = () => screen.queryAllByTestId(/^field-(?!fill-|remove)/);

describe('Sign Document: Add Documents (a06, a07)', () => {
  it('cards show "N Pages"; Rename, Move up and Remove; no Recipients step', async () => {
    renderScreen();
    expect(screen.getByText('Add Documents')).toBeTruthy();
    expect(screen.getByTestId('self-next').props.accessibilityState).toMatchObject({ disabled: true });
    await addFile('Lease', 2);
    await waitFor(() => expect(screen.getByText('2 Pages')).toBeTruthy(), WAIT);
    expect(screen.getByText('Add another document')).toBeTruthy();
    await addFile('Addendum', 1);
    await waitFor(() => expect(screen.getByText('1 Page')).toBeTruthy(), WAIT);

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

  it('opens on the document picked on the sheet over Home', async () => {
    putPendingSelfDoc({
      source: 'Files',
      doc: { key: 'k1', title: 'Picked lease', filename: 'Picked lease.pdf', base64: null, pages: [{ width: 612, height: 792 }], serverId: null },
    });
    renderScreen();
    expect(screen.getByText('Picked lease')).toBeTruthy();
    expect(screen.getByText('1 Page')).toBeTruthy();
  });

  it('"no sends left" never blocks it: Next creates a self envelope and uploads', async () => {
    const { net } = renderScreen();
    await toPlace();
    const create = net.calls.find((c) => c.method === 'POST' && c.url.endsWith('/v1/sign/sender/envelopes'));
    expect(create?.body).toEqual({ subject: 'Lease', mode: 'self' });
    expect(net.calls.some((c) => c.url.includes('/recipients'))).toBe(false);
    expect(net.calls.some((c) => c.url.endsWith('/env-1/documents'))).toBe(true);
    // Header: "Sign" / the file name; no AI button.
    expect(screen.getByText('Sign')).toBeTruthy();
    expect(screen.getByTestId('self-file-name')).toHaveTextContent('Lease.pdf');
  });

  it('the Templates tile shows only while the backend allows templates', async () => {
    renderScreen();
    fireEvent.press(screen.getByTestId('self-add'));
    await waitFor(() => expect(screen.getByTestId('self-source-files')).toBeTruthy(), WAIT);
    expect(screen.queryByTestId('self-source-templates')).toBeNull();
  });

  it('R-7: the sheet offers Scan, Photos and Files only — no Email or cloud tiles', async () => {
    renderScreen();
    fireEvent.press(screen.getByTestId('self-add'));
    await waitFor(() => expect(screen.getByTestId('add-docs-sheet')).toBeTruthy(), WAIT);
    expect(screen.queryAllByTestId(/^self-source-/).map((n) => n.props.testID)).toEqual([
      'self-source-scan',
      'self-source-photos',
      'self-source-files',
    ]);
    for (const label of ['Email', 'Google', 'OneDrive', 'Box', 'Dropbox']) expect(screen.queryByText(label)).toBeNull();
    // ⓘ explains the sources.
    fireEvent.press(screen.getByTestId('add-docs-info'));
    expect(screen.getByTestId('add-docs-info-body')).toBeTruthy();
  });

  it('Templates: mode "self" from the template, then the editor with its documents and fields', async () => {
    const r = await toPlaceWithTemplate();
    const call = r.net.calls.find((c) => c.url.endsWith('/from-template'));
    expect(call?.body).toMatchObject({ template_id: 'tpl-1', mode: 'self' });
    expect(call?.body).not.toHaveProperty('recipients');
    expect(call?.body).not.toHaveProperty('signer');
    await waitFor(() => expect(placedFields()).toHaveLength(1), WAIT);
  });
});

describe('Sign Document: Sign screen (a08–a10, b01, b02)', () => {
  it('M-A13 #3: adopting from the Signature tool places the mark at the centre, selected', async () => {
    await toPlaceWithTemplate();
    await adoptSignature();
    expect(placedFields()).toHaveLength(2);
    expect(screen.getByLabelText('Remove field')).toBeTruthy();
  });

  it('R-6: one tool row in the prototype order, then Last Name and Email; no "More fields"', async () => {
    renderScreen();
    await toPlace();
    const row = screen.queryAllByTestId(/^self-tool-/).map((n) => n.props.accessibilityLabel);
    expect(row).toEqual([
      'Signature field',
      'Initials field',
      'Date field',
      'Textbox field',
      'Name field',
      'First Name field',
      'Company field',
      'Title field',
      'Checkbox field',
      'Last Name field',
      'Email field',
    ]);
    expect(screen.queryByTestId('editor-more-fields')).toBeNull();
    expect(screen.queryByText('Place at center')).toBeNull();
    expect(screen.getByTestId('self-finish')).toBeTruthy();
    expect(screen.getByLabelText('Previous page')).toBeTruthy();
    expect(screen.getByLabelText('Next page')).toBeTruthy();
  });

  it('R-3: suggestions are placed with the banner; Undo removes them', async () => {
    suggestions = [
      { type: 'SIGNATURE', page: 1, x: 72, y: 100, width: 200, height: 46 },
      { type: 'SIGN_DATE', page: 1, x: 360, y: 110, width: 124, height: 24 },
      { type: 'BOGUS', page: 1, x: 0, y: 0, width: 1, height: 1 },
    ];
    const { net } = renderScreen();
    await toPlace();
    expect(net.calls.some((c) => c.url.endsWith('/env-1/documents/srv-1/field-suggestions'))).toBe(true);
    expect(screen.getByText('2 field suggestions placed. Review them below.')).toBeTruthy();
    await waitFor(() => expect(placedFields()).toHaveLength(2), WAIT);
    // The banner replaces the toolbar.
    expect(screen.queryByLabelText('Find in document')).toBeNull();

    fireEvent.press(screen.getByTestId('self-suggest-undo'));
    expect(screen.queryByTestId('self-suggest-banner')).toBeNull();
    await waitFor(() => expect(placedFields()).toHaveLength(0), WAIT);
    expect(screen.getByLabelText('Find in document')).toBeTruthy();
  });

  it('R-3: ✕ keeps the suggestions and hides the banner', async () => {
    suggestions = [{ type: 'SIGNATURE', page: 1, x: 72, y: 100, width: 200, height: 46 }];
    renderScreen();
    await toPlace();
    expect(screen.getByText('1 field suggestion placed. Review them below.')).toBeTruthy();
    fireEvent.press(screen.getByTestId('self-suggest-dismiss'));
    expect(screen.queryByTestId('self-suggest-banner')).toBeNull();
    await waitFor(() => expect(placedFields()).toHaveLength(1), WAIT);
  });

  it('R-3: with the switch off nothing is suggested, and the choice is kept on this device', async () => {
    suggestions = [{ type: 'SIGNATURE', page: 1, x: 72, y: 100, width: 200, height: 46 }];
    const { net, kv } = renderScreen();
    await waitFor(() => expect(screen.getByTestId('self-auto-suggest').props.value).toBe(true), WAIT);
    await act(async () => {
      fireEvent(screen.getByTestId('self-auto-suggest'), 'valueChange', false);
    });
    expect(kv.items.get(AUTO_SUGGEST_KEY)).toBe('0');
    await toPlace();
    expect(net.calls.some((c) => c.url.endsWith('/field-suggestions'))).toBe(false);
    expect(screen.queryByTestId('self-suggest-banner')).toBeNull();
  });

  it('Finish without a signature: the toast, and the Signature tool is armed', async () => {
    renderScreen();
    await toPlace();
    fireEvent.press(screen.getByTestId('self-finish'));
    expect(screen.getByText('Add your signature before you finish')).toBeTruthy();
    await waitFor(
      () => expect(screen.getByTestId('self-tool-SIGNATURE').props.accessibilityState).toMatchObject({ selected: true }),
      WAIT,
    );
    expect(screen.getByTestId('self-hint')).toHaveTextContent('Tap the document where the signature goes');
    expect(mockSendAndOpen).not.toHaveBeenCalled();
  });

  it('R-7: no AI header button, Summarize or AI-Assisted badge', async () => {
    renderScreen();
    expect(screen.queryByText('AI-Assisted')).toBeNull();
    await toPlace();
    expect(screen.queryByLabelText('AI assistant')).toBeNull();
    expect(screen.queryByLabelText('Summarize')).toBeNull();
    expect(screen.queryByText('AI-Assisted')).toBeNull();
  });
});

describe('Sign Document: R-1 completion order', () => {
  async function toConsent() {
    await toPlaceWithTemplate();
    await adoptSignature();
    mockSendAndOpen.mockResolvedValue({
      progress: { envelopeId: 'env-t', etag: '"env-t.2"', signerId: 'r-self', sent: true, uploadKeys: {} },
      session: { discard: jest.fn() },
      disclosure: DISCLOSURE,
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('self-finish'));
    });
    await waitFor(() => expect(screen.getByTestId('self-consent')).toBeTruthy(), WAIT);
    fireEvent.press(screen.getByTestId('self-consent-check'));
  }

  it('Finishing… while completing; You\'ve Signed only after COMPLETED and Finish Signing', async () => {
    await toConsent();
    let resolve: (v: unknown) => void = () => undefined;
    mockComplete.mockReturnValue(new Promise((r) => (resolve = r)));
    await act(async () => {
      fireEvent.press(screen.getByTestId('self-consent-continue'));
    });
    await waitFor(() => expect(screen.getByTestId('finishing-working')).toBeTruthy(), WAIT);
    expect(screen.queryByTestId('you-signed')).toBeNull();
    expect(screen.queryByTestId('almost-there')).toBeNull();
    await act(async () => {
      resolve({ envelopeStatus: 'COMPLETED', view: {} });
    });
    await waitFor(() => expect(screen.getByTestId('almost-there')).toBeTruthy(), WAIT);
    expect(screen.getByText("You're almost there · env-t · Lease")).toBeTruthy();
    expect(screen.queryByTestId('you-signed')).toBeNull();
    fireEvent.press(screen.getByTestId('almost-finish'));
    expect(screen.getByTestId('you-signed')).toBeTruthy();
    fireEvent.press(screen.getByTestId('ys-view-signed'));
    expect(mockNavigate).toHaveBeenCalledWith('DocumentViewer', { envelopeId: 'env-t', kind: 'executed' });
    // Done: Agreements (All), and "Want to sign another document?" is requested.
    fireEvent.press(screen.getByTestId('ys-done'));
    expect(mockNavigate).toHaveBeenCalledWith('Main', { screen: 'Agreements', params: { filter: 'all' } });
    expect(signNextRequested()).toBe(true);
  });

  it('a failed completion shows Try again; the retry completes', async () => {
    await toConsent();
    mockComplete.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ envelopeStatus: 'COMPLETED', view: {} });
    await act(async () => {
      fireEvent.press(screen.getByTestId('self-consent-continue'));
    });
    await waitFor(() => expect(screen.getByTestId('finishing-failed')).toBeTruthy(), WAIT);
    expect(screen.queryByTestId('you-signed')).toBeNull();
    expect(screen.queryByTestId('almost-there')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('finishing-retry'));
    });
    await waitFor(() => expect(screen.getByTestId('almost-there')).toBeTruthy(), WAIT);
    expect(mockComplete).toHaveBeenCalledTimes(2);
  });

  it('a failed send shows Try again (Finishing…, not the Sign screen)', async () => {
    await toPlaceWithTemplate();
    await adoptSignature();
    mockSendAndOpen.mockRejectedValueOnce(new Error('network'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('self-finish'));
    });
    await waitFor(() => expect(screen.getByTestId('finishing-failed')).toBeTruthy(), WAIT);
    fireEvent.press(screen.getByTestId('finishing-cancel'));
    expect(screen.getByTestId('self-place')).toBeTruthy();
  });

  it('IN_PROGRESS keeps "ready shortly" and never shows You\'ve Signed', async () => {
    await toConsent();
    mockComplete.mockResolvedValue({ envelopeStatus: 'IN_PROGRESS', view: {} });
    await act(async () => {
      fireEvent.press(screen.getByTestId('self-consent-continue'));
    });
    await waitFor(() => expect(screen.getByTestId('self-pending')).toBeTruthy(), WAIT);
    expect(screen.getByText(/ready shortly/)).toBeTruthy();
    expect(screen.queryByTestId('you-signed')).toBeNull();
    expect(screen.queryByTestId('almost-there')).toBeNull();
  });
});

describe('Sign Document copy', () => {
  it('the banner and the header file name', () => {
    expect(suggestionBannerText(1)).toBe('1 field suggestion placed. Review them below.');
    expect(suggestionBannerText(2)).toBe('2 field suggestions placed. Review them below.');
    const d = (title: string, filename: string) => ({ key: title, title, filename, base64: null, pages: null, serverId: null });
    expect(signFileName([d('Lease', 'Lease.pdf')])).toBe('Lease.pdf');
    expect(signFileName([d('Scan', 'scan'), d('B', 'B.pdf')])).toBe('Scan.pdf +1');
  });
});
