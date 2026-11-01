// Feature-Parity Directive v1.0 §1.18 — the Time-Stamping Authority (TSA) port. An
// adapter obtains an RFC 3161 time-stamp token over a SHA-256 digest from a TSA and
// returns it ONLY after verifying it (status, messageImprint, nonce, genTime, CMS
// signature). The composition root (apps/sign-service) binds the RFC 3161 HTTP adapter
// when SIGN_TSA_URL is set and `sign.trusted_timestamp` is AVAILABLE; otherwise the
// token is bound to null and the feature is off (no request, no row, no certificate
// line). libs/sign holds no network client.

export const TRUSTED_TIMESTAMP_PORT = 'TRUSTED_TIMESTAMP_PORT';

export interface TrustedTimestampToken {
  token_der: Buffer; // the TimeStampToken (CMS ContentInfo), DER
  gen_time: Date;
  serial_number: string; // hex, uppercase
  policy_oid: string;
  hash_algorithm: 'SHA-256';
  message_imprint_sha256: string; // hex, lowercase
  tsa_name: string; // TSA signing certificate subject
  tsa_certificate_sha256: string; // hex, lowercase
}

export interface TrustedTimestampPort {
  // The TSA endpoint, recorded with every request (never a credential).
  readonly tsa_url: string;
  /** Request and verify a token over the SHA-256 digest (64 lowercase hex chars). */
  timestamp(sha256Hex: string): Promise<TrustedTimestampToken>;
}
