import { generateKeyPairSync, randomBytes, verify as cryptoVerify } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  GENERIC_SIGNATURE_TEXT,
  GENERIC_UPDATE_TEXT,
  notificationKindForLedgerEvent,
  pushAllowedByPreferences,
  pushTextFor,
  recordNotificationFact,
  type SignNotificationRepository,
} from '@aramo/sign';

import { ApnsPushAdapter, type Http2Requester } from '../app/push/apns-push.adapter.js';
import { FcmPushAdapter, type FetchLike } from '../app/push/fcm-push.adapter.js';
import { DisabledPushDelivery, LogPushDelivery, pushDeliveryFromEnv } from '../app/push/push-delivery.adapters.js';
import { decryptPushToken, encryptPushToken, pushTokenDigest } from '../app/push/push-token-crypto.js';
import { PushDeliveryService } from '../app/push/push-delivery.service.js';
import { NotificationFanoutService } from '../app/push/notification-fanout.service.js';
import type { PushDeliveryPort, PushMessage, PushProvider, PushSendResult } from '../app/push/push-delivery.port.js';
import type { DeviceSessionLiveness, DeviceSessionState } from '../app/push/device-session-liveness.js';
import { decodeFeedCursor, encodeFeedCursor, SignMeNotificationsService } from '../app/me/notifications/sign-me-notifications.service.js';

// Aramo Sign Mobile — notification feed, devices, preferences and push (M-A3 §1, §2,
// §9) — unit level: the vocabulary, the outbox writer, token encryption, the APNs and
// FCM adapters over mocked HTTP, the delivery worker's revocation re-checks, the
// fan-out rules and the /me service's refusals. The database paths run in
// sign-mobile-notifications.integration.spec.ts.

const T = '01900000-0000-7000-8000-0000000000a1';
const U = '01900000-0000-7000-8000-0000000000b1';
const ENV = '01900000-0000-7000-8000-0000000000c1';
const S1 = '01900000-0000-7000-8000-0000000000d1';
const S2 = '01900000-0000-7000-8000-0000000000d2';
const DSID = '01900000-0000-7000-8000-0000000000e1';
const APNS_TOKEN = 'a'.repeat(64);
const KEY = randomBytes(32).toString('base64');

describe('notification vocabulary', () => {
  it('lock-screen text is generic by default and never carries the subject or actor', () => {
    for (const type of ['SIGNED', 'VIEWED', 'DECLINED', 'COMPLETED', 'EXPIRED', 'SIGNATURE_NEEDED', 'REMINDER'] as const) {
      const t = pushTextFor({ type, envelope_subject: 'Offer letter', actor_name: 'Alex Morgan' }, false);
      expect(JSON.stringify(t)).not.toContain('Offer letter');
      expect(JSON.stringify(t)).not.toContain('Alex');
      expect(t.body).toBe(type === 'SIGNATURE_NEEDED' || type === 'REMINDER' ? GENERIC_SIGNATURE_TEXT : GENERIC_UPDATE_TEXT);
    }
  });

  it('shows the subject only when the user opted in', () => {
    expect(pushTextFor({ type: 'SIGNED', envelope_subject: 'Offer letter', actor_name: 'Alex' }, true)).toEqual({ title: 'Alex signed', body: 'Offer letter' });
    expect(pushTextFor({ type: 'REMINDER', envelope_subject: 'NDA', actor_name: null }, true)).toEqual({ title: 'Your signature is still needed', body: 'NDA' });
  });

  it('defaults: every type on, subject on the lock screen off; each flag governs its type', () => {
    expect(DEFAULT_NOTIFICATION_PREFERENCES).toEqual({ signed: true, viewed: true, declined: true, signature_needed: true, reminders: true, lock_screen_subject: false });
    const off = { ...DEFAULT_NOTIFICATION_PREFERENCES, signed: false, reminders: false };
    expect(pushAllowedByPreferences('SIGNED', off)).toBe(false);
    expect(pushAllowedByPreferences('COMPLETED', off)).toBe(false);
    expect(pushAllowedByPreferences('REMINDER', off)).toBe(false);
    expect(pushAllowedByPreferences('VIEWED', off)).toBe(true);
    expect(pushAllowedByPreferences('EXPIRED', off)).toBe(true);
  });
});

