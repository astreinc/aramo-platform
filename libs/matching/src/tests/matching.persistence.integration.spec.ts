import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ExaminationRepository, PrismaService } from '@aramo/examination';

import { MatchingService } from '../lib/matching.service.js';
import {
  EXAMINATION_VERSION,
  MATCHING_MODEL_VERSION,
  TAXONOMY_VERSION,
} from '../lib/dto/version-pins.js';

import { entrustablePass } from './_input-factory.js';

// M3 PR-2 §3.5 persistence integration test. Runs the engine + service
// against a real Postgres testcontainer; asserts:
//   - the engine result is persisted via PR-1's ExaminationRepository
//   - the row carries the three §3.4 version pins (taken from the
//     typed constants, not the input contract)
//   - the row's tier matches the engine's classification
//   - delta_to_entrustable is null for ENTRUSTABLE; populated otherwise
//
// PR-1's column-scoped immutability trigger remains in force here; no
// post-create UPDATE is attempted (PR-2's persistence is create-only).
//
// Applies PR-1's migration via the dollar-quote-aware splitDdl helper
// because the migration contains a $$...$$ PL/pgSQL trigger body — a
// naive ;-split breaks it (PR-1 §3.4 substrate ruling carried forward).

const PR1_MIGRATION_PATH = resolve(
  __dirname,
  '../../../examination/prisma/migrations/20260517200000_init_examination_model/migration.sql',
);

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'MatchingService — persistence integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let svc: MatchingService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const migrationSql = readFileSync(PR1_MIGRATION_PATH, 'utf8');

      const setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const stmt of splitDdl(migrationSql)) {
        const trimmed = stmt.trim();
        if (trimmed.length === 0) continue;
        await setupClient.$executeRawUnsafe(trimmed);
      }
      await setupClient.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      svc = new MatchingService(new ExaminationRepository(prisma));
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('persists an ENTRUSTABLE snapshot with the three §3.4 version pins and null delta_to_entrustable', async () => {
      const input = entrustablePass({ id: '00000000-0000-7000-8000-0000000000e1' });
      const row = await svc.evaluateAndPersist(input);

      expect(row.id).toBe(input.id);
      expect(row.tier).toBe('ENTRUSTABLE');
      expect(row.examination_version).toBe(EXAMINATION_VERSION);
      expect(row.model_version).toBe(MATCHING_MODEL_VERSION);
      expect(row.taxonomy_version).toBe(TAXONOMY_VERSION);
      expect(row.delta_to_entrustable).toBeNull();
      expect(row.lifecycle_state).toBe('active');
    });

    it('persists a WORTH_CONSIDERING snapshot with delta_to_entrustable.next_tier_target=ENTRUSTABLE', async () => {
      const input = entrustablePass({
        id: '00000000-0000-7000-8000-0000000000e2',
        confidence_indicators_evaluated: {
          evidence_strength: 'low',
          data_completeness: 'high',
          constraint_confidence: 'high',
        },
      });
      const row = await svc.evaluateAndPersist(input);

      expect(row.tier).toBe('WORTH_CONSIDERING');
      expect(row.examination_version).toBe(EXAMINATION_VERSION);
      const delta = row.delta_to_entrustable as {
        current_tier: string;
        next_tier_target: string;
        blockers: string[];
      } | null;
      expect(delta).not.toBeNull();
      expect(delta?.current_tier).toBe('WORTH_CONSIDERING');
      expect(delta?.next_tier_target).toBe('ENTRUSTABLE');
      expect(delta?.blockers).toContain('evidence_strength');
    });

    it('persists a STRETCH snapshot with delta_to_entrustable.next_tier_target=WORTH_CONSIDERING', async () => {
      const input = entrustablePass({
        id: '00000000-0000-7000-8000-0000000000e3',
        constraint_checks_evaluated: {
          location: 'fail',
          work_mode: 'pass',
          rate: 'pass',
          work_authorization: 'pass',
        },
      });
      const row = await svc.evaluateAndPersist(input);

      expect(row.tier).toBe('STRETCH');
      const delta = row.delta_to_entrustable as {
        current_tier: string;
        next_tier_target: string;
        blockers: string[];
      } | null;
      expect(delta?.current_tier).toBe('STRETCH');
      expect(delta?.next_tier_target).toBe('WORTH_CONSIDERING');
      expect(delta?.blockers).toContain('constraint_location');
    });

    it('persists the §2.5 Anita Sharma example as WORTH_CONSIDERING with both soft failures captured', async () => {
      const input = entrustablePass({
        id: '00000000-0000-7000-8000-0000000000e4',
        role_family: 'backend_engineer',
        critical_skills: [
          { name: 'Java', evidence_count: 3, has_ingested_evidence: true },
          { name: 'AWS', evidence_count: 1, has_ingested_evidence: true },
        ],
        confidence_indicators_evaluated: {
          evidence_strength: 'low',
          data_completeness: 'high',
          constraint_confidence: 'high',
        },
      });
      const row = await svc.evaluateAndPersist(input);

      expect(row.tier).toBe('WORTH_CONSIDERING');
      const delta = row.delta_to_entrustable as {
        blockers: string[];
      } | null;
      expect(delta?.blockers.sort()).toEqual(
        ['evidence_strength', 'skill_evidence_count (AWS)'].sort(),
      );
    });
  },
);

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
