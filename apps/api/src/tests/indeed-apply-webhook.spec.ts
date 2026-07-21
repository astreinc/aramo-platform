import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizeEmail, normalizePhone } from '@aramo/common';

import {
  computeIndeedSignature,
  verifyIndeedSignature,
  indeedSignedBytes,
} from '../webhooks/indeed-signature.js';
import { IndeedApplyWebhookService } from '../webhooks/indeed-apply.service.js';
import { INDEED_APPLY_WEBHOOK_SECRET_ENV } from '../webhooks/indeed-apply.constants.js';

// SRC-1 PR-2 unit coverage — the signature verifier (R5) + the processing
// service's fail-closed paths and R4 order. No Postgres/S3 — deps are mocked; the
// real spine is exercised in indeed-apply-webhook.integration.spec.ts.

const SECRET = 'test-indeed-apply-secret';
const TENANT_ID = '00000000-0000-4000-8000-000000000abc';

describe('verifyIndeedSignature (R5)', () => {
  const body = Buffer.from('{"id":"apply-1","applicant":{"email":"a@b.co"}}', 'utf8');

  it('accepts a correct base64 HMAC-SHA1 signature', () => {
    const sig = computeIndeedSignature(body, SECRET);
    expect(verifyIndeedSignature(body, sig, SECRET)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = computeIndeedSignature(body, SECRET);
    const tampered = Buffer.from(body.toString('utf8').replace('a@b.co', 'x@y.co'), 'utf8');
    expect(verifyIndeedSignature(tampered, sig, SECRET)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const sig = computeIndeedSignature(body, SECRET);
    expect(verifyIndeedSignature(body, sig, 'other-secret')).toBe(false);
  });

  it('rejects a missing/empty header', () => {
    expect(verifyIndeedSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyIndeedSignature(body, '', SECRET)).toBe(false);
  });

  it('rejects a wrong-length signature WITHOUT throwing (length check before timingSafeEqual)', () => {
    expect(() => verifyIndeedSignature(body, 'short', SECRET)).not.toThrow();
    expect(verifyIndeedSignature(body, 'short', SECRET)).toBe(false);
  });

  it('rejects an equal-length but different signature (constant-time branch)', () => {
    const sig = computeIndeedSignature(body, SECRET);
    // Flip the first char to a different base64 char, same length.
    const diff = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(diff.length).toBe(sig.length);
    expect(diff).not.toBe(sig);
    expect(verifyIndeedSignature(body, diff, SECRET)).toBe(false);
  });

  it('signs the raw body verbatim (the certification seam)', () => {
    expect(indeedSignedBytes(body).equals(body)).toBe(true);
  });
});

interface Mocks {
  service: IndeedApplyWebhookService;
  objectStorage: { putIngestionObject: ReturnType<typeof vi.fn> };
  ingestion: { acceptPayload: ReturnType<typeof vi.fn> };
  tenants: { findActiveBySlug: ReturnType<typeof vi.fn> };
  arrivals: { recordArrival: ReturnType<typeof vi.fn> };
}

function makeService(): Mocks {
  const objectStorage = {
    putIngestionObject: vi
      .fn()
      .mockResolvedValue({ storage_ref: 's3://bucket/key', sha256: 'a'.repeat(64) }),
  };
  const ingestion = {
    acceptPayload: vi.fn().mockResolvedValue({ id: 'ingest-1' }),
  };
  const tenants = {
    findActiveBySlug: vi.fn().mockResolvedValue({ id: TENANT_ID }),
  };
  const arrivals = {
    recordArrival: vi.fn().mockResolvedValue({ id: 'arrival-1' }),
  };
  const service = new IndeedApplyWebhookService(
    objectStorage as never,
    ingestion as never,
    tenants as never,
    arrivals as never,
  );
  return { service, objectStorage, ingestion, tenants, arrivals };
}

describe('IndeedApplyWebhookService (fail-closed + R4 order)', () => {
  const originalSecret = process.env[INDEED_APPLY_WEBHOOK_SECRET_ENV];

  afterEach(() => {
    if (originalSecret === undefined) delete process.env[INDEED_APPLY_WEBHOOK_SECRET_ENV];
    else process.env[INDEED_APPLY_WEBHOOK_SECRET_ENV] = originalSecret;
    vi.restoreAllMocks();
  });

  it('503 when the webhook secret is unset — refuses ALL traffic, no downstream calls', async () => {
    delete process.env[INDEED_APPLY_WEBHOOK_SECRET_ENV];
    const m = makeService();
    const body = Buffer.from('{"id":"apply-1"}', 'utf8');
    const outcome = await m.service.process({
      rawBody: body,
      // Even a correct-looking signature must not matter — there is no secret.
      signatureHeader: 'anything',
      host: 'acme.aramo.ai',
      requestId: 'r',
    });
    expect(outcome.status).toBe(503);
    expect(m.tenants.findActiveBySlug).not.toHaveBeenCalled();
    expect(m.objectStorage.putIngestionObject).not.toHaveBeenCalled();
    expect(m.ingestion.acceptPayload).not.toHaveBeenCalled();
    expect(m.arrivals.recordArrival).not.toHaveBeenCalled();
  });

  it('401 on a missing signature (secret set) — before any tenant probe', async () => {
    process.env[INDEED_APPLY_WEBHOOK_SECRET_ENV] = SECRET;
    const m = makeService();
    const outcome = await m.service.process({
      rawBody: Buffer.from('{"id":"apply-1"}', 'utf8'),
      signatureHeader: undefined,
      host: 'acme.aramo.ai',
      requestId: 'r',
    });
    expect(outcome.status).toBe(401);
    expect(m.tenants.findActiveBySlug).not.toHaveBeenCalled();
    expect(m.objectStorage.putIngestionObject).not.toHaveBeenCalled();
  });

  it('401 on an invalid signature', async () => {
    process.env[INDEED_APPLY_WEBHOOK_SECRET_ENV] = SECRET;
    const m = makeService();
    const outcome = await m.service.process({
      rawBody: Buffer.from('{"id":"apply-1"}', 'utf8'),
      signatureHeader: 'not-the-right-signature',
      host: 'acme.aramo.ai',
      requestId: 'r',
    });
    expect(outcome.status).toBe(401);
    expect(m.objectStorage.putIngestionObject).not.toHaveBeenCalled();
  });

  it('404 on unknown/inactive slug (after a valid signature) — no storage write', async () => {
    process.env[INDEED_APPLY_WEBHOOK_SECRET_ENV] = SECRET;
    const m = makeService();
    m.tenants.findActiveBySlug.mockResolvedValue(null);
    const body = Buffer.from('{"id":"apply-1"}', 'utf8');
    const outcome = await m.service.process({
      rawBody: body,
      signatureHeader: computeIndeedSignature(body, SECRET),
      host: 'ghost.aramo.ai',
      requestId: 'r',
    });
    expect(outcome.status).toBe(404);
    expect(m.objectStorage.putIngestionObject).not.toHaveBeenCalled();
    expect(m.arrivals.recordArrival).not.toHaveBeenCalled();
  });

  it('400 on a malformed payload (no apply_id) — no storage write', async () => {
    process.env[INDEED_APPLY_WEBHOOK_SECRET_ENV] = SECRET;
    const m = makeService();
    const body = Buffer.from('{"applicant":{"email":"a@b.co"}}', 'utf8');
    const outcome = await m.service.process({
      rawBody: body,
      signatureHeader: computeIndeedSignature(body, SECRET),
      host: 'acme.aramo.ai',
      requestId: 'r',
    });
    expect(outcome.status).toBe(400);
    expect(m.objectStorage.putIngestionObject).not.toHaveBeenCalled();
  });

  it('200 happy path — R4 order, apply_id dedup key, @aramo/common normalization (R8)', async () => {
    process.env[INDEED_APPLY_WEBHOOK_SECRET_ENV] = SECRET;
    const m = makeService();
    const payload = {
      id: 'apply-xyz',
      applicant: {
        fullName: 'Ada Lovelace',
        email: 'ADA@Example.com',
        phoneNumber: '+1 (415) 555-0100',
      },
    };
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const outcome = await m.service.process({
      rawBody: body,
      signatureHeader: computeIndeedSignature(body, SECRET),
      host: 'acme.aramo.ai',
      requestId: 'req-happy',
    });

    expect(outcome).toEqual({
      status: 200,
      arrival_id: 'arrival-1',
      ingestion_payload_id: 'ingest-1',
    });

    // Step 2 — raw bytes to object storage (channel lowercase, id = apply_id).
    expect(m.objectStorage.putIngestionObject).toHaveBeenCalledTimes(1);
    const putArg = m.objectStorage.putIngestionObject.mock.calls[0][0];
    expect(putArg.tenant_id).toBe(TENANT_ID);
    expect(putArg.channel).toBe('indeed');
    expect(putArg.external_source_id).toBe('apply-xyz');
    expect(Buffer.compare(putArg.body, body)).toBe(0);
    expect(putArg.content_type).toBe('application/json');

    // Step 3 — front door, source 'indeed', storage_ref+sha256 from step 2,
    // verified_email NOT set, declared_name carried.
    const acceptArg = m.ingestion.acceptPayload.mock.calls[0][0];
    expect(acceptArg.tenant_id).toBe(TENANT_ID);
    expect(acceptArg.request.source).toBe('indeed');
    expect(acceptArg.request.storage_ref).toBe('s3://bucket/key');
    expect(acceptArg.request.sha256).toBe('a'.repeat(64));
    expect(acceptArg.request.declared_name).toBe('Ada Lovelace');
    expect(acceptArg.request.verified_email).toBeUndefined();

    // Step 4 — dedup memory. external_source_id = apply_id; normalized contact via
    // @aramo/common; placeholder legal_basis; provenance carries the ingestion id
    // + the signature HEADER NAME (not value).
    const recordArg = m.arrivals.recordArrival.mock.calls[0][0];
    expect(recordArg.source_channel).toBe('INDEED');
    expect(recordArg.external_source_id).toBe('apply-xyz');
    expect(recordArg.normalized_email).toBe(normalizeEmail('ADA@Example.com'));
    expect(recordArg.normalized_phone).toBe(normalizePhone('+1 (415) 555-0100'));
    expect(recordArg.legal_basis).toEqual({
      basis: 'first_party_application',
      jurisdiction_note: 'PENDING_COUNSEL_A4',
    });
    expect(recordArg.provenance.ingestion_payload_id).toBe('ingest-1');
    expect(recordArg.provenance.signature_header).toBe('x-indeed-signature');
    expect(recordArg.provenance.applicant.apply_id).toBe('apply-xyz');
  });
});
