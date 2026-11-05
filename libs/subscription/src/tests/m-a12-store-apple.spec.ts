import { X509Certificate, createHash, generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { AppleAppStoreAdapter } from '../lib/billing/store/apple-app-store.adapter.js';
import { AppleJwsError, AppleJwsVerifier } from '../lib/billing/store/apple-jws.verifier.js';
import { APPLE_ROOT_CA_G3_PEM, APPLE_ROOT_CA_G3_SHA256 } from '../lib/billing/store/apple-root-ca.js';
import { StoreVerificationError } from '../lib/billing/store/store-billing.port.js';
import type { AppleStoreConfig } from '../lib/billing/store/store-billing.config.js';

import { appleShapedChain, makeCert, signedByChain } from './support/store-test-pki.js';

// Aramo Sign Mobile M-A12 §4 item 4 — App Store verification: the JWS x5c chain to the trusted root
// (good, bad chain, untrusted root, expired, missing marker, forged signature), the bundle and the
// environment; the notification envelope; the App Store Server API re-fetch and its status mapping.
// Every certificate and key is generated per run by a TEST CA (support/store-test-pki.ts): no Apple
// secret, no network.

const NOW = new Date('2026-11-04T12:00:00.000Z');
const SIGNED = NOW.getTime();
const TOKEN = '019a1200-0000-7000-8000-000000000001';

const tx = (over: Record<string, unknown> = {}) => ({
  transactionId: '2000000111',
  originalTransactionId: '2000000100',
  bundleId: 'ai.aramo.sign',
  productId: 'ai.aramo.sign.standard.monthly',
  purchaseDate: SIGNED - 86_400_000,
  expiresDate: SIGNED + 29 * 86_400_000,
  appAccountToken: TOKEN,
  environment: 'Sandbox',
  type: 'Auto-Renewable Subscription',
  signedDate: SIGNED,
  ...over,
});

function config(): AppleStoreConfig {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { issuer_id: '57246542-96fe-1a63-e053-0824d011072a', key_id: 'TESTKEY123', private_key_pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), bundle_id: 'ai.aramo.sign', environment: 'Sandbox' };
}

describe('M-A12 — Apple Root CA G3 (embedded trust anchor)', () => {
  it('is the published Apple Root CA - G3 (SHA-256 fingerprint) and valid until 2039', () => {
    const c = new X509Certificate(APPLE_ROOT_CA_G3_PEM);
    expect(createHash('sha256').update(c.raw).digest('hex')).toBe(APPLE_ROOT_CA_G3_SHA256);
    expect(c.subject).toContain('CN=Apple Root CA - G3');
    expect(new Date(c.validTo).getUTCFullYear()).toBe(2039);
  });

  it('a production verifier (embedded root only) refuses a chain from any other root', async () => {
    const chain = appleShapedChain();
    const v = new AppleJwsVerifier({ now: () => NOW });
    await expect(v.verify(await signedByChain(tx(), chain))).rejects.toMatchObject({ reason: 'untrusted_root' });
  });
});

