// Single-Box Directive 2 — the Astre seed (fresh-start box provisioning).
//
// Provisions a clean box for go-live: the full scope/role catalog (reused
// verbatim from runIdentitySeed — the same path the integration tests use)
// PLUS the Astre tenant and its owner, purush@astreinc.com.
//
// THE OWNER IS SEEDED WITH NO COGNITO SUB. On first login the auth reconcile
// flow (session-orchestrator → linkExternalIdentity) resolves by-sub, MISSES,
// reconciles by the IdP-verified email, FINDS this seeded user, and LINKS the
// new sub to it — preserving tenant_id + the tenant_owner role. So the owner
// logs in via Cognito and IS the tenant_owner, not a duplicate. (Scenario 3 of
// the reconcile recon — it LINKS; see doc/step4-singlebox-astre-seed-recon.md.)
// The live login→link is a real-Cognito step, proven ON THE BOX (the §5
// checklist), not locally; this seed proves the STATE the link binds to.
//
// Idempotent: every write is an upsert keyed on a stable hardcoded UUID with
// `update: {}` — re-running produces no errors, no duplicates, identical state,
// and is safe even AFTER the owner has logged in (the linked sub is untouched).
//
// Run it (schema first, via the D5 db-sync replayer, then this seed):
//   npm run db:sync:local        # apply all module migrations to DATABASE_URL
//   npm run prisma:seed-astre    # this file

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/client/client.js';
import { runIdentitySeed, SEED_IDS } from './seed.js';

// Astre provisioning UUIDs — a distinct namespace (019000a0-…) from the
// dev/bootstrap seed's 01900000-… ids, so the two never collide.
export const ASTRE_SEED_IDS = {
  tenant: '019000a0-0000-7000-8000-000000000001',
  owner_user: '019000a0-0000-7000-8000-000000000002',
  owner_membership: '019000a0-0000-7000-8000-000000000003',
  owner_membership_role: '019000a0-0000-7000-8000-000000000004',
  audit_events: {
    tenant_created: '019000a0-0000-7000-8000-000000000010',
    user_created: '019000a0-0000-7000-8000-000000000011',
    membership_created: '019000a0-0000-7000-8000-000000000012',
  },
} as const;

export const ASTRE_TENANT_NAME = 'Astre';
// Domain-Enforcement P1 — Astre's locked domain. The seed BACKFILLS it (the
// upsert sets it in BOTH create AND update, so an Astre row created before the
// allowed_domain migration is backfilled on the next idempotent re-seed). The
// seeded owner purush@astreinc.com matches it (astreinc.com is non-personal),
// so the existing owner stays valid — no retroactive break. After this runs,
// NULL allowed_domain does not exist for any real tenant.
export const ASTRE_ALLOWED_DOMAIN = 'astreinc.com';
// NORMALIZED form — the reconcile lookup is findUserByEmail(cognito.email
// .trim().toLowerCase()) with an EXACT match (no stored-side normalization),
// so the seeded email MUST equal the lowercase+trimmed login email.
export const ASTRE_OWNER_EMAIL = 'purush@astreinc.com';
export const ASTRE_OWNER_DISPLAY_NAME = 'Purush Pichaimuthu';

// Minimal model surface the seed touches (structurally satisfied by
// PrismaClient — mirrors seed.ts's IdentityPrismaClient).
type AstreSeedPrisma = Pick<
  PrismaClient,
  | 'tenant'
  | 'user'
  | 'userTenantMembership'
  | 'userTenantMembershipRole'
  | 'identityAuditEvent'
>;

