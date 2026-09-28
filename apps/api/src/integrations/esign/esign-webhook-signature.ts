import { createHmac, timingSafeEqual } from 'node:crypto';

// E-Sign OC v2 — Core-side verifier for the E-Sign lifecycle webhook. A SEPARATE
// integration verifier (deliberately NOT coupled to the Indeed webhook verifier):
// same coding pattern (raw-body HMAC, length-check-first, constant-time compare),
// distinct scheme.
//
// The signature is HMAC-SHA256 over `${timestamp}.` + the EXACT raw request body
// bytes, matching the producer (apps/esign-service HttpWebhookEventPublisher). Two
// protections combine: a bounded timestamp window (rejects captured-request
// replay) + event_id dedup at the handler (business-level duplicate protection).

export function computeEsignWebhookSignature(timestamp: string, rawBody: Buffer, secret: string): string {
  const signed = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]);
  return createHmac('sha256', secret).update(signed).digest('base64');
}

export type EsignWebhookVerifyReason = 'NO_SECRET' | 'MISSING' | 'STALE' | 'BAD_SIGNATURE';

export interface EsignWebhookVerifyResult {
  ok: boolean;
  reason?: EsignWebhookVerifyReason;
}

// Fail-closed verification. Order matters: secret presence (503 dark) -> header
// presence -> timestamp window -> length check -> constant-time compare.
export function verifyEsignWebhookSignature(input: {
  rawBody: Buffer;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  secret: string | undefined;
  nowSec: number;
  toleranceSec: number;
}): EsignWebhookVerifyResult {
  const { rawBody, timestampHeader, signatureHeader, secret, nowSec, toleranceSec } = input;
  if (secret === undefined || secret.length === 0) return { ok: false, reason: 'NO_SECRET' };
  if (
    timestampHeader === undefined ||
    timestampHeader.length === 0 ||
    signatureHeader === undefined ||
    signatureHeader.length === 0
  ) {
    return { ok: false, reason: 'MISSING' };
  }
  const ts = Number(timestampHeader);
  if (!Number.isInteger(ts)) return { ok: false, reason: 'MISSING' };
  if (Math.abs(nowSec - ts) > toleranceSec) return { ok: false, reason: 'STALE' };

  const expected = Buffer.from(computeEsignWebhookSignature(timestampHeader, rawBody, secret), 'utf8');
  const provided = Buffer.from(signatureHeader, 'utf8');
  if (expected.length !== provided.length) return { ok: false, reason: 'BAD_SIGNATURE' };
  return timingSafeEqual(expected, provided) ? { ok: true } : { ok: false, reason: 'BAD_SIGNATURE' };
}
