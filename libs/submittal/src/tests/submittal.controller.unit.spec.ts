import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AramoError } from '@aramo/common';
import { IdempotencyService } from '@aramo/consent';
import { EvidenceRepository } from '@aramo/evidence';
import type { AuthContextType } from '@aramo/auth';

import type { CreateSubmittalRequestDto } from '../lib/dto/create-submittal-request.dto.js';
import { SubmittalController } from '../lib/submittal.controller.js';
import { SubmittalRepository } from '../lib/submittal.repository.js';

// M4 PR-3 §4.11 — controller unit spec.
//
// Mocks SubmittalRepository + IdempotencyService. Asserts:
//   - consumer_type !== 'recruiter' → INSUFFICIENT_PERMISSIONS 403.
//   - Idempotency-Key missing → VALIDATION_ERROR 400.
//   - Idempotency-Key non-UUID → VALIDATION_ERROR 400.
//   - replay path returns prior response without calling repository.
//   - conflict path throws via IdempotencyService.lookup.
//   - happy path returns submittal, then persists idempotency record.
//   - error from repository propagates to caller.

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TALENT_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const JOB_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const EXAM_ID = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const RECRUITER_ID = '00000000-0000-7000-8000-000000000bb1';
const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f00';
const IDEMPOTENCY_KEY = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f01';

function makeAuth(overrides: Partial<AuthContextType> = {}): AuthContextType {
  return {
    sub: RECRUITER_ID,
    consumer_type: 'recruiter',
    actor_kind: 'user',
    tenant_id: TENANT_A,
    scopes: [],
    iat: 0,
    exp: 0,
    ...overrides,
  };
}

function makeBody(overrides: Partial<CreateSubmittalRequestDto> = {}): CreateSubmittalRequestDto {
  return {
    talent_id: TALENT_A,
    job_id: JOB_ID,
    examination_id: EXAM_ID,
    talent_identity: {
      full_name: 'Sample Talent',
      preferred_name: 'Sam',
      location: 'Remote (US)',
    },
    contact_summary: { contact_available: true, channels_verified: ['email'] },
    capability_summary_overrides: {
      key_work_history: [
        { employer_name: 'Acme', role_title: 'Senior Engineer', start_date: '2021-01-01' },
      ],
    },
    recruiter_contribution: {
      conversation_summary: { recruiter_summary: 'Discussed role.' },
      talent_confirmed: { spoken_to_recruiter: true },
    },
    ...overrides,
  };
}

interface MockSetup {
  controller: SubmittalController;
  createSubmittal: ReturnType<typeof vi.fn>;
  lookup: ReturnType<typeof vi.fn>;
  persist: ReturnType<typeof vi.fn>;
}

function build(): MockSetup {
  const createSubmittal = vi.fn().mockResolvedValue({
    id: '99990000-0000-7000-8000-000000000001',
    tenant_id: TENANT_A,
    talent_id: TALENT_A,
    job_id: JOB_ID,
    evidence_package_id: '99990000-0000-7000-8000-000000000002',
    pinned_examination_id: EXAM_ID,
    state: 'draft',
    created_by: RECRUITER_ID,
    justification: null,
    failed_criterion_acknowledgments: null,
    created_at: new Date(),
    confirmed_at: null,
  });
  const lookup = vi.fn().mockResolvedValue({ kind: 'proceed' });
  const persist = vi.fn().mockResolvedValue(undefined);
  const mockRepo = { createSubmittal } as unknown as SubmittalRepository;
  const mockIdempotency = { lookup, persist } as unknown as IdempotencyService;
  const mockEvidence = { findById: vi.fn() } as unknown as EvidenceRepository;
  const controller = new SubmittalController(mockRepo, mockIdempotency, mockEvidence);
  return { controller, createSubmittal, lookup, persist };
}

