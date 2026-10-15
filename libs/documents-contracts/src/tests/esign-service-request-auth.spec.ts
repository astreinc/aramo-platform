import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ESIGN_S2S_SCHEME,
  ESIGN_S2S_SIGNATURE_HEADER,
  ESIGN_S2S_TIMESTAMP_HEADER,
  canonicalEsignS2sRequest,
  normalizeEsignS2sQuery,
  signEsignServiceRequest,
  verifyEsignServiceRequest,
} from '../lib/esign-service-request-auth.js';

// ES-2 — the shared esign-service → Core request-signature scheme.

const SECRET = 'unit-test-esign-secret';
const NOW = 1_800_000_000;
const REV = 'd0c4c000-0000-7000-8000-000000000001';
const TENANT = '11111111-1111-7111-8111-111111111111';
const URL_OK = `http://api:3000/v1/documents/revisions/${REV}/source?tenant_id=${TENANT}`;

function signedFor(url: string, overrides: Partial<{ method: string; nowSec: number; secret: string }> = {}) {
  return signEsignServiceRequest({ method: overrides.method ?? 'GET', url, secret: overrides.secret ?? SECRET, nowSec: overrides.nowSec ?? NOW });
}

function verify(input: { method?: string; path?: string; rawQuery?: string; headers: Record<string, string>; secret?: string | undefined; nowSec?: number }) {
  return verifyEsignServiceRequest({
    method: input.method ?? 'GET',
    path: input.path ?? `/v1/documents/revisions/${REV}/source`,
    rawQuery: input.rawQuery ?? `tenant_id=${TENANT}`,
    timestampHeader: input.headers[ESIGN_S2S_TIMESTAMP_HEADER],
    signatureHeader: input.headers[ESIGN_S2S_SIGNATURE_HEADER],
    secret: 'secret' in input ? input.secret : SECRET,
    nowSec: input.nowSec ?? NOW,
  });
}

describe('normalizeEsignS2sQuery', () => {
  it('sorts by key, percent-encodes, and strips a leading ?', () => {
    expect(normalizeEsignS2sQuery('?b=2&a=x%20y')).toBe('a=x%20y&b=2');
    expect(normalizeEsignS2sQuery('a=x+y')).toBe('a=x%20y');
    expect(normalizeEsignS2sQuery('')).toBe('');
  });
  it('rejects a repeated key as malformed', () => {
    expect(normalizeEsignS2sQuery(`tenant_id=${TENANT}&tenant_id=other`)).toBeNull();
  });
});

describe('canonicalEsignS2sRequest', () => {
  it('is scheme-tagged, newline-delimited and upper-cases the method', () => {
    expect(canonicalEsignS2sRequest({ method: 'get', path: '/p', query: 'a=1', timestamp: '9' })).toBe(`${ESIGN_S2S_SCHEME}\nGET\n/p\na=1\n9`);
  });
});

describe('verifyEsignServiceRequest', () => {
  it('accepts a correctly signed request (query order irrelevant)', () => {
    const h = signedFor(URL_OK);
    expect(verify({ headers: h })).toEqual({ ok: true });
    const h2 = signedFor(`http://api:3000/v1/x?b=2&a=1`);
    expect(verify({ path: '/v1/x', rawQuery: 'a=1&b=2', headers: h2 })).toEqual({ ok: true });
  });
  it('fails closed without a secret', () => {
    expect(verify({ headers: signedFor(URL_OK), secret: undefined }).reason).toBe('NO_SECRET');
    expect(verify({ headers: signedFor(URL_OK), secret: '' }).reason).toBe('NO_SECRET');
  });
  it('rejects missing headers', () => {
    expect(verify({ headers: {} }).reason).toBe('MISSING');
    expect(verify({ headers: { [ESIGN_S2S_TIMESTAMP_HEADER]: String(NOW) } }).reason).toBe('MISSING');
  });
  it('rejects a malformed timestamp, path or query', () => {
    const h = signedFor(URL_OK);
    expect(verify({ headers: { ...h, [ESIGN_S2S_TIMESTAMP_HEADER]: '17e8' } }).reason).toBe('MALFORMED');
    expect(verify({ headers: { ...h, [ESIGN_S2S_TIMESTAMP_HEADER]: '-1' } }).reason).toBe('MALFORMED');
    expect(verify({ headers: h, path: 'v1/no-leading-slash' }).reason).toBe('MALFORMED');
    expect(verify({ headers: h, rawQuery: `tenant_id=${TENANT}&tenant_id=x` }).reason).toBe('MALFORMED');
  });
  it('rejects a stale or future timestamp outside ±300s', () => {
    expect(verify({ headers: signedFor(URL_OK, { nowSec: NOW - 301 }) }).reason).toBe('STALE');
    expect(verify({ headers: signedFor(URL_OK, { nowSec: NOW + 301 }) }).reason).toBe('STALE');
    expect(verify({ headers: signedFor(URL_OK, { nowSec: NOW - 300 }) }).ok).toBe(true);
  });
  it('binds method, path, every query parameter and the secret', () => {
    const h = signedFor(URL_OK);
    expect(verify({ headers: h, method: 'POST' }).reason).toBe('BAD_SIGNATURE');
    expect(verify({ headers: h, path: '/v1/documents/revisions/d0c4c000-0000-7000-8000-000000000002/source' }).reason).toBe('BAD_SIGNATURE');
    expect(verify({ headers: h, rawQuery: 'tenant_id=22222222-2222-7222-8222-222222222222' }).reason).toBe('BAD_SIGNATURE');
    expect(verify({ headers: h, rawQuery: `tenant_id=${TENANT}&extra=1` }).reason).toBe('BAD_SIGNATURE');
    expect(verify({ headers: signedFor(URL_OK, { secret: 'other-secret' }) }).reason).toBe('BAD_SIGNATURE');
  });
  it('rejects a tampered or truncated signature', () => {
    const h = signedFor(URL_OK);
    const sig = h[ESIGN_S2S_SIGNATURE_HEADER]!;
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(verify({ headers: { ...h, [ESIGN_S2S_SIGNATURE_HEADER]: flipped } }).reason).toBe('BAD_SIGNATURE');
    expect(verify({ headers: { ...h, [ESIGN_S2S_SIGNATURE_HEADER]: sig.slice(0, -2) } }).reason).toBe('BAD_SIGNATURE');
  });
  it('is domain-separated from the lifecycle webhook signature (cross-purpose reuse fails both ways)', () => {
    // A webhook-style signature (HMAC over `${ts}.${body}`) for an empty body never verifies here.
    const ts = String(NOW);
    const webhookSig = createHmac('sha256', SECRET).update(`${ts}.`).digest('base64');
    expect(verify({ headers: { [ESIGN_S2S_TIMESTAMP_HEADER]: ts, [ESIGN_S2S_SIGNATURE_HEADER]: webhookSig } }).reason).toBe('BAD_SIGNATURE');
    // An s2s canonical message can never take the webhook form `<digits>.<body>`.
    const canonical = canonicalEsignS2sRequest({ method: 'GET', path: '/p', query: '', timestamp: ts });
    expect(/^\d+\./.test(canonical)).toBe(false);
  });
});
