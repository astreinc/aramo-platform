import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AramoError, makeMockLogger } from '@aramo/common';
import {
  ExaminationRepository,
  PrismaService as ExaminationPrismaService,
} from '@aramo/examination';
import {
  TalentEvidenceRepository,
  PrismaService as TalentEvidencePrismaService,
} from '@aramo/talent-evidence';

import type { BuildPackageInput } from '../lib/dto/talent-job-evidence-package.view.js';
import { EvidenceRepository } from '../lib/evidence.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// M4 PR-1 §4.6 — integration spec for libs/evidence (read-path tests).
// M4 PR-2 §4.7 — extended with buildPackage write-path tests (8 new
// it() blocks, total 17).
//
// Brings up a Postgres testcontainer, applies the three lib migrations
// (libs/evidence + libs/examination + libs/talent-evidence — separate
// schemas, no conflicts), seeds the read-path packages + the new
// builder-test examinations + rate expectation, constructs all three
// repositories, and asserts:
//
// READ PATH (PR-1):
//   - Seed via raw SQL (no builder method exists at PR-1's substrate).
//   - findById returns the row with JSONB structures deserialized to
//     typed view projections.
//   - findByTenantAndSubmittal returns the row when submittal_record_id
//     is non-null; null result on the (tenant, unknown_submittal) lookup.
//   - findByTenantAndTalent returns rows sorted by created_at DESC.
//   - No-write spy across all six Prisma write methods asserts zero
//     invocations across the read-path tests (the buildPackage tests
//     write deliberately and are excluded from the spy).
//   - Immutability trigger raises an exception on a deliberate UPDATE
//     attempt on a seeded row; error message contains
//     'immutable per Group 2 §2.6'.
//   - Tenant isolation: queries scoped by tenant_id do not return rows
//     from other tenants.
//
// WRITE PATH (PR-2 builder):
//   - Successful build (Entrustable) writes all six JSONB columns.
//   - Successful build (Worth Considering) succeeds (only Stretch is
//     blocked at substrate).
//   - Stretch refusal throws SUBMITTAL_STRETCH_BLOCKED; no row written.
//   - Non-existent examination_id throws NOT_FOUND; no row written.
//   - Archived examination throws NOT_FOUND; no row written.
//   - Rate-expectation read populates the rate sub-payload of
//     recruiter_contribution.talent_confirmed.rate.
//   - Built rows are immutable (PR-1 trigger fires on UPDATE).
//   - Tenant isolation across two tenants building the same
//     (talent_id, job_id).
//
// Dollar-quote-aware splitter (splitDdl below) — both the libs/evidence
// migration AND the libs/examination migration carry CREATE FUNCTION
// blocks with $$ ... $$ bodies that contain semicolons. A naive
// `.split(';')` would corrupt the trigger SQL; the splitter only splits
// on semicolons OUTSIDE dollar-quoted regions.

const EVIDENCE_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260522090000_init_evidence_model/migration.sql',
);
const EXAMINATION_INIT_MIGRATION_PATH = resolve(
  __dirname,
  '../../../examination/prisma/migrations/20260517200000_init_examination_model/migration.sql',
);
const EXAMINATION_LIVE_LIST_MIGRATION_PATH = resolve(
  __dirname,
  '../../../examination/prisma/migrations/20260521120000_add_live_list_index/migration.sql',
);
const TALENT_EVIDENCE_MIGRATION_PATH = resolve(
  __dirname,
  '../../../talent-evidence/prisma/migrations/20260519170000_init_talent_evidence_model/migration.sql',
);

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const TALENT_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const TALENT_B = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaa999';
const JOB_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const GOLDEN_PROFILE_ID = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const EXAMINATION_ID = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const SUBMITTAL_ID = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';

const PACKAGE_1 = '00000000-0000-7000-8000-000000000001';
const PACKAGE_2 = '00000000-0000-7000-8000-000000000002';
const PACKAGE_3 = '00000000-0000-7000-8000-000000000003';
const PACKAGE_4_OTHER_TENANT = '00000000-0000-7000-8000-000000000004';

