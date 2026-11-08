import { AramoError } from '@aramo/common';

import type { PrismaClient } from '../../../prisma/generated/client/client.js';

// Aramo Sign Business Per-Seat Pricing, Implementation Directive v1.0 (LOCKED) §3.2 (S-3, S-4, O-6, O-7).
//
//   seat        an ACTIVE, ACCEPTED member of the tenant (is_active, not deactivated, invite_status
//               ACCEPTED or ACTIVE) holding Sign send access: a Sign role that sends (sign_admin,
//               sign_sender) or an organization role (tenant_owner, tenant_admin — ADR-0035 R1). A pending
//               invite, a viewer and a signer never take a seat. The owner is a seat (O-7).
//   limit       the purchased seats of a tenant whose current subscription is priced per seat. libs/identity
//               never reads billing: the limit comes through SeatLimitPort, which the apps (apps/api,
//               platform-admin) implement with libs/subscription. No port bound = no limit.
//   enforcement adding a person who would hold Sign send access while every purchased seat is in use is
//               refused 409 seat_limit_reached { used, purchased }: an invite, a role grant, a re-enable
//               and a platform-console invite. The identity transaction locks the tenant row FOR UPDATE
//               first (as the Personal single-user guard), so two concurrent additions serialize.
//   release     removing a member or their Sign access frees the seat at once (O-6): it is a count.

export const SEAT_LIMIT_PORT = 'SEAT_LIMIT_PORT';

/** The roles that hold Sign send access (S-4). */
export const SIGN_SEAT_ROLE_KEYS: readonly string[] = ['sign_admin', 'sign_sender', 'tenant_owner', 'tenant_admin'];

export const SEAT_LIMIT_REACHED_REASON = 'seat_limit_reached';

export type SeatLimitTx = Pick<PrismaClient, '$queryRaw'>;

export type SeatLimitCheck = { limited: false } | { limited: true; used: number; purchased: number };

export interface SeatLimitPort {
  /** The tenant's seat limit and current seat count, read inside the caller's identity transaction. */
  check(tenant_id: string, tx: SeatLimitTx): Promise<SeatLimitCheck>;
}

export function holdsSignSendAccess(role_keys: readonly string[]): boolean {
  return role_keys.some((k) => SIGN_SEAT_ROLE_KEYS.includes(k));
}

/** S-4 — the tenant's seats in use (active, accepted members holding Sign send access). */
export async function countSignSeatsTx(tx: SeatLimitTx, tenant_id: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ n: number }>>`
    SELECT count(DISTINCT m."id")::int AS n
      FROM "identity"."UserTenantMembership" m
      JOIN "identity"."UserTenantMembershipRole" mr ON mr."membership_id" = m."id"
      JOIN "identity"."Role" r ON r."id" = mr."role_id"
     WHERE m."tenant_id" = ${tenant_id}::uuid
       AND m."is_active" = true
       AND m."deactivated_at" IS NULL
       AND m."invite_status" IN ('ACCEPTED', 'ACTIVE')
       AND r."is_active" = true
       AND r."key" IN ('sign_admin', 'sign_sender', 'tenant_owner', 'tenant_admin')`;
  return rows[0]?.n ?? 0;
}

export class SeatLimitReachedError extends Error {
  constructor(
    readonly used: number,
    readonly purchased: number,
  ) {
    super('All purchased seats are in use');
    this.name = 'SeatLimitReachedError';
  }
}

/** The governed refusal (the Sign billing conflict code, as the store seat refusal). */
export function seatLimitReachedError(request_id: string, used: number, purchased: number): AramoError {
  return new AramoError('ESIGN_BILLING_CONFLICT', `All ${purchased} seats are in use. Add a seat to invite more people.`, 409, {
    requestId: request_id,
    details: { reason: SEAT_LIMIT_REACHED_REASON, used, purchased },
  });
}

/**
 * The in-transaction guard: lock the tenant row, then ask the port. Call only when the change would give a
 * person Sign send access who does not hold a seat now. Throws SeatLimitReachedError at the limit.
 */
export async function assertSeatAvailableTx(tx: SeatLimitTx, tenant_id: string, port: SeatLimitPort): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "identity"."Tenant" WHERE "id" = ${tenant_id}::uuid FOR UPDATE`;
  const r = await port.check(tenant_id, tx);
  if (r.limited && r.used >= r.purchased) throw new SeatLimitReachedError(r.used, r.purchased);
}

/** Maps the guard's error to the governed 409 (other errors pass through). */
export function rethrowSeatLimitReached(err: unknown, request_id: string): void {
  if (err instanceof SeatLimitReachedError) throw seatLimitReachedError(request_id, err.used, err.purchased);
}

/** A guard the identity transactions run first (built by the lifecycle from the port). */
export type SeatGuard = (tx: SeatLimitTx) => Promise<void>;

export function seatGuardOf(port: SeatLimitPort | undefined, tenant_id: string): SeatGuard | undefined {
  return port === undefined ? undefined : (tx) => assertSeatAvailableTx(tx, tenant_id, port);
}
