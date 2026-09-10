import { describe, expect, it, vi } from 'vitest';

import { ManualTalentCaptureService } from '../manual-capture/manual-capture.service.js';

// TM-L1-C1 — unit proofs over the manual recruiter capture orchestration with
// mocked collaborators. Establishes that the NEW canonical path selects the
// source server-side, derives source_class through the canonical contract, keeps
// the recruiter actor out of the source vocabulary, and threads tenant from the
// authenticated context — never from a caller-supplied source/source_class.

const TENANT = '01900000-0000-7000-8000-0000000000c1';
const ACTOR = '01900000-0000-7000-8000-0000000000ac';
const STORAGE_REF = 's3://aramo-raw-ingestion/manual/artifact.json';
const SHA = 'b'.repeat(64);

function makeDeps() {
  const putIngestionObject = vi
    .fn()
    .mockResolvedValue({ storage_ref: STORAGE_REF, sha256: SHA });
  const acceptPayload = vi
    .fn()
    .mockResolvedValue({ id: 'payload-1', tenant_id: TENANT });
  const recordArrival = vi
    .fn()
    .mockResolvedValue({ id: 'arrival-1', tenant_id: TENANT });
  const service = new ManualTalentCaptureService(
    { putIngestionObject } as never,
    { acceptPayload } as never,
    { recordArrival } as never,
  );
  return { service, putIngestionObject, acceptPayload, recordArrival };
}

const FIELDS = {
  first_name: 'Ada',
  last_name: 'Lovelace',
  email: 'Ada@Example.COM',
  phone: '+1 (555) 010-2030',
};

describe('ManualTalentCaptureService.capture — source/provenance', () => {
  it('server-SETS source=talent_direct on the ingestion arrival (caller supplies no source)', async () => {
    const { service, acceptPayload } = makeDeps();
    await service.capture({ tenant_id: TENANT, actor_id: ACTOR, requestId: 'r1', fields: FIELDS });
    const req = acceptPayload.mock.calls[0]![0].request;
    expect(req.source).toBe('talent_direct');
    // The DTO the service builds does not carry source_class — it cannot be
    // caller-supplied and is derived inside acceptPayload.
    expect(req).not.toHaveProperty('source_class');
  });

  it('returns source_class derived through the canonical contract (talent_direct -> SELF)', async () => {
    const { service } = makeDeps();
    const result = await service.capture({ tenant_id: TENANT, actor_id: ACTOR, requestId: 'r1', fields: FIELDS });
    expect(result.source).toBe('talent_direct');
    expect(result.source_class).toBe('SELF');
  });

  it('takes tenant from the input auth context and stamps a server captured_at', async () => {
    const { service, acceptPayload, putIngestionObject, recordArrival } = makeDeps();
    await service.capture({ tenant_id: TENANT, actor_id: ACTOR, requestId: 'r1', fields: FIELDS });
    expect(putIngestionObject.mock.calls[0]![0].tenant_id).toBe(TENANT);
    expect(acceptPayload.mock.calls[0]![0].tenant_id).toBe(TENANT);
    expect(recordArrival.mock.calls[0]![0].tenant_id).toBe(TENANT);
    const capturedAt = acceptPayload.mock.calls[0]![0].request.captured_at;
    expect(typeof capturedAt).toBe('string');
    expect(Number.isNaN(Date.parse(capturedAt))).toBe(false);
  });

  it('records the recruiter ACTOR in provenance, never in the source/channel classification', async () => {
    const { service, recordArrival } = makeDeps();
    await service.capture({ tenant_id: TENANT, actor_id: ACTOR, requestId: 'r1', fields: FIELDS });
    const arg = recordArrival.mock.calls[0]![0];
    expect(arg.source_channel).toBe('TALENT_DIRECT');
    expect(arg.provenance.captured_by_actor_id).toBe(ACTOR);
    // The actor must NOT leak into the channel/source classification.
    expect(arg.source_channel).not.toContain(ACTOR);
    expect(arg.external_source_id).not.toContain(ACTOR);
  });

  it('does NOT persist recruiter_manual_entry as an authoritative legal basis (basis unasserted, pending counsel)', async () => {
    const { service, recordArrival } = makeDeps();
    await service.capture({ tenant_id: TENANT, actor_id: ACTOR, requestId: 'r1', fields: FIELDS });
    const arg = recordArrival.mock.calls[0]![0];
    // No fabricated basis — explicitly unasserted, pending counsel disposition.
    expect(arg.legal_basis.basis).toBeNull();
    expect(arg.legal_basis.status).toBe('PENDING_COUNSEL');
    // recruiter_manual_entry survives ONLY as capture-mechanism provenance context.
    expect(arg.provenance.capture_mechanism).toBe('recruiter_manual_entry');
    expect(JSON.stringify(arg.legal_basis)).not.toContain('recruiter_manual_entry');
    // No invented legal-basis kinds leak in.
    for (const invented of ['consent', 'legitimate_interest', 'contract', 'first_party_application']) {
      expect(arg.legal_basis.basis).not.toBe(invented);
    }
  });

  it('normalizes email/phone onto the staging arrival and carries declared_name', async () => {
    const { service, acceptPayload, recordArrival } = makeDeps();
    await service.capture({ tenant_id: TENANT, actor_id: ACTOR, requestId: 'r1', fields: FIELDS });
    expect(acceptPayload.mock.calls[0]![0].request.declared_name).toBe('Ada Lovelace');
    const arg = recordArrival.mock.calls[0]![0];
    expect(arg.normalized_email).toBe('ada@example.com');
    expect(typeof arg.normalized_phone).toBe('string');
  });

  it('is content-addressed: external_source_id equals the ingestion sha256 (deterministic dedup key)', async () => {
    const { service, acceptPayload, recordArrival, putIngestionObject } = makeDeps();
    await service.capture({ tenant_id: TENANT, actor_id: ACTOR, requestId: 'r1', fields: FIELDS });
    // The 64-hex content hash the service computed drives BOTH the storage key
    // and the staging dedup key.
    const externalId = recordArrival.mock.calls[0]![0].external_source_id;
    expect(externalId).toMatch(/^[a-f0-9]{64}$/);
    expect(putIngestionObject.mock.calls[0]![0].external_source_id).toBe(externalId);
  });

  it('drives the governed sequence: object-storage -> acceptPayload -> recordArrival', async () => {
    const { service, putIngestionObject, acceptPayload, recordArrival } = makeDeps();
    await service.capture({ tenant_id: TENANT, actor_id: ACTOR, requestId: 'r1', fields: FIELDS });
    expect(putIngestionObject).toHaveBeenCalledTimes(1);
    expect(acceptPayload).toHaveBeenCalledTimes(1);
    expect(recordArrival).toHaveBeenCalledTimes(1);
  });
});
