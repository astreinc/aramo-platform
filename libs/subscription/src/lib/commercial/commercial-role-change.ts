import { createHash } from 'node:crypto';

import { v7 as uuidv7 } from 'uuid';

import type { PrismaService } from '../prisma/prisma.service.js';

// CCP-A9 (PBD §5.1 row A9; Inc-1 Closure Amendment A1 A1-3; T2-F1-H3 Amendment A1 A1-2,
// A1-4) — the identity-side writes of a platform role change, run inside the CALLER's
// subscription transaction as raw cross-schema SQL (the TD-A3-4 precedent: no
// @aramo/identity import, so no nx edge). Two callers only:
//   - the governed ROLE_GRANT / ROLE_REVOKE apply (CommercialChangeRequestService), and
//   - the single D7 bootstrap command (commercial-platform-owner-bootstrap.ts).
// Every role write bumps the subject's AuthorizationVersion in the same transaction (the
// HF-AUTH-1 rule every identity role write follows). The last-effective-platform_owner
// trigger (identity migration 20261025180000) is the DB authority for removals.

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];
type Client = PrismaService | Tx;

export const PLATFORM_OWNER_ROLE_KEY = 'platform_owner';

/** The DB marker raised by identity.ccp_a9_assert_platform_keeps_owner(). */
export const PLATFORM_LAST_OWNER_DB_MARKER = 'platform_last_owner';

export type RoleChangeApplyReason = 'SUBJECT_NOT_PLATFORM_MEMBER' | 'ROLE_NOT_IN_CATALOG' | 'ROLE_ALREADY_HELD' | 'ROLE_NOT_HELD' | 'PLATFORM_LAST_OWNER' | 'ATTESTATION_CONFLICT';

export class RoleChangeApplyError extends Error {
  constructor(
    readonly reason: RoleChangeApplyReason,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(`role change not applied (${reason})`);
    this.name = 'RoleChangeApplyError';
  }
}

function errorText(err: unknown): string {
  const parts: string[] = [];
  if (err instanceof Error) parts.push(err.message);
  const e = err as { meta?: unknown; cause?: { message?: unknown } } | null;
  try {
    parts.push(JSON.stringify(e?.meta ?? {}));
  } catch {
    /* non-serialisable meta */
  }
  if (typeof e?.cause?.message === 'string') parts.push(e.cause.message);
  return parts.join(' | ');
}

/** True when `err` is the DB last-effective-platform_owner refusal. */
export function isPlatformLastOwnerViolation(err: unknown): boolean {
  if (err === null || typeof err !== 'object' || err instanceof RoleChangeApplyError) return false;
  return errorText(err).includes(PLATFORM_LAST_OWNER_DB_MARKER);
}

export interface PlatformSubjectFacts {
  user_id: string;
  /** An active User with an active membership in the platform sentinel tenant. */
  is_platform_member: boolean;
  membership_id: string | null;
  role_keys: string[];
  /** The active D9 attestation id, or null. */
  attestation_id: string | null;
}

/** The subject's live platform membership, roles and attestation (lock the membership row with `lock`). */
export async function readPlatformSubject(client: Client, platform_tenant_id: string, user_id: string, lock = false): Promise<PlatformSubjectFacts> {
  const m = await client.$queryRawUnsafe<Array<{ membership_id: string }>>(
    `SELECT m.id::text AS membership_id FROM identity."UserTenantMembership" m JOIN identity."User" u ON u.id = m.user_id AND u.is_active
      WHERE m.user_id = $1::uuid AND m.tenant_id = $2::uuid AND m.is_active${lock ? ' FOR UPDATE OF m' : ''}`,
    user_id,
    platform_tenant_id,
  );
  const membership_id = m[0]?.membership_id ?? null;
  const roles =
    membership_id === null
      ? []
      : await client.$queryRawUnsafe<Array<{ key: string }>>(
          `SELECT r.key FROM identity."UserTenantMembershipRole" mr JOIN identity."Role" r ON r.id = mr.role_id WHERE mr.membership_id = $1::uuid ORDER BY r.key`,
          membership_id,
        );
  const att = await client.commercialOperatorAttestation.findFirst({ where: { user_id, revoked_at: null }, select: { id: true } });
  return { user_id, is_platform_member: membership_id !== null, membership_id, role_keys: roles.map((r) => r.key), attestation_id: att?.id ?? null };
}

