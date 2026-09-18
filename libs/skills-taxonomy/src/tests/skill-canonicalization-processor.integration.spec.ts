import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Test, type TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

import { SkillsTaxonomyModule } from '../lib/skills-taxonomy.module.js';
import { SKILL_CANONICALIZATION_QUEUE_NAME } from '../lib/skill-canonicalization.queue.constants.js';
import { SkillRegistryService } from '../lib/skill-registry.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import type { SkillCanonicalizationScanResult } from '../lib/skill-canonicalization.processor.js';

// SKILL-TAX-1C execution seam — the BullMQ processor resolves a batch of surface
// forms THROUGH the deterministic canonicalization engine (real Redis 7 + real
// Postgres 17). Proves the full path canonicalization job -> processor ->
// SkillCanonicalizationService, and that re-running writes nothing (idempotent,
// read-only).
//
// MIGRATIONS list:
//   - 20260915140000_init_skill_registry
//   - 20260915150000_skill_alias_version
//   - 20260915160000_skill_relationship
const MIGRATIONS = [
  resolve(__dirname, '../../prisma/migrations/20260915140000_init_skill_registry/migration.sql'),
  resolve(__dirname, '../../prisma/migrations/20260915150000_skill_alias_version/migration.sql'),
  resolve(__dirname, '../../prisma/migrations/20260915160000_skill_relationship/migration.sql'),
  // SKILL-TAX-1F-A — Skill.merged_into_skill_id (regen client SELECTs it). Split-safe.
  resolve(__dirname, '../../prisma/migrations/20260917210000_skill_tax_1f_governance/migration.sql'),
  // SKILL-TAX-1F-B2 — governance mutations now write a SkillCorrectionTask atomically;
  // its table is created here (regen client INSERTs it → curated list must include it).
  resolve(__dirname, '../../prisma/migrations/20260918120000_skill_tax_1f_b_governance_proposal_correction/migration.sql'),
];

