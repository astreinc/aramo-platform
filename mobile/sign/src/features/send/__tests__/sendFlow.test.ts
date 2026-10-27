import { createDraftStore } from '../../../state/draftStore';
import { createEncryptedStore } from '../../../state/encryptedStore';
import { memoryFiles, memoryKv, nodeAesGcm, type RecordedRequest } from '../../../testing/fakes';
import { createDocumentBytesStore } from '../documentBytes';
import type { SendDraftPayload } from '../draftModel';
import { createSenderApi } from '../senderApi';
import { CHANGED_ELSEWHERE, SendFlowController } from '../sendFlowController';
import { UPLOAD_ATTEMPTS } from '../syncDraft';
import { fakeSenderServer } from './fakeSenderServer';

const PDF = new Uint8Array(
  Buffer.from(
    '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\ntrailer << /Root 1 0 R >>\nstartxref\n0\n%%EOF\n',
    'latin1',
  ),
);

function setup(
  opts: { online?: boolean; dropFirstUploadResponse?: boolean; refuseFirstUploads?: number } = {},
) {
  const kv = memoryKv();
  const files = memoryFiles();
  const store = createEncryptedStore({ kv, cipher: nodeAesGcm, files });
  const server = fakeSenderServer(opts);
  let n = 0;
  let online = opts.online ?? true;
  const make = () =>
    new SendFlowController({
      drafts: createDraftStore(store),
      bytes: createDocumentBytesStore(store),
      api: createSenderApi(server.workspace),
      fetchSource: async () => PDF,
      isOnline: () => online,
      newId: () => `id-${String(++n).padStart(8, '0')}`,
      sleep: async () => undefined,
      now: () => new Date('2026-10-25T10:00:00.000Z'),
    });
  return {
    server,
    files,
    store,
    make,
    setOnline: (v: boolean) => {
      online = v;
    },
    restart: () => createEncryptedStore({ kv, cipher: nodeAesGcm, files }),
  };
}

async function prepared(c: SendFlowController) {
  await c.open();
  await c.addDocument({ title: 'Offer letter', filename: 'Offer letter.pdf', bytes: PDF });
  c.setStep('recipients');
  expect(c.addRecipient({ name: 'Dana Lee', email: 'dana@example.com' })).toBe('added');
  c.setStep('fields');
  const p = c.snapshot.draft!.payload;
  c.setFields([
    {
      key: 'f1',
      docKey: p.documents[0]!.key,
      page: 0,
      recipientKey: p.recipients[0]!.key,
      type: 'SIGNATURE',
      x: 72,
      y: 642,
      width: 230,
      height: 50,
      required: true,
    },
  ]);
  await c.flush();
}

const writes = (calls: readonly RecordedRequest[]) => calls.filter((r) => r.method !== 'GET');

