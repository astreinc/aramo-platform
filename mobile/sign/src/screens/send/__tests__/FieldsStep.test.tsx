// UAT DOC-06 — the Fields step syncs on entry; a refusal from that sync (storage full for a
// PDF added offline) shows on this step, as on Documents and Review, instead of being swallowed.
import { STORAGE_FULL } from '@aramo/sign-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react-native';
import { useSyncExternalStore } from 'react';

import type { AppServices } from '../../../app/services';
import { ServicesProvider } from '../../../app/ServicesContext';
import { createDocumentBytesStore } from '../../../features/send/documentBytes';
import { fakeSenderServer } from '../../../features/send/__tests__/fakeSenderServer';
import { createSenderApi } from '../../../features/send/senderApi';
import { SendFlowController } from '../../../features/send/sendFlowController';
import { createDraftStore } from '../../../state/draftStore';
import { createEncryptedStore } from '../../../state/encryptedStore';
import { memoryFiles, memoryKv, nodeAesGcm } from '../../../testing/fakes';
import { FieldsStep } from '../FieldsStep';

jest.mock('react-native-pdf', () => 'Pdf');

const PDF = new Uint8Array(
  Buffer.from(
    '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\ntrailer << /Root 1 0 R >>\nstartxref\n0\n%%EOF\n',
    'latin1',
  ),
);

function Harness({ c }: { readonly c: SendFlowController }) {
  const state = useSyncExternalStore(c.subscribe, () => c.snapshot);
  return <FieldsStep controller={c} state={state} />;
}

let qc: QueryClient;
afterEach(() => qc?.clear());

describe('Fields step errors (UAT DOC-06)', () => {
  it('a PDF added offline is refused by the sync on entering Fields, and the words show here', async () => {
    const store = createEncryptedStore({ kv: memoryKv(), cipher: nodeAesGcm, files: memoryFiles() });
    const server = fakeSenderServer({ storageFull: true });
    let online = false;
    let n = 0;
    const c = new SendFlowController({
      drafts: createDraftStore(store),
      bytes: createDocumentBytesStore(store),
      api: createSenderApi(server.workspace),
      fetchSource: async () => PDF,
      isOnline: () => online,
      newId: () => `id-${String(++n).padStart(8, '0')}`,
      sleep: async () => undefined,
    });
    await c.open();
    await c.addDocument({ title: 'Lease', filename: 'Lease.pdf', bytes: PDF });
    expect(c.addRecipient({ name: 'Dana Lee', email: 'dana@example.com' })).toBe('added');
    expect(c.snapshot.error).toBeNull();
    online = true;
    c.setStep('fields');

    qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const services = { workspace: { call: jest.fn(async () => ({})) } } as unknown as AppServices;
    render(
      <ServicesProvider services={services}>
        <QueryClientProvider client={qc}>
          <Harness c={c} />
        </QueryClientProvider>
      </ServicesProvider>,
    );
    expect(await screen.findByText(STORAGE_FULL)).toBeTruthy();
    // The document stays (it was added offline); the user decides what to remove.
    expect(c.snapshot.draft!.payload.documents.map((d) => d.title)).toEqual(['Lease']);
  });
});