describe('SubmittalController.createSubmittal (unit)', () => {
  let ctx: MockSetup;

  beforeEach(() => {
    ctx = build();
  });

  it('1. consumer_type !== "recruiter" → INSUFFICIENT_PERMISSIONS (403)', async () => {
    try {
      await ctx.controller.createSubmittal(
        makeBody(),
        IDEMPOTENCY_KEY,
        makeAuth({ consumer_type: 'portal' }),
        REQUEST_ID,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AramoError);
      expect((err as AramoError).code).toBe('INSUFFICIENT_PERMISSIONS');
      expect((err as AramoError).statusCode).toBe(403);
    }
    expect(ctx.createSubmittal).not.toHaveBeenCalled();
  });

  it('2. Idempotency-Key missing → VALIDATION_ERROR (400)', async () => {
    try {
      await ctx.controller.createSubmittal(
        makeBody(),
        undefined,
        makeAuth(),
        REQUEST_ID,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AramoError);
      expect((err as AramoError).code).toBe('VALIDATION_ERROR');
    }
  });

  it('3. Idempotency-Key non-UUID → VALIDATION_ERROR (400)', async () => {
    try {
      await ctx.controller.createSubmittal(
        makeBody(),
        'not-a-uuid',
        makeAuth(),
        REQUEST_ID,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AramoError);
      expect((err as AramoError).code).toBe('VALIDATION_ERROR');
    }
  });

  it('4. replay path: lookup returns replay → repository NOT called', async () => {
    const priorResponse = {
      submittal: { id: 'prior-submittal' },
    } as unknown;
    ctx.lookup.mockResolvedValue({
      kind: 'replay',
      response_status: 201,
      response_body: priorResponse,
    });
    const result = await ctx.controller.createSubmittal(
      makeBody(),
      IDEMPOTENCY_KEY,
      makeAuth(),
      REQUEST_ID,
    );
    expect(result).toBe(priorResponse);
    expect(ctx.createSubmittal).not.toHaveBeenCalled();
    expect(ctx.persist).not.toHaveBeenCalled();
  });

  it('5. conflict path: lookup throws IDEMPOTENCY_KEY_CONFLICT', async () => {
    ctx.lookup.mockRejectedValue(
      new AramoError('IDEMPOTENCY_KEY_CONFLICT', 'conflict', 409, { requestId: REQUEST_ID }),
    );
    try {
      await ctx.controller.createSubmittal(
        makeBody(),
        IDEMPOTENCY_KEY,
        makeAuth(),
        REQUEST_ID,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AramoError);
      expect((err as AramoError).code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    }
    expect(ctx.createSubmittal).not.toHaveBeenCalled();
  });

  it('6. happy path: returns submittal then persists idempotency record', async () => {
    const result = await ctx.controller.createSubmittal(
      makeBody(),
      IDEMPOTENCY_KEY,
      makeAuth(),
      REQUEST_ID,
    );
    expect(result.submittal.state).toBe('draft');
    expect(ctx.createSubmittal).toHaveBeenCalledTimes(1);
    expect(ctx.persist).toHaveBeenCalledTimes(1);
    const persistArg = ctx.persist.mock.calls[0]?.[0] as { response_status: number };
    expect(persistArg.response_status).toBe(201);
  });

  it('7. repository error propagates without persisting idempotency', async () => {
    ctx.createSubmittal.mockRejectedValue(
      new AramoError('SUBMITTAL_STRETCH_BLOCKED', 'stretch', 422, { requestId: REQUEST_ID }),
    );
    try {
      await ctx.controller.createSubmittal(
        makeBody(),
        IDEMPOTENCY_KEY,
        makeAuth(),
        REQUEST_ID,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AramoError).code).toBe('SUBMITTAL_STRETCH_BLOCKED');
    }
    expect(ctx.persist).not.toHaveBeenCalled();
  });

  it('8. malformed sub → INVALID_REQUEST', async () => {
    try {
      await ctx.controller.createSubmittal(
        makeBody(),
        IDEMPOTENCY_KEY,
        makeAuth({ sub: 'not-a-uuid' }),
        REQUEST_ID,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AramoError).code).toBe('INVALID_REQUEST');
    }
  });
});

// =============================================================================
// M4 PR-4 §4.10 — controller unit tests for confirmSubmittal (4 new)
// =============================================================================

const SUBMITTAL_ID = '99990000-0000-7000-8000-000000000001';

function makeAttestations(
  overrides: Partial<{
    talent_evidence_reviewed: boolean;
    constraints_reviewed: boolean;
    submittal_risk_acknowledged: boolean;
  }> = {},
): {
  talent_evidence_reviewed: true;
  constraints_reviewed: true;
  submittal_risk_acknowledged: true;
} {
  return {
    talent_evidence_reviewed: true,
    constraints_reviewed: true,
    submittal_risk_acknowledged: true,
    ...overrides,
  } as {
    talent_evidence_reviewed: true;
    constraints_reviewed: true;
    submittal_risk_acknowledged: true;
  };
}

