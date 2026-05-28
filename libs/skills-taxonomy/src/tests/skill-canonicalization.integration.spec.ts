import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Test, type TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

import { SkillsTaxonomyModule } from '../lib/skills-taxonomy.module.js';
import { SKILL_CANONICALIZATION_QUEUE_NAME } from '../lib/skill-canonicalization.queue.constants.js';

// M5 PR-11 §4.5 + §6.24 — skill-canonicalization integration spec
// (PL-66 Category 5 FIRST RATIFICATION USE).
//
// NO-OP framework verification (ADR-0018 Decision 8): spins up real
// Redis 7 testcontainer, boots SkillsTaxonomyModule under Nest DI (so
// the SkillCanonicalizationProcessor's BullMQ worker attaches), enqueues
// a scan job, and asserts:
//   - The job completes (BullMQ round-trip works).
//   - No failures (the no-op handler returns without error).
//
// No Postgres testcontainer required at PR-11 — skill canonicalization
// has no DB writes. Future M6/M7 Skills Taxonomy workstream PR will
// add Postgres + meaningful canonicalization logic + corresponding
// assertions.
//
// MIGRATIONS list: (none at PR-11; no-op framework only)

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'SkillCanonicalizationProcessor — integration (real Redis 7; no-op framework)',
  () => {
    let redisContainer: StartedRedisContainer;
    let moduleRef: TestingModule;
    let skillQueue: Queue;
    let savedRedisUrl: string | undefined;

    beforeAll(async () => {
      redisContainer = await new RedisContainer('redis:7').start();

      savedRedisUrl = process.env['REDIS_URL'];
      process.env['REDIS_URL'] = redisContainer.getConnectionUrl();

      moduleRef = await Test.createTestingModule({
        imports: [SkillsTaxonomyModule],
      }).compile();

      const app = moduleRef.createNestApplication();
      await app.init();
      moduleRef = app as unknown as TestingModule;

      skillQueue = moduleRef.get<Queue>(getQueueToken(SKILL_CANONICALIZATION_QUEUE_NAME));
    }, 120_000);

    afterAll(async () => {
      if (savedRedisUrl === undefined) {
        delete process.env['REDIS_URL'];
      } else {
        process.env['REDIS_URL'] = savedRedisUrl;
      }
      try {
        await skillQueue?.close();
      } catch {
        /* queue may already be closed */
      }
      await (moduleRef as unknown as { close?: () => Promise<void> }).close?.();
      await redisContainer?.stop();
    }, 60_000);

    it('no-op handler completes without failure', async () => {
      await skillQueue.add('daily-scan', {});

      await waitFor(
        async () => {
          const counts = await skillQueue.getJobCounts('completed', 'failed');
          return (counts.completed ?? 0) + (counts.failed ?? 0) >= 1;
        },
        30_000,
        250,
      );

      const counts = await skillQueue.getJobCounts('completed', 'failed');
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