describe('notification outbox writer', () => {
  it('maps notifiable ledger events and ignores routine ones', () => {
    expect(notificationKindForLedgerEvent('SIGNER_SIGNED')).toBe('SIGNED');
    expect(notificationKindForLedgerEvent('SESSION_EXCHANGED')).toBe('VIEWED');
    expect(notificationKindForLedgerEvent('ENVELOPE_SENT')).toBe('SIGNATURE_NEEDED');
    expect(notificationKindForLedgerEvent('SIGNATURE_REMINDER_SENT')).toBe('REMINDER');
    for (const routine of ['ENVELOPE_CREATED', 'DOCUMENT_ATTACHED', 'DOCUMENT_REMOVED', 'DISCLOSURE_ACCEPTED', 'ENVELOPE_IN_PROGRESS', 'ENVELOPE_VOIDED']) {
      expect(notificationKindForLedgerEvent(routine)).toBeNull();
    }
  });

  it('records on the caller transaction, with the reminder targets from the ledger payload', async () => {
    const create = vi.fn(async () => ({}));
    const id = await recordNotificationFact({ signNotificationOutbox: { create } }, {
      tenant_id: T, envelope_id: ENV, event_type: 'SIGNATURE_REMINDER_SENT', actor_type: 'SERVICE', actor_ref: U, payload: { signer_ids: [S1, 'not-a-uuid'] },
    });
    expect(id).not.toBeNull();
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: 'REMINDER', tenant_id: T, envelope_id: ENV, actor_ref: U, signer_ids: [S1] }) });
  });

  it('a decline names the declining signer; a non-notifiable event or a client without the delegate records nothing', async () => {
    const create = vi.fn(async () => ({}));
    await recordNotificationFact({ signNotificationOutbox: { create } }, { tenant_id: T, envelope_id: ENV, event_type: 'ENVELOPE_DECLINED', actor_type: 'SIGNER', actor_ref: S1 });
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: 'DECLINED', signer_id: S1 }) });
    expect(await recordNotificationFact({ signNotificationOutbox: { create } }, { tenant_id: T, envelope_id: ENV, event_type: 'DOCUMENT_ATTACHED', actor_type: 'SERVICE' })).toBeNull();
    expect(await recordNotificationFact({}, { tenant_id: T, envelope_id: ENV, event_type: 'SIGNER_SIGNED', actor_type: 'SIGNER' })).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('push token encryption', () => {
  it('round-trips under SIGN_PUSH_TOKEN_KEY, never stores the clear token, and fails closed without the key', () => {
    const env = { SIGN_PUSH_TOKEN_KEY: KEY };
    const ct = encryptPushToken(APNS_TOKEN, env);
    expect(ct).not.toContain(APNS_TOKEN);
    expect(decryptPushToken(ct, env)).toBe(APNS_TOKEN);
    expect(() => encryptPushToken(APNS_TOKEN, {})).toThrow(/SIGN_PUSH_TOKEN_KEY/);
    expect(() => decryptPushToken(ct, { SIGN_PUSH_TOKEN_KEY: randomBytes(32).toString('base64') })).toThrow();
    expect(pushTokenDigest('apns', APNS_TOKEN)).toMatch(/^[0-9a-f]{64}$/);
  });
});

const MESSAGE: PushMessage = { title: 'Aramo Sign', body: GENERIC_UPDATE_TEXT, data: { type: 'SIGNED', envelope_id: ENV }, badge: 3 };

