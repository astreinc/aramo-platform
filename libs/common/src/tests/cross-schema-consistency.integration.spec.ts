import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Test, type TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { Pool } from 'pg';

import { CrossSchemaConsistencyModule } from '../lib/cross-schema-consistency/cross-schema-consistency.module.js';
import { CROSS_SCHEMA_CONSISTENCY_QUEUE_NAME } from '../lib/cross-schema-consistency.queue.constants.js';
import { CrossSchemaConsistencyRepository } from '../lib/cross-schema-consistency.repository.js';

// M5 PR-11 §4.4 + §6.24 — cross-schema-consistency integration spec
// (PL-66 Category 5 FIRST RATIFICATION USE).
//
// Applies 5 schema migrations to a single Postgres testcontainer, seeds
// 1 valid talent + 1 orphaned consent.TalentConsentEvent (whose talent_id
// does NOT match any talent.Talent.id), enqueues a scan job, and asserts:
//   - The cross-schema repository returns orphan_count = 1 for the
//     consent->talent pair.
//   - All other 4 pairs return orphan_count = 0 (empty tables).
//   - The BullMQ-mediated worker run completes without failures.
//
// MIGRATIONS list:
//   libs/consent/prisma/migrations/20260429164414_initial_consent_schema/migration.sql
//   libs/talent/prisma/migrations/20260516085014_init_talent_model/migration.sql
//   libs/engagement/prisma/migrations/20260525120000_init_engagement_model/migration.sql
//   libs/examination/prisma/migrations/20260517200000_init_examination_model/migration.sql
//   libs/job-domain/prisma/migrations/20260519100000_init_job_domain_model/migration.sql

