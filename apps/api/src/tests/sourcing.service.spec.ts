import { describe, expect, it, vi } from 'vitest';

import { SourcingService } from '../talent-identity/sourcing.service.js';

// Unit coverage for the two sourcer triggers: promote-then-associate, gate-
// deferral short-circuit, and idempotency. E6 (Q-2): the idempotent no-op now
// comes from catching the pipeline application guard's EXACT one-live refusal
// (PIPELINE_EPISODE_ALREADY_LIVE), NOT a generic P2002 — a bare P2002 propagates.
// ATI-SEP-1 T10 WP2 — plus the ATS-local pool / drill-in readers (sourced_talent
// arrivals + the ATS duplicate advisories; no trust ledger).

const TENANT = '11111111-1111-7111-8111-111111111111';
const REF = { tenant_id: TENANT, sourced_talent_id: 'arrival-1' };
const REQ_ID = 'req-1';
const RECORD_ID = 'rec-1';

function arrivalRow(id: string, at: string, name = `Name ${id}`) {
  return {
    id,
    tenant_id: TENANT,
    source_channel: 'INDEED',
    external_source_id: `apply-${id}`,
    normalized_email: `${id}@x.com`,
    normalized_phone: '4155550100',
    provenance: { ingestion_payload_id: `payload-${id}`, applicant: { full_name: name } },
    legal_basis: {},
    arrived_at: new Date(at),
    created_at: new Date(at),
  };
}

function make(parts: {
  promoteOutcome?: unknown;
  pipelineThrows?: 'P2002' | 'live' | 'other';
  batches?: unknown[][];
  linked?: string[];
  arrival?: unknown;
  advisories?: unknown[];
} = {}) {
  const promoteArrival = vi
    .fn()
    .mockResolvedValue(parts.promoteOutcome ?? { status: 'promoted', talent_record_id: RECORD_ID });
  const promotion = { promoteArrival } as never;

  const create = parts.pipelineThrows
    ? vi.fn().mockRejectedValue(
        parts.pipelineThrows === 'P2002'
          ? { code: 'P2002' }
          : parts.pipelineThrows === 'live'
            ? { code: 'PIPELINE_EPISODE_ALREADY_LIVE' }
            : new Error('boom'),
      )
    : vi.fn().mockResolvedValue({ id: 'pipe-1' });
  const pipelines = { create } as never;

  const getOrCreateTenantBench = vi.fn().mockResolvedValue({ id: 'bench-1' });
  const addToTenantBench = vi.fn().mockResolvedValue({ added: true });
  const savedLists = { getOrCreateTenantBench, addToTenantBench } as never;

  const listByTenantKeyset = vi.fn();
  for (const b of parts.batches ?? [[]]) listByTenantKeyset.mockResolvedValueOnce(b);
  listByTenantKeyset.mockResolvedValue([]);
  const findById = vi.fn().mockResolvedValue(parts.arrival === undefined ? arrivalRow('arrival-1', '2026-07-01T00:00:00Z') : parts.arrival);
  const sourced = { listByTenantKeyset, findById } as never;

  const findLinkedArrivalIds = vi.fn().mockResolvedValue(new Set(parts.linked ?? []));
  const listForArrival = vi.fn().mockResolvedValue(parts.advisories ?? []);
  const countPendingByArrivals = vi.fn().mockResolvedValue(new Map<string, number>());
  const advisories = { findLinkedArrivalIds, listForArrival, countPendingByArrivals } as never;

  const findNamesByIds = vi.fn().mockResolvedValue(new Map([['rec-9', 'Ada King']]));
  const talentRecords = { findNamesByIds } as never;

  const service = new SourcingService(promotion, pipelines, savedLists, sourced, advisories, talentRecords);
  return { service, promoteArrival, create, getOrCreateTenantBench, addToTenantBench, listByTenantKeyset, findById, listForArrival };
}

