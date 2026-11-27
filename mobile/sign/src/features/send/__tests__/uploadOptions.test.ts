// FIELD-PARITY-2 A-3 (G-4) — the Send flow's upload options (sign-web's two choices) and a sync
// that keeps the fields the server made: after an opted-in upload the server's fields are the
// base, local edits apply on top, and a replace-all fields PUT never removes a server-made field
// the user did not delete (an offline edit and a re-sync included).
import { createDraftStore } from '../../../state/draftStore';
import { createEncryptedStore } from '../../../state/encryptedStore';
import { memoryFiles, memoryKv, nodeAesGcm, type RecordedRequest } from '../../../testing/fakes';
import { createDocumentBytesStore } from '../documentBytes';
import { createSenderApi } from '../senderApi';
import { SendFlowController, removedAttachmentsNotice } from '../sendFlowController';
import { fakeSenderServer } from './fakeSenderServer';

const PDF = new Uint8Array(
  Buffer.from(
    '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\ntrailer << /Root 1 0 R >>\nstartxref\n0\n%%EOF\n',
    'latin1',
  ),
);

function setup(serverOpts: Parameters<typeof fakeSenderServer>[0] = {}) {
  const store = createEncryptedStore({ kv: memoryKv(), cipher: nodeAesGcm, files: memoryFiles() });
  const server = fakeSenderServer(serverOpts);
  let online = true;
  let n = 0;
  const c = new SendFlowController({
    drafts: createDraftStore(store),
    bytes: createDocumentBytesStore(store),
    api: createSenderApi(server.workspace),
    fetchSource: async () => PDF,
    isOnline: () => online,
    newId: () => `id-${String(++n).padStart(8, '0')}`,
    sleep: async () => undefined,
    now: () => new Date('2026-11-23T10:00:00.000Z'),
  });
  return { c, server, setOnline: (v: boolean) => (online = v) };
}

const writes = (calls: readonly RecordedRequest[]) => calls.filter((r) => r.method !== 'GET');
const path = (r: RecordedRequest) => `${r.method} ${(r.url.split('/envelopes')[1] ?? '').replace(/^\/[^/]+/, '')}`;
const lastFieldsPut = (calls: readonly RecordedRequest[]) =>
  (writes(calls).filter((r) => r.url.endsWith('/fields')).at(-1)?.body?.['fields'] ?? []) as Record<string, unknown>[];

async function preparedWithImport(c: SendFlowController) {
  await c.open();
  c.setUploadOptions({ importFields: true, applyTextTags: false });
  await c.addDocument({ title: 'Lease', filename: 'Lease.pdf', bytes: PDF });
  c.setStep('recipients');
  expect(c.addRecipient({ name: 'Dana Lee', email: 'dana@example.com' })).toBe('added');
  const p = c.snapshot.draft!.payload;
  c.setFields([
    { key: 'mine', docKey: p.documents[0]!.key, page: 0, recipientKey: p.recipients[0]!.key, type: 'INITIALS', x: 400, y: 700, width: 60, height: 30, required: true },
  ]);
  await c.flush();
}

