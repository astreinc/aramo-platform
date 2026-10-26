import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { REQUIRED_SCOPES_KEY } from '@aramo/authorization';
import { EsignSenderConsumerGuard } from '@aramo/identity';
import {
  EnvelopeRevisionMismatchError,
  IdempotencyKeyReuseError,
  IdempotencyRequestInProgressError,
  ReminderLimitError,
  SIGN_REMINDER_LIMITS,
  SignContactDuplicateError,
} from '@aramo/sign';
import { describe, expect, it, vi } from 'vitest';

import { EsignSenderController } from '../app/sender/esign-sender.controller.js';
import { envelopeEtag, expectedRevision, idempotencyKey, sanitizeMessage, senderHttp } from '../app/sender/envelope-contracts.js';
import { SenderEnvelopeService } from '../app/sender/sender-envelope.service.js';
import { SavedSignatureController } from '../app/me/signature/saved-signature.controller.js';
import { imageDimensions, validateSavedSignature } from '../app/me/signature/saved-signature.service.js';
import { SavedDataPurgeService } from '../app/me/signature/saved-data-purge.service.js';
import { SignAccountService } from '../app/account/sign-account.service.js';

// Aramo Sign Mobile — envelope contracts (M-A3 §3–§8): If-Match / ETag, the sender
// message, the expiry fields, reminder limits + idempotency, contacts, saved
// signatures. Unit level; the database guarantees are proven in libs/sign
// envelope-contracts.integration.spec.ts and the HTTP surface in
// sign-mobile-contracts.integration.spec.ts.

const ENV = 'e5000000-0000-7000-8000-0000000000a1';
const BROWSER: AuthContextType = {
  sub: '11111111-1111-7111-8111-111111111111',
  consumer_type: 'sign',
  actor_kind: 'user',
  tenant_id: '22222222-2222-7222-8222-222222222222',
  scopes: ['sign:envelope:read', 'sign:envelope:create', 'sign:envelope:send', 'sign:contact:read'],
  iat: 0,
  exp: 0,
};
const NATIVE: AuthContextType = { ...BROWSER, client: 'native', dsid: 'ds-1' };

// 1×1 PNG and a minimal JPEG header with a 2×3 SOF0.
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const JPEG_2X3 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x03, 0x00, 0x02, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]).toString('base64');

describe('If-Match → expected revision (M-A3 §6)', () => {
  it('a native token without If-Match is refused 428 precondition_required', () => {
    expect(() => expectedRevision(NATIVE, undefined, ENV, 'r')).toThrow(expect.objectContaining({ statusCode: 428, context: expect.objectContaining({ details: { reason: 'precondition_required' } }) }));
    expect(() => expectedRevision(NATIVE, '  ', ENV, 'r')).toThrow(expect.objectContaining({ statusCode: 428 }));
  });
  it('a browser token may omit it (temporary web compatibility)', () => {
    expect(expectedRevision(BROWSER, undefined, ENV, 'r')).toBeUndefined();
  });
  it('the strong validator round-trips, quoted or bare; any other value can never match', () => {
    expect(envelopeEtag(ENV, 7)).toBe(`"${ENV}.7"`);
    expect(expectedRevision(NATIVE, envelopeEtag(ENV, 7), ENV, 'r')).toBe(7);
    expect(expectedRevision(BROWSER, `${ENV}.3`, ENV, 'r')).toBe(3);
    expect(expectedRevision(NATIVE, `"e5000000-0000-7000-8000-0000000000ff.7"`, ENV, 'r')).toBe(-1);
    expect(expectedRevision(NATIVE, `W/"${ENV}.7"`, ENV, 'r')).toBe(-1);
    expect(expectedRevision(NATIVE, '*', ENV, 'r')).toBe(-1);
  });
});

