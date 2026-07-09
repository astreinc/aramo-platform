import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';

// TR-2a-B1 §6(d) [anchors by evidence join] — the SubjectAnchor.source_class
// migration backfills existing anchor rows from their minting EvidenceRecord via
// source_evidence_id. Proven by seeding anchors (at two different evidence
// classes) BEFORE the migration, then applying it and reading source_class.

const MIGRATIONS_DIR = resolve(__dirname, '../../prisma/migrations');
// init + tr2a1 give ResolutionSubject + EvidenceRecord + SubjectAnchor.
const PRE_MIGRATIONS = [
  '20260628000000_init_talent_trust',
  '20260703120000_tr2a1_subject_anchor',
  // TR-4 B3 — last_consistency_at (the regenerated client SELECTs it on subject reads).
  '20260710120000_tr4_b3_last_consistency_at',
  '20260711120000_tr5_b2_thinness_flags',
];
const SOURCE_CLASS_MIGRATION = '20260706170000_tr2a_b1_subject_anchor_source_class';

// $$-aware splitter (trigger bodies carry semicolons inside $$ … $$).
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

async function applyMigration(client: PrismaService, dir: string): Promise<void> {
  const sql = readFileSync(resolve(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8');
  for (const stmt of splitDdl(sql)) {
    if (stmt.trim().length === 0) continue;
    await client.$executeRawUnsafe(stmt.trim());
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-2a-B1 §6(d) — SubjectAnchor.source_class backfill from minting evidence (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let client: PrismaService;

    const TENANT = '11111111-1111-7111-8111-111111111111';
    const SUBJECT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
    // (anchorId, evidenceId, value, the evidence's source_class to backfill).
    const CASES: Array<[string, string, string, string]> = [
      [uuidv7(), uuidv7(), 'self@example.com', 'SELF'],
      [uuidv7(), uuidv7(), 'unverified@example.com', 'THIRD_PARTY_UNVERIFIED'],
      [uuidv7(), uuidv7(), 'verified@example.com', 'THIRD_PARTY_VERIFIED'],
    ];

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      client = new PrismaService(container.getConnectionUri());
      await client.$connect();

      for (const dir of PRE_MIGRATIONS) {
        await applyMigration(client, dir);
      }

      await client.$executeRawUnsafe(
        `INSERT INTO "talent_trust"."ResolutionSubject" (id, tenant_id) VALUES ($1::uuid, $2::uuid)`,
        SUBJECT,
        TENANT,
      );

      for (const [anchorId, evidenceId, value, sourceClass] of CASES) {
        // The minting evidence carries the class the backfill must project.
        await client.$executeRawUnsafe(
          `INSERT INTO "talent_trust"."EvidenceRecord"
             (id, subject_id, tenant_id, dimension, assertion_type, assertion_payload,
              source_class, method, strength, collected_at, decay_profile,
              portability_class, current_status, created_by)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'IDENTITY', 'EMAIL', $4::jsonb,
                   $5, 'DOCUMENT', 0, NOW(), 'SLOW', 'TENANT_ONLY', 'VALID', 'backfill-test')`,
          evidenceId,
          SUBJECT,
          TENANT,
          JSON.stringify({ normalized_value: value }),
          sourceClass,
        );
        // The anchor exists pre-migration WITHOUT a source_class column.
        await client.$executeRawUnsafe(
          `INSERT INTO "talent_trust"."SubjectAnchor"
             (id, subject_id, tenant_id, anchor_kind, normalized_value, source_evidence_id)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'EMAIL', $4, $5::uuid)`,
          anchorId,
          SUBJECT,
          TENANT,
          value,
          evidenceId,
        );
      }

      // Apply the migration: add column + backfill from the evidence join + NOT NULL.
      await applyMigration(client, SOURCE_CLASS_MIGRATION);
    }, 120_000);

    afterAll(async () => {
      await client?.$disconnect();
      await container?.stop();
    });

    it('backfills each anchor from its minting evidence class via source_evidence_id', async () => {
      for (const [anchorId, , value, expected] of CASES) {
        const rows = await client.$queryRawUnsafe<{ source_class: string }[]>(
          `SELECT source_class FROM "talent_trust"."SubjectAnchor" WHERE id = '${anchorId}'::uuid`,
        );
        expect(rows[0]?.source_class, `value=${value}`).toBe(expected);
      }
    });

    it('enforces NOT NULL after backfill (no anchor left null)', async () => {
      const rows = await client.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*)::bigint AS n FROM "talent_trust"."SubjectAnchor" WHERE source_class IS NULL`,
      );
      expect(Number(rows[0]?.n)).toBe(0);
    });
  },
);
