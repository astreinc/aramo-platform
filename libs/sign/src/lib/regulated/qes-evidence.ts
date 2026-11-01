import { createHash, createPublicKey, publicDecrypt, constants as cryptoConstants, X509Certificate } from 'node:crypto';

import { QES_HASH_ALGORITHM_SHA256_OID } from '../ports/qes-signing.port.js';

// Feature-Parity §1.16 (Amendment A1) — pure helpers for the QES evidence: the digest a
// signer authorizes at the QTSP, the certificate-chain fingerprint and summary, and a
// check that the QTSP's signature matches the signer certificate.

/** RSASSA-PKCS1-v1_5 with SHA-256 — the fallback signature algorithm (CSC signAlgo). */
export const RSA_SHA256_SIGNATURE_OID = '1.2.840.113549.1.1.11';
const RSA_ENCRYPTION_OID = '1.2.840.113549.1.1.1';
// DER DigestInfo prefix for SHA-256 (RFC 8017 §9.2 note 1).
const SHA256_DIGEST_INFO_PREFIX = Buffer.from('3031300d060960864801650304020105000420', 'hex');

export interface QesDigestDocument {
  id: string;
  ordinal: number;
  source_sha256: string;
}

/**
 * The SHA-256 digest a QES signer authorizes: a canonical statement of WHICH envelope,
 * WHICH signer and WHICH frozen source documents (by their stored SHA-256, in document
 * order). The documents of a sent envelope never change, so the digest is stable.
 */
export function qesSigningDigest(input: { envelope_id: string; signer_id: string; documents: readonly QesDigestDocument[] }): { digest_b64: string; hash_algorithm_oid: string } {
  const documents = [...input.documents].sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id)).map((d) => ({ id: d.id, sha256: d.source_sha256 }));
  const canonical = JSON.stringify({ v: 1, purpose: 'aramo-sign-qes', envelope_id: input.envelope_id, signer_id: input.signer_id, documents });
  return { digest_b64: createHash('sha256').update(canonical, 'utf8').digest('base64'), hash_algorithm_oid: QES_HASH_ALGORITHM_SHA256_OID };
}

/** SHA-256 over the chain (PEM text, normalized line endings, joined by "\n"). */
export function certificateChainSha256(chain: readonly string[]): string {
  return createHash('sha256').update(chain.map((c) => c.replace(/\r\n/g, '\n').trim()).join('\n'), 'utf8').digest('hex');
}

export function sha256Hex(b64: string): string {
  return createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
}

export interface CertificateSummary {
  subject: string;
  issuer: string;
  serial_number: string;
  valid_from: string;
  valid_to: string;
  fingerprint_sha256: string;
}

/** A readable summary of the signer certificate (the first in the chain); null if unparsable. */
export function signerCertificateSummary(chain: readonly string[]): CertificateSummary | null {
  const pem = chain[0];
  if (pem === undefined) return null;
  try {
    const c = new X509Certificate(pem);
    return {
      subject: c.subject,
      issuer: c.issuer,
      serial_number: c.serialNumber,
      valid_from: new Date(c.validFrom).toISOString(),
      valid_to: new Date(c.validTo).toISOString(),
      fingerprint_sha256: c.fingerprint256,
    };
  } catch {
    return null;
  }
}

/** Every certificate in the chain parses as X.509. */
export function isParsableChain(chain: readonly string[]): boolean {
  if (chain.length === 0) return false;
  try {
    for (const pem of chain) new X509Certificate(pem);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks the QTSP's raw signature against the signer certificate's public key.
 * Returns true/false for RSASSA-PKCS1-v1_5 + SHA-256 (the common CSC default); null when
 * the algorithm is one Aramo does not check locally (the QTSP's evidence still stands).
 */
export function verifyQesSignature(input: { certificate_pem: string; digest_b64: string; signature_b64: string; signature_algorithm_oid: string }): boolean | null {
  if (input.signature_algorithm_oid !== RSA_SHA256_SIGNATURE_OID && input.signature_algorithm_oid !== RSA_ENCRYPTION_OID) return null;
  try {
    const key = createPublicKey(new X509Certificate(input.certificate_pem).publicKey.export({ format: 'pem', type: 'spki' }));
    if (key.asymmetricKeyType !== 'rsa') return null;
    const recovered = publicDecrypt({ key, padding: cryptoConstants.RSA_PKCS1_PADDING }, Buffer.from(input.signature_b64, 'base64'));
    const expected = Buffer.concat([SHA256_DIGEST_INFO_PREFIX, Buffer.from(input.digest_b64, 'base64')]);
    return recovered.equals(expected);
  } catch {
    return false;
  }
}
