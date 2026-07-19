import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { HostAuthProfileRepository } from '../lib/host-auth-profile.repository.js';
import { HostAuthProfileStore } from '../lib/host-auth-profile.store.js';
import {
  seedHostAuthProfiles,
  SEED_POOL_ID,
  DEFAULT_PLATFORM_HOST,
  DEFAULT_PORTAL_HOST,
} from '../lib/host-auth-profile.seed.js';

// Auth-Decoupling PR-1 — proves the new migration DDL matches the generated
// HostAuthProfile model and that seed → read round-trips against real Postgres:
// the seed upserts three class rows, the store returns them indexed by class,
// and re-seeding stays idempotent (host_class UNIQUE).

const MIGRATION_PATHS = [
  resolve(__dirname, '../../prisma/migrations/20260512100000_init_auth_storage/migration.sql'),
  resolve(__dirname, '../../prisma/migrations/20260719000000_add_host_auth_profile/migration.sql'),
];

const SEED_ENV = {
  APP_ROOT_DOMAIN: 'aramo.ai',
  AUTH_PLATFORM_HOSTS: DEFAULT_PLATFORM_HOST,
  AUTH_PORTAL_HOSTS: DEFAULT_PORTAL_HOST,
  AUTH_COGNITO_CLIENT_ID: 'client-xyz',
  AUTH_COGNITO_ISSUER: 'https://issuer.example',
  AUTH_COGNITO_DOMAIN: 'auth.example',
} as const;

function splitDdl(sql: string): string[] {
  return sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'auth-storage HostAuthProfile — integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let store: HostAuthProfileStore;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const path of MIGRATION_PATHS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          const t = stmt.trim();
          if (t.length === 0) continue;
          await setup.$executeRawUnsafe(t);
        }
      }
      await setup.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      store = new HostAuthProfileStore(new HostAuthProfileRepository(prisma));
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    beforeEach(async () => {
      await prisma.hostAuthProfile.deleteMany({});
    });

    it('seed upserts the three class rows; store indexes them by class', async () => {
      await seedHostAuthProfiles(prisma, SEED_ENV);
      const byClass = await store.activeByClass();
      expect([...byClass.keys()].sort()).toEqual(['PLATFORM', 'PORTAL', 'TENANT']);
      expect(byClass.get('PLATFORM')?.host_pattern).toBe(DEFAULT_PLATFORM_HOST);
      expect(byClass.get('PORTAL')?.host_pattern).toBe(DEFAULT_PORTAL_HOST);
      expect(byClass.get('TENANT')?.host_pattern).toBe('*.aramo.ai');
      for (const row of byClass.values()) {
        expect(row.pool_id).toBe(SEED_POOL_ID);
        expect(row.default_idp).toBeNull();
        expect(row.is_active).toBe(true);
      }
    });

    it('re-seeding is idempotent — still exactly three rows', async () => {
      await seedHostAuthProfiles(prisma, SEED_ENV);
      await seedHostAuthProfiles(prisma, SEED_ENV);
      const count = await prisma.hostAuthProfile.count();
      expect(count).toBe(3);
    });

    it('inactive rows are excluded from the store read', async () => {
      await seedHostAuthProfiles(prisma, SEED_ENV);
      await prisma.hostAuthProfile.update({
        where: { host_class: 'PORTAL' },
        data: { is_active: false },
      });
      const byClass = await store.activeByClass();
      expect(byClass.has('PORTAL')).toBe(false);
      expect(byClass.size).toBe(2);
    });
  },
);
