import { describe, expect, it, vi } from 'vitest';

import { ClientSelectionController } from '../lib/client-selection.controller.js';
import type { InterviewSessionRepository } from '../lib/interview-session.repository.js';
import type { ClientSelectionProcessRepository } from '../lib/client-selection.repository.js';
import type { InterviewSessionView } from '../lib/dto/interview-session.view.js';

// Lane 2 / L2-F (F2) — the schedule route's idempotency + required-UUID-key wiring,
// proven at the controller boundary with a mocked IdempotencyService (the consent DB is
// out of scope here; IdempotencyService's own semantics are proven in libs/consent and
// the pipeline precedent). Covers F2.1's Idempotency-Key contract: missing/non-UUID →
// 400; proceed → repo + persist; replay → the first response, repo NOT called.

const VIEW: InterviewSessionView = {
  id: '11111111-1111-7111-8111-111111111111',
  tenant_id: 't',
  client_selection_process_id: 'p',
  requisition_id: 'r',
  talent_record_id: 'tr',
  site_id: null,
  interview_type: 'onsite',
  round: 1,
  scheduled_at: '2026-09-01T15:00:00.000Z',
  interviewer_user_ids: [],
  state: 'SCHEDULED',
  version: 0,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
};

const AUTH = { tenant_id: 't', sub: 'actor' } as never;
const BODY = { interview_type: 'onsite', scheduled_at: '2026-09-01T15:00:00Z' };
const REQ = { resolveVisibleRequisitionIds: async () => null } as never;
const UUID_KEY = 'cccccccc-cccc-7ccc-8ccc-ccccccccccc9';

function make(idempotency: { lookup: unknown; persist: unknown }) {
  const interviews = {
    scheduleInterview: vi.fn(async () => VIEW),
  } as unknown as InterviewSessionRepository;
  const process = {} as ClientSelectionProcessRepository;
  const controller = new ClientSelectionController(
    process,
    interviews,
    idempotency as never,
  );
  return { controller, interviews };
}

describe('L2-F F2 — interview schedule idempotency wiring (unit)', () => {
  it('missing Idempotency-Key → VALIDATION_ERROR 400, repo not called', async () => {
    const { controller, interviews } = make({ lookup: vi.fn(), persist: vi.fn() });
    await expect(
      controller.scheduleInterview(AUTH, 'p', BODY, undefined, 'rid', REQ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    expect(interviews.scheduleInterview).not.toHaveBeenCalled();
  });

  it('non-UUID Idempotency-Key → VALIDATION_ERROR 400', async () => {
    const { controller } = make({ lookup: vi.fn(), persist: vi.fn() });
    await expect(
      controller.scheduleInterview(AUTH, 'p', BODY, 'not-a-uuid', 'rid', REQ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
  });

  it('proceed → schedules via repo then persists the response', async () => {
    const persist = vi.fn(async () => undefined);
    const lookup = vi.fn(async () => ({ kind: 'proceed' as const }));
    const { controller, interviews } = make({ lookup, persist });
    const out = await controller.scheduleInterview(AUTH, 'p', BODY, UUID_KEY, 'rid', REQ);
    expect(out).toBe(VIEW);
    expect(interviews.scheduleInterview).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
  });

  it('replay → returns the first response, repo + persist NOT called', async () => {
    const persist = vi.fn(async () => undefined);
    const lookup = vi.fn(async () => ({
      kind: 'replay' as const,
      response_status: 201,
      response_body: VIEW,
    }));
    const { controller, interviews } = make({ lookup, persist });
    const out = await controller.scheduleInterview(AUTH, 'p', BODY, UUID_KEY, 'rid', REQ);
    expect(out).toBe(VIEW);
    expect(interviews.scheduleInterview).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });
});
