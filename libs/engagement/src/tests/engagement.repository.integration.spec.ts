import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { AramoError, makeMockLogger } from '@aramo/common';
import {
  ExaminationRepository,
  PrismaService as ExaminationPrismaService,
} from '@aramo/examination';
import {
  JobDomainRepository,
  PrismaService as JobDomainPrismaService,
} from '@aramo/job-domain';
import {
  TalentRepository,
  PrismaService as TalentPrismaService,
} from '@aramo/talent';

import { EngagementRepository } from '../lib/engagement.repository.js';
import { EngagementEventRepository } from '../lib/engagement-event.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// M5 PR-1 §4.9 + M5 PR-3 §4.6 — integration spec for libs/engagement.
//
// Brings up a Postgres 17 testcontainer, applies the engagement init
// migration (PR-1) + the three cross-schema lib migrations needed for
// PR-3 write-path validators (talent + job-domain + examination init),
// constructs EngagementRepository with all real cross-schema deps wired,
// and asserts:
//   PR-1 read-path scope: 8 tests (findById round-trip, null on unknown,
//     nullable examination_id projection, tenant-scoped lookups, sorted
//     reads, tenant isolation).
//   PR-3 write-path scope: createEngagement happy + 5 validator refusal
//     paths + atomicity; transitionState happy + illegal-transition +
//     DB-trigger defense + tenant isolation; initial-state-and-event
//     assertions.

const ENGAGEMENT_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260525120000_init_engagement_model/migration.sql',
);
const ENGAGEMENT_EVENT_LOG_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260525150000_add_engagement_event_log/migration.sql',
);
const TALENT_MIGRATION_PATH = resolve(
  __dirname,
  '../../../talent/prisma/migrations/20260516085014_init_talent_model/migration.sql',
);
const JOB_DOMAIN_MIGRATION_PATH = resolve(
  __dirname,
  '../../../job-domain/prisma/migrations/20260519100000_init_job_domain_model/migration.sql',
);
const EXAMINATION_INIT_MIGRATION_PATH = resolve(
  __dirname,
  '../../../examination/prisma/migrations/20260517200000_init_examination_model/migration.sql',
);

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const TALENT_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const TALENT_B = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaa999';
const REQUISITION_A = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const REQUISITION_B = 'cccccccc-cccc-7ccc-8ccc-ccccccccc999';
const JOB_ID = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
const GOLDEN_PROFILE_ID = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const EXAM_A = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const EXAM_TENANT_B = 'dddddddd-dddd-7ddd-8ddd-ddddddddd999';

// PR-1 read-path seeded engagements.
const ENGAGEMENT_1 = '00000000-0000-7000-8000-000000000001';
const ENGAGEMENT_2 = '00000000-0000-7000-8000-000000000002';
const ENGAGEMENT_3 = '00000000-0000-7000-8000-000000000003';
const ENGAGEMENT_TENANT_B = '00000000-0000-7000-8000-000000000004';

// PR-3 write-path scenario UUIDs. Final group must be exactly 12 hex
// chars per evidence.repository UUID_REGEX validation (also applied in
// engagement.repository.validateCreateInput).
const CREATE_HAPPY_ID = '00000000-0000-7000-8000-cccc00000001';
const CREATE_HAPPY_EVENT_ID = '00000000-0000-7000-8000-eeeec0000001';
const CREATE_TALENT_REFUSE_ID = '00000000-0000-7000-8000-cccc00000002';
const CREATE_REQ_NULL_ID = '00000000-0000-7000-8000-cccc00000003';
const CREATE_REQ_XTENANT_ID = '00000000-0000-7000-8000-cccc00000004';
const CREATE_EXAM_NULL_ID = '00000000-0000-7000-8000-cccc00000005';
const CREATE_EXAM_XTENANT_ID = '00000000-0000-7000-8000-cccc00000006';
const CREATE_NO_EXAM_ID = '00000000-0000-7000-8000-cccc00000007';
const CREATE_NO_EXAM_EVENT_ID = '00000000-0000-7000-8000-eeeec0000007';

