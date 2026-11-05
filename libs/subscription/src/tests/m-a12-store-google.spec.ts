import { generateKeyPairSync } from 'node:crypto';

import { SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { describe, expect, it } from 'vitest';

import { GooglePlayAdapter, googleMoneyMinor } from '../lib/billing/store/google-play.adapter.js';
import type { GooglePlayConfig } from '../lib/billing/store/store-billing.config.js';
import { StoreVerificationError } from '../lib/billing/store/store-billing.port.js';
import { playSubscriptionState } from '../lib/billing/store/store-state.js';

// Aramo Sign Mobile M-A12 §4 item 4 — Google Play verification: the service-account token (RS256 JWT
// with jose), subscriptionsv2.get for OUR package (a token of another package is refused), the
// obfuscated account id carried to the binding, acknowledgement, the RTDN Pub/Sub push OIDC bearer
// (issuer, audience, service account) and the package, and the state mapping. Keys generated per run;
// every HTTP call is a recorded fake (no network, no Google secret).

const NOW = new Date('2026-11-04T12:00:00.000Z');
const TOKEN = 'play-purchase-token-0001';
const INTENT = '019a1200-0000-7000-8000-000000000002';
const SA = 'rtdn-push@aramo-sign.iam.gserviceaccount.com';
const AUD = 'https://sign.aramo.ai/v1/sign/billing/webhook/google-play';

const sa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = (over: Partial<GooglePlayConfig> = {}): GooglePlayConfig => ({
  package_name: 'ai.aramo.sign',
  credentials: { client_email: 'play-api@aramo-sign.iam.gserviceaccount.com', private_key: sa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
  rtdn_audience: AUD,
  rtdn_service_account: SA,
  ...over,
});

const purchase = (over: Record<string, unknown> = {}) => ({
  kind: 'androidpublisher#subscriptionPurchaseV2',
  subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
  startTime: '2026-11-01T00:00:00.000Z',
  acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
  externalAccountIdentifiers: { obfuscatedExternalAccountId: INTENT },
  lineItems: [{ productId: 'ai.aramo.sign.standard.annual', expiryTime: '2027-11-01T00:00:00.000Z', autoRenewingPlan: { autoRenewEnabled: true } }],
  ...over,
});

type Call = { url: string; method: string; body?: string; auth?: string };
function fakeGoogle(routes: (url: string, method: string) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method, ...(init.body !== undefined ? { body: init.body } : {}), ...(init.headers['authorization'] !== undefined ? { auth: init.headers['authorization'] } : {}) });
    if (url === 'https://oauth2.googleapis.com/token') return { ok: true, status: 200, json: async () => ({ access_token: 'ya29.test-access', expires_in: 3600 }) };
    const r = routes(url, init.method);
    return { ok: r.status < 300, status: r.status, json: async () => r.body };
  };
  return { calls, fetchImpl };
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ACCEPTED';
  } catch (e) {
    return e instanceof StoreVerificationError ? e.reason : String(e);
  }
};

