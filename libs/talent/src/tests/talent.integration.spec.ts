import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { TalentRepository } from '../lib/talent.repository.js';
import { TalentService } from '../lib/talent.service.js';

const MIGRATIONS_DIR = resolve(__dirname, '../../prisma/migrations');

function findInitMigrationSqlPath(): string {
  const subdirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /_init_talent_model$/.test(d.name))
    .map((d) => d.name)
    .sort();
  const initDir = subdirs[subdirs.length - 1];
  if (initDir === undefined) {
    throw new Error('init_talent_model migration directory not found');
  }
  return resolve(MIGRATIONS_DIR, initDir, 'migration.sql');
}

// Mirrors libs/identity integration spec's splitDdl: strip line comments
// first, then split on statement-boundary semicolons.
function splitDdl(sql: string): string[] {
  const noLineComments = sql.replace(/--[^\n]*$/gm, '');
  return noLineComments
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Talent module — integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let service: TalentService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const migrationSql = readFileSync(findInitMigrationSqlPath(), 'utf8');
      const setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const stmt of splitDdl(migrationSql)) {
        await setupClient.$executeRawUnsafe(stmt);
      }
      await setupClient.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      service = new TalentService(new TalentRepository(prisma));
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('creates a Talent and reads it back', async () => {
      const id = uuidv7();
      const created = await service.createTalent({ id, lifecycle_status: 'active' });
      expect(created.id).toBe(id);
      expect(created.lifecycle_status).toBe('active');

      const found = await service.getTalent({ id });
      expect(found).not.toBeNull();
      expect(found?.id).toBe(id);
    });

    it('creates a TalentTenantOverlay and reads it back via (talent_id, tenant_id)', async () => {
      const talentId = uuidv7();
      const tenantId = uuidv7();
      await service.createTalent({ id: talentId, lifecycle_status: 'active' });
      const overlay = await service.createOverlay({
        talent_id: talentId,
        tenant_id: tenantId,
        source_channel: 'recruiter_capture',
        tenant_status: 'active',
      });
      expect(overlay.talent_id).toBe(talentId);
      expect(overlay.tenant_id).toBe(tenantId);

      const found = await service.getOverlayByTenant({ talent_id: talentId, tenant_id: tenantId });
      expect(found?.id).toBe(overlay.id);
    });

    it('@@unique([talent_id, tenant_id]) — a second overlay for the same (talent, tenant) pair fails', async () => {
      const talentId = uuidv7();
      const tenantId = uuidv7();
      await service.createTalent({ id: talentId, lifecycle_status: 'active' });
      await service.createOverlay({
        talent_id: talentId,
        tenant_id: tenantId,
        source_channel: 'recruiter_capture',
        tenant_status: 'active',
      });

      await expect(
        service.createOverlay({
          talent_id: talentId,
          tenant_id: tenantId,
          source_channel: 'recruiter_capture',
          tenant_status: 'active',
        }),
      ).rejects.toThrow();
    });

    it('FK — overlay creation with a non-existent talent_id fails', async () => {
      const ghostTalentId = uuidv7();
      const tenantId = uuidv7();

      await expect(
        service.createOverlay({
          talent_id: ghostTalentId,
          tenant_id: tenantId,
          source_channel: 'recruiter_capture',
          tenant_status: 'active',
        }),
      ).rejects.toThrow();
    });
  },
);
