import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { SourcedTalentRepository } from '../lib/sourced-talent.repository.js';

// Fix-Slice-1 integration test — brings up Postgres 17, applies the init
// migration, and proves the L1 arrival substrate against real SQL: idempotent
// record (the dedup memory, §4), distinct arrivals, and the raw-immutability
// trigger (a sourced arrival is immutable — Spec §2).

// Ordered curated migration list (standing curated-list rule) — every
// sourced_talent migration, applied in filename order, so the integration boot
// provisions the schema at HEAD. TR-2b B1 (DDR R3) appended the
// normalized-contact columns migration.
const MIGRATION_PATHS = [
  '20260704000000_init_sourced_talent',
  '20260713160000_add_sourced_talent_normalized_contact',
].map((name) =>
  resolve(__dirname, `../../prisma/migrations/${name}/migration.sql`),
);

// A fixed tenant UUID (L1 is tenant-scoped). Date.now()/Math.random() are not
// used — fixed literals keep the run deterministic.
const TENANT = '00000000-0000-4000-8000-000000000001';
const ARRIVED_AT = new Date('2026-07-04T00:00:00.000Z');

// $$-aware DDL splitter (mirrors the libs/talent-trust / libs/identity-index
// harness) — the immutability trigger body is delimited by $$.
function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (sql.startsWith('$$', i)) {
      inDollar = !inDollar;
      current += '$$';
      i += 1;
      continue;
    }
    if (ch === ';' && !inDollar) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'SourcedTalentRepository — L1 staging substrate integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: SourcedTalentRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const migrationPath of MIGRATION_PATHS) {
        const migrationSql = readFileSync(migrationPath, 'utf8');
        for (const stmt of splitDdl(migrationSql)) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setupClient.$executeRawUnsafe(trimmed);
        }
      }
      await setupClient.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new SourcedTalentRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('records a raw arrival and resolves it by dedup key and by id', async () => {
      const arrival = await repo.recordArrival({
        tenant_id: TENANT,
        source_channel: 'INDEED',
        external_source_id: 'indeed-abc-001',
        provenance: { pull_query: 'react senior', actor: 'sourcing-svc' },
        legal_basis: { basis: 'LEGITIMATE_INTEREST', source: 'INDEED', provenance: 'ToS-2026' },
        arrived_at: ARRIVED_AT,
      });
      expect(arrival.id).toMatch(/^[0-9a-f-]{36}$/);

      const byKey = await repo.findArrival(TENANT, 'INDEED', 'indeed-abc-001');
      expect(byKey?.id).toBe(arrival.id);

      const byId = await repo.findById(arrival.id);
      expect(byId?.external_source_id).toBe('indeed-abc-001');
      expect(byId?.tenant_id).toBe(TENANT);
    });

    it('is idempotent on the dedup key — a re-pull returns the SAME arrival (§4)', async () => {
      const first = await repo.recordArrival({
        tenant_id: TENANT,
        source_channel: 'INDEED',
        external_source_id: 'indeed-dup-777',
        provenance: { attempt: 1 },
        legal_basis: { basis: 'CONSENT' },
        arrived_at: ARRIVED_AT,
      });
      const second = await repo.recordArrival({
        tenant_id: TENANT,
        source_channel: 'INDEED',
        external_source_id: 'indeed-dup-777',
        provenance: { attempt: 2 },
        legal_basis: { basis: 'CONSENT' },
        arrived_at: ARRIVED_AT,
      });
      expect(second.id).toBe(first.id);
    });

    it('maps distinct (channel, external id) arrivals to distinct rows', async () => {
      const a = await repo.recordArrival({
        tenant_id: TENANT,
        source_channel: 'GITHUB',
        external_source_id: 'gh-1',
        provenance: {},
        legal_basis: { basis: 'LEGITIMATE_INTEREST' },
        arrived_at: ARRIVED_AT,
      });
      const b = await repo.recordArrival({
        tenant_id: TENANT,
        source_channel: 'GITHUB',
        external_source_id: 'gh-2',
        provenance: {},
        legal_basis: { basis: 'LEGITIMATE_INTEREST' },
        arrived_at: ARRIVED_AT,
      });
      expect(a.id).not.toBe(b.id);
    });

    it('rejects any UPDATE — a sourced arrival is immutable (Spec §2 / the trigger)', async () => {
      const arrival = await repo.recordArrival({
        tenant_id: TENANT,
        source_channel: 'DICE',
        external_source_id: 'dice-immutable-1',
        provenance: { v: 1 },
        legal_basis: { basis: 'LEGITIMATE_INTEREST' },
        arrived_at: ARRIVED_AT,
      });
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "sourced_talent"."SourcedTalent" SET "source_channel" = 'MUTATED' WHERE "id" = '${arrival.id}'`,
        ),
      ).rejects.toThrow();
    });
  },
);
