import { describe, expect, it, vi } from 'vitest';

import { RoleBundleValidator } from '../lib/tenant-user/role-bundle-validator.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

// Settings S3a — RoleBundleValidator unit proofs.
//
// The load-bearing D5 integrity gate at invite-time. assertNonInvertibleBundle
// (libs/field-masking) proves the math; this wrapper proves the integration:
//   - empty / single-role inputs are no-ops (no DB call, no throw)
//   - multi-role inputs whose UNION is non-invertible pass
//   - multi-role inputs whose UNION holds compensation:view:pay + a spread
//     scope are rejected with VALIDATION_ERROR (reason='invertible_role_union')
//   - the see-all-tier bypass: assigning a see-all role alongside any others
//     is allowed (D5 invariant exception)

const REQUEST_ID = 'test-rq-001';

function makePrismaWithRoles(
  rolesByKey: Record<string, readonly string[]>,
): { prisma: PrismaService; findMany: ReturnType<typeof vi.fn> } {
  const findMany = vi.fn().mockImplementation(
    async (args: { where: { key: { in: string[] } } }) => {
      return args.where.key.in
        .filter((k) => k in rolesByKey)
        .map((k) => ({
          id: `role-${k}`,
          key: k,
          role_scopes: (rolesByKey[k] ?? []).map((scopeKey) => ({
            scope: { key: scopeKey },
          })),
        }));
    },
  );
  const prisma = {
    role: { findMany },
  } as unknown as PrismaService;
  return { prisma, findMany };
}

describe('RoleBundleValidator.assertUnionNonInvertible', () => {
  it('empty role_keys → no-op, no DB call', async () => {
    const { prisma, findMany } = makePrismaWithRoles({});
    const validator = new RoleBundleValidator(prisma);
    await validator.assertUnionNonInvertible({
      role_keys: [],
      request_id: REQUEST_ID,
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('single role_keys → no-op (single bundles proven at seed time)', async () => {
    const { prisma, findMany } = makePrismaWithRoles({
      recruiter: ['recruiter:talent:read'],
    });
    const validator = new RoleBundleValidator(prisma);
    await validator.assertUnionNonInvertible({
      role_keys: ['recruiter'],
      request_id: REQUEST_ID,
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('multi-role non-invertible union → passes (no spread held)', async () => {
    const { prisma } = makePrismaWithRoles({
      recruiter: ['recruiter:talent:read', 'recruiter:requisition:read'],
      sourcer: ['sourcer:talent:create', 'sourcer:requisition:read'],
    });
    const validator = new RoleBundleValidator(prisma);
    await expect(
      validator.assertUnionNonInvertible({
        role_keys: ['recruiter', 'sourcer'],
        request_id: REQUEST_ID,
      }),
    ).resolves.not.toThrow();
  });

  it('multi-role INVERTIBLE union (pay + spread) → VALIDATION_ERROR', async () => {
    // The D5-leak shape: one role grants view:pay, another grants any spread
    // scope (here view:spread:amount); their union reconstructs bill, which
    // is the leak D5 closes. The validator must reject.
    const { prisma } = makePrismaWithRoles({
      finance_view_pay: ['compensation:view:pay'],
      finance_view_spread: ['compensation:view:spread:amount'],
    });
    const validator = new RoleBundleValidator(prisma);
    const promise = validator.assertUnionNonInvertible({
      role_keys: ['finance_view_pay', 'finance_view_spread'],
      request_id: REQUEST_ID,
    });
    await expect(promise).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    });
    await expect(promise).rejects.toMatchObject({
      context: {
        requestId: REQUEST_ID,
        details: {
          reason: 'invertible_role_union',
          role_keys: ['finance_view_pay', 'finance_view_spread'],
        },
      },
    });
  });

  it('multi-role INVERTIBLE union but see-all role present → BYPASS (D5 exception)', async () => {
    // tenant_admin holds view:pay + every spread BY DESIGN. Assigning
    // tenant_admin alongside another role unions into a "would-be-invertible"
    // set, but the see-all bypass exempts this combination from the check.
    const { prisma } = makePrismaWithRoles({
      tenant_admin: [
        'compensation:view:pay',
        'compensation:view:spread:amount',
        'compensation:view:spread:percent',
        'compensation:view:margin:percent',
        'compensation:view:bill',
        'compensation:view:revenue',
      ],
      recruiter: ['recruiter:talent:read'],
    });
    const validator = new RoleBundleValidator(prisma);
    await expect(
      validator.assertUnionNonInvertible({
        role_keys: ['tenant_admin', 'recruiter'],
        request_id: REQUEST_ID,
      }),
    ).resolves.not.toThrow();
  });

  it('duplicate role_keys deduplicated before union math', async () => {
    const { prisma, findMany } = makePrismaWithRoles({
      recruiter: ['recruiter:talent:read'],
      sourcer: ['sourcer:talent:create'],
    });
    const validator = new RoleBundleValidator(prisma);
    await validator.assertUnionNonInvertible({
      role_keys: ['recruiter', 'recruiter', 'sourcer'],
      request_id: REQUEST_ID,
    });
    // findMany called once; the where.key.in must contain unique keys.
    const args = findMany.mock.calls[0]?.[0] as {
      where: { key: { in: string[] } };
    };
    expect(args.where.key.in.sort()).toEqual(['recruiter', 'sourcer']);
  });
});
