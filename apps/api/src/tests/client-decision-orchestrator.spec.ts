import { describe, expect, it, vi } from 'vitest';

import { ClientDecisionOrchestrator } from '../client-decision-orchestration/client-decision.orchestrator.js';

// L3-E(2) — the governed decision orchestrator. DECLINED terminates by default; WITHDRAWN
// is cause-sensitive; TERMINATES → the linked Pipeline is dispositioned via the
// system-gated writer; PRESERVES → Pipeline untouched; an unclassifiable WITHDRAWN is 422
// and never transitions. Pipeline is resolved through the Submittal, and an already-terminal
// episode is never reopened.

const SUBMITTAL = 'sub-1';
const PIPELINE = 'pipe-1';

function harness(opts: { pipelineStatus?: string; pipelineId?: string | null } = {}) {
  const transition = vi
    .fn()
    .mockResolvedValue({ id: 'proc-1', submittal_id: SUBMITTAL, state: 'DECLINED', version: 1 });
  const findById = vi.fn().mockResolvedValue(
    opts.pipelineId === null
      ? null
      : { id: PIPELINE, status: opts.pipelineStatus ?? 'qualified', version: 3 },
  );
  const dispositionDownstream = vi.fn().mockResolvedValue({ id: PIPELINE });
  const db = {
    $queryRawUnsafe: vi
      .fn()
      .mockResolvedValue(
        opts.pipelineId === null ? [{ pipeline_id: null }] : [{ pipeline_id: PIPELINE }],
      ),
  };
  const orch = new ClientDecisionOrchestrator(
    { transition } as never,
    { findById, dispositionDownstream } as never,
    db as never,
  );
  return { orch, transition, findById, dispositionDownstream, db };
}

const base = {
  tenant_id: 't-1',
  id: 'proc-1',
  expected_version: 0,
  changed_by_id: 'u-1',
  visible_requisition_ids: null,
  requestId: 'r-1',
};

describe('ClientDecisionOrchestrator (L3-E(2))', () => {
  it('DECLINED → transitions and dispositions the linked Pipeline (client_selection_declined)', async () => {
    const h = harness();
    const out = await h.orch.decide({ ...base, to_state: 'DECLINED' });
    expect(h.transition).toHaveBeenCalledWith(expect.objectContaining({ to_state: 'DECLINED' }));
    expect(h.dispositionDownstream).toHaveBeenCalledWith(
      expect.objectContaining({ id: PIPELINE, reason: 'client_selection_declined', expected_version: 3 }),
    );
    expect(out.pipeline_dispositioned).toBe(true);
  });

  it('WITHDRAWN terminal cause → dispositions the Pipeline (client_selection_withdrawn)', async () => {
    const h = harness();
    const out = await h.orch.decide({ ...base, to_state: 'WITHDRAWN', reason_code: 'TALENT_WITHDREW' });
    expect(h.dispositionDownstream).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'client_selection_withdrawn' }),
    );
    expect(out.pipeline_dispositioned).toBe(true);
  });

  it('WITHDRAWN preserving cause → transitions but leaves Pipeline qualified', async () => {
    const h = harness();
    const out = await h.orch.decide({ ...base, to_state: 'WITHDRAWN', reason_code: 'RESUBMITTAL' });
    expect(h.transition).toHaveBeenCalledOnce();
    expect(h.dispositionDownstream).not.toHaveBeenCalled();
    expect(out.pipeline_dispositioned).toBe(false);
  });

  it('WITHDRAWN with no/invalid reason → 422 and does NOT transition', async () => {
    const h = harness();
    await expect(h.orch.decide({ ...base, to_state: 'WITHDRAWN' })).rejects.toMatchObject({
      code: 'CLIENT_SELECTION_WITHDRAW_REASON_INVALID',
      statusCode: 422,
    });
    await expect(
      h.orch.decide({ ...base, to_state: 'WITHDRAWN', reason_code: 'free_text' }),
    ).rejects.toMatchObject({ code: 'CLIENT_SELECTION_WITHDRAW_REASON_INVALID' });
    expect(h.transition).not.toHaveBeenCalled();
  });

  it('a non-DECLINED/WITHDRAWN target is refused (this endpoint is decision-only)', async () => {
    const h = harness();
    await expect(h.orch.decide({ ...base, to_state: 'SELECTED' })).rejects.toMatchObject({
      code: 'INVALID_CLIENT_SELECTION_TRANSITION',
      statusCode: 422,
    });
  });

  it('TERMINATES but Pipeline already terminal → transitions, does NOT reopen', async () => {
    const h = harness({ pipelineStatus: 'not_in_consideration' });
    const out = await h.orch.decide({ ...base, to_state: 'DECLINED' });
    expect(h.transition).toHaveBeenCalledOnce();
    expect(h.dispositionDownstream).not.toHaveBeenCalled();
    expect(out.pipeline_dispositioned).toBe(false);
  });

  it('TERMINATES but Submittal has no linked Pipeline → transitions, no disposition', async () => {
    const h = harness({ pipelineId: null });
    const out = await h.orch.decide({ ...base, to_state: 'DECLINED' });
    expect(h.dispositionDownstream).not.toHaveBeenCalled();
    expect(out.pipeline_dispositioned).toBe(false);
  });
});
