import { AramoError } from '@aramo/common';

// ROLES-1 PR-1 (Aramo-ROLES-1 Implementation Directive v1.0 LOCKED §4).
//
// The organization owner role key. Owner-only acts and the last-owner invariant key on it.
export const TENANT_OWNER_ROLE_KEY = 'tenant_owner';

// §4.1 — the marker the DB trigger `identity.roles1_assert_tenant_keeps_owner` raises
// (migration 20261021120100_roles1_last_owner_invariant). The trigger is the authority; this
// module only translates its refusal into the governed 409 so the API never returns a raw 500.
export const TENANT_LAST_OWNER_DB_MARKER = 'tenant_last_owner';

// Prisma 7 + the PrismaPg driver adapter surface a raised trigger exception with the database
// message in `.message` and/or in `meta` (shape varies by call path), so both are searched.
function dbErrorText(err: unknown): string {
  const parts: string[] = [];
  if (err instanceof Error && typeof err.message === 'string') parts.push(err.message);
  const anyErr = err as { meta?: unknown; cause?: unknown } | null;
  try {
    parts.push(JSON.stringify(anyErr?.meta ?? {}));
  } catch {
    /* non-serialisable meta */
  }
  const cause = anyErr?.cause as { message?: unknown } | undefined;
  if (cause !== undefined && typeof cause?.message === 'string') parts.push(cause.message);
  return parts.join(' | ');
}

/** True when `err` is the DB last-owner invariant refusal. */
export function isTenantLastOwnerViolation(err: unknown): boolean {
  if (err === null || typeof err !== 'object' || err instanceof AramoError) return false;
  return dbErrorText(err).includes(TENANT_LAST_OWNER_DB_MARKER);
}

/**
 * Rethrow the DB last-owner refusal as 409 TENANT_LAST_OWNER; rethrow anything else unchanged.
 * The whole transaction was rolled back by the database, so the write had no effect.
 */
export function rethrowTenantLastOwner(
  err: unknown,
  ctx: { request_id?: string; tenant_id?: string; operation: string },
): never {
  if (isTenantLastOwnerViolation(err)) {
    throw new AramoError(
      'TENANT_LAST_OWNER',
      'The organization must keep at least one active owner',
      409,
      {
        requestId: ctx.request_id ?? 'identity.last_owner',
        details: {
          reason: 'last_owner',
          operation: ctx.operation,
          ...(ctx.tenant_id === undefined ? {} : { tenant_id: ctx.tenant_id }),
        },
      },
    );
  }
  throw err;
}
