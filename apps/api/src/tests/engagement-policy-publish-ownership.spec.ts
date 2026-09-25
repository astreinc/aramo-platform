import { describe, it, expect, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';

import { EngagementController } from '../engagement/engagement.controller.js';

// CSP PR-5 — the CLIENT-scope ownership retrofit on the engagement publish route.
// A CLIENT-scoped engagement policy must target a company the tenant OWNS as a
// CLIENT, verified through the SAME CompanyClientCheckPort seam pre-start +
// client-submittal use. These are pure controller-logic proofs (no DB): the
// ownership branch is exercised directly with stubbed collaborators.

const AUTH = { tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sub: 'user-1' } as unknown as AuthContextType;
const COMPANY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function makeController(isClient: boolean) {
  const publish = vi.fn().mockResolvedValue({ id: 'v1' });
  const isClientCompany = vi.fn().mockResolvedValue(isClient);
  const controller = new EngagementController(
    { publish } as never,
    {} as never,
    { isClientCompany } as never,
  );
  return { controller, publish, isClientCompany };
}

const baseDto = {
  version: '1.0.0',
  schema_version: 1,
  requirements: [],
} as never;

describe('CSP PR-5 — engagement CLIENT-scope publish ownership guard', () => {
  it('CLIENT scope with NO scope_ref → 422 SCOPE_REF_REQUIRED, publish NOT called', async () => {
    const { controller, publish, isClientCompany } = makeController(true);
    await expect(
      controller.publish({ ...(baseDto as object), scope: 'CLIENT' } as never, AUTH, 'r1'),
    ).rejects.toMatchObject({
      code: 'ENGAGEMENT_POLICY_SCHEMA_INVALID',
      statusCode: 422,
      context: { details: { reason: 'SCOPE_REF_REQUIRED' } },
    });
    expect(isClientCompany).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('CLIENT scope, scope_ref NOT owned as a client → 422 COMPANY_NOT_CLIENT, publish NOT called', async () => {
    const { controller, publish, isClientCompany } = makeController(false);
    await expect(
      controller.publish({ ...(baseDto as object), scope: 'CLIENT', scope_ref: COMPANY } as never, AUTH, 'r2'),
    ).rejects.toMatchObject({
      code: 'ENGAGEMENT_POLICY_SCHEMA_INVALID',
      statusCode: 422,
      context: { details: { reason: 'COMPANY_NOT_CLIENT', scope_ref: COMPANY } },
    });
    expect(isClientCompany).toHaveBeenCalledWith({ tenant_id: AUTH.tenant_id, company_id: COMPANY });
    expect(publish).not.toHaveBeenCalled();
  });

  it('CLIENT scope, scope_ref OWNED → ownership verified then publish delegated', async () => {
    const { controller, publish, isClientCompany } = makeController(true);
    const res = await controller.publish(
      { ...(baseDto as object), scope: 'CLIENT', scope_ref: COMPANY } as never,
      AUTH,
      'r3',
    );
    expect(isClientCompany).toHaveBeenCalledWith({ tenant_id: AUTH.tenant_id, company_id: COMPANY });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ published: { id: 'v1' } });
  });

  it('TENANT scope → ownership check NOT invoked (parity floor: non-CLIENT scopes untouched)', async () => {
    const { controller, publish, isClientCompany } = makeController(true);
    await controller.publish({ ...(baseDto as object), scope: 'TENANT' } as never, AUTH, 'r4');
    expect(isClientCompany).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
