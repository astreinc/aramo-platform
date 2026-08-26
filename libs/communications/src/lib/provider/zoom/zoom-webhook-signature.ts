import { createHmac, timingSafeEqual } from 'node:crypto';

// COMM-B6 — Zoom webhook signature verification (Zoom's CURRENT documented
// scheme; the legacy verification-token approach is deprecated). Vendor code
// lives under provider/zoom/, confined behind the communications boundary and
// OUTSIDE the provider-neutrality scan, so Zoom terminology is legal here.
//
//   headers: x-zm-request-timestamp, x-zm-signature
//   message: `v0:{timestamp}:{raw request body}`
//   digest : HMAC-SHA256(secret, message) as lowercase hex
//   header : `v0=<hex digest>`
//   compare: constant-time (timingSafeEqual)
//   freshness: |now - timestamp| must be within the replay tolerance window
//
// Pure + deterministic: the caller injects `nowEpochSec` so it is CI-testable
// without a live Zoom. The raw request body MUST be the exact bytes Zoom signed
// (the route mounts a raw-body parser — never the re-serialized JSON).

export interface ZoomSignatureInput {
  /** The exact raw request body Zoom signed. */
  readonly rawBody: string;
  /** `x-zm-request-timestamp` header (unix seconds, as a string). */
  readonly timestamp: string;
  /** `x-zm-signature` header, expected format `v0=<hex>`. */
  readonly signatureHeader: string;
  /** The app-level webhook signing secret (resolved memory-only at the caller). */
  readonly secret: string;
  /** Current time in unix seconds (injected for determinism/testing). */
  readonly nowEpochSec: number;
  /** Replay window: reject if |now - timestamp| exceeds this many seconds. */
  readonly toleranceSec: number;
}

export type ZoomSignatureResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'missing' | 'malformed' | 'stale' | 'mismatch' };

const V0_PREFIX = 'v0=';

export function verifyZoomWebhookSignature(input: ZoomSignatureInput): ZoomSignatureResult {
  const { rawBody, timestamp, signatureHeader, secret, nowEpochSec, toleranceSec } = input;

  if (timestamp.length === 0 || signatureHeader.length === 0) {
    return { ok: false, reason: 'missing' };
  }

  // Timestamp must be an integer number of unix seconds.
  if (!/^\d+$/.test(timestamp)) {
    return { ok: false, reason: 'malformed' };
  }
  const ts = Number(timestamp);

  // Freshness / replay window — a correctly signed but stale captured request
  // must not remain replayable. Zoom's algorithm folds the timestamp into the
  // signed message, so tampering with `ts` invalidates the signature anyway;
  // this bounds the window in which a captured-verbatim request is accepted.
  if (Math.abs(nowEpochSec - ts) > toleranceSec) {
    return { ok: false, reason: 'stale' };
  }

  if (!signatureHeader.startsWith(V0_PREFIX)) {
    return { ok: false, reason: 'malformed' };
  }
  const provided = signatureHeader.slice(V0_PREFIX.length);
  // Hex-only guard so Buffer.from below is unambiguous.
  if (provided.length === 0 || !/^[0-9a-f]+$/i.test(provided)) {
    return { ok: false, reason: 'malformed' };
  }

  const expected = createHmac('sha256', secret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest('hex');

  // Constant-time compare; unequal length can't be timingSafeEqual'd, so guard
  // it first (a length mismatch is itself a mismatch, not an oracle).
  if (provided.length !== expected.length) {
    return { ok: false, reason: 'mismatch' };
  }
  const equal = timingSafeEqual(
    Buffer.from(provided, 'utf8'),
    Buffer.from(expected, 'utf8'),
  );
  return equal ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/** Zoom `endpoint.url_validation`: encryptedToken = HMAC-SHA256(secret, plainToken) hex. */
export function computeZoomUrlValidationResponse(
  plainToken: string,
  secret: string,
): { readonly plainToken: string; readonly encryptedToken: string } {
  const encryptedToken = createHmac('sha256', secret).update(plainToken).digest('hex');
  return { plainToken, encryptedToken };
}
