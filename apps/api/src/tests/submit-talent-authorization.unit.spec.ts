import { describe, it, expect, vi } from 'vitest';

import {
  SubmitTalentToClientService,
  type SubmitTalentToClientInput,
} from '../submit-talent/submit-talent.service.js';

// INC-1b (TIP-E2E) — send-path (POST .../submit-to-client) authorization unit spec.
// Proves server-resolved SITE + requisition-VISIBILITY are enforced on the VALIDATED
// pipeline chain BEFORE any state mutation / slot consumption / outbox write. The
// authz block sits in-tx after the submittal + pipeline reads (both FOR UPDATE) and
// before the requisition-open gate; a DENIAL therefore consumes only the two reads —
// no third query means no mutation path was entered (no side effects). A PASS reaches
// the open-gate read (3rd query), which here refuses REQUISITION_NOT_OPEN — proving
// the actor cleared authorization, not that the submit completed.

const TENANT = '11111111-1111-7111-8111-111111111111';
const SUBMITTAL_ID = '22222222-2222-7222-8222-222222222222';
const REQ_ID = '33333333-3333-7333-8333-333333333333';
const TALENT = '44444444-4444-7444-8444-444444444444';
const PIPE_ID = '55555555-5555-7555-8555-555555555555';
const EVENT_ID = '66666666-6666-7666-8666-666666666666';
const ACTOR_ID = '77777777-7777-7777-8777-777777777777';
const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f00';
const OTHER_REQ = '99999999-9999-7999-8999-999999999999';
// v1.2 §4.4(d) — the two statements that now precede the submittal read in the tx.
const LEAD_STATEMENTS = 2;

function makeInput(
  over: Partial<SubmitTalentToClientInput> = {},
): SubmitTalentToClientInput {
  return {
    tenant_id: TENANT,
    submittal_id: SUBMITTAL_ID,
    event_id: EVENT_ID,
    actor_id: ACTOR_ID,
    requestId: REQUEST_ID,
    // INC-1d defaults so the authorization-pass cases clear the service's fail-closed
    // attestation floor and reach the downstream open-gate; the INC-1d suite below
    // overrides these to prove the service-level refusals (direct-invocation bypass guard).
    handoff_performed: true,
    delivery_channel: 'manual_email',
    ...over,
  };
}

