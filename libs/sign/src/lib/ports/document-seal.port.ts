// Feature-Parity Directive v1.0 §1.15 (AATL document seal) under Amendment A1 — the
// vendor-neutral ports of the PAdES document seal. libs/sign builds the PAdES signature
// (the ByteRange placeholder, the CMS SignedData and its signed attributes) and holds no
// network client. The composition root (apps/sign-service) binds:
//   - DOCUMENT_SEAL_SIGNING_PROVIDER — a hash-signing service holding the seal key in an
//     HSM (default vendor per D-3: GlobalSign DSS), only when SIGN_SEAL_PROVIDER is set
//     AND `sign.document_seal` is AVAILABLE. Unbound = no seal (dark).
//   - DOCUMENT_SEAL_TIMESTAMP_SOURCE — optional. Bound = PAdES B-T (signature
//     time-stamp); unbound = PAdES B-B. It is satisfied structurally by the §1.18
//     RFC 3161 TrustedTimestampPort (feat/sign-rfc3161-timestamp), which is bound to it
//     once that port is on main; this lib does not carry a second TSA client.

export const DOCUMENT_SEAL_SIGNING_PROVIDER = 'DOCUMENT_SEAL_SIGNING_PROVIDER';
export const DOCUMENT_SEAL_TIMESTAMP_SOURCE = 'DOCUMENT_SEAL_TIMESTAMP_SOURCE';

/** The seal identity: the signing certificate and the chain up to (not incl.) the root. */
export interface DocumentSealIdentity {
  /** DER X.509 certificate whose key signs the seal (must chain to an AATL CA in production). */
  certificate_der: Buffer;
  /** DER intermediate certificates, nearest first. Embedded in the CMS for path building. */
  chain_der: Buffer[];
}

export interface DocumentSealSigningProvider {
  /** A short provider id recorded with every seal (never a credential). */
  readonly provider_id: string;
  /** The identity to seal with. A provider may cache it for its validity window. */
  identity(): Promise<DocumentSealIdentity>;
  /**
   * Sign a SHA-256 digest (32 bytes) with the identity's key: RSASSA-PKCS1-v1_5 over
   * a DigestInfo(SHA-256) — i.e. the signature value of sha256WithRSAEncryption.
   * The identity passed is the one returned by identity() for this seal.
   */
  signDigest(identity: DocumentSealIdentity, sha256Digest: Buffer): Promise<Buffer>;
}

/**
 * The minimal time-stamp source of the B-T level: an RFC 3161 TimeStampToken (CMS
 * ContentInfo, DER) over a SHA-256 digest, already verified by the source.
 */
export interface DocumentSealTimestampSource {
  timestamp(sha256Hex: string): Promise<{ token_der: Buffer }>;
}