describe('SourcingService.promoteAndAddToPipeline', () => {
  it('promoted → creates the pipeline row', async () => {
    const { service, create } = make();
    const result = await service.promoteAndAddToPipeline(REF, REQ_ID);
    expect(result).toEqual({ status: 'promoted', talent_record_id: RECORD_ID, pipeline_id: 'pipe-1' });
    expect(create).toHaveBeenCalledWith({
      tenant_id: TENANT,
      input: { talent_record_id: RECORD_ID, requisition_id: REQ_ID },
      // L2-D — the sourcing producer always stamps ARAMO_SOURCING entry-provenance
      // (initiated_by_kind defaults to 'user' when the controller threads none).
      entry_provenance: { origin_type: 'ARAMO_SOURCING', initiated_by_kind: 'user' },
    });
  });

  // ADR-0024 PR-3b THREADING PROOF — the risk this PR introduces is that the
  // §D17a provenance record the policy service produced survives the hop
  // controller -> promoteAndAddToPipeline -> PipelineRepository.create. Assert
  // create() receives the SAME record object (not undefined, not a
  // reconstruction). create()'s in-tx atomicity itself is a property of
  // create(), already proven in PR-3.
  it('threads the provenance record through to create() UNCHANGED (same object)', async () => {
    const { service, create } = make();
    const PROVENANCE = {
      tenant_id: TENANT,
      decision: 'ALLOW',
      policy_version: '1.0.0',
      rule_id: 'add-talent-active',
      reason_code: 'LIFECYCLE_ADD_ALLOWED',
      resource: 'REQUISITION_TALENT',
      action: 'ADD',
      inputs: { resource: 'REQUISITION_TALENT', action: 'ADD', declared: {}, derived: {}, capabilities: {} },
      actor_id: 'actor-1',
      origin: 'ui' as const,
      correlation_id: 'corr-1',
    };
    await service.promoteAndAddToPipeline(REF, REQ_ID, { provenance: PROVENANCE });
    expect(create).toHaveBeenCalledWith({
      tenant_id: TENANT,
      input: { talent_record_id: RECORD_ID, requisition_id: REQ_ID },
      provenance: PROVENANCE,
      // L2-D — the ARAMO_SOURCING entry-provenance rides alongside the policy provenance.
      entry_provenance: { origin_type: 'ARAMO_SOURCING', initiated_by_kind: 'user' },
    });
    // The SAME record, not a reconstruction — identity, not deep-equality.
    expect((create.mock.calls[0]![0] as { provenance: unknown }).provenance).toBe(PROVENANCE);
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

  // ---- E6 B-sourcing-idempotency (Q-2, §4) ----
  // A live episode already exists → the pipeline application guard refuses with
  // PIPELINE_EPISODE_ALREADY_LIVE, and the sourcing trigger treats THAT specific
  // refusal as an idempotent no-op (no throw, pipeline_id null). The no-op comes
  // from the explicit guard, not from generic uniqueness handling.
  it('B-sourcing-idempotency: a live-episode guard refusal (PIPELINE_EPISODE_ALREADY_LIVE) → idempotent no-op (no throw, pipeline_id null)', async () => {
    const { service } = make({ pipelineThrows: 'live' });
    const result = await service.promoteAndAddToPipeline(REF, REQ_ID);
    expect(result).toEqual({ status: 'promoted', talent_record_id: RECORD_ID, pipeline_id: null });
  });

  // §4.1 specificity — a bare Prisma P2002 is NO LONGER swallowed here (E6 replaced
  // the generic-P2002 reliance): it propagates, so the ONLY idempotent path is the
  // explicit guard refusal above.
  it('a bare P2002 pipeline error propagates (not treated as the one-live no-op)', async () => {
    const { service } = make({ pipelineThrows: 'P2002' });
    await expect(service.promoteAndAddToPipeline(REF, REQ_ID)).rejects.toMatchObject({ code: 'P2002' });
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

describe('SourcingService.getPool (ATS-local)', () => {
  it('lists un-linked arrivals with their parsed name/email/phone; no trust fields', async () => {
    const { service } = make({
      batches: [[arrivalRow('a1', '2026-07-01T00:00:00Z', 'Ada Lovelace'), arrivalRow('a2', '2026-07-02T00:00:00Z')]],
      linked: ['a2'],
    });
    const page = await service.getPool(TENANT, { limit: 10 });
    expect(page.items).toEqual([
      {
        subject_id: 'a1',
        display_name: 'Ada Lovelace',
        email: 'a1@x.com',
        phone: '4155550100',
        source_channel: 'INDEED',
        arrived_at: '2026-07-01T00:00:00.000Z',
        open_advisory_count: 0,
      },
    ]);
    // A short batch fully consumed → last page.
    expect(page.next_cursor).toBeNull();
  });

  it('fills a page past linked arrivals across batches and returns a cursor while more may exist', async () => {
    const { service, listByTenantKeyset } = make({
      batches: [
        [arrivalRow('a1', '2026-07-01T00:00:00Z'), arrivalRow('a2', '2026-07-02T00:00:00Z')],
        [arrivalRow('a3', '2026-07-03T00:00:00Z'), arrivalRow('a4', '2026-07-04T00:00:00Z')],
      ],
      linked: ['a1', 'a2'],
    });
    const page = await service.getPool(TENANT, { limit: 2 });
    expect(page.items.map((i) => i.subject_id)).toEqual(['a3', 'a4']);
    expect(page.next_cursor).not.toBeNull();
    expect(listByTenantKeyset).toHaveBeenCalledTimes(2);
    expect(listByTenantKeyset.mock.calls[1]![0].cursor.id).toBe('a2');
  });
});

describe('SourcingService.getSubjectDetail (ATS-local)', () => {
  it('composes the arrival material + refs + PENDING ATS advisories (with the record name)', async () => {
    const { service, listForArrival } = make({
      advisories: [
        {
          id: 'adv-1',
          talent_record_a_id: 'rec-9',
          basis: 'SOURCED_ARRIVAL',
          shared_kinds: ['EMAIL'],
          status: 'PENDING_REVIEW',
          created_at: new Date('2026-07-05T00:00:00Z'),
        },
      ],
    });
    const d = await service.getSubjectDetail(TENANT, 'arrival-1');
    expect(listForArrival).toHaveBeenCalledWith(TENANT, 'arrival-1', 'PENDING_REVIEW');
    expect(d.refs).toEqual([
      { ref_type: 'SOURCED_TALENT', ref_id: 'arrival-1', link_source: 'INDEED' },
      { ref_type: 'INGESTION_PAYLOAD', ref_id: 'payload-arrival-1', link_source: 'ingestion' },
    ]);
    expect(d.open_identity_advisories).toEqual([
      {
        id: 'adv-1',
        talent_record_id: 'rec-9',
        talent_record_name: 'Ada King',
        basis: 'SOURCED_ARRIVAL',
        shared_kinds: ['EMAIL'],
        status: 'PENDING_REVIEW',
        created_at: '2026-07-05T00:00:00.000Z',
      },
    ]);
    expect(d).not.toHaveProperty('trust_bands');
    expect(d).not.toHaveProperty('evidence');
  });

  it('404 when the arrival is in another tenant / absent', async () => {
    await expect(
      make({ arrival: { ...arrivalRow('arrival-1', '2026-07-01T00:00:00Z'), tenant_id: 'other' } }).service.getSubjectDetail(
        TENANT,
        'arrival-1',
      ),
    ).rejects.toThrow(/not found/);
    await expect(make({ arrival: null }).service.getSubjectDetail(TENANT, 'x')).rejects.toThrow(/not found/);
  });
});