// PR-2 examinations + rate expectation. All UUIDs use hex-only chars.
const ENTRUSTABLE_EXAM_ID = '11110000-0000-7000-8000-0000000e0001';
const WORTH_CONSIDERING_EXAM_ID = '22220000-0000-7000-8000-0000000c0001';
const STRETCH_EXAM_ID = '33330000-0000-7000-8000-0000000a0001';
const ARCHIVED_EXAM_ID = '44440000-0000-7000-8000-0000000d0001';
const TENANT_B_EXAM_ID = '55550000-0000-7000-8000-0000000b0001';
const RATE_EXPECTATION_ID = '66660000-0000-7000-8000-0000000f0001';

const BUILT_PACKAGE_BASE = '77770000-0000-7000-8000-0000000';

const TALENT_IDENTITY = {
  full_name: 'Sample Talent',
  preferred_name: 'Sam',
  location: 'Remote (US)',
};

const CONTACT_SUMMARY = {
  contact_available: true,
  channels_verified: ['email', 'phone'],
};

const CAPABILITY_SUMMARY = {
  skill_match: { matched_count: 5, missing_count: 0, per_skill: [] },
  experience_match: { years_overlap: 7, role_alignment: 'strong' },
  key_work_history: [
    { employer_name: 'Acme Corp', role_title: 'Senior Engineer', start_date: '2021-01-01' },
  ],
  certifications: ['AWS Solutions Architect'],
};

const MATCH_JUSTIFICATION = {
  why_this_talent: 'Strong evidence across all critical skills.',
  strengths: ['typescript-expertise', 'cloud-native-experience'],
  gaps: [],
  risk_flags: [],
};

const RECRUITER_CONTRIBUTION = {
  screening_notes: 'Spoke 2026-05-20; available immediately.',
  // M4 PR-2 widens conversation_summary from `string` to
  // { recruiter_summary: string } — the builder validates
  // conversation_summary.recruiter_summary at the input boundary
  // (directive §4.1 step 1), and the JSONB column stores the object
  // verbatim. PR-1's read-path tests now seed the same object shape.
  conversation_summary: {
    recruiter_summary: 'Confirmed availability, rate, and authorization.',
  },
  talent_confirmed: {
    spoken_to_recruiter: true,
    rate_confirmed: true,
    availability_confirmed: true,
    work_authorization: 'US_CITIZEN',
  },
};

