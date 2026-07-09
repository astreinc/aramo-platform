import { describe, expect, it, vi } from 'vitest';

import { SourcingService } from '../talent-identity/sourcing.service.js';

// Unit coverage for the two sourcer triggers: promote-then-associate, gate-
// deferral short-circuit, and idempotency (pipeline P2002 no-op; already-promoted
// still associates).

const TENANT = '11111111-1111-7111-8111-111111111111';
const REF = { tenant_id: TENANT, ref_type: 'SOURCED_TALENT' as const, ref_id: 'payload-1' };
const REQ_ID = 'req-1';
const RECORD_ID = 'rec-1';

function make(parts: {
  promoteOutcome?: unknown;
  pipelineThrows?: 'P2002' | 'other';
  poolRows?: unknown[];
  displayEvidence?: unknown[];
  subject?: unknown;
  trustState?: unknown;
  evidence?: unknown[];
  refs?: unknown[];
  advisories?: unknown[];
} = {}) {
  const promoteSubject = vi
    .fn()
    .mockResolvedValue(parts.promoteOutcome ?? { status: 'promoted', talent_record_id: RECORD_ID });
  const promotion = { promoteSubject } as never;

  const create = parts.pipelineThrows
    ? vi.fn().mockRejectedValue(parts.pipelineThrows === 'P2002' ? { code: 'P2002' } : new Error('boom'))
    : vi.fn().mockResolvedValue({ id: 'pipe-1' });
  const pipelines = { create } as never;

  const getOrCreateTenantBench = vi.fn().mockResolvedValue({ id: 'bench-1' });
  const addToTenantBench = vi.fn().mockResolvedValue({ added: true });
  const savedLists = { getOrCreateTenantBench, addToTenantBench } as never;

  const listSourcedPool = vi.fn().mockResolvedValue(parts.poolRows ?? []);
  const listDisplayIdentityEvidence = vi.fn().mockResolvedValue(parts.displayEvidence ?? []);
  const findSubjectById = vi.fn().mockResolvedValue(
    parts.subject === undefined ? { id: 'subj-1', tenant_id: TENANT } : parts.subject,
  );
  const findTrustStateBySubject = vi.fn().mockResolvedValue(parts.trustState ?? null);
  // TR-14 B1 — getSubjectDetail now reads evidence CLUSTER-UNION (clusterMembers +
  // listEvidenceBySubjects) instead of the single-subject listEvidenceBySubject.
  const clusterMembers = vi.fn().mockResolvedValue(['subj-1']);
  const listEvidenceBySubjects = vi.fn().mockResolvedValue(parts.evidence ?? []);
  const listRefsBySubject = vi.fn().mockResolvedValue(parts.refs ?? []);
  const listMatchAdvisories = vi.fn().mockResolvedValue(parts.advisories ?? []);
  const trustRepo = {
    listSourcedPool,
    listDisplayIdentityEvidence,
    findSubjectById,
    findTrustStateBySubject,
    clusterMembers,
    listEvidenceBySubjects,
    listRefsBySubject,
    listMatchAdvisories,
  } as never;

  const service = new SourcingService(promotion, pipelines, savedLists, trustRepo);
  return { service, promoteSubject, create, getOrCreateTenantBench, addToTenantBench, listSourcedPool, listDisplayIdentityEvidence, findSubjectById, listMatchAdvisories };
}

describe('SourcingService.promoteAndAddToPipeline', () => {
  it('promoted → creates the pipeline row', async () => {
    const { service, create } = make();
    const result = await service.promoteAndAddToPipeline(REF, REQ_ID);
    expect(result).toEqual({ status: 'promoted', talent_record_id: RECORD_ID, pipeline_id: 'pipe-1' });
    expect(create).toHaveBeenCalledWith({
      tenant_id: TENANT,
      input: { talent_record_id: RECORD_ID, requisition_id: REQ_ID },
    });
  });

  it('gate deferral (deferred_unresolved_identity) → short-circuit, NO pipeline write', async () => {
    const { service, create } = make({ promoteOutcome: { status: 'deferred_unresolved_identity' } });
    const result = await service.promoteAndAddToPipeline(REF, REQ_ID);
    expect(result).toEqual({ status: 'deferred_unresolved_identity' });
    expect(create).not.toHaveBeenCalled();
  });

  it('already-promoted → still associates the existing record to the pipeline', async () => {
    const { service, create } = make({ promoteOutcome: { status: 'already_promoted', talent_record_id: RECORD_ID } });
    const result = await service.promoteAndAddToPipeline(REF, REQ_ID);
    expect(result.status).toBe('already_promoted');
    expect(create).toHaveBeenCalled();
  });

  it('duplicate pipeline (P2002) → idempotent no-op (no throw, pipeline_id null)', async () => {
    const { service } = make({ pipelineThrows: 'P2002' });
    const result = await service.promoteAndAddToPipeline(REF, REQ_ID);
    expect(result).toEqual({ status: 'promoted', talent_record_id: RECORD_ID, pipeline_id: null });
  });

  it('a non-unique pipeline error propagates', async () => {
    const { service } = make({ pipelineThrows: 'other' });
    await expect(service.promoteAndAddToPipeline(REF, REQ_ID)).rejects.toThrow('boom');
  });
});

