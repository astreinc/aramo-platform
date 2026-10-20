import { randomBytes } from 'node:crypto';

import type { AuthContextType } from '@aramo/auth';
import { ESIGN_ROLE_PERMISSIONS } from '@aramo/identity';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IntegrationAdminService } from '../app/integrations/integration-admin.service.js';
import { SignWebhookDeliveryService } from '../app/integrations/webhook-delivery.service.js';
import { decryptWebhookSecret, encryptWebhookSecret, webhookSecretsAvailable } from '../app/integrations/webhook-secrets.js';
import { checkTargetResolves, checkTargetShape, isPrivateAddress } from '../app/integrations/webhook-target.js';
import { HttpWebhookEventPublisher, computeEsignWebhookSignature } from '../app/webhook-event-publisher.js';

// Sign Unified Product S-5 (directive §4.4.4) — per-installation webhook
// subscriptions with isolated, encrypted signing secrets; per-subscription
// delivery; SSRF guard; legacy single target only for un-migrated ATS envelopes.

const KEY = randomBytes(32).toString('base64');
const TENANT = '22222222-2222-7222-8222-222222222222';
const EVENT = {
  event_id: '66666666-6666-7666-8666-666666666666',
  event_type: 'sign.envelope.executed.v1',
  event_version: 1,
  occurred_at: '2026-10-19T00:00:00.000Z',
  tenant_id: TENANT,
  envelope_id: '77777777-7777-7777-8777-777777777777',
  correlation_id: 'c',
  artifact_refs: { executed_document_ids: [], has_certificate: true },
};

let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = { k: process.env['SIGN_WEBHOOK_SECRET_KEY'], s: process.env['SIGN_WEBHOOK_SIGNING_SECRET'] };
  process.env['SIGN_WEBHOOK_SECRET_KEY'] = KEY;
});
afterEach(() => {
  if (saved['k'] === undefined) delete process.env['SIGN_WEBHOOK_SECRET_KEY'];
  else process.env['SIGN_WEBHOOK_SECRET_KEY'] = saved['k'];
  if (saved['s'] === undefined) delete process.env['SIGN_WEBHOOK_SIGNING_SECRET'];
  else process.env['SIGN_WEBHOOK_SIGNING_SECRET'] = saved['s'];
  vi.restoreAllMocks();
});

describe('signing secrets are isolated and encrypted at rest', () => {
  it('round-trips; the stored form never contains the secret; tampering fails', () => {
    const c = encryptWebhookSecret('whs_secret-value');
    expect(c).not.toContain('whs_secret-value');
    expect(decryptWebhookSecret(c)).toBe('whs_secret-value');
    const parts = c.split('.');
    const tampered = [parts[0], parts[1], parts[2], Buffer.from('x').toString('base64url')].join('.');
    expect(() => decryptWebhookSecret(tampered)).toThrow();
  });
  it('without the service key nothing is encrypted or decrypted (fail closed)', () => {
    const c = encryptWebhookSecret('s');
    delete process.env['SIGN_WEBHOOK_SECRET_KEY'];
    expect(webhookSecretsAvailable()).toBe(false);
    expect(() => encryptWebhookSecret('s')).toThrow();
    expect(() => decryptWebhookSecret(c)).toThrow();
  });
});

describe('SSRF guard for tenant-configured targets', () => {
  it.each([
    ['http://example.com/hook', 'not_https'],
    ['https://user:pw@example.com/hook', 'credentials_in_url'],
    ['https://example.com:8443/hook', 'port_not_allowed'],
    ['https://localhost/hook', 'private_address'],
    ['https://api.internal/hook', 'private_address'],
    ['https://10.0.0.5/hook', 'private_address'],
    ['https://169.254.169.254/latest', 'private_address'],
    ['https://[::1]/hook', 'private_address'],
    ['not a url', 'invalid_url'],
  ])('%s → %s', (url, reason) => {
    expect(checkTargetShape(url)).toBe(reason);
  });

  it('private ranges, IPv4-mapped IPv6 and unique-local IPv6 are private', () => {
    for (const ip of ['127.0.0.1', '172.16.3.1', '192.168.1.1', '100.64.0.1', '::ffff:10.1.1.1', 'fd00::1', 'fe80::1']) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '2606:4700::1111']) expect(isPrivateAddress(ip)).toBe(false);
  });

  it('a public host name that resolves to a private address is refused', async () => {
    expect(await checkTargetResolves('https://hooks.example.com/x', async () => [{ address: '10.0.0.9' }])).toBe('private_address');
    expect(await checkTargetResolves('https://hooks.example.com/x', async () => [{ address: '93.184.216.34' }])).toBeNull();
    expect(await checkTargetResolves('https://hooks.example.com/x', async () => { throw new Error('nx'); })).toBe('unresolvable');
  });
});

