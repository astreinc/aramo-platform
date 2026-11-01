// Consolidated Directive v1.0 B2 — the sender's per-recipient options on the wire:
// witness_for_index in wire order, the access code only while a change is pending, the
// identity check only when changed here, allow_delegation only when changed, and the
// text-delivery choice on its own route after the recipients exist.
import { createDraftStore } from '../../../state/draftStore';
import { createEncryptedStore } from '../../../state/encryptedStore';
import { memoryFiles, memoryKv, nodeAesGcm } from '../../../testing/fakes';
import { createDocumentBytesStore } from '../documentBytes';
import type { DraftRecipient } from '../draftModel';
import {
  changeKind,
  recipientsToWire,
  validAccessCode,
  validPhone,
} from '../recipientRoles';
import { createSenderApi, messagingToWire } from '../senderApi';
import { messagingOffered, NO_SEND_FEATURES, sendFeaturesOf } from '../sendFeatures';
import { SendFlowController } from '../sendFlowController';
import { fakeSenderServer } from './fakeSenderServer';

const PDF = new Uint8Array(
  Buffer.from(
    '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\ntrailer << /Root 1 0 R >>\nstartxref\n0\n%%EOF\n',
    'latin1',
  ),
);

const r = (key: string, kind: DraftRecipient['kind'], extra: Partial<DraftRecipient> = {}): DraftRecipient => ({
  key,
  serverId: null,
  name: key,
  email: `${key}@example.com`,
  kind,
  ...extra,
});

describe('B2 — recipients on the wire', () => {
  it('a witness names its signer by position in the wire order (copies last)', () => {
    const list = [
      r('cc', 'RECEIVES_COPY', { copyDelivery: 'ON_COMPLETION' }),
      r('w', 'WITNESS', { witnessForKey: 'b' }),
      r('a', 'SIGNER'),
      r('b', 'SIGNER'),
    ];
    const wire = recipientsToWire(list);
    expect(wire.map((x) => x.name)).toEqual(['w', 'a', 'b', 'cc']);
    expect(wire[0]).toMatchObject({ recipient_kind: 'WITNESS', witness_for_index: 2 });
    expect(wire[1]).not.toHaveProperty('witness_for_index');
    // A witness without a target is sent as null (the server answers witness_for_required).
    expect(recipientsToWire([r('w', 'WITNESS'), r('a', 'SIGNER')])[0]).toMatchObject({ witness_for_index: null });
  });

  it('the access code goes only while a change is pending; the identity check only when changed', () => {
    const [kept, set, cleared] = recipientsToWire([
      r('a', 'SIGNER', { accessCodeSet: true, identityCheck: 'ID_VERIFICATION' }),
      r('b', 'SIGNER', { accessCode: ' 4821 ', identityCheck: 'KBA', identityDirty: true }),
      r('c', 'WITNESS', { accessCode: null, identityCheck: null, identityDirty: true, witnessForKey: 'a' }),
    ]);
    expect(kept).not.toHaveProperty('access_code');
    expect(kept).not.toHaveProperty('identity_verification_method');
    expect(set).toMatchObject({ access_code: '4821', identity_verification_method: 'KBA' });
    expect(cleared).toMatchObject({ access_code: null, identity_verification_method: null });
  });

  it('a recipient leaving the link kinds drops its code, identity check, text delivery and any witness pointing at it', () => {
    const list = [
      r('a', 'SIGNER', {
        accessCodeSet: true,
        identityCheck: 'ID_VERIFICATION',
        messaging: { channel: 'SMS', smsOtp: true, phone: '+14155550123' },
      }),
      r('w', 'WITNESS', { witnessForKey: 'a' }),
    ];
    const out = changeKind(list, 'a', 'RECEIVES_COPY');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const [a, w] = out.recipients;
    expect(a).toMatchObject({ accessCode: null, identityCheck: null, identityDirty: true, messagingDirty: true });
    expect(a!.messaging).toEqual({ channel: null, smsOtp: false, phone: '' });
    expect(w!.witnessForKey).toBeNull();
  });

  it('validates the access code (4–32 printable) and E.164 phone numbers', () => {
    expect(validAccessCode('123')).toBe(false);
    expect(validAccessCode(' 1234 ')).toBe(true);
    expect(validAccessCode('x'.repeat(33))).toBe(false);
    expect(validAccessCode('ab\ncd')).toBe(false);
    expect(validPhone('+14155550123')).toBe(true);
    expect(validPhone('4155550123')).toBe(false);
    expect(validPhone('+0123456789')).toBe(false);
    expect(validPhone('+1 415 555 0123')).toBe(false);
    expect(messagingToWire({ channel: null, smsOtp: false, phone: '+14155550123' })).toEqual({
      delivery_channel: null,
      sms_otp_required: false,
    });
  });

  it('reads the options from the sender context (absent = off)', () => {
    expect(sendFeaturesOf(undefined)).toEqual(NO_SEND_FEATURES);
    const f = sendFeaturesOf({ features: { witness_signing: true, sms_otp: true, kba: true, access_code: false } });
    expect(f).toMatchObject({ witness: true, smsCode: true, kba: true, accessCode: false, sms: false });
    expect(messagingOffered(f)).toBe(true);
    expect(messagingOffered(NO_SEND_FEATURES)).toBe(false);
  });
});

function setup() {
  const store = createEncryptedStore({ kv: memoryKv(), cipher: nodeAesGcm, files: memoryFiles() });
  const server = fakeSenderServer();
  let n = 0;
  const c = new SendFlowController({
    drafts: createDraftStore(store),
    bytes: createDocumentBytesStore(store),
    api: createSenderApi(server.workspace),
    loadMessaging: (id) => createSenderApi(server.workspace).messaging(id),
    fetchSource: async () => PDF,
    isOnline: () => true,
    newId: () => `id-${String(++n).padStart(8, '0')}`,
    sleep: async () => undefined,
    now: () => new Date('2026-11-01T10:00:00.000Z'),
  });
  return { c, server };
}