/** Effective platform_owner holders (A1-4 definition): active User, active sentinel membership, platform_owner. */
export async function effectivePlatformOwners(client: Client, platform_tenant_id: string): Promise<string[]> {
  const rows = await client.$queryRawUnsafe<Array<{ user_id: string }>>(
    `SELECT DISTINCT m.user_id::text AS user_id
       FROM identity."UserTenantMembershipRole" mr
       JOIN identity."UserTenantMembership" m ON m.id = mr.membership_id AND m.is_active
       JOIN identity."User" u ON u.id = m.user_id AND u.is_active
       JOIN identity."Role" r ON r.id = mr.role_id
      WHERE m.tenant_id = $1::uuid AND r.key = $2
      ORDER BY 1`,
    platform_tenant_id,
    PLATFORM_OWNER_ROLE_KEY,
  );
  return rows.map((r) => r.user_id);
}

async function roleIdOf(client: Client, role_key: string): Promise<string> {
  const rows = await client.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text AS id FROM identity."Role" WHERE key = $1 AND is_active`, role_key);
  const id = rows[0]?.id;
  if (id === undefined) throw new RoleChangeApplyError('ROLE_NOT_IN_CATALOG', { role_key });
  return id;
}

/** HF-AUTH-1: baseline (absent) → 2; present → +1. */
async function bumpAuthorizationVersion(client: Client, tenant_id: string, principal_id: string): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO identity."AuthorizationVersion" (id, tenant_id, principal_id, version, updated_at) VALUES ($1::uuid, $2::uuid, $3::uuid, 2, now())
     ON CONFLICT (tenant_id, principal_id) DO UPDATE SET version = identity."AuthorizationVersion".version + 1, updated_at = now()`,
    uuidv7(),
    tenant_id,
    principal_id,
  );
}

/** A deterministic membership-role id (the bootstrap's "stable, deterministic id", A1-2(4)). */
export function deterministicMembershipRoleId(seed: string): string {
  const h = createHash('sha256').update(seed, 'utf8').digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Grants `role_key` on the subject's sentinel membership. Throws RoleChangeApplyError when
 * the subject is not a platform member or already holds the role. With `id`, the row id is
 * that value and an existing row is left untouched (`update: {}` semantics).
 */
export async function grantPlatformRole(tx: Tx, platform_tenant_id: string, input: { user_id: string; role_key: string; id?: string }): Promise<{ membership_role_id: string }> {
  const subject = await readPlatformSubject(tx, platform_tenant_id, input.user_id, true);
  if (!subject.is_platform_member || subject.membership_id === null) throw new RoleChangeApplyError('SUBJECT_NOT_PLATFORM_MEMBER', { user_id: input.user_id });
  if (subject.role_keys.includes(input.role_key)) throw new RoleChangeApplyError('ROLE_ALREADY_HELD', { user_id: input.user_id, role_key: input.role_key });
  const role_id = await roleIdOf(tx, input.role_key);
  const id = input.id ?? uuidv7();
  await tx.$executeRawUnsafe(
    `INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id, created_at) VALUES ($1::uuid, $2::uuid, $3::uuid, now()) ON CONFLICT (membership_id, role_id) DO NOTHING`,
    id,
    subject.membership_id,
    role_id,
  );
  await bumpAuthorizationVersion(tx, platform_tenant_id, input.user_id);
  return { membership_role_id: id };
}

/** Removes `role_key` from the subject's sentinel membership; the DB last-owner trigger is the authority. */
export async function revokePlatformRole(tx: Tx, platform_tenant_id: string, input: { user_id: string; role_key: string }): Promise<{ membership_role_id: string }> {
  const subject = await readPlatformSubject(tx, platform_tenant_id, input.user_id, true);
  if (!subject.is_platform_member || subject.membership_id === null) throw new RoleChangeApplyError('SUBJECT_NOT_PLATFORM_MEMBER', { user_id: input.user_id });
  const role_id = await roleIdOf(tx, input.role_key);
  const removed = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `DELETE FROM identity."UserTenantMembershipRole" WHERE membership_id = $1::uuid AND role_id = $2::uuid RETURNING id::text AS id`,
    subject.membership_id,
    role_id,
  );
  const row = removed[0];
  if (row === undefined) throw new RoleChangeApplyError('ROLE_NOT_HELD', { user_id: input.user_id, role_key: input.role_key });
  await bumpAuthorizationVersion(tx, platform_tenant_id, input.user_id);
  return { membership_role_id: row.id };
}
