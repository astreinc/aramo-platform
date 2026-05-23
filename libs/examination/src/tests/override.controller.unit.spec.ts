import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import type { IdempotencyService } from '@aramo/consent';

import { CreateOverrideRequestDto } from '../lib/dto/create-override-request.dto.js';
import type { ExaminationRepository } from '../lib/examination.repository.js';
import { OverrideController } from '../lib/override.controller.js';

// M4 PR-5 §4.11 — OverrideController unit spec.
//
// Mocks ExaminationRepository and IdempotencyService. Asserts:
//   (1) Non-recruiter consumer → 403 INSUFFICIENT_PERMISSIONS
//   (2) Missing Idempotency-Key → 400 VALIDATION_ERROR
//   (3) Malformed examination_id → 400 VALIDATION_ERROR
//   (4) Happy path → 201 with examination_mutated: false literal
//   (5) Repository AramoError re-thrown with the controller's requestId

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const EXAM_ID = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
const RECRUITER_SUB = '00000000-0000-7000-8000-0000000000bb';
const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1500';
const IDEMPOTENCY_KEY = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1501';

function recruiterAuth(
  overrides: Partial<{ consumer_type: 'recruiter' | 'portal' | 'ingestion'; sub: string }> = {},
) {
  return {
    sub: overrides.sub ?? RECRUITER_SUB,
    consumer_type: overrides.consumer_type ?? ('recruiter' as const),
    actor_kind: 'user' as const,
    tenant_id: TENANT_ID,
    scopes: [],
    iat: 0,
    exp: 0,
  };
}

function makeRequestBody(): CreateOverrideRequestDto {
  const dto = new CreateOverrideRequestDto();
  dto.override_type = 'tier';
  dto.target_field = 'tier';
  dto.justification = 'rationale';
  return dto;
}

function build(opts: {
  createOverride?: ReturnType<typeof vi.fn>;
  lookup?: ReturnType<typeof vi.fn>;
  persist?: ReturnType<typeof vi.fn>;
} = {}) {
  const createOverride =
    opts.createOverride ??
    vi.fn().mockResolvedValue({
      id: '99990000-0000-7000-8000-000000000901',
      tenant_id: TENANT_ID,
      examination_id: EXAM_ID,
      override_type: 'tier',
      target_field: 'tier',
      justification: 'rationale',
      created_by: RECRUITER_SUB,
      created_at: '2026-05-23T12:00:00Z',
    });
  const lookup = opts.lookup ?? vi.fn().mockResolvedValue({ kind: 'proceed' });
  const persist = opts.persist ?? vi.fn().mockResolvedValue(undefined);

  const examinationRepository = { createOverride } as unknown as ExaminationRepository;
  const idempotencyService = { lookup, persist } as unknown as IdempotencyService;
  const controller = new OverrideController(examinationRepository, idempotencyService);
  return { controller, createOverride, lookup, persist };
}

describe('OverrideController.createOverride (unit)', () => {
  it('1. non-recruiter consumer → 403 INSUFFICIENT_PERMISSIONS', async () => {
    const { controller, createOverride } = build();
    await expect(
      controller.createOverride(
        EXAM_ID,
        makeRequestBody(),
        IDEMPOTENCY_KEY,
        recruiterAuth({ consumer_type: 'portal' }),
        REQUEST_ID,
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    expect(createOverride).not.toHaveBeenCalled();
  });

  it('2. missing Idempotency-Key → 400 VALIDATION_ERROR', async () => {
    const { controller } = build();
    await expect(
      controller.createOverride(
        EXAM_ID,
        makeRequestBody(),
        undefined,
        recruiterAuth(),
        REQUEST_ID,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
  });

  it('3. malformed examination_id → 400 VALIDATION_ERROR', async () => {
    const { controller } = build();
    await expect(
      controller.createOverride(
        'not-a-uuid',
        makeRequestBody(),
        IDEMPOTENCY_KEY,
        recruiterAuth(),
        REQUEST_ID,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
  });

  it('4. happy path → 201-shape response with literal examination_mutated: false', async () => {
    const { controller, persist } = build();
    const response = await controller.createOverride(
      EXAM_ID,
      makeRequestBody(),
      IDEMPOTENCY_KEY,
      recruiterAuth(),
      REQUEST_ID,
    );
    expect(response.examination_mutated).toBe(false);
    expect(response.override.examination_id).toBe(EXAM_ID);
    expect(response.override.override_type).toBe('tier');
    // Idempotency persist runs post-mutation success.
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('5. repository AramoError re-thrown with bound requestId', async () => {
    const { controller } = build({
      createOverride: vi.fn().mockRejectedValue(
        new AramoError('NOT_FOUND', 'TalentJobExamination not found', 404, {
          requestId: 'override',
        }),
      ),
    });
    const err = await controller
      .createOverride(EXAM_ID, makeRequestBody(), IDEMPOTENCY_KEY, recruiterAuth(), REQUEST_ID)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AramoError);
    expect((err as AramoError).code).toBe('NOT_FOUND');
    // The substrate raised with requestId='override'; controller rebinds
    // to the inbound REQUEST_ID per PR-3 enrichment precedent.
    expect((err as AramoError).context.requestId).toBe(REQUEST_ID);
  });
});