describe('APNs adapter (mocked HTTP/2)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const config = { keyId: 'KEY123', teamId: 'TEAM456', keyPem, topic: 'ai.aramo.sign', environment: 'sandbox' as const };

  it('posts to /3/device/{token} with a valid ES256 provider token and a payload of text + { type, envelope_id }', async () => {
    const calls: Array<{ origin: string; headers: Record<string, unknown>; body: string }> = [];
    const req: Http2Requester = async (origin, headers, body) => {
      calls.push({ origin, headers: headers as Record<string, unknown>, body });
      return { status: 200, body: '' };
    };
    const a = new ApnsPushAdapter(config, req, () => 1_800_000_000_000);
    expect(await a.send(APNS_TOKEN, MESSAGE)).toEqual({ outcome: 'sent' });
    const c = calls[0]!;
    expect(c.origin).toBe('https://api.sandbox.push.apple.com');
    expect(c.headers[':path']).toBe(`/3/device/${APNS_TOKEN}`);
    expect(c.headers['apns-topic']).toBe('ai.aramo.sign');
    expect(c.headers['apns-push-type']).toBe('alert');
    const jwt = String(c.headers['authorization']).replace(/^bearer /, '');
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY123' });
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toEqual({ iss: 'TEAM456', iat: 1_800_000_000 });
    expect(cryptoVerify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'))).toBe(true);
    const body = JSON.parse(c.body);
    expect(body).toEqual({ aps: { alert: { title: 'Aramo Sign', body: GENERIC_UPDATE_TEXT }, sound: 'default', badge: 3 }, type: 'SIGNED', envelope_id: ENV });
    expect(c.body).not.toContain(APNS_TOKEN);
  });

  it('maps provider answers: 410 / BadDeviceToken prune, 429 / 5xx retry, ExpiredProviderToken re-mints, other 4xx fail', async () => {
    let reply = { status: 410, body: '{"reason":"Unregistered"}' };
    const auths: string[] = [];
    const req: Http2Requester = async (_o, headers) => {
      auths.push(String(headers['authorization']));
      return reply;
    };
    let now = 1_800_000_000_000;
    const a = new ApnsPushAdapter(config, req, () => now);
    expect((await a.send(APNS_TOKEN, MESSAGE)).outcome).toBe('unregistered');
    reply = { status: 400, body: '{"reason":"BadDeviceToken"}' };
    expect((await a.send(APNS_TOKEN, MESSAGE)).outcome).toBe('unregistered');
    reply = { status: 429, body: '{"reason":"TooManyRequests"}' };
    expect((await a.send(APNS_TOKEN, MESSAGE)).outcome).toBe('retry');
    reply = { status: 503, body: '' };
    expect((await a.send(APNS_TOKEN, MESSAGE)).outcome).toBe('retry');
    reply = { status: 400, body: '{"reason":"PayloadTooLarge"}' };
    expect(await a.send(APNS_TOKEN, MESSAGE)).toEqual({ outcome: 'failed', error_code: 'apns_400_PayloadTooLarge' });
    expect(new Set(auths).size).toBe(1); // the provider token is reused
    reply = { status: 403, body: '{"reason":"ExpiredProviderToken"}' };
    expect((await a.send(APNS_TOKEN, MESSAGE)).outcome).toBe('retry');
    now += 1000;
    reply = { status: 200, body: '' };
    await a.send(APNS_TOKEN, MESSAGE);
    expect(auths[auths.length - 1]).not.toBe(auths[0]); // re-minted
  });

  it('a network error retries; a token that is not hex is never put in the path', async () => {
    const req = vi.fn<Http2Requester>(async () => {
      throw new Error('ECONNRESET');
    });
    const a = new ApnsPushAdapter(config, req);
    expect((await a.send(APNS_TOKEN, MESSAGE)).outcome).toBe('retry');
    expect((await a.send('../../evil', MESSAGE)).outcome).toBe('unregistered');
    expect(req).toHaveBeenCalledTimes(1);
  });
});

