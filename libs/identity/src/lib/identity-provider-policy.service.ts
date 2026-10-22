import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// AUTH-SIGNIN-1 (LOCKED) R1/R2 + Lead Architect HALT disposition 2026-10-20.
//
// Two rules, evaluated by the auth-service principal directory BEFORE an
// identity link is written and again for every session:
//
//   R2 (all tenants) — no cross-provider merge on email equality: a User that
//      already holds a link recorded for one federated provider is never
//      linked to an identity from another provider. Links created before this
//      rule have no recorded provider (legacy) and keep today's behaviour.
//
//   R1 (NARROW cohort) — a tenant with a TenantIdentityProviderPolicy row (only
//      new Sign Business signup tenants) enforces its pin
//      (Tenant.identity_provider): the first authorized OWNER federation sets it
//      once (compare-and-set on `identity_provider IS NULL`), every later
//      sign-in must come from that provider, even when the email matches.
//      Tenants without a row keep the fail-open hint of Subdomain-Identity-B; a
//      mismatch there is only logged.

export const FEDERATED_IDPS = ['google', 'microsoft'] as const;
export type FederatedIdp = (typeof FEDERATED_IDPS)[number];
// Owner roles that may establish a cohort tenant's first pin. ROLES-1 PR-2 (§3.4;
// Conforming Amendment 7): only the organization owner, tenant_owner.
const PIN_OWNER_ROLE_KEYS = new Set(['tenant_owner']);

export type IdpDecision =
  | { ok: true; pinned_now: boolean }
  | { ok: false; reason: 'idp_not_permitted_for_tenant' | 'idp_identity_conflict' };

export function normalizeIdp(raw: string | null | undefined): FederatedIdp | 'ambiguous' | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (v === 'ambiguous') return 'ambiguous';
  return (FEDERATED_IDPS as readonly string[]).includes(v) ? (v as FederatedIdp) : null;
}

