import { describe, it, expect, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';

import { ClientSubmittalPolicyController } from '../../client-submittal-policy/client-submittal-policy.controller.js';

// PA-1 — the Client Submittal read surface (effective provenance / raw layers /
// history). Pure controller-logic proofs: the §27 company-ownership guard and the
// scope validation are exercised directly with stubbed collaborators.

const AUTH = { tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sub: 'user-1' } as unknown as AuthContextType;
const OWNED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FOREIGN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function make(isClient: (id: string) => boolean) {
  const resolveEffectiveView = vi.fn().mockResolvedValue({ requirements: [], layers: [], composite_version: 'v' });
  const readLayers = vi.fn().mockResolvedValue({ tenant: {}, client: null, requisition: null, effective: null });
  const history = vi.fn().mockResolvedValue([]);
  const isClientCompany = vi.fn(({ company_id }: { company_id: string }) => Promise.resolve(isClient(company_id)));
  const controller = new ClientSubmittalPolicyController(
    { resolveEffectiveView, readLayers, history } as never,
    { isClientCompany } as never,
  );
  return { controller, resolveEffectiveView, readLayers, history, isClientCompany };
}

describe('PA-1 — Client Submittal read endpoints (ownership + scope)', () => {
  it('effective for an OWNED client delegates to the annotated view', async () => {
    const { controller, resolveEffectiveView, isClientCompany } = make(() => true);
    const res = await controller.effective(OWNED, undefined, AUTH, 'r1');
    expect(isClientCompany).toHaveBeenCalledWith({ tenant_id: AUTH.tenant_id, company_id: OWNED });
    expect(resolveEffectiveView).toHaveBeenCalledWith(AUTH.tenant_id, { company_id: OWNED, requisition_id: null });
    expect(res.effective).toEqual({ requirements: [], layers: [], composite_version: 'v' });
  });

  it('effective for a FOREIGN company → 422 COMPANY_NOT_CLIENT, service NOT called', async () => {
    const { controller, resolveEffectiveView } = make((id) => id !== FOREIGN);
    await expect(controller.effective(FOREIGN, undefined, AUTH, 'r2')).rejects.toMatchObject({
      code: 'CLIENT_SUBMITTAL_POLICY_INVALID',
      statusCode: 422,
      context: { details: { reason: 'COMPANY_NOT_CLIENT' } },
    });
    expect(resolveEffectiveView).not.toHaveBeenCalled();
  });

  it('effective tenant-only (no company_id) skips the ownership check', async () => {
    const { controller, resolveEffectiveView, isClientCompany } = make(() => true);
    await controller.effective(undefined, undefined, AUTH, 'r3');
    expect(isClientCompany).not.toHaveBeenCalled();
    expect(resolveEffectiveView).toHaveBeenCalledWith(AUTH.tenant_id, { company_id: null, requisition_id: null });
  });

  it('layers for a FOREIGN company → 422, service NOT called', async () => {
    const { controller, readLayers } = make((id) => id !== FOREIGN);
    await expect(controller.layers(FOREIGN, undefined, AUTH, 'r4')).rejects.toMatchObject({
      code: 'CLIENT_SUBMITTAL_POLICY_INVALID',
      statusCode: 422,
    });
    expect(readLayers).not.toHaveBeenCalled();
  });

  it('history TENANT scope delegates with a null scope_ref', async () => {
    const { controller, history, isClientCompany } = make(() => true);
    await controller.history('TENANT', undefined, AUTH, 'r5');
    expect(isClientCompany).not.toHaveBeenCalled();
    expect(history).toHaveBeenCalledWith(AUTH.tenant_id, 'TENANT', null);
  });

  it('history CLIENT scope with no scope_ref → 422 SCOPE_REF_REQUIRED', async () => {
    const { controller, history } = make(() => true);
    await expect(controller.history('CLIENT', undefined, AUTH, 'r6')).rejects.toMatchObject({
      code: 'CLIENT_SUBMITTAL_POLICY_INVALID',
      statusCode: 422,
      context: { details: { reason: 'SCOPE_REF_REQUIRED' } },
    });
    expect(history).not.toHaveBeenCalled();
  });

  it('history CLIENT scope with a FOREIGN scope_ref → 422 COMPANY_NOT_CLIENT', async () => {
    const { controller, history } = make((id) => id !== FOREIGN);
    await expect(controller.history('CLIENT', FOREIGN, AUTH, 'r7')).rejects.toMatchObject({
      code: 'CLIENT_SUBMITTAL_POLICY_INVALID',
      context: { details: { reason: 'COMPANY_NOT_CLIENT' } },
    });
    expect(history).not.toHaveBeenCalled();
  });

  it('history CLIENT scope with an OWNED scope_ref delegates', async () => {
    const { controller, history } = make(() => true);
    await controller.history('CLIENT', OWNED, AUTH, 'r8');
    expect(history).toHaveBeenCalledWith(AUTH.tenant_id, 'CLIENT', OWNED);
  });

  it('history invalid scope → 422 INVALID_SCOPE', async () => {
    const { controller, history } = make(() => true);
    await expect(controller.history('NONSENSE', undefined, AUTH, 'r9')).rejects.toMatchObject({
      code: 'CLIENT_SUBMITTAL_POLICY_INVALID',
      context: { details: { reason: 'INVALID_SCOPE' } },
    });
    expect(history).not.toHaveBeenCalled();
  });
});
