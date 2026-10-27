// Step 1 + Add documents sheet (M-A4 §5): Scan · Photos · Templates (only when the
// backend allows) · Files; PDF only; no email-in, cloud or AI tiles; every source adds
// its document through the Send flow controller.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useSyncExternalStore } from 'react';

import type { AppServices } from '../../../app/services';
import { ServicesProvider } from '../../../app/ServicesContext';
import { createDocumentBytesStore } from '../../../features/send/documentBytes';
import {
  addFromSource,
  addSourceTiles,
  FILES_NOTE,
  SOURCE_UNAVAILABLE,
} from '../../../features/send/AddDocumentsSheet';
import type { SenderApi } from '../../../features/send/senderApi';
import { SendFlowController } from '../../../features/send/sendFlowController';
import { createDraftStore } from '../../../state/draftStore';
import { createEncryptedStore } from '../../../state/encryptedStore';
import { memoryFiles, memoryKv, nodeAesGcm } from '../../../testing/fakes';
import { DocumentsStep } from '../DocumentsStep';

const PDF = new Uint8Array(
  Buffer.from(
    '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\ntrailer << /Root 1 0 R >>\nstartxref\n0\n%%EOF\n',
    'latin1',
  ),
);

const mockPhotos = jest.fn();
const mockScan = jest.fn();
const mockPick = jest.fn();
jest.mock('../../../features/send/photos', () => ({ pickPhotosToPdf: () => mockPhotos() }));
jest.mock('../../../features/send/sources', () => ({
  scanToPdf: () => mockScan(),
  pickPdf: () => mockPick(),
}));

function controller() {
  const store = createEncryptedStore({ kv: memoryKv(), cipher: nodeAesGcm, files: memoryFiles() });
  let n = 0;
  return new SendFlowController({
    drafts: createDraftStore(store),
    bytes: createDocumentBytesStore(store),
    api: {} as SenderApi,
    fetchSource: async () => PDF,
    isOnline: () => true,
    newId: () => `id-${String(++n).padStart(8, '0')}`,
  });
}

function Harness({
  c,
  templatesEnabled = false,
  onPicked = () => undefined,
}: {
  readonly c: SendFlowController;
  readonly templatesEnabled?: boolean;
  readonly onPicked?: () => void;
}) {
  const state = useSyncExternalStore(c.subscribe, () => c.snapshot);
  return <DocumentsStep controller={c} state={state} limit={null} templatesEnabled={templatesEnabled} onPicked={onPicked} />;
}

let qc: QueryClient;
afterEach(() => qc?.clear());

function renderStep(c: SendFlowController, props: { templatesEnabled?: boolean; onPicked?: () => void } = {}) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const services = { workspace: { call: jest.fn(async () => ({ items: [], unavailable: [] })) } } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <QueryClientProvider client={qc}>
        <Harness c={c} {...props} />
      </QueryClientProvider>
    </ServicesProvider>,
  );
}

beforeEach(() => {
  mockPhotos.mockReset();
  mockScan.mockReset();
  mockPick.mockReset();
});

describe('Add documents sheet tiles (M-A4 §5.1, §5.4)', () => {
  it('lists Scan, Photos and Files, plus Templates only when the backend allows it', () => {
    expect(addSourceTiles(false).map((t) => t.label)).toEqual(['Scan', 'Photos', 'Files']);
    expect(addSourceTiles(true).map((t) => t.label)).toEqual(['Scan', 'Photos', 'Templates', 'Files']);
  });

  it('says PDF, never Word, for Files', () => {
    const files = addSourceTiles(false).find((t) => t.key === 'files')!;
    expect(files.hint).toBe(FILES_NOTE);
    expect(FILES_NOTE).toBe('A PDF from this phone, OneDrive or Google Drive');
    expect(JSON.stringify(addSourceTiles(true))).not.toMatch(/word/i);
  });
});

describe('addFromSource', () => {
  it('adds the returned PDF through the controller', async () => {
    const c = controller();
    await c.open();
    const out = await addFromSource(c, async () => ({ kind: 'document', title: 'Lease', filename: 'Lease.pdf', bytes: PDF }));
    expect(out).toEqual({ added: true, refusal: null });
    expect(c.snapshot.draft!.payload.documents.map((d) => d.title)).toEqual(['Lease']);
  });

  it('passes refusals through, ignores cancels, and maps a missing source', async () => {
    const c = controller();
    await c.open();
    expect(await addFromSource(c, async () => ({ kind: 'cancelled' }))).toEqual({ added: false, refusal: null });
    expect(await addFromSource(c, async () => ({ kind: 'refused', message: 'No.' }))).toEqual({ added: false, refusal: 'No.' });
    expect(
      await addFromSource(c, async () => {
        throw new Error('native module missing');
      }),
    ).toEqual({ added: false, refusal: SOURCE_UNAVAILABLE });
    expect(c.snapshot.draft!.payload.documents).toHaveLength(0);
  });
});

describe('Step 1 with the sheet', () => {
  it('opens the sheet for a new envelope, with no cloud, email-in or AI tiles', async () => {
    const c = controller();
    await c.open();
    renderStep(c);
    expect(screen.getByRole('header', { name: 'Add documents' })).toBeTruthy();
    expect(screen.getByLabelText('Scan')).toBeTruthy();
    expect(screen.getByLabelText('Photos')).toBeTruthy();
    expect(screen.getByLabelText('Files')).toBeTruthy();
    expect(screen.queryByLabelText('Templates')).toBeNull();
    for (const banned of [/email/i, /google drive$/i, /^onedrive$/i, /box/i, /dropbox/i, /\bAI\b/, /auto-suggest/i, /word/i]) {
      expect(screen.queryByLabelText(banned)).toBeNull();
      expect(screen.queryByText(banned)).toBeNull();
    }
  });

  it('shows Templates when sign.templates is available', async () => {
    const c = controller();
    await c.open();
    renderStep(c, { templatesEnabled: true });
    expect(screen.getByLabelText('Templates')).toBeTruthy();
  });

  it('Photos adds one PDF document and moves on', async () => {
    const c = controller();
    await c.open();
    const onPicked = jest.fn();
    mockPhotos.mockResolvedValue({ kind: 'document', title: 'Photos Oct 27, 2026', filename: 'Photos Oct 27, 2026.pdf', bytes: PDF });
    renderStep(c, { onPicked });
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Photos'));
    });
    await waitFor(() => expect(onPicked).toHaveBeenCalledTimes(1));
    expect(mockPhotos).toHaveBeenCalledTimes(1);
    expect(c.snapshot.draft!.payload.documents.map((d) => d.filename)).toEqual(['Photos Oct 27, 2026.pdf']);
  });

  it('shows a refusal in the sheet and adds nothing', async () => {
    const c = controller();
    await c.open();
    mockPick.mockResolvedValue({ kind: 'refused', message: 'Only PDF files can be sent for signature.' });
    renderStep(c);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Files'));
    });
    expect(await screen.findByText('Only PDF files can be sent for signature.')).toBeTruthy();
    expect(c.snapshot.draft!.payload.documents).toHaveLength(0);
  });
});