// M4 PR-2 — reusable BuildPackageInput baseline. The builder tests vary
// id / examination_id / tenant_id / rate_expectation_id from this base.
function makeBuildInput(overrides: Partial<BuildPackageInput>): BuildPackageInput {
  const base: BuildPackageInput = {
    id: BUILT_PACKAGE_BASE + '00001',
    tenant_id: TENANT_A,
    talent_id: TALENT_A,
    job_id: JOB_ID,
    examination_id: ENTRUSTABLE_EXAM_ID,
    talent_identity: {
      full_name: 'Sample Talent',
      preferred_name: 'Sam',
      location: 'Remote (US)',
    },
    contact_summary: {
      contact_available: true,
      channels_verified: ['email'],
    },
    capability_summary_overrides: {
      key_work_history: [
        {
          employer_name: 'Acme Corp',
          role_title: 'Senior Engineer',
          start_date: '2021-01-01',
        },
      ],
      certifications: ['AWS Solutions Architect'],
    },
    recruiter_contribution: {
      screening_notes: 'Spoke 2026-05-20.',
      conversation_summary: {
        recruiter_summary: 'Discussed role, fit, and timing.',
      },
      talent_confirmed: {
        spoken_to_recruiter: true,
      },
    },
  };
  return { ...base, ...overrides };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'EvidenceRepository — schema + immutability integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let examPrisma: ExaminationPrismaService;
    let talentEvidencePrisma: TalentEvidencePrismaService;
    let repo: EvidenceRepository;
    let setupClient: PrismaService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      // Apply all three lib migrations to the same container. Each
      // migration creates a distinct schema (evidence, examination,
      // talent_evidence); no conflicts.
      const migrations = [
        readFileSync(EVIDENCE_MIGRATION_PATH, 'utf8'),
        readFileSync(EXAMINATION_INIT_MIGRATION_PATH, 'utf8'),
        readFileSync(EXAMINATION_LIVE_LIST_MIGRATION_PATH, 'utf8'),
        readFileSync(TALENT_EVIDENCE_MIGRATION_PATH, 'utf8'),
      ];

      setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const migrationSql of migrations) {
        for (const stmt of splitDdl(migrationSql)) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setupClient.$executeRawUnsafe(trimmed);
        }
      }

      // Per-module PrismaService instances. Each PrismaClient knows only
      // about its own module's models (the per-module generated client
      // pattern); seeding cross-schema data therefore goes through raw
      // SQL on setupClient, not through any of the typed clients.
      prisma = new PrismaService(url);
      await prisma.$connect();
      examPrisma = new ExaminationPrismaService(url);
      await examPrisma.$connect();
      talentEvidencePrisma = new TalentEvidencePrismaService(url);
      await talentEvidencePrisma.$connect();

      const examRepo = new ExaminationRepository(examPrisma, undefined as never);
      const talentEvidenceRepo = new TalentEvidenceRepository(talentEvidencePrisma);
      repo = new EvidenceRepository(prisma, examRepo, talentEvidenceRepo, makeMockLogger());

      // ---- Read-path seed (PR-1, unchanged shape) ---------------------
      await seedPackage(setupClient, {
        id: PACKAGE_1,
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        job_id: JOB_ID,
        examination_id: EXAMINATION_ID,
        submittal_record_id: null,
        parent_package_id: null,
        created_at: '2026-05-20T10:00:00Z',
      });
      await seedPackage(setupClient, {
        id: PACKAGE_2,
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        job_id: JOB_ID,
        examination_id: EXAMINATION_ID,
        submittal_record_id: SUBMITTAL_ID,
        parent_package_id: PACKAGE_1,
        created_at: '2026-05-21T10:00:00Z',
      });
      await seedPackage(setupClient, {
        id: PACKAGE_3,
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        job_id: JOB_ID,
        examination_id: EXAMINATION_ID,
        submittal_record_id: null,
        parent_package_id: null,
        created_at: '2026-05-22T10:00:00Z',
      });
      await seedPackage(setupClient, {
        id: PACKAGE_4_OTHER_TENANT,
        tenant_id: TENANT_B,
        talent_id: TALENT_A,
        job_id: JOB_ID,
        examination_id: EXAMINATION_ID,
        submittal_record_id: null,
        parent_package_id: null,
        created_at: '2026-05-22T10:00:00Z',
      });

      // ---- Write-path seed (PR-2 builder tests) ----------------------
      await seedExamination(setupClient, {
        id: ENTRUSTABLE_EXAM_ID,
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        job_id: JOB_ID,
        tier: 'ENTRUSTABLE',
        lifecycle_state: 'active',
      });
      await seedExamination(setupClient, {
        id: WORTH_CONSIDERING_EXAM_ID,
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        job_id: JOB_ID,
        tier: 'WORTH_CONSIDERING',
        lifecycle_state: 'active',
      });
      await seedExamination(setupClient, {
        id: STRETCH_EXAM_ID,
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        job_id: JOB_ID,
        tier: 'STRETCH',
        lifecycle_state: 'active',
      });
      await seedExamination(setupClient, {
        id: ARCHIVED_EXAM_ID,
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        job_id: JOB_ID,
        tier: 'ENTRUSTABLE',
        lifecycle_state: 'archived',
      });
      await seedExamination(setupClient, {
        id: TENANT_B_EXAM_ID,
        tenant_id: TENANT_B,
        talent_id: TALENT_A,
        job_id: JOB_ID,
        tier: 'ENTRUSTABLE',
        lifecycle_state: 'active',
      });
      await seedRateExpectation(setupClient, {
        id: RATE_EXPECTATION_ID,
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
      });
    }, 180_000);

    afterAll(async () => {
      await setupClient?.$disconnect();
      await prisma?.$disconnect();
      await examPrisma?.$disconnect();
      await talentEvidencePrisma?.$disconnect();
      await container?.stop();
    });

    // =====================================================================
    // PR-1 READ-PATH TESTS (9)
    // =====================================================================

    it('findById returns the row with deserialized JSONB structures', async () => {
      const view = await repo.findById({ tenant_id: TENANT_A, id: PACKAGE_1 });
      expect(view).not.toBeNull();
      expect(view?.id).toBe(PACKAGE_1);
      expect(view?.tenant_id).toBe(TENANT_A);
      expect(view?.talent_id).toBe(TALENT_A);
      expect(view?.job_id).toBe(JOB_ID);
      expect(view?.examination_id).toBe(EXAMINATION_ID);
      expect(view?.submittal_record_id).toBeNull();
      expect(view?.parent_package_id).toBeNull();
      expect(view?.talent_identity).toEqual(TALENT_IDENTITY);
      expect(view?.contact_summary).toEqual(CONTACT_SUMMARY);
      expect(view?.capability_summary).toEqual(CAPABILITY_SUMMARY);
      expect(view?.match_justification).toEqual(MATCH_JUSTIFICATION);
      expect(view?.recruiter_contribution).toEqual(RECRUITER_CONTRIBUTION);
      expect(view?.engagement_event_refs).toEqual([]);
    });

    it('findById returns null for an unknown id', async () => {
      const view = await repo.findById({
        tenant_id: TENANT_A,
        id: '00000000-0000-7000-8000-deadbeef0000',
      });
      expect(view).toBeNull();
    });

    it('findById returns null for a known id under a wrong tenant (tenant isolation)', async () => {
      // PACKAGE_1 is in TENANT_A; TENANT_B should not see it.
      const view = await repo.findById({ tenant_id: TENANT_B, id: PACKAGE_1 });
      expect(view).toBeNull();
    });

    it('findByTenantAndSubmittal returns the row when submittal_record_id is non-null', async () => {
      const view = await repo.findByTenantAndSubmittal({
        tenant_id: TENANT_A,
        submittal_record_id: SUBMITTAL_ID,
      });
      expect(view).not.toBeNull();
      expect(view?.id).toBe(PACKAGE_2);
      expect(view?.submittal_record_id).toBe(SUBMITTAL_ID);
      expect(view?.parent_package_id).toBe(PACKAGE_1);
    });

    it('findByTenantAndSubmittal returns null for an unknown submittal_record_id', async () => {
      const view = await repo.findByTenantAndSubmittal({
        tenant_id: TENANT_A,
        submittal_record_id: '00000000-0000-7000-8000-deadbeef0000',
      });
      expect(view).toBeNull();
    });

    it('findByTenantAndTalent returns rows sorted by created_at DESC', async () => {
      const views = await repo.findByTenantAndTalent({
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
      });
      // PR-2 note: buildPackage tests may add rows for TENANT_A + TALENT_A.
      // This test must still find the three originally-seeded packages at
      // the head of the result (newest-first ordering on created_at). Use
      // a "contains in order" assertion rather than "exact length" — the
      // builder tests use 2026-05-23+ timestamps so they sort BEFORE the
      // seeded 2026-05-22 timestamps. The three seeded packages must
      // remain in their relative order: PACKAGE_3, PACKAGE_2, PACKAGE_1.
      const seededOrder = views
        .map((v) => v.id)
        .filter((id) => id === PACKAGE_1 || id === PACKAGE_2 || id === PACKAGE_3);
      expect(seededOrder).toEqual([PACKAGE_3, PACKAGE_2, PACKAGE_1]);
      // Tenant isolation: the TENANT_B package with TALENT_A is NOT included.
      expect(views.map((v) => v.id)).not.toContain(PACKAGE_4_OTHER_TENANT);
    });

    it('findByTenantAndTalent returns [] for an unknown talent', async () => {
      const views = await repo.findByTenantAndTalent({
        tenant_id: TENANT_A,
        talent_id: TALENT_B,
      });
      expect(views).toEqual([]);
    });

    it('no-write evidence: all read methods issue zero write invocations', async () => {
      // PR-6/PR-7 spy precedent — spy across every Prisma write surface
      // on the talentJobEvidencePackage delegate. Any write would be a
      // scope breach (read methods are read-only by directive §4.3 Ruling 3).
      const createSpy = vi.spyOn(prisma.talentJobEvidencePackage, 'create');
      const createManySpy = vi.spyOn(prisma.talentJobEvidencePackage, 'createMany');
      const updateSpy = vi.spyOn(prisma.talentJobEvidencePackage, 'update');
      const updateManySpy = vi.spyOn(prisma.talentJobEvidencePackage, 'updateMany');
      const upsertSpy = vi.spyOn(prisma.talentJobEvidencePackage, 'upsert');
      const deleteSpy = vi.spyOn(prisma.talentJobEvidencePackage, 'delete');
      const deleteManySpy = vi.spyOn(prisma.talentJobEvidencePackage, 'deleteMany');

      try {
        await repo.findById({ tenant_id: TENANT_A, id: PACKAGE_1 });
        await repo.findByTenantAndSubmittal({
          tenant_id: TENANT_A,
          submittal_record_id: SUBMITTAL_ID,
        });
        await repo.findByTenantAndTalent({ tenant_id: TENANT_A, talent_id: TALENT_A });

        expect(createSpy).not.toHaveBeenCalled();
        expect(createManySpy).not.toHaveBeenCalled();
        expect(updateSpy).not.toHaveBeenCalled();
        expect(updateManySpy).not.toHaveBeenCalled();
        expect(upsertSpy).not.toHaveBeenCalled();
        expect(deleteSpy).not.toHaveBeenCalled();
        expect(deleteManySpy).not.toHaveBeenCalled();
      } finally {
        createSpy.mockRestore();
        createManySpy.mockRestore();
        updateSpy.mockRestore();
        updateManySpy.mockRestore();
        upsertSpy.mockRestore();
        deleteSpy.mockRestore();
        deleteManySpy.mockRestore();
      }
    });

    it('immutability trigger rejects any UPDATE on the table', async () => {
      // Per directive §4.2: the BEFORE UPDATE trigger raises an exception
      // with the spec'd message. Deliberate UPDATE attempt on a benign
      // column (the JSONB recruiter_contribution) MUST fail.
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE evidence."TalentJobEvidencePackage"
             SET recruiter_contribution = '{"changed":true}'::jsonb
             WHERE id = '${PACKAGE_1}'::uuid`,
        ),
      ).rejects.toThrow(/immutable per Group 2 §2.6/);
    });

    // =====================================================================
    // PR-2 BUILDER WRITE-PATH TESTS (8)
    // =====================================================================

    it('buildPackage(Entrustable): writes a row with all six JSONB columns populated', async () => {
      const input = makeBuildInput({
        id: BUILT_PACKAGE_BASE + 'b0001',
        examination_id: ENTRUSTABLE_EXAM_ID,
      });
      const view = await repo.buildPackage(input);

      expect(view.id).toBe(input.id);
      expect(view.tenant_id).toBe(TENANT_A);
      expect(view.talent_id).toBe(TALENT_A);
      expect(view.job_id).toBe(JOB_ID);
      expect(view.examination_id).toBe(ENTRUSTABLE_EXAM_ID);

      // All six JSONB payloads populated.
      expect(view.talent_identity).toBeDefined();
      expect(view.contact_summary).toBeDefined();
      expect(view.capability_summary).toBeDefined();
      expect(view.match_justification).toBeDefined();
      expect(view.recruiter_contribution).toBeDefined();
      expect(Array.isArray(view.engagement_event_refs)).toBe(true);
      expect(view.engagement_event_refs).toEqual([]);

      // Capability summary is derived from the seeded examination's
      // skill_match + experience_match; recruiter overrides supply
      // key_work_history + certifications.
      expect(view.capability_summary.skill_match).toBeDefined();
      expect(view.capability_summary.key_work_history).toHaveLength(1);

      // Match justification defaults from examination Full view (no overrides).
      expect(view.match_justification.why_this_talent).toBeDefined();
      expect(Array.isArray(view.match_justification.strengths)).toBe(true);

      // Round-trip: findById returns the just-built row.
      const reread = await repo.findById({ tenant_id: TENANT_A, id: view.id });
      expect(reread).not.toBeNull();
      expect(reread?.id).toBe(view.id);
    });

    it('buildPackage(Worth Considering): build succeeds (only Stretch is blocked)', async () => {
      const input = makeBuildInput({
        id: BUILT_PACKAGE_BASE + 'b0002',
        examination_id: WORTH_CONSIDERING_EXAM_ID,
      });
      const view = await repo.buildPackage(input);
      expect(view.id).toBe(input.id);
      expect(view.examination_id).toBe(WORTH_CONSIDERING_EXAM_ID);
    });

    it('buildPackage(Stretch): throws SUBMITTAL_STRETCH_BLOCKED; no row written', async () => {
      const targetId = BUILT_PACKAGE_BASE + 'b0003';
      const input = makeBuildInput({
        id: targetId,
        examination_id: STRETCH_EXAM_ID,
      });
      await expect(repo.buildPackage(input)).rejects.toThrow(AramoError);
      try {
        await repo.buildPackage(input);
      } catch (err) {
        expect(err).toBeInstanceOf(AramoError);
        const aramoErr = err as AramoError;
        expect(aramoErr.code).toBe('SUBMITTAL_STRETCH_BLOCKED');
        expect(aramoErr.statusCode).toBe(422);
      }
      const reread = await repo.findById({ tenant_id: TENANT_A, id: targetId });
      expect(reread).toBeNull();
    });

    it('buildPackage(non-existent examination_id): throws NOT_FOUND; no row written', async () => {
      const targetId = BUILT_PACKAGE_BASE + 'b0004';
      const input = makeBuildInput({
        id: targetId,
        examination_id: 'ffff0000-0000-7000-8000-ffffffffffff',
      });
      try {
        await repo.buildPackage(input);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AramoError);
        expect((err as AramoError).code).toBe('NOT_FOUND');
      }
      const reread = await repo.findById({ tenant_id: TENANT_A, id: targetId });
      expect(reread).toBeNull();
    });

    it('buildPackage(archived examination): throws NOT_FOUND; no row written', async () => {
      const targetId = BUILT_PACKAGE_BASE + 'b0005';
      const input = makeBuildInput({
        id: targetId,
        examination_id: ARCHIVED_EXAM_ID,
      });
      try {
        await repo.buildPackage(input);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AramoError);
        expect((err as AramoError).code).toBe('NOT_FOUND');
        expect((err as AramoError).message).toContain('archived');
      }
      const reread = await repo.findById({ tenant_id: TENANT_A, id: targetId });
      expect(reread).toBeNull();
    });

    it('buildPackage with rate_expectation_id: JSONB carries the rate sub-payload', async () => {
      const input = makeBuildInput({
        id: BUILT_PACKAGE_BASE + 'b0006',
        examination_id: ENTRUSTABLE_EXAM_ID,
        rate_expectation_id: RATE_EXPECTATION_ID,
      });
      const view = await repo.buildPackage(input);
      const rc = view.recruiter_contribution as unknown as {
        talent_confirmed: {
          rate?: {
            min_rate: number;
            target_rate: number | null;
            currency: string;
            period: string;
            source: string;
            employment_type: string;
          };
        };
      };
      expect(rc.talent_confirmed.rate).toBeDefined();
      expect(rc.talent_confirmed.rate?.min_rate).toBe(150);
      expect(rc.talent_confirmed.rate?.target_rate).toBe(180);
      expect(rc.talent_confirmed.rate?.currency).toBe('USD');
      expect(rc.talent_confirmed.rate?.period).toBe('HOURLY');
      expect(rc.talent_confirmed.rate?.source).toBe('talent_declared');
      expect(rc.talent_confirmed.rate?.employment_type).toBe('W2');

      // Absent rate_expectation_id → rate field omitted from JSONB.
      const inputNoRate = makeBuildInput({
        id: BUILT_PACKAGE_BASE + 'b0007',
        examination_id: ENTRUSTABLE_EXAM_ID,
      });
      const viewNoRate = await repo.buildPackage(inputNoRate);
      const rcNoRate = viewNoRate.recruiter_contribution as unknown as {
        talent_confirmed: { rate?: unknown };
      };
      expect(rcNoRate.talent_confirmed.rate).toBeUndefined();
    });

    it('built rows are immutable (PR-1 trigger fires on UPDATE attempt)', async () => {
      const input = makeBuildInput({
        id: BUILT_PACKAGE_BASE + 'b0008',
        examination_id: ENTRUSTABLE_EXAM_ID,
      });
      const view = await repo.buildPackage(input);
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE evidence."TalentJobEvidencePackage"
             SET recruiter_contribution = '{"changed":true}'::jsonb
             WHERE id = '${view.id}'::uuid`,
        ),
      ).rejects.toThrow(/immutable per Group 2 §2.6/);
    });

    it('tenant isolation: cross-tenant build cannot reach another tenant\'s examination', async () => {
      // TENANT_B's examination is seeded above; build for TENANT_A with
      // that examination_id must refuse NOT_FOUND (tenant cross-check).
      const targetId = BUILT_PACKAGE_BASE + 'b0009';
      const crossTenantInput = makeBuildInput({
        id: targetId,
        tenant_id: TENANT_A,
        examination_id: TENANT_B_EXAM_ID,
      });
      try {
        await repo.buildPackage(crossTenantInput);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AramoError);
        expect((err as AramoError).code).toBe('NOT_FOUND');
        expect((err as AramoError).message).toContain('not found in tenant');
      }

      // TENANT_B can build using its own examination; the resulting row
      // is in TENANT_B's silo and is invisible to TENANT_A.
      const tenantBInput = makeBuildInput({
        id: BUILT_PACKAGE_BASE + 'b0010',
        tenant_id: TENANT_B,
        examination_id: TENANT_B_EXAM_ID,
      });
      const tenantBView = await repo.buildPackage(tenantBInput);
      const fromTenantA = await repo.findById({
        tenant_id: TENANT_A,
        id: tenantBView.id,
      });
      expect(fromTenantA).toBeNull();
      const fromTenantB = await repo.findById({
        tenant_id: TENANT_B,
        id: tenantBView.id,
      });
      expect(fromTenantB).not.toBeNull();
    });
  },
);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function seedPackage(
  client: PrismaService,
  opts: {
    id: string;
    tenant_id: string;
    talent_id: string;
    job_id: string;
    examination_id: string;
    submittal_record_id: string | null;
    parent_package_id: string | null;
    created_at: string;
  },
): Promise<void> {
  // Raw SQL seed. The Prisma create path is intentionally NOT used here —
  // the read-path test seeds predate the builder. The migration-applied
  // immutability trigger fires on UPDATE only, not INSERT, so this seed
  // path is unconstrained.
  await client.$executeRawUnsafe(
    `INSERT INTO evidence."TalentJobEvidencePackage" (
       id, tenant_id, talent_id, job_id, examination_id,
       submittal_record_id, parent_package_id,
       talent_identity, contact_summary, capability_summary,
       match_justification, recruiter_contribution, engagement_event_refs,
       created_at
     ) VALUES (
       '${opts.id}'::uuid,
       '${opts.tenant_id}'::uuid,
       '${opts.talent_id}'::uuid,
       '${opts.job_id}'::uuid,
       '${opts.examination_id}'::uuid,
       ${opts.submittal_record_id === null ? 'NULL' : `'${opts.submittal_record_id}'::uuid`},
       ${opts.parent_package_id === null ? 'NULL' : `'${opts.parent_package_id}'::uuid`},
       '${JSON.stringify(TALENT_IDENTITY)}'::jsonb,
       '${JSON.stringify(CONTACT_SUMMARY)}'::jsonb,
       '${JSON.stringify(CAPABILITY_SUMMARY)}'::jsonb,
       '${JSON.stringify(MATCH_JUSTIFICATION)}'::jsonb,
       '${JSON.stringify(RECRUITER_CONTRIBUTION)}'::jsonb,
       '[]'::jsonb,
       '${opts.created_at}'::timestamptz
     )`,
  );
}

