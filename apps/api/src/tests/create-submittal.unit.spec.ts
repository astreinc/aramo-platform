import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AramoError } from '@aramo/common';
import type { IdempotencyService } from '@aramo/consent';
import type { PipelineRepository } from '@aramo/pipeline';
import type { SubmittalRepository, CreateSubmittalRequestDto } from '@aramo/submittal';
import type { AuthContextType } from '@aramo/auth';

import { CreateSubmittalOrchestrator } from '../create-submittal/create-submittal.service.js';
import { CreateSubmittalController } from '../create-submittal/create-submittal.controller.js';

// SW-1 (Submittal Workspace, R1-A) — unit spec for the re-pointed create command.
//
// Orchestrator: proves pipeline_id is DERIVED server-side from the sole live
// Pipeline episode and forwarded to SubmittalRepository.createSubmittal, and that a
// missing live episode is refused (SUBMITTAL_NO_LIVE_PIPELINE_EPISODE) BEFORE any
// write. Controller: preserves the auth + Idempotency-Key posture of the legacy
// libs/submittal handler.

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TALENT_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const JOB_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const EXAM_ID = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const PIPELINE_ID = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
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

function liveEpisode(overrides: Record<string, unknown> = {}) {
  return {
    id: PIPELINE_ID,
    tenant_id: TENANT_A,
    site_id: null,
    talent_record_id: TALENT_A,
    requisition_id: JOB_ID,
    status: 'qualifying',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    version: 1,
    ...overrides,
  };
}