describe('sender message sanitizing (M-A3 §3)', () => {
  it('strips control and bidi-override characters, keeps line breaks, trims', () => {
    expect(sanitizeMessage('  Hi\u0000 there\r\nPlease \u202Esign\u0007 by Friday  ', 'r')).toBe('Hi there\nPlease sign by Friday');
    expect(sanitizeMessage('<b>bold</b>', 'r')).toBe('<b>bold</b>'); // plain text: kept verbatim, escaped wherever shown
  });
  it('empty clears; over 1000 characters is refused; non-text is refused', () => {
    expect(sanitizeMessage('   ', 'r')).toBeNull();
    expect(sanitizeMessage(null, 'r')).toBeNull();
    expect(sanitizeMessage('x'.repeat(1000), 'r')).toHaveLength(1000);
    expect(() => sanitizeMessage('x'.repeat(1001), 'r')).toThrow(expect.objectContaining({ statusCode: 400, context: expect.objectContaining({ details: expect.objectContaining({ reason: 'message_too_long' }) }) }));
    expect(() => sanitizeMessage(42, 'r')).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});

describe('error mapping (stable details.reason)', () => {
  it('412 revision_mismatch carries the current revision', () => {
    expect(senderHttp(new EnvelopeRevisionMismatchError(ENV, 5, 4), 'r')).toMatchObject({ statusCode: 412, context: { details: { reason: 'revision_mismatch', current_revision: 5 } } });
  });
  it('429 reminder limits carry retry_after seconds and the ISO instant', () => {
    const at = new Date(Date.now() + 90_000);
    const e = senderHttp(new ReminderLimitError('reminder_cooldown', at), 'r');
    expect(e).toMatchObject({ statusCode: 429, code: 'ESIGN_REMINDER_NOT_ALLOWED', context: { details: { reason: 'reminder_cooldown', retry_at: at.toISOString() } } });
    const secs = (e.context.details as { retry_after_seconds: number }).retry_after_seconds;
    expect(secs).toBeGreaterThanOrEqual(89);
    expect(secs).toBeLessThanOrEqual(90);
    expect(senderHttp(new ReminderLimitError('reminder_daily_limit', at), 'r')).toMatchObject({ statusCode: 429, context: { details: { reason: 'reminder_daily_limit' } } });
  });
  it('idempotency: 422 reuse, 409 in progress; a malformed key is 400', () => {
    expect(senderHttp(new IdempotencyKeyReuseError(), 'r')).toMatchObject({ statusCode: 422, context: { details: { reason: 'idempotency_key_reuse' } } });
    expect(senderHttp(new IdempotencyRequestInProgressError(), 'r')).toMatchObject({ statusCode: 409, context: { details: { reason: 'idempotency_request_in_progress' } } });
    expect(idempotencyKey(undefined, 'r')).toBeUndefined();
    expect(idempotencyKey(' abc-123 ', 'r')).toBe('abc-123');
    for (const bad of ['', 'x'.repeat(256), 'has space', 'tab\tkey']) {
      expect(() => idempotencyKey(bad, 'r')).toThrow(expect.objectContaining({ statusCode: 400, context: expect.objectContaining({ details: { reason: 'invalid_idempotency_key' } }) }));
    }
  });
});

function envelope(over: Record<string, unknown> = {}) {
  return {
    id: ENV, subject: 'Offer', status: 'DRAFT', created_by: BROWSER.sub, source_application: 'aramo-sign', created_at: new Date(), sent_at: null,
    completed_at: null, declined_at: null, voided_at: null, expires_at: null, routing_mode: 'PARALLEL', revision: 4, message: 'Hello', documents: [], signers: [],
    ...over,
  };
}

function harness(opts: { env?: Record<string, unknown>; replay?: unknown; contacts?: unknown[]; recent?: unknown[]; history?: unknown[] } = {}) {
  const repo = {
    getEnvelopeDetail: vi.fn(async () => envelope(opts.env)),
    updateDraft: vi.fn(async (i: { expected_revision?: number }) => (i.expected_revision ?? 4) + 1),
    listPastRecipients: vi.fn(async () => opts.recent ?? []),
    reminderHistory: vi.fn(async () => opts.history ?? []),
  };
  const provider = { voidEnvelope: vi.fn(async () => undefined), sendEnvelope: vi.fn(async () => undefined), remindEnvelopeSigner: vi.fn(async () => undefined) };
  const tenants = { findById: vi.fn(async () => ({ id: BROWSER.tenant_id, kind: 'BUSINESS', is_active: true, status: 'ACTIVE' })) };
  const ctx = {
    tenantKind: vi.fn(async () => 'BUSINESS'),
    assertCanAuthor: vi.fn(async () => undefined),
    assertCanAuthorTenant: vi.fn(async () => tenants.findById()),
  };
  const idem = {
    begin: vi.fn(async () => (opts.replay !== undefined ? { kind: 'replay', status: 200, body: opts.replay } : { kind: 'fresh', id: 'k1' })),
    complete: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
  const contactStore = {
    list: vi.fn(async () => opts.contacts ?? []),
    create: vi.fn(async () => {
      throw new SignContactDuplicateError();
    }),
    update: vi.fn(async () => null),
    remove: vi.fn(async () => false),
    touchUsed: vi.fn(async () => undefined),
  };
  const svc = new SenderEnvelopeService(
    repo as never, provider as never, ctx as never, { findUserById: vi.fn(async () => null) } as never,
    {} as never, {} as never, { reserveUpload: vi.fn(), release: vi.fn() } as never, undefined, idem as never, contactStore as never,
  );
  return { svc, repo, provider, idem, contactStore };
}

describe('SenderEnvelopeService — preconditions, message and detail fields', () => {
  it('a native PATCH without If-Match is refused before any write; with it, the revision is compared in the write', async () => {
    const { svc, repo } = harness();
    await expect(svc.update(NATIVE, ENV, { subject: 'New' }, 'r')).rejects.toMatchObject({ statusCode: 428 });
    expect(repo.updateDraft).not.toHaveBeenCalled();
    await svc.update(NATIVE, ENV, { message: '  Please sign\u0000 ' }, 'r', envelopeEtag(ENV, 4));
    expect(repo.updateDraft).toHaveBeenLastCalledWith({ tenant_id: BROWSER.tenant_id, envelope_id: ENV, message: 'Please sign', expected_revision: 4 });
  });

  it('a browser PATCH without If-Match still works (no precondition passed)', async () => {
    const { svc, repo } = harness();
    await svc.update(BROWSER, ENV, { subject: 'New' }, 'r');
    expect(repo.updateDraft).toHaveBeenLastCalledWith({ tenant_id: BROWSER.tenant_id, envelope_id: ENV, subject: 'New' });
  });

  it('native void and send need If-Match; send chains the revision through every step', async () => {
    const { svc, provider, repo } = harness();
    await expect(svc.void(NATIVE, ENV, { reason: 'Wrong' }, 'r')).rejects.toMatchObject({ statusCode: 428 });
    await expect(svc.send(NATIVE, ENV, {}, 'r')).rejects.toMatchObject({ statusCode: 428 });
    expect(provider.voidEnvelope).not.toHaveBeenCalled();
    await svc.void(NATIVE, ENV, { reason: 'Wrong' }, 'r', envelopeEtag(ENV, 4));
    expect(provider.voidEnvelope).toHaveBeenCalledWith(BROWSER.tenant_id, ENV, 'Wrong', BROWSER.sub, { expected_revision: 4 });

    const ready = harness({
      env: {
        documents: [{ id: 'd1', title: 'a.pdf', ordinal: 0, content_type: 'application/pdf', byte_size: 1, source_sha256: 'x', fields: [{ id: 'f1', signer_id: 's1', field_type: 'SIGNATURE', page_number: 0, x: 1, y: 1, width: 1, height: 1, required: true, filled_at: null }] }],
        signers: [{ id: 's1', name: 'Ann', email: 'ann@x.test', status: 'PENDING', signing_order: 1, viewed_at: null, signed_at: null, declined_at: null, decline_reason: null }],
      },
    });
    await ready.svc.send(NATIVE, ENV, { subject: 'Renamed' }, 'r', { ifMatch: envelopeEtag(ENV, 4) });
    expect(ready.repo.updateDraft).toHaveBeenNthCalledWith(1, expect.objectContaining({ subject: 'Renamed', expected_revision: 4 }));
    expect(ready.repo.updateDraft).toHaveBeenNthCalledWith(2, expect.objectContaining({ execution_mode: 'SINGLE_SIGNATURE', expected_revision: 5 }));
    expect(ready.provider.sendEnvelope).toHaveBeenCalledWith(BROWSER.tenant_id, ENV, BROWSER.sub, undefined, { expected_revision: 6 });
    void repo;
  });

  it('detail reports revision, message and the two distinct expiry fields (C-14); expires_at is kept', async () => {
    const sent = new Date('2026-10-01T10:00:00.000Z');
    const { svc } = harness({ env: { status: 'SENT', sent_at: sent, expires_at: new Date('2026-10-31T10:00:00.000Z') } });
    const d = await svc.detail(BROWSER, ENV, 'r');
    expect(d).toMatchObject({
      revision: 4,
      message: 'Hello',
      signing_link_valid_days: 7,
      envelope_expires_at: '2026-10-31T10:00:00.000Z',
      expires_at: '2026-10-08T10:00:00.000Z',
    });
    // An envelope sent before expires_at existed: sent_at + the configured TTL (30 days).
    const legacy = await harness({ env: { status: 'SENT', sent_at: sent, expires_at: null } }).svc.detail(BROWSER, ENV, 'r');
    expect(legacy.envelope_expires_at).toBe('2026-10-31T10:00:00.000Z');
  });

  it('detail tells when each remindable signer may next be reminded', async () => {
    const now = Date.now();
    const signers = [
      { id: 's1', name: 'A', email: 'a@x.test', status: 'PENDING', signing_order: 1, viewed_at: null, signed_at: null, declined_at: null, decline_reason: null },
      { id: 's2', name: 'B', email: 'b@x.test', status: 'PENDING', signing_order: 2, viewed_at: null, signed_at: null, declined_at: null, decline_reason: null },
    ];
    const at = new Date(now - 10 * 60_000);
    const { svc } = harness({ env: { status: 'SENT', sent_at: new Date(), signers }, history: [{ occurred_at: at, signer_ids: ['s1'] }] });
    const d = await svc.detail(BROWSER, ENV, 'r');
    expect(d.recipients[0]!.reminder_available_at).toBe(new Date(at.getTime() + SIGN_REMINDER_LIMITS.per_signer_cooldown_ms).toISOString());
    expect(d.recipients[1]!.reminder_available_at).toBeNull();
  });
});

describe('SenderEnvelopeService — reminders and idempotency (M-A3 §7/§8)', () => {
  it('the Sign console always passes the reminder limits to the engine', async () => {
    const { svc, provider } = harness({ env: { status: 'SENT', sent_at: new Date() } });
    await svc.remind(BROWSER, ENV, { signer_id: 's1' }, 'r');
    expect(provider.remindEnvelopeSigner).toHaveBeenCalledWith(BROWSER.tenant_id, ENV, BROWSER.sub, 's1', { limits: SIGN_REMINDER_LIMITS });
  });

  it('a replayed Idempotency-Key returns the stored response and never reminds again', async () => {
    const stored = { id: ENV, revision: 9, status: 'SENT' };
    const { svc, provider, idem } = harness({ env: { status: 'SENT', sent_at: new Date() }, replay: stored });
    await expect(svc.remind(BROWSER, ENV, { signer_id: 's1' }, 'r', { idempotencyKey: 'k-1' })).resolves.toEqual(stored);
    expect(provider.remindEnvelopeSigner).not.toHaveBeenCalled();
    expect(idem.begin).toHaveBeenCalledWith({ tenant_id: BROWSER.tenant_id, actor_id: BROWSER.sub, operation: `remind:${ENV}`, key: 'k-1' }, expect.any(String));
  });

  it('a refused first attempt releases its key so the same key may be retried', async () => {
    const { svc, provider, idem } = harness({ env: { status: 'SENT', sent_at: new Date() } });
    provider.remindEnvelopeSigner.mockRejectedValueOnce(new ReminderLimitError('reminder_cooldown', new Date(Date.now() + 1000)));
    await expect(svc.remind(BROWSER, ENV, {}, 'r', { idempotencyKey: 'k-2' })).rejects.toBeInstanceOf(ReminderLimitError);
    expect(idem.release).toHaveBeenCalledWith('k1');
    expect(idem.complete).not.toHaveBeenCalled();
  });

  it('a Word upload is refused with unsupported_file_type (PDF only)', async () => {
    const { svc } = harness();
    await expect(svc.upload(BROWSER, ENV, { filename: 'offer.docx', content_base64: 'UEsDBA==' }, 'r')).rejects.toMatchObject({ statusCode: 400, context: { details: { reason: 'unsupported_file_type' } } });
    await expect(svc.upload(BROWSER, ENV, { filename: 'offer.pdf', content_base64: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]).toString('base64') }, 'r')).rejects.toMatchObject({
      context: { details: { reason: 'unsupported_file_type' } },
    });
  });
});

describe('SenderEnvelopeService — contacts (M-A3 §5)', () => {
  it('lists saved contacts (with ids) merged with recent recipients (id null); a saved email appears once', async () => {
    const created = new Date('2026-10-20T10:00:00.000Z');
    const { svc, repo, contactStore } = harness({
      contacts: [{ id: 'c1', name: 'Ann Saved', email: 'Ann@x.test', organization: 'Acme', created_at: created, updated_at: created, last_used_at: null }],
      recent: [
        { name: 'Ann', email: 'ann@x.test', envelope: { id: 'e1', created_at: new Date('2026-10-21T10:00:00.000Z') } },
        { name: 'Bo', email: 'bo@x.test', envelope: { id: 'e2', created_at: new Date('2026-10-19T10:00:00.000Z') } },
      ],
    });
    const out = await svc.contacts(BROWSER, 'r');
    expect(out.items).toEqual([
      { id: 'c1', name: 'Ann Saved', email: 'Ann@x.test', organization: 'Acme', source: 'saved', envelope_count: 1, last_used_at: '2026-10-21T10:00:00.000Z' },
      { id: null, name: 'Bo', email: 'bo@x.test', organization: null, source: 'recent', envelope_count: 1, last_used_at: '2026-10-19T10:00:00.000Z' },
    ]);
    // Owner-scoped: the saved list by (tenant, caller); recent recipients by the visibility rule.
    expect(contactStore.list).toHaveBeenCalledWith(BROWSER.tenant_id, BROWSER.sub);
    expect(repo.listPastRecipients).toHaveBeenCalledWith(BROWSER.tenant_id, 200, BROWSER.sub);
  });

  it('create validates; a duplicate email is 409 contact_exists; a contact of someone else is 404', async () => {
    const { svc } = harness();
    await expect(svc.createContact(BROWSER, { name: '', email: 'a@x.test' }, 'r')).rejects.toMatchObject({ statusCode: 400, context: { details: { reason: 'invalid_contact_name' } } });
    await expect(svc.createContact(BROWSER, { name: 'A', email: 'nope' }, 'r')).rejects.toMatchObject({ statusCode: 400, context: { details: { reason: 'invalid_contact_email' } } });
    await expect(svc.createContact(BROWSER, { name: 'A', email: 'a@x.test' }, 'r')).rejects.toMatchObject({ statusCode: 409, context: { details: { reason: 'contact_exists' } } });
    await expect(svc.updateContact(BROWSER, 'c-other', { name: 'X' }, 'r')).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.updateContact(BROWSER, 'c-other', {}, 'r')).rejects.toMatchObject({ statusCode: 400, context: { details: { reason: 'empty_contact_update' } } });
    await expect(svc.deleteContact(BROWSER, 'c-other', 'r')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('route metadata', () => {
  const sender = (n: string): object => (EsignSenderController.prototype as unknown as Record<string, object>)[n] ?? {};
  it.each(['createContact', 'updateContact', 'deleteContact'])('%s needs sign:envelope:create', (n) => {
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, sender(n))).toEqual(['sign:envelope:create']);
  });
  const me = (n: string): object => (SavedSignatureController.prototype as unknown as Record<string, object>)[n] ?? {};
  it.each(['get', 'putSignature', 'deleteSignature', 'putInitials', 'deleteInitials'])('saved signature %s: session + sign consumer, keyed by the caller', (n) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, me(n))).toEqual([JwtAuthGuard, EsignSenderConsumerGuard]);
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, me(n))).toBeUndefined();
  });
});

