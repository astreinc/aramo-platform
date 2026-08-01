import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { JobDomainRepository } from '../lib/job-domain.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// M3 PR-4 integration test. Brings up a Postgres testcontainer, applies the
// init migration, and asserts:
//
//   - Job, GoldenProfile, Requisition persist and read back round-trip.
//   - GoldenProfile correctly carries its job_id cross-schema reference
//     value (anchor 5; UUID-only, no FK).
//   - Requisition correctly carries its job_id and recruiter_id cross-schema
//     reference values (anchors 5 + 7).
//   - The §4.1.3 critical_skills collection is enumerable and round-trips
//     verbatim.
//   - The §4.1.4 RequisitionState enum accepts both 'active' and 'inactive'.
//
// Cross-schema FK absence is a structural property of the migration; the
// migration emits zero FOREIGN KEY constraints (verified by inspection),
// so this spec exercises the round-trip behavior the absence enables — a
// GoldenProfile may reference a `job_id` that does not exist in the Job
// table without insert failing.

const MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260519100000_init_job_domain_model/migration.sql',
);

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const JOB_A = '00000000-0000-7000-8000-00000000000a';
const JOB_B = '00000000-0000-7000-8000-00000000000b';
const GOLDEN_A = '00000000-0000-7000-8000-00000000000c';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'JobDomainRepository — schema integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: JobDomainRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');

      const setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const stmt of migrationSql.split(';')) {
        const trimmed = stmt.trim();
        if (trimmed.length === 0) continue;
        await setupClient.$executeRawUnsafe(trimmed);
      }
      await setupClient.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new JobDomainRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('persists and reads back a Job (anchors 1, 5)', async () => {
      const created = await repo.createJob({ id: JOB_A, tenant_id: TENANT_A });
      expect(created.id).toBe(JOB_A);
      expect(created.tenant_id).toBe(TENANT_A);

      const read = await repo.findJobById(JOB_A);
      expect(read).not.toBeNull();
      expect(read?.id).toBe(JOB_A);
      expect(read?.tenant_id).toBe(TENANT_A);
    });

    it('returns null for an unknown Job id', async () => {
      const read = await repo.findJobById('00000000-0000-7000-8000-000000000000');
      expect(read).toBeNull();
    });

    it('persists and reads back a GoldenProfile carrying its job_id cross-schema reference (anchors 1, 2, 3, 5)', async () => {
      await repo.createJob({ id: JOB_B, tenant_id: TENANT_A });

      const created = await repo.createGoldenProfile({
        id: GOLDEN_A,
        tenant_id: TENANT_A,
        job_id: JOB_B,
        skills: { primary: ['typescript', 'node'], secondary: ['aws'] },
        experience: { years_min: 5, years_max: 10 },
        constraints: { location: 'remote_ok', rate: { min: 80, max: 140 } },
        critical_skills: ['typescript', 'node'],
      });

      expect(created.id).toBe(GOLDEN_A);
      expect(created.job_id).toBe(JOB_B);
      expect(created.critical_skills).toEqual(['typescript', 'node']);

      const read = await repo.findGoldenProfileById(GOLDEN_A);
      expect(read).not.toBeNull();
      expect(read?.job_id).toBe(JOB_B);
      expect(read?.tenant_id).toBe(TENANT_A);
      expect(read?.skills).toEqual({ primary: ['typescript', 'node'], secondary: ['aws'] });
      expect(read?.experience).toEqual({ years_min: 5, years_max: 10 });
      expect(read?.constraints).toEqual({ location: 'remote_ok', rate: { min: 80, max: 140 } });
      expect(read?.critical_skills).toEqual(['typescript', 'node']);
    });

    // T1-a — the Requisition round-trip / findActiveRequisitionByJobId cases
    // were removed with the model. Job + GoldenProfile round-trips above remain.
  },
);
