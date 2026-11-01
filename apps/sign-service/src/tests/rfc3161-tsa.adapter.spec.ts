import { createHash } from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';

import { describe, expect, it, vi } from 'vitest';
import { FEATURE_AVAILABILITY, type FeatureAvailability } from '@aramo/subscription';
import { TrustedTimestampService } from '@aramo/sign';

import {
  Rfc3161HttpTsaAdapter,
  SIGN_TRUSTED_TIMESTAMP_FEATURE,
  TsaConfigError,
  clientCertificateFetch,
  trustedTimestampFromEnv,
  tsaAuthFromEnv,
} from '../app/trusted-timestamp/rfc3161-tsa.adapter.js';
import { TrustedTimestampRetryWorker } from '../app/trusted-timestamp/trusted-timestamp-retry.worker.js';
// The shared `openssl ts` fixtures live with the RFC 3161 codec in libs/sign (test-only data).
// eslint-disable-next-line @nx/enforce-module-boundaries
import {
  EC_RESPONSE,
  FIXTURE_SHA256_HEX,
  RSA_REQUEST_DER_B64,
  RSA_RESPONSE,
} from '../../../../libs/sign/src/tests/fixtures/rfc3161-fixtures.js';
// eslint-disable-next-line @nx/enforce-module-boundaries
import { createSelfSignedSealIdentity } from '../../../../libs/sign/src/tests/fixtures/self-signed-seal-provider.js';

// Feature-Parity Directive v1.0 §1.18 — the RFC 3161 HTTP adapter and its env gate. The
// network is never reached: fetch is a stub that answers with an `openssl ts` fixture.

const AVAILABLE: Readonly<Record<string, FeatureAvailability>> = { [SIGN_TRUSTED_TIMESTAMP_FEATURE]: 'AVAILABLE' };

function stubFetch(body: Buffer, init: { status?: number } = {}) {
  return vi.fn<(url: string | URL | Request, req?: RequestInit) => Promise<Response>>(async () =>
    new Response(new Uint8Array(body), { status: init.status ?? 200, headers: { 'content-type': 'application/timestamp-reply' } }),
  );
}

describe('trustedTimestampFromEnv — dark by default', () => {
  it('keeps sign.trusted_timestamp NOT_AVAILABLE in the production registry (flipping it is a PO decision)', () => {
    expect(FEATURE_AVAILABILITY[SIGN_TRUSTED_TIMESTAMP_FEATURE]).toBe('NOT_AVAILABLE');
  });

  it('returns null when SIGN_TSA_URL is unset or blank', () => {
    expect(trustedTimestampFromEnv({}, AVAILABLE)).toBeNull();
    expect(trustedTimestampFromEnv({ SIGN_TSA_URL: '  ' }, AVAILABLE)).toBeNull();
  });

  it('returns null when SIGN_TSA_URL is set but the feature is NOT_AVAILABLE (production registry)', () => {
    expect(trustedTimestampFromEnv({ SIGN_TSA_URL: 'https://tsa.example.test/rfc3161' })).toBeNull();
  });

  it('binds the adapter when SIGN_TSA_URL is set and the feature is AVAILABLE', () => {
    const adapter = trustedTimestampFromEnv({ SIGN_TSA_URL: 'http://timestamp.example.test' }, AVAILABLE);
    expect(adapter).toBeInstanceOf(Rfc3161HttpTsaAdapter);
    expect(adapter?.tsa_url).toBe('http://timestamp.example.test/');
  });

  it('refuses boot on a malformed URL, a non-http scheme, credentials in the URL, or a bad timeout', () => {
    expect(() => trustedTimestampFromEnv({ SIGN_TSA_URL: 'not a url' }, AVAILABLE)).toThrow(TsaConfigError);
    expect(() => trustedTimestampFromEnv({ SIGN_TSA_URL: 'ftp://tsa.example.test' }, AVAILABLE)).toThrow(TsaConfigError);
    expect(() => trustedTimestampFromEnv({ SIGN_TSA_URL: 'https://user:pw@tsa.example.test' }, AVAILABLE)).toThrow(TsaConfigError);
    expect(() => trustedTimestampFromEnv({ SIGN_TSA_URL: 'https://tsa.example.test', SIGN_TSA_TIMEOUT_MS: 'soon' }, AVAILABLE)).toThrow(TsaConfigError);
    expect(() => trustedTimestampFromEnv({ SIGN_TSA_URL: 'https://tsa.example.test', SIGN_TSA_TIMEOUT_MS: '100' }, AVAILABLE)).toThrow(TsaConfigError);
  });
});

