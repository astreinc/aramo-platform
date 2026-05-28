import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Test, type TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';

import { ConsentModule } from '../lib/consent.module.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { StaleConsentRepository } from '../lib/stale-consent.repository.js';
import { STALE_CONSENT_QUEUE_NAME } from '../lib/stale-consent.queue.constants.js';

// M5 PR-11 §4.2 + §6.24 — stale-consent integration spec (PL-66 Category 5
// FIRST RATIFICATION USE).
//
// Spins up real Redis 7 + Postgres 17 testcontainers, boots ConsentModule
// under Nest DI (so the StaleConsentProcessor's BullMQ worker attaches to
// the 'stale-consent' queue), seeds a 13-month-old contacting grant +
// a fresh contacting grant for a different talent, enqueues a scan job,
// and asserts:
//   - The 13-month-old grant produces a new action='expired' row.
//   - The fresh grant remains untouched.
//   - The audit + outbox rows for the expiration are written in the same
//     transaction.
//
// MIGRATIONS list:
//   libs/consent/prisma/migrations/20260429164414_initial_consent_schema/migration.sql

const PR2_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260429164414_initial_consent_schema/migration.sql',
);

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TALENT_STALE = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaa111';
const TALENT_FRESH = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaa222';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'StaleConsentProcessor — integration (real Redis 7 + Postgres 17)',
  () => {
    let redisContainer: StartedRedisContainer;
    let pgContainer: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let moduleRef: TestingModule;
    let staleQueue: Queue;
    let savedRedisUrl: string | undefined;
    let savedDatabaseUrl: string | undefined;

    beforeAll(async () => {
      [redisContainer, pgContainer] = await Promise.all([
        new RedisContainer('redis:7').start(),
        new PostgreSqlContainer('postgres:17').start(),
      ]);

      const pgUrl = pgContainer.getConnectionUri();
      const migrationSql = readFileSync(PR2_MIGRATION_PATH, 'utf8');
      const setupClient = new PrismaService(pgUrl);
      await setupClient.$connect();
      for (const stmt of splitDdl(migrationSql)) {
        const trimmed = stmt.trim();
        if (trimmed.length === 0) continue;
        await setupClient.$executeRawUnsafe(trimmed);
      }
      await setupClient.$disconnect();

      prisma = new PrismaService(pgUrl);
      await prisma.$connect();

      // RedisConnectionConfig reads REDIS_URL via process.env. The same
      // pattern as libs/matching/src/tests/match-queue.integration.spec.ts.
      // Save/restore so other specs aren't perturbed.
      savedRedisUrl = process.env['REDIS_URL'];
      savedDatabaseUrl = process.env['DATABASE_URL'];
      process.env['REDIS_URL'] = redisContainer.getConnectionUrl();
      process.env['DATABASE_URL'] = pgUrl;

      moduleRef = await Test.createTestingModule({
        imports: [ConsentModule],
      })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        .compile();

      const app = moduleRef.createNestApplication();
      await app.init();
      moduleRef = app as unknown as TestingModule;

      staleQueue = moduleRef.get<Queue>(getQueueToken(STALE_CONSENT_QUEUE_NAME));
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
        await staleQueue?.close();
      } catch {
        /* queue may already be closed by Nest shutdown */
      }
      await (moduleRef as unknown as { close?: () => Promise<void> }).close?.();
      await prisma?.$disconnect();
      await Promise.all([redisContainer?.stop(), pgContainer?.stop()]);
    }, 60_000);

    it('marks 13-month-old contacting grant expired; leaves fresh grant untouched', async () => {
      const computedAt = new Date();
      const thirteenMonthsAgo = new Date(computedAt);
      thirteenMonthsAgo.setMonth(thirteenMonthsAgo.getMonth() - 13);

      // Seed: stale contacting grant (13 months old).
      await prisma.talentConsentEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: TENANT_A,
          talent_id: TALENT_STALE,
          scope: 'contacting',
          action: 'granted',
          captured_by_actor_id: null,
          captured_method: 'self_signup',
          consent_version: 'v1',
          occurred_at: thirteenMonthsAgo,
        },
      });

      // Seed: fresh contacting grant (now).
      await prisma.talentConsentEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: TENANT_A,
          talent_id: TALENT_FRESH,
          scope: 'contacting',
          action: 'granted',
          captured_by_actor_id: null,
          captured_method: 'self_signup',
          consent_version: 'v1',
          occurred_at: computedAt,
        },
      });

      // Enqueue scan job.
      await staleQueue.add('daily-scan', {});

      // Poll until the worker completes the job.
      await waitFor(
        async () => {
          const counts = await staleQueue.getJobCounts('completed', 'failed');
          return (counts.completed ?? 0) + (counts.failed ?? 0) >= 1;
        },
        30_000,
        250,
      );

      const counts = await staleQueue.getJobCounts('completed', 'failed');
      expect(counts.failed ?? 0).toBe(0);
      expect(counts.completed ?? 0).toBeGreaterThanOrEqual(1);

      // Assert: stale talent now has an action='expired' row.
      const staleExpired = await prisma.talentConsentEvent.findMany({
        where: { tenant_id: TENANT_A, talent_id: TALENT_STALE, action: 'expired' },
      });
      expect(staleExpired).toHaveLength(1);

      // Assert: fresh talent has NO expired row.
      const freshExpired = await prisma.talentConsentEvent.findMany({
        where: { tenant_id: TENANT_A, talent_id: TALENT_FRESH, action: 'expired' },
      });
      expect(freshExpired).toHaveLength(0);

      // Assert: paired audit + outbox rows written.
      const auditExpired = await prisma.consentAuditEvent.findMany({
        where: {
          tenant_id: TENANT_A,
          subject_id: TALENT_STALE,
          event_type: 'consent.expired.recorded',
        },
      });
      expect(auditExpired).toHaveLength(1);

      const outboxExpired = await prisma.outboxEvent.findMany({
        where: { tenant_id: TENANT_A, event_type: 'consent.expired' },
      });
      expect(outboxExpired).toHaveLength(1);
    }, 60_000);

    it('repository unit method findStaleContactingGrants returns only stale rows', async () => {
      const repo = moduleRef.get(StaleConsentRepository);
      const computedAt = new Date();
      const cutoff = new Date(computedAt);
      cutoff.setMonth(cutoff.getMonth() - 12);

      const stale = await repo.findStaleContactingGrants({ cutoff, computedAt });
      // After the prior test, the stale talent's latest event is 'expired'
      // (not 'granted'), so it should NOT be returned by this scan.
      const staleTalentIds = stale.map((s) => s.talent_id);
      expect(staleTalentIds).not.toContain(TALENT_STALE);
      expect(staleTalentIds).not.toContain(TALENT_FRESH);
    });
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
