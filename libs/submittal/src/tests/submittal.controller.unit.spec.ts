import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AramoError } from '@aramo/common';
import { IdempotencyService } from '@aramo/consent';
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
  const controller = new SubmittalController(mockRepo, mockIdempotency);
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
  const controller = new SubmittalController(mockRepo, mockIdempotency);
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