describe('Rfc3161HttpTsaAdapter', () => {
  const nonceOf = (hex: string) => () => Buffer.from(hex, 'hex');

  it('POSTs the DER TimeStampReq and returns the verified token', async () => {
    const fetchImpl = stubFetch(Buffer.from(RSA_RESPONSE.der_b64, 'base64'));
    const adapter = new Rfc3161HttpTsaAdapter('https://tsa.example.test/', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      nonce: nonceOf(RSA_RESPONSE.nonce_hex),
      now: () => new Date(RSA_RESPONSE.gen_time),
    });
    const token = await adapter.timestamp(FIXTURE_SHA256_HEX);
    expect(token.gen_time.toISOString()).toBe(RSA_RESPONSE.gen_time);
    expect(token.message_imprint_sha256).toBe(FIXTURE_SHA256_HEX);
    expect(token.tsa_name).toContain('CN=Aramo Test TSA');
    expect(token.token_der.length).toBeGreaterThan(0);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://tsa.example.test/');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/timestamp-query');
    expect(Buffer.from(init.body as Uint8Array).toString('base64')).toBe(RSA_REQUEST_DER_B64);
  });

  it('rejects an HTTP error, an unverifiable reply and a malformed digest', async () => {
    const http500 = new Rfc3161HttpTsaAdapter('https://tsa.example.test/', { fetchImpl: stubFetch(Buffer.alloc(0), { status: 500 }) as unknown as typeof fetch });
    await expect(http500.timestamp(FIXTURE_SHA256_HEX)).rejects.toThrow(/HTTP 500/);

    // The EC fixture answers a different nonce than this request carries.
    const wrongNonce = new Rfc3161HttpTsaAdapter('https://tsa.example.test/', {
      fetchImpl: stubFetch(Buffer.from(EC_RESPONSE.der_b64, 'base64')) as unknown as typeof fetch,
      nonce: nonceOf(RSA_RESPONSE.nonce_hex),
      now: () => new Date(EC_RESPONSE.gen_time),
    });
    await expect(wrongNonce.timestamp(FIXTURE_SHA256_HEX)).rejects.toThrow(/NONCE_MISMATCH/);

    await expect(http500.timestamp('XYZ')).rejects.toThrow(/64 lowercase hex/);
  });
});