describe('SourcingService.promoteAndSaveToBench', () => {
  it('promoted → get-or-create the tenant bench + add the record', async () => {
    const { service, getOrCreateTenantBench, addToTenantBench } = make();
    const result = await service.promoteAndSaveToBench(REF);
    expect(result).toEqual({ status: 'promoted', talent_record_id: RECORD_ID, bench_id: 'bench-1' });
    expect(getOrCreateTenantBench).toHaveBeenCalledWith(TENANT);
    expect(addToTenantBench).toHaveBeenCalledWith({
      tenant_id: TENANT,
      bench_id: 'bench-1',
      talent_record_id: RECORD_ID,
    });
  });

  it('gate deferral → short-circuit, NO bench write', async () => {
    const { service, getOrCreateTenantBench, addToTenantBench } = make({
      promoteOutcome: { status: 'deferred_no_name' },
    });
    const result = await service.promoteAndSaveToBench(REF);
    expect(result).toEqual({ status: 'deferred_no_name' });
    expect(getOrCreateTenantBench).not.toHaveBeenCalled();
    expect(addToTenantBench).not.toHaveBeenCalled();
  });
});

describe('SourcingService.getPool', () => {
  it('composes the anti-join list with batched display names (no N+1), sets bands + count', async () => {
    const created = new Date('2026-07-05T00:00:00.000Z');
    const { service, listDisplayIdentityEvidence } = make({
      poolRows: [
        { subject_id: 's1', created_at: created, identity_band: 'SELF_ASSERTED', claims_band: 'NOT_ESTABLISHED', continuity_band: 'NOT_ESTABLISHED', eligibility_band: 'NOT_ESTABLISHED', open_contradiction_count: 2 },
      ],
      displayEvidence: [
        { subject_id: 's1', assertion_type: 'FULL_NAME', assertion_payload: { first_name: 'Ada', last_name: 'Lovelace' } },
        { subject_id: 's1', assertion_type: 'EMAIL', assertion_payload: { normalized_value: 'ada@x.com' } },
      ],
    });
    const page = await service.getPool(TENANT, { limit: 50 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toEqual({
      subject_id: 's1',
      display_name: 'Ada Lovelace',
      email: 'ada@x.com',
      trust_bands: { identity: 'SELF_ASSERTED', claims: 'NOT_ESTABLISHED', continuity: 'NOT_ESTABLISHED', eligibility: 'NOT_ESTABLISHED' },
      open_contradiction_count: 2,
    });
    // one batched evidence read for the whole page.
    expect(listDisplayIdentityEvidence).toHaveBeenCalledWith(TENANT, ['s1']);
    // page < limit → no next cursor.
    expect(page.next_cursor).toBeNull();
  });

  it('emits an opaque next_cursor when the page is full (keyset)', async () => {
    const created = new Date('2026-07-05T00:00:00.000Z');
    const rows = Array.from({ length: 2 }, (_, i) => ({
      subject_id: `s${i}`, created_at: created, identity_band: null, claims_band: null, continuity_band: null, eligibility_band: null, open_contradiction_count: 0,
    }));
    const { service } = make({ poolRows: rows });
    const page = await service.getPool(TENANT, { limit: 2 });
    expect(page.next_cursor).not.toBeNull();
    // round-trips: decode(encode(created,'s1')) → the query would resume after s1.
    expect(typeof page.next_cursor).toBe('string');
  });

  it('empty pool → no evidence read, no cursor', async () => {
    const { service, listDisplayIdentityEvidence } = make({ poolRows: [] });
    const page = await service.getPool(TENANT);
    expect(page.items).toEqual([]);
    expect(page.next_cursor).toBeNull();
    expect(listDisplayIdentityEvidence).toHaveBeenCalledWith(TENANT, []);
  });
});

describe('SourcingService.getSubjectDetail', () => {
  it('composes trust + evidence + refs + PENDING identity advisories (tenant-scoped)', async () => {
    const { service, listMatchAdvisories } = make({
      trustState: { identity_band: 'CORROBORATED', claims_band: 'NOT_ESTABLISHED', continuity_band: 'NOT_ESTABLISHED', eligibility_band: 'NOT_ESTABLISHED', open_contradiction_count: 1, single_source_only: true, longitudinal_observed: true },
      // strength is present on the repo row and must be STRIPPED from the wire (TR-14 B1).
      evidence: [{ id: 'e1', assertion_type: 'FULL_NAME', assertion_payload: { first_name: 'Ada', last_name: 'Byron' }, current_status: 'VALID', strength: 0.42 }],
      refs: [{ ref_type: 'SOURCED_TALENT', ref_id: 'p1', link_source: 'x' }],
      advisories: [{ id: 'adv-1', status: 'PENDING_REVIEW' }],
    });
    const detail = await service.getSubjectDetail(TENANT, 'subj-1');
    expect(detail.subject_id).toBe('subj-1');
    expect(detail.display_name).toBe('Ada Byron');
    expect(detail.trust_bands?.identity).toBe('CORROBORATED');
    expect(detail.open_contradiction_count).toBe(1);
    expect(detail.open_identity_advisories).toHaveLength(1);
    // TR-14 B1 — the ungated `strength` ordinal is stripped from the wire.
    expect('strength' in detail.evidence[0]!).toBe(false);
    // TR-5 B2 (β1) — the flags surface as statements (strings only, no numbers).
    expect(detail.trust_statements).toEqual(['Evidence from a single source', 'Observed over time']);
    expect(detail.trust_statements.every((s) => !/\d/.test(s))).toBe(true);
    // only PENDING_REVIEW advisories for this subject.
    expect(listMatchAdvisories).toHaveBeenCalledWith(TENANT, { subjectId: 'subj-1', status: 'PENDING_REVIEW' });
  });

  it('404 when the subject is not in the caller tenant', async () => {
    const { service } = make({ subject: { id: 'subj-1', tenant_id: 'OTHER' } });
    await expect(service.getSubjectDetail(TENANT, 'subj-1')).rejects.toThrow();
  });

  it('404 when the subject does not exist', async () => {
    const { service } = make({ subject: null });
    await expect(service.getSubjectDetail(TENANT, 'subj-1')).rejects.toThrow();
  });
});
