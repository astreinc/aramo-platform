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
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const JOB_A = '00000000-0000-7000-8000-00000000000a';
const JOB_B = '00000000-0000-7000-8000-00000000000b';
const GOLDEN_A = '00000000-0000-7000-8000-00000000000c';
const REQ_A = '00000000-0000-7000-8000-00000000000d';
const REQ_B = '00000000-0000-7000-8000-00000000000e';
const REQ_C = '00000000-0000-7000-8000-00000000000f';
const RECRUITER_A = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const UNREFERENCED_JOB = '00000000-0000-7000-8000-deadbeef0000';

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

    it('persists and reads back a Requisition carrying its job_id + recruiter_id (anchors 1, 4, 5, 7)', async () => {
      const created = await repo.createRequisition({
        id: REQ_A,
        tenant_id: TENANT_A,
        job_id: JOB_A,
        recruiter_id: RECRUITER_A,
        state: 'active',
      });

      expect(created.id).toBe(REQ_A);
      expect(created.job_id).toBe(JOB_A);
      expect(created.recruiter_id).toBe(RECRUITER_A);
      expect(created.state).toBe('active');

      const read = await repo.findRequisitionById(REQ_A);
      expect(read).not.toBeNull();
      expect(read?.job_id).toBe(JOB_A);
      expect(read?.recruiter_id).toBe(RECRUITER_A);
      expect(read?.state).toBe('active');
    });

    it('accepts both active and inactive Requisition state values (anchor 4)', async () => {
      const inactive = await repo.createRequisition({
        id: REQ_B,
        tenant_id: TENANT_A,
        job_id: JOB_A,
        recruiter_id: RECRUITER_A,
        state: 'inactive',
      });
      expect(inactive.state).toBe('inactive');

      const reread = await repo.findRequisitionById(REQ_B);
      expect(reread?.state).toBe('inactive');
    });

    it('findActiveRequisitionByJobId returns the active requisition for (tenant_id, job_id) (PR-8 §4.2)', async () => {
      // (TENANT_A, JOB_A) has REQ_A (active) and REQ_B (inactive) seeded
      // earlier in this describe block. The bridge method must return the
      // active one.
      const found = await repo.findActiveRequisitionByJobId({
        tenant_id: TENANT_A,
        job_id: JOB_A,
      });
      expect(found).not.toBeNull();
      expect(found?.id).toBe(REQ_A);
      expect(found?.state).toBe('active');
    });

    it('findActiveRequisitionByJobId returns null on tenant mismatch (PR-8 §4.2 — security posture)', async () => {
      const found = await repo.findActiveRequisitionByJobId({
        tenant_id: TENANT_B,
        job_id: JOB_A,
      });
      expect(found).toBeNull();
    });

    it('findActiveRequisitionByJobId returns null when only inactive requisitions exist (PR-8 §4.2)', async () => {
      // Create a tenant + job pair with only an inactive requisition.
      const TENANT_C = '33333333-3333-7333-8333-333333333333';
      const JOB_C = '00000000-0000-7000-8000-0000000000ab';
      await repo.createRequisition({
        id: '00000000-0000-7000-8000-00000000abcd',
        tenant_id: TENANT_C,
        job_id: JOB_C,
        recruiter_id: RECRUITER_A,
        state: 'inactive',
      });
      const found = await repo.findActiveRequisitionByJobId({
        tenant_id: TENANT_C,
        job_id: JOB_C,
      });
      expect(found).toBeNull();
    });

    it('findActiveRequisitionByJobId returns null for an unknown (tenant_id, job_id) (PR-8 §4.2)', async () => {
      const found = await repo.findActiveRequisitionByJobId({
        tenant_id: TENANT_A,
        job_id: '00000000-0000-7000-8000-deadbeef9999',
      });
      expect(found).toBeNull();
    });

    it('allows a Requisition.job_id that does not exist in Job (no FK; anchor 5)', async () => {
      // The migration emits zero FOREIGN KEY constraints — a Requisition
      // may reference an unknown job_id without insert failure. The
      // application layer (and Architecture §9's weekly consistency-check
      // job) is responsible for referential integrity; the schema is not.
      const created = await repo.createRequisition({
        id: REQ_C,
        tenant_id: TENANT_B,
        job_id: UNREFERENCED_JOB,
        recruiter_id: RECRUITER_A,
        state: 'active',
      });
      expect(created.job_id).toBe(UNREFERENCED_JOB);

      const noSuchJob = await repo.findJobById(UNREFERENCED_JOB);
      expect(noSuchJob).toBeNull();
    });
  },
);