const ACTOR = { id: '55555555-5555-7555-8555-555555555555', type: 'platform_admin' };

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`waitFor: timed out after ${String(timeoutMs)}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'SkillCanonicalizationProcessor — engine seam (real Redis 7 + Postgres 17)',
  () => {
    let pg: StartedPostgreSqlContainer;
    let redis: StartedRedisContainer;
    let moduleRef: TestingModule;
    let queue: Queue;
    let prisma: PrismaService;
    let savedDbUrl: string | undefined;
    let savedRedisUrl: string | undefined;

    beforeAll(async () => {
      pg = await new PostgreSqlContainer('postgres:17').start();
      redis = await new RedisContainer('redis:7').start();

      savedDbUrl = process.env['DATABASE_URL'];
      savedRedisUrl = process.env['REDIS_URL'];
      process.env['DATABASE_URL'] = pg.getConnectionUri();
      process.env['REDIS_URL'] = redis.getConnectionUrl();

      // Apply migrations.
      const setup = new PrismaService(pg.getConnectionUri());
      await setup.$connect();
      for (const path of MIGRATIONS) {
        for (const stmt of readFileSync(path, 'utf8').split(';')) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setup.$executeRawUnsafe(trimmed);
        }
      }
      await setup.$disconnect();

      // Boot the module — onApplicationBootstrap attaches the worker.
      const built = await Test.createTestingModule({ imports: [SkillsTaxonomyModule] }).compile();
      const app = built.createNestApplication();
      await app.init();
      moduleRef = app as unknown as TestingModule;

      queue = moduleRef.get<Queue>(getQueueToken(SKILL_CANONICALIZATION_QUEUE_NAME));
      prisma = moduleRef.get(PrismaService);

      // Seed canonical taxonomy through the registry service the app uses.
      const service = moduleRef.get(SkillRegistryService);
      const k8s = await service.createSkill({ canonicalName: 'Kubernetes', actor: ACTOR });
      const docker = await service.createSkill({ canonicalName: 'Docker', actor: ACTOR });
      const java = await service.createSkill({ canonicalName: 'Java', actor: ACTOR });
      await service.addAlias({ skillId: k8s.id, alias: 'K8s', aliasType: 'ABBREVIATION', actor: ACTOR });
      await service.addVersion({ skillId: java.id, version: '17', actor: ACTOR });
      await service.addRelationship({
        sourceSkillId: k8s.id,
        targetSkillId: docker.id,
        relationshipType: 'RELATED_TO',
        source: 'ADMIN_CURATED',
        actor: ACTOR,
      });
    }, 180_000);

    afterAll(async () => {
      if (savedDbUrl === undefined) delete process.env['DATABASE_URL'];
      else process.env['DATABASE_URL'] = savedDbUrl;
      if (savedRedisUrl === undefined) delete process.env['REDIS_URL'];
      else process.env['REDIS_URL'] = savedRedisUrl;
      try {
        await queue?.close();
      } catch {
        /* already closed */
      }
      await (moduleRef as unknown as { close?: () => Promise<void> }).close?.();
      await pg?.stop();
      await redis?.stop();
    }, 60_000);

    async function runScan(
      items: Array<{ surfaceForm: string; explicitVersion?: string | null }>,
    ): Promise<SkillCanonicalizationScanResult> {
      const job = await queue.add('scan', { items });
      await waitFor(
        async () => {
          const j = await queue.getJob(job.id as string);
          const state = await j?.getState();
          return state === 'completed' || state === 'failed';
        },
        30_000,
        200,
      );
      const done = await queue.getJob(job.id as string);
      expect(await done?.getState()).toBe('completed');
      return done?.returnvalue as SkillCanonicalizationScanResult;
    }

    it('resolves a batch through the engine (EXACT_CANONICAL / ALIAS / VERSION / UNRESOLVED)', async () => {
      const out = await runScan([
        { surfaceForm: 'Kubernetes' },
        { surfaceForm: 'K8s' },
        { surfaceForm: 'Java', explicitVersion: '17' },
        { surfaceForm: 'UnknownFoo' },
      ]);

      expect(out.total).toBe(4);
      const byForm = Object.fromEntries(out.results.map((r) => [r.surfaceForm, r]));

      expect(byForm['Kubernetes'].status).toBe('RESOLVED');
      expect(byForm['Kubernetes'].matchMethod).toBe('EXACT_CANONICAL');
      expect(byForm['Kubernetes'].canonicalName).toBe('Kubernetes');

      expect(byForm['K8s'].status).toBe('RESOLVED');
      expect(byForm['K8s'].matchMethod).toBe('ALIAS');
      expect(byForm['K8s'].canonicalName).toBe('Kubernetes');

      expect(byForm['Java'].status).toBe('RESOLVED');
      expect(byForm['Java'].matchMethod).toBe('VERSION');
      expect(byForm['Java'].canonicalVersionId).not.toBeNull();

      // Unknown skill resolves to UNRESOLVED and the job still completes safely.
      expect(byForm['UnknownFoo'].status).toBe('UNRESOLVED');
      expect(byForm['UnknownFoo'].canonicalSkillId).toBeNull();

      // No related-skill leakage: a RELATED_TO Docker edge never yields Docker.
      expect(out.results.every((r) => r.canonicalName !== 'Docker')).toBe(true);
    }, 60_000);

    it('is idempotent — re-running the same scan writes no new taxonomy/audit state', async () => {
      const countState = async (): Promise<{ skills: number; audits: number }> => {
        const s = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT COUNT(*)::bigint AS n FROM "skills_taxonomy"."Skill"`,
        );
        const a = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT COUNT(*)::bigint AS n FROM "skills_taxonomy"."SkillAuditEvent"`,
        );
        return { skills: Number(s[0].n), audits: Number(a[0].n) };
      };

      const items = [{ surfaceForm: 'Kubernetes' }, { surfaceForm: 'K8s' }];
      const before = await countState();
      await runScan(items);
      const afterFirst = await countState();
      await runScan(items);
      const afterSecond = await countState();

      // The processor is read-only: neither run mutated taxonomy or audit state.
      expect(afterFirst).toEqual(before);
      expect(afterSecond).toEqual(before);
    }, 60_000);
  },
);
