import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  computeZoomUrlValidationResponse,
  verifyZoomWebhookSignature,
} from '../lib/provider/zoom/zoom-webhook-signature.js';

// COMM-B6 — Zoom webhook signature verification (current documented scheme, NOT
// the deprecated verification-token). message = `v0:{timestamp}:{rawBody}`,
// HMAC-SHA256, header `x-zm-signature: v0=<hex>`, constant-time compare, and a
// freshness (replay) window around `x-zm-request-timestamp`. Pure + deterministic
// (the caller injects `nowEpochSec`), so it is CI-testable without a live Zoom.

const SECRET = 'zoom-webhook-signing-secret';
const NOW = 1_800_000_000;

function sign(rawBody: string, ts: string, secret = SECRET): string {
  const digest = createHmac('sha256', secret).update(`v0:${ts}:${rawBody}`).digest('hex');
  return `v0=${digest}`;
}

describe('verifyZoomWebhookSignature', () => {
  const body = '{"event":"phone.callee_ringing"}';
  const ts = String(NOW - 5);

  it('accepts a correctly signed, fresh request', () => {
    const res = verifyZoomWebhookSignature({
      rawBody: body,
      timestamp: ts,
      signatureHeader: sign(body, ts),
      secret: SECRET,
      nowEpochSec: NOW,
      toleranceSec: 300,
    });
    expect(res.ok).toBe(true);
  });

  it('rejects a missing timestamp or signature header', () => {
    expect(
      verifyZoomWebhookSignature({ rawBody: body, timestamp: '', signatureHeader: sign(body, ts), secret: SECRET, nowEpochSec: NOW, toleranceSec: 300 }),
    ).toEqual({ ok: false, reason: 'missing' });
    expect(
      verifyZoomWebhookSignature({ rawBody: body, timestamp: ts, signatureHeader: '', secret: SECRET, nowEpochSec: NOW, toleranceSec: 300 }),
    ).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejects a malformed signature header (no v0= prefix / non-integer ts)', () => {
    expect(
      verifyZoomWebhookSignature({ rawBody: body, timestamp: ts, signatureHeader: 'deadbeef', secret: SECRET, nowEpochSec: NOW, toleranceSec: 300 }).ok,
    ).toBe(false);
    expect(
      verifyZoomWebhookSignature({ rawBody: body, timestamp: 'not-a-number', signatureHeader: sign(body, 'not-a-number'), secret: SECRET, nowEpochSec: NOW, toleranceSec: 300 }),
    ).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a stale (replayed) request outside the tolerance window', () => {
    const oldTs = String(NOW - 4000);
    const res = verifyZoomWebhookSignature({
      rawBody: body,
      timestamp: oldTs,
      signatureHeader: sign(body, oldTs),
      secret: SECRET,
      nowEpochSec: NOW,
      toleranceSec: 300,
    });
    expect(res).toEqual({ ok: false, reason: 'stale' });
  });

  it('rejects a wrong-secret signature (mismatch), constant-time', () => {
    const res = verifyZoomWebhookSignature({
      rawBody: body,
      timestamp: ts,
      signatureHeader: sign(body, ts, 'the-wrong-secret'),
      secret: SECRET,
      nowEpochSec: NOW,
      toleranceSec: 300,
    });
    expect(res).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a tampered body (signature no longer matches)', () => {
    const res = verifyZoomWebhookSignature({
      rawBody: '{"event":"phone.call_ended"}', // different from the signed body
      timestamp: ts,
      signatureHeader: sign(body, ts),
      secret: SECRET,
      nowEpochSec: NOW,
      toleranceSec: 300,
    });
    expect(res.ok).toBe(false);
  });
});

describe('computeZoomUrlValidationResponse', () => {
  it('returns plainToken + HMAC-SHA256(plainToken) as encryptedToken', () => {
    const plainToken = 'abc123plain';
    const out = computeZoomUrlValidationResponse(plainToken, SECRET);
    expect(out.plainToken).toBe(plainToken);
    expect(out.encryptedToken).toBe(
      createHmac('sha256', SECRET).update(plainToken).digest('hex'),
    );
  });
});
