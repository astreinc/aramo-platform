import { describe, expect, it, vi } from 'vitest';
import type { JobDomainRepository, RequisitionRow } from '@aramo/job-domain';

import {
  ExaminationRepository,
  type FindActiveReqLiveListInput,
  type TalentJobExaminationRow,
} from '../lib/examination.repository.js';

// M3 PR-7 §4.4 unit tests for findActiveReqLiveList — the per-active-req
// Live List query.
//
// Discipline (directive §2 Rulings 1, 3, 4, 6, 7 — verified by these tests):
//   - Ruling 1 (pull-side): no entity / no BullMQ / no event involved; tests
//     mock the JobDomainRepository and PrismaService surfaces only.
//   - Ruling 3 (PR-6 projection reused): tests assert the returned rows are
//     Summary-shaped (the PR-6 projection output shape).
//   - Ruling 4 (no engagement-state filter): tests verify the query filter
//     carries lifecycle_state='active' but NO engagement_state field.
//   - Ruling 6 (Summary-only): the projection produces Summary; no Full
//     fields appear.
//   - Ruling 7 (limit clamp): default 50 when omitted; floor 1 on values <1;
//     hard cap 200 on values >200; explicit 1/200 pass through.
//
// Integration round-trip (real Postgres) is exercised by
// examination-live-list.integration.spec.ts.

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const REQ_ID = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
const JOB_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

function activeReq(overrides: Partial<RequisitionRow> = {}): RequisitionRow {
  return {
    id: REQ_ID,
    tenant_id: TENANT_A,
    job_id: JOB_ID,
    recruiter_id: 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
    state: 'active',
    ...overrides,
  };
}

function makeRow(overrides: Partial<TalentJobExaminationRow> = {}): TalentJobExaminationRow {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    tenant_id: TENANT_A,
    talent_id: TALENT_ID,
    job_id: JOB_ID,
    golden_profile_id: 'dddddddd-dddd-7ddd-8ddd-dddddddddddd',
    trigger: 'initial_match',
    tier: 'WORTH_CONSIDERING',
    rank_ordinal: 1,
    why_matched_sentence: 'm',
    match_summary: 'm',
    expanded_reasoning: [],
    skill_match: { matched_count: 0, missing_count: 0, per_skill: [] },
    experience_match: {},
    constraint_checks: {},
    strengths: [],
    gaps: [],
    risk_flags: [],
    confidence_indicators: null,
    freshness_indicator: {},
    delta_to_entrustable: null,
    examination_version: 'examination-v1.0.0',
    model_version: 'matching-model-v1.0.0',
    taxonomy_version: 'taxonomy-v1.0.0',
    computed_at: new Date('2026-05-21T10:00:00Z'),
    lifecycle_state: 'active',
    archived_at: null,
    superseded_by_examination_id: null,
    ...overrides,
  };
}

// Capture the Prisma findMany call args for assertions on the query shape.
interface FindManyCall {
  args: { where?: unknown; orderBy?: unknown; take?: number };
  returns: TalentJobExaminationRow[];
}

function makeRepo(opts: {
  requisition: RequisitionRow | null;
  rows?: TalentJobExaminationRow[];
}): { repo: ExaminationRepository; call: FindManyCall } {
  const findReqSpy = vi.fn<(id: string) => Promise<RequisitionRow | null>>(
    async () => opts.requisition,
  );
  const jobDomain = { findRequisitionById: findReqSpy } as unknown as JobDomainRepository;

  const call: FindManyCall = {
    args: {},
    returns: opts.rows ?? [],
  };
  const findManySpy = vi.fn(async (args: unknown) => {
    call.args = (args ?? {}) as FindManyCall['args'];
    return call.returns as never;
  });
  const prisma = {
    talentJobExamination: { findMany: findManySpy },
  } as unknown as ConstructorParameters<typeof ExaminationRepository>[0];

  return {
    repo: new ExaminationRepository(prisma, jobDomain),
    call,
  };
}

describe('findActiveReqLiveList — Requisition-precondition contract (Ruling 1 + 4)', () => {
  it('returns [] when the requisition is not found', async () => {
    const { repo, call } = makeRepo({ requisition: null });
    const result = await repo.findActiveReqLiveList({ tenant_id: TENANT_A, req_id: REQ_ID });
    expect(result).toEqual([]);
    // Prisma must NOT be called when the requisition is absent.
    expect(call.args).toEqual({});
  });

  it("returns [] when the requisition's state is 'inactive'", async () => {
    const { repo, call } = makeRepo({ requisition: activeReq({ state: 'inactive' }) });
    const result = await repo.findActiveReqLiveList({ tenant_id: TENANT_A, req_id: REQ_ID });
    expect(result).toEqual([]);
    expect(call.args).toEqual({});
  });

  it('returns [] when the tenant_id does NOT match the requisition (security posture, not an exception)', async () => {
    const { repo, call } = makeRepo({ requisition: activeReq({ tenant_id: TENANT_B }) });
    const result = await repo.findActiveReqLiveList({ tenant_id: TENANT_A, req_id: REQ_ID });
    expect(result).toEqual([]);
    // No Prisma call — short-circuited before the query.
    expect(call.args).toEqual({});
  });
});