describe('TrustedTimestampRetryWorker', () => {
  it('does not schedule while the feature is off', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const worker = new TrustedTimestampRetryWorker(new TrustedTimestampService({} as never, null));
    worker.onApplicationBootstrap();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('a tick drives retryDue and never throws', async () => {
    const retryDue = vi.fn(async () => {
      throw new Error('db down');
    });
    const worker = new TrustedTimestampRetryWorker({ enabled: true, retryDue } as unknown as TrustedTimestampService);
    expect(await worker.tick()).toBe(0);
    expect(retryDue).toHaveBeenCalledTimes(1);
  });
});

// Remaining-Work Directive §3 B4 — optional TSA authentication (unset = the unauthenticated POST).
describe('TSA authentication (SIGN_TSA_USERNAME / _PASSWORD, SIGN_TSA_CLIENT_CERT / _KEY)', () => {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  const client = createSelfSignedSealIdentity('Aramo TEST TSA client');
  const clientKeyPem = client.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const other = createSelfSignedSealIdentity('Aramo TEST other');
  const URL_HTTPS = 'https://tsa.example.test/rfc3161';

  it('unset = no authentication: no Authorization header, no client certificate (current behaviour)', async () => {
    expect(tsaAuthFromEnv({}, URL_HTTPS)).toEqual({});
    const fetchImpl = stubFetch(Buffer.from(RSA_RESPONSE.der_b64, 'base64'));
    const adapter = trustedTimestampFromEnv({ SIGN_TSA_URL: URL_HTTPS }, AVAILABLE, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      nonce: () => Buffer.from(RSA_RESPONSE.nonce_hex, 'hex'),
      now: () => new Date(RSA_RESPONSE.gen_time),
    });
    await adapter?.timestamp(FIXTURE_SHA256_HEX);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(Object.keys(init.headers as Record<string, string>)).not.toContain('Authorization');
  });

  it('sends HTTP basic credentials as the Authorization header', async () => {
    const fetchImpl = stubFetch(Buffer.from(RSA_RESPONSE.der_b64, 'base64'));
    const adapter = trustedTimestampFromEnv({ SIGN_TSA_URL: URL_HTTPS, SIGN_TSA_USERNAME: 'aramo', SIGN_TSA_PASSWORD: 'pä:ss' }, AVAILABLE, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      nonce: () => Buffer.from(RSA_RESPONSE.nonce_hex, 'hex'),
      now: () => new Date(RSA_RESPONSE.gen_time),
    });
    await adapter?.timestamp(FIXTURE_SHA256_HEX);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Basic ${Buffer.from('aramo:pä:ss', 'utf8').toString('base64')}`);
  });

  it('refuses boot on a partial, unsafe or invalid setting', () => {
    expect(() => tsaAuthFromEnv({ SIGN_TSA_USERNAME: 'u' }, URL_HTTPS)).toThrow(TsaConfigError);
    expect(() => tsaAuthFromEnv({ SIGN_TSA_PASSWORD: 'p' }, URL_HTTPS)).toThrow(TsaConfigError);
    expect(() => tsaAuthFromEnv({ SIGN_TSA_USERNAME: 'a:b', SIGN_TSA_PASSWORD: 'p' }, URL_HTTPS)).toThrow(/':'/);
    expect(() => tsaAuthFromEnv({ SIGN_TSA_USERNAME: 'u', SIGN_TSA_PASSWORD: 'p' }, 'http://tsa.example.test/')).toThrow(/only over https/);
    expect(() => tsaAuthFromEnv({ SIGN_TSA_CLIENT_CERT: b64(client.certificate_pem) }, URL_HTTPS)).toThrow(/together/);
    expect(() => tsaAuthFromEnv({ SIGN_TSA_CLIENT_CERT: b64(client.certificate_pem), SIGN_TSA_CLIENT_KEY: b64(clientKeyPem) }, 'http://tsa.example.test/')).toThrow(/https/);
    expect(() => tsaAuthFromEnv({ SIGN_TSA_CLIENT_CERT: b64('not a cert'), SIGN_TSA_CLIENT_KEY: b64(clientKeyPem) }, URL_HTTPS)).toThrow(/PEM certificate/);
    expect(() => tsaAuthFromEnv({ SIGN_TSA_CLIENT_CERT: b64(client.certificate_pem), SIGN_TSA_CLIENT_KEY: b64('nope') }, URL_HTTPS)).toThrow(/PEM private key/);
    const otherKey = other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => tsaAuthFromEnv({ SIGN_TSA_CLIENT_CERT: b64(client.certificate_pem), SIGN_TSA_CLIENT_KEY: b64(otherKey) }, URL_HTTPS)).toThrow(/does not match/);
    // The refusal happens even while the feature is NOT_AVAILABLE (the setting is checked at boot).
    expect(() => trustedTimestampFromEnv({ SIGN_TSA_URL: URL_HTTPS, SIGN_TSA_USERNAME: 'u' })).toThrow(TsaConfigError);
  });

  it('parses a valid client certificate and key (base64 PEM) into the TLS options', () => {
    const auth = tsaAuthFromEnv({ SIGN_TSA_CLIENT_CERT: b64(client.certificate_pem), SIGN_TSA_CLIENT_KEY: b64(clientKeyPem), SIGN_TSA_USERNAME: 'u', SIGN_TSA_PASSWORD: 'p' }, URL_HTTPS);
    expect(auth.clientCertificate).toEqual({ cert_pem: client.certificate_pem, key_pem: clientKeyPem });
    expect(auth.basicAuth).toEqual({ username: 'u', password: 'p' });
  });

  it('presents the client certificate in the TLS handshake to the TSA (a local fake TSA)', async () => {
    const server = createHttpsServer(
      { key: other.privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: other.certificate_pem, requestCert: true, rejectUnauthorized: false },
      (req, res) => {
        const peer = (req.socket as TLSSocket).getPeerCertificate();
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/timestamp-reply', 'x-peer-sha256': peer.raw === undefined ? 'none' : createHash('sha256').update(peer.raw).digest('hex'), 'x-body-b64': Buffer.concat(chunks).toString('base64'), 'x-auth': String(req.headers.authorization ?? '') });
          res.end(Buffer.from(RSA_RESPONSE.der_b64, 'base64'));
        });
      },
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address() as AddressInfo;
      const transport = clientCertificateFetch({ cert_pem: client.certificate_pem, key_pem: clientKeyPem }, 256 * 1024, { rejectUnauthorized: false });
      const res = await transport(`https://127.0.0.1:${port}/tsa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/timestamp-query', Authorization: 'Basic eDp5' },
        body: new Uint8Array([1, 2, 3]),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-peer-sha256')).toBe(createHash('sha256').update(client.identity.certificate_der).digest('hex'));
      expect(res.headers.get('x-body-b64')).toBe(Buffer.from([1, 2, 3]).toString('base64'));
      expect(res.headers.get('x-auth')).toBe('Basic eDp5');
      expect(Buffer.from(await res.arrayBuffer()).toString('base64')).toBe(RSA_RESPONSE.der_b64);

      // End to end through the adapter: the verified token comes back over the mTLS transport.
      const adapter = new Rfc3161HttpTsaAdapter(`https://127.0.0.1:${port}/tsa`, {
        fetchImpl: transport,
        nonce: () => Buffer.from(RSA_RESPONSE.nonce_hex, 'hex'),
        now: () => new Date(RSA_RESPONSE.gen_time),
      });
      expect((await adapter.timestamp(FIXTURE_SHA256_HEX)).message_imprint_sha256).toBe(FIXTURE_SHA256_HEX);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
