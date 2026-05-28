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
import { OutboxPublisherRepository } from '../lib/outbox-publisher.repository.js';
import { OUTBOX_PUBLISHER_QUEUE_NAME } from '../lib/outbox-publisher.queue.constants.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// M5 PR-11 §4.3 + §6.24 — outbox-publisher integration spec (PL-66
// Category 5 FIRST RATIFICATION USE).
//
// Spins up Redis 7 + Postgres 17 testcontainers, boots ConsentModule
// (so the OutboxPublisherProcessor worker attaches to the
// 'outbox-publisher' queue), seeds 3 unpublished consent.OutboxEvent
// rows + 1 already-published row, enqueues a tick, and asserts:
//   - All 3 unpublished rows now carry published_at != null.
//   - The pre-published row's published_at is unchanged.
//
// MIGRATIONS list:
//   libs/consent/prisma/migrations/20260429164414_initial_consent_schema/migration.sql

const PR2_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260429164414_initial_consent_schema/migration.sql',
);

const TENANT_A = '11111111-1111-7111-8111-111111111111';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'OutboxPublisherProcessor — integration (real Redis 7 + Postgres 17)',
  () => {
    let redisContainer: StartedRedisContainer;
    let pgContainer: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let moduleRef: TestingModule;
    let publisherQueue: Queue;
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

      publisherQueue = moduleRef.get<Queue>(getQueueToken(OUTBOX_PUBLISHER_QUEUE_NAME));
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
        await publisherQueue?.close();
      } catch {
        /* queue may already be closed by Nest shutdown */
      }
      await (moduleRef as unknown as { close?: () => Promise<void> }).close?.();
      await prisma?.$disconnect();
      await Promise.all([redisContainer?.stop(), pgContainer?.stop()]);
    }, 60_000);

    it('publishes all unpublished outbox rows; leaves already-published rows alone', async () => {
      const preExistingPublishedAt = new Date('2025-01-01T00:00:00Z');

      // Seed: 3 unpublished events.
      for (let i = 0; i < 3; i++) {
        await prisma.outboxEvent.create({
          data: {
            id: uuidv7(),
            tenant_id: TENANT_A,
            event_type: 'consent.granted',
            event_payload: { idx: i } as never,
          },
        });
      }

      // Seed: 1 already-published event.
      const prePublishedId = uuidv7();
      await prisma.outboxEvent.create({
        data: {
          id: prePublishedId,
          tenant_id: TENANT_A,
          event_type: 'consent.granted',
          event_payload: { idx: 'pre' } as never,
          published_at: preExistingPublishedAt,
        },
      });

      await publisherQueue.add('tick', {});

      await waitFor(
        async () => {
          const counts = await publisherQueue.getJobCounts('completed', 'failed');
          return (counts.completed ?? 0) + (counts.failed ?? 0) >= 1;
        },
        30_000,
        250,
      );

      const counts = await publisherQueue.getJobCounts('completed', 'failed');
      expect(counts.failed ?? 0).toBe(0);
      expect(counts.completed ?? 0).toBeGreaterThanOrEqual(1);

      // Assert: 3 newly-published rows + 1 already-published row.
      const allPublished = await prisma.outboxEvent.findMany({
        where: { tenant_id: TENANT_A, published_at: { not: null } },
      });
      expect(allPublished).toHaveLength(4);

      // Assert: pre-existing published_at value is preserved.
      const prePublished = await prisma.outboxEvent.findUnique({
        where: { id: prePublishedId },
      });
      expect(prePublished?.published_at?.getTime()).toBe(preExistingPublishedAt.getTime());
    }, 60_000);

    it('repository unit method markPublished is a no-op on empty input', async () => {
      const repo = moduleRef.get(OutboxPublisherRepository);
      const result = await repo.markPublished({
        event_ids: [],
        published_at: new Date(),
      });
      expect(result).toBe(0);
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