const TRANSITION_HAPPY_ID = '00000000-0000-7000-8000-dddd00000001';
const TRANSITION_HAPPY_EVENT_ID = '00000000-0000-7000-8000-eeeed0000001';
const TRANSITION_ILLEGAL_ID = '00000000-0000-7000-8000-dddd00000002';
const TRANSITION_ILLEGAL_EVENT_ID = '00000000-0000-7000-8000-eeeed0000002';
const TRANSITION_DBTRIG_ID = '00000000-0000-7000-8000-dddd00000003';
const TRANSITION_XTENANT_ID = '00000000-0000-7000-8000-dddd00000004';
const TRANSITION_XTENANT_EVENT_ID = '00000000-0000-7000-8000-eeeed0000004';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'EngagementRepository — read + write integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let talentPrisma: TalentPrismaService;
    let jobDomainPrisma: JobDomainPrismaService;
    let examPrisma: ExaminationPrismaService;
    let repo: EngagementRepository;
    let setupClient: PrismaService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const migrations = [
        readFileSync(ENGAGEMENT_MIGRATION_PATH, 'utf8'),
        readFileSync(ENGAGEMENT_EVENT_LOG_MIGRATION_PATH, 'utf8'),
        readFileSync(TALENT_MIGRATION_PATH, 'utf8'),
        readFileSync(JOB_DOMAIN_MIGRATION_PATH, 'utf8'),
        readFileSync(EXAMINATION_INIT_MIGRATION_PATH, 'utf8'),
      ];

      setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const sql of migrations) {
        for (const stmt of splitDdl(sql)) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setupClient.$executeRawUnsafe(trimmed);
        }
      }

      prisma = new PrismaService(url);
      await prisma.$connect();
      talentPrisma = new TalentPrismaService(url);
      await talentPrisma.$connect();
      jobDomainPrisma = new JobDomainPrismaService(url);
      await jobDomainPrisma.$connect();
      examPrisma = new ExaminationPrismaService(url);
      await examPrisma.$connect();

      const talentRepo = new TalentRepository(talentPrisma);
      const jobDomainRepo = new JobDomainRepository(jobDomainPrisma);
      const examRepo = new ExaminationRepository(examPrisma, undefined as never);
      const engagementEventRepo = new EngagementEventRepository(prisma, makeMockLogger());
      repo = new EngagementRepository(
        prisma,
        engagementEventRepo,
        talentRepo,
        jobDomainRepo,
        examRepo,
        makeMockLogger(),
      );

      // ---- PR-1 read-path seeds (engagement-only) ---------------------
      await seedEngagement(setupClient, {
        id: ENGAGEMENT_1,
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        requisition_id: REQUISITION_A,
        examination_id: EXAM_A,
        state: 'surfaced',
        created_at: '2026-05-23T10:00:00Z',
      });
      await seedEngagement(setupClient, {
        id: ENGAGEMENT_2,
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        requisition_id: REQUISITION_A,
        examination_id: null,
        state: 'evaluated',
        created_at: '2026-05-24T10:00:00Z',
      });
      await seedEngagement(setupClient, {
        id: ENGAGEMENT_3,
        tenant_id: TENANT_A,
        talent_id: TALENT_B,
        requisition_id: REQUISITION_B,
        examination_id: EXAM_A,
        state: 'engaged',
        created_at: '2026-05-25T10:00:00Z',
      });
      await seedEngagement(setupClient, {
        id: ENGAGEMENT_TENANT_B,
        tenant_id: TENANT_B,
        talent_id: TALENT_A,
        requisition_id: REQUISITION_A,
        examination_id: null,
        state: 'surfaced',
        created_at: '2026-05-24T10:00:00Z',
      });

      // ---- PR-3 write-path seeds (cross-schema) -----------------------
      // Talent core (tenant-agnostic) + per-tenant overlays.
      await seedTalent(setupClient, TALENT_A);
      await seedTalent(setupClient, TALENT_B);
      await seedTalentOverlay(setupClient, {
        talent_id: TALENT_A,
        tenant_id: TENANT_A,
      });
      // No overlay for TALENT_A in TENANT_B → Pattern C refusal test.
      await seedTalentOverlay(setupClient, {
        talent_id: TALENT_B,
        tenant_id: TENANT_A,
      });

      // Job + Requisition (TENANT_A).
      await seedJob(setupClient, { id: JOB_ID, tenant_id: TENANT_A });
      await seedRequisition(setupClient, {
        id: REQUISITION_A,
        tenant_id: TENANT_A,
        job_id: JOB_ID,
      });
      await seedRequisition(setupClient, {
        id: REQUISITION_B,
        tenant_id: TENANT_A,
        job_id: JOB_ID,
      });

      // Examination (TENANT_A) + cross-tenant Examination for Pattern B.
      await seedExamination(setupClient, {
        id: EXAM_A,
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        job_id: JOB_ID,
      });
      await seedExamination(setupClient, {
        id: EXAM_TENANT_B,
        tenant_id: TENANT_B,
        talent_id: TALENT_A,
        job_id: JOB_ID,
      });

      // Pre-seed engagement rows for transitionState tests (avoid coupling
      // to createEngagement happy path which is its own test).
      await seedEngagement(setupClient, {
        id: TRANSITION_HAPPY_ID,
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        requisition_id: REQUISITION_A,
        examination_id: null,
        state: 'surfaced',
        created_at: '2026-05-25T12:00:00Z',
      });
      await seedEngagement(setupClient, {
        id: TRANSITION_ILLEGAL_ID,
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        requisition_id: REQUISITION_A,
        examination_id: null,
        state: 'surfaced',
        created_at: '2026-05-25T12:00:00Z',
      });
      await seedEngagement(setupClient, {
        id: TRANSITION_DBTRIG_ID,
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        requisition_id: REQUISITION_A,
        examination_id: null,
        state: 'surfaced',
        created_at: '2026-05-25T12:00:00Z',
      });
      await seedEngagement(setupClient, {
        id: TRANSITION_XTENANT_ID,
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        requisition_id: REQUISITION_A,
        examination_id: null,
        state: 'surfaced',
        created_at: '2026-05-25T12:00:00Z',
      });
    }, 240_000);

    afterAll(async () => {
      await setupClient?.$disconnect();
      await prisma?.$disconnect();
      await talentPrisma?.$disconnect();
      await jobDomainPrisma?.$disconnect();
      await examPrisma?.$disconnect();
      await container?.stop();
    });

    // =====================================================================
    // PR-1 READ-PATH TESTS (8) — unchanged in behavior; constructor sig
    // updated above.
    // =====================================================================

    it('findById returns the row and projects the typed view shape', async () => {
      const view = await repo.findById(ENGAGEMENT_1);
      expect(view).not.toBeNull();
      expect(view?.id).toBe(ENGAGEMENT_1);
      expect(view?.tenant_id).toBe(TENANT_A);
      expect(view?.talent_id).toBe(TALENT_A);
      expect(view?.requisition_id).toBe(REQUISITION_A);
      expect(view?.examination_id).toBe(EXAM_A);
      expect(view?.state).toBe('surfaced');
      expect(view?.created_at).toBeInstanceOf(Date);
    });

    it('findById returns null on unknown id', async () => {
      const view = await repo.findById('99999999-9999-7999-8999-999999999999');
      expect(view).toBeNull();
    });

    it('findById projects nullable examination_id as null', async () => {
      const view = await repo.findById(ENGAGEMENT_2);
      expect(view).not.toBeNull();
      expect(view?.examination_id).toBeNull();
    });

    it('findByTenantAndId is tenant-scoped (cross-tenant returns null)', async () => {
      const hit = await repo.findByTenantAndId({
        tenant_id: TENANT_A,
        id: ENGAGEMENT_1,
      });
      expect(hit).not.toBeNull();
      expect(hit?.id).toBe(ENGAGEMENT_1);

      const miss = await repo.findByTenantAndId({
        tenant_id: TENANT_B,
        id: ENGAGEMENT_1,
      });
      expect(miss).toBeNull();
    });

    it('findByTenantAndTalent returns DESC by created_at and filters by tenant', async () => {
      const views = await repo.findByTenantAndTalent({
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
      });
      // 2 PR-1-seeded (ENGAGEMENT_1, ENGAGEMENT_2) + 4 PR-3-seeded for
      // transition tests (TRANSITION_HAPPY/ILLEGAL/DBTRIG/XTENANT, all
      // surfaced/TALENT_A/TENANT_A). Ordering: PR-3 seeds (most recent)
      // first, then PR-1 ENGAGEMENT_2, then PR-1 ENGAGEMENT_1.
      expect(views.length).toBeGreaterThanOrEqual(2);
      // Spot-check the chronological-DESC ordering invariant on the two
      // earliest seeds.
      const idsInOrder = views.map((v) => v.id);
      const idx1 = idsInOrder.indexOf(ENGAGEMENT_1);
      const idx2 = idsInOrder.indexOf(ENGAGEMENT_2);
      expect(idx2).toBeGreaterThanOrEqual(0);
      expect(idx1).toBeGreaterThan(idx2);
    });

    it('findByTenantAndTalent returns [] for unknown talent', async () => {
      const views = await repo.findByTenantAndTalent({
        tenant_id: TENANT_A,
        talent_id: '99999999-9999-7999-8999-999999999999',
      });
      expect(views).toEqual([]);
    });

    it('findByTenantAndRequisition returns DESC by created_at and filters by tenant', async () => {
      const views = await repo.findByTenantAndRequisition({
        tenant_id: TENANT_A,
        requisition_id: REQUISITION_A,
      });
      // ENGAGEMENT_1 + ENGAGEMENT_2 + 4 PR-3-seeded engagements all on
      // (TENANT_A, REQUISITION_A). DESC ordering invariant verified on
      // the two PR-1 seeds.
      expect(views.length).toBeGreaterThanOrEqual(2);
      const idsInOrder = views.map((v) => v.id);
      const idx1 = idsInOrder.indexOf(ENGAGEMENT_1);
      const idx2 = idsInOrder.indexOf(ENGAGEMENT_2);
      expect(idx1).toBeGreaterThan(idx2);
    });

    it('findByTenantAndRequisition cross-tenant isolation', async () => {
      const tenantBViews = await repo.findByTenantAndRequisition({
        tenant_id: TENANT_B,
        requisition_id: REQUISITION_A,
      });
      // Tenant B has 1 row for REQUISITION_A (ENGAGEMENT_TENANT_B);
      // tenant A's rows for the same requisition not visible.
      expect(tenantBViews).toHaveLength(1);
      expect(tenantBViews[0]?.id).toBe(ENGAGEMENT_TENANT_B);
      expect(tenantBViews[0]?.tenant_id).toBe(TENANT_B);
    });

    // =====================================================================
    // PR-3 WRITE-PATH TESTS — createEngagement (8 scenarios)
    // =====================================================================

    it('createEngagement happy path — all 3 validators pass; both rows persist', async () => {
      const result = await repo.createEngagement({
        id: CREATE_HAPPY_ID,
        event_id: CREATE_HAPPY_EVENT_ID,
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        requisition_id: REQUISITION_A,
        examination_id: EXAM_A,
      });
      expect(result.engagement.id).toBe(CREATE_HAPPY_ID);
      expect(result.engagement.state).toBe('surfaced');
      expect(result.event.id).toBe(CREATE_HAPPY_EVENT_ID);

      // Verify both rows persisted via direct re-read.
      const eRow = await repo.findById(CREATE_HAPPY_ID);
      expect(eRow?.id).toBe(CREATE_HAPPY_ID);
      const evRows = await setupClient.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM engagement."TalentEngagementEvent" WHERE id = '${CREATE_HAPPY_EVENT_ID}'::uuid`,
      );
      expect(Number(evRows[0]?.count ?? 0n)).toBe(1);
    });

    it('createEngagement Pattern C refusal — talent overlay absent → ENGAGEMENT_REFERENCE_NOT_FOUND 422; no rows', async () => {
      // TALENT_A has no overlay in TENANT_B → findOverlayByTenant returns null.
      const promise = repo.createEngagement({
        id: CREATE_TALENT_REFUSE_ID,
        event_id: '00000000-0000-7000-8000-eeeec0000002',
        tenant_id: TENANT_B,
        talent_id: TALENT_A,
        requisition_id: REQUISITION_A,
        examination_id: null,
      });
      await expect(promise).rejects.toBeInstanceOf(AramoError);
      try {
        await promise;
      } catch (err) {
        const e = err as AramoError;
        expect(e.code).toBe('ENGAGEMENT_REFERENCE_NOT_FOUND');
        expect(e.statusCode).toBe(422);
        expect(e.context.details?.['field']).toBe('talent_id');
      }
      // No rows written (atomicity / fail-fast before $transaction).
      const noEng = await repo.findById(CREATE_TALENT_REFUSE_ID);
      expect(noEng).toBeNull();
    });

    it('createEngagement Pattern A refusal — requisition absent → ENGAGEMENT_REFERENCE_NOT_FOUND 422', async () => {
      const ghostReq = '99999999-9999-7999-8999-999999999999';
      const promise = repo.createEngagement({
        id: CREATE_REQ_NULL_ID,
        event_id: '00000000-0000-7000-8000-eeeec0000003',
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        requisition_id: ghostReq,
        examination_id: null,
      });
      await expect(promise).rejects.toBeInstanceOf(AramoError);
      try {
        await promise;
      } catch (err) {
        const e = err as AramoError;
        expect(e.code).toBe('ENGAGEMENT_REFERENCE_NOT_FOUND');
        expect(e.context.details?.['field']).toBe('requisition_id');
      }
      const noEng = await repo.findById(CREATE_REQ_NULL_ID);
      expect(noEng).toBeNull();
    });

    it('createEngagement Pattern A refusal — requisition cross-tenant → ENGAGEMENT_REFERENCE_NOT_FOUND 422', async () => {
      // Seed a TENANT_B requisition; lookup from TENANT_A finds the row
      // but row.tenant_id mismatch → refuse.
      const reqTenantB = 'cccccccc-cccc-7ccc-8ccc-ccccccccc000';
      await seedRequisition(setupClient, {
        id: reqTenantB,
        tenant_id: TENANT_B,
        job_id: JOB_ID,
      });
      const promise = repo.createEngagement({
        id: CREATE_REQ_XTENANT_ID,
        event_id: '00000000-0000-7000-8000-eeeec0000004',
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        requisition_id: reqTenantB,
        examination_id: null,
      });
      await expect(promise).rejects.toBeInstanceOf(AramoError);
      try {
        await promise;
      } catch (err) {
        const e = err as AramoError;
        expect(e.code).toBe('ENGAGEMENT_REFERENCE_NOT_FOUND');
        expect(e.context.details?.['field']).toBe('requisition_id');
      }
      const noEng = await repo.findById(CREATE_REQ_XTENANT_ID);
      expect(noEng).toBeNull();
    });

    it('createEngagement Pattern B refusal — examination absent → ENGAGEMENT_REFERENCE_NOT_FOUND 422', async () => {
      const ghostExam = '99999999-9999-7999-8999-999999999998';
      const promise = repo.createEngagement({
        id: CREATE_EXAM_NULL_ID,
        event_id: '00000000-0000-7000-8000-eeeec0000005',
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        requisition_id: REQUISITION_A,
        examination_id: ghostExam,
      });
      await expect(promise).rejects.toBeInstanceOf(AramoError);
      try {
        await promise;
      } catch (err) {
        const e = err as AramoError;
        expect(e.code).toBe('ENGAGEMENT_REFERENCE_NOT_FOUND');
        expect(e.context.details?.['field']).toBe('examination_id');
      }
    });

    it('createEngagement Pattern B refusal — examination cross-tenant → ENGAGEMENT_REFERENCE_NOT_FOUND 422', async () => {
      // EXAM_TENANT_B was seeded in TENANT_B; lookup from TENANT_A
      // returns the row but tenant_id mismatch → refuse.
      const promise = repo.createEngagement({
        id: CREATE_EXAM_XTENANT_ID,
        event_id: '00000000-0000-7000-8000-eeeec0000006',
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        requisition_id: REQUISITION_A,
        examination_id: EXAM_TENANT_B,
      });
      await expect(promise).rejects.toBeInstanceOf(AramoError);
      try {
        await promise;
      } catch (err) {
        const e = err as AramoError;
        expect(e.code).toBe('ENGAGEMENT_REFERENCE_NOT_FOUND');
        expect(e.context.details?.['field']).toBe('examination_id');
      }
    });

    it('createEngagement initial state is `surfaced` and initial event payload { from_state: null, to_state: surfaced }', async () => {
      const result = await repo.createEngagement({
        id: CREATE_NO_EXAM_ID,
        event_id: CREATE_NO_EXAM_EVENT_ID,
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        requisition_id: REQUISITION_A,
        examination_id: null,
      });
      expect(result.engagement.state).toBe('surfaced');
      expect(result.engagement.examination_id).toBeNull();
      expect(result.event.event_type).toBe('state_transition');
      expect(result.event.event_payload).toEqual({
        from_state: null,
        to_state: 'surfaced',
      });
    });

    // =====================================================================
    // PR-3 WRITE-PATH TESTS — transitionState (4 scenarios)
    // =====================================================================

    it('transitionState legal (surfaced → evaluated): state updated + event appended atomically', async () => {
      const evRowsBefore = await setupClient.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM engagement."TalentEngagementEvent" WHERE engagement_id = '${TRANSITION_HAPPY_ID}'::uuid`,
      );
      const beforeCount = Number(evRowsBefore[0]?.count ?? 0n);

      const result = await repo.transitionState({
        engagement_id: TRANSITION_HAPPY_ID,
        event_id: TRANSITION_HAPPY_EVENT_ID,
        tenant_id: TENANT_A,
        to_state: 'evaluated',
      });
      expect(result.engagement.state).toBe('evaluated');
      expect(result.event.event_payload).toEqual({
        from_state: 'surfaced',
        to_state: 'evaluated',
      });

      const evRowsAfter = await setupClient.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM engagement."TalentEngagementEvent" WHERE engagement_id = '${TRANSITION_HAPPY_ID}'::uuid`,
      );
      expect(Number(evRowsAfter[0]?.count ?? 0n)).toBe(beforeCount + 1);
    });

    it('transitionState illegal (surfaced → submitted): ENGAGEMENT_STATE_INVALID 422; NO state change + NO event appended', async () => {
      const stateBefore = await repo.findById(TRANSITION_ILLEGAL_ID);
      const evRowsBefore = await setupClient.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM engagement."TalentEngagementEvent" WHERE engagement_id = '${TRANSITION_ILLEGAL_ID}'::uuid`,
      );
      const beforeCount = Number(evRowsBefore[0]?.count ?? 0n);

      const promise = repo.transitionState({
        engagement_id: TRANSITION_ILLEGAL_ID,
        event_id: TRANSITION_ILLEGAL_EVENT_ID,
        tenant_id: TENANT_A,
        to_state: 'submitted',
      });
      await expect(promise).rejects.toBeInstanceOf(AramoError);
      try {
        await promise;
      } catch (err) {
        const e = err as AramoError;
        expect(e.code).toBe('ENGAGEMENT_STATE_INVALID');
        expect(e.statusCode).toBe(422);
        expect(e.context.details?.['from_state']).toBe('surfaced');
        expect(e.context.details?.['to_state']).toBe('submitted');
      }

      // Atomicity: state unchanged + no event row added.
      const stateAfter = await repo.findById(TRANSITION_ILLEGAL_ID);
      expect(stateAfter?.state).toBe(stateBefore?.state);
      const evRowsAfter = await setupClient.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM engagement."TalentEngagementEvent" WHERE engagement_id = '${TRANSITION_ILLEGAL_ID}'::uuid`,
      );
      expect(Number(evRowsAfter[0]?.count ?? 0n)).toBe(beforeCount);
    });

    it('transitionState DB-trigger defense-in-depth: raw SQL UPDATE with illegal transition is rejected by the column-scoped trigger', async () => {
      // The application-layer canTransition guard is the first line of
      // defense. The PR-1 column-scoped trigger is the second. Bypass
      // the application layer by direct SQL — the trigger should still
      // reject.
      await expect(
        setupClient.$executeRawUnsafe(
          `UPDATE engagement."TalentJobEngagement"
             SET state = 'submitted'::engagement."EngagementState"
             WHERE id = '${TRANSITION_DBTRIG_ID}'::uuid`,
        ),
      ).rejects.toThrow(/Illegal engagement state transition/);
    });

    it('transitionState cross-tenant attempt → NOT_FOUND 404', async () => {
      // TRANSITION_XTENANT_ID is in TENANT_A; transition from TENANT_B
      // → findByTenantAndId returns null → NOT_FOUND.
      const promise = repo.transitionState({
        engagement_id: TRANSITION_XTENANT_ID,
        event_id: TRANSITION_XTENANT_EVENT_ID,
        tenant_id: TENANT_B,
        to_state: 'evaluated',
      });
      await expect(promise).rejects.toBeInstanceOf(AramoError);
      try {
        await promise;
      } catch (err) {
        const e = err as AramoError;
        expect(e.code).toBe('NOT_FOUND');
        expect(e.statusCode).toBe(404);
      }
    });
  },
);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function seedEngagement(
  client: PrismaService,
  opts: {
    id: string;
    tenant_id: string;
    talent_id: string;
    requisition_id: string;
    examination_id: string | null;
    state: string;
    created_at: string;
  },
): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO engagement."TalentJobEngagement" (
       id, tenant_id, talent_id, requisition_id, examination_id, state, created_at
     ) VALUES (
       '${opts.id}'::uuid,
       '${opts.tenant_id}'::uuid,
       '${opts.talent_id}'::uuid,
       '${opts.requisition_id}'::uuid,
       ${opts.examination_id === null ? 'NULL' : `'${opts.examination_id}'::uuid`},
       '${opts.state}'::engagement."EngagementState",
       '${opts.created_at}'::timestamptz
     )`,
  );
}