function createdSubmittal(pipeline_id: string | null) {
  return {
    id: '99990000-0000-7000-8000-000000000001',
    tenant_id: TENANT_A,
    talent_id: TALENT_A,
    job_id: JOB_ID,
    evidence_package_id: '99990000-0000-7000-8000-000000000002',
    pinned_examination_id: EXAM_ID,
    pipeline_id,
    state: 'created',
    created_by: RECRUITER_ID,
    justification: null,
    failed_criterion_acknowledgments: null,
    created_at: new Date(),
    confirmed_at: null,
    revoked_at: null,
    revoked_by: null,
    revocation_justification: null,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator — server-side pipeline derivation (R1-A)
// ---------------------------------------------------------------------------
describe('CreateSubmittalOrchestrator (unit) — server-side pipeline derivation', () => {
  let findLiveEpisode: ReturnType<typeof vi.fn>;
  let createSubmittal: ReturnType<typeof vi.fn>;
  let orchestrator: CreateSubmittalOrchestrator;

  beforeEach(() => {
    findLiveEpisode = vi.fn();
    createSubmittal = vi.fn();
    orchestrator = new CreateSubmittalOrchestrator(
      { findLiveEpisode } as unknown as PipelineRepository,
      { createSubmittal } as unknown as SubmittalRepository,
    );
  });

  it('derives pipeline_id from the sole live episode and forwards it to createSubmittal', async () => {
    findLiveEpisode.mockResolvedValue(liveEpisode());
    createSubmittal.mockResolvedValue(createdSubmittal(PIPELINE_ID));

    const result = await orchestrator.create({
      requestId: REQUEST_ID,
      tenant_id: TENANT_A,
      talent_id: TALENT_A,
      job_id: JOB_ID,
      examination_id: EXAM_ID,
      created_by: RECRUITER_ID,
      talent_identity: makeBody().talent_identity,
      contact_summary: makeBody().contact_summary,
      capability_summary_overrides: makeBody().capability_summary_overrides,
      recruiter_contribution: makeBody().recruiter_contribution,
    });

    // Reader keyed on the triple (tenant, talent, requisition).
    expect(findLiveEpisode).toHaveBeenCalledWith({
      tenant_id: TENANT_A,
      talent_record_id: TALENT_A,
      requisition_id: JOB_ID,
    });
    // pipeline_id derived server-side == the live episode id.
    const passed = createSubmittal.mock.calls[0]?.[0] as { pipeline_id?: string | null };
    expect(passed.pipeline_id).toBe(PIPELINE_ID);
    // requestId is NOT forwarded into the repository input.
    expect(passed).not.toHaveProperty('requestId');
    expect(result.pipeline_id).toBe(PIPELINE_ID);
  });

  it('refuses with SUBMITTAL_NO_LIVE_PIPELINE_EPISODE (409) when no live episode exists — no write', async () => {
    findLiveEpisode.mockResolvedValue(null);

    await expect(
      orchestrator.create({
        requestId: REQUEST_ID,
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        job_id: JOB_ID,
        examination_id: EXAM_ID,
        created_by: RECRUITER_ID,
        talent_identity: makeBody().talent_identity,
        contact_summary: makeBody().contact_summary,
        capability_summary_overrides: makeBody().capability_summary_overrides,
        recruiter_contribution: makeBody().recruiter_contribution,
      }),
    ).rejects.toMatchObject({ code: 'SUBMITTAL_NO_LIVE_PIPELINE_EPISODE', statusCode: 409 });

    expect(createSubmittal).not.toHaveBeenCalled();
  });

  it('never trusts a caller-supplied pipeline_id — the type omits it and derivation is authoritative', async () => {
    findLiveEpisode.mockResolvedValue(liveEpisode({ id: PIPELINE_ID }));
    createSubmittal.mockResolvedValue(createdSubmittal(PIPELINE_ID));

    // A rogue extra field on the input object must not reach the repository as the link.
    await orchestrator.create({
      requestId: REQUEST_ID,
      tenant_id: TENANT_A,
      talent_id: TALENT_A,
      job_id: JOB_ID,
      examination_id: EXAM_ID,
      created_by: RECRUITER_ID,
      talent_identity: makeBody().talent_identity,
      contact_summary: makeBody().contact_summary,
      capability_summary_overrides: makeBody().capability_summary_overrides,
      recruiter_contribution: makeBody().recruiter_contribution,
      // @ts-expect-error — pipeline_id is intentionally NOT part of the input type.
      pipeline_id: 'ffffffff-ffff-7fff-8fff-ffffffffffff',
    });

    const passed = createSubmittal.mock.calls[0]?.[0] as { pipeline_id?: string | null };
    expect(passed.pipeline_id).toBe(PIPELINE_ID);
  });
});

// ---------------------------------------------------------------------------
// Controller — auth + Idempotency-Key posture (preserved from legacy handler)
// ---------------------------------------------------------------------------
interface ControllerCtx {
  controller: CreateSubmittalController;
  create: ReturnType<typeof vi.fn>;
  lookup: ReturnType<typeof vi.fn>;
  persist: ReturnType<typeof vi.fn>;
}

function buildController(): ControllerCtx {
  const create = vi.fn().mockResolvedValue(createdSubmittal(PIPELINE_ID));
  const lookup = vi.fn().mockResolvedValue({ kind: 'proceed' });
  const persist = vi.fn().mockResolvedValue(undefined);
  const controller = new CreateSubmittalController(
    { create } as unknown as CreateSubmittalOrchestrator,
    { lookup, persist } as unknown as IdempotencyService,
  );
  return { controller, create, lookup, persist };
}

describe('CreateSubmittalController (unit) — auth + idempotency', () => {
  let ctx: ControllerCtx;
  beforeEach(() => {
    ctx = buildController();
  });

  it('consumer_type !== "recruiter" → INSUFFICIENT_PERMISSIONS (403), no orchestration', async () => {
    await expect(
      ctx.controller.createSubmittal(makeBody(), IDEMPOTENCY_KEY, makeAuth({ consumer_type: 'portal' }), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    expect(ctx.create).not.toHaveBeenCalled();
  });

  it('Idempotency-Key missing → VALIDATION_ERROR (400)', async () => {
    await expect(
      ctx.controller.createSubmittal(makeBody(), undefined, makeAuth(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('Idempotency-Key non-UUID → VALIDATION_ERROR (400)', async () => {
    await expect(
      ctx.controller.createSubmittal(makeBody(), 'not-a-uuid', makeAuth(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('replay path: returns prior response, orchestrator NOT called', async () => {
    const priorResponse = { submittal: { id: 'prior' } } as unknown;
    ctx.lookup.mockResolvedValue({ kind: 'replay', response_status: 201, response_body: priorResponse });
    const result = await ctx.controller.createSubmittal(makeBody(), IDEMPOTENCY_KEY, makeAuth(), REQUEST_ID);
    expect(result).toBe(priorResponse);
    expect(ctx.create).not.toHaveBeenCalled();
    expect(ctx.persist).not.toHaveBeenCalled();
  });

  it('happy path: returns { submittal } then persists idempotency (201)', async () => {
    const result = await ctx.controller.createSubmittal(makeBody(), IDEMPOTENCY_KEY, makeAuth(), REQUEST_ID);
    expect(result.submittal.state).toBe('created');
    expect(ctx.create).toHaveBeenCalledTimes(1);
    expect(ctx.persist).toHaveBeenCalledTimes(1);
    const persistArg = ctx.persist.mock.calls[0]?.[0] as { response_status: number };
    expect(persistArg.response_status).toBe(201);
  });

  it('orchestrator refusal propagates (re-bound requestId) without persisting idempotency', async () => {
    ctx.create.mockRejectedValue(
      new AramoError('SUBMITTAL_NO_LIVE_PIPELINE_EPISODE', 'no live episode', 409, { requestId: 'builder' }),
    );
    await expect(
      ctx.controller.createSubmittal(makeBody(), IDEMPOTENCY_KEY, makeAuth(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'SUBMITTAL_NO_LIVE_PIPELINE_EPISODE', statusCode: 409 });
    expect(ctx.persist).not.toHaveBeenCalled();
  });

  it('malformed sub → INVALID_REQUEST (400)', async () => {
    await expect(
      ctx.controller.createSubmittal(makeBody(), IDEMPOTENCY_KEY, makeAuth({ sub: 'not-a-uuid' }), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});
