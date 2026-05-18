import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Test, type TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { ExaminationRepository, PrismaService } from '@aramo/examination';

import { MatchingModule } from '../lib/matching.module.js';
import { MATCH_QUEUE_NAME } from '../lib/match-queue.constants.js';
import { MatchingService } from '../lib/matching.service.js';

import { entrustablePass } from './_input-factory.js';

// M3 PR-3 §4.9 — match-queue integration test. Brings up Postgres + Redis
// testcontainers, boots MatchingModule under Nest DI (so BullModule
// constructs the queue + the @Processor wires the worker), enqueues a
// MatchingAnalysisInput onto the "match" queue, and asserts:
//   - MatchingService.evaluateAndPersist is invoked by the worker
//   - a TalentJobExamination row is persisted via ExaminationRepository
//
// The enqueue path here is test-only. The production "Talent updated →
// matching scheduled" trigger is OUT of scope per directive §5.
//
// Postgres is required because evaluateAndPersist writes through PR-1's
// ExaminationRepository; the spec applies PR-1's init migration via the
// same dollar-quote-aware splitDdl helper the existing
// matching.persistence.integration.spec uses (the migration contains a
// $$...$$ PL/pgSQL trigger body).

const PR1_MIGRATION_PATH = resolve(
  __dirname,
  '../../../examination/prisma/migrations/20260517200000_init_examination_model/migration.sql',
);

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'MatchingModule — match-queue integration (real Redis 7 + Postgres 17)',
  () => {
    let redisContainer: StartedRedisContainer;
    let pgContainer: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let moduleRef: TestingModule;
    let matchQueue: Queue;
    let evaluateAndPersistSpy: ReturnType<typeof vi.spyOn>;
    let savedRedisUrl: string | undefined;

    beforeAll(async () => {
      [redisContainer, pgContainer] = await Promise.all([
        new RedisContainer('redis:7').start(),
        new PostgreSqlContainer('postgres:17').start(),
      ]);

      const pgUrl = pgContainer.getConnectionUri();
      const migrationSql = readFileSync(PR1_MIGRATION_PATH, 'utf8');
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

      // RedisConnectionConfig reads REDIS_URL via process.env; the
      // testcontainer is the live target. (Saved/restored in afterAll.)
      savedRedisUrl = process.env['REDIS_URL'];
      process.env['REDIS_URL'] = redisContainer.getConnectionUrl();

      // Replace the examination-owned PrismaService so the repository
      // writes to the testcontainer Postgres rather than constructing a
      // second connection from process.env.DATABASE_URL.
      moduleRef = await Test.createTestingModule({
        imports: [MatchingModule],
      })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        .compile();

      const app = moduleRef.createNestApplication();
      await app.init();
      moduleRef = app as unknown as TestingModule;

      // Spy on the real MatchingService instance Nest constructed so we
      // can assert the worker actually invoked evaluateAndPersist.
      const matching = moduleRef.get(MatchingService);
      evaluateAndPersistSpy = vi.spyOn(matching, 'evaluateAndPersist');

      matchQueue = moduleRef.get<Queue>(getQueueToken(MATCH_QUEUE_NAME));
    }, 180_000);

    afterAll(async () => {
      // Restore REDIS_URL before tearing connections down.
      if (savedRedisUrl === undefined) {
        delete process.env['REDIS_URL'];
      } else {
        process.env['REDIS_URL'] = savedRedisUrl;
      }
      try {
        await matchQueue?.close();
      } catch {
        /* queue may already be closed by Nest shutdown */
      }
      await (moduleRef as unknown as { close?: () => Promise<void> }).close?.();
      await prisma?.$disconnect();
      await Promise.all([redisContainer?.stop(), pgContainer?.stop()]);
    }, 60_000);

    it('worker consumes a match-queue job, invokes MatchingService.evaluateAndPersist, and persists a TalentJobExamination row', async () => {
      const input = entrustablePass({ id: '00000000-0000-7000-8000-0000000000f1' });

      await matchQueue.add('evaluate', input);

      await waitFor(
        async () => {
          const counts = await matchQueue.getJobCounts('completed', 'failed');
          return (counts.completed ?? 0) + (counts.failed ?? 0) >= 1;
        },
        30_000,
        250,
      );

      const counts = await matchQueue.getJobCounts('completed', 'failed');
      expect(counts.failed ?? 0).toBe(0);
      expect(counts.completed ?? 0).toBeGreaterThanOrEqual(1);

      expect(evaluateAndPersistSpy).toHaveBeenCalledTimes(1);
      const callArg = evaluateAndPersistSpy.mock.calls[0]?.[0] as {
        id: string;
      };
      expect(callArg.id).toBe(input.id);

      const repo = moduleRef.get(ExaminationRepository);
      const row = await repo.findById(input.id);
      expect(row).not.toBeNull();
      expect(row?.tier).toBe('ENTRUSTABLE');
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
