// FIELD-PARITY-2 B-1 / B-2 / B-7 — the Send flow carries every field's key and condition: a field
// read from the server keeps its field_key as its editor key, a new field is saved with its key as
// its field_key, and a condition (authored here or on the web) survives an offline edit and a
// re-sync. Before this, a mobile re-save sent no key (the server blanked every key) and no
// condition (every condition was silently dropped).
import { createDraftStore } from '../../../state/draftStore';
import { createEncryptedStore } from '../../../state/encryptedStore';
import { memoryFiles, memoryKv, nodeAesGcm, type RecordedRequest } from '../../../testing/fakes';
import { createDocumentBytesStore } from '../documentBytes';
import { editorFieldsFromServer, parseEnvelope, type ServerField } from '../draftModel';
import { createSenderApi } from '../senderApi';
import { SendFlowController } from '../sendFlowController';
import { fieldsToWire, storedFieldWire } from '../syncDraft';
import { fakeSenderServer } from './fakeSenderServer';

const PDF = new Uint8Array(
  Buffer.from(
    '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\ntrailer << /Root 1 0 R >>\nstartxref\n0\n%%EOF\n',
    'latin1',
  ),
);

function setup() {
  const store = createEncryptedStore({ kv: memoryKv(), cipher: nodeAesGcm, files: memoryFiles() });
  const server = fakeSenderServer();
  let online = true;
  let n = 0;
  const make = () =>
    new SendFlowController({
      drafts: createDraftStore(store),
      bytes: createDocumentBytesStore(store),
      api: createSenderApi(server.workspace),
      fetchSource: async () => PDF,
      isOnline: () => online,
      newId: () => `id-${String(++n).padStart(8, '0')}`,
      sleep: async () => undefined,
      now: () => new Date('2026-11-23T10:00:00.000Z'),
    });
  return { make, server, setOnline: (v: boolean) => (online = v) };
}

const lastFieldsPut = (calls: readonly RecordedRequest[]) =>
  (calls.filter((r) => r.method === 'PUT' && r.url.endsWith('/fields')).at(-1)?.body?.['fields'] ?? []) as Record<string, unknown>[];

const SHOWN_WHEN_CHECKED = { trigger_key: 'agree', when: 'checked' } as const;

async function prepared(c: SendFlowController) {
  await c.open();
  await c.addDocument({ title: 'Lease', filename: 'Lease.pdf', bytes: PDF });
  c.setStep('recipients');
  expect(c.addRecipient({ name: 'Dana Lee', email: 'dana@example.com' })).toBe('added');
  c.setStep('fields');
  const p = c.snapshot.draft!.payload;
  const base = { docKey: p.documents[0]!.key, page: 0, recipientKey: p.recipients[0]!.key } as const;
  c.setFields([
    { ...base, key: 'sig', type: 'SIGNATURE', x: 72, y: 642, width: 230, height: 50, required: true },
    { ...base, key: 'agree', type: 'CHECKBOX', x: 72, y: 600, width: 18, height: 18, required: false, label: 'Co-applicant' },
    { ...base, key: 'co_name', type: 'TEXT', x: 100, y: 600, width: 200, height: 24, required: true, condition: SHOWN_WHEN_CHECKED },
  ]);
  await c.flush();
}

