import { describe, expect, it } from 'vitest';

import {
  RSA_SHA256_SIGNATURE_OID,
  certificateChainSha256,
  isParsableChain,
  qesSigningDigest,
  sha256Hex,
  signerCertificateSummary,
  verifyQesSignature,
} from '../lib/regulated/qes-evidence.js';
import { QES_HASH_ALGORITHM_SHA256_OID } from '../lib/ports/qes-signing.port.js';

import { makeTestCertificate, signDigest } from './support/test-certificate.js';

// Feature-Parity §1.16 (Amendment A1) — the QES evidence helpers.
const ENV = '11111111-1111-4111-8111-111111111111';
const SIGNER = '22222222-2222-4222-8222-222222222222';
const DOCS = [
  { id: 'b', ordinal: 1, source_sha256: 'bb'.repeat(32) },
  { id: 'a', ordinal: 0, source_sha256: 'aa'.repeat(32) },
];

describe('qesSigningDigest', () => {
  it('is a SHA-256 digest that does not depend on input order', () => {
    const one = qesSigningDigest({ envelope_id: ENV, signer_id: SIGNER, documents: DOCS });
    const two = qesSigningDigest({ envelope_id: ENV, signer_id: SIGNER, documents: [...DOCS].reverse() });
    expect(one).toEqual(two);
    expect(one.hash_algorithm_oid).toBe(QES_HASH_ALGORITHM_SHA256_OID);
    expect(Buffer.from(one.digest_b64, 'base64')).toHaveLength(32);
  });
  it('changes with the signer and with any document hash', () => {
    const base = qesSigningDigest({ envelope_id: ENV, signer_id: SIGNER, documents: DOCS }).digest_b64;
    expect(qesSigningDigest({ envelope_id: ENV, signer_id: ENV, documents: DOCS }).digest_b64).not.toBe(base);
    const changed = [{ ...DOCS[0]!, source_sha256: 'cc'.repeat(32) }, DOCS[1]!];
    expect(qesSigningDigest({ envelope_id: ENV, signer_id: SIGNER, documents: changed }).digest_b64).not.toBe(base);
  });
});

describe('certificate helpers', () => {
  const cert = makeTestCertificate('Asha Rao', 7);
  it('fingerprints the chain independently of CRLF line endings', () => {
    expect(certificateChainSha256([cert.pem])).toBe(certificateChainSha256([cert.pem.replace(/\n/g, '\r\n')]));
    expect(certificateChainSha256([cert.pem])).toMatch(/^[0-9a-f]{64}$/);
  });
  it('summarizes the signer certificate', () => {
    const s = signerCertificateSummary([cert.pem]);
    expect(s?.subject).toContain('Asha Rao');
    expect(s?.issuer).toContain('Test QTSP CA');
    expect(s?.serial_number).toBe('07');
    expect(signerCertificateSummary([])).toBeNull();
    expect(signerCertificateSummary(['not a certificate'])).toBeNull();
  });
  it('parses only a non-empty chain of X.509 certificates', () => {
    expect(isParsableChain([cert.pem])).toBe(true);
    expect(isParsableChain([])).toBe(false);
    expect(isParsableChain([cert.pem, 'garbage'])).toBe(false);
  });
  it('sha256Hex hashes the decoded bytes', () => {
    expect(sha256Hex(Buffer.from('abc').toString('base64'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('verifyQesSignature', () => {
  const cert = makeTestCertificate();
  const { digest_b64 } = qesSigningDigest({ envelope_id: ENV, signer_id: SIGNER, documents: DOCS });
  it('accepts an RSA PKCS#1 v1.5 signature by the certificate key over the digest', () => {
    const signature_b64 = signDigest(cert.privateKey, digest_b64);
    expect(verifyQesSignature({ certificate_pem: cert.pem, digest_b64, signature_b64, signature_algorithm_oid: RSA_SHA256_SIGNATURE_OID })).toBe(true);
  });
  it('rejects a signature over another digest or by another key', () => {
    const other = qesSigningDigest({ envelope_id: ENV, signer_id: ENV, documents: DOCS }).digest_b64;
    expect(verifyQesSignature({ certificate_pem: cert.pem, digest_b64, signature_b64: signDigest(cert.privateKey, other), signature_algorithm_oid: RSA_SHA256_SIGNATURE_OID })).toBe(false);
    const stranger = makeTestCertificate('Someone Else');
    expect(verifyQesSignature({ certificate_pem: cert.pem, digest_b64, signature_b64: signDigest(stranger.privateKey, digest_b64), signature_algorithm_oid: RSA_SHA256_SIGNATURE_OID })).toBe(false);
    expect(verifyQesSignature({ certificate_pem: cert.pem, digest_b64, signature_b64: 'AAAA', signature_algorithm_oid: RSA_SHA256_SIGNATURE_OID })).toBe(false);
  });
  it('returns null for an algorithm it does not check locally', () => {
    expect(verifyQesSignature({ certificate_pem: cert.pem, digest_b64, signature_b64: 'AAAA', signature_algorithm_oid: '1.2.840.10045.4.3.2' })).toBeNull();
  });
});
