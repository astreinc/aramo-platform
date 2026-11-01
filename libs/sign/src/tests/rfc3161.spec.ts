import { describe, expect, it } from 'vitest';

import {
  TAG,
  decodeGeneralizedTime,
  decodeInteger,
  decodeOid,
  encodeGeneralizedTime,
  encodeOid,
  encodeSequence,
  encodeTlv,
  encodeUnsignedInteger,
  parseDer,
} from '../lib/trusted-timestamp/der.js';
import { Rfc3161Error, buildTimeStampRequest, verifyTimeStampResponse } from '../lib/trusted-timestamp/rfc3161.js';

import {
  EC_RESPONSE,
  FIXTURE_POLICY_OID,
  FIXTURE_SHA256_HEX,
  NO_CERT_RESPONSE,
  RSA_REQUEST_DER_B64,
  RSA_RESPONSE,
} from './fixtures/rfc3161-fixtures.js';

// Feature-Parity Directive v1.0 §1.18 — the RFC 3161 codec against fixtures produced by
// `openssl ts` (offline; no network TSA is ever contacted by a unit test).

const SHA = Buffer.from(FIXTURE_SHA256_HEX, 'hex');
const der = (b64: string): Buffer => Buffer.from(b64, 'base64');

function expectRfcError(fn: () => unknown, code: Rfc3161Error['code']): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(Rfc3161Error);
    expect((e as Rfc3161Error).code).toBe(code);
    return;
  }
  throw new Error(`expected Rfc3161Error ${code}`);
}

describe('DER helpers', () => {
  it('round-trips an OBJECT IDENTIFIER, including multi-byte arcs', () => {
    for (const oid of ['2.16.840.1.101.3.4.2.1', '1.2.840.113549.1.9.16.1.4', '1.2.3.4.1']) {
      expect(decodeOid(parseDer(encodeOid(oid)))).toBe(oid);
    }
  });

  it('encodes a positive INTEGER minimally, with a leading zero only when the high bit is set', () => {
    expect(encodeUnsignedInteger(1n).toString('hex')).toBe('020101');
    expect(encodeUnsignedInteger(0x80n).toString('hex')).toBe('02020080');
    expect(encodeUnsignedInteger(Buffer.from('0000ff', 'hex')).toString('hex')).toBe('020200ff');
    expect(decodeInteger(parseDer(encodeUnsignedInteger(0xf6b8b0f5df60094dn)))).toBe(0xf6b8b0f5df60094dn);
  });

  it('round-trips a GeneralizedTime with and without fractional seconds', () => {
    for (const iso of ['2026-11-01T04:50:56.000Z', '2026-11-01T04:50:56.120Z']) {
      expect(decodeGeneralizedTime(parseDer(encodeGeneralizedTime(new Date(iso)))).toISOString()).toBe(iso);
    }
  });

  it('refuses an indefinite length and trailing bytes (DER only)', () => {
    expect(() => parseDer(Buffer.from('3080020101 0000'.replace(/ /g, ''), 'hex'))).toThrow(/indefinite/);
    expect(() => parseDer(Buffer.from('02010100', 'hex'))).toThrow(/trailing/);
  });
});

describe('TimeStampReq', () => {
  it('is byte-identical to the request openssl builds (v1, SHA-256 imprint, nonce, certReq)', () => {
    const req = buildTimeStampRequest({ sha256: SHA, nonce: Buffer.from(RSA_RESPONSE.nonce_hex, 'hex'), certReq: true });
    expect(req.toString('base64')).toBe(RSA_REQUEST_DER_B64);
  });

  it('refuses a digest that is not 32 bytes and an empty nonce', () => {
    expectRfcError(() => buildTimeStampRequest({ sha256: Buffer.alloc(20), nonce: Buffer.from('01', 'hex') }), 'MALFORMED');
    expectRfcError(() => buildTimeStampRequest({ sha256: SHA, nonce: Buffer.alloc(0) }), 'MALFORMED');
  });
});

