import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  INTELLIGENCE_WEBHOOK_SIGNATURE_HEADER,
  INTELLIGENCE_WEBHOOK_TIMESTAMP_HEADER,
  canonicalIntelligenceWebhookMessage,
  isIntelligenceProfileUpdatedWebhook,
  signIntelligenceWebhook,
  validateConfirmVerificationRequest,
  validateCreateVerificationRequest,
  verifyIntelligenceWebhook,
} from '../index.js';

// ATI-SEP-1 T7 — the TI → ATS webhook HMAC (shared by signer and verifier) and
// the T4 verification request validators.

const SECRET = 's'.repeat(40);
const BODY = JSON.stringify({ a: 1 });

describe('intelligence webhook HMAC (aramo-intelligence-webhook-v1)', () => {
  it('signs the scheme-tagged canonical message and verifies the exact bytes', () => {
    const h = signIntelligenceWebhook({ rawBody: BODY, secret: SECRET, nowSec: 1_000_000 });
    expect(h[INTELLIGENCE_WEBHOOK_TIMESTAMP_HEADER]).toBe('1000000');
    const expected = createHmac('sha256', SECRET).update(`aramo-intelligence-webhook-v1\n1000000\n${BODY}`).digest('base64');
    expect(h[INTELLIGENCE_WEBHOOK_SIGNATURE_HEADER]).toBe(expected);
    expect(canonicalIntelligenceWebhookMessage('1', 'x')).toBe('aramo-intelligence-webhook-v1\n1\nx');
    const ok = { rawBody: BODY, timestampHeader: '1000000', signatureHeader: expected, secret: SECRET, nowSec: 1_000_100 };
    expect(verifyIntelligenceWebhook(ok)).toEqual({ ok: true });
  });

  it('fails closed: no secret, missing headers, malformed / stale timestamp, tampered body, wrong secret', () => {
    const sig = signIntelligenceWebhook({ rawBody: BODY, secret: SECRET, nowSec: 1_000_000 })[INTELLIGENCE_WEBHOOK_SIGNATURE_HEADER];
    const base = { rawBody: BODY, timestampHeader: '1000000', signatureHeader: sig, secret: SECRET, nowSec: 1_000_000 };
    expect(verifyIntelligenceWebhook({ ...base, secret: undefined }).reason).toBe('NO_SECRET');
    expect(verifyIntelligenceWebhook({ ...base, signatureHeader: undefined }).reason).toBe('MISSING');
    expect(verifyIntelligenceWebhook({ ...base, timestampHeader: '12a' }).reason).toBe('MALFORMED');
    expect(verifyIntelligenceWebhook({ ...base, nowSec: 1_000_301 }).reason).toBe('STALE');
    expect(verifyIntelligenceWebhook({ ...base, rawBody: `${BODY} ` }).reason).toBe('BAD_SIGNATURE');
    expect(verifyIntelligenceWebhook({ ...base, secret: 'x'.repeat(40) }).reason).toBe('BAD_SIGNATURE');
    expect(verifyIntelligenceWebhook({ ...base, signatureHeader: 'short' }).reason).toBe('BAD_SIGNATURE');
    expect(() => signIntelligenceWebhook({ rawBody: BODY, secret: '', nowSec: 1 })).toThrow();
  });

  it('the webhook body guard accepts exactly the envelope + reference keys', () => {
    const body = {
      event_id: 'e1',
      event_type: 'golden_talent.profile_updated',
      event_version: 'v1',
      intelligence_subject_id: 's1',
      occurred_at: '2026-10-23T00:00:00.000Z',
      source_system_id: 'ARAMO_ATS',
      source_tenant_id: 't1',
      external_talent_id: 'x1',
      changed_fact_types: ['SKILL'],
    };
    expect(isIntelligenceProfileUpdatedWebhook(body)).toBe(true);
    expect(isIntelligenceProfileUpdatedWebhook({ ...body, email: 'a@b.c' })).toBe(false);
    expect(isIntelligenceProfileUpdatedWebhook({ ...body, event_version: 'v2' })).toBe(false);
    expect(isIntelligenceProfileUpdatedWebhook({ ...body, source_tenant_id: '' })).toBe(false);
    expect(isIntelligenceProfileUpdatedWebhook({ ...body, changed_fact_types: [1] })).toBe(false);
  });
});

describe('verification request validators', () => {
  const ref = { source_system_id: 'ARAMO_ATS', source_tenant_id: 't1', external_talent_id: 'x1' };
  it('create: exactly one of source_reference / portal_context; closed keys; shaped value', () => {
    expect(validateCreateVerificationRequest({ source_reference: ref, identifier_type: 'EMAIL', value: 'a@b.io' }).ok).toBe(true);
    expect(validateCreateVerificationRequest({ portal_context: { portal_session_id: 'p1' }, identifier_type: 'PHONE', value: '+1 555 010 2000' }).ok).toBe(true);
    expect(validateCreateVerificationRequest({ identifier_type: 'EMAIL', value: 'a@b.io' }).ok).toBe(false);
    expect(validateCreateVerificationRequest({ source_reference: ref, portal_context: { portal_session_id: 'p1' }, identifier_type: 'EMAIL', value: 'a@b.io' }).ok).toBe(false);
    expect(validateCreateVerificationRequest({ source_reference: { ...ref, extra: 1 }, identifier_type: 'EMAIL', value: 'a@b.io' }).ok).toBe(false);
    expect(validateCreateVerificationRequest({ source_reference: ref, identifier_type: 'GOV_ID', value: 'x' }).ok).toBe(false);
    expect(validateCreateVerificationRequest({ source_reference: ref, identifier_type: 'EMAIL', value: 'nope' }).ok).toBe(false);
    expect(validateCreateVerificationRequest({ source_reference: ref, identifier_type: 'EMAIL', value: 'a@b.io', code: '1' }).ok).toBe(false);
  });
  it('confirm: exactly six digits', () => {
    expect(validateConfirmVerificationRequest({ code: '012345' })).toEqual({ ok: true, value: { code: '012345' } });
    expect(validateConfirmVerificationRequest({ code: '12345' }).ok).toBe(false);
    expect(validateConfirmVerificationRequest({ code: 123456 }).ok).toBe(false);
    expect(validateConfirmVerificationRequest({ code: '123456', x: 1 }).ok).toBe(false);
  });
});