describe('Send flow: field keys and conditions (FIELD-PARITY-2 B-1 / B-2)', () => {
  it('saves every field with its key as field_key, and the condition with its field', async () => {
    const t = setup();
    const c = t.make();
    await prepared(c);
    expect(await c.sync()).toBe(true);
    const put = lastFieldsPut(t.server.calls);
    expect(put.map((f) => f['field_key'])).toEqual(['sig', 'agree', 'co_name']);
    expect(put.map((f) => f['condition'] ?? null)).toEqual([null, null, SHOWN_WHEN_CHECKED]);
  });

  it('a condition and the keys survive a reopen, an offline edit and a re-sync', async () => {
    const t = setup();
    const first = t.make();
    await prepared(first);
    await first.saveDraft();
    await first.discard(); // forget the local copy; the server draft stays
    const c = t.make();
    await c.open({ envelopeId: t.server.ENV_ID });
    const loaded = c.snapshot.draft!.payload.fields;
    // The server's field_key is the editor key again, so the condition still names its trigger.
    expect(loaded.map((f) => f.key)).toEqual(['sig', 'agree', 'co_name']);
    expect(loaded[2]!.condition).toEqual(SHOWN_WHEN_CHECKED);
    // Offline: move the dependent field (the draft is saved on the device).
    t.setOnline(false);
    c.setFields(loaded.map((f) => (f.key === 'co_name' ? { ...f, x: f.x + 10 } : f)));
    await c.flush();
    expect(await c.sync()).toBe(false);
    // Back online: the replace-all PUT keeps every key and the condition.
    t.setOnline(true);
    expect(await c.sync()).toBe(true);
    const put = lastFieldsPut(t.server.calls);
    expect(put.map((f) => f['field_key'])).toEqual(['sig', 'agree', 'co_name']);
    expect(put[2]).toMatchObject({ x: 110, condition: SHOWN_WHEN_CHECKED });
    expect(t.server.envelope!.fields.map((f) => f['condition'] ?? null)).toEqual([null, null, SHOWN_WHEN_CHECKED]);
  });

  it('a new field gets its own key; a stored engine field goes back with its key and condition', async () => {
    const t = setup();
    const c = t.make();
    await prepared(c);
    expect(await c.sync()).toBe(true);
    const p = c.snapshot.draft!.payload;
    const engine: ServerField = {
      id: 'row-9',
      envelope_document_id: p.documents[0]!.serverId!,
      signer_id: null,
      field_type: 'ACKNOWLEDGEMENT',
      page_number: 0,
      x: 1,
      y: 2,
      width: null,
      height: null,
      required: true,
      name_mode: null,
      label: null,
      group_key: null,
      group_rule: null,
      min_selected: null,
      field_key: 'ack_1',
    };
    const wire = fieldsToWire({
      ...p,
      fields: [...p.fields, { ...p.fields[0]!, key: 'f-new-1', y: 500 }],
      preservedFields: [engine],
    });
    expect(wire.map((f) => f.field_key)).toEqual(['sig', 'agree', 'co_name', 'f-new-1', 'ack_1']);
    expect(storedFieldWire({ ...engine, condition: SHOWN_WHEN_CHECKED })).toMatchObject({ field_key: 'ack_1', condition: SHOWN_WHEN_CHECKED });
  });

  it('never sends a key twice: a local key that a stored field already uses goes without one', () => {
    const p = {
      documents: [{ key: 'd', serverId: 'D', title: 'T', filename: 'T.pdf', pages: [{ width: 612, height: 792 }], pendingUpload: null }],
      recipients: [{ key: 'r', serverId: 'R', name: 'Dana', email: 'd@example.com' }],
      fields: [{ key: 'dup', docKey: 'd', page: 0, recipientKey: 'r', type: 'TEXT' as const, x: 1, y: 1, width: 10, height: 10, required: false }],
      preservedFields: [{ ...storedLike('dup') }],
    };
    const wire = fieldsToWire(p as unknown as Parameters<typeof fieldsToWire>[0]);
    expect(wire.map((f) => f.field_key ?? null)).toEqual([null, 'dup']);
  });
});

function storedLike(field_key: string): ServerField {
  return {
    id: 'row-1',
    envelope_document_id: 'D',
    signer_id: 'R',
    field_type: 'ACKNOWLEDGEMENT',
    page_number: 0,
    x: 0,
    y: 0,
    width: null,
    height: null,
    required: true,
    name_mode: null,
    label: null,
    group_key: null,
    group_rule: null,
    min_selected: null,
    field_key,
  };
}

describe('reading the server copy (FIELD-PARITY-2 B-1 / B-2)', () => {
  const field = (over: Record<string, unknown>) => ({
    id: 'x',
    envelope_document_id: 'D',
    signer_id: 'R',
    field_type: 'TEXT',
    page_number: 0,
    x: 10,
    y: 10,
    width: 100,
    height: 20,
    required: true,
    ...over,
  });

  it('parses field_key and condition; a broken condition or key reads as none', () => {
    const env = parseEnvelope({
      fields: [
        field({ field_key: 'a', condition: { trigger_key: 'b', when: 'one_of', values: ['Yes'] } }),
        field({ field_key: '', condition: { trigger_key: 'b', when: 'sometimes' } }),
        field({}),
      ],
    });
    expect(env.fields.map((f) => [f.field_key ?? null, f.condition ?? null])).toEqual([
      ['a', { trigger_key: 'b', when: 'one_of', values: ['Yes'] }],
      [null, null],
      [null, null],
    ]);
  });

  it('a field without a stored key gets one that no stored field uses', () => {
    const env = parseEnvelope({
      fields: [field({ id: 'r1', field_key: 'srv-1' }), field({ id: 'r2' }), field({ id: 'r3', field_key: 'kept', condition: { trigger_key: 'srv-1', when: 'unchecked' } })],
    });
    const pages = new Map([['D', [{ width: 612, height: 792 }]]]);
    const { fields } = editorFieldsFromServer(env.fields, pages, (id) => id, (_f, i) => `srv-${i}`);
    expect(fields.map((f) => f.key)).toEqual(['srv-1', 'srv-1-1', 'kept']);
    expect(fields[2]!.condition).toEqual({ trigger_key: 'srv-1', when: 'unchecked' });
  });
});