describe('M-A12 — GooglePlayAdapter: subscriptionsv2.get and acknowledge', () => {
  it('re-fetches for our package with a service-account bearer; the obfuscated account id becomes the binding', async () => {
    const g = fakeGoogle(() => ({ status: 200, body: purchase() }));
    const a = new GooglePlayAdapter(config(), g.fetchImpl, () => NOW.getTime(), createLocalJWKSet({ keys: [] }));
    const state = await a.retrieveSubscription(TOKEN);
    expect(g.calls[0]?.url).toBe('https://oauth2.googleapis.com/token');
    expect(g.calls[0]?.body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    expect(g.calls[1]).toMatchObject({ url: `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/ai.aramo.sign/purchases/subscriptionsv2/tokens/${TOKEN}`, method: 'GET', auth: 'Bearer ya29.test-access' });
    expect(state).toMatchObject({ provider: 'GOOGLE_PLAY', subscription_ref: TOKEN, provider_status: 'active', price_ref: 'ai.aramo.sign.standard.annual', intent_id: INTENT, account_country: null, store: { environment: 'Production' } });
  });

  it('wrong package: a token that is not a purchase of our package (Play answers 404/400) is refused', async () => {
    const a = new GooglePlayAdapter(config(), fakeGoogle(() => ({ status: 404, body: {} })).fetchImpl, () => NOW.getTime(), createLocalJWKSet({ keys: [] }));
    expect(await failure(a.getPurchase(TOKEN))).toBe('unknown_purchase');
    const b = new GooglePlayAdapter(config(), fakeGoogle(() => ({ status: 400, body: {} })).fetchImpl, () => NOW.getTime(), createLocalJWKSet({ keys: [] }));
    expect(await failure(b.getPurchase(TOKEN))).toBe('unknown_purchase');
  });

  it('acknowledges a purchase with purchases.subscriptions.acknowledge', async () => {
    const g = fakeGoogle(() => ({ status: 200, body: {} }));
    const a = new GooglePlayAdapter(config(), g.fetchImpl, () => NOW.getTime(), createLocalJWKSet({ keys: [] }));
    await a.acknowledge('ai.aramo.sign.standard.annual', TOKEN);
    expect(g.calls[1]).toMatchObject({ url: `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/ai.aramo.sign/purchases/subscriptions/ai.aramo.sign.standard.annual/tokens/${TOKEN}:acknowledge`, method: 'POST', body: '{}' });
  });

  it('a Play outage is transient (provider unavailable), never a verification failure', async () => {
    const a = new GooglePlayAdapter(config(), fakeGoogle(() => ({ status: 503, body: {} })).fetchImpl, () => NOW.getTime(), createLocalJWKSet({ keys: [] }));
    await expect(a.getPurchase(TOKEN)).rejects.toThrow(/google play api http 503/);
  });

  it('reads the base-plan regional prices (minor units) for the reconciliation report', async () => {
    const body = { basePlans: [{ regionalConfigs: [{ regionCode: 'IN', price: { currencyCode: 'INR', units: '899', nanos: 0 } }, { regionCode: 'JP', price: { currencyCode: 'JPY', units: '1500' } }, { regionCode: 'US', price: { currencyCode: 'USD', units: '9', nanos: 990000000 } }] }] };
    const a = new GooglePlayAdapter(config(), fakeGoogle(() => ({ status: 200, body })).fetchImpl, () => NOW.getTime(), createLocalJWKSet({ keys: [] }));
    expect(await a.regionalPrices('ai.aramo.sign.standard.monthly')).toEqual([
      { country: 'IN', currency: 'INR', amount_minor: 89900 },
      { country: 'JP', currency: 'JPY', amount_minor: 1500 },
      { country: 'US', currency: 'USD', amount_minor: 999 },
    ]);
    expect(googleMoneyMinor({ currencyCode: 'usd', units: '1' })).toBeNull();
  });
});

describe('M-A12 — Play subscription states → the status machine', () => {
  const at = (state: string, over: Record<string, unknown> = {}) => playSubscriptionState(TOKEN, purchase({ subscriptionState: state, ...over }));
  it('maps every subscriptionsv2 state', () => {
    expect(at('SUBSCRIPTION_STATE_ACTIVE')).toMatchObject({ provider_status: 'active', cancel_at_period_end: false });
    expect(at('SUBSCRIPTION_STATE_CANCELED')).toMatchObject({ provider_status: 'active', cancel_at_period_end: true });
    expect(at('SUBSCRIPTION_STATE_IN_GRACE_PERIOD')).toMatchObject({ provider_status: 'past_due', store: { grace_until: new Date('2027-11-01T00:00:00.000Z') } });
    expect(at('SUBSCRIPTION_STATE_ON_HOLD').provider_status).toBe('unpaid');
    expect(at('SUBSCRIPTION_STATE_PAUSED').provider_status).toBe('paused');
    expect(at('SUBSCRIPTION_STATE_EXPIRED').provider_status).toBe('canceled');
    expect(at('SUBSCRIPTION_STATE_PENDING').provider_status).toBe('incomplete');
    expect(at('SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED').provider_status).toBe('incomplete_expired');
    expect(at('SUBSCRIPTION_STATE_ACTIVE', { testPurchase: {} }).store?.environment).toBe('Sandbox');
  });
  it('a purchase without a line item is malformed (fail closed)', () => {
    expect(() => playSubscriptionState(TOKEN, purchase({ lineItems: [] }))).toThrow(StoreVerificationError);
  });
});

describe('M-A12 — Google RTDN push (Pub/Sub OIDC bearer)', () => {
  const google = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwksPromise = exportJWK(google.publicKey).then((jwk) => createLocalJWKSet({ keys: [{ ...jwk, kid: 'google-test-1', alg: 'RS256', use: 'sig' }] }));
  const bearer = async (claims: Record<string, unknown> = {}, opts: { aud?: string; iss?: string } = {}) =>
    `Bearer ${await new SignJWT({ email: SA, email_verified: true, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'google-test-1' })
      .setIssuer(opts.iss ?? 'https://accounts.google.com')
      .setAudience(opts.aud ?? AUD)
      .setIssuedAt(Math.floor(NOW.getTime() / 1000))
      .setExpirationTime(Math.floor(NOW.getTime() / 1000) + 3600)
      .sign(google.privateKey)}`;
  const push = (n: Record<string, unknown>, messageId = 'pubsub-msg-1') => ({ message: { data: Buffer.from(JSON.stringify(n)).toString('base64'), messageId, publishTime: NOW.toISOString() }, subscription: 'projects/p/subscriptions/s' });
  const rtdn = (over: Record<string, unknown> = {}) => ({ version: '1.0', packageName: 'ai.aramo.sign', eventTimeMillis: String(NOW.getTime()), subscriptionNotification: { version: '1.0', notificationType: 2, purchaseToken: TOKEN, subscriptionId: 'ai.aramo.sign.standard.annual' }, ...over });
  const adapter = async () => new GooglePlayAdapter(config(), fakeGoogle(() => ({ status: 500, body: {} })).fetchImpl, () => NOW.getTime(), await jwksPromise);

  it('a verified push becomes an envelope (id = messageId, ref = purchase token); the payload state is never used', async () => {
    expect(await (await adapter()).verifyPush(await bearer(), push(rtdn()))).toEqual({ provider: 'GOOGLE_PLAY', id: 'pubsub-msg-1', type: 'subscription.2', created: NOW, subscription_ref: TOKEN });
  });

  it('a voided (refunded) subscription purchase is an envelope too; a test notification carries none', async () => {
    const voided = rtdn({ subscriptionNotification: undefined, voidedPurchaseNotification: { purchaseToken: TOKEN, orderId: 'GPA.1', productType: 1, refundType: 1 } });
    expect(await (await adapter()).verifyPush(await bearer(), push(voided))).toMatchObject({ type: 'voided_purchase', subscription_ref: TOKEN });
    expect(await (await adapter()).verifyPush(await bearer(), push({ version: '1.0', packageName: 'ai.aramo.sign', testNotification: { version: '1.0' } }))).toBeNull();
  });

  it('refuses a missing bearer, another audience, another service account, an unverified email, a forged token and another package', async () => {
    const a = await adapter();
    expect(await failure(a.verifyPush(undefined, push(rtdn())))).toBe('push_token_missing');
    expect(await failure(a.verifyPush(await bearer({}, { aud: 'https://evil.example' }), push(rtdn())))).toBe('push_token_invalid');
    expect(await failure(a.verifyPush(await bearer({}, { iss: 'https://evil.example' }), push(rtdn())))).toBe('push_token_invalid');
    expect(await failure(a.verifyPush(await bearer({ email: 'someone@evil.example' }), push(rtdn())))).toBe('push_wrong_account');
    expect(await failure(a.verifyPush(await bearer({ email_verified: false }), push(rtdn())))).toBe('push_wrong_account');
    const forger = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const forged = `Bearer ${await new SignJWT({ email: SA, email_verified: true }).setProtectedHeader({ alg: 'RS256', kid: 'google-test-1' }).setIssuer('https://accounts.google.com').setAudience(AUD).setIssuedAt().setExpirationTime('1h').sign(forger.privateKey)}`;
    expect(await failure(a.verifyPush(forged, push(rtdn())))).toBe('push_token_invalid');
    expect(await failure(a.verifyPush(await bearer(), push(rtdn({ packageName: 'com.other.app' }))))).toBe('wrong_package');
    expect(await failure(a.verifyPush(await bearer(), { message: { data: 'x' } }))).toBe('push_malformed');
  });

  it('RTDN is refused while the audience or service account is not configured', async () => {
    const a = new GooglePlayAdapter(config({ rtdn_audience: null }), fakeGoogle(() => ({ status: 500, body: {} })).fetchImpl, () => NOW.getTime(), await jwksPromise);
    expect(a.pushConfigured()).toBe(false);
    expect(await failure(a.verifyPush(await bearer(), push(rtdn())))).toBe('push_not_configured');
  });
});
