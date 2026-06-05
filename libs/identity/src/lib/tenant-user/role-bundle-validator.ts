import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { assertNonInvertibleBundle } from '@aramo/field-masking';

import { PrismaService } from '../prisma/prisma.service.js';

// Settings S3a — RoleBundleValidator (the shared D5 integrity check).
//
// The load-bearing gate against UNIONED role bundles. AssertNonInvertibleBundle
// (libs/field-masking) proves a SINGLE role's scope-set cannot reconstruct pay
// from spread arithmetic. The S3 case is harder: a user may hold MULTIPLE roles
// (UserTenantMembership.role_assignments is many-to-many), so a tenant_admin
// could assign two individually-safe roles whose UNION is invertible (one role
// granting compensation:view:pay, another granting a spread scope) — re-opening
// the leak D5 closed.
//
// This validator runs at the controller boundary BEFORE any membership-write:
// at INVITE (when role_keys.length >= 2) and (S3b, follow-on PR) at role-assign.
// Both call this same surface so the D5 boundary is enforced in exactly one
// place. The non-invertibility math itself stays where it belongs (libs/field-
// masking — the single owner); this lib is a thin consumer.
//
// The see-all tier (tenant_admin / tenant_owner / super_admin) holds pay + every
// spread scope BY DESIGN — the D5 invariant exempts them via the {seeAll:true}
// bypass. If any requested role is in the see-all tier, the union is allowed to
// hold both halves (because the bundle is intentionally see-all). When no see-
// all role is in the set, the union must satisfy the non-invertibility check.
//
// Surface failures as VALIDATION_ERROR 400 so the caller sees a structured
// rejection (the S2 per-key-validator precedent). The error details carry the
// offending role_keys + the colliding scope_keys so the caller can self-correct.

export const SEE_ALL_ROLE_KEYS: ReadonlySet<string> = new Set([
  'tenant_admin',
  'tenant_owner',
  'super_admin',
]);

@Injectable()
export class RoleBundleValidator {
  constructor(private readonly prisma: PrismaService) {}

  // Asserts that the UNION of scope-keys across the given role-keys is non-
  // invertible (or that the set contains a see-all-tier role, which bypasses
  // by design). Throws VALIDATION_ERROR on violation. No-op when role_keys
  // is empty or a single non-see-all role (assertNonInvertibleBundle has
  // already been proven over single-role bundles at seed time).
  async assertUnionNonInvertible(args: {
    role_keys: readonly string[];
    request_id: string;
  }): Promise<void> {
    if (args.role_keys.length < 2) return;

    const distinctKeys = [...new Set(args.role_keys)];
    const seeAll = distinctKeys.some((k) => SEE_ALL_ROLE_KEYS.has(k));

    const roles = await this.prisma.role.findMany({
      where: { key: { in: distinctKeys }, is_active: true },
      include: {
        role_scopes: {
          include: { scope: { select: { key: true } } },
        },
      },
    });

    const unionScopes = new Set<string>();
    for (const role of roles) {
      for (const rs of role.role_scopes) {
        unionScopes.add(rs.scope.key);
      }
    }

    try {
      assertNonInvertibleBundle(
        `composite:${distinctKeys.slice().sort().join('+')}`,
        unionScopes,
        { seeAll },
      );
    } catch (err) {
      throw new AramoError(
        'VALIDATION_ERROR',
        `role bundle union violates D5 non-invertibility`,
        400,
        {
          requestId: args.request_id,
          details: {
            reason: 'invertible_role_union',
            role_keys: distinctKeys,
            cause: (err as Error).message,
          },
        },
      );
    }
  }
}
