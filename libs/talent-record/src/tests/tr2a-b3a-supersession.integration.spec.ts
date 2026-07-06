import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { TalentRecordRepository } from '../lib/talent-record.repository.js';

// TR-2a-B3a (DDR-3 §3) — record supersession read predicates against real
// Postgres 17. Superseded rows are seeded DIRECTLY (no reconcile writer exists
// this slice). Covers directive §5 acceptance test:
//   (a) a superseded record is HIDDEN from list()/search, RETURNED by findById
//       WITH its supersession metadata, and VISIBLE to listByTenantKeyset.
//   (g, shape) the record-detail read (findById) carries record_status /
//       superseded_by_record_id / superseded_at.

const MIGRATIONS_DIR = resolve(__dirname, '../../prisma/migrations');
const MIGRATIONS = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d+_/.test(d.name))
  .map((d) => d.name)
  .sort()
  .map((d) => resolve(MIGRATIONS_DIR, d, 'migration.sql'));

const TENANT = '11111111-1111-7111-8111-111111111111';

function splitDdl(sql: string): string[] {
  return sql
    .replace(/--[^\n]*$/gm, '')
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-2a-B3a — TalentRecord supersession read predicates (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: TalentRecordRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const path of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          await setup.$executeRawUnsafe(stmt);
        }
      }
      await setup.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new TalentRecordRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    async function seedLive(first: string): Promise<string> {
      const id = uuidv7();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "talent_record"."TalentRecord" (id, tenant_id, first_name, last_name)
         VALUES ('${id}'::uuid, '${TENANT}'::uuid, '${first}', 'Live')`,
      );
      return id;
    }

    // Seed a SUPERSEDED husk pointing at the survivor (the state the B3b reconcile
    // writer will produce; seeded directly here — writer-less slice).
    async function seedSuperseded(first: string, survivorId: string): Promise<string> {
      const id = uuidv7();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "talent_record"."TalentRecord"
           (id, tenant_id, first_name, last_name, record_status, superseded_by_record_id, superseded_at)
         VALUES ('${id}'::uuid, '${TENANT}'::uuid, '${first}', 'Husk', 'superseded', '${survivorId}'::uuid, NOW())`,
      );
      return id;
    }

    it('(a) superseded record is hidden from list()/search/count, returned by findById WITH metadata, visible to listByTenantKeyset', async () => {
      const survivor = await seedLive('Survivor');
      const husk = await seedSuperseded('Husk', survivor);

      // list() — live-only. The husk is absent; the survivor is present.
      const listed = await repo.list({ tenant_id: TENANT });
      const listedIds = listed.map((r) => r.id);
      expect(listedIds).toContain(survivor);
      expect(listedIds).not.toContain(husk);

      // search (searchPaged) — live-only, incl. facet counts over the same WHERE.
      const page = await repo.searchPaged({ tenant_id: TENANT });
      const pageIds = page.items.map((r) => r.id);
      expect(pageIds).toContain(survivor);
      expect(pageIds).not.toContain(husk);

      // count() — cardinality of the live list surface.
      const liveCount = await repo.count({ tenant_id: TENANT });
      expect(liveCount).toBe(1);

      // findById — returns the superseded husk WITH its supersession metadata.
      const detail = await repo.findById({ tenant_id: TENANT, id: husk });
      expect(detail).not.toBeNull();
      expect(detail!.record_status).toBe('superseded');
      expect(detail!.superseded_by_record_id).toBe(survivor);
      expect(detail!.superseded_at).not.toBeNull();

      // findById on a live record carries record_status='live' + null metadata.
      const liveDetail = await repo.findById({ tenant_id: TENANT, id: survivor });
      expect(liveDetail!.record_status).toBe('live');
      expect(liveDetail!.superseded_by_record_id).toBeNull();
      expect(liveDetail!.superseded_at).toBeNull();

      // listByTenantKeyset — DELIBERATELY see-everything (system backfill): BOTH.
      const keyset = await repo.listByTenantKeyset({ tenant_id: TENANT, limit: 100 });
      const keysetIds = keyset.map((r) => r.id);
      expect(keysetIds).toContain(survivor);
      expect(keysetIds).toContain(husk);
    });
  },
);
