import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SubjectResolutionService } from '../lib/subject-resolution.service.js';
import type {
  SubjectMatchAdvisoryRow,
  TalentTrustRepository,
} from '../lib/talent-trust.repository.js';
import type { TalentTrustService } from '../lib/talent-trust.service.js';

// TR-2a-3 — resolution service guards + mechanism (mocked repo + trust, no DB).
// Proves the R1/R3/R5 guards and that the merge/un-merge go through the EXISTING
// TalentTrustService (pointer-only), plus the audit fields written on the advisory.

const TENANT = '11111111-1111-7111-8111-111111111111';
const SUBJ_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const SUBJ_B = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const ADV = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const ACTOR = 'reviewer-1';

function advisory(over: Partial<SubjectMatchAdvisoryRow> = {}): SubjectMatchAdvisoryRow {
  return {
    id: ADV,
    tenant_id: TENANT,
    subject_a_id: SUBJ_A,
    subject_b_id: SUBJ_B,
    advise_band: 'ADVISE_WEAK',
    has_contradiction: false,
    match_basis: { shared: [], contradiction_kinds: [] },
    status: 'PENDING_REVIEW',
    created_by: 'matcher',
    created_at: new Date('2026-07-03T00:00:00Z'),
    resolution_action: null,
    resolved_by: null,
    resolved_at: null,
    resolution_justification: null,
    surviving_subject_id: null,
    merged_subject_id: null,
    reversed_by: null,
    reversed_at: null,
    reversal_justification: null,
    ...over,
  };
}

function makeService(adv: SubjectMatchAdvisoryRow, subjectStatus: 'ACTIVE' | 'MERGED' = 'ACTIVE') {
  const mergeSubjects = vi.fn(async () => ({}));
  const unmergeSubjects = vi.fn(async () => ({}));
  const applyAdvisoryResolution = vi.fn(async (i: unknown) => ({ ...adv, ...(i as object) }));
  const applyAdvisoryReversal = vi.fn(async (i: unknown) => ({ ...adv, ...(i as object) }));

  const repo = {
    findMatchAdvisoryById: vi.fn(async () => adv),
    findSubjectById: vi.fn(async (id: string) => ({
      id,
      tenant_id: TENANT,
      status: subjectStatus,
      merged_into_subject_id: null,
      created_at: new Date(),
    })),
    applyAdvisoryResolution,
    applyAdvisoryReversal,
  } as unknown as TalentTrustRepository;

  const trust = { mergeSubjects, unmergeSubjects } as unknown as TalentTrustService;
  const svc = new SubjectResolutionService(repo, trust);
  return { svc, mergeSubjects, unmergeSubjects, applyAdvisoryResolution, applyAdvisoryReversal };
}

