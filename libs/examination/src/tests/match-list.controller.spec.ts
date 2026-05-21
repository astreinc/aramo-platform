import { describe, expect, it } from 'vitest';

import { MatchListController } from '../lib/match-list.controller.js';
import type { ExaminationRepository, ExaminationTierValue } from '../lib/examination.repository.js';
import type { TalentJobExaminationSummaryView } from '../lib/examination-full.types.js';

// M3 PR-8 §4.8 — controller unit tests with mocked ExaminationRepository
// and JobDomainRepository. Verifies the eight-step behavior in §4.1:
// auth check, UUID validation, limit parsing, cursor decoding, repository
// wiring, response envelope shape, empty-list on no active requisition.
//
// Integration end-to-end (AppModule compile + HTTP request + JSON shape
// match) lives in match-list.negative-shape.spec.ts.

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const JOB_ID = '22222222-2222-7222-8222-222222222222';
const REQ_ID = '33333333-3333-7333-8333-333333333333';
const TALENT_ID_1 = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const TALENT_ID_2 = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const EXAM_ID_1 = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const EXAM_ID_2 = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';

function recruiterAuth(overrides: Partial<{
  consumer_type: 'recruiter' | 'portal' | 'ingestion';
  tenant_id: string;
}> = {}) {
  return {
    sub: 'user-1',
    consumer_type: overrides.consumer_type ?? ('recruiter' as const),
    actor_kind: 'user' as const,
    tenant_id: overrides.tenant_id ?? TENANT_ID,
    scopes: [],
    iat: 0,
    exp: 0,
  };
}

function makeSummary(
  examination_id: string,
  talent_id: string,
  tier: ExaminationTierValue,
  rank_ordinal: number,
): TalentJobExaminationSummaryView {
  return {
    examination_id,
    talent_id,
    job_id: JOB_ID,
    tier,
    rank_ordinal,
    why_matched_sentence: 'matched on skills X and Y',
    top_skills: ['TypeScript'],
    confidence_summary: {
      evidence_strength: { level: 'medium', basis: 'evidence_count' },
      data_completeness: { level: 'high', basis: 'fields_present' },
      constraint_confidence: { level: 'medium', basis: 'rate_overlap' },
    },
    freshness_indicator: { profile_age_days: 14 },
    computed_at: new Date('2026-05-01T12:00:00Z'),
  };
}

function mockExamRepo(
  returns: TalentJobExaminationSummaryView[],
  capture?: { calls: unknown[] },
): ExaminationRepository {
  return {
    findActiveReqLiveList: async (input: unknown) => {
      capture?.calls.push(input);
      return returns;
    },
  } as unknown as ExaminationRepository;
}

function mockJobDomainRepo(
  returns: { id: string; tenant_id: string; job_id: string; recruiter_id: string; state: 'active' | 'inactive' } | null,
  capture?: { calls: unknown[] },
) {
  return {
    findActiveRequisitionByJobId: async (input: unknown) => {
      capture?.calls.push(input);
      return returns;
    },
  };
}