describe('M-A12 — AppleJwsVerifier (x5c chain)', () => {
  const chain = appleShapedChain();
  const verifier = new AppleJwsVerifier({ roots: [chain.rootPem], now: () => NOW });
  const reason = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ACCEPTED';
    } catch (e) {
      return e instanceof AppleJwsError ? e.reason : String(e);
    }
  };

  it('good: a payload signed by the leaf of a chain to the trusted root verifies and decodes', async () => {
    expect(await verifier.verify(await signedByChain(tx(), chain))).toMatchObject({ originalTransactionId: '2000000100', appAccountToken: TOKEN });
  });

  it('bad chain: an intermediate not signed by the root is refused', async () => {
    const stranger = makeCert({ cn: 'Test Root CA', ca: true });
    const forgedIntermediate = makeCert({ cn: 'Test WWDR Intermediate', issuer: chain.root, ca: true, marker: '1.2.840.113635.100.6.2.1', signWith: stranger.key });
    const leaf = makeCert({ cn: 'Test App Store Signing', issuer: forgedIntermediate, marker: '1.2.840.113635.100.6.11.1' });
    expect(await reason(verifier.verify(await signedByChain(tx(), { root: chain.root, intermediate: forgedIntermediate, leaf })))).toBe('bad_chain');
  });

  it('bad chain: a leaf not issued by the intermediate is refused', async () => {
    const other = appleShapedChain();
    expect(await reason(verifier.verify(await signedByChain(tx(), { root: chain.root, intermediate: chain.intermediate, leaf: other.leaf })))).toBe('bad_chain');
  });

  it('a chain to another root is untrusted; an x5c of the wrong length is a bad chain', async () => {
    expect(await reason(verifier.verify(await signedByChain(tx(), appleShapedChain())))).toBe('untrusted_root');
    const two = (await signedByChain(tx(), chain)).split('.');
    const header = JSON.parse(Buffer.from(two[0] as string, 'base64url').toString()) as { x5c: string[] };
    header.x5c = header.x5c.slice(0, 2);
    const forged = [Buffer.from(JSON.stringify(header)).toString('base64url'), two[1], two[2]].join('.');
    expect(await reason(verifier.verify(forged))).toBe('bad_chain');
  });

  it('a leaf without the Apple receipt-signing marker is refused', async () => {
    const noMarker = appleShapedChain({ leafMarker: null });
    const v = new AppleJwsVerifier({ roots: [noMarker.rootPem], now: () => NOW });
    expect(await reason(v.verify(await signedByChain(tx(), noMarker)))).toBe('bad_marker');
  });

  it('a certificate expired at the signed date is refused', async () => {
    const expired = appleShapedChain({ leafNotAfter: new Date('2026-01-01T00:00:00Z') });
    const v = new AppleJwsVerifier({ roots: [expired.rootPem], now: () => NOW });
    expect(await reason(v.verify(await signedByChain(tx(), expired)))).toBe('certificate_expired');
  });

  it('a payload signed by another key than the leaf (forged) is refused', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(await reason(verifier.verify(await signedByChain(tx(), chain, privateKey)))).toBe('bad_signature');
  });

  it('a malformed JWS is refused', async () => {
    expect(await reason(verifier.verify('not-a-jws'))).toBe('malformed');
  });
});

