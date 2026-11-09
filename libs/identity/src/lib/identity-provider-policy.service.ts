import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// AUTH-SIGNIN-1 (LOCKED) R1/R2 + Lead Architect HALT disposition 2026-10-20.
//
// Two rules, evaluated by the auth-service principal directory BEFORE an
// identity link is written and again for every session:
//
//   R2 (all tenants) — no cross-provider merge on email equality: a User that
//      already holds a link recorded for one federated provider is never
//      linked to an identity from another provider. Fail closed (legacy-link gap
//      ruling, 2026-10-26): a link is never written for an unresolved or
//      ambiguous provider, and a User holding a legacy link (no recorded
//      provider) is never linked to a new identity.
//
//   R1 (NARROW cohort) — a tenant with a TenantIdentityProviderPolicy row (only
//      new Sign Business signup tenants) enforces its pin
//      (Tenant.identity_provider): the first authorized OWNER federation sets it
//      once (compare-and-set on `identity_provider IS NULL`), every later
//      sign-in must come from that provider, even when the email matches.
//      Tenants without a row keep the fail-open hint of Subdomain-Identity-B; a
//      mismatch there is only logged.
//
// Apple Go-Live (LOCKED) R-1/R-4 + Amendment A1 L-6:
//   - `apple` (Cognito provider `SignInWithApple`) is a third federated provider.
//   - PERSONAL tenants accept only {google, apple}; Microsoft is refused
//     (idp_not_permitted_for_tenant). A returning sign-in into an enforced
//     PERSONAL tenant is allowed when the provider is the pin OR one of the
//     user's recorded links (a provider attached by proven linking, A1 L-1).
//     BUSINESS enforced tenants keep strict pin equality.

export const FEDERATED_IDPS = ['google', 'microsoft', 'apple'] as const;
export type FederatedIdp = (typeof FEDERATED_IDPS)[number];
// Apple Go-Live R-4 — the providers a PERSONAL tenant may use.
export const PERSONAL_IDPS: readonly FederatedIdp[] = ['google', 'apple'];
// Cognito provider names that alias an Aramo value (lowercased).
const IDP_ALIASES: Readonly<Record<string, FederatedIdp>> = { signinwithapple: 'apple' };
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
  const aliased = IDP_ALIASES[v];
  if (aliased !== undefined) return aliased;
  return (FEDERATED_IDPS as readonly string[]).includes(v) ? (v as FederatedIdp) : null;
}