interface ConfirmMockSetup {
  controller: SubmittalController;
  confirmSubmittal: ReturnType<typeof vi.fn>;
  lookup: ReturnType<typeof vi.fn>;
  persist: ReturnType<typeof vi.fn>;
}

function buildConfirm(): ConfirmMockSetup {
  const confirmSubmittal = vi.fn().mockResolvedValue({
    id: SUBMITTAL_ID,
    tenant_id: TENANT_A,
    talent_id: TALENT_A,
    job_id: JOB_ID,
    evidence_package_id: '99990000-0000-7000-8000-000000000002',
    pinned_examination_id: EXAM_ID,
    state: 'submitted',
    created_by: RECRUITER_ID,
    justification: null,
    failed_criterion_acknowledgments: null,
    created_at: new Date('2026-05-23T12:00:00Z'),
    confirmed_at: new Date('2026-05-23T13:00:00Z'),
  });
  const lookup = vi.fn().mockResolvedValue({ kind: 'proceed' });
  const persist = vi.fn().mockResolvedValue(undefined);
  const mockRepo = {
    createSubmittal: vi.fn(),
    confirmSubmittal,
  } as unknown as SubmittalRepository;
  const mockIdempotency = { lookup, persist } as unknown as IdempotencyService;
  const mockEvidence = { findById: vi.fn() } as unknown as EvidenceRepository;
  const controller = new SubmittalController(mockRepo, mockIdempotency, mockEvidence);
  return { controller, confirmSubmittal, lookup, persist };
}

describe('SubmittalController.confirmSubmittal (unit)', () => {
  let ctx: ConfirmMockSetup;
  beforeEach(() => {
    ctx = buildConfirm();
  });

  it('1. consumer_type !== "recruiter" → INSUFFICIENT_PERMISSIONS 403', async () => {
    try {
      await ctx.controller.confirmSubmittal(
        SUBMITTAL_ID,
        { attestations: makeAttestations() },
        IDEMPOTENCY_KEY,
        makeAuth({ consumer_type: 'portal' }),
        REQUEST_ID,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AramoError);
      expect((err as AramoError).code).toBe('INSUFFICIENT_PERMISSIONS');
      expect((err as AramoError).statusCode).toBe(403);
    }
    expect(ctx.confirmSubmittal).not.toHaveBeenCalled();
  });

  it('2. Idempotency-Key missing → VALIDATION_ERROR 400', async () => {
    try {
      await ctx.controller.confirmSubmittal(
        SUBMITTAL_ID,
        { attestations: makeAttestations() },
        undefined,
        makeAuth(),
        REQUEST_ID,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AramoError).code).toBe('VALIDATION_ERROR');
    }
    expect(ctx.confirmSubmittal).not.toHaveBeenCalled();
  });

  it('3. submittal_id non-UUID → VALIDATION_ERROR 400', async () => {
    try {
      await ctx.controller.confirmSubmittal(
        'not-a-uuid',
        { attestations: makeAttestations() },
        IDEMPOTENCY_KEY,
        makeAuth(),
        REQUEST_ID,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AramoError).code).toBe('VALIDATION_ERROR');
    }
    expect(ctx.confirmSubmittal).not.toHaveBeenCalled();
  });

  it('4. attestations: any false → ATTESTATION_MISSING 422 (3 permutations)', async () => {
    const permutations: Array<Partial<{
      talent_evidence_reviewed: boolean;
      constraints_reviewed: boolean;
      submittal_risk_acknowledged: boolean;
    }>> = [
      { talent_evidence_reviewed: false },
      { constraints_reviewed: false },
      { submittal_risk_acknowledged: false },
    ];
    for (const overrides of permutations) {
      const local = buildConfirm();
      try {
        await local.controller.confirmSubmittal(
          SUBMITTAL_ID,
          { attestations: makeAttestations(overrides) },
          IDEMPOTENCY_KEY,
          makeAuth(),
          REQUEST_ID,
        );
        throw new Error('expected throw');
      } catch (err) {
        expect((err as AramoError).code).toBe('ATTESTATION_MISSING');
        expect((err as AramoError).statusCode).toBe(422);
      }
      expect(local.confirmSubmittal).not.toHaveBeenCalled();
    }
  });
});

// =============================================================================
// M4 PR-6 §4.8 — controller unit tests for getSubmittal + getEvidencePackage
// (9 new tests)
// =============================================================================