describe('FCM adapter (mocked HTTP v1)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = { client_email: 'push@aramo-test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), token_uri: 'https://oauth2.example.test/token' };
  const FCM_TOKEN = 'fcm-token_' + 'x'.repeat(40);

  function harness(sendReplies: Array<{ status: number; body: string }>) {
    const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, init });
      if (url === account.token_uri) return { status: 200, text: async () => JSON.stringify({ access_token: `ya29.${calls.length}`, expires_in: 3600 }) };
      const r = sendReplies.shift() ?? { status: 200, body: '{}' };
      return { status: r.status, text: async () => r.body };
    };
    return { calls, adapter: new FcmPushAdapter({ projectId: 'aramo-sign', account }, fetchFn, () => 1_800_000_000_000) };
  }

  it('exchanges a signed service-account assertion, caches the access token, and sends data as strings', async () => {
    const { calls, adapter } = harness([]);
    expect(await adapter.send(FCM_TOKEN, MESSAGE)).toEqual({ outcome: 'sent' });
    expect(await adapter.send(FCM_TOKEN, MESSAGE)).toEqual({ outcome: 'sent' });
    const oauth = calls.filter((c) => c.url === account.token_uri);
    expect(oauth).toHaveLength(1);
    const assertion = new URLSearchParams(oauth[0]!.init.body).get('assertion')!;
    const [h, p, s] = assertion.split('.');
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toMatchObject({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: account.token_uri });
    expect(cryptoVerify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s!, 'base64url'))).toBe(true);
    const send = calls.find((c) => c.url.endsWith('/messages:send'))!;
    expect(send.url).toBe('https://fcm.googleapis.com/v1/projects/aramo-sign/messages:send');
    expect(send.init.headers['authorization']).toMatch(/^Bearer ya29\./);
    const body = JSON.parse(send.init.body);
    expect(body.message.token).toBe(FCM_TOKEN);
    expect(body.message.data).toEqual({ type: 'SIGNED', envelope_id: ENV });
    expect(body.message.notification).toEqual({ title: 'Aramo Sign', body: GENERIC_UPDATE_TEXT });
  });

  it('maps answers: 404 / UNREGISTERED prune, 401 refreshes and retries, 429 retries, 400 fails', async () => {
    const { calls, adapter } = harness([
      { status: 404, body: '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}' },
      { status: 401, body: '{"error":{"status":"UNAUTHENTICATED"}}' },
      { status: 429, body: '{"error":{"status":"RESOURCE_EXHAUSTED"}}' },
      { status: 400, body: '{"error":{"status":"INVALID_ARGUMENT"}}' },
    ]);
    expect(await adapter.send(FCM_TOKEN, MESSAGE)).toEqual({ outcome: 'unregistered', error_code: 'fcm_404_UNREGISTERED' });
    expect((await adapter.send(FCM_TOKEN, MESSAGE)).outcome).toBe('retry');
    expect((await adapter.send(FCM_TOKEN, MESSAGE)).outcome).toBe('retry');
    expect(await adapter.send(FCM_TOKEN, MESSAGE)).toEqual({ outcome: 'failed', error_code: 'fcm_400_INVALID_ARGUMENT' });
    expect(calls.filter((c) => c.url === account.token_uri)).toHaveLength(2); // re-auth after the 401
  });
});

describe('push delivery selection', () => {
  it('defaults to disabled; log delivers to both providers; incomplete provider settings stay off', () => {
    expect(pushDeliveryFromEnv({}).providers.size).toBe(0);
    expect(pushDeliveryFromEnv({ SIGN_PUSH_DELIVERY: 'disabled' })).toBeInstanceOf(DisabledPushDelivery);
    expect([...pushDeliveryFromEnv({ SIGN_PUSH_DELIVERY: 'log' }).providers].sort()).toEqual(['apns', 'fcm']);
    expect(pushDeliveryFromEnv({ SIGN_PUSH_DELIVERY: 'apns,fcm' }).providers.size).toBe(0);
  });
});

// ── Delivery worker over an in-memory repository ──

interface FakeDevice { id: string; tenant_id: string; user_id: string; device_session_id: string; provider: string; push_token_ciphertext: string | null; revoked_at: Date | null }