const MIGRATIONS: readonly string[] = [
  resolve(__dirname, '../../../consent/prisma/migrations/20260429164414_initial_consent_schema/migration.sql'),
  resolve(__dirname, '../../../talent/prisma/migrations/20260516085014_init_talent_model/migration.sql'),
  // 4e-engagement-key — the engagement→talent pair now LEFT JOINs
  // talent_record.TalentRecord (was talent.Talent), so the target table must
  // exist. Init only (the orphan scan selects no TalentRecord columns).
  resolve(__dirname, '../../../talent-record/prisma/migrations/20260602120000_init_talent_record_model/migration.sql'),
  resolve(__dirname, '../../../job-domain/prisma/migrations/20260519100000_init_job_domain_model/migration.sql'),
  resolve(__dirname, '../../../engagement/prisma/migrations/20260525120000_init_engagement_model/migration.sql'),
  resolve(__dirname, '../../../examination/prisma/migrations/20260517200000_init_examination_model/migration.sql'),
];

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const VALID_TALENT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaa111';
const ORPHAN_TALENT = 'ffffffff-ffff-7fff-8fff-ffffffffffff';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'CrossSchemaConsistencyProcessor — integration (real Redis 7 + Postgres 17)',
  () => {
    let redisContainer: StartedRedisContainer;
    let pgContainer: StartedPostgreSqlContainer;
    let pgPool: Pool;
    let moduleRef: TestingModule;
    let crossSchemaQueue: Queue;
    let savedRedisUrl: string | undefined;
    let savedDatabaseUrl: string | undefined;

    beforeAll(async () => {
      [redisContainer, pgContainer] = await Promise.all([
        new RedisContainer('redis:7').start(),
        new PostgreSqlContainer('postgres:17').start(),
      ]);

      const pgUrl = pgContainer.getConnectionUri();
      const setupPool = new Pool({ connectionString: pgUrl });
      const setupClient = await setupPool.connect();
      try {
        for (const migrationPath of MIGRATIONS) {
          const sql = readFileSync(migrationPath, 'utf8');
          for (const stmt of splitDdl(sql)) {
            const trimmed = stmt.trim();
            if (trimmed.length === 0) continue;
            await setupClient.query(trimmed);
          }
        }
      } finally {
        setupClient.release();
        await setupPool.end();
      }

      savedRedisUrl = process.env['REDIS_URL'];
      savedDatabaseUrl = process.env['DATABASE_URL'];
      process.env['REDIS_URL'] = redisContainer.getConnectionUrl();
      process.env['DATABASE_URL'] = pgUrl;

      pgPool = new Pool({ connectionString: pgUrl });

      // Gate 5-redux (Option β-1 / PL-88): CrossSchemaConsistencyModule
      // is now self-contained — it registers its own BullModule.forRootAsync
      // with manualRegistration + 5-layer no-network-at-boot config. The
      // spec just imports it; no inline forRoot wiring required.
      moduleRef = await Test.createTestingModule({
        imports: [CrossSchemaConsistencyModule],
      }).compile();

      const app = moduleRef.createNestApplication();
      await app.init();
      moduleRef = app as unknown as TestingModule;

      crossSchemaQueue = moduleRef.get<Queue>(getQueueToken(CROSS_SCHEMA_CONSISTENCY_QUEUE_NAME));
    }, 180_000);

    afterAll(async () => {
      if (savedRedisUrl === undefined) {
        delete process.env['REDIS_URL'];
      } else {
        process.env['REDIS_URL'] = savedRedisUrl;
      }
      if (savedDatabaseUrl === undefined) {
        delete process.env['DATABASE_URL'];
      } else {
        process.env['DATABASE_URL'] = savedDatabaseUrl;
      }
      try {
        await crossSchemaQueue?.close();
      } catch {
        /* queue may already be closed by Nest shutdown */
      }
      await (moduleRef as unknown as { close?: () => Promise<void> }).close?.();
      await pgPool?.end();
      await Promise.all([redisContainer?.stop(), pgContainer?.stop()]);
    }, 60_000);

    it('scanAll detects orphaned consent->talent reference; other pairs return 0', async () => {
      // Seed: 1 valid talent row.
      const client = await pgPool.connect();
      try {
        await client.query(
          'INSERT INTO "talent"."Talent" ("id", "lifecycle_status", "created_at", "updated_at") ' +
            'VALUES ($1, $2, NOW(), NOW())',
          [VALID_TALENT, 'active'],
        );
        // Seed: 1 consent event whose talent_id matches the valid talent.
        await client.query(
          'INSERT INTO "consent"."TalentConsentEvent" ' +
            '("id", "talent_id", "tenant_id", "scope", "action", "captured_method", "consent_version", "occurred_at") ' +
            'VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())',
          [uuidv7(), VALID_TALENT, TENANT_A, 'matching', 'granted', 'self_signup', 'v1'],
        );
        // Seed: 1 consent event whose talent_id is ORPHANED (no matching talent.Talent row).
        await client.query(
          'INSERT INTO "consent"."TalentConsentEvent" ' +
            '("id", "talent_id", "tenant_id", "scope", "action", "captured_method", "consent_version", "occurred_at") ' +
            'VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())',
          [uuidv7(), ORPHAN_TALENT, TENANT_A, 'matching', 'granted', 'self_signup', 'v1'],
        );
      } finally {
        client.release();
      }

      const repo = moduleRef.get(CrossSchemaConsistencyRepository);
      const results = await repo.scanAll({ sample_size: 5 });

      // Find the consent->talent pair result.
      const consentTalentPair = results.find(
        (r) => r.pair_id === 'consent.TalentConsentEvent.talent_id->talent.Talent',
      );
      expect(consentTalentPair).toBeDefined();
      expect(consentTalentPair?.orphan_count).toBe(1);
      expect(consentTalentPair?.samples).toHaveLength(1);
      expect(consentTalentPair?.samples[0]?.missing_foreign_id).toBe(ORPHAN_TALENT);

      // Other pairs have empty tables, so orphan_count should be 0 for each.
      for (const r of results) {
        if (r.pair_id === 'consent.TalentConsentEvent.talent_id->talent.Talent') continue;
        expect(r.orphan_count).toBe(0);
      }
    });

    it('BullMQ queue.add → worker process round-trip completes without failure', async () => {
      await crossSchemaQueue.add('daily-scan', {});

      await waitFor(
        async () => {
          const counts = await crossSchemaQueue.getJobCounts('completed', 'failed');
          return (counts.completed ?? 0) + (counts.failed ?? 0) >= 1;
        },
        30_000,
        250,
      );

      const counts = await crossSchemaQueue.getJobCounts('completed', 'failed');
      expect(counts.failed ?? 0).toBe(0);
      expect(counts.completed ?? 0).toBeGreaterThanOrEqual(1);
    }, 60_000);
  },
);

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`waitFor: predicate did not become true within ${String(timeoutMs)}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

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