const EVIDENCE_PKG_ID = '99990000-0000-7000-8000-000000000002';

function makeSubmittalView(): {
  id: string;
  tenant_id: string;
  talent_id: string;
  job_id: string;
  evidence_package_id: string;
  pinned_examination_id: string;
  state: 'draft';
  created_by: string;
  justification: null;
  failed_criterion_acknowledgments: null;
  created_at: Date;
  confirmed_at: null;
} {
  return {
    id: SUBMITTAL_ID,
    tenant_id: TENANT_A,
    talent_id: TALENT_A,
    job_id: JOB_ID,
    evidence_package_id: EVIDENCE_PKG_ID,
    pinned_examination_id: EXAM_ID,
    state: 'draft',
    created_by: RECRUITER_ID,
    justification: null,
    failed_criterion_acknowledgments: null,
    created_at: new Date('2026-05-23T12:00:00Z'),
    confirmed_at: null,
  };
}

function makeEvidencePackageView(): Record<string, unknown> {
  return {
    id: EVIDENCE_PKG_ID,
    tenant_id: TENANT_A,
    talent_id: TALENT_A,
    job_id: JOB_ID,
    examination_id: EXAM_ID,
    submittal_record_id: SUBMITTAL_ID,
    parent_package_id: null,
    talent_identity: { full_name: 'Sample', location: 'Remote (US)' },
    contact_summary: { contact_available: true, channels_verified: ['email'] },
    capability_summary: {
      skill_match: { matched_count: 5, missing_count: 0, per_skill: [] },
      experience_match: { years: 7, summary: 'Strong' },
      key_work_history: [],
    },
    match_justification: {
      why_this_talent: 'Sample',
      strengths: [],
      gaps: [],
      risk_flags: [],
    },
    recruiter_contribution: {
      conversation_summary: { recruiter_summary: 'Discussed.' },
      talent_confirmed: { spoken_to_recruiter: true },
    },
    engagement_event_refs: [],
    created_at: new Date('2026-05-23T12:00:00Z'),
  };
}

interface GetMockSetup {
  controller: SubmittalController;
  findById: ReturnType<typeof vi.fn>;
  evidenceFindById: ReturnType<typeof vi.fn>;
}

function buildGet(): GetMockSetup {
  const findById = vi.fn().mockResolvedValue(makeSubmittalView());
  const evidenceFindById = vi.fn().mockResolvedValue(makeEvidencePackageView());
  const mockRepo = {
    createSubmittal: vi.fn(),
    confirmSubmittal: vi.fn(),
    findById,
  } as unknown as SubmittalRepository;
  const mockIdempotency = {
    lookup: vi.fn(),
    persist: vi.fn(),
  } as unknown as IdempotencyService;
  const mockEvidence = {
    findById: evidenceFindById,
  } as unknown as EvidenceRepository;
  const controller = new SubmittalController(mockRepo, mockIdempotency, mockEvidence);
  return { controller, findById, evidenceFindById };
}

describe('SubmittalController.getSubmittal (unit)', () => {
  let ctx: GetMockSetup;
  beforeEach(() => {
    ctx = buildGet();
  });

  it('1. consumer_type !== "recruiter" → INSUFFICIENT_PERMISSIONS 403', async () => {
    try {
      await ctx.controller.getSubmittal(
        SUBMITTAL_ID,
        makeAuth({ consumer_type: 'portal' }),
        REQUEST_ID,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AramoError).code).toBe('INSUFFICIENT_PERMISSIONS');
      expect((err as AramoError).statusCode).toBe(403);
    }
    expect(ctx.findById).not.toHaveBeenCalled();
  });

  it('2. submittal_id non-UUID → VALIDATION_ERROR 400', async () => {
    try {
      await ctx.controller.getSubmittal('not-a-uuid', makeAuth(), REQUEST_ID);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AramoError).code).toBe('VALIDATION_ERROR');
      expect((err as AramoError).statusCode).toBe(400);
    }
    expect(ctx.findById).not.toHaveBeenCalled();
  });

  it('3. missing submittal → NOT_FOUND 404', async () => {
    ctx.findById.mockResolvedValue(null);
    try {
      await ctx.controller.getSubmittal(SUBMITTAL_ID, makeAuth(), REQUEST_ID);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AramoError).code).toBe('NOT_FOUND');
      expect((err as AramoError).statusCode).toBe(404);
    }
  });

  it('4. successful → returns submittal view', async () => {
    const result = await ctx.controller.getSubmittal(
      SUBMITTAL_ID,
      makeAuth(),
      REQUEST_ID,
    );
    expect(result.id).toBe(SUBMITTAL_ID);
    expect(result.state).toBe('draft');
    expect(ctx.findById).toHaveBeenCalledWith({
      tenant_id: TENANT_A,
      id: SUBMITTAL_ID,
    });
  });
});