describe('event routing: subscriptions first; legacy target only for un-migrated ATS envelopes', () => {
  function publisher(envelope: { source_application: string; installation_id: string | null } | null, subs: { id: string; event_types: string[] }[]) {
    const repo = { subscriptionsForEnvelope: vi.fn(async () => ({ envelope, subscriptions: subs })), enqueue: vi.fn(async () => undefined) };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    return { pub: new HttpWebhookEventPublisher(repo as never), repo, fetchSpy };
  }

  it('fans out to every matching subscription and never to the legacy target', async () => {
    const { pub, repo, fetchSpy } = publisher({ source_application: 'acme-hr', installation_id: 'i' }, [
      { id: 's1', event_types: [] },
      { id: 's2', event_types: ['sign.envelope.executed.v1'] },
      { id: 's3', event_types: ['sign.envelope.declined.v1'] },
    ]);
    expect(await pub.deliver(EVENT)).toEqual({ ok: true });
    expect((repo.enqueue.mock.calls[0] as unknown as [{ subscription_id: string }[]])[0].map((r) => r.subscription_id)).toEqual(['s1', 's2']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('an ATS envelope with no ATS subscription yet still reaches the legacy target (shared secret, fail closed without it)', async () => {
    process.env['SIGN_WEBHOOK_SIGNING_SECRET'] = 'legacy';
    const { pub, fetchSpy } = publisher({ source_application: 'aramo-ats', installation_id: null }, []);
    expect(await pub.deliver(EVENT)).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    delete process.env['SIGN_WEBHOOK_SIGNING_SECRET'];
    expect(await publisher({ source_application: 'aramo-ats', installation_id: null }, []).pub.deliver(EVENT)).toEqual({ ok: false, error_code: 'NO_SIGNING_SECRET' });
  });

  it('a Sign-app or third-party envelope without subscriptions goes nowhere', async () => {
    process.env['SIGN_WEBHOOK_SIGNING_SECRET'] = 'legacy';
    for (const src of ['aramo-sign', 'acme-hr']) {
      const { pub, fetchSpy, repo } = publisher({ source_application: src, installation_id: null }, []);
      expect(await pub.deliver(EVENT)).toEqual({ ok: true });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(repo.enqueue).not.toHaveBeenCalled();
    }
  });
});

describe('per-subscription delivery', () => {
  const sub = (over: Record<string, unknown> = {}) => ({
    id: 'sub-1',
    status: 'ACTIVE',
    internal: false,
    target_url: 'https://hooks.example.com/aramo',
    secret_ciphertext: encryptWebhookSecret('whs_isolated'),
    ...over,
  });

  it('signs with the subscription’s OWN secret and carries the event and subscription ids', async () => {
    process.env['SIGN_WEBHOOK_SIGNING_SECRET'] = 'the-global-secret';
    const svc = new SignWebhookDeliveryService({} as never);
    let seen: Record<string, string> = {};
    let body = '';
    svc.useSender(async (_u, h, b) => {
      seen = h;
      body = b;
      return 204;
    });
    expect(await svc.deliverOne(sub() as never, EVENT, EVENT.event_id)).toEqual({ ok: true });
    expect(seen['x-aramo-sign-signature']).toBe(computeEsignWebhookSignature(seen['x-aramo-sign-timestamp']!, body, 'whs_isolated'));
    expect(seen['x-aramo-sign-signature']).not.toBe(computeEsignWebhookSignature(seen['x-aramo-sign-timestamp']!, body, 'the-global-secret'));
    expect(seen).toMatchObject({ 'x-aramo-sign-event-id': EVENT.event_id, 'x-aramo-sign-subscription-id': 'sub-1' });
  });

  it('refuses before sending: disabled subscription, non-HTTPS tenant target, undecryptable secret', async () => {
    const svc = new SignWebhookDeliveryService({} as never);
    const send = vi.fn(async () => 200);
    svc.useSender(send);
    expect(await svc.deliverOne(sub({ status: 'DISABLED' }) as never, EVENT, 'e')).toEqual({ ok: false, error_code: 'SUBSCRIPTION_DISABLED' });
    expect(await svc.deliverOne(sub({ target_url: 'http://10.0.0.1/x' }) as never, EVENT, 'e')).toEqual({ ok: false, error_code: 'TARGET_NOT_HTTPS' });
    expect(await svc.deliverOne(sub({ secret_ciphertext: 'garbage' }) as never, EVENT, 'e')).toEqual({ ok: false, error_code: 'NO_SIGNING_SECRET' });
    expect(send).not.toHaveBeenCalled();
    // An operator first-party target may be internal HTTP.
    expect(await svc.deliverOne(sub({ internal: true, target_url: 'http://api:3000/v1/integrations/sign/events' }) as never, EVENT, 'e')).toEqual({ ok: true });
  });

  it('retries with backoff, and gives up (DEAD) after the attempt budget', async () => {
    const repo = {
      claimDue: vi.fn(async () => [
        { id: 'd1', subscription: sub(), payload: EVENT, event_id: 'e1', attempt_count: 0, subscription_id: 'sub-1' },
        { id: 'd2', subscription: sub(), payload: EVENT, event_id: 'e2', attempt_count: 14, subscription_id: 'sub-1' },
      ]),
      markDelivered: vi.fn(),
      markFailed: vi.fn(),
    };
    const svc = new SignWebhookDeliveryService(repo as never);
    svc.useSender(async () => 500);
    expect(await svc.deliverDueBatch()).toEqual({ claimed: 2, delivered: 0, failed: 2 });
    const calls = repo.markFailed.mock.calls as unknown as [string, string, Date | null][];
    expect(calls[0]![1]).toBe('HTTP_500');
    expect(calls[0]![2]).toBeInstanceOf(Date);
    expect(calls[1]![2]).toBeNull();
  });
});

describe('webhook administration', () => {
  const admin: AuthContextType = { sub: '11111111-1111-7111-8111-111111111111', consumer_type: 'sign', actor_kind: 'user', tenant_id: TENANT, scopes: [...ESIGN_ROLE_PERMISSIONS.sign_admin], iat: 0, exp: 0 };
  function svc() {
    const inst = { id: 'inst-1', tenant_id: TENANT, application_id: 'app-1', status: 'ACTIVE', application: { kind: 'THIRD_PARTY' }, role_mappings: [] };
    const webhooks = {
      createSubscription: vi.fn(async (i: Record<string, unknown>) => ({ id: 'w1', created_at: new Date(), secret_rotated_at: null, status: 'ACTIVE', ...i })),
      getForInstallation: vi.fn(async () => ({ id: 'w1', created_at: new Date(), secret_rotated_at: null, status: 'ACTIVE', target_url: 'https://x', event_types: [] })),
      rotateSecret: vi.fn(async () => undefined),
    };
    const s = new IntegrationAdminService({ getInstallation: vi.fn(async () => inst) } as never, { tenantKind: vi.fn(async () => 'BUSINESS') } as never, webhooks as never);
    return { s, webhooks };
  }

  it('without the service key, webhooks are unavailable (503)', async () => {
    delete process.env['SIGN_WEBHOOK_SECRET_KEY'];
    await expect(svc().s.createWebhook(admin, 'inst-1', { target_url: 'https://93.184.216.34/h' }, 'r')).rejects.toMatchObject({ statusCode: 503, code: 'ESIGN_WEBHOOKS_UNAVAILABLE' });
  });

  it('refuses private or non-HTTPS targets and unknown event types', async () => {
    const { s, webhooks } = svc();
    await expect(s.createWebhook(admin, 'inst-1', { target_url: 'http://example.com/h' }, 'r')).rejects.toMatchObject({ statusCode: 400, context: { details: { reason: 'not_https' } } });
    await expect(s.createWebhook(admin, 'inst-1', { target_url: 'https://127.0.0.1/h' }, 'r')).rejects.toMatchObject({ context: { details: { reason: 'private_address' } } });
    await expect(s.createWebhook(admin, 'inst-1', { target_url: 'https://93.184.216.34/h', event_types: ['talent.updated'] }, 'r')).rejects.toMatchObject({ statusCode: 400 });
    expect(webhooks.createSubscription).not.toHaveBeenCalled();
  });

  it('returns the signing secret once and stores only its ciphertext', async () => {
    const { s, webhooks } = svc();
    const w = await s.createWebhook(admin, 'inst-1', { target_url: 'https://93.184.216.34/h' }, 'r');
    expect(w.signing_secret).toMatch(/^whs_/);
    const stored = (webhooks.createSubscription.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(JSON.stringify(stored)).not.toContain(w.signing_secret);
    expect(decryptWebhookSecret(stored['secret_ciphertext'] as string)).toBe(w.signing_secret);
    expect(stored).toMatchObject({ installation_id: 'inst-1', tenant_id: TENANT, internal: false });
    const r = await s.rotateWebhookSecret(admin, 'inst-1', 'w1', 'r');
    expect(r.signing_secret).not.toBe(w.signing_secret);
  });
});