export async function runAstreSeed(
  prisma: PrismaClient,
): Promise<{ astre_tenant_id: string; owner_user_id: string }> {
  // 1. Catalog ONLY — reused verbatim, idempotent. Seeds the full
  //    85-scope / 14-role / 468-grant catalog, the system ServiceAccount that
  //    the audit rows below reference as actor, and the `Aramo Platform`
  //    sentinel tenant. `includeDevFixtures: false` SCRUBS the dev/bootstrap
  //    fixtures (Aramo Dev Tenant + admin@aramo.dev) so Astre's first prod DB
  //    is catalog + Astre + owner ONLY — clean from creation, never
  //    seeded-then-scrubbed (Single-Box Directive 3 §F). The catalog itself is
  //    byte-identical to the dev path; only the dev fixtures are gated.
  await runIdentitySeed(prisma, { includeDevFixtures: false });

  const db = prisma as AstreSeedPrisma;

  // 2. The Astre tenant.
  await db.tenant.upsert({
    where: { id: ASTRE_SEED_IDS.tenant },
    // Domain-Enforcement P1 — set allowed_domain in UPDATE too so a pre-
    // migration Astre row is backfilled on re-seed (NULL → astreinc.com).
    update: { allowed_domain: ASTRE_ALLOWED_DOMAIN },
    create: {
      id: ASTRE_SEED_IDS.tenant,
      name: ASTRE_TENANT_NAME,
      is_active: true,
      allowed_domain: ASTRE_ALLOWED_DOMAIN,
    },
  });

  // 3. The owner User — NO ExternalIdentity (no Cognito sub). The reconcile
  //    flow links the sub on first login (scenario 3 LINKS).
  await db.user.upsert({
    where: { id: ASTRE_SEED_IDS.owner_user },
    update: {},
    create: {
      id: ASTRE_SEED_IDS.owner_user,
      email: ASTRE_OWNER_EMAIL,
      display_name: ASTRE_OWNER_DISPLAY_NAME,
      is_active: true,
    },
  });

  // 4. The owner's tenant membership (tenant-wide; site_id null).
  await db.userTenantMembership.upsert({
    where: {
      user_id_tenant_id: {
        user_id: ASTRE_SEED_IDS.owner_user,
        tenant_id: ASTRE_SEED_IDS.tenant,
      },
    },
    update: {},
    create: {
      id: ASTRE_SEED_IDS.owner_membership,
      user_id: ASTRE_SEED_IDS.owner_user,
      tenant_id: ASTRE_SEED_IDS.tenant,
      is_active: true,
    },
  });

  // 5. tenant_owner role on that membership (the role id comes from the
  //    catalog seeded in step 1).
  await db.userTenantMembershipRole.upsert({
    where: {
      membership_id_role_id: {
        membership_id: ASTRE_SEED_IDS.owner_membership,
        role_id: SEED_IDS.roles.tenant_owner,
      },
    },
    update: {},
    create: {
      id: ASTRE_SEED_IDS.owner_membership_role,
      membership_id: ASTRE_SEED_IDS.owner_membership,
      role_id: SEED_IDS.roles.tenant_owner,
    },
  });

  // 6. Provisioning audit trail (actor = system ServiceAccount; mirrors the
  //    dev seed's tenant/user/membership-created events + their scope mapping).
  await db.identityAuditEvent.upsert({
    where: { id: ASTRE_SEED_IDS.audit_events.tenant_created },
    update: {},
    create: {
      id: ASTRE_SEED_IDS.audit_events.tenant_created,
      tenant_id: ASTRE_SEED_IDS.tenant, // tenant-scoped
      actor_id: SEED_IDS.service_account_system,
      actor_type: 'system',
      event_type: 'identity.tenant.created',
      subject_id: ASTRE_SEED_IDS.tenant,
      event_payload: {
        tenant_id: ASTRE_SEED_IDS.tenant,
        name: ASTRE_TENANT_NAME,
      } as never,
    },
  });
  await db.identityAuditEvent.upsert({
    where: { id: ASTRE_SEED_IDS.audit_events.user_created },
    update: {},
    create: {
      id: ASTRE_SEED_IDS.audit_events.user_created,
      tenant_id: null, // global
      actor_id: SEED_IDS.service_account_system,
      actor_type: 'system',
      event_type: 'identity.user.created',
      subject_id: ASTRE_SEED_IDS.owner_user,
      event_payload: {
        user_id: ASTRE_SEED_IDS.owner_user,
        email: ASTRE_OWNER_EMAIL,
      } as never,
    },
  });
  await db.identityAuditEvent.upsert({
    where: { id: ASTRE_SEED_IDS.audit_events.membership_created },
    update: {},
    create: {
      id: ASTRE_SEED_IDS.audit_events.membership_created,
      tenant_id: ASTRE_SEED_IDS.tenant, // tenant-scoped
      actor_id: SEED_IDS.service_account_system,
      actor_type: 'system',
      event_type: 'identity.membership.created',
      subject_id: ASTRE_SEED_IDS.owner_user,
      event_payload: {
        membership_id: ASTRE_SEED_IDS.owner_membership,
        user_id: ASTRE_SEED_IDS.owner_user,
        tenant_id: ASTRE_SEED_IDS.tenant,
        role_keys: ['tenant_owner'],
      } as never,
    },
  });

  return {
    astre_tenant_id: ASTRE_SEED_IDS.tenant,
    owner_user_id: ASTRE_SEED_IDS.owner_user,
  };
}

// CLI entrypoint — `npm run prisma:seed-astre` invokes this file.
async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error('DATABASE_URL is not configured');
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
  try {
    await prisma.$connect();
    const result = await runAstreSeed(prisma);
    console.log(
      `astre seed complete: tenant=${result.astre_tenant_id} owner=${result.owner_user_id} (${ASTRE_OWNER_EMAIL}, tenant_owner, no sub — links on first login)`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// ESM detection: only run main() when invoked as the entrypoint.
const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  /seed-astre\.(ts|js)$/.test(process.argv[1]);

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error('astre seed failed:', err);
    process.exit(1);
  });
}
