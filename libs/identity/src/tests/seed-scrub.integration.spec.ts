import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import {
  runIdentitySeed,
  SEED_IDS,
  SEED_ADMIN_EMAIL,
  SEED_TENANT_NAME,
  SEED_COGNITO_SUB,
} from '../../prisma/seed.js';
import {
  runAstreSeed,
  ASTRE_SEED_IDS,
  ASTRE_OWNER_EMAIL,
  ASTRE_TENANT_NAME,
} from '../../prisma/seed-astre.js';

// Single-Box Directive 3 §F — the dev-fixtures scrub.
//
// runIdentitySeed gained an `includeDevFixtures` flag (default TRUE — every
// existing caller is byte-for-byte unchanged). The Astre box seed passes
// FALSE so the first prod DB is `catalog + Astre + owner` ONLY — clean from
// creation, never seeded-then-scrubbed.
//
// What this spec proves against a REAL fresh Postgres 17, in order on one DB:
//   1. runAstreSeed (which calls runIdentitySeed with the flag FALSE) produces
//      the full catalog + the Astre tenant + the owner ONLY — NO Aramo Dev
//      Tenant, NO admin@aramo.dev, NO admin membership / role / identity.
//   2. runAstreSeed is idempotent (re-run → identical row counts).
//   3. The DEV path (flag default TRUE) then ADDS the dev fixtures on top while
//      leaving the catalog BYTE-IDENTICAL — proving the flag gates ONLY the
//      fixtures and never touches the catalog (the careful-review invariant).

const MIGRATION_DIR = resolve(__dirname, '../../prisma/migrations');
const MIGRATIONS = [
  '20260512000000_init_identity_model',
  '20260601000000_add_site_axis',
  '20260604000000_add_authz_team_models',
  '20260619000000_add_tenant_profile',
  '20260620000000_add_site_hierarchy',
];

// The locked catalog shape (Single-Box D2 memory: 85 scopes / 14 roles / 468
// grants). These are the numbers the scrub must keep byte-identical.
const CATALOG_ROLE_COUNT = 14;
const CATALOG_SCOPE_COUNT = 85;
const CATALOG_ROLE_SCOPE_COUNT = 468;

// Naive DDL splitter — mirrors identity.integration.spec.ts.
function splitDdl(sql: string): string[] {
  return sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/);
}