async function seedTalent(client: PrismaService, id: string): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO talent."Talent" (id, lifecycle_status, updated_at) VALUES (
       '${id}'::uuid, 'active', NOW()
     )`,
  );
}

// Monotonic counter ensures unique overlay IDs across calls (test
// fixtures repeat across talent/tenant combinations).
let overlaySeq = 0;
async function seedTalentOverlay(
  client: PrismaService,
  opts: { talent_id: string; tenant_id: string },
): Promise<void> {
  overlaySeq += 1;
  const overlayId = `00000000-0000-7fff-8fff-${overlaySeq.toString(16).padStart(12, '0')}`;
  await client.$executeRawUnsafe(
    `INSERT INTO talent."TalentTenantOverlay" (
       id, talent_id, tenant_id, source_channel, tenant_status, updated_at
     ) VALUES (
       '${overlayId}'::uuid,
       '${opts.talent_id}'::uuid,
       '${opts.tenant_id}'::uuid,
       'self_signup',
       'active',
       NOW()
     )`,
  );
}

async function seedJob(
  client: PrismaService,
  opts: { id: string; tenant_id: string },
): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO job_domain."Job" (id, tenant_id) VALUES (
       '${opts.id}'::uuid, '${opts.tenant_id}'::uuid
     ) ON CONFLICT (id) DO NOTHING`,
  );
}