@Injectable()
export class IdentityProviderPolicyService {
  private readonly logger = new Logger(IdentityProviderPolicyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Mark a newly created tenant as an enforced-pin tenant (Sign signup cohort). */
  async enrollEnforcedTenant(tenant_id: string): Promise<void> {
    await this.prisma.tenantIdentityProviderPolicy.createMany({ data: [{ tenant_id }], skipDuplicates: true });
  }

  /**
   * Sign Personal (Free) Launch v1.1 (LOCKED) §5 — V1 Personal sign-in is Google
   * only: enroll the tenant in the enforced cohort with its pin ALREADY set, so
   * the owner's first federation must be Google (any other provider is
   * idp_not_permitted_for_tenant) and still binds only through the existing
   * provider-checked verified-email reconcile. Idempotent; never re-points an
   * existing pin.
   */
  async enrollEnforcedTenantPinned(tenant_id: string, idp: FederatedIdp): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.tenantIdentityProviderPolicy.createMany({ data: [{ tenant_id }], skipDuplicates: true });
      const n = await tx.$executeRaw`
        UPDATE "identity"."Tenant" SET "identity_provider" = ${idp}, "updated_at" = now()
        WHERE "id" = ${tenant_id}::uuid AND "identity_provider" IS NULL`;
      if (n === 1) {
        await tx.tenantIdentityProviderPolicy.update({ where: { tenant_id }, data: { pinned_at: new Date() } });
      }
    });
  }

  async policyOf(tenant_id: string): Promise<{ enforced: boolean; pin: string | null }> {
    const [policy, tenant] = await Promise.all([
      this.prisma.tenantIdentityProviderPolicy.findUnique({ where: { tenant_id } }),
      this.prisma.tenant.findUnique({ where: { id: tenant_id }, select: { identity_provider: true } }),
    ]);
    return { enforced: policy !== null, pin: tenant?.identity_provider ?? null };
  }

  /** Providers recorded for a user's links (legacy links have none). */
  async recordedIdpsOf(user_id: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ idp: string }[]>`
      SELECT DISTINCT p.idp FROM "identity"."ExternalIdentityIdp" p
      JOIN "identity"."ExternalIdentity" e ON e.id = p.external_identity_id
      WHERE e.user_id = ${user_id}::uuid`;
    return rows.map((r) => r.idp);
  }

  /** Record which provider authenticated a newly created link (idempotent). */
  async recordLinkIdp(external_identity_id: string, idp: FederatedIdp): Promise<void> {
    await this.prisma.externalIdentityIdp.createMany({ data: [{ external_identity_id, idp }], skipDuplicates: true });
  }

  private async membershipTenantOf(user_id: string): Promise<string | null> {
    const rows = await this.prisma.userTenantMembership.findMany({ where: { user_id, is_active: true }, select: { tenant_id: true }, take: 2 });
    return rows.length === 1 ? rows[0]!.tenant_id : null;
  }

  private async isOwner(user_id: string, tenant_id: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ key: string }[]>`
      SELECT r.key FROM "identity"."UserTenantMembership" m
      JOIN "identity"."UserTenantMembershipRole" mr ON mr.membership_id = m.id
      JOIN "identity"."Role" r ON r.id = mr.role_id
      WHERE m.user_id = ${user_id}::uuid AND m.tenant_id = ${tenant_id}::uuid AND m.is_active = true`;
    return rows.some((r) => PIN_OWNER_ROLE_KEYS.has(r.key));
  }

  /**
   * Decide whether `idp` may authenticate `user_id` into `tenant_id`.
   * `linking` = this sign-in is about to create the user's link (first sign-in).
   */
  async evaluate(input: { user_id: string; tenant_id?: string; idp: string | null | undefined; linking: boolean }): Promise<IdpDecision> {
    const idp = normalizeIdp(input.idp);
    // The user's single tenant (IC-1) when the caller has not resolved it yet —
    // read from the membership directly so the caller's activation/tenant
    // resolution order is untouched.
    const tenant_id = input.tenant_id ?? (await this.membershipTenantOf(input.user_id));

    // R2 — never merge a second provider into a user on email equality.
    if (input.linking && idp !== null && idp !== 'ambiguous') {
      const recorded = await this.recordedIdpsOf(input.user_id);
      if (recorded.some((r) => r !== idp)) return { ok: false, reason: 'idp_identity_conflict' };
    }

    if (tenant_id === null) return { ok: true, pinned_now: false };
    const { enforced, pin } = await this.policyOf(tenant_id);
    if (!enforced) {
      // Subdomain-Identity-B fail-open hint: observability only, never refused.
      if (pin !== null && idp !== null && pin.toLowerCase() !== idp) {
        this.logger.warn(JSON.stringify({ event: 'auth.idp_pin', mode: 'log', outcome: 'mismatch', pin: pin.toLowerCase(), idp }));
      }
      return { ok: true, pinned_now: false };
    }

    // Enforced cohort: only a single, known federated provider can authenticate.
    if (idp === null || idp === 'ambiguous') return { ok: false, reason: 'idp_not_permitted_for_tenant' };
    if (input.linking) {
      const recorded = await this.recordedIdpsOf(input.user_id);
      if (recorded.some((r) => r !== idp)) return { ok: false, reason: 'idp_identity_conflict' };
    }
    if (pin !== null) {
      return pin.toLowerCase() === idp ? { ok: true, pinned_now: false } : { ok: false, reason: 'idp_not_permitted_for_tenant' };
    }

    // No pin yet: only the tenant's owner may establish it, exactly once.
    if (!(await this.isOwner(input.user_id, tenant_id))) return { ok: false, reason: 'idp_not_permitted_for_tenant' };
    const won = await this.prisma.$transaction(async (tx) => {
      const n = await tx.$executeRaw`
        UPDATE "identity"."Tenant" SET "identity_provider" = ${idp}, "updated_at" = now()
        WHERE "id" = ${tenant_id}::uuid AND "identity_provider" IS NULL`;
      if (n === 1) {
        await tx.tenantIdentityProviderPolicy.update({
          where: { tenant_id },
          data: { pinned_at: new Date(), pinned_by_user_id: input.user_id },
        });
      }
      return n === 1;
    });
    if (won) return { ok: true, pinned_now: true };
    // Lost the race: whoever won decides.
    const after = await this.policyOf(tenant_id);
    return after.pin !== null && after.pin.toLowerCase() === idp ? { ok: true, pinned_now: false } : { ok: false, reason: 'idp_not_permitted_for_tenant' };
  }
}