describe('SubmittalController.getEvidencePackage (unit)', () => {
  let ctx: GetMockSetup;
  beforeEach(() => {
    ctx = buildGet();
  });

  it('1. consumer_type !== "recruiter" → INSUFFICIENT_PERMISSIONS 403', async () => {
    try {
      await ctx.controller.getEvidencePackage(
        SUBMITTAL_ID,
        makeAuth({ consumer_type: 'portal' }),
        REQUEST_ID,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AramoError).code).toBe('INSUFFICIENT_PERMISSIONS');
      expect((err as AramoError).statusCode).toBe(403);
    }
    expect(ctx.findById).not.toHaveBeenCalled();
    expect(ctx.evidenceFindById).not.toHaveBeenCalled();
  });

  it('2. submittal_id non-UUID → VALIDATION_ERROR 400', async () => {
    try {
      await ctx.controller.getEvidencePackage(
        'not-a-uuid',
        makeAuth(),
        REQUEST_ID,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AramoError).code).toBe('VALIDATION_ERROR');
      expect((err as AramoError).statusCode).toBe(400);
    }
    expect(ctx.findById).not.toHaveBeenCalled();
    expect(ctx.evidenceFindById).not.toHaveBeenCalled();
  });

  it('3. missing submittal → NOT_FOUND 404 (TalentSubmittalRecord not found)', async () => {
    ctx.findById.mockResolvedValue(null);
    try {
      await ctx.controller.getEvidencePackage(
        SUBMITTAL_ID,
        makeAuth(),
        REQUEST_ID,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AramoError).code).toBe('NOT_FOUND');
      expect((err as AramoError).message).toMatch(/TalentSubmittalRecord/);
    }
    expect(ctx.evidenceFindById).not.toHaveBeenCalled();
  });

  it('4. missing evidence package (chain-break) → NOT_FOUND 404 (TalentJobEvidencePackage not found)', async () => {
    ctx.evidenceFindById.mockResolvedValue(null);
    try {
      await ctx.controller.getEvidencePackage(
        SUBMITTAL_ID,
        makeAuth(),
        REQUEST_ID,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AramoError).code).toBe('NOT_FOUND');
      expect((err as AramoError).message).toMatch(/TalentJobEvidencePackage/);
      expect((err as AramoError).message).toMatch(/chain-break/);
    }
    expect(ctx.evidenceFindById).toHaveBeenCalledWith({
      tenant_id: TENANT_A,
      id: EVIDENCE_PKG_ID,
    });
  });

  it('5. successful → returns evidence-package view', async () => {
    const result = await ctx.controller.getEvidencePackage(
      SUBMITTAL_ID,
      makeAuth(),
      REQUEST_ID,
    );
    expect(result.id).toBe(EVIDENCE_PKG_ID);
    expect(result.submittal_record_id).toBe(SUBMITTAL_ID);
    expect(ctx.findById).toHaveBeenCalledWith({
      tenant_id: TENANT_A,
      id: SUBMITTAL_ID,
    });
    expect(ctx.evidenceFindById).toHaveBeenCalledWith({
      tenant_id: TENANT_A,
      id: EVIDENCE_PKG_ID,
    });
  });
});

// =============================================================================
// M4 PR-7 §4.10 — controller unit tests for revokeSubmittal (5 new)
// =============================================================================

interface RevokeMockSetup {
  controller: SubmittalController;
  revokeSubmittal: ReturnType<typeof vi.fn>;
  lookup: ReturnType<typeof vi.fn>;
  persist: ReturnType<typeof vi.fn>;
}

