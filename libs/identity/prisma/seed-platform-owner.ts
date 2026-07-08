// Platform-Console Increment-1 Directive §3 — the platform-owner bootstrap seed.
//
// The Increment-1 recon confirmed the platform tier's catalog is already
// seeded (AUTHZ-2): the `super_admin` role, its 3 `platform:*` scopes + grants,
// and the seed-only `Aramo Platform` sentinel Tenant all exist. What was
// missing is a HOLDER — no User carries `super_admin`, and the only runtime
// path to create one (`invitePlatformAdmin`) is itself gated behind
// `platform:admin:invite`. That chicken-and-egg is what this bootstrap seed
// breaks: it binds the first platform operator to the sentinel tenant with the
// `super_admin` role, so a real Cognito login can mint a platform JWT.
//
// THE OWNER IS SEEDED WITH NO COGNITO SUB — exactly like seed-astre's tenant
// owner. On first login the auth reconcile flow (session-orchestrator →
// resolve-by-sub MISS → findUserByEmail → linkExternalIdentity insert) FINDS
// this seeded user by IdP-verified email and LINKS the new sub to it,
// preserving the sentinel membership + super_admin role. So `purush@aramo.ai`
// logs in via Cognito and IS the platform owner, not a duplicate. The D2 link
// guard (repository no-op `update: {}`) is inviolable (Branch-Cut Ruling R1);
// this seed depends on it and never re-points.
//
// Idempotent: every write is an upsert keyed on a stable hardcoded UUID with
// `update: {}` — re-running produces no errors, no duplicates, identical state,
// and is safe even AFTER the owner has logged in (the linked sub is untouched).
//
// Seed-once rule (Directive §3): `purush@aramo.ai` is created at the platform
// layer by THIS track only. It must NOT appear in seed.ts dev fixtures or
// seed-astre.ts — those seed `admin@aramo.dev` (dev) and `purush@astreinc.com`
// (Astre tenant owner) respectively.
//
// Run it (schema first, via the D5 db-sync replayer, then this seed):
//   npm run db:sync:local             # apply all module migrations to DATABASE_URL
//   npm run prisma:seed-platform-owner # this file

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/client/client.js';
import { runIdentitySeed, SEED_IDS } from './seed.js';

// Platform-owner provisioning UUIDs — a distinct namespace (019000b0-…) from
// the dev/bootstrap seed's 01900000-… ids AND the Astre seed's 019000a0-… ids,
// so the three seed layers never collide.
export const PLATFORM_OWNER_SEED_IDS = {
  owner_user: '019000b0-0000-7000-8000-000000000001',
  owner_membership: '019000b0-0000-7000-8000-000000000002',
  owner_membership_role: '019000b0-0000-7000-8000-000000000003',
  audit_events: {
    user_created: '019000b0-0000-7000-8000-000000000010',
    membership_created: '019000b0-0000-7000-8000-000000000011',
  },
} as const;

// NORMALIZED form — the reconcile lookup is findUserByEmail(cognito.email
// .trim().toLowerCase()) with an EXACT match (no stored-side normalization),
// so the seeded email MUST equal the lowercase+trimmed login email.
export const PLATFORM_OWNER_EMAIL = 'purush@aramo.ai';
export const PLATFORM_OWNER_DISPLAY_NAME = 'Purush Purushothaman';

// Minimal model surface the seed touches (structurally satisfied by
// PrismaClient — mirrors seed.ts's IdentityPrismaClient and seed-astre.ts).
type PlatformOwnerSeedPrisma = Pick<
  PrismaClient,
  | 'tenant'
  | 'user'
  | 'userTenantMembership'
  | 'userTenantMembershipRole'
  | 'identityAuditEvent'
>;

