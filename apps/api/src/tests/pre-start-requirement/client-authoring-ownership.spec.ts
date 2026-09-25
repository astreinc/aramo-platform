import { describe, it, expect, vi } from 'vitest';

import { PreStartRequirementController } from '../../pre-start-requirement/pre-start-requirement.controller.js';

// CSP PR-1 (§D13) — CLIENT-scope authoring goes through the established
// CompanyClientCheckPort ownership seam (no @aramo/company import). Pure controller
// unit test: only `sets.createDraft` and `clientCheck.isClientCompany` are exercised.

const auth = { tenant_id: 't1', sub: 'u1' } as never;
const baseBody = {
  version: 'v1',
  definitions: [
    { requirement_type: 'BACKGROUND_CHECK', label: 'BG', blocking: true, sequence: 1, waiver_mode: 'NOT_WAIVABLE' },
  ],
} as never;

function make(isClient: boolean) {
  const createDraft = vi.fn().mockResolvedValue({ id: 's1' });
  const sets = { createDraft } as never;
  const clientCheck = { isClientCompany: vi.fn().mockResolvedValue(isClient) };
  const ctrl = new PreStartRequirementController(
    sets,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    clientCheck as never,
  );
  return { ctrl, createDraft, clientCheck };
}

describe('PreStartRequirementController — CLIENT authoring ownership (CSP PR-1 §D13)', () => {
  it('TENANT (default) authors with a server-derived scope_ref_id and no ownership check', async () => {
    const { ctrl, createDraft, clientCheck } = make(true);
    await ctrl.createDraft(auth, 'r', baseBody);
    expect(clientCheck.isClientCompany).not.toHaveBeenCalled();
    expect(createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'TENANT', scope_ref_id: 't1' }),
      'r',
    );
  });

  it('CLIENT with an owned company_id authors a CLIENT set', async () => {
    const { ctrl, createDraft, clientCheck } = make(true);
    await ctrl.createDraft(auth, 'r', { ...(baseBody as object), scope: 'CLIENT', scope_ref_id: 'company-9' } as never);
    expect(clientCheck.isClientCompany).toHaveBeenCalledWith({ tenant_id: 't1', company_id: 'company-9' });
    expect(createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'CLIENT', scope_ref_id: 'company-9' }),
      'r',
    );
  });

  it('CLIENT with a company_id NOT owned by the tenant is rejected 422 (COMPANY_NOT_CLIENT)', async () => {
    const { ctrl, createDraft } = make(false);
    await expect(
      ctrl.createDraft(auth, 'r', { ...(baseBody as object), scope: 'CLIENT', scope_ref_id: 'foreign' } as never),
    ).rejects.toMatchObject({ code: 'PRE_START_REQUIREMENT_INVALID', statusCode: 422 });
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('CLIENT without scope_ref_id is rejected 422', async () => {
    const { ctrl } = make(true);
    await expect(
      ctrl.createDraft(auth, 'r', { ...(baseBody as object), scope: 'CLIENT' } as never),
    ).rejects.toMatchObject({ code: 'PRE_START_REQUIREMENT_INVALID', statusCode: 422 });
  });
});
