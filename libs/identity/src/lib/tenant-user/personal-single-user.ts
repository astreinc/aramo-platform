import type { PrismaClient } from '../../../prisma/generated/client/client.js';

// Sign Personal is single-user (PO 2026-11-02: "Single user only. Price is per
// user"). A PERSONAL tenant holds exactly one membership — its owner, created by
// the self-service signup — and no runtime path may add a second one (tenant
// invite, platform-console invite, or any later writer).
//
// Two layers, mirroring the platform-role guard:
//   - the callers refuse early (before any Cognito side effect) with
//     personalTenantSeatTaken(), a plain read;
//   - the identity transactions call assertPersonalSeatFreeTx() FIRST, which
//     locks the tenant row (FOR UPDATE) so two concurrent invites into the same
//     PERSONAL tenant serialize, then re-counts. This is the authoritative
//     backstop; it throws PersonalTenantSeatTakenError, which the service maps
//     to the governed 400.
//
// A BUSINESS tenant is never affected. Every membership counts, whatever its
// status (an INVITED or disabled member still occupies the seat).

export const PERSONAL_SINGLE_USER_REASON = 'personal_single_user';

export class PersonalTenantSeatTakenError extends Error {
  constructor(readonly tenant_id: string) {
    super('A Personal account has a single user');
    this.name = 'PersonalTenantSeatTakenError';
  }
}

type SeatReadClient = Pick<PrismaClient, '$queryRaw'>;

// Read-only pre-check: true when the tenant is PERSONAL and already has a membership.
export async function personalTenantSeatTaken(db: SeatReadClient, tenant_id: string): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ taken: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM "identity"."UserTenantMembership" m WHERE m."tenant_id" = t."id") AS taken
      FROM "identity"."Tenant" t
     WHERE t."id" = ${tenant_id}::uuid AND t."kind" = 'PERSONAL'`;
  return rows[0]?.taken === true;
}

// In-transaction backstop: lock the tenant row, then re-check. Call before the membership insert.
export async function assertPersonalSeatFreeTx(tx: SeatReadClient, tenant_id: string): Promise<void> {
  const locked = await tx.$queryRaw<Array<{ kind: string }>>`
    SELECT "kind" FROM "identity"."Tenant" WHERE "id" = ${tenant_id}::uuid FOR UPDATE`;
  if (locked[0]?.kind !== 'PERSONAL') return;
  if (await personalTenantSeatTaken(tx, tenant_id)) throw new PersonalTenantSeatTakenError(tenant_id);
}
