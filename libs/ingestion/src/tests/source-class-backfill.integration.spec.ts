import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';

// TR-2a-B1 §6(d) [payloads by channel] — the RawPayloadReference.source_class
// migration backfills existing rows from their `source` via the channel map,
// fail-closed to THIRD_PARTY_UNVERIFIED. Proven by seeding rows BEFORE the
// source_class migration, then applying it and reading the backfilled column.

const MIGRATIONS_DIR = resolve(__dirname, '../../prisma/migrations');
const SOURCE_CLASS_DIR = '20260706170000_add_source_class_to_raw_payload_reference';

function migrationDirs(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d+_/.test(d.name))
    .map((d) => d.name)
    .sort();
}

function splitDdl(sql: string): string[] {
  const noLineComments = sql.replace(/--[^\n]*$/gm, '');
  return noLineComments
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function applyMigration(client: PrismaService, dir: string): Promise<void> {
  const sql = readFileSync(resolve(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8');
  for (const stmt of splitDdl(sql)) {
    await client.$executeRawUnsafe(stmt);
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-2a-B1 §6(d) — RawPayloadReference.source_class backfill (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let client: PrismaService;

    // (source, expected backfilled class) — talent_direct → SELF; the rest and
    // any unmapped source → the fail-closed THIRD_PARTY_UNVERIFIED default.
    const SEEDS: Array<[string, string, string]> = [
      [uuidv7(), 'talent_direct', 'SELF'],
      [uuidv7(), 'github', 'THIRD_PARTY_UNVERIFIED'],
      [uuidv7(), 'astre_import', 'THIRD_PARTY_UNVERIFIED'],
      [uuidv7(), 'indeed', 'THIRD_PARTY_UNVERIFIED'],
      [uuidv7(), 'a_future_unmapped_channel', 'THIRD_PARTY_UNVERIFIED'],
    ];

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      client = new PrismaService(container.getConnectionUri());
      await client.$connect();

      // Apply every ingestion migration BEFORE the source_class one.
      for (const dir of migrationDirs().filter((d) => d < SOURCE_CLASS_DIR)) {
        await applyMigration(client, dir);
      }

      // Seed rows while the column does NOT yet exist (pre-migration state).
      const tenantId = uuidv7();
      for (let i = 0; i < SEEDS.length; i++) {
        const [id, source] = SEEDS[i]!;
        await client.$executeRawUnsafe(
          `INSERT INTO "ingestion"."RawPayloadReference"
             (id, tenant_id, source, storage_ref, sha256, content_type, captured_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, NOW(), NOW())`,
          id,
          tenantId,
          source,
          's3://x/' + source + '.json',
          // Distinct sha per row — the (tenant_id, sha256) unique key forbids dups.
          String(i).padEnd(64, '0').replace(/[^0-9a-f]/gi, 'a').toLowerCase(),
          'application/json',
        );
      }

      // Now apply the source_class migration (adds column + backfills + NOT NULL).
      await applyMigration(client, SOURCE_CLASS_DIR);
    }, 120_000);

    afterAll(async () => {
      await client?.$disconnect();
      await container?.stop();
    });

    it('backfills each seeded row from its channel via the map (fail-closed default)', async () => {
      for (const [id, source, expected] of SEEDS) {
        const rows = await client.$queryRawUnsafe<{ source_class: string }[]>(
          `SELECT source_class FROM "ingestion"."RawPayloadReference" WHERE id = '${id}'::uuid`,
        );
        expect(rows[0]?.source_class, `source=${source}`).toBe(expected);
      }
    });

    it('enforces NOT NULL after backfill (no row left null)', async () => {
      const rows = await client.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*)::bigint AS n FROM "ingestion"."RawPayloadReference" WHERE source_class IS NULL`,
      );
      expect(Number(rows[0]?.n)).toBe(0);
    });
  },
);