// A content fingerprint of the catalog (NOT just counts): the exact role rows,
// scope rows, and the full set of (role, scope) grant pairs. If the scrub flag
// touched the catalog in any way, this deep-equals assertion fails.
async function catalogFingerprint(p: PrismaService): Promise<{
  roles: { key: string; description: string }[];
  scopes: { key: string; description: string }[];
  grants: string[];
  serviceAccounts: number;
}> {
  const roles = await p.role.findMany({
    select: { key: true, description: true },
    orderBy: { key: 'asc' },
  });
  const scopes = await p.scope.findMany({
    select: { key: true, description: true },
    orderBy: { key: 'asc' },
  });
  const grantRows = await p.roleScope.findMany({
    select: { role_id: true, scope_id: true },
  });
  const grants = grantRows
    .map((g) => `${g.role_id}:${g.scope_id}`)
    .sort((a, b) => a.localeCompare(b));
  const serviceAccounts = await p.serviceAccount.count();
  return { roles, scopes, grants, serviceAccounts };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Single-Box D3 §F — dev-fixtures scrub (real Postgres 17)',
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

    it('runAstreSeed (flag FALSE) produces catalog + Astre + owner ONLY — no dev fixtures', async () => {
      const { astre_tenant_id, owner_user_id } = await runAstreSeed(prisma);

      // --- The Astre tenant + owner exist ---
      const astre = await prisma.tenant.findUnique({
        where: { id: astre_tenant_id },
      });
      expect(astre?.name).toBe(ASTRE_TENANT_NAME);

      const owner = await prisma.user.findUnique({
        where: { id: owner_user_id },
      });
      expect(owner?.email).toBe(ASTRE_OWNER_EMAIL);

      // Owner is tenant_owner, with NO external identity (links on first login).
      const ownerRole = await prisma.userTenantMembershipRole.findUnique({
        where: { id: ASTRE_SEED_IDS.owner_membership_role },
      });
      expect(ownerRole?.role_id).toBe(SEED_IDS.roles.tenant_owner);
      const ownerIdentities = await prisma.externalIdentity.count({
        where: { user_id: owner_user_id },
      });
      expect(ownerIdentities).toBe(0);

      // --- The dev fixtures DO NOT exist (the scrub) ---
      expect(
        await prisma.tenant.findUnique({ where: { id: SEED_IDS.tenant } }),
      ).toBeNull();
      expect(
        await prisma.user.findUnique({ where: { id: SEED_IDS.user_admin } }),
      ).toBeNull();
      expect(
        await prisma.userTenantMembership.findUnique({
          where: { id: SEED_IDS.membership_admin },
        }),
      ).toBeNull();
      expect(
        await prisma.externalIdentity.findUnique({
          where: {
            provider_provider_subject: {
              provider: 'cognito',
              provider_subject: SEED_COGNITO_SUB,
            },
          },
        }),
      ).toBeNull();
      // The four dev-fixture creation-audit rows are absent.
      for (const id of [
        SEED_IDS.audit_events.tenant_created,
        SEED_IDS.audit_events.user_created,
        SEED_IDS.audit_events.membership_created,
        SEED_IDS.audit_events.external_identity_linked,
      ]) {
        expect(
          await prisma.identityAuditEvent.findUnique({ where: { id } }),
        ).toBeNull();
      }

      // --- The catalog is fully present ---
      expect(await prisma.role.count()).toBe(CATALOG_ROLE_COUNT);
      expect(await prisma.scope.count()).toBe(CATALOG_SCOPE_COUNT);
      expect(await prisma.roleScope.count()).toBe(CATALOG_ROLE_SCOPE_COUNT);
      expect(await prisma.serviceAccount.count()).toBe(1);
      // The `Aramo Platform` sentinel tenant is catalog (not a dev fixture).
      expect(
        await prisma.tenant.findUnique({
          where: { id: SEED_IDS.platform_tenant },
        }),
      ).not.toBeNull();

      // catalog + Astre + owner ONLY: exactly 2 tenants (Astre + platform
      // sentinel) and exactly 1 user (the owner).
      expect(await prisma.tenant.count()).toBe(2);
      expect(await prisma.user.count()).toBe(1);
    });

    it('runAstreSeed is idempotent (re-run → identical state)', async () => {
      const before = await collectCounts(prisma);
      await runAstreSeed(prisma);
      const after = await collectCounts(prisma);
      expect(after).toEqual(before);
    });

    it('the dev path (flag default TRUE) adds the dev fixtures and leaves the catalog BYTE-IDENTICAL', async () => {
      const catalogBefore = await catalogFingerprint(prisma);

      // The default path — every existing caller. Adds the dev fixtures.
      await runIdentitySeed(prisma);

      // Dev fixtures are now present.
      const devTenant = await prisma.tenant.findUnique({
        where: { id: SEED_IDS.tenant },
      });
      expect(devTenant?.name).toBe(SEED_TENANT_NAME);
      const admin = await prisma.user.findUnique({
        where: { id: SEED_IDS.user_admin },
      });
      expect(admin?.email).toBe(SEED_ADMIN_EMAIL);
      expect(
        await prisma.externalIdentity.findUnique({
          where: {
            provider_provider_subject: {
              provider: 'cognito',
              provider_subject: SEED_COGNITO_SUB,
            },
          },
        }),
      ).not.toBeNull();

      // ★ The catalog is byte-identical — the flag gated ONLY the fixtures.
      const catalogAfter = await catalogFingerprint(prisma);
      expect(catalogAfter).toEqual(catalogBefore);
      expect(catalogAfter.roles).toHaveLength(CATALOG_ROLE_COUNT);
      expect(catalogAfter.scopes).toHaveLength(CATALOG_SCOPE_COUNT);
      expect(catalogAfter.grants).toHaveLength(CATALOG_ROLE_SCOPE_COUNT);
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