describe('MatchListController — eight-step behavior', () => {
  it('step 1 — 403 INSUFFICIENT_PERMISSIONS when consumer_type !== "recruiter"', async () => {
    const controller = new MatchListController(
      mockExamRepo([]),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockJobDomainRepo(null) as any,
    );
    await expect(
      controller.listMatches(JOB_ID, undefined, undefined, recruiterAuth({ consumer_type: 'portal' }), 'req-1'),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      statusCode: 403,
    });
  });

  it('step 2 — 400 INVALID_REQUEST when job_id is not a UUID', async () => {
    const controller = new MatchListController(
      mockExamRepo([]),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockJobDomainRepo(null) as any,
    );
    await expect(
      controller.listMatches('not-a-uuid', undefined, undefined, recruiterAuth(), 'req-1'),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      statusCode: 400,
      context: { details: { invalid_field: 'job_id' } },
    });
  });

  it('step 3 — 400 INVALID_REQUEST on non-integer limit', async () => {
    const controller = new MatchListController(
      mockExamRepo([]),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockJobDomainRepo(null) as any,
    );
    await expect(
      controller.listMatches(JOB_ID, 'abc', undefined, recruiterAuth(), 'req-1'),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      statusCode: 400,
      context: { details: { invalid_field: 'limit' } },
    });
  });

  it('step 3 — 400 INVALID_REQUEST when limit < 1', async () => {
    const controller = new MatchListController(
      mockExamRepo([]),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockJobDomainRepo(null) as any,
    );
    await expect(
      controller.listMatches(JOB_ID, '0', undefined, recruiterAuth(), 'req-1'),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST', statusCode: 400 });
  });

  it('step 4 — 400 INVALID_REQUEST on malformed cursor (bad base64/JSON)', async () => {
    const controller = new MatchListController(
      mockExamRepo([]),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockJobDomainRepo(null) as any,
    );
    await expect(
      controller.listMatches(JOB_ID, undefined, '!!!not-valid!!!', recruiterAuth(), 'req-1'),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      context: { details: { invalid_field: 'cursor' } },
    });
  });

  it('step 4 — 400 INVALID_REQUEST on cursor with wrong fields', async () => {
    const controller = new MatchListController(
      mockExamRepo([]),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockJobDomainRepo(null) as any,
    );
    const badCursor = Buffer.from(JSON.stringify({ tier: 'NOT_A_TIER', rank_ordinal: 0, id: TALENT_ID_1 })).toString('base64');
    await expect(
      controller.listMatches(JOB_ID, undefined, badCursor, recruiterAuth(), 'req-1'),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('step 5 — empty-list response (200 + data: []) when no active requisition exists', async () => {
    const examCalls: { calls: unknown[] } = { calls: [] };
    const controller = new MatchListController(
      mockExamRepo([], examCalls),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockJobDomainRepo(null) as any,
    );
    const result = await controller.listMatches(JOB_ID, undefined, undefined, recruiterAuth(), 'req-1');
    expect(result.data).toEqual([]);
    expect(result.pagination).toEqual({
      cursor: null,
      next_cursor: null,
      page_size: 0,
      has_more: false,
    });
    expect(examCalls.calls).toEqual([]);
  });

  it('step 6 — wires (tenant_id, req_id, limit, cursor) into findActiveReqLiveList', async () => {
    const examCalls: { calls: unknown[] } = { calls: [] };
    const jobCalls: { calls: unknown[] } = { calls: [] };
    const controller = new MatchListController(
      mockExamRepo([], examCalls),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockJobDomainRepo({ id: REQ_ID, tenant_id: TENANT_ID, job_id: JOB_ID, recruiter_id: 'r', state: 'active' }, jobCalls) as any,
    );
    const cursorPayload = { tier: 'WORTH_CONSIDERING' as const, rank_ordinal: 5, id: EXAM_ID_1 };
    const cursorStr = Buffer.from(JSON.stringify(cursorPayload)).toString('base64');

    await controller.listMatches(JOB_ID, '25', cursorStr, recruiterAuth(), 'req-1');
    expect(jobCalls.calls).toEqual([{ tenant_id: TENANT_ID, job_id: JOB_ID }]);
    expect(examCalls.calls).toEqual([
      { tenant_id: TENANT_ID, req_id: REQ_ID, limit: 25, cursor: cursorPayload },
    ]);
  });

  it('step 7 — response envelope; has_more=false when rows < effective limit', async () => {
    const rows = [
      makeSummary(EXAM_ID_1, TALENT_ID_1, 'ENTRUSTABLE', 1),
      makeSummary(EXAM_ID_2, TALENT_ID_2, 'WORTH_CONSIDERING', 2),
    ];
    const controller = new MatchListController(
      mockExamRepo(rows),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockJobDomainRepo({ id: REQ_ID, tenant_id: TENANT_ID, job_id: JOB_ID, recruiter_id: 'r', state: 'active' }) as any,
    );
    const result = await controller.listMatches(JOB_ID, '10', undefined, recruiterAuth(), 'req-1');
    expect(result.data).toHaveLength(2);
    expect(result.pagination).toEqual({
      cursor: null,
      next_cursor: null,
      page_size: 2,
      has_more: false,
    });
  });

  it('step 7 — has_more=true and next_cursor encoded when rows === effective limit', async () => {
    const rows = [
      makeSummary(EXAM_ID_1, TALENT_ID_1, 'ENTRUSTABLE', 1),
      makeSummary(EXAM_ID_2, TALENT_ID_2, 'WORTH_CONSIDERING', 2),
    ];
    const controller = new MatchListController(
      mockExamRepo(rows),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockJobDomainRepo({ id: REQ_ID, tenant_id: TENANT_ID, job_id: JOB_ID, recruiter_id: 'r', state: 'active' }) as any,
    );
    const result = await controller.listMatches(JOB_ID, '2', undefined, recruiterAuth(), 'req-1');
    expect(result.pagination.has_more).toBe(true);
    expect(result.pagination.page_size).toBe(2);
    expect(result.pagination.next_cursor).not.toBeNull();
    const decoded = JSON.parse(Buffer.from(result.pagination.next_cursor as string, 'base64').toString('utf8'));
    expect(decoded).toEqual({
      tier: 'WORTH_CONSIDERING',
      rank_ordinal: 2,
      id: EXAM_ID_2,
    });
  });

  it('step 8 — pagination.cursor echoes input cursor when supplied', async () => {
    const cursorPayload = { tier: 'ENTRUSTABLE' as const, rank_ordinal: 0, id: EXAM_ID_1 };
    const cursorStr = Buffer.from(JSON.stringify(cursorPayload)).toString('base64');
    const controller = new MatchListController(
      mockExamRepo([]),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockJobDomainRepo({ id: REQ_ID, tenant_id: TENANT_ID, job_id: JOB_ID, recruiter_id: 'r', state: 'active' }) as any,
    );
    const result = await controller.listMatches(JOB_ID, undefined, cursorStr, recruiterAuth(), 'req-1');
    expect(result.pagination.cursor).toBe(cursorStr);
  });

  it('Summary-only — response data carries no Full-specific keys', async () => {
    const rows = [makeSummary(EXAM_ID_1, TALENT_ID_1, 'ENTRUSTABLE', 1)];
    const controller = new MatchListController(
      mockExamRepo(rows),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockJobDomainRepo({ id: REQ_ID, tenant_id: TENANT_ID, job_id: JOB_ID, recruiter_id: 'r', state: 'active' }) as any,
    );
    const result = await controller.listMatches(JOB_ID, undefined, undefined, recruiterAuth(), 'req-1');
    const item = result.data[0]!;
    const FULL_SPECIFIC_FIELDS = [
      'expanded_reasoning',
      'evidence_references',
      'risk_flags',
      'confidence_indicators',
      'delta_to_entrustable',
      'skill_match',
      'experience_match',
      'constraint_checks',
      'strengths',
      'gaps',
      'lifecycle_state',
      'archived_at',
      'superseded_by_examination_id',
    ];
    for (const f of FULL_SPECIFIC_FIELDS) {
      expect(item, `Full-specific field "${f}" leaked into Summary response`).not.toHaveProperty(f);
    }
  });
});
