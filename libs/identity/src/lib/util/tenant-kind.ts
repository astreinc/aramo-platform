// IC-4 PR-9 (IC-0 §H; E-Sign PX-V1 D-3) — tenant KIND vocabulary.
//
// BUSINESS — an organization: provisioned from a non-personal owner email whose
//            domain becomes the tenant's locked `allowed_domain` (Domain-
//            Enforcement P1); any product set (default [core, ats, portal]).
// PERSONAL — a one-person Sign subscriber: an ORDINARY identity.Tenant (same
//            table, same cardinality: exactly one owning User, one membership,
//            same reconcile spine, same JWT shape) that is provisioned WITHOUT a
//            locked domain (`allowed_domain` NULL; the personal-provider
//            rejection does not apply — P1 Amendment P1-A1), holds ONLY the
//            product capabilities a personal subscriber may hold
//            (PERSONAL_TENANT_CAPABILITIES — never ats/portal/sourcing through
//            provisioning), and whose owner receives the product-neutral
//            org_admin role (IC-0 N-2; the Sign SENDER role is a separate,
//            governed grant — IC-3 PR-8 assignability, never assumed here).
//
// String vocabulary enforced in application code (the repo convention for
// status / domain_verification_status / invite_status), NOT a Prisma enum.
export const TENANT_KINDS = ['BUSINESS', 'PERSONAL'] as const;
export type TenantKind = (typeof TENANT_KINDS)[number];

export function isTenantKind(v: string): v is TenantKind {
  return (TENANT_KINDS as readonly string[]).includes(v);
}

export const DEFAULT_TENANT_KIND: TenantKind = 'BUSINESS';

// The CLOSED capability set a PERSONAL tenant may be provisioned with. `core`
// ("is an Aramo organization" — the org routes are core-gated) + `sign` (the
// product a personal subscriber subscribes to). A request naming any other
// capability for a PERSONAL tenant is refused at provisioning (fail closed);
// ATS / TIP authorization for a personal identity would require an explicit,
// separately governed entitlement decision that does not exist (IC-4 §4).
export const PERSONAL_TENANT_CAPABILITIES: readonly string[] = ['core', 'sign'];

// IC-0 J-9 (Platform-Console Inc-2 PR-1 Amendment Inc-2-PR-1-A1) — the owner
// role keys whose FIRST successful session activates a PROVISIONED tenant
// (Pattern-A owners have no Invitation row, so the acceptance-time hook never
// fires for them): the ATS owner (tenant_owner) or the product-neutral
// organization administrator (org_admin — the owner of a Sign-only or PERSONAL
// tenant, IC-0 N-2 / IC-3 PR-7).
export const TENANT_ACTIVATING_OWNER_ROLE_KEYS: readonly string[] = ['tenant_owner', 'org_admin'];