function deliveryHarness(opts: { prefs?: Partial<typeof DEFAULT_NOTIFICATION_PREFERENCES>; session?: DeviceSessionState; result?: PushSendResult; revokeBeforeSend?: boolean; audience?: 'SENDER' | 'RECIPIENT' } = {}) {
  const env = { SIGN_PUSH_TOKEN_KEY: KEY };
  const saved = process.env['SIGN_PUSH_TOKEN_KEY'];
  process.env['SIGN_PUSH_TOKEN_KEY'] = env.SIGN_PUSH_TOKEN_KEY;
  const device: FakeDevice = { id: 'dev-1', tenant_id: T, user_id: U, device_session_id: DSID, provider: 'apns', push_token_ciphertext: encryptPushToken(APNS_TOKEN, env), revoked_at: null };
  const jobs = new Map([['job-1', { id: 'job-1', tenant_id: T, user_id: U, device_id: 'dev-1', notification_id: 'n-1', payload_kind: 'SIGNED', attempts: 0, status: 'PENDING' as string, next: null as Date | null }]]);
  const revoked: string[] = [];
  const revoke = (id: string) => {
    revoked.push(id);
    device.revoked_at = new Date();
    device.push_token_ciphertext = null;
    for (const j of jobs.values()) if (j.device_id === id && j.status === 'PENDING') j.status = 'CANCELLED';
  };
  const repo = {
    claimPushJobs: vi.fn(async () => [...jobs.values()].filter((j) => j.status === 'PENDING')),
    findDevice: vi.fn(async () => ({ ...device })),
    getNotification: vi.fn(async () => ({
      id: 'n-1', tenant_id: T, user_id: U, type: 'SIGNED', audience: opts.audience ?? 'SENDER', envelope_id: ENV, inbox_item_id: opts.audience === 'RECIPIENT' ? S2 : null, envelope_subject: 'Offer letter', actor_name: 'Alex',
    })),
    getPreferences: vi.fn(async () => ({ ...DEFAULT_NOTIFICATION_PREFERENCES, ...(opts.prefs ?? {}) })),
    unreadCount: vi.fn(async () => 2),
    revokeDevice: vi.fn(async (id: string) => {
      revoke(id);
      return 0;
    }),
    withLiveDeviceForSend: vi.fn(async (_id: string, send: (d: unknown) => Promise<unknown>) => {
      if (opts.revokeBeforeSend) revoke('dev-1');
      if (device.revoked_at !== null || device.push_token_ciphertext === null) return { ran: false };
      return { ran: true, result: await send({ ...device }) };
    }),
    finishPushJob: vi.fn(async (id: string, status: string) => {
      const j = jobs.get(id)!;
      if (j.status === 'PENDING') j.status = status;
    }),
    retryPushJob: vi.fn(async (id: string, attempts: number, _c: string, next: Date) => {
      const j = jobs.get(id)!;
      j.attempts = attempts;
      j.next = next;
    }),
  };
  const sent: Array<{ provider: PushProvider; token: string; message: PushMessage }> = [];
  const port: PushDeliveryPort = {
    providers: new Set<PushProvider>(['apns', 'fcm']),
    send: vi.fn(async (provider, token, message) => {
      sent.push({ provider, token, message });
      return opts.result ?? { outcome: 'sent' };
    }),
  };
  const liveness: DeviceSessionLiveness = { stateOf: vi.fn(async () => opts.session ?? 'live') };
  const svc = new PushDeliveryService(repo as unknown as SignNotificationRepository, port, liveness);
  const restore = () => {
    if (saved === undefined) delete process.env['SIGN_PUSH_TOKEN_KEY'];
    else process.env['SIGN_PUSH_TOKEN_KEY'] = saved;
  };
  return { svc, repo, jobs, sent, revoked, restore };
}

