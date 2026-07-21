import { createHmac, timingSafeEqual } from 'node:crypto';

// SRC-1 PR-2 (R5) — Indeed Apply webhook signature verification.
//
// The codebase's FIRST signature-verified endpoint (audit E2: zero precedent).
// Scheme, per Indeed's current partner docs
// (docs.indeed.com/indeed-apply/message-signature-generation, read at build
// time): the `X-Indeed-Signature` header carries an HMAC-SHA1 of the full,
// unaltered UTF-8 request body, Base64-encoded, keyed by the partner-provisioned
// Indeed Apply "api Secret". Indeed returns 401 when the signature does not match.
//
// ⚠️ HMAC-SHA1 is the counterparty's MANDATED scheme. It is cryptographically
// sound for MAC use here and MUST NOT be unilaterally "upgraded" to SHA-256 —
// doing so silently breaks verification against every real Indeed delivery (a
// verification outage). If Indeed changes their scheme, that is a coordinated
// change, not a local hardening.
//
// ⚠️ Documented ambiguity (RECON-1): the docs' Node.js sample base64-encodes the
// body BEFORE the HMAC, while the prose ("full unaltered JSON payload") and five
// of six language samples HMAC the raw body directly. We implement the canonical
// raw-body variant. The transform is isolated in ONE named function below
// (`indeedSignedBytes`) — the certification seam. SRC-2 pins it against a REAL
// Indeed-signed sample (a hard SRC-2 exit criterion; no tenant is onboarded to
// Indeed Apply before that passes). If live behavior matches the Node variant,
// only that one function body changes — no redesign.

export const INDEED_SIGNATURE_HEADER = 'x-indeed-signature';

/**
 * The signed-bytes seam (R5). Given the raw request body, return the exact byte
 * sequence fed into HMAC-SHA1. Canonical Indeed scheme = the raw body verbatim.
 * This is the ONE place the "what is signed" decision lives.
 */
export function indeedSignedBytes(rawBody: Buffer): Buffer {
  return rawBody;
}

/**
 * Compute the expected `X-Indeed-Signature` value: base64(HMAC-SHA1(secret, body)).
 */
export function computeIndeedSignature(rawBody: Buffer, secret: string): string {
  return createHmac('sha1', secret)
    .update(indeedSignedBytes(rawBody))
    .digest('base64');
}

/**
 * Fail-closed verification (R5). Returns false on a missing header or any
 * mismatch. Length check FIRST (timingSafeEqual throws on unequal-length
 * buffers), constant-time compare SECOND.
 */
export function verifyIndeedSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (signatureHeader === undefined || signatureHeader.length === 0) {
    return false;
  }
  const expected = Buffer.from(computeIndeedSignature(rawBody, secret), 'utf8');
  const provided = Buffer.from(signatureHeader, 'utf8');
  if (expected.length !== provided.length) {
    return false;
  }
  return timingSafeEqual(expected, provided);
}
