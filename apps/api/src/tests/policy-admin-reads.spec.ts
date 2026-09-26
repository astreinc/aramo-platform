import { describe, it, expect, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';

import { EngagementController } from '../engagement/engagement.controller.js';
import { PreStartRequirementController } from '../pre-start-requirement/pre-start-requirement.controller.js';

// PA-2c — the Engagement + Pre-Start admin read surfaces (effective view / raw layers
// / history). Pure controller-logic proofs: the §27 company-ownership guard and scope
// validation are exercised directly with stubbed collaborators.

const AUTH = { tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sub: 'u1' } as unknown as AuthContextType;
const OWNED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FOREIGN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('PA-2c — Engagement read endpoints (ownership + scope)', () => {
  function make(isClient: (id: string) => boolean) {
    const resolveEffectiveView = vi.fn().mockResolvedValue({ requirements: [], layers: [], composite_version: 'v', enforcement_mode: 'ENFORCING' });
    const readLayers = vi.fn().mockResolvedValue({ tenant: {}, client: null, requisition: null, effective: null });
    const history = vi.fn().mockResolvedValue([]);
    const isTenantGoverned = vi.fn().mockResolvedValue(true);
    const isClientCompany = vi.fn(({ company_id }: { company_id: string }) => Promise.resolve(isClient(company_id)));
    const controller = new EngagementController(
      { resolveEffectiveView, readLayers, history, isTenantGoverned } as never,
      {} as never,
      { isClientCompany } as never,
    );
    return { controller, resolveEffectiveView, readLayers, history, isClientCompany };
  }

  it('effective for an OWNED client delegates to the annotated view + governed', async () => {
    const { controller, resolveEffectiveView, isClientCompany } = make(() => true);
    const res = await controller.effective(undefined, OWNED, AUTH, 'r1');
    expect(isClientCompany).toHaveBeenCalledWith({ tenant_id: AUTH.tenant_id, company_id: OWNED });
    expect(resolveEffectiveView).toHaveBeenCalledWith(AUTH.tenant_id, { company_id: OWNED, requisition_id: null });
    expect(res.governed).toBe(true);
  });

  it('effective for a FOREIGN company → 422 COMPANY_NOT_CLIENT, service NOT called', async () => {
    const { controller, resolveEffectiveView } = make((id) => id !== FOREIGN);
    await expect(controller.effective(undefined, FOREIGN, AUTH, 'r2')).rejects.toMatchObject({
      code: 'ENGAGEMENT_POLICY_SCHEMA_INVALID',
      statusCode: 422,
      context: { details: { reason: 'COMPANY_NOT_CLIENT' } },
    });
    expect(resolveEffectiveView).not.toHaveBeenCalled();
  });

  it('layers for a FOREIGN company → 422, service NOT called', async () => {
    const { controller, readLayers } = make((id) => id !== FOREIGN);
    await expect(controller.layers(undefined, FOREIGN, AUTH, 'r3')).rejects.toMatchObject({ code: 'ENGAGEMENT_POLICY_SCHEMA_INVALID' });
    expect(readLayers).not.toHaveBeenCalled();
  });

  it('history TENANT delegates a null scope_ref', async () => {
    const { controller, history } = make(() => true);
    await controller.history('TENANT', undefined, AUTH, 'r4');
    expect(history).toHaveBeenCalledWith(AUTH.tenant_id, 'TENANT', null);
  });

  it('history CLIENT with no scope_ref → 422 SCOPE_REF_REQUIRED', async () => {
    const { controller, history } = make(() => true);
    await expect(controller.history('CLIENT', undefined, AUTH, 'r5')).rejects.toMatchObject({
      context: { details: { reason: 'SCOPE_REF_REQUIRED' } },
    });
    expect(history).not.toHaveBeenCalled();
  });

  it('history invalid scope → 422 INVALID_SCOPE', async () => {
    const { controller } = make(() => true);
    await expect(controller.history('X', undefined, AUTH, 'r6')).rejects.toMatchObject({
      context: { details: { reason: 'INVALID_SCOPE' } },
    });
  });
});

describe('PA-2c — Pre-Start read endpoints (ownership + scope)', () => {
  function make(isClient: (id: string) => boolean) {
    const resolveEffectiveView = vi.fn().mockResolvedValue(null);
    const readLayers = vi.fn().mockResolvedValue({ tenant: {}, client: null, requisition: null, effective: null });
    const history = vi.fn().mockResolvedValue([]);
    const isClientCompany = vi.fn(({ company_id }: { company_id: string }) => Promise.resolve(isClient(company_id)));
    const controller = new PreStartRequirementController(
      { resolveEffectiveView, readLayers, history } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { isClientCompany } as never,
    );
    return { controller, resolveEffectiveView, readLayers, history, isClientCompany };
  }

  it('effective for an OWNED client delegates with client_id', async () => {
    const { controller, resolveEffectiveView, isClientCompany } = make(() => true);
    await controller.effective(OWNED, undefined, AUTH, 'r1');
    expect(isClientCompany).toHaveBeenCalledWith({ tenant_id: AUTH.tenant_id, company_id: OWNED });
    expect(resolveEffectiveView).toHaveBeenCalledWith(AUTH.tenant_id, { client_id: OWNED, requisition_id: null }, 'r1');
  });

  it('effective for a FOREIGN company → 422 COMPANY_NOT_CLIENT, service NOT called', async () => {
    const { controller, resolveEffectiveView } = make((id) => id !== FOREIGN);
    await expect(controller.effective(FOREIGN, undefined, AUTH, 'r2')).rejects.toMatchObject({
      code: 'PRE_START_REQUIREMENT_INVALID',
      context: { details: { reason: 'COMPANY_NOT_CLIENT' } },
    });
    expect(resolveEffectiveView).not.toHaveBeenCalled();
  });

  it('history TENANT uses tenant_id as the scope_ref', async () => {
    const { controller, history } = make(() => true);
    await controller.history('TENANT', undefined, AUTH, 'r3');
    expect(history).toHaveBeenCalledWith(AUTH.tenant_id, 'TENANT', AUTH.tenant_id);
  });

  it('history CLIENT with an OWNED scope_ref delegates', async () => {
    const { controller, history } = make(() => true);
    await controller.history('CLIENT', OWNED, AUTH, 'r4');
    expect(history).toHaveBeenCalledWith(AUTH.tenant_id, 'CLIENT', OWNED);
  });

  it('history CLIENT with a FOREIGN scope_ref → 422 COMPANY_NOT_CLIENT', async () => {
    const { controller, history } = make((id) => id !== FOREIGN);
    await expect(controller.history('CLIENT', FOREIGN, AUTH, 'r5')).rejects.toMatchObject({
      context: { details: { reason: 'COMPANY_NOT_CLIENT' } },
    });
    expect(history).not.toHaveBeenCalled();
  });

  it('history invalid scope → 422 INVALID_SCOPE', async () => {
    const { controller } = make(() => true);
    await expect(controller.history('NOPE', undefined, AUTH, 'r6')).rejects.toMatchObject({
      context: { details: { reason: 'INVALID_SCOPE' } },
    });
  });
});