describe('saved signature validation (M-A3 §4, C-19 PNG/JPEG only)', () => {
  it('accepts a PNG or JPEG data URL; TYPED needs a name and a font', () => {
    expect(validateSavedSignature({ kind: 'DRAWN', image_data_url: `data:image/png;base64,${PNG_1PX}` }, 'r')).toEqual({
      kind: 'DRAWN', typed_name: null, font_key: null, image_data_url: `data:image/png;base64,${PNG_1PX}`,
    });
    expect(validateSavedSignature({ kind: 'TYPED', typed_name: ' Ann Lee ', font_key: 'caveat', image_data_url: `data:image/jpeg;base64,${JPEG_2X3}` }, 'r')).toMatchObject({ typed_name: 'Ann Lee', font_key: 'caveat' });
    expect(imageDimensions('jpeg', Buffer.from(JPEG_2X3, 'base64'))).toEqual({ width: 2, height: 3 });
    expect(imageDimensions('png', Buffer.from(PNG_1PX, 'base64'))).toEqual({ width: 1, height: 1 });
  });
  it.each([
    ['an SVG', { kind: 'DRAWN', image_data_url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }, 'invalid_image'],
    ['a GIF', { kind: 'DRAWN', image_data_url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }, 'invalid_image'],
    ['PNG label on JPEG bytes', { kind: 'DRAWN', image_data_url: `data:image/png;base64,${JPEG_2X3}` }, 'invalid_image'],
    ['a remote URL', { kind: 'DRAWN', image_data_url: 'https://evil.test/a.png' }, 'invalid_image'],
    ['an unknown kind', { kind: 'STAMP', image_data_url: `data:image/png;base64,${PNG_1PX}` }, 'invalid_signature_kind'],
    ['TYPED without a name', { kind: 'TYPED', font_key: 'caveat', image_data_url: `data:image/png;base64,${PNG_1PX}` }, 'invalid_typed_name'],
    ['TYPED with a bad font key', { kind: 'TYPED', typed_name: 'A', font_key: '../x', image_data_url: `data:image/png;base64,${PNG_1PX}` }, 'invalid_font_key'],
    ['an oversize image', { kind: 'DRAWN', image_data_url: `data:image/png;base64,${'A'.repeat(400_000)}` }, 'image_too_large'],
  ])('%s is refused', (_n, body, reason) => {
    expect(() => validateSavedSignature(body, 'r')).toThrow(expect.objectContaining({ statusCode: 400, context: expect.objectContaining({ details: expect.objectContaining({ reason }) }) }));
  });
  it('an image wider than 2048 pixels is refused', () => {
    const png = Buffer.from(PNG_1PX, 'base64');
    png.writeUInt32BE(4096, 16);
    expect(() => validateSavedSignature({ kind: 'DRAWN', image_data_url: `data:image/png;base64,${png.toString('base64')}` }, 'r')).toThrow(
      expect.objectContaining({ context: expect.objectContaining({ details: expect.objectContaining({ reason: 'image_too_large' }) }) }),
    );
  });
});