describe('upload options (FIELD-PARITY-2 A-3)', () => {
  it('a chosen option goes with the upload; an unchosen one is never sent', async () => {
    const t = setup();
    await t.c.open();
    // Offline, so both wait for upload (online, a PDF is uploaded as it is added; UAT DOC-06).
    t.setOnline(false);
    await t.c.addDocument({ title: 'Plain', filename: 'Plain.pdf', bytes: PDF });
    t.c.setUploadOptions({ importFields: false, applyTextTags: true });
    await t.c.addDocument({ title: 'Tagged', filename: 'Tagged.pdf', bytes: PDF });
    t.setOnline(true);
    const docs = t.c.snapshot.draft!.payload.documents;
    // A pending document follows the options until it is uploaded.
    expect(docs.map((d) => d.pendingUpload && { i: d.pendingUpload.importFields, t: d.pendingUpload.applyTextTags })).toEqual([
      { i: undefined, t: true },
      { i: undefined, t: true },
    ]);
    t.c.setStep('recipients');
    t.c.addRecipient({ name: 'Dana Lee', email: 'dana@example.com' });
    expect(await t.c.sync()).toBe(true);
    const uploads = writes(t.server.calls).filter((r) => r.url.endsWith('/documents'));
    expect(uploads.map((u) => [u.body?.['import_fields'], u.body?.['apply_text_tags']])).toEqual([
      [undefined, true],
      [undefined, true],
    ]);
  });

  it('recipients go before an opted-in upload; the server-made fields join the draft and the PUT', async () => {
    const t = setup();
    await preparedWithImport(t.c);
    expect(await t.c.sync()).toBe(true);
    // Adding the document online created the envelope (UAT DOC-06); its opted-in upload waited
    // for a signing recipient, so the recipients still go before it.
    expect(writes(t.server.calls).map(path)).toEqual(['POST ', 'PATCH ', 'PUT /recipients', 'POST /documents', 'PUT /fields']);
    // The local field and both server-made fields, with their settings.
    const put = lastFieldsPut(t.server.calls);
    expect(put.map((f) => f['field_type'])).toEqual(['INITIALS', 'TEXT', 'SIGNATURE']);
    expect(put[1]).toMatchObject({ label: 'Full name', tooltip: 'As on your ID', x: 100, y: 500 });
    const p = t.c.snapshot.draft!.payload;
    expect(p.fields.map((f) => f.type)).toEqual(['INITIALS', 'TEXT', 'SIGNATURE']);
    expect(t.server.envelope!.fields).toHaveLength(3);
    // The import summary, in the shared words.
    expect(t.c.snapshot.notice).toMatch(/^Lease: 2 fields added · 1 warning · active content removed\nA hidden form field was skipped\.$/);
  });

  it('a server-made field survives an offline edit and a re-sync; one the user deleted is gone', async () => {
    const t = setup();
    await preparedWithImport(t.c);
    expect(await t.c.sync()).toBe(true);
    // Offline: move the user's own field (the draft is saved on the device).
    t.setOnline(false);
    const p = t.c.snapshot.draft!.payload;
    t.c.setFields(p.fields.map((f) => (f.key === 'mine' ? { ...f, x: f.x + 20 } : f)));
    await t.c.flush();
    expect(await t.c.sync()).toBe(false);
    // Back online: the replace-all PUT keeps both server-made fields.
    t.setOnline(true);
    expect(await t.c.sync()).toBe(true);
    let put = lastFieldsPut(t.server.calls);
    expect(put.map((f) => f['field_type'])).toEqual(['INITIALS', 'TEXT', 'SIGNATURE']);
    expect(put[0]).toMatchObject({ x: 420 });
    expect(put[1]).toMatchObject({ label: 'Full name', tooltip: 'As on your ID' });
    // The user deletes the imported text field: only that one goes.
    const q = t.c.snapshot.draft!.payload;
    t.c.setFields(q.fields.filter((f) => f.type !== 'TEXT'));
    expect(await t.c.sync()).toBe(true);
    put = lastFieldsPut(t.server.calls);
    expect(put.map((f) => f['field_type'])).toEqual(['INITIALS', 'SIGNATURE']);
  });

  it('with no signing recipient yet an opted-in upload waits (and so do the fields)', async () => {
    const t = setup();
    await t.c.open();
    t.c.setUploadOptions({ importFields: true, applyTextTags: false });
    await t.c.addDocument({ title: 'Lease', filename: 'Lease.pdf', bytes: PDF });
    expect(await t.c.sync()).toBe(true);
    expect(writes(t.server.calls).map(path)).toEqual(['POST ', 'PATCH ']);
    expect(t.c.snapshot.draft!.payload.documents[0]!.pendingUpload).not.toBeNull();
    t.c.setStep('recipients');
    t.c.addRecipient({ name: 'Dana Lee', email: 'dana@example.com' });
    expect(await t.c.sync()).toBe(true);
    expect(writes(t.server.calls).map(path).slice(2)).toEqual(['PUT /recipients', 'POST /documents', 'PUT /fields']);
    expect(t.c.snapshot.draft!.payload.fields.map((f) => f.type)).toEqual(['TEXT', 'SIGNATURE']);
  });
});

// PDF-ATTACH-1 ATT-8 — the server removed a PDF's attached files: the app says so in the shared words.
describe('attached files removed (PDF-ATTACH-1)', () => {
  it('a PDF added online whose attached files were removed shows the shared notice', async () => {
    const t = setup({ attachmentsRemoved: 1 });
    await t.c.open();
    await t.c.addDocument({ title: 'Incorporation', filename: 'Incorporation.pdf', bytes: PDF });
    t.c.setStep('recipients');
    t.c.addRecipient({ name: 'Dana Lee', email: 'dana@example.com' });
    expect(await t.c.sync()).toBe(true);
    expect(writes(t.server.calls).some((r) => r.url.endsWith('/documents'))).toBe(true);
    expect(t.c.snapshot.notice).toBe('Incorporation: We removed 1 attached file from this PDF. Attached files can’t be signed, so they aren’t sent.');
  });

  it('nothing removed, nothing said', async () => {
    const t = setup();
    await t.c.open();
    await t.c.addDocument({ title: 'Plain', filename: 'Plain.pdf', bytes: PDF });
    t.c.setStep('recipients');
    t.c.addRecipient({ name: 'Dana Lee', email: 'dana@example.com' });
    expect(await t.c.sync()).toBe(true);
    expect(t.c.snapshot.notice).toBeNull();
  });

  it('the notice lists each document, in the shared words', () => {
    expect(removedAttachmentsNotice([])).toBeNull();
    expect(removedAttachmentsNotice(undefined)).toBeNull();
    expect(removedAttachmentsNotice([{ title: 'A', count: 2 }, { title: 'B', count: 0 }])).toBe('A: We removed 2 attached files from this PDF. Attached files can’t be signed, so they aren’t sent.');
  });
});