describe('M-A12 — AppleAppStoreAdapter', () => {
  const chain = appleShapedChain();
  const verifier = new AppleJwsVerifier({ roots: [chain.rootPem], now: () => NOW });
  const failure = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ACCEPTED';
    } catch (e) {
      return e instanceof StoreVerificationError ? e.reason : String(e);
    }
  };

  it('verifyTransaction: bundle, environment and the appAccountToken binding', async () => {
    const a = new AppleAppStoreAdapter(config(), verifier, async () => ({ ok: false, status: 500, json: async () => ({}) }), () => NOW.getTime());
    expect(await a.verifyTransaction(await signedByChain(tx(), chain))).toEqual({
      original_transaction_id: '2000000100',
      transaction_id: '2000000111',
      product_id: 'ai.aramo.sign.standard.monthly',
      app_account_token: TOKEN,
      environment: 'Sandbox',
    });
    expect(await failure(a.verifyTransaction(await signedByChain(tx({ bundleId: 'com.other.app' }), chain)))).toBe('wrong_bundle');
    expect(await failure(a.verifyTransaction(await signedByChain(tx({ environment: 'Production' }), chain)))).toBe('wrong_environment');
    expect(await failure(a.verifyTransaction(await signedByChain(tx(), appleShapedChain())))).toBe('jws_untrusted_root');
  });

  it('verifyNotification: the verified envelope (id = notificationUUID, ref = originalTransactionId), never the state', async () => {
    const a = new AppleAppStoreAdapter(config(), verifier, async () => ({ ok: false, status: 500, json: async () => ({}) }), () => NOW.getTime());
    const signedTransactionInfo = await signedByChain(tx(), chain);
    const n = { notificationType: 'DID_RENEW', notificationUUID: 'b5f0c0de-0000-4000-8000-000000000001', signedDate: SIGNED, data: { bundleId: 'ai.aramo.sign', environment: 'Sandbox', signedTransactionInfo } };
    expect(await a.verifyNotification(await signedByChain(n, chain))).toEqual({ provider: 'APP_STORE', id: n.notificationUUID, type: 'DID_RENEW', created: NOW, subscription_ref: '2000000100' });
    expect(await failure(a.verifyNotification(await signedByChain({ ...n, data: { ...n.data, environment: 'Production' } }, chain)))).toBe('wrong_environment');
    expect(await failure(a.verifyNotification(await signedByChain(n, appleShapedChain())))).toBe('jws_untrusted_root');
  });

  it('retrieveSubscription: the App Store Server API (ES256 bearer) re-fetch, verified, mapped onto the status machine', async () => {
    const calls: { url: string; auth: string }[] = [];
    let status = 1;
    let renewal: Record<string, unknown> = { autoRenewStatus: 1, signedDate: SIGNED };
    let txOver: Record<string, unknown> = {};
    const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, auth: init.headers['authorization'] ?? '' });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          bundleId: 'ai.aramo.sign',
          environment: 'Sandbox',
          data: [{ lastTransactions: [{ originalTransactionId: '2000000100', status, signedTransactionInfo: await signedByChain(tx(txOver), chain), signedRenewalInfo: await signedByChain(renewal, chain) }] }],
        }),
      };
    };
    const a = new AppleAppStoreAdapter(config(), verifier, fetchImpl, () => NOW.getTime());
    const active = await a.retrieveSubscription('2000000100');
    expect(calls[0]?.url).toBe('https://api.storekit-sandbox.itunes.apple.com/inApps/v1/subscriptions/2000000100');
    expect(calls[0]?.auth).toMatch(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const header = JSON.parse(Buffer.from((calls[0]?.auth.slice(7) ?? '').split('.')[0] as string, 'base64url').toString()) as Record<string, unknown>;
    expect(header).toMatchObject({ alg: 'ES256', kid: 'TESTKEY123', typ: 'JWT' });
    expect(active).toMatchObject({ provider: 'APP_STORE', subscription_ref: '2000000100', provider_status: 'active', cancel_at_period_end: false, price_ref: 'ai.aramo.sign.standard.monthly', intent_id: TOKEN, account_country: null });
    renewal = { autoRenewStatus: 0, signedDate: SIGNED };
    expect((await a.retrieveSubscription('2000000100')).cancel_at_period_end).toBe(true);
    status = 4;
    renewal = { autoRenewStatus: 1, gracePeriodExpiresDate: SIGNED + 6 * 86_400_000, signedDate: SIGNED };
    expect(await a.retrieveSubscription('2000000100')).toMatchObject({ provider_status: 'past_due', store: { grace_until: new Date(SIGNED + 6 * 86_400_000) } });
    status = 3;
    expect(await a.retrieveSubscription('2000000100')).toMatchObject({ provider_status: 'past_due', store: { grace_until: null } });
    status = 2;
    expect((await a.retrieveSubscription('2000000100')).provider_status).toBe('canceled');
    status = 1;
    txOver = { revocationDate: SIGNED };
    expect((await a.retrieveSubscription('2000000100')).provider_status).toBe('canceled');
  });

  it('retrieveSubscription refuses an answer for another bundle or environment', async () => {
    const a = new AppleAppStoreAdapter(config(), verifier, async () => ({ ok: true, status: 200, json: async () => ({ bundleId: 'ai.aramo.sign', environment: 'Production', data: [] }) }), () => NOW.getTime());
    expect(await failure(a.retrieveSubscription('2000000100'))).toBe('wrong_environment');
  });

  it('unconfigured: not configured, and every call fails closed', async () => {
    const a = new AppleAppStoreAdapter(null, verifier);
    expect(a.isConfigured()).toBe(false);
    await expect(a.retrieveSubscription('x')).rejects.toThrow(/not configured/);
  });
});