function buildRevoke(): RevokeMockSetup {
  const revokeSubmittal = vi.fn().mockResolvedValue({
    id: SUBMITTAL_ID,
    tenant_id: TENANT_A,
    talent_id: TALENT_A,
    job_id: JOB_ID,
    evidence_package_id: EVIDENCE_PKG_ID,
    pinned_examination_id: EXAM_ID,
    state: 'revoked',
    created_by: RECRUITER_ID,
    justification: null,
    failed_criterion_acknowledgments: null,
    created_at: new Date('2026-05-23T12:00:00Z'),
    confirmed_at: new Date('2026-05-23T13:00:00Z'),
    revoked_at: new Date('2026-05-23T15:00:00Z'),
    revoked_by: RECRUITER_ID,
    revocation_justification: 'Position frozen by hiring manager.',
  });
  const lookup = vi.fn().mockResolvedValue({ kind: 'proceed' });
  const persist = vi.fn().mockResolvedValue(undefined);
  const mockRepo = {
    createSubmittal: vi.fn(),
    confirmSubmittal: vi.fn(),
    revokeSubmittal,
  } as unknown as SubmittalRepository;
  const mockIdempotency = { lookup, persist } as unknown as IdempotencyService;
  const mockEvidence = { findById: vi.fn() } as unknown as EvidenceRepository;
  const controller = new SubmittalController(mockRepo, mockIdempotency, mockEvidence);
  return { controller, revokeSubmittal, lookup, persist };
}

const REVOKE_BODY = {
  revocation_justification: 'Position frozen by hiring manager.',
};

describe('SubmittalController.revokeSubmittal (unit)', () => {
  let ctx: RevokeMockSetup;
  beforeEach(() => {
    ctx = buildRevoke();
  });

  it('1. consumer_type !== "recruiter" → INSUFFICIENT_PERMISSIONS 403', async () => {
    try {
      await ctx.controller.revokeSubmittal(
        SUBMITTAL_ID,
        REVOKE_BODY,
        IDEMPOTENCY_KEY,
        makeAuth({ consumer_type: 'portal' }),
        REQUEST_ID,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AramoError);
      expect((err as AramoError).code).toBe('INSUFFICIENT_PERMISSIONS');
      expect((err as AramoError).statusCode).toBe(403);
    }
    expect(ctx.revokeSubmittal).not.toHaveBeenCalled();
  });

  it('2. Idempotency-Key missing → VALIDATION_ERROR 400', async () => {
    try {
      await ctx.controller.revokeSubmittal(
        SUBMITTAL_ID,
        REVOKE_BODY,
        undefined,
        makeAuth(),
        REQUEST_ID,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AramoError).code).toBe('VALIDATION_ERROR');
    }
    expect(ctx.revokeSubmittal).not.toHaveBeenCalled();
  });

  it('3. submittal_id non-UUID → VALIDATION_ERROR 400', async () => {
    try {
      await ctx.controller.revokeSubmittal(
        'not-a-uuid',
        REVOKE_BODY,
        IDEMPOTENCY_KEY,
        makeAuth(),
        REQUEST_ID,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AramoError).code).toBe('VALIDATION_ERROR');
    }
    expect(ctx.revokeSubmittal).not.toHaveBeenCalled();
  });

  it('4. successful → returns submittal + evidence_package_mutated literal false', async () => {
    const result = await ctx.controller.revokeSubmittal(
      SUBMITTAL_ID,
      REVOKE_BODY,
      IDEMPOTENCY_KEY,
      makeAuth(),
      REQUEST_ID,
    );
    expect(result.submittal.state).toBe('revoked');
    expect(result.evidence_package_mutated).toBe(false);
    expect(ctx.revokeSubmittal).toHaveBeenCalledTimes(1);
    expect(ctx.persist).toHaveBeenCalledTimes(1);
    const persistArg = ctx.persist.mock.calls[0]?.[0] as {
      response_status: number;
    };
    expect(persistArg.response_status).toBe(200);
  });

  it('5. idempotency replay: lookup returns replay → repository NOT called', async () => {
    const priorResponse = {
      submittal: { id: 'prior-submittal' },
      evidence_package_mutated: false as const,
    };
    ctx.lookup.mockResolvedValue({
      kind: 'replay',
      response_status: 200,
      response_body: priorResponse,
    });
    const result = await ctx.controller.revokeSubmittal(
      SUBMITTAL_ID,
      REVOKE_BODY,
      IDEMPOTENCY_KEY,
      makeAuth(),
      REQUEST_ID,
    );
    expect(result).toBe(priorResponse);
    expect(ctx.revokeSubmittal).not.toHaveBeenCalled();
    expect(ctx.persist).not.toHaveBeenCalled();
  });
});