function buildService(over: { pipelineSiteId?: string | null } = {}) {
  const submittalRow = {
    id: SUBMITTAL_ID,
    tenant_id: TENANT,
    talent_id: TALENT,
    job_id: REQ_ID,
    pipeline_id: PIPE_ID,
    state: 'ready_for_review', // legal pre-state for -> submitted_to_client
  };
  const pipelineRow = {
    id: PIPE_ID,
    tenant_id: TENANT,
    talent_record_id: TALENT,
    requisition_id: REQ_ID,
    site_id: over.pipelineSiteId ?? null,
    status: 'qualified', // live (non-terminal) → passes the link-liveness verdict
  };
  // Sequential raw-SQL returns inside the orchestration tx (Talent Lifecycle R1–R5 Impl
  // Directive v1.2 §4.4(d): the shared client-submittal-policy lock + the database-clock
  // linearization read now LEAD the transaction — LEAD_STATEMENTS below):
  //   0a) pg_advisory_xact_lock_shared   0b) clock_timestamp()
  //   1) submittal SELECT ... FOR UPDATE   2) pipeline SELECT ... FOR UPDATE
  //   3) requisition-open gate read (empty → REQUISITION_NOT_OPEN; only reached on PASS)
  const queryRaw = vi
    .fn()
    .mockResolvedValueOnce([{ locked: '' }])
    .mockResolvedValueOnce([{ t: new Date('2026-10-20T00:00:00Z') }])
    .mockResolvedValueOnce([submittalRow])
    .mockResolvedValueOnce([pipelineRow])
    .mockResolvedValue([]);
  const tx = {
    $queryRawUnsafe: queryRaw,
    $executeRawUnsafe: vi.fn(),
    $executeRaw: vi.fn(),
  };
  const db = {
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  // engagement / document-readiness / client-submittal-policy gates are invoked only
  // AFTER authorization + the open-gate — never reached on a denial path here.
  const gate = {};
  const service = new SubmitTalentToClientService(
    db as never,
    logger as never,
    gate as never,
    gate as never,
    gate as never,
  );
  return { service, queryRaw };
}

describe('SubmitTalentToClientService — INC-1b send-path authorization', () => {
  it('cross-site: site-scoped actor + pipeline in a different site → 403, no mutation', async () => {
    const { service, queryRaw } = buildService({ pipelineSiteId: 'site-B' });
    await expect(
      service.submitToClient(makeInput({ actor_site_id: 'site-A' })),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    // Only the two reads ran — the mutation path (3rd+ query) was never entered.
    expect(queryRaw).toHaveBeenCalledTimes(LEAD_STATEMENTS + 2);
  });

  it('hidden requisition: requisition not in actor visible set → 404, no mutation', async () => {
    const { service, queryRaw } = buildService({ pipelineSiteId: null });
    await expect(
      service.submitToClient(makeInput({ visible_requisition_ids: new Set([OTHER_REQ]) })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(queryRaw).toHaveBeenCalledTimes(LEAD_STATEMENTS + 2);
  });

  it('tenant-wide actor (null site) + see_all (null visible) → authz passes, reaches open-gate', async () => {
    const { service, queryRaw } = buildService({ pipelineSiteId: 'site-B' });
    // null actor_site_id = tenant-wide (admitted on any site); null visible = see_all.
    await expect(
      service.submitToClient(
        makeInput({ actor_site_id: null, visible_requisition_ids: null }),
      ),
    ).rejects.toMatchObject({ code: 'REQUISITION_NOT_OPEN' });
    expect(queryRaw).toHaveBeenCalledTimes(LEAD_STATEMENTS + 3);
  });

  it('valid access: site + requisition visibility match → authz passes, reaches open-gate', async () => {
    const { service, queryRaw } = buildService({ pipelineSiteId: 'site-A' });
    await expect(
      service.submitToClient(
        makeInput({ actor_site_id: 'site-A', visible_requisition_ids: new Set([REQ_ID]) }),
      ),
    ).rejects.toMatchObject({ code: 'REQUISITION_NOT_OPEN' });
    expect(queryRaw).toHaveBeenCalledTimes(LEAD_STATEMENTS + 3);
  });
});

// INC-1d (TIP-E2E) — SERVICE-LEVEL manual-handoff floor. Proves the mutation command
// itself fails closed on a DIRECT invocation that bypasses the controller: the
// attestation + required delivery_channel are enforced on the authorized chain BEFORE
// the open-gate / slot / mutation (no side effects — only the two reads run).
describe('SubmitTalentToClientService — INC-1d service-level attestation floor', () => {
  it('missing handoff_performed → ATTESTATION_MISSING (422), no mutation (direct-invocation guard)', async () => {
    const { service, queryRaw } = buildService({ pipelineSiteId: null });
    await expect(
      service.submitToClient(
        makeInput({ handoff_performed: undefined, visible_requisition_ids: null }),
      ),
    ).rejects.toMatchObject({ code: 'ATTESTATION_MISSING', statusCode: 422 });
    expect(queryRaw).toHaveBeenCalledTimes(LEAD_STATEMENTS + 2);
  });

  it('handoff_performed:false (non-true) → ATTESTATION_MISSING (422), no mutation', async () => {
    const { service, queryRaw } = buildService({ pipelineSiteId: null });
    await expect(
      service.submitToClient(
        makeInput({ handoff_performed: false, visible_requisition_ids: null }),
      ),
    ).rejects.toMatchObject({ code: 'ATTESTATION_MISSING', statusCode: 422 });
    expect(queryRaw).toHaveBeenCalledTimes(LEAD_STATEMENTS + 2);
  });

  it('attested but delivery_channel missing → SUBMITTAL_DELIVERY_CHANNEL_INVALID (422, required), no mutation', async () => {
    const { service, queryRaw } = buildService({ pipelineSiteId: null });
    await expect(
      service.submitToClient(
        makeInput({ delivery_channel: null, visible_requisition_ids: null }),
      ),
    ).rejects.toMatchObject({
      code: 'SUBMITTAL_DELIVERY_CHANNEL_INVALID',
      statusCode: 422,
      context: { details: { reason: 'required' } },
    });
    expect(queryRaw).toHaveBeenCalledTimes(LEAD_STATEMENTS + 2);
  });

  it('attestation floor runs AFTER authorization (an unauthorized + unattested send is denied on authz first)', async () => {
    // cross-site actor + missing attestation: the site denial (403) precedes the
    // attestation check — authz is the outermost gate.
    const { service, queryRaw } = buildService({ pipelineSiteId: 'site-B' });
    await expect(
      service.submitToClient(
        makeInput({ actor_site_id: 'site-A', handoff_performed: undefined }),
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    expect(queryRaw).toHaveBeenCalledTimes(LEAD_STATEMENTS + 2);
  });
});