describe('Send flow: concurrency (M-A3 §6)', () => {
  it('sends If-Match with the previous ETag on every write, and Idempotency-Key on upload', async () => {
    const t = setup();
    const c = t.make();
    await prepared(c);
    const sent = await c.send();
    expect(sent).toEqual({ envelopeId: t.server.ENV_ID, signers: 1 });
    expect(t.server.envelope!.status).toBe('SENT');

    const w = writes(t.server.calls);
    expect(w.map((r) => `${r.method} ${r.url.split('/envelopes')[1] ?? ''}`)).toEqual([
      'POST ',
      'POST /11111111-2222-4333-8444-555555555555/documents',
      'PATCH /11111111-2222-4333-8444-555555555555',
      'PUT /11111111-2222-4333-8444-555555555555/recipients',
      'PUT /11111111-2222-4333-8444-555555555555/fields',
      'POST /11111111-2222-4333-8444-555555555555/send',
    ]);
    // Create is the only write without a version (there is no envelope yet).
    for (const r of w.slice(1))
      expect(r.headers['If-Match']).toMatch(/^"11111111-2222-4333-8444-555555555555\.\d+"$/);
    expect(w[1]!.headers['Idempotency-Key']).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    // Each write carries the revision the previous response produced: 1, 2, 3, 4, 5.
    expect(w.slice(1).map((r) => r.headers['If-Match'])).toEqual(
      [1, 2, 3, 4, 5].map((v) => `"${t.server.ENV_ID}.${v}"`),
    );
    // The field reached the server in PDF-native geometry (bottom-left origin).
    expect(w[4]!.body!['fields']).toEqual([
      expect.objectContaining({
        field_type: 'SIGNATURE',
        page_number: 0,
        x: 72,
        y: 100,
        width: 230,
        height: 50,
        required: true,
      }),
    ]);
  });

  it('on 412 refreshes, shows "changed elsewhere" and never overwrites the other change', async () => {
    const t = setup();
    const c = t.make();
    await prepared(c);
    expect(await c.saveDraft()).toBe('synced');
    // The web editor changes the subject and recipients meanwhile.
    t.server.editElsewhere((e) => {
      e.subject = 'Changed on the web';
      e.recipients = [
        {
          id: 'sig-web',
          name: 'Web Person',
          email: 'web@example.com',
          status: 'PENDING',
          signing_order: 0,
        },
      ];
      e.fields = [];
    });
    const before = t.server.calls.length;
    c.setMessage('Please sign by Friday');
    expect(await c.sync()).toBe(false);

    const after = t.server.calls.slice(before);
    const failed = after.filter((r) => r.method !== 'GET');
    expect(failed).toHaveLength(1); // the one stale PATCH, refused with 412; nothing after it
    expect(t.server.envelope!.subject).toBe('Changed on the web');
    expect(t.server.envelope!.message).toBeNull();
    const s = c.snapshot;
    expect(s.notice).toBe(CHANGED_ELSEWHERE);
    expect(CHANGED_ELSEWHERE).toMatch(/^This envelope changed elsewhere/);
    expect(s.draft!.payload.recipients.map((r) => r.email)).toEqual(['web@example.com']);
    expect(s.draft!.payload.etag).toBe(`"${t.server.ENV_ID}.${t.server.envelope!.revision}"`);
  });

  it('a 412 on send leaves the envelope unsent and shows the latest version', async () => {
    const t = setup();
    const c = t.make();
    await prepared(c);
    await c.saveDraft();
    t.server.editElsewhere((e) => {
      e.subject = 'Edited elsewhere';
    });
    expect(await c.send()).toBeNull();
    expect(t.server.envelope!.status).toBe('DRAFT');
    expect(c.snapshot.notice).toBe(CHANGED_ELSEWHERE);
  });
});

describe('Send flow: a sync that fails part-way', () => {
  it('a retry continues the envelope it already created, never a second one', async () => {
    // Every upload attempt of the first sync fails (3 tries), after the create succeeded.
    const t = setup({ refuseFirstUploads: 3 });
    const c = t.make();
    await prepared(c);
    expect(await c.sync()).toBe(false);
    expect(c.snapshot.draft!.envelopeId).toBe(t.server.ENV_ID);
    expect(c.snapshot.draft!.payload.recipients).toHaveLength(1);

    expect(await c.sync()).toBe(true);
    const creates = t.server.calls.filter(
      (r) => r.method === 'POST' && r.url.endsWith('/v1/sign/sender/envelopes'),
    );
    expect(creates).toHaveLength(1);
    expect(c.snapshot.draft!.payload.documents[0]!.serverId).toBeTruthy();
  });
});

describe('Send flow: removing an uploaded document', () => {
  it('deletes it on the server with If-Match and drops its fields', async () => {
    const t = setup();
    const c = t.make();
    await prepared(c);
    await c.saveDraft();
    const rev = t.server.envelope!.revision;
    await c.removeDocument(c.snapshot.draft!.payload.documents[0]!.key);
    const del = t.server.calls.filter((r) => r.method === 'DELETE');
    expect(del).toHaveLength(1);
    expect(del[0]!.headers['If-Match']).toBe(`"${t.server.ENV_ID}.${rev}"`);
    expect(t.server.envelope!.documents).toHaveLength(0);
    expect(c.snapshot.draft!.payload.fields).toHaveLength(0);
    expect(c.snapshot.draft!.payload.etag).toBe(`"${t.server.ENV_ID}.${rev + 1}"`);
  });
});

describe('Send flow: idempotent upload (M-A3 §8)', () => {
  it('retries a lost upload response with the SAME key and attaches the document once', async () => {
    const t = setup({ dropFirstUploadResponse: true });
    const c = t.make();
    await prepared(c);
    expect(await c.saveDraft()).toBe('synced');
    const uploads = t.server.calls.filter((r) => r.url.endsWith('/documents'));
    expect(uploads).toHaveLength(2);
    expect(UPLOAD_ATTEMPTS).toBeGreaterThanOrEqual(2);
    expect(uploads[1]!.headers['Idempotency-Key']).toBe(uploads[0]!.headers['Idempotency-Key']);
    expect(uploads[1]!.headers['If-Match']).toBe(uploads[0]!.headers['If-Match']);
    expect(t.server.envelope!.documents).toHaveLength(1);
    expect(c.snapshot.draft!.payload.documents[0]!.pendingUpload).toBeNull();
  });
});

