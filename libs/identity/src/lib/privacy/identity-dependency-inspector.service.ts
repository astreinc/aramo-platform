import { Inject, Injectable } from '@nestjs/common';

import { PLATFORM_ROLE_KEYS } from '../dto/role.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantEntitlementReader } from '../tenant-entitlement-reader.service.js';

import { IDENTITY_RETIREMENT_PORT, type IdentityPoolLookup, type IdentityRetirementPort } from './identity-retirement.port.js';

// Aramo-Sign-Mobile-Amendment-M-A8 §3.2 — the identity-owned dependency inspection
// that decides whether a Personal "Delete my account" may retire the Aramo identity.
// Computed at execution time, never cached. Codes, exactly as §3.2:
//
//   (a) A_OTHER_PRODUCT        the Personal tenant's capabilities other than core/sign
//   (b) B_OTHER_MEMBERSHIP     active memberships of the same User in any other tenant
//                              (defensive: the schema allows one; the check stays)
//   (c) C_SHARED_IDENTITY      another Aramo User sharing the Cognito subject, or holding
//                              a federated (ExternalIdentityIdp) link for the same email
//   (d) D_PLATFORM_ROLE        a platform role assignment held by the user
//   (e) E_COGNITO_POOL         Cognito pool state for the subject (through the identity
//                              retirement port): a linked provider in `identities`, or
//                              another pool user with the same email; a pool that cannot
//                              be read (not configured / failed) is NOT clear (fail closed)
//   (f) F_LEGAL_HOLD           Tenant.legal_hold or any DocumentArtifact.legal_hold in the
//                              tenant → the request returns to the queue
//   (g) G_PRESERVED            agreements awaiting this user and retained evidence — they
//                              affect what is preserved, never whether the account closes
//
// (a)–(e) are dependencies (retain path); (f) holds; (g) is informational. Tables of
// other schemas (documents, sign) are read by raw SQL when present in the database (an
// isolated identity test database has none: their counts are 0, the same posture as
// the Sign privacy repository's auth_storage reads).

export const IDENTITY_DEPENDENCY_CODES = {
  a: 'A_OTHER_PRODUCT',
  b: 'B_OTHER_MEMBERSHIP',
  c: 'C_SHARED_IDENTITY',
  d: 'D_PLATFORM_ROLE',
  e: 'E_COGNITO_POOL',
  f: 'F_LEGAL_HOLD',
  g: 'G_PRESERVED',
} as const;

export type IdentityDependencyCode = (typeof IDENTITY_DEPENDENCY_CODES)['a' | 'b' | 'c' | 'd' | 'e'];

/** Capabilities that do not count as another product for a Personal Sign account. */
const SIGN_ONLY_CAPABILITIES: ReadonlySet<string> = new Set(['core', 'sign']);
export const COGNITO_PROVIDER = 'cognito';

export interface IdentityDependencyReport {
  /** (a)–(e) codes present; empty = no dependency. */
  dependencies: IdentityDependencyCode[];
  /** (f) — the request must wait. */
  legal_hold: boolean;
  /** No dependency and no legal hold: the identity may be retired. */
  retire_identity: boolean;
  /** (a) clear: the Personal Sign tenant may be closed. */
  may_close_tenant: boolean;
  a_other_products: string[];
  b_other_memberships: number;
  c_shared_identity_users: number;
  d_platform_roles: string[];
  e_cognito: { status: 'clear' | 'linked' | 'unverified'; pool: IdentityPoolLookup['status']; subject_found: boolean; linked_providers: number; other_users_same_email: number };
  f_legal_hold: { tenant: boolean; document_artifacts: number };
  g_preserved: { agreements_awaiting_user: number; agreements_sent_open: number; completed_agreements: number; signed_signer_records: number };
  /** The Cognito subject linked to the user (for the retirement step) — never evidence. */
  cognito_sub: string | null;
}