describe('account close deletes saved signatures and contacts (M-A3 §9)', () => {
  it('the purge deletes both for exactly (tenant, user) and reports counts', async () => {
    const signatures = { removeAllForUser: vi.fn(async () => 2) };
    const contacts = { removeAllForUser: vi.fn(async () => 3) };
    const purge = new SavedDataPurgeService(signatures as never, contacts as never);
    await expect(purge.purgeForAccountClose({ tenant_id: 't1', user_id: 'u1' })).resolves.toEqual({ saved_signatures: 2, contacts: 3 });
    expect(signatures.removeAllForUser).toHaveBeenCalledWith('t1', 'u1');
    expect(contacts.removeAllForUser).toHaveBeenCalledWith('t1', 'u1');
  });

  it('the Personal close runs it — on the close and again on an idempotent repeat', async () => {
    let state = 'clear';
    const T0 = new Date('2026-10-25T10:00:00.000Z');
    const tenants = { findById: vi.fn(async () => ({ id: 't1', kind: 'PERSONAL' })) };
    const repo = { findMembership: vi.fn(async () => ({ id: 'm1', is_active: true })) };
    const identity = { findRoleKeysForMembership: vi.fn(async () => ['tenant_owner']) };
    const risk = {
      riskStateOf: vi.fn(async () => ({ state, updated_at: T0 })),
      close: vi.fn(async () => {
        state = 'closed';
        return { state: 'closed', updated_at: T0 };
      }),
    };
    const savedData = { purgeForAccountClose: vi.fn(async () => ({ saved_signatures: 0, contacts: 0 })) };
    const svc = new SignAccountService(tenants as never, repo as never, identity as never, risk as never, undefined, savedData as never);
    await svc.close({ tenant_id: 't1', sub: 'u1' }, { confirm: 'CLOSE' }, 'r');
    await svc.close({ tenant_id: 't1', sub: 'u1' }, { confirm: 'CLOSE' }, 'r');
    expect(savedData.purgeForAccountClose).toHaveBeenCalledTimes(2);
    expect(savedData.purgeForAccountClose).toHaveBeenCalledWith({ tenant_id: 't1', user_id: 'u1' });
  });
});
