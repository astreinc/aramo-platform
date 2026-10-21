import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';

import { PipelineController } from '../lib/pipeline.controller.js';
import {
  AddTalentPolicyService,
  REQUISITION_NOT_FOUND_REASON,
} from '../lib/policy/add-talent-policy.service.js';

// Add-Talent → Qualified integrity fixes (LOCKED-spec conformance):
//   DEF-1 — Lane2-C §5 AC-7(b) / DDR §2: `completed` is unreachable through the generic
//           POST /v1/pipelines/:id/transition route (system-only COMPLETE).
//   DEF-2 — Lane2-DDR RP-1 "enforced fail-closed": an unresolved requisition (absent or
//           cross-tenant) is DENIED, never the package's permissive no-match default.
//   DEF-4 — Lane2-DDR §0/§6: an episode is born only for a Talent that exists in the
//           caller's tenant.

const TENANT = '11111111-1111-7111-8111-111111111111';
const TALENT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const REQ = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const KEY = '0190f000-0000-7000-8000-000000000001';
const AUTH = {
  sub: 'me',
  tenant_id: TENANT,
  actor_kind: 'user',
  scopes: ['pipeline:add', 'pipeline:change-status', 'pipeline:complete'],
} as unknown as AuthContextType;

function controller(parts: { talentExists?: boolean; withReader?: boolean; visible?: ReadonlySet<string> | null; endedBefore?: boolean } = {}) {
  const transition = vi.fn().mockResolvedValue({ id: 'pl-1', status: 'qualifying' });
  const create = vi.fn().mockResolvedValue({ id: 'pl-1', status: 'no_contact' });
  // Remediation v1.0 R3 (DEF-15(b)) — whether the Talent had an ended episode on the requisition.
  const hasEndedEpisode = vi.fn().mockResolvedValue(parts.endedBefore ?? false);
  const pipelineRepository = { transition, create, recordDecision: vi.fn(), hasEndedEpisode };
  const decide = vi.fn().mockResolvedValue({
    disposition: 'ALLOW',
    reason_code: 'LIFECYCLE_ALLOWED_DEFAULT',
    required_capabilities: [],
    provenance: {},
  });
  const idempotency = {
    lookup: vi.fn().mockResolvedValue({ kind: 'miss' }),
    persist: vi.fn().mockResolvedValue(undefined),
  };
  const existsInTenant = vi.fn().mockResolvedValue(parts.talentExists ?? true);
  const ctl = new PipelineController(
    pipelineRepository as never,
    { decide } as never,
    idempotency as never,
    undefined,
    parts.withReader === false ? undefined : ({ existsInTenant } as never),
  );
  // The visibility resolver yields a Set (or null = see-all); default: REQ is visible.
  const visible = parts.visible === undefined ? new Set([REQ]) : parts.visible;
  const req = { resolveVisibleRequisitionIds: async () => visible } as never;
  return { ctl, req, transition, create, decide, existsInTenant };
}

describe('DEF-1 — POST /v1/pipelines/:id/transition never reaches `completed`', () => {
  it('refuses to_status=completed with 403 PIPELINE_COMPLETE_SYSTEM_ONLY (even holding pipeline:complete); no write', async () => {
    const { ctl, req, transition } = controller();
    await expect(
      ctl.transition(AUTH, 'pl-1', { to_status: 'completed', expected_version: 3 } as never, 'rq-1', req),
    ).rejects.toMatchObject({ code: 'PIPELINE_COMPLETE_SYSTEM_ONLY', statusCode: 403 });
    expect(transition).not.toHaveBeenCalled();
  });

  it('a recruiter decision edge (qualifying) still transitions', async () => {
    const { ctl, req, transition } = controller();
    await ctl.transition(AUTH, 'pl-1', { to_status: 'qualifying', expected_version: 3 } as never, 'rq-1', req);
    expect(transition).toHaveBeenCalledTimes(1);
  });
});