describe('push delivery worker', () => {
  it('sends the generic text with data { type, envelope_id } and the badge, decrypting the token only for the provider', async () => {
    const h = deliveryHarness();
    const r = await h.svc.deliverDueBatch();
    h.restore();
    expect(r.sent).toBe(1);
    expect(h.sent[0]!.token).toBe(APNS_TOKEN);
    expect(h.sent[0]!.message).toEqual({ title: 'Aramo Sign', body: GENERIC_UPDATE_TEXT, data: { type: 'SIGNED', envelope_id: ENV }, badge: 2 });
    expect(h.jobs.get('job-1')!.status).toBe('SENT');
  });

  it("a recipient's push carries the inbox item, never the sender's envelope id", async () => {
    const h = deliveryHarness({ audience: 'RECIPIENT', prefs: { lock_screen_subject: true } });
    await h.svc.deliverDueBatch();
    h.restore();
    expect(h.sent[0]!.message.data).toEqual({ type: 'SIGNED', inbox_item_id: S2 });
    expect(JSON.stringify(h.sent[0]!.message)).not.toContain(ENV);
    expect(h.sent[0]!.message.body).toBe('Offer letter');
  });

  it('correction 6 — a device revoked after the job was claimed is re-checked under the lock: dropped, never sent', async () => {
    const h = deliveryHarness({ revokeBeforeSend: true });
    const r = await h.svc.deliverDueBatch();
    h.restore();
    expect(h.sent).toHaveLength(0);
    expect(r.cancelled).toBe(1);
    expect(h.jobs.get('job-1')!.status).toBe('CANCELLED');
  });

  it('a revoked native device session revokes the registration and drops the push', async () => {
    const h = deliveryHarness({ session: 'revoked' });
    await h.svc.deliverDueBatch();
    h.restore();
    expect(h.sent).toHaveLength(0);
    expect(h.revoked).toEqual(['dev-1']);
    expect(h.jobs.get('job-1')!.status).toBe('CANCELLED');
  });

  it('a type switched off since the job was queued is dropped', async () => {
    const h = deliveryHarness({ prefs: { signed: false } });
    await h.svc.deliverDueBatch();
    h.restore();
    expect(h.sent).toHaveLength(0);
    expect(h.jobs.get('job-1')!.status).toBe('CANCELLED');
  });

  it('a provider "unregistered" prunes the device', async () => {
    const h = deliveryHarness({ result: { outcome: 'unregistered', error_code: 'apns_410_Unregistered' } });
    const r = await h.svc.deliverDueBatch();
    h.restore();
    expect(r.pruned).toBe(1);
    expect(h.revoked).toEqual(['dev-1']);
    expect(h.jobs.get('job-1')!.status).toBe('FAILED');
  });

  it('a transient failure retries with backoff', async () => {
    const h = deliveryHarness({ result: { outcome: 'retry', error_code: 'apns_503' } });
    const before = Date.now();
    const r = await h.svc.deliverDueBatch();
    h.restore();
    expect(r.retried).toBe(1);
    const j = h.jobs.get('job-1')!;
    expect(j.status).toBe('PENDING');
    expect(j.attempts).toBe(1);
    expect(j.next!.getTime()).toBeGreaterThanOrEqual(before + 30_000);
  });
});

// ── Fan-out rules over an in-memory repository ──