describe('B2 — sync', () => {
  it('saves witness, access code, identity, delegation and text delivery; the code is not kept after saving', async () => {
    const { c, server } = setup();
    await c.open();
    await c.addDocument({ title: 'Lease', filename: 'Lease.pdf', bytes: PDF });
    c.addRecipient({ name: 'Dana Lee', email: 'dana@example.com' });
    c.addRecipient({ name: 'Wes Tan', email: 'wes@example.com' });
    const [dana, wes] = c.snapshot.draft!.payload.recipients;
    expect(c.setRecipientKind(wes!.key, 'WITNESS')).toBeNull();
    c.setWitnessFor(wes!.key, dana!.key);
    expect(c.setAccessCode(dana!.key, '12')).toBe(false);
    expect(c.setAccessCode(dana!.key, '4821')).toBe(true);
    c.setIdentityCheck(dana!.key, 'ID_VERIFICATION');
    c.setMessaging(dana!.key, { channel: 'SMS', phone: '+14155550123' });
    c.setMessaging(wes!.key, { channel: 'SMS' }); // a witness takes no text delivery: ignored
    c.setAllowDelegation(true);
    expect(await c.sync()).toBe(true);

    const env = server.envelope!;
    expect(env.allow_delegation).toBe(true);
    const [sd, sw] = env.recipients;
    expect(sd).toMatchObject({ access_code_set: true, identity_verification_method: 'ID_VERIFICATION' });
    expect(sw).toMatchObject({ recipient_kind: 'WITNESS', witness_for_signer_id: sd!.id });
    expect(server.messaging.get(sd!.id)).toEqual({ delivery_channel: 'SMS', sms_otp_required: false, phone_e164: '+14155550123' });
    expect(server.messaging.has(sw!.id)).toBe(false);

    // The messaging PUT follows the recipients PUT and carries no If-Match.
    const writes = server.calls.filter((x) => x.method !== 'GET').map((x) => `${x.method} ${x.url.split('/envelopes/')[1] ?? 'create'}`);
    const recipientsAt = writes.findIndex((w) => w.endsWith('/recipients'));
    const messagingAt = writes.findIndex((w) => w.endsWith('/messaging'));
    expect(recipientsAt).toBeGreaterThanOrEqual(0);
    expect(messagingAt).toBeGreaterThan(recipientsAt);
    const put = server.calls.find((x) => x.url.endsWith('/messaging'))!;
    expect(put.headers['If-Match']).toBeUndefined();

    const local = c.snapshot.draft!.payload.recipients;
    expect(local[0]).toMatchObject({ accessCodeSet: true, messagingDirty: false });
    expect(local[0]).not.toHaveProperty('accessCode');
    expect(local[0]).not.toHaveProperty('identityDirty');
    expect(JSON.stringify(c.snapshot.draft)).not.toContain('4821');

    // Unchanged: a second save sends no access code, identity or delegation again.
    c.setSubject('Lease 2026');
    expect(await c.sync()).toBe(true);
    const patch = server.calls.filter((x) => x.method === 'PATCH').at(-1)!;
    expect(patch.body).not.toHaveProperty('allow_delegation');
  });

  it('opening a server draft reads its text-delivery choices only while messaging is enabled', async () => {
    const { c, server } = setup();
    await c.open();
    await c.addDocument({ title: 'Lease', filename: 'Lease.pdf', bytes: PDF });
    c.addRecipient({ name: 'Dana Lee', email: 'dana@example.com' });
    const dana = c.snapshot.draft!.payload.recipients[0]!;
    c.setMessaging(dana.key, { smsOtp: true, phone: '+447700900123' });
    expect(await c.sync()).toBe(true);
    await c.flush();

    const reopen = new SendFlowController({
      drafts: createDraftStore(createEncryptedStore({ kv: memoryKv(), cipher: nodeAesGcm, files: memoryFiles() })),
      bytes: createDocumentBytesStore(createEncryptedStore({ kv: memoryKv(), cipher: nodeAesGcm, files: memoryFiles() })),
      api: createSenderApi(server.workspace),
      loadMessaging: (id) => createSenderApi(server.workspace).messaging(id),
      fetchSource: async () => PDF,
      isOnline: () => true,
      newId: () => 'id-reopen01',
    });
    await reopen.open({ envelopeId: server.ENV_ID });
    expect(reopen.snapshot.error).toBeNull();
    expect(reopen.snapshot.draft!.payload.recipients[0]!.messaging).toBeUndefined();
    reopen.setMessagingEnabled(true);
    await reopen.open({ envelopeId: server.ENV_ID });
    expect(reopen.snapshot.draft!.payload.recipients[0]!.messaging).toEqual({
      channel: null,
      smsOtp: true,
      phone: '+447700900123',
    });
  });

  it('a refused phone number is shown in plain words', async () => {
    const { c } = setup();
    await c.open();
    await c.addDocument({ title: 'Lease', filename: 'Lease.pdf', bytes: PDF });
    c.addRecipient({ name: 'Dana Lee', email: 'dana@example.com' });
    const dana = c.snapshot.draft!.payload.recipients[0]!;
    c.setMessaging(dana.key, { channel: 'WHATSAPP', phone: '0123' });
    expect(await c.sync()).toBe(false);
    expect(c.snapshot.error).toBe('Use the international format, for example +14155550123');
  });
});