describe('DEF-4 — POST /v1/pipelines requires the Talent to exist in the tenant', () => {
  const body = { talent_record_id: TALENT, requisition_id: REQ } as never;

  it('an absent / cross-tenant talent is 404 NOT_FOUND; no policy call, no write', async () => {
    const { ctl, req, create, decide, existsInTenant } = controller({ talentExists: false });
    await expect(ctl.create(AUTH, body, 'rq-1', KEY, req)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
    expect(existsInTenant).toHaveBeenCalledWith({ tenant_id: TENANT, talent_record_id: TALENT });
    expect(decide).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('an existing talent proceeds to the policy call and the create', async () => {
    const { ctl, req, create, decide } = controller({ talentExists: true });
    await ctl.create(AUTH, body, 'rq-1', KEY, req);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

// Pipeline & RTR Recon Remediation Directive v1.0 R3 — DEF-9 (visibility) + DEF-15(b) (re-add).
describe('R3 — POST /v1/pipelines visibility and re-add gates (unit)', () => {
  const body = { talent_record_id: TALENT, requisition_id: REQ } as never;

  it('DEF-9: a requisition the actor cannot see conceals as 404, before the policy call', async () => {
    const { ctl, req, create, decide } = controller({ visible: new Set(['some-other-req']) });
    await expect(ctl.create(AUTH, body, 'rq-1', KEY, req)).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(decide).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('DEF-9: a see-all actor (null visibility) proceeds', async () => {
    const { ctl, req, create } = controller({ visible: null });
    await ctl.create(AUTH, body, 'rq-1', KEY, req);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('DEF-15(b): re-adding after an ended episode without pipeline:re-add → 403; nothing created', async () => {
    const { ctl, req, create, decide } = controller({ endedBefore: true });
    await expect(ctl.create(AUTH, body, 'rq-1', KEY, req)).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      statusCode: 403,
      context: { details: { reason: 'pipeline_re_add_requires_senior_role' } },
    });
    expect(decide).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('DEF-15(b): a pipeline:re-add holder may re-add', async () => {
    const { ctl, req, create } = controller({ endedBefore: true });
    const senior = { ...AUTH, scopes: [...AUTH.scopes, 'pipeline:re-add'] } as unknown as AuthContextType;
    await ctl.create(senior, body, 'rq-1', KEY, req);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('DEF-2 — AddTalentPolicyService fails closed on an unresolved requisition', () => {
  const input = {
    tenant_id: TENANT,
    requisition_id: REQ,
    scopes: ['pipeline:add'],
    actor_id: 'me',
    origin: 'ui' as const,
    correlation_id: 'rq-1',
  };

  it('an absent / cross-tenant requisition (null status) is DENY REQUISITION_NOT_FOUND; no package retrieval', async () => {
    const getActiveVersion = vi.fn();
    const svc = new AddTalentPolicyService(
      { findStatusById: vi.fn().mockResolvedValue(null) } as never,
      { getActiveVersion } as never,
    );
    const out = await svc.decide(input);
    expect(out.disposition).toBe('DENY');
    expect(out.reason_code).toBe(REQUISITION_NOT_FOUND_REASON);
    expect(out.provenance.decision).toBe('DENY');
    expect(out.provenance.reason_code).toBe(REQUISITION_NOT_FOUND_REASON);
    expect(getActiveVersion).not.toHaveBeenCalled();
  });

  it('a resolved requisition is still evaluated against the published package', async () => {
    const getActiveVersion = vi.fn().mockResolvedValue(null); // no package → NO_POLICY_PUBLISHED
    const svc = new AddTalentPolicyService(
      { findStatusById: vi.fn().mockResolvedValue('open') } as never,
      { getActiveVersion } as never,
    );
    const out = await svc.decide(input);
    expect(getActiveVersion).toHaveBeenCalledTimes(1);
    expect(out.reason_code).toBe('NO_POLICY_PUBLISHED');
  });
});
