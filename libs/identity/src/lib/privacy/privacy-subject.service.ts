import { Injectable, Optional } from '@nestjs/common';

import { bumpPrincipalVersion } from '../authorization-version.ops.js';
import { ESIGN_ROLE_KEYS } from '../dto/esign-permissions.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantEntitlementReader } from '../tenant-entitlement-reader.service.js';
import { TENANT_OWNER_ROLE_KEY } from '../util/tenant-lifecycle.js';

import { normalizePrivacyEmail } from './privacy-request-crypto.js';

// Aramo-Sign-Mobile-Amendment-M-A7 §3.2 — the identity side of a privacy request:
// who the subject is, whether a shared identity still carries other product
// authorization, and the two identity writes a deletion may make:
//   - retireAccountHolder  the Personal account holder's membership and user are
//                          deactivated (only when NO other membership or product
//                          authorization remains — the shared-identity guard);
//   - removeSignAccess     a Business member's Sign-only roles are removed; the
//                          organization-wide roles (which also carry other
//                          products) are never touched.
// Every write bumps the principal's authorization version in the same transaction,
// so cached scopes are invalidated immediately. Nothing here deletes a row.

/** Capabilities that do not count as "other product authorization" for a Sign request. */
const SIGN_ONLY_CAPABILITIES: ReadonlySet<string> = new Set(['core', 'sign']);

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

export interface PrivacyOtherAuthorization {
  /** Active memberships of this user in OTHER tenants. */
  other_memberships: number;
  /** Product capabilities of the subject's tenant beyond core + sign (e.g. ats). */
  other_products: string[];
  /** Other users bound to the same external (Cognito / IdP) subject. */
  shared_external_identities: number;
  /** True when the shared identity must be kept. */
  retain: boolean;
}

@Injectable()
export class PrivacySubjectService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly entitlements?: TenantEntitlementReader,
  ) {}

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

  /** §3.2 shared-identity guard: does anything other than this Sign account still use the identity? */
  async otherAuthorization(user_id: string, tenant_id: string): Promise<PrivacyOtherAuthorization> {
    const other_memberships = await this.prisma.userTenantMembership.count({ where: { user_id, tenant_id: { not: tenant_id }, is_active: true } });
    const caps = this.entitlements !== undefined ? await this.entitlements.getCapabilities(tenant_id) : new Set<string>();
    const other_products = [...caps].filter((c) => !SIGN_ONLY_CAPABILITIES.has(c)).sort();
    const externals = await this.prisma.externalIdentity.findMany({ where: { user_id }, select: { provider: true, provider_subject: true } });
    const shared_external_identities =
      externals.length === 0
        ? 0
        : await this.prisma.externalIdentity.count({
            where: { user_id: { not: user_id }, OR: externals.map((e) => ({ provider: e.provider, provider_subject: e.provider_subject })) },
          });
    return { other_memberships, other_products, shared_external_identities, retain: other_memberships > 0 || other_products.length > 0 || shared_external_identities > 0 };
  }

  /** The external (IdP) subjects bound to the user — for the IdP retirement step. */
  async externalSubjects(user_id: string): Promise<Array<{ provider: string; provider_subject: string }>> {
    return this.prisma.externalIdentity.findMany({ where: { user_id }, select: { provider: true, provider_subject: true } });
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