/**
 * Retention and Purge directive (ebd41d99) W9 / finding F-P4-1. 'platform' (default) reads
 * every schema it can see, as before. 'sign' is the scope for the Sign deletion path: it
 * never reads an ATS schema (Sign holds no grant on them), so (f) comes from
 * identity."Tenant".legal_hold alone and document_artifacts is 0.
 */
export interface IdentityDependencyInspectOptions {
  scope?: 'platform' | 'sign';
}

type Count = Array<{ n: bigint | number }>;
const num = (rows: Count): number => Number(rows[0]?.n ?? 0);

@Injectable()
export class IdentityDependencyInspector {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: TenantEntitlementReader,
    @Inject(IDENTITY_RETIREMENT_PORT) private readonly pool: IdentityRetirementPort,
  ) {}

  private async present(table: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ present: boolean }>>`SELECT to_regclass(${table}) IS NOT NULL AS present`;
    return rows[0]?.present === true;
  }

  async inspect(user_id: string, tenant_id: string, opts: IdentityDependencyInspectOptions = {}): Promise<IdentityDependencyReport> {
    const signScope = opts.scope === 'sign';
    const user = await this.prisma.user.findUnique({ where: { id: user_id }, select: { email: true, tenant_id: true } });
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenant_id }, select: { legal_hold: true } });
    if (user === null || tenant === null || user.tenant_id !== tenant_id) throw new Error('identity_dependency_subject_not_in_tenant');
    const email = user.email.trim().toLowerCase();

    // (a)
    const caps = await this.entitlements.getCapabilities(tenant_id);
    const a_other_products = [...caps].filter((c) => !SIGN_ONLY_CAPABILITIES.has(c)).sort();

    // (b)
    const b_other_memberships = await this.prisma.userTenantMembership.count({ where: { user_id, tenant_id: { not: tenant_id }, is_active: true } });

    // (c)
    const links = await this.prisma.externalIdentity.findMany({ where: { user_id }, select: { provider: true, provider_subject: true, email_snapshot: true }, orderBy: { created_at: 'asc' } });
    const cognito_sub = links.find((l) => l.provider === COGNITO_PROVIDER)?.provider_subject ?? null;
    const sameSubject =
      links.length === 0
        ? 0
        : await this.prisma.externalIdentity.count({ where: { user_id: { not: user_id }, OR: links.map((l) => ({ provider: l.provider, provider_subject: l.provider_subject })) } });
    const emails = [...new Set([email, ...links.map((l) => (l.email_snapshot ?? '').trim().toLowerCase()).filter((e) => e !== '')])];
    const federatedSameEmail = num(
      await this.prisma.$queryRaw<Count>`
        SELECT count(DISTINCT e.user_id) AS n FROM "identity"."ExternalIdentity" e
          JOIN "identity"."ExternalIdentityIdp" p ON p.external_identity_id = e.id
         WHERE e.user_id <> ${user_id}::uuid AND lower(e.email_snapshot) = ANY(${emails}::text[])`,
    );
    const c_shared_identity_users = sameSubject + federatedSameEmail;

    // (d)
    const platformRoles = await this.prisma.userTenantMembershipRole.findMany({
      where: { membership: { user_id }, role: { key: { in: [...PLATFORM_ROLE_KEYS] } } },
      select: { role: { select: { key: true } } },
    });
    const d_platform_roles = [...new Set(platformRoles.map((r) => r.role.key))].sort();

    // (e)
    const lookup = await this.pool.lookup({ cognito_sub, email });
    const e_cognito: IdentityDependencyReport['e_cognito'] =
      lookup.status !== 'ok'
        ? { status: 'unverified', pool: lookup.status, subject_found: false, linked_providers: 0, other_users_same_email: 0 }
        : {
            status: lookup.linked_providers > 0 || lookup.other_users_same_email > 0 ? 'linked' : 'clear',
            pool: 'ok',
            subject_found: lookup.subject_found,
            linked_providers: lookup.linked_providers,
            other_users_same_email: lookup.other_users_same_email,
          };

    // (f) — the ATS document check is skipped entirely in the Sign scope (F-P4-1).
    const document_artifacts = !signScope && (await this.present('documents."DocumentArtifact"'))
      ? num(await this.prisma.$queryRaw<Count>`SELECT count(*) AS n FROM "documents"."DocumentArtifact" WHERE tenant_id = ${tenant_id}::uuid AND legal_hold`)
      : 0;
    const legal_hold = tenant.legal_hold || document_artifacts > 0;

    // (g)
    const g_preserved = { agreements_awaiting_user: 0, agreements_sent_open: 0, completed_agreements: 0, signed_signer_records: 0 };
    if ((await this.present('sign."SignatureEnvelope"')) && (await this.present('sign."Signer"'))) {
      g_preserved.agreements_awaiting_user = num(
        await this.prisma.$queryRaw<Count>`
          SELECT count(DISTINCT s.envelope_id) AS n FROM "sign"."Signer" s JOIN "sign"."SignatureEnvelope" v ON v.id = s.envelope_id
           WHERE (s.bound_user_id = ${user_id}::uuid OR lower(s.email) = ${email})
             AND s.status IN ('PENDING', 'VIEWED') AND v.status IN ('SENT', 'IN_PROGRESS')`,
      );
      g_preserved.agreements_sent_open = num(
        await this.prisma.$queryRaw<Count>`SELECT count(*) AS n FROM "sign"."SignatureEnvelope" WHERE tenant_id = ${tenant_id}::uuid AND created_by = ${user_id}::uuid AND status IN ('SENT', 'IN_PROGRESS')`,
      );
      g_preserved.completed_agreements = num(
        await this.prisma.$queryRaw<Count>`SELECT count(*) AS n FROM "sign"."SignatureEnvelope" WHERE tenant_id = ${tenant_id}::uuid AND created_by = ${user_id}::uuid AND status = 'COMPLETED'`,
      );
      g_preserved.signed_signer_records = num(
        await this.prisma.$queryRaw<Count>`SELECT count(*) AS n FROM "sign"."Signer" WHERE (bound_user_id = ${user_id}::uuid OR lower(email) = ${email}) AND status = 'SIGNED'`,
      );
    }

    const dependencies: IdentityDependencyCode[] = [];
    if (a_other_products.length > 0) dependencies.push(IDENTITY_DEPENDENCY_CODES.a);
    if (b_other_memberships > 0) dependencies.push(IDENTITY_DEPENDENCY_CODES.b);
    if (c_shared_identity_users > 0) dependencies.push(IDENTITY_DEPENDENCY_CODES.c);
    if (d_platform_roles.length > 0) dependencies.push(IDENTITY_DEPENDENCY_CODES.d);
    if (e_cognito.status !== 'clear') dependencies.push(IDENTITY_DEPENDENCY_CODES.e);

    return {
      dependencies,
      legal_hold,
      retire_identity: dependencies.length === 0 && !legal_hold,
      may_close_tenant: a_other_products.length === 0,
      a_other_products,
      b_other_memberships,
      c_shared_identity_users,
      d_platform_roles,
      e_cognito,
      f_legal_hold: { tenant: tenant.legal_hold, document_artifacts },
      g_preserved,
      cognito_sub,
    };
  }
}

/** The report as counts and codes only (no subject, no email) — for request evidence. */
export function dependencyEvidence(r: IdentityDependencyReport): Record<string, unknown> {
  return {
    dependency_codes: r.dependencies,
    legal_hold: r.legal_hold,
    other_products: r.a_other_products,
    other_memberships: r.b_other_memberships,
    shared_identity_users: r.c_shared_identity_users,
    platform_roles: r.d_platform_roles.length,
    cognito_pool: { status: r.e_cognito.status, pool: r.e_cognito.pool, subject_found: r.e_cognito.subject_found, linked_providers: r.e_cognito.linked_providers, other_users_same_email: r.e_cognito.other_users_same_email },
    legal_hold_document_artifacts: r.f_legal_hold.document_artifacts,
    preserved: r.g_preserved,
  };
}
