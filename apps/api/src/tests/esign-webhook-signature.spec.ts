import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  computeEsignWebhookSignature,
  verifyEsignWebhookSignature,
} from '../integrations/esign/esign-webhook-signature.js';

const SECRET = 'top-secret';
const NOW = 1_790_550_000;
const TOL = 300;
const BODY = Buffer.from(JSON.stringify({ event_id: 'e1', envelope_id: 'env1', tenant_id: 't1' }), 'utf8');

function sign(ts: string, body: Buffer, secret = SECRET): string {
  return computeEsignWebhookSignature(ts, body, secret);
}

describe('verifyEsignWebhookSignature (Core-side HMAC + timestamp replay guard)', () => {
  it('accepts a correctly signed, in-window request', () => {
    const ts = String(NOW);
    expect(
      verifyEsignWebhookSignature({ rawBody: BODY, timestampHeader: ts, signatureHeader: sign(ts, BODY), secret: SECRET, nowSec: NOW, toleranceSec: TOL }),
    ).toEqual({ ok: true });
  });

  it('reports NO_SECRET (dark) when the signing secret is unset', () => {
    const ts = String(NOW);
    expect(
      verifyEsignWebhookSignature({ rawBody: BODY, timestampHeader: ts, signatureHeader: sign(ts, BODY), secret: undefined, nowSec: NOW, toleranceSec: TOL }),
    ).toEqual({ ok: false, reason: 'NO_SECRET' });
  });

  it('rejects a stale timestamp outside the replay window', () => {
    const staleTs = String(NOW - TOL - 1);
    expect(
      verifyEsignWebhookSignature({ rawBody: BODY, timestampHeader: staleTs, signatureHeader: sign(staleTs, BODY), secret: SECRET, nowSec: NOW, toleranceSec: TOL }),
    ).toEqual({ ok: false, reason: 'STALE' });
  });

  it('rejects a future timestamp outside the window (captured-request replay)', () => {
    const futureTs = String(NOW + TOL + 5);
    expect(
      verifyEsignWebhookSignature({ rawBody: BODY, timestampHeader: futureTs, signatureHeader: sign(futureTs, BODY), secret: SECRET, nowSec: NOW, toleranceSec: TOL }),
    ).toEqual({ ok: false, reason: 'STALE' });
  });

  it('rejects a tampered body (signature no longer matches the bytes)', () => {
    const ts = String(NOW);
    const sig = sign(ts, BODY);
    const tampered = Buffer.from(JSON.stringify({ event_id: 'e1', envelope_id: 'ENV-EVIL', tenant_id: 't1' }), 'utf8');
    expect(
      verifyEsignWebhookSignature({ rawBody: tampered, timestampHeader: ts, signatureHeader: sig, secret: SECRET, nowSec: NOW, toleranceSec: TOL }),
    ).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('rejects a signature made with the wrong secret', () => {
    const ts = String(NOW);
    expect(
      verifyEsignWebhookSignature({ rawBody: BODY, timestampHeader: ts, signatureHeader: sign(ts, BODY, 'wrong'), secret: SECRET, nowSec: NOW, toleranceSec: TOL }),
    ).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('reports MISSING when a header is absent', () => {
    const ts = String(NOW);
    expect(
      verifyEsignWebhookSignature({ rawBody: BODY, timestampHeader: undefined, signatureHeader: sign(ts, BODY), secret: SECRET, nowSec: NOW, toleranceSec: TOL }),
    ).toEqual({ ok: false, reason: 'MISSING' });
    expect(
      verifyEsignWebhookSignature({ rawBody: BODY, timestampHeader: ts, signatureHeader: undefined, secret: SECRET, nowSec: NOW, toleranceSec: TOL }),
    ).toEqual({ ok: false, reason: 'MISSING' });
  });

  it('interops with the producer formula `${timestamp}.${rawBodyString}`', () => {
    const ts = String(NOW);
    const producerStyle = createHmac('sha256', SECRET).update(`${ts}.${BODY.toString('utf8')}`).digest('base64');
    expect(sign(ts, BODY)).toBe(producerStyle);
  });
});