describe('findActiveReqLiveList — query shape (Ruling 3 + 4 + 6)', () => {
  it('filters by (tenant_id, job_id, lifecycle_state="active") and orders by (tier asc, rank_ordinal asc, id asc)', async () => {
    const { repo, call } = makeRepo({ requisition: activeReq(), rows: [makeRow()] });
    await repo.findActiveReqLiveList({ tenant_id: TENANT_A, req_id: REQ_ID });

    expect(call.args.where).toEqual({
      tenant_id: TENANT_A,
      job_id: JOB_ID,
      lifecycle_state: 'active',
    });
    expect(call.args.orderBy).toEqual([
      { tier: 'asc' },
      { rank_ordinal: 'asc' },
      { id: 'asc' },
    ]);
  });

  it('carries NO engagement_state filter (Ruling 4 — deferred to M5 / F20)', async () => {
    const { repo, call } = makeRepo({ requisition: activeReq(), rows: [] });
    await repo.findActiveReqLiveList({ tenant_id: TENANT_A, req_id: REQ_ID });

    const where = call.args.where as Record<string, unknown>;
    expect(where).not.toHaveProperty('engagement_state');
  });

  it('projects each row through PR-6 projectSummaryView — returned shape is Summary, not Full (Ruling 3 + 6)', async () => {
    const { repo } = makeRepo({
      requisition: activeReq(),
      rows: [
        makeRow({
          id: '00000000-0000-7000-8000-000000000001',
          tier: 'ENTRUSTABLE',
          rank_ordinal: 1,
          why_matched_sentence: 'strong match',
        }),
      ],
    });
    const result = await repo.findActiveReqLiveList({ tenant_id: TENANT_A, req_id: REQ_ID });

    expect(result).toHaveLength(1);
    // Exactly the 10 Summary fields per API Contracts v1.0 L433-461 (PR-6
    // projection). No Full fields — no expanded_reasoning, no
    // evidence_references, no risk_flags, no delta_to_entrustable.
    expect(Object.keys(result[0] ?? {}).sort()).toEqual(
      [
        'computed_at',
        'confidence_summary',
        'examination_id',
        'freshness_indicator',
        'job_id',
        'rank_ordinal',
        'talent_id',
        'tier',
        'top_skills',
        'why_matched_sentence',
      ].sort(),
    );
    expect(result[0]?.examination_id).toBe('00000000-0000-7000-8000-000000000001');
    expect(result[0]?.tier).toBe('ENTRUSTABLE');
  });
});

describe('findActiveReqLiveList — Ruling 7 limit clamp', () => {
  async function callWith(limit: number | undefined): Promise<number> {
    const { repo, call } = makeRepo({ requisition: activeReq(), rows: [] });
    const input: FindActiveReqLiveListInput = { tenant_id: TENANT_A, req_id: REQ_ID };
    if (limit !== undefined) input.limit = limit;
    await repo.findActiveReqLiveList(input);
    return (call.args.take as number) ?? -1;
  }

  it('defaults to 50 when limit is omitted', async () => {
    expect(await callWith(undefined)).toBe(50);
  });

  it('clamps value <1 (e.g. 0) to the floor 1', async () => {
    expect(await callWith(0)).toBe(1);
  });

  it('clamps a negative value to the floor 1', async () => {
    expect(await callWith(-7)).toBe(1);
  });

  it('passes value 1 through (boundary low)', async () => {
    expect(await callWith(1)).toBe(1);
  });

  it('passes value 200 through (boundary high)', async () => {
    expect(await callWith(200)).toBe(200);
  });

  it('clamps value >200 to the hard cap 200', async () => {
    expect(await callWith(201)).toBe(200);
  });

  it('clamps very large values (e.g. 100_000) to the hard cap 200', async () => {
    expect(await callWith(100_000)).toBe(200);
  });
});