describe('Send flow: offline drafts (directive §9)', () => {
  it('persists preparation encrypted and recovers it after a restart', async () => {
    const t = setup({ online: false });
    const c = t.make();
    await prepared(c);
    expect(await c.saveDraft()).toBe('local');
    expect(t.server.calls).toHaveLength(0); // offline: nothing reached the server
    const localId = c.snapshot.draft!.localId;
    const onDisk = [...t.files.files.values()].join('');
    expect(onDisk).not.toContain('Dana');
    expect(onDisk).not.toContain('dana@example.com');
    expect(onDisk).not.toContain('%PDF');

    // "Kill the app": a new store instance and controller over the same key and files.
    const store = t.restart();
    const recovered = new SendFlowController({
      drafts: createDraftStore(store),
      bytes: createDocumentBytesStore(store),
      api: createSenderApi(t.server.workspace),
      fetchSource: async () => PDF,
      isOnline: () => true,
      newId: () => 'id-recovered',
      sleep: async () => undefined,
    });
    await recovered.open({ localDraftId: localId });
    const p: SendDraftPayload = recovered.snapshot.draft!.payload;
    expect(recovered.snapshot.step).toBe('fields');
    expect(p.recipients.map((r) => r.email)).toEqual(['dana@example.com']);
    expect(p.fields).toHaveLength(1);
    expect(p.documents[0]!.pendingUpload).not.toBeNull();
    expect((await recovered.documentAsset(p.documents[0]!.key)).pages).toEqual([
      { width: 612, height: 792 },
    ]);

    // Back online: it syncs and sends, uploading the document kept on the device.
    expect(await recovered.send()).toEqual({ envelopeId: t.server.ENV_ID, signers: 1 });
    expect(t.server.envelope!.documents).toHaveLength(1);
    await expect(createDraftStore(store).load(localId)).resolves.toBeNull();
  });

  it('never sends while offline', async () => {
    const t = setup({ online: false });
    const c = t.make();
    await prepared(c);
    expect(await c.send()).toBeNull();
    expect(t.server.calls).toHaveLength(0);
    expect(c.snapshot.error).toMatch(/offline/i);
  });

  it('"Continue editing" opens a server draft at the furthest step with data', async () => {
    const t = setup();
    const c = t.make();
    await prepared(c);
    await c.saveDraft();
    await c.discard(); // forget the local copy; the server draft stays
    const again = t.make();
    await again.open({ envelopeId: t.server.ENV_ID });
    expect(again.snapshot.status).toBe('ready');
    expect(again.snapshot.step).toBe('review');
    const f = again.snapshot.draft!.payload.fields[0]!;
    // Back in the editor frame (top-left origin): y = 792 - 100 - 50.
    expect(f).toMatchObject({ type: 'SIGNATURE', x: 72, y: 642, width: 230, height: 50 });
  });
});

describe('Recipients: every recipient signs (C-11)', () => {
  it('has no copy-only role and caps at 10', async () => {
    const t = setup();
    const c = t.make();
    await c.open();
    for (let i = 0; i < 10; i += 1)
      expect(c.addRecipient({ name: `P${i}`, email: `p${i}@example.com` })).toBe('added');
    expect(c.addRecipient({ name: 'Eleven', email: 'p10@example.com' })).toBe('full');
    const r = c.snapshot.draft!.payload.recipients[0]!;
    expect(Object.keys(r).sort()).toEqual(['email', 'key', 'name', 'serverId']);
    expect(c.addRecipient({ name: 'Dup', email: 'P1@EXAMPLE.com' })).toBe('full');
  });

  it('reorders for sequential routing and refuses duplicates', async () => {
    const t = setup();
    const c = t.make();
    await c.open();
    c.addRecipient({ name: 'A', email: 'a@example.com' });
    c.addRecipient({ name: 'B', email: 'b@example.com' });
    expect(c.addRecipient({ name: 'A again', email: 'A@example.com' })).toBe('duplicate');
    c.setRouting('SEQUENTIAL');
    c.moveRecipient(c.snapshot.draft!.payload.recipients[1]!.key, -1);
    expect(c.snapshot.draft!.payload.recipients.map((r) => r.name)).toEqual(['B', 'A']);
    expect(c.snapshot.draft!.payload.routingMode).toBe('SEQUENTIAL');
  });
});
