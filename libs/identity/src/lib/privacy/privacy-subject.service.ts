import { Injectable } from '@nestjs/common';

import { bumpPrincipalVersion } from '../authorization-version.ops.js';
import { ESIGN_ROLE_KEYS } from '../dto/esign-permissions.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TENANT_OWNER_ROLE_KEY } from '../util/tenant-lifecycle.js';

import { normalizePrivacyEmail } from './privacy-request-crypto.js';

// Aramo-Sign-Mobile-Amendment-M-A7 §3.2 — the identity side of a privacy request:
// who the subject is, and the identity writes a deletion may make:
//   - retireAccountHolder  the Personal account holder's membership and user are
//                          deactivated (only when the M-A8 §3.2
//                          IdentityDependencyInspector found no dependency);
//   - tombstoneRetiredUser M-A8 §3.3 — the retired user's email tombstoned and its
//                          ExternalIdentity rows removed (after identity retirement);
//   - removeSignAccess     a Business member's Sign-only roles are removed; the
//                          organization-wide roles (which also carry other
//                          products) are never touched.
// Every write bumps the principal's authorization version in the same transaction,
// so cached scopes are invalidated immediately. Only tombstoneRetiredUser deletes rows
// (the retired user's ExternalIdentity links).

export interface PrivacySubjectContext {
  user_id: string;
  tenant_id: string;
  email: string;
  user_active: boolean;
  tenant_kind: string;
  tenant_status: string;
  legal_hold: boolean;
  membership_id: string | null;
  membership_active: boolean;
  role_keys: string[];
  is_owner: boolean;
}

/** M-A8 §3.3 — the `User.email` of a retired Personal account. */
export function retiredEmailTombstone(user_id: string): string {
  return `retired+${user_id}@invalid.aramo`;
}

export function isRetiredEmailTombstone(user_id: string, email: string): boolean {
  return email === retiredEmailTombstone(user_id);
}

@Injectable()
export class PrivacySubjectService {
  constructor(private readonly prisma: PrismaService) {}

  /** The account (if any) whose sign-in email is `email` (case-insensitive). */
  async findAccountByEmail(email: string): Promise<{ user_id: string; tenant_id: string } | null> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; tenant_id: string }>>`
      SELECT u.id::text AS id, u.tenant_id::text AS tenant_id FROM "identity"."User" u WHERE lower(u.email) = ${normalizePrivacyEmail(email)} LIMIT 1`;
    const r = rows[0];
    return r === undefined ? null : { user_id: r.id, tenant_id: r.tenant_id };
  }

  /** The subject in its tenant, or null when the user does not belong to that tenant. */
  async context(user_id: string, tenant_id: string): Promise<PrivacySubjectContext | null> {
    const user = await this.prisma.user.findUnique({ where: { id: user_id }, select: { id: true, email: true, is_active: true, tenant_id: true } });
    if (user === null || user.tenant_id !== tenant_id) return null;
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenant_id }, select: { kind: true, status: true, legal_hold: true } });
    if (tenant === null) return null;
    const membership = await this.prisma.userTenantMembership.findFirst({ where: { user_id, tenant_id }, select: { id: true, is_active: true } });
    const role_keys =
      membership === null
        ? []
        : (
            await this.prisma.userTenantMembershipRole.findMany({ where: { membership_id: membership.id }, select: { role: { select: { key: true } } } })
          ).map((r) => r.role.key);
    return {
      user_id,
      tenant_id,
      email: user.email,
      user_active: user.is_active,
      tenant_kind: tenant.kind,
      tenant_status: tenant.status,
      legal_hold: tenant.legal_hold,
      membership_id: membership?.id ?? null,
      membership_active: membership?.is_active ?? false,
      role_keys,
      is_owner: membership?.is_active === true && role_keys.includes(TENANT_OWNER_ROLE_KEY),
    };
  }

  /**
   * M-A8 §3.3 — the identity record of a retired Personal account (idempotent, one
   * transaction): `User.email` becomes the tombstone `retired+<user_id>@invalid.aramo`
   * and every ExternalIdentity row (ExternalIdentityIdp cascades) is removed, so the
   * address can sign up again and nothing maps the old Cognito subject to the retired
   * user. Signing evidence (Signer rows, certificates) is never rewritten here.
   * Refuses an active user: the caller deactivates first.
   */
  async tombstoneRetiredUser(user_id: string, tenant_id: string): Promise<{ email_tombstoned: number; external_identities_removed: number }> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: user_id }, select: { tenant_id: true, is_active: true, email: true } });
      if (user === null || user.tenant_id !== tenant_id) throw new Error('privacy_subject_not_in_tenant');
      if (user.is_active) throw new Error('privacy_subject_still_active');
      const tombstone = retiredEmailTombstone(user_id);
      const e = user.email === tombstone ? 0 : (await tx.user.updateMany({ where: { id: user_id, tenant_id }, data: { email: tombstone } })).count;
      const x = await tx.externalIdentity.deleteMany({ where: { user_id } });
      if (e + x.count > 0) await bumpPrincipalVersion(tx, { tenant_id, principal_id: user_id });
      return { email_tombstoned: e, external_identities_removed: x.count };
    });
  }

  /** Deactivates the account holder's membership and user (idempotent). Caller applies the guard first. */
  async retireAccountHolder(user_id: string, tenant_id: string, now: Date = new Date()): Promise<{ memberships_deactivated: number; users_deactivated: number }> {
    return this.prisma.$transaction(async (tx) => {
      const m = await tx.userTenantMembership.updateMany({ where: { user_id, tenant_id, is_active: true }, data: { is_active: false, deactivated_at: now } });
      const u = await tx.user.updateMany({ where: { id: user_id, tenant_id, is_active: true }, data: { is_active: false, deactivated_at: now } });
      if (m.count + u.count > 0) await bumpPrincipalVersion(tx, { tenant_id, principal_id: user_id });
      return { memberships_deactivated: m.count, users_deactivated: u.count };
    });
  }

  /** Removes the member's Sign-only roles in this tenant (idempotent). Organization-wide roles stay. */
  async removeSignAccess(user_id: string, tenant_id: string): Promise<{ roles_removed: number; remaining_role_keys: string[] }> {
    return this.prisma.$transaction(async (tx) => {
      const membership = await tx.userTenantMembership.findFirst({ where: { user_id, tenant_id }, select: { id: true } });
      if (membership === null) return { roles_removed: 0, remaining_role_keys: [] };
      const removed = await tx.userTenantMembershipRole.deleteMany({ where: { membership_id: membership.id, role: { key: { in: [...ESIGN_ROLE_KEYS] } } } });
      if (removed.count > 0) await bumpPrincipalVersion(tx, { tenant_id, principal_id: user_id });
      const remaining = await tx.userTenantMembershipRole.findMany({ where: { membership_id: membership.id }, select: { role: { select: { key: true } } } });
      return { roles_removed: removed.count, remaining_role_keys: remaining.map((r) => r.role.key).sort() };
    });
  }
}