describe('findActiveReqLiveList — keyset cursor (Ruling 1 / pull-side pagination)', () => {
  it('applies the (tier, rank_ordinal, id) > cursor OR-chain predicate when cursor is provided', async () => {
    const { repo, call } = makeRepo({ requisition: activeReq(), rows: [] });
    await repo.findActiveReqLiveList({
      tenant_id: TENANT_A,
      req_id: REQ_ID,
      cursor: {
        tier: 'WORTH_CONSIDERING',
        rank_ordinal: 7,
        id: '00000000-0000-7000-8000-000000000aaa',
      },
    });

    const where = call.args.where as Record<string, unknown>;
    expect(where['tenant_id']).toBe(TENANT_A);
    expect(where['job_id']).toBe(JOB_ID);
    expect(where['lifecycle_state']).toBe('active');
    // The keyset predicate is an OR-chain over (tier ∈ tiers-after-cursor),
    // (tier == c.tier AND rank_ordinal > c.rank_ordinal), and (tier == c.tier
    // AND rank_ordinal == c.rank_ordinal AND id > c.id) — the SQL-equivalent
    // of the (tier, rank_ordinal, id) > cursor lexical comparison. The first
    // branch uses Prisma's `in` filter over the explicit list of tiers
    // strictly after cursor.tier (Prisma 7 enum filters don't support `gt`);
    // for cursor WORTH_CONSIDERING that list is ['STRETCH'].
    expect(where['OR']).toEqual([
      { tier: { in: ['STRETCH'] } },
      { AND: [{ tier: 'WORTH_CONSIDERING' }, { rank_ordinal: { gt: 7 } }] },
      {
        AND: [
          { tier: 'WORTH_CONSIDERING' },
          { rank_ordinal: 7 },
          { id: { gt: '00000000-0000-7000-8000-000000000aaa' } },
        ],
      },
    ]);
  });

  it('cursor at the last tier (STRETCH) → branch-1 in-list is empty (no tiers strictly after STRETCH)', async () => {
    const { repo, call } = makeRepo({ requisition: activeReq(), rows: [] });
    await repo.findActiveReqLiveList({
      tenant_id: TENANT_A,
      req_id: REQ_ID,
      cursor: {
        tier: 'STRETCH',
        rank_ordinal: 99,
        id: '00000000-0000-7000-8000-000000000fff',
      },
    });
    const where = call.args.where as Record<string, unknown>;
    expect((where['OR'] as Array<Record<string, unknown>>)[0]).toEqual({
      tier: { in: [] },
    });
  });

  it('cursor at the first tier (ENTRUSTABLE) → branch-1 in-list is [WORTH_CONSIDERING, STRETCH]', async () => {
    const { repo, call } = makeRepo({ requisition: activeReq(), rows: [] });
    await repo.findActiveReqLiveList({
      tenant_id: TENANT_A,
      req_id: REQ_ID,
      cursor: {
        tier: 'ENTRUSTABLE',
        rank_ordinal: 1,
        id: '00000000-0000-7000-8000-000000000aaa',
      },
    });
    const where = call.args.where as Record<string, unknown>;
    expect((where['OR'] as Array<Record<string, unknown>>)[0]).toEqual({
      tier: { in: ['WORTH_CONSIDERING', 'STRETCH'] },
    });
  });

  it('omits the OR-chain when no cursor is provided (first page)', async () => {
    const { repo, call } = makeRepo({ requisition: activeReq(), rows: [] });
    await repo.findActiveReqLiveList({ tenant_id: TENANT_A, req_id: REQ_ID });

    const where = call.args.where as Record<string, unknown>;
    expect(where).not.toHaveProperty('OR');
  });
});

describe('findActiveReqLiveList — write-path discipline (Ruling 1 — read-only)', () => {
  it('issues no UPDATE / updateMany — the projection is read-only', async () => {
    const findReq = vi.fn<(id: string) => Promise<RequisitionRow | null>>(async () => activeReq());
    const jobDomain = { findRequisitionById: findReq } as unknown as JobDomainRepository;

    const findMany = vi.fn(async () => [makeRow()] as never);
    const update = vi.fn();
    const updateMany = vi.fn();
    const prisma = {
      talentJobExamination: { findMany, update, updateMany },
    } as unknown as ConstructorParameters<typeof ExaminationRepository>[0];

    const repo = new ExaminationRepository(prisma, jobDomain);
    // Exercise several configurations.
    await repo.findActiveReqLiveList({ tenant_id: TENANT_A, req_id: REQ_ID });
    await repo.findActiveReqLiveList({ tenant_id: TENANT_A, req_id: REQ_ID, limit: 10 });
    await repo.findActiveReqLiveList({
      tenant_id: TENANT_A,
      req_id: REQ_ID,
      cursor: {
        tier: 'ENTRUSTABLE',
        rank_ordinal: 1,
        id: '00000000-0000-7000-8000-000000000aaa',
      },
    });

    expect(update).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