describe('TimeStampResp verification', () => {
  const ok = (fixture: { der_b64: string; nonce_hex: string; gen_time: string }) =>
    verifyTimeStampResponse(der(fixture.der_b64), { sha256: SHA, nonce: Buffer.from(fixture.nonce_hex, 'hex'), now: new Date(fixture.gen_time) });

  it('verifies an RSA (sha256WithRSAEncryption) token: imprint, nonce, genTime, signature, TSA certificate', () => {
    const v = ok(RSA_RESPONSE);
    expect(v.status).toBe(0);
    expect(v.gen_time.toISOString()).toBe(RSA_RESPONSE.gen_time);
    expect(v.serial_number).toBe(RSA_RESPONSE.serial_hex);
    expect(v.policy_oid).toBe(FIXTURE_POLICY_OID);
    expect(v.hash_algorithm).toBe('SHA-256');
    expect(v.message_imprint_sha256).toBe(FIXTURE_SHA256_HEX);
    expect(v.tsa_name).toContain('CN=Aramo Test TSA');
    expect(v.tsa_certificate_sha256).toMatch(/^[0-9a-f]{64}$/);
    // The stored token is the TimeStampToken (a CMS ContentInfo), not the whole response.
    const token = parseDer(v.token_der);
    expect(token.tag).toBe(TAG.SEQUENCE);
    expect(der(RSA_RESPONSE.der_b64).includes(v.token_der)).toBe(true);
  });

  it('verifies an ECDSA P-256 (ecdsa-with-SHA256) token', () => {
    const v = ok(EC_RESPONSE);
    expect(v.gen_time.toISOString()).toBe(EC_RESPONSE.gen_time);
    expect(v.serial_number).toBe(EC_RESPONSE.serial_hex);
    expect(v.tsa_name).toContain('CN=Aramo Test EC TSA');
  });

  it('refuses a token over a different digest (messageImprint mismatch)', () => {
    const other = Buffer.from(SHA);
    other[0] = (other[0] as number) ^ 0xff;
    expectRfcError(
      () => verifyTimeStampResponse(der(RSA_RESPONSE.der_b64), { sha256: other, nonce: Buffer.from(RSA_RESPONSE.nonce_hex, 'hex'), now: new Date(RSA_RESPONSE.gen_time) }),
      'IMPRINT_MISMATCH',
    );
  });

  it('refuses a token that answers another request (nonce mismatch)', () => {
    expectRfcError(
      () => verifyTimeStampResponse(der(RSA_RESPONSE.der_b64), { sha256: SHA, nonce: Buffer.from(EC_RESPONSE.nonce_hex, 'hex'), now: new Date(RSA_RESPONSE.gen_time) }),
      'NONCE_MISMATCH',
    );
  });

  it('refuses a genTime outside the allowed clock skew', () => {
    const later = new Date(new Date(RSA_RESPONSE.gen_time).getTime() + 10 * 60_000);
    expectRfcError(
      () => verifyTimeStampResponse(der(RSA_RESPONSE.der_b64), { sha256: SHA, nonce: Buffer.from(RSA_RESPONSE.nonce_hex, 'hex'), now: later }),
      'GEN_TIME_OUT_OF_RANGE',
    );
    // ...but accepts it with a wider configured skew.
    expect(
      verifyTimeStampResponse(der(RSA_RESPONSE.der_b64), { sha256: SHA, nonce: Buffer.from(RSA_RESPONSE.nonce_hex, 'hex'), now: later, maxClockSkewMs: 15 * 60_000 }).status,
    ).toBe(0);
  });

  it('refuses a token whose TSTInfo was altered after signing (messageDigest mismatch)', () => {
    const bytes = der(RSA_RESPONSE.der_b64);
    const at = bytes.indexOf(Buffer.from('20261101045056Z', 'latin1'));
    expect(at).toBeGreaterThan(0);
    const tampered = Buffer.from(bytes);
    tampered[at + 13] = '7'.charCodeAt(0); // genTime 04:50:56 → 04:50:57
    expectRfcError(
      () => verifyTimeStampResponse(tampered, { sha256: SHA, nonce: Buffer.from(RSA_RESPONSE.nonce_hex, 'hex'), now: new Date(RSA_RESPONSE.gen_time) }),
      'SIGNATURE_INVALID',
    );
  });

  it('refuses a token whose signature bytes were altered', () => {
    const tampered = Buffer.from(der(RSA_RESPONSE.der_b64));
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] as number) ^ 0x01;
    expectRfcError(
      () => verifyTimeStampResponse(tampered, { sha256: SHA, nonce: Buffer.from(RSA_RESPONSE.nonce_hex, 'hex'), now: new Date(RSA_RESPONSE.gen_time) }),
      'SIGNATURE_INVALID',
    );
  });

  it('refuses a token that carries no certificate (certReq is always set)', () => {
    expectRfcError(() => ok(NO_CERT_RESPONSE), 'CERTIFICATE_INVALID');
  });

  it('refuses a rejection status and reports the TSA status text', () => {
    const rejection = encodeSequence(encodeSequence(encodeUnsignedInteger(2n), encodeSequence(encodeTlv(TAG.UTF8_STRING, Buffer.from('bad alg')))));
    try {
      verifyTimeStampResponse(rejection, { sha256: SHA, nonce: Buffer.from('01', 'hex'), now: new Date() });
      throw new Error('expected a rejection');
    } catch (e) {
      expect((e as Rfc3161Error).code).toBe('REJECTED');
      expect((e as Error).message).toContain('bad alg');
    }
  });

  it('refuses malformed input and a granted status without a token', () => {
    expectRfcError(() => verifyTimeStampResponse(Buffer.from('not der'), { sha256: SHA, nonce: Buffer.from('01', 'hex'), now: new Date() }), 'MALFORMED');
    const grantedEmpty = encodeSequence(encodeSequence(encodeUnsignedInteger(0n)));
    expectRfcError(() => verifyTimeStampResponse(grantedEmpty, { sha256: SHA, nonce: Buffer.from('01', 'hex'), now: new Date() }), 'MALFORMED');
  });
});