function fanoutHarness(opts: { signerEmail?: string; bindings?: Array<{ id: string; signer_id: string; user_id: string; user_tenant_id: string }>; prefs?: Partial<typeof DEFAULT_NOTIFICATION_PREFERENCES>; existingSource?: string; status?: string } = {}) {
  const upserts: Array<Record<string, unknown>> = [];
  const jobs: unknown[] = [];
  const repo = {
    envelopeForFanout: vi.fn(async () => ({
      id: ENV, tenant_id: T, subject: 'Offer letter', status: opts.status ?? 'IN_PROGRESS', created_by: U, routing_mode: 'PARALLEL', source_application: 'aramo-sign', origin_actor_kind: 'USER', has_owned_document: true,
      signers: [{ id: S1, name: 'Alex', email: opts.signerEmail ?? 'alex@example.test', status: 'SIGNED', signing_order: 1, signed_at: new Date() }, { id: S2, name: 'Bo', email: 'bo@example.test', status: 'PENDING', signing_order: 2, signed_at: null }],
    })),
    activeBindings: vi.fn(async (_e: string, ids: readonly string[]) => (opts.bindings ?? []).filter((b) => ids.includes(b.signer_id))),
    upsertNotification: vi.fn(async (d: Record<string, unknown>) => {
      upserts.push(d);
      return { id: `n-${upserts.length}`, source_outbox_id: opts.existingSource ?? (d['source_outbox_id'] as string) };
    }),
    getPreferences: vi.fn(async () => ({ ...DEFAULT_NOTIFICATION_PREFERENCES, ...(opts.prefs ?? {}) })),
    listActiveDevices: vi.fn(async () => [{ id: 'dev-1', provider: 'apns', device_session_id: DSID }]),
    countPushJobsSince: vi.fn(async () => 0),
    enqueuePushJobs: vi.fn(async (rows: unknown[]) => {
      jobs.push(...rows);
      return rows.length;
    }),
  };
  const identity = { findUserById: vi.fn(async () => ({ email: 'sam@example.test' })), findTenantNameById: vi.fn(async () => ({ name: 'Northwind', display_name: 'Northwind Staffing' })) };
  const svc = new NotificationFanoutService(repo as unknown as SignNotificationRepository, new LogPushDelivery(), identity as never);
  const row = (kind: string, extra: Record<string, unknown> = {}) => ({ id: 'ob-1', tenant_id: T, envelope_id: ENV, signer_id: S1, kind, actor_type: 'SIGNER', actor_ref: S1, signer_ids: [], attempt_count: 0, created_at: new Date(), ...extra });
  return { svc, repo, upserts, jobs, row };
}

describe('notification fan-out rules', () => {
  it('the sender hears a signature, with the signer as actor, and gets a push per active device', async () => {
    const h = fanoutHarness();
    const d = await h.svc.draftsFor(h.row('SIGNED'));
    expect(d).toEqual([expect.objectContaining({ tenant_id: T, user_id: U, type: 'SIGNED', audience: 'SENDER', actor_name: 'Alex', dedupe_key: 'ob-1:SIGNED' })]);
  });

  it('a sender who signs their own envelope is not notified (self-caused)', async () => {
    const h = fanoutHarness({ signerEmail: 'Sam@Example.test' });
    expect(await h.svc.draftsFor(h.row('SIGNED'))).toEqual([]);
    expect(await h.svc.draftsFor(h.row('VIEWED'))).toEqual([]);
  });

  it('a view dedupes per signer, not per event', async () => {
    const h = fanoutHarness();
    const [d] = await h.svc.draftsFor(h.row('VIEWED'));
    expect(d!.dedupe_key).toBe(`viewed:${ENV}:${S1}`);
  });

  it('an unclaimed recipient gets nothing; a claimed one gets the reminder in their own tenant, keyed to their inbox item', async () => {
    const none = fanoutHarness();
    expect(await none.svc.draftsFor(none.row('REMINDER', { signer_ids: [S2], actor_type: 'SERVICE', actor_ref: U }))).toEqual([]);
    const OTHER_T = '01900000-0000-7000-8000-0000000000a9';
    const BOB = '01900000-0000-7000-8000-0000000000b9';
    const h = fanoutHarness({ bindings: [{ id: 'bind-1', signer_id: S2, user_id: BOB, user_tenant_id: OTHER_T }] });
    const d = await h.svc.draftsFor(h.row('REMINDER', { signer_ids: [S2], actor_type: 'SERVICE', actor_ref: U }));
    expect(d).toEqual([expect.objectContaining({ tenant_id: OTHER_T, user_id: BOB, type: 'REMINDER', audience: 'RECIPIENT', inbox_item_id: 'bind-1', actor_name: 'Northwind Staffing' })]);
  });

  it('push jobs honour preferences; the feed row is written regardless', async () => {
    const h = fanoutHarness({ prefs: { signed: false } });
    (h.repo as unknown as { claimOutbox: unknown }).claimOutbox = vi.fn(async () => [h.row('SIGNED')]);
    (h.repo as unknown as { markOutboxProcessed: unknown }).markOutboxProcessed = vi.fn(async () => undefined);
    const r = await h.svc.processDueBatch();
    expect(r).toMatchObject({ processed: 1, notifications: 1, push_jobs: 0 });
    expect(h.jobs).toHaveLength(0);
  });

  it('a feed row created by an earlier event (a repeat view) is never pushed again', async () => {
    const h = fanoutHarness({ existingSource: 'ob-0' });
    (h.repo as unknown as { claimOutbox: unknown }).claimOutbox = vi.fn(async () => [h.row('VIEWED')]);
    (h.repo as unknown as { markOutboxProcessed: unknown }).markOutboxProcessed = vi.fn(async () => undefined);
    const r = await h.svc.processDueBatch();
    expect(r).toMatchObject({ processed: 1, notifications: 1, push_jobs: 0 });
  });
});

