import { describe, it, expect, vi } from 'vitest';
import type { SubmittalRepository, TalentSubmittalEventRepository } from '@aramo/submittal';

import { TalentJourneyAuditService } from '../talent-journey-audit/talent-journey-audit.service.js';

// INC-1e (TIP-E2E) — correlated journey-audit read. Proves:
//  • the audit read does NOT cross tenant/visibility boundaries (non-visible → 404,
//    and the immutable event read is NEVER issued — no existence disclosure);
//  • the durable-ID spine correlates the trace across requests (no per-request id);
//  • authenticated actor provenance is surfaced from the immutable payload (honest
//    null when absent, never fabricated);
//  • entries are source-labelled (submittal transitions kept distinct).

const TENANT = 't-1';
const SUBMITTAL_ID = 'sub-1';
const TALENT = 'talent-1';
const REQ = 'req-1';
const EXAM = 'exam-1';
const EVPKG = 'evpkg-1';
const CREATED_BY = 'recruiter-1';

const submittalView = {
  id: SUBMITTAL_ID,
  tenant_id: TENANT,
  talent_id: TALENT,
  job_id: REQ,
  pinned_examination_id: EXAM,
  evidence_package_id: EVPKG,
  created_by: CREATED_BY,
  state: 'submitted_to_client',
};

function build(over: {
  findByIdForActor?: unknown;
  events?: unknown[];
} = {}) {
  const findByIdForActor = vi
    .fn()
    .mockResolvedValue(over.findByIdForActor === undefined ? submittalView : over.findByIdForActor);
  const findByTenantAndSubmittalId = vi.fn().mockResolvedValue(over.events ?? []);
  const submittal = { findByIdForActor } as unknown as SubmittalRepository;
  const events = { findByTenantAndSubmittalId } as unknown as TalentSubmittalEventRepository;
  const service = new TalentJourneyAuditService(submittal, events);
  return { service, findByIdForActor, findByTenantAndSubmittalId };
}

describe('TalentJourneyAuditService — INC-1e correlated journey audit', () => {
  it('out-of-visibility / cross-tenant submittal → 404 and NO event read (no existence disclosure)', async () => {
    const { service, findByIdForActor, findByTenantAndSubmittalId } = build({ findByIdForActor: null });
    await expect(
      service.getAuditTrace({
        tenant_id: TENANT,
        submittal_id: SUBMITTAL_ID,
        visible_requisition_ids: new Set(['some-other-req']),
        requestId: 'rq-audit',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    // The visibility set is threaded to the authoritative finder…
    expect(findByIdForActor).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT, id: SUBMITTAL_ID }),
    );
    // …and the immutable event read is NEVER issued on a concealed submittal.
    expect(findByTenantAndSubmittalId).not.toHaveBeenCalled();
  });

  it('threads the actor visible-requisition set into the authoritative finder', async () => {
    const vis = new Set([REQ]);
    const { service, findByIdForActor } = build();
    await service.getAuditTrace({ tenant_id: TENANT, submittal_id: SUBMITTAL_ID, visible_requisition_ids: vis, requestId: 'rq-audit' });
    expect(findByIdForActor).toHaveBeenCalledWith({
      tenant_id: TENANT,
      id: SUBMITTAL_ID,
      visible_requisition_ids: vis,
    });
  });

  it('returns the durable-ID correlation spine (join keys, no per-request id)', async () => {
    const { service } = build();
    const trace = await service.getAuditTrace({
      tenant_id: TENANT,
      submittal_id: SUBMITTAL_ID,
      visible_requisition_ids: null,
      requestId: 'rq-audit',
    });
    expect(trace.spine).toEqual({
      submittal_id: SUBMITTAL_ID,
      talent_id: TALENT,
      requisition_id: REQ, // = job_id (shared-UUID)
      examination_id: EXAM,
      evidence_package_id: EVPKG,
    });
    expect(trace.record_provenance).toEqual({ created_by: CREATED_BY });
  });

  it('maps immutable events to source-labelled entries with actor provenance from the payload', async () => {
    const events = [
      {
        id: 'evt-1',
        event_type: 'state_transition',
        created_at: new Date('2026-01-01T00:00:00Z'),
        event_payload: { submitted_by_actor_id: 'actor-9', to_state: 'submitted_to_client' },
      },
      {
        id: 'evt-2',
        event_type: 'revoked',
        created_at: new Date('2026-01-02T00:00:00Z'),
        event_payload: {}, // no actor recorded → honest null
      },
    ];
    const { service } = build({ events });
    const trace = await service.getAuditTrace({
      tenant_id: TENANT,
      submittal_id: SUBMITTAL_ID,
      visible_requisition_ids: null,
      requestId: 'rq-audit',
    });
    expect(trace.entries).toEqual([
      {
        source: 'submittal',
        kind: 'state_transition',
        occurred_at: '2026-01-01T00:00:00.000Z',
        actor_id: 'actor-9',
        submittal_event_id: 'evt-1',
      },
      {
        source: 'submittal',
        kind: 'revoked',
        occurred_at: '2026-01-02T00:00:00.000Z',
        actor_id: null, // never fabricated
        submittal_event_id: 'evt-2',
      },
    ]);
  });

  it('empty event history → spine still returned with an empty, honest trace', async () => {
    const { service } = build({ events: [] });
    const trace = await service.getAuditTrace({
      tenant_id: TENANT,
      submittal_id: SUBMITTAL_ID,
      visible_requisition_ids: null,
      requestId: 'rq-audit',
    });
    expect(trace.entries).toEqual([]);
    expect(trace.spine.submittal_id).toBe(SUBMITTAL_ID);
  });
});