// PR-2 — seed a TalentJobExamination row in the examination schema. The
// nine analytical Json fields carry minimal but well-formed shapes so
// the builder's findByIdFull projection sees consistent inputs.
async function seedExamination(
  client: PrismaService,
  opts: {
    id: string;
    tenant_id: string;
    talent_id: string;
    job_id: string;
    tier: 'ENTRUSTABLE' | 'WORTH_CONSIDERING' | 'STRETCH';
    lifecycle_state: 'active' | 'archived' | 'cold_storage';
  },
): Promise<void> {
  const skillMatch = { matched_count: 5, missing_count: 0, per_skill: [] };
  const experienceMatch = { years: 7, summary: 'Strong overlap' };
  const constraintChecks = { location: 'pass', work_mode: 'pass' };
  const expandedReasoning: unknown[] = [];
  const strengths = ['typescript-expertise', 'cloud-native-experience'];
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
       '${opts.tier}'::examination."ExaminationTier",
       1,
       'Strong skill + experience overlap on critical role requirements.',
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
       '2026-05-22T09:00:00Z'::timestamptz,
       '${opts.lifecycle_state}'::examination."ExaminationLifecycleState",
       ${opts.lifecycle_state === 'active' ? 'NULL' : `'2026-05-22T09:00:00Z'::timestamptz`},
       NULL
     )`,
  );
}

async function seedRateExpectation(
  client: PrismaService,
  opts: {
    id: string;
    tenant_id: string;
    talent_id: string;
  },
): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO talent_evidence."TalentRateExpectation" (
       id, talent_id, tenant_id,
       employment_type, min_rate, target_rate, currency, period, source,
       updated_at
     ) VALUES (
       '${opts.id}'::uuid,
       '${opts.talent_id}'::uuid,
       '${opts.tenant_id}'::uuid,
       'W2'::talent_evidence."TalentEmploymentType",
       150, 180, 'USD',
       'HOURLY'::talent_evidence."TalentRatePeriod",
       'talent_declared'::talent_evidence."TalentRateSource",
       '2026-05-22T09:00:00Z'::timestamptz
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