describe('/me service refusals', () => {
  const repo = { upsertDevice: vi.fn(), revokeDeviceBySession: vi.fn() } as unknown as SignNotificationRepository;
  const svc = new SignMeNotificationsService(repo, { stateOf: async () => 'revoked' });
  const web = { sub: U, tenant_id: T, consumer_type: 'sign', actor_kind: 'user', scopes: [], iat: 0, exp: 0 } as never;
  const native = { ...(web as object), client: 'native', dsid: DSID } as never;
  const reasonOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'resolved';
    } catch (e) {
      return (e as { context?: { details?: { reason?: string } } }).context?.details?.reason;
    }
  };

  it('device routes need a native token (client + dsid); a request body never names the device', async () => {
    expect(await reasonOf(svc.registerDevice(web, { platform: 'ios', provider: 'apns', push_token: APNS_TOKEN, app_version: '1.0.0' }, 'r'))).toBe('native_session_required');
    expect(await reasonOf(svc.removeDevice(web, 'r'))).toBe('native_session_required');
  });

  it('validates the registration, fails closed without the key, and refuses a revoked device session', async () => {
    expect(await reasonOf(svc.registerDevice(native, { platform: 'ios', provider: 'apns', push_token: 'zz', app_version: '1.0.0' }, 'r'))).toBe('invalid_push_registration');
    const saved = process.env['SIGN_PUSH_TOKEN_KEY'];
    delete process.env['SIGN_PUSH_TOKEN_KEY'];
    expect(await reasonOf(svc.registerDevice(native, { platform: 'ios', provider: 'apns', push_token: APNS_TOKEN, app_version: '1.0.0' }, 'r'))).toBe('push_registration_unavailable');
    process.env['SIGN_PUSH_TOKEN_KEY'] = KEY;
    expect(await reasonOf(svc.registerDevice(native, { platform: 'ios', provider: 'apns', push_token: APNS_TOKEN, app_version: '1.0.0' }, 'r'))).toBe('session_revoked');
    if (saved === undefined) delete process.env['SIGN_PUSH_TOKEN_KEY'];
    else process.env['SIGN_PUSH_TOKEN_KEY'] = saved;
    expect(repo.upsertDevice).not.toHaveBeenCalled();
  });

  it('preferences need exactly the six booleans; cursors and limits are validated', async () => {
    expect(await reasonOf(svc.putPreferences(web, { signed: true }, 'r'))).toBe('invalid_notification_preferences');
    expect(await reasonOf(svc.putPreferences(web, { ...DEFAULT_NOTIFICATION_PREFERENCES, extra: true }, 'r'))).toBe('invalid_notification_preferences');
    expect(await reasonOf(svc.list(web, { cursor: 'garbage' }, 'r'))).toBe('invalid_cursor');
    expect(await reasonOf(svc.list(web, { limit: '500' }, 'r'))).toBe('invalid_limit');
    const c = encodeFeedCursor({ created_at: new Date('2026-10-25T10:00:00.000Z'), id: S1 });
    expect(decodeFeedCursor(c)).toEqual({ created_at: new Date('2026-10-25T10:00:00.000Z'), id: S1 });
  });
});