async function seedRequisition(
  client: PrismaService,
  opts: { id: string; tenant_id: string; job_id: string },
): Promise<void> {
  // Ensure parent Job exists (FK requirement).
  await seedJob(client, { id: opts.job_id, tenant_id: opts.tenant_id });
  const recruiterId = 'ffffffff-ffff-7fff-8fff-ffffffffffff';
  await client.$executeRawUnsafe(
    `INSERT INTO job_domain."Requisition" (id, tenant_id, job_id, recruiter_id, state) VALUES (
       '${opts.id}'::uuid,
       '${opts.tenant_id}'::uuid,
       '${opts.job_id}'::uuid,
       '${recruiterId}'::uuid,
       'active'::job_domain."RequisitionState"
     )`,
  );
}

async function seedExamination(
  client: PrismaService,
  opts: {
    id: string;
    tenant_id: string;
    talent_id: string;
    job_id: string;
  },
): Promise<void> {
  const skillMatch = { matched_count: 5, missing_count: 0, per_skill: [] };
  const experienceMatch = { years: 7, summary: 'Strong overlap' };
  const constraintChecks = { location: 'pass', work_mode: 'pass' };
  const expandedReasoning: unknown[] = [];
  const strengths = ['typescript-expertise'];
  const gaps: string[] = [];
  const riskFlags: unknown[] = [];
  const confidenceIndicators = {
    evidence_strength: { level: 'high', basis: 'ingested-evidence' },
    data_completeness: { level: 'high', basis: 'profile-complete' },
    constraint_confidence: { level: 'high', basis: 'verified' },
  };
  const freshnessIndicator = { profile_age_days: 14 };
  await client.$executeRawUnsafe(
    `INSERT INTO examination."TalentJobExamination" (
       id, tenant_id, talent_id, job_id, golden_profile_id,
       trigger, tier, rank_ordinal,
       why_matched_sentence, match_summary,
       expanded_reasoning, skill_match, experience_match,
       constraint_checks, strengths, gaps, risk_flags,
       confidence_indicators, freshness_indicator, delta_to_entrustable,
       examination_version, model_version, taxonomy_version,
       computed_at, lifecycle_state, archived_at, superseded_by_examination_id
     ) VALUES (
       '${opts.id}'::uuid,
       '${opts.tenant_id}'::uuid,
       '${opts.talent_id}'::uuid,
       '${opts.job_id}'::uuid,
       '${GOLDEN_PROFILE_ID}'::uuid,
       'initial_match'::examination."ExaminationTrigger",
       'ENTRUSTABLE'::examination."ExaminationTier",
       1,
       'Strong overlap.',
       'Sample match summary.',
       '${JSON.stringify(expandedReasoning)}'::jsonb,
       '${JSON.stringify(skillMatch)}'::jsonb,
       '${JSON.stringify(experienceMatch)}'::jsonb,
       '${JSON.stringify(constraintChecks)}'::jsonb,
       '${JSON.stringify(strengths)}'::jsonb,
       '${JSON.stringify(gaps)}'::jsonb,
       '${JSON.stringify(riskFlags)}'::jsonb,
       '${JSON.stringify(confidenceIndicators)}'::jsonb,
       '${JSON.stringify(freshnessIndicator)}'::jsonb,
       NULL,
       'v1.0', 'v1.0', 'v1.0',
       '2026-05-25T09:00:00Z'::timestamptz,
       'active'::examination."ExaminationLifecycleState",
       NULL,
       NULL
     )`,
  );
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