describe('SubjectResolutionService — TR-2a-3 resolution', () => {
  let now: Date;
  beforeEach(() => {
    now = new Date();
    void now;
  });

  it('approveMerge (non-contradicted) → pointer-only mergeSubjects(a survives, b merges) + MERGED audit', async () => {
    const { svc, mergeSubjects, applyAdvisoryResolution } = makeService(advisory());
    await svc.approveMerge({ tenant_id: TENANT, advisory_id: ADV, actor: ACTOR });

    expect(mergeSubjects).toHaveBeenCalledTimes(1);
    // Default direction: subject_a survives, subject_b merges into it.
    expect(mergeSubjects.mock.calls[0]!.slice(0, 2)).toEqual([SUBJ_A, SUBJ_B]);
    const audit = applyAdvisoryResolution.mock.calls[0]![0] as Record<string, unknown>;
    expect(audit.status).toBe('MERGED');
    expect(audit.resolution_action).toBe('MERGE');
    expect(audit.resolved_by).toBe(ACTOR);
    expect(audit.surviving_subject_id).toBe(SUBJ_A);
    expect(audit.merged_subject_id).toBe(SUBJ_B);
  });

  it('approveMerge honours surviving_subject_id = subject_b (b survives, a merges)', async () => {
    const { svc, mergeSubjects } = makeService(advisory());
    await svc.approveMerge({
      tenant_id: TENANT,
      advisory_id: ADV,
      actor: ACTOR,
      surviving_subject_id: SUBJ_B,
    });
    expect(mergeSubjects.mock.calls[0]!.slice(0, 2)).toEqual([SUBJ_B, SUBJ_A]);
  });

  it('approveMerge rejects a surviving_subject_id not in the pair (no merge)', async () => {
    const { svc, mergeSubjects } = makeService(advisory());
    await expect(
      svc.approveMerge({
        tenant_id: TENANT,
        advisory_id: ADV,
        actor: ACTOR,
        surviving_subject_id: 'dddddddd-dddd-7ddd-8ddd-dddddddddddd',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mergeSubjects).not.toHaveBeenCalled();
  });

  it('approveMerge on a CONTRADICTED advisory WITHOUT ack+justification → BadRequest, NO merge (R3)', async () => {
    const { svc, mergeSubjects } = makeService(advisory({ has_contradiction: true }));
    await expect(
      svc.approveMerge({ tenant_id: TENANT, advisory_id: ADV, actor: ACTOR }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Even ack alone (no justification) is not enough.
    await expect(
      svc.approveMerge({
        tenant_id: TENANT,
        advisory_id: ADV,
        actor: ACTOR,
        override_acknowledged: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mergeSubjects).not.toHaveBeenCalled();
  });

  it('approveMerge on a CONTRADICTED advisory WITH ack+justification → merges, override audited (R3)', async () => {
    const { svc, mergeSubjects, applyAdvisoryResolution } = makeService(
      advisory({ has_contradiction: true }),
    );
    await svc.approveMerge({
      tenant_id: TENANT,
      advisory_id: ADV,
      actor: ACTOR,
      override_acknowledged: true,
      justification: 'same human — phone changed jobs, confirmed via reference',
    });
    expect(mergeSubjects).toHaveBeenCalledTimes(1);
    const audit = applyAdvisoryResolution.mock.calls[0]![0] as Record<string, unknown>;
    expect(audit.resolution_justification).toContain('phone changed');
  });

  it('approveMerge on an already-resolved advisory → Conflict (R5 idempotency)', async () => {
    const { svc, mergeSubjects } = makeService(advisory({ status: 'MERGED' }));
    await expect(
      svc.approveMerge({ tenant_id: TENANT, advisory_id: ADV, actor: ACTOR }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(mergeSubjects).not.toHaveBeenCalled();
  });

  it('approveMerge when a subject is not ACTIVE → Conflict, NO merge (R5)', async () => {
    const { svc, mergeSubjects } = makeService(advisory(), 'MERGED');
    await expect(
      svc.approveMerge({ tenant_id: TENANT, advisory_id: ADV, actor: ACTOR }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(mergeSubjects).not.toHaveBeenCalled();
  });

  it('dismiss → DISMISSED audit, NO merge', async () => {
    const { svc, mergeSubjects, applyAdvisoryResolution } = makeService(advisory());
    await svc.dismiss({ tenant_id: TENANT, advisory_id: ADV, actor: ACTOR, justification: 'different people' });
    expect(mergeSubjects).not.toHaveBeenCalled();
    const audit = applyAdvisoryResolution.mock.calls[0]![0] as Record<string, unknown>;
    expect(audit.status).toBe('DISMISSED');
    expect(audit.resolution_action).toBe('DISMISS');
    expect(audit.merged_subject_id).toBeNull();
  });

  it('reverseMerge on a MERGED advisory → unmergeSubjects(merged) + REVERSED audit (R2)', async () => {
    const merged = advisory({ status: 'MERGED', surviving_subject_id: SUBJ_A, merged_subject_id: SUBJ_B });
    const { svc, unmergeSubjects, applyAdvisoryReversal } = makeService(merged);
    await svc.reverseMerge({ tenant_id: TENANT, advisory_id: ADV, actor: ACTOR, justification: 'merge was wrong' });
    expect(unmergeSubjects).toHaveBeenCalledTimes(1);
    expect(unmergeSubjects.mock.calls[0]![0]).toBe(SUBJ_B); // the merged subject
    const audit = applyAdvisoryReversal.mock.calls[0]![0] as Record<string, unknown>;
    expect(audit.reversed_by).toBe(ACTOR);
    expect(audit.reversal_justification).toBe('merge was wrong');
  });

  it('reverseMerge without justification → BadRequest, NO un-merge (R4)', async () => {
    const merged = advisory({ status: 'MERGED', merged_subject_id: SUBJ_B });
    const { svc, unmergeSubjects } = makeService(merged);
    await expect(
      svc.reverseMerge({ tenant_id: TENANT, advisory_id: ADV, actor: ACTOR, justification: '   ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(unmergeSubjects).not.toHaveBeenCalled();
  });

  it('reverseMerge on a non-MERGED advisory → Conflict', async () => {
    const { svc, unmergeSubjects } = makeService(advisory({ status: 'PENDING_REVIEW' }));
    await expect(
      svc.reverseMerge({ tenant_id: TENANT, advisory_id: ADV, actor: ACTOR, justification: 'x' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(unmergeSubjects).not.toHaveBeenCalled();
  });

  it('a missing advisory → NotFound', async () => {
    const { svc } = makeService(advisory());
    const repo = {
      findMatchAdvisoryById: vi.fn(async () => null),
    } as unknown as TalentTrustRepository;
    const svc2 = new SubjectResolutionService(repo, {} as unknown as TalentTrustService);
    await expect(
      svc2.dismiss({ tenant_id: TENANT, advisory_id: ADV, actor: ACTOR }),
    ).rejects.toBeInstanceOf(NotFoundException);
    void svc;
  });
});