export async function runPlatformOwnerSeed(
  prisma: PrismaClient,
): Promise<{ platform_tenant_id: string; owner_user_id: string }> {
  // 1. Catalog + sentinel ONLY — reused verbatim, idempotent. Seeds the full
  //    scope/role/grant catalog, the system ServiceAccount that the audit rows
  //    below reference as actor, and the `Aramo Platform` sentinel tenant (the
  //    membership target). `includeDevFixtures: false` SCRUBS the dev/bootstrap
  //    fixtures (Aramo Dev Tenant + admin@aramo.dev) so a platform-owner seed
  //    run against a clean box yields catalog + sentinel + platform-owner ONLY
  //    (mirrors seed-astre's prod-clean posture). The catalog + sentinel +
  //    super_admin grants are seeded unconditionally regardless of the flag.
  await runIdentitySeed(prisma, { includeDevFixtures: false });

  const db = prisma as PlatformOwnerSeedPrisma;

  // 2. The platform-owner User — NO ExternalIdentity (no Cognito sub). The
  //    reconcile flow links the sub on first login (§2 spine, unchanged).
  await db.user.upsert({
    where: { id: PLATFORM_OWNER_SEED_IDS.owner_user },
    update: {},
    create: {
      id: PLATFORM_OWNER_SEED_IDS.owner_user,
      email: PLATFORM_OWNER_EMAIL,
      display_name: PLATFORM_OWNER_DISPLAY_NAME,
      is_active: true,
    },
  });

  // 3. The owner's membership in the EXISTING sentinel tenant (tenant-wide;
  //    site_id null). No new tenant, no migration — SEED_IDS.platform_tenant is
  //    the sentinel row seeded in step 1, whose UUID equals libs/auth's
  //    PLATFORM_TENANT_SENTINEL_ID (the platform JWT tenant_id claim).
  await db.userTenantMembership.upsert({
    where: {
      user_id_tenant_id: {
        user_id: PLATFORM_OWNER_SEED_IDS.owner_user,
        tenant_id: SEED_IDS.platform_tenant,
      },
    },
    update: {},
    create: {
      id: PLATFORM_OWNER_SEED_IDS.owner_membership,
      user_id: PLATFORM_OWNER_SEED_IDS.owner_user,
      tenant_id: SEED_IDS.platform_tenant,
      is_active: true,
    },
  });

  // 4. super_admin role on that membership (the role id + its 3 platform:*
  //    grants come from the catalog seeded in step 1). This is the binding that
  //    breaks the chicken-and-egg: the holder now exists.
  await db.userTenantMembershipRole.upsert({
    where: {
      membership_id_role_id: {
        membership_id: PLATFORM_OWNER_SEED_IDS.owner_membership,
        role_id: SEED_IDS.roles.super_admin,
      },
    },
    update: {},
    create: {
      id: PLATFORM_OWNER_SEED_IDS.owner_membership_role,
      membership_id: PLATFORM_OWNER_SEED_IDS.owner_membership,
      role_id: SEED_IDS.roles.super_admin,
    },
  });

  // 5. Provisioning audit trail (actor = system ServiceAccount; mirrors the
  //    Astre seed's user/membership-created events). The sentinel tenant.created
  //    event is already emitted by runIdentitySeed, so this seed adds only the
  //    owner's user.created (global) + membership.created (sentinel-scoped).
  await db.identityAuditEvent.upsert({
    where: { id: PLATFORM_OWNER_SEED_IDS.audit_events.user_created },
    update: {},
    create: {
      id: PLATFORM_OWNER_SEED_IDS.audit_events.user_created,
      tenant_id: null, // global
      actor_id: SEED_IDS.service_account_system,
      actor_type: 'system',
      event_type: 'identity.user.created',
      subject_id: PLATFORM_OWNER_SEED_IDS.owner_user,
      event_payload: {
        user_id: PLATFORM_OWNER_SEED_IDS.owner_user,
        email: PLATFORM_OWNER_EMAIL,
      } as never,
    },
  });
  await db.identityAuditEvent.upsert({
    where: { id: PLATFORM_OWNER_SEED_IDS.audit_events.membership_created },
    update: {},
    create: {
      id: PLATFORM_OWNER_SEED_IDS.audit_events.membership_created,
      tenant_id: SEED_IDS.platform_tenant, // sentinel-scoped
      actor_id: SEED_IDS.service_account_system,
      actor_type: 'system',
      event_type: 'identity.membership.created',
      subject_id: PLATFORM_OWNER_SEED_IDS.owner_user,
      event_payload: {
        membership_id: PLATFORM_OWNER_SEED_IDS.owner_membership,
        user_id: PLATFORM_OWNER_SEED_IDS.owner_user,
        tenant_id: SEED_IDS.platform_tenant,
        role_keys: ['super_admin'],
      } as never,
    },
  });

  return {
    platform_tenant_id: SEED_IDS.platform_tenant,
    owner_user_id: PLATFORM_OWNER_SEED_IDS.owner_user,
  };
}

// CLI entrypoint — `npm run prisma:seed-platform-owner` invokes this file.
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
    const result = await runPlatformOwnerSeed(prisma);
    console.log(
      `platform-owner seed complete: tenant=${result.platform_tenant_id} (sentinel) owner=${result.owner_user_id} (${PLATFORM_OWNER_EMAIL}, super_admin, no sub — links on first login)`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// ESM detection: only run main() when invoked as the entrypoint.
const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  /seed-platform-owner\.(ts|js)$/.test(process.argv[1]);

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error('platform-owner seed failed:', err);
    process.exit(1);
  });
}
