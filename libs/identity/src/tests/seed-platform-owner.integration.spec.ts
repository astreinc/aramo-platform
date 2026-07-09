import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { SEED_IDS } from '../../prisma/seed.js';
import {
  runPlatformOwnerSeed,
  PLATFORM_OWNER_SEED_IDS,
  PLATFORM_OWNER_EMAIL,
  PLATFORM_OWNER_DISPLAY_NAME,
} from '../../prisma/seed-platform-owner.js';

// Platform-Console Increment-1 Directive §3 — the platform-owner bootstrap seed.
//
// runPlatformOwnerSeed calls runIdentitySeed({ includeDevFixtures: false }) —
// so against a fresh box it yields `catalog + sentinel + platform-owner` ONLY
// (no Aramo Dev Tenant, no admin@aramo.dev) — then binds `purush@aramo.ai` to
// the EXISTING `Aramo Platform` sentinel tenant with the `super_admin` role,
// sub-less (the D2 reconcile links the Cognito sub on first login).
//
// What this spec proves against a REAL fresh Postgres 17, in order on one DB:
//   1. runPlatformOwnerSeed creates the owner bound to the sentinel UUID with
//      the super_admin role, sub-less, and no dev fixtures leak in.
//   2. It is idempotent (re-run → identical counts; exactly one user /
//      membership / membership-role row).

const MIGRATION_DIR = resolve(__dirname, '../../prisma/migrations');
// Curated migration list — mirrors seed-scrub.integration.spec.ts verbatim
// (the seed's Tenant/User/Membership writes need exactly these columns present).
const MIGRATIONS = [
  '20260512000000_init_identity_model',
  '20260625000000_add_tenant_allowed_domain',
  '20260626000000_add_tenant_domain_verification',
  '20260626120000_add_tenant_slug',
  '20260624000000_add_invitation_and_invite_status',
  '20260601000000_add_site_axis',
  '20260604000000_add_authz_team_models',
  '20260619000000_add_tenant_profile',
  '20260620000000_add_site_hierarchy',
  '20260627000000_add_tenant_identity_provider',
  '20260709130000_add_tenant_lifecycle_status',
];

// Naive DDL splitter — mirrors identity.integration.spec.ts / seed-scrub.
function splitDdl(sql: string): string[] {
  return sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Platform-Console Inc-1 §3 — platform-owner bootstrap seed (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const name of MIGRATIONS) {
        const sql = readFileSync(
          resolve(MIGRATION_DIR, name, 'migration.sql'),
          'utf8',
        );
        for (const stmt of splitDdl(sql)) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setup.$executeRawUnsafe(trimmed);
        }
      }
      await setup.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('binds purush@aramo.ai to the sentinel tenant with super_admin, sub-less; no dev fixtures', async () => {
      const { platform_tenant_id, owner_user_id } =
        await runPlatformOwnerSeed(prisma);

      // The membership target IS the sentinel tenant (no new tenant minted).
      expect(platform_tenant_id).toBe(SEED_IDS.platform_tenant);

      // The owner User exists with the expected email + display name.
      const owner = await prisma.user.findUnique({
        where: { id: owner_user_id },
      });
      expect(owner?.email).toBe(PLATFORM_OWNER_EMAIL);
      expect(owner?.display_name).toBe(PLATFORM_OWNER_DISPLAY_NAME);

      // Membership binds to the SENTINEL UUID.
      const membership = await prisma.userTenantMembership.findUnique({
        where: { id: PLATFORM_OWNER_SEED_IDS.owner_membership },
      });
      expect(membership?.user_id).toBe(owner_user_id);
      expect(membership?.tenant_id).toBe(SEED_IDS.platform_tenant);
      expect(membership?.is_active).toBe(true);

      // Role is super_admin.
      const membershipRole = await prisma.userTenantMembershipRole.findUnique({
        where: { id: PLATFORM_OWNER_SEED_IDS.owner_membership_role },
      });
      expect(membershipRole?.role_id).toBe(SEED_IDS.roles.super_admin);

      // The owner is SUB-LESS post-seed (links on first login via D2 reconcile).
      const ownerIdentities = await prisma.externalIdentity.count({
        where: { user_id: owner_user_id },
      });
      expect(ownerIdentities).toBe(0);

      // No dev fixtures leaked in (runIdentitySeed ran with includeDevFixtures:false).
      expect(
        await prisma.tenant.findUnique({ where: { id: SEED_IDS.tenant } }),
      ).toBeNull();
      expect(
        await prisma.user.findUnique({ where: { id: SEED_IDS.user_admin } }),
      ).toBeNull();

      // The sentinel tenant (catalog) is present and is the membership target.
      const sentinel = await prisma.tenant.findUnique({
        where: { id: SEED_IDS.platform_tenant },
      });
      expect(sentinel).not.toBeNull();

      // catalog + sentinel + owner ONLY: exactly 1 tenant (sentinel) and
      // exactly 1 user (the platform owner).
      expect(await prisma.tenant.count()).toBe(1);
      expect(await prisma.user.count()).toBe(1);

      // The audit trail for the owner is written (user.created + membership.created).
      expect(
        await prisma.identityAuditEvent.findUnique({
          where: { id: PLATFORM_OWNER_SEED_IDS.audit_events.user_created },
        }),
      ).not.toBeNull();
      expect(
        await prisma.identityAuditEvent.findUnique({
          where: {
            id: PLATFORM_OWNER_SEED_IDS.audit_events.membership_created,
          },
        }),
      ).not.toBeNull();
    });

    it('is idempotent (re-run → identical state; one user/membership/role row)', async () => {
      const before = await collectCounts(prisma);
      await runPlatformOwnerSeed(prisma);
      const after = await collectCounts(prisma);
      expect(after).toEqual(before);

      // Exactly one of each owner row after the re-run.
      expect(
        await prisma.user.count({
          where: { id: PLATFORM_OWNER_SEED_IDS.owner_user },
        }),
      ).toBe(1);
      expect(
        await prisma.userTenantMembership.count({
          where: {
            user_id: PLATFORM_OWNER_SEED_IDS.owner_user,
            tenant_id: SEED_IDS.platform_tenant,
          },
        }),
      ).toBe(1);
      expect(
        await prisma.userTenantMembershipRole.count({
          where: { membership_id: PLATFORM_OWNER_SEED_IDS.owner_membership },
        }),
      ).toBe(1);
    });
  },
);

interface ModelLike {
  count(): Promise<number>;
}

async function collectCounts(p: PrismaService): Promise<Record<string, number>> {
  const sources: [string, ModelLike][] = [
    ['tenant', p.tenant],
    ['user', p.user],
    ['service_account', p.serviceAccount],
    ['membership', p.userTenantMembership],
    ['membership_role', p.userTenantMembershipRole],
    ['role', p.role],
    ['scope', p.scope],
    ['role_scope', p.roleScope],
    ['external_identity', p.externalIdentity],
    ['audit', p.identityAuditEvent],
  ];
  const out: Record<string, number> = {};
  for (const [name, model] of sources) {
    out[name] = await model.count();
  }
  return out;
}
