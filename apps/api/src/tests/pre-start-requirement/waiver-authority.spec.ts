import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import { RequirementInstanceRepository } from '@aramo/pre-start-requirement';

import { PreStartWaiverService } from '../../pre-start-requirement/pre-start-waiver.service.js';

// Track 3 / E2 — waiver ZERO-GRANT proof (§13c-1). Two INDEPENDENT controls:
//   RBAC:   may this principal attempt to waive THIS requirement? (data-dependent
//           on blocking; blocking -> waive_blocking, which has ZERO default grants)
//   Domain: may this requirement EVER be waived under its FROZEN rule? (NOT_WAIVABLE)
// Neither substitutes for the other. Here the RBAC floor is exercised with real
// seeded-role scope sets (minus the zero-grant scopes no role holds); the domain
// floor is exercised against the real RequirementInstanceRepository.waive.

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const INSTANCE = '00000000-0000-0000-0000-0000000000bb';

// Effective default role scope-sets from the seeded catalog. NONE of the seeded
// roles holds pre_start_requirement:waive_blocking (RoleScope count 0) — the
// fail-closed posture. These lists include every OTHER pre_start_requirement scope
// a role could plausibly hold, to prove the denial is the waive_blocking floor and
// not merely an unrelated missing scope.
const DEFAULT_ROLE_SCOPES: Record<string, string[]> = {
  recruiter: ['pre_start_requirement:read', 'pre_start_requirement:act'],
  account_manager: ['pre_start_requirement:read', 'pre_start_requirement:act', 'pre_start_requirement:waive_advisory'],
  tenant_admin: [
    'pre_start_requirement:read',
    'pre_start_requirement:act',
    'pre_start_requirement:waive_advisory',
    'pre_start_requirement:configure',
    'pre_start_requirement:publish',
  ],
  tenant_owner: [
    'pre_start_requirement:read',
    'pre_start_requirement:act',
    'pre_start_requirement:waive_advisory',
    'pre_start_requirement:configure',
    'pre_start_requirement:publish',
  ],
  auditor: ['pre_start_requirement:read'],
  auditor_with_financials: ['pre_start_requirement:read'],
  // Platform authority must NOT bypass tenant compliance authority.
  super_admin: ['pre_start_requirement:read', 'pre_start_requirement:act', 'pre_start_requirement:configure'],
};

function auth(scopes: string[]) {
  return { sub: 'user-1', tenant_id: TENANT, actor_kind: 'user', scopes } as never;
}

function blockingInstance(waiver_mode: string) {
  return {
    findById: vi.fn().mockResolvedValue({ id: INSTANCE, tenant_id: TENANT, blocking: true, waiver_mode, status: 'PENDING' }),
    waive: vi.fn().mockResolvedValue({ id: INSTANCE, status: 'WAIVED' }),
  };
}

describe('Waiver RBAC floor — waive_blocking has ZERO default grants', () => {
  for (const [role, scopes] of Object.entries(DEFAULT_ROLE_SCOPES)) {
    it(`${role} CANNOT waive a blocking requirement (INSUFFICIENT_PERMISSIONS, before any mutation)`, async () => {
      const repo = blockingInstance('COMPLIANCE_AUTHORITY_ONLY');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new PreStartWaiverService(repo as any);
      await expect(
        svc.waive(auth(scopes), INSTANCE, { authority: 'COMPLIANCE', justification: 'x' }, 'req'),
      ).rejects.toMatchObject({
        code: 'INSUFFICIENT_PERMISSIONS',
        statusCode: 403,
        context: { details: { required_scope: 'pre_start_requirement:waive_blocking' } },
      });
      // The domain mutation was never attempted — RBAC denied first.
      expect(repo.waive).not.toHaveBeenCalled();
    });
  }

  it('a caller WITH waive_blocking passes the RBAC floor and reaches the domain layer', async () => {
    const repo = blockingInstance('COMPLIANCE_AUTHORITY_ONLY');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new PreStartWaiverService(repo as any);
    await svc.waive(
      auth(['pre_start_requirement:act', 'pre_start_requirement:waive_blocking']),
      INSTANCE,
      { authority: 'COMPLIANCE', justification: 'approved by compliance' },
      'req',
    );
    expect(repo.waive).toHaveBeenCalledOnce();
  });
});

describe('Waiver domain floor — NOT_WAIVABLE is unwaivable even WITH waive_blocking', () => {
  it('a caller holding waive_blocking still cannot waive a NOT_WAIVABLE instance', async () => {
    // Real repository, but the DB call is intercepted: the NOT_WAIVABLE refusal
    // is a pure pre-condition in waive() evaluated against the snapshotted mode,
    // so it fires before any Prisma access. We stub findFirst to return a
    // NOT_WAIVABLE row and assert the domain refusal.
    const prisma = {
      preStartRequirementInstance: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: INSTANCE, tenant_id: TENANT, blocking: true, waiver_mode: 'NOT_WAIVABLE', status: 'PENDING' }),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const domain = new RequirementInstanceRepository(prisma as any);
    await expect(
      domain.waive(
        { tenant_id: TENANT, requirement_instance_id: INSTANCE, authority: 'COMPLIANCE', actor_id: 'u', actor_type: 'user', justification: 'try anyway' },
        'req',
      ),
    ).rejects.toMatchObject({
      code: 'PRE_START_REQUIREMENT_INVALID',
      statusCode: 422,
      context: { details: { waiver_mode: 'NOT_WAIVABLE', snapshot_enforced: true } },
    });
  });
});