/** Apple Go-Live R-4 — may a tenant of this kind use this provider at all? */
export function idpAllowedForTenantKind(kind: string | null | undefined, idp: FederatedIdp): boolean {
  return kind === 'PERSONAL' ? PERSONAL_IDPS.includes(idp) : true;
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

  async policyOf(tenant_id: string): Promise<{ enforced: boolean; pin: string | null; kind: string | null }> {
    const [policy, tenant] = await Promise.all([
      this.prisma.tenantIdentityProviderPolicy.findUnique({ where: { tenant_id } }),
      this.prisma.tenant.findUnique({ where: { id: tenant_id }, select: { identity_provider: true, kind: true } }),
    ]);
    return { enforced: policy !== null, pin: tenant?.identity_provider ?? null, kind: tenant?.kind ?? null };
  }

  /** Providers recorded for a user's links (legacy links have none). */
  async recordedIdpsOf(user_id: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ idp: string }[]>`
      SELECT DISTINCT p.idp FROM "identity"."ExternalIdentityIdp" p
      JOIN "identity"."ExternalIdentity" e ON e.id = p.external_identity_id
      WHERE e.user_id = ${user_id}::uuid`;
    return rows.map((r) => r.idp);
  }

  /** True when the user holds a link with no recorded provider (created before R2). */
  async hasUnrecordedLink(user_id: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM "identity"."ExternalIdentity" e
      WHERE e.user_id = ${user_id}::uuid
        AND NOT EXISTS (SELECT 1 FROM "identity"."ExternalIdentityIdp" p WHERE p.external_identity_id = e.id)`;
    return (rows[0]?.n ?? 0n) > 0n;
  }

  /** Record which provider authenticated a newly created link (idempotent). */
  async recordLinkIdp(external_identity_id: string, idp: FederatedIdp): Promise<void> {
    await this.prisma.externalIdentityIdp.createMany({ data: [{ external_identity_id, idp }], skipDuplicates: true });
  }

  /**
   * W2 (locked/Aramo-Sign-W2-Inbox-Discovery-…-v1_0-LOCKED.md, C1 "re-establish that proof") and the
   * PO's approval of 2026-11-03: a RETURNING sign-in (resolved by subject) records the provider of the
   * link it used when that link has none (a pre-R2 legacy link). Same rule as at link creation: only a
   * single resolved provider (`google` | `microsoft` | `apple`) is ever recorded; the caller has already checked
   * that the token's verified email equals the account email. Idempotent; returns true when a row
   * was written. It records which provider authenticated this link now, not mailbox ownership before.
   */
  async recordReturningLinkIdp(args: { user_id: string; provider: string; provider_subject: string; idp: FederatedIdp }): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      INSERT INTO "identity"."ExternalIdentityIdp" ("external_identity_id", "idp")
      SELECT e."id", ${args.idp} FROM "identity"."ExternalIdentity" e
      WHERE e."provider" = ${args.provider} AND e."provider_subject" = ${args.provider_subject}
        AND e."user_id" = ${args.user_id}::uuid
        AND NOT EXISTS (SELECT 1 FROM "identity"."ExternalIdentityIdp" p WHERE p."external_identity_id" = e."id")`;
    return n > 0;
  }

  /** The user's single active membership tenant (IC-1), or null. */
  async membershipTenantOf(user_id: string): Promise<string | null> {
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
    // Legacy-link gap ruling (v1.0 LOCKED, 2026-10-26, decision 2): fail closed.
    //   - A link whose own provider cannot be resolved (null, or 'ambiguous' from a
    //     Cognito user that carries several providers) is never written: it would be
    //     unrecorded, and an unrecorded link cannot be defended by R2 later.
    //   - A user who already holds a link WITHOUT a recorded provider (a legacy link)
    //     is treated as conflicting with any new provider, instead of keeping the
    //     pre-R2 behaviour of linking anything with a matching email.
    // Returning users resolve by subject and never reach this (linking=false).
    // (The enforced-pin cohort below refuses an unresolved provider with its own
    // reason, idp_not_permitted_for_tenant; every other path refuses it here.)
    const unresolvedLink = input.linking && (idp === null || idp === 'ambiguous');
    if (input.linking && !unresolvedLink) {
      const recorded = await this.recordedIdpsOf(input.user_id);
      if (recorded.some((r) => r !== idp)) return { ok: false, reason: 'idp_identity_conflict' };
      if (await this.hasUnrecordedLink(input.user_id)) return { ok: false, reason: 'idp_identity_conflict' };
    }

    if (tenant_id === null) {
      return unresolvedLink ? { ok: false, reason: 'idp_identity_conflict' } : { ok: true, pinned_now: false };
    }
    const { enforced, pin, kind } = await this.policyOf(tenant_id);
    if (!enforced) {
      if (unresolvedLink) return { ok: false, reason: 'idp_identity_conflict' };
      // Subdomain-Identity-B fail-open hint: observability only, never refused.
      if (pin !== null && idp !== null && pin.toLowerCase() !== idp) {
        this.logger.warn(JSON.stringify({ event: 'auth.idp_pin', mode: 'log', outcome: 'mismatch', pin: pin.toLowerCase(), idp }));
      }
      return { ok: true, pinned_now: false };
    }

    // Enforced cohort: only a single, known federated provider can authenticate.
    if (idp === null || idp === 'ambiguous') return { ok: false, reason: 'idp_not_permitted_for_tenant' };
    // Apple Go-Live R-4 — a PERSONAL tenant uses only {google, apple}.
    if (!idpAllowedForTenantKind(kind, idp)) return { ok: false, reason: 'idp_not_permitted_for_tenant' };
    if (input.linking) {
      const recorded = await this.recordedIdpsOf(input.user_id);
      if (recorded.some((r) => r !== idp)) return { ok: false, reason: 'idp_identity_conflict' };
    }
    if (pin !== null) {
      if (pin.toLowerCase() === idp) return { ok: true, pinned_now: false };
      // A1 L-6 — a returning PERSONAL sign-in may also use any provider the user
      // holds a recorded link for (attached by proven linking). BUSINESS: strict.
      if (kind === 'PERSONAL' && !input.linking && (await this.recordedIdpsOf(input.user_id)).includes(idp)) {
        return { ok: true, pinned_now: false };
      }
      return { ok: false, reason: 'idp_not_permitted_for_tenant' };
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
