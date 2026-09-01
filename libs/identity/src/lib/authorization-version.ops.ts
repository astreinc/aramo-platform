import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '../../prisma/generated/client/client.js';

// HF-AUTH-1 — standalone authorization-version bump operations.
//
// These are FUNCTIONS (not an injected service) on purpose: the runtime authz
// mutations live in IdentityRepository, whose `$transaction` blocks must bump the
// version ATOMICALLY with the grant/membership change. Threading a new DI
// dependency through IdentityRepository would ripple its constructor into ~17
// `new IdentityRepository(prisma)` test sites (the ctor-dep ripple). Instead the
// repository calls these with its live tx client, so the bump commits in the same
// transaction with zero constructor change. `AuthorizationVersionService` wraps
// the same functions for callers that resolve it via DI (the resolver, the seed).
//
// Semantics: implicit baseline = 1; the first bump of a baseline principal lands
// at 2 (create version:2), so a bumped version is always DISTINCT from the
// baseline any outstanding token could carry.

// The minimal client surface the ops need. `Pick` off the real PrismaClient keeps
// the genuine Prisma delegate types (so `select` narrows the return shape) while
// accepting BOTH a full PrismaService and an interactive-transaction client — the
// tx client retains every model delegate, so it satisfies this Pick.
export type AuthzVersionTx = Pick<PrismaClient, 'authorizationVersion' | 'userTenantMembership'>;

// Establish the baseline row at principal/membership birth. Idempotent no-op if a
// row already exists — never rewinds a bumped version.
export async function ensureBaselineVersion(
  tx: AuthzVersionTx,
  args: { tenant_id: string; principal_id: string },
): Promise<void> {
  await tx.authorizationVersion.upsert({
    where: {
      tenant_id_principal_id: { tenant_id: args.tenant_id, principal_id: args.principal_id },
    },
    create: { id: randomUUID(), tenant_id: args.tenant_id, principal_id: args.principal_id, version: 1 },
    update: {},
  });
}

// Bump ONE principal's version. Baseline (absent) → 2; present → +1. Returns the
// new version.
export async function bumpPrincipalVersion(
  tx: AuthzVersionTx,
  args: { tenant_id: string; principal_id: string },
): Promise<number> {
  const row = await tx.authorizationVersion.upsert({
    where: {
      tenant_id_principal_id: { tenant_id: args.tenant_id, principal_id: args.principal_id },
    },
    create: { id: randomUUID(), tenant_id: args.tenant_id, principal_id: args.principal_id, version: 2 },
    update: { version: { increment: 1 } },
    select: { version: true },
  });
  return row.version;
}

// Bump EVERY principal whose ACTIVE membership assigns `role_id` — the fan-out a
// RoleScope grant add/remove or a role activate/deactivate requires, since one
// catalog change alters every holder's effective scopes. Scoped by (tenant, user)
// so each principal's version moves independently and stays tenant-isolated.
export async function bumpPrincipalsWithRoleVersion(
  tx: AuthzVersionTx,
  args: { role_id: string },
): Promise<number> {
  const holders = await tx.userTenantMembership.findMany({
    where: { is_active: true, role_assignments: { some: { role_id: args.role_id } } },
    select: { tenant_id: true, user_id: true },
  });
  for (const h of holders) {
    await bumpPrincipalVersion(tx, { tenant_id: h.tenant_id, principal_id: h.user_id });
  }
  return holders.length;
}
