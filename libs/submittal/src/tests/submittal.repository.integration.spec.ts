import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AramoError, type AramoLogger } from '@aramo/common';
import {
  EvidenceRepository,
  PrismaService as EvidencePrismaService,
} from '@aramo/evidence';
import {
  ExaminationRepository,
  PrismaService as ExaminationPrismaService,
} from '@aramo/examination';
import {
  TalentEvidenceRepository,
  PrismaService as TalentEvidencePrismaService,
} from '@aramo/talent-evidence';
// M4 PR-7 §4.10 — IdempotencyService imported for the integration-
// level replay/conflict test (no new Nx edge — SubmittalController
// already depends on @aramo/consent for the same service).
import {
  IdempotencyService,
  PrismaService as ConsentPrismaService,
} from '@aramo/consent';

import type { CreateSubmittalInput } from '../lib/dto/talent-submittal-record.view.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { SubmittalRepository } from '../lib/submittal.repository.js';

// M4 PR-9 §4.5 — SubmittalRepository constructor now takes an
// AramoLogger as 4th arg. Integration test injects a no-op mock; the
// integration assertions focus on DB-level state isolation + write
// path, not log output.
function makeMockLogger(): AramoLogger {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as AramoLogger;
}

// M4 PR-3 §4.11 — integration spec for libs/submittal.
//
// Brings up a Postgres testcontainer, applies the four lib migrations
// (consent + examination + talent-evidence + evidence + submittal),
// constructs the cross-lib repository chain, and asserts:
//   - Successful create: TalentSubmittalRecord row exists in `draft`
//     state; the cross-schema TalentJobEvidencePackage row exists too;
//     all six JSONB payloads on the package are populated.
//   - Stretch refusal: SUBMITTAL_STRETCH_BLOCKED throws; no rows on
//     either table.
//   - Examination not found: NOT_FOUND throws; no rows.
//   - Archived examination: NOT_FOUND throws; no rows.
//   - Worth Considering: create succeeds; justification +
//     failed_criterion_acknowledgments persist (NOT enforced at PR-3).
//   - Immutability trigger column-scoped behavior: legal
//     draft→submitted UPDATE with confirmed_at succeeds; illegal column
//     changes raise.
//   - Tenant isolation: cross-tenant findById returns null.

const SUBMITTAL_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260523120000_init_submittal_model/migration.sql',
);
// M4 PR-7 — submittal-revoke schema extension migration. Applied
// after the init migration so the ALTER TYPE / ALTER TABLE statements
// extend the existing enum + table; the CREATE OR REPLACE FUNCTION
// rewrites the column-scoped trigger to encode Transition A + B.
const SUBMITTAL_REVOKE_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260523200000_add_submittal_revoke/migration.sql',
);
const EXAMINATION_INIT_PATH = resolve(
  __dirname,
  '../../../examination/prisma/migrations/20260517200000_init_examination_model/migration.sql',
);
const EXAMINATION_LIVE_LIST_PATH = resolve(
  __dirname,
  '../../../examination/prisma/migrations/20260521120000_add_live_list_index/migration.sql',
);
const TALENT_EVIDENCE_INIT_PATH = resolve(
  __dirname,
  '../../../talent-evidence/prisma/migrations/20260519170000_init_talent_evidence_model/migration.sql',
);
const EVIDENCE_INIT_PATH = resolve(
  __dirname,
  '../../../evidence/prisma/migrations/20260522090000_init_evidence_model/migration.sql',
);

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const TALENT_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const JOB_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const GOLDEN_ID = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const RECRUITER_ID = '00000000-0000-7000-8000-000000000bb1';

const ENT_EXAM_ID = '11110000-0000-7000-8000-0000000e0001';
const WC_EXAM_ID = '22220000-0000-7000-8000-0000000c0001';
const STRETCH_EXAM_ID = '33330000-0000-7000-8000-0000000a0001';
const ARCHIVED_EXAM_ID = '44440000-0000-7000-8000-0000000d0001';
const TENANT_B_EXAM_ID = '55550000-0000-7000-8000-0000000b0001';

function makeInput(overrides: Partial<CreateSubmittalInput>): CreateSubmittalInput {
  const base: CreateSubmittalInput = {
    tenant_id: TENANT_A,
    talent_id: TALENT_A,
    job_id: JOB_ID,
    examination_id: ENT_EXAM_ID,
    created_by: RECRUITER_ID,
    talent_identity: {
      full_name: 'Sample Talent',
      preferred_name: 'Sam',
      location: 'Remote (US)',
    },
    contact_summary: { contact_available: true, channels_verified: ['email'] },
    capability_summary_overrides: {
      key_work_history: [
        { employer_name: 'Acme', role_title: 'Senior Engineer', start_date: '2021-01-01' },
      ],
      certifications: ['AWS Solutions Architect'],
    },
    recruiter_contribution: {
      screening_notes: 'Spoke 2026-05-23.',
      conversation_summary: { recruiter_summary: 'Discussed role.' },
      talent_confirmed: { spoken_to_recruiter: true },
    },
  };
  return { ...base, ...overrides };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'SubmittalRepository — schema + immutability integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let setupClient: PrismaService;
    let submittalPrisma: PrismaService;
    let evidencePrisma: EvidencePrismaService;
    let examPrisma: ExaminationPrismaService;
    let talentEvidencePrisma: TalentEvidencePrismaService;
    let repo: SubmittalRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const migrationSqls = [
        readFileSync(EXAMINATION_INIT_PATH, 'utf8'),
        readFileSync(EXAMINATION_LIVE_LIST_PATH, 'utf8'),
        readFileSync(TALENT_EVIDENCE_INIT_PATH, 'utf8'),
        readFileSync(EVIDENCE_INIT_PATH, 'utf8'),
        readFileSync(SUBMITTAL_MIGRATION_PATH, 'utf8'),
        // M4 PR-7 — submittal-revoke schema extension. Applied after
        // the init migration so the ALTER TYPE / ALTER TABLE land on
        // the existing enum + table; the CREATE OR REPLACE FUNCTION
        // rewrites the column-scoped trigger to encode both legal
        // transitions (A: draft→submitted, B: submitted→revoked).
        readFileSync(SUBMITTAL_REVOKE_MIGRATION_PATH, 'utf8'),
      ];

      setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const sql of migrationSqls) {
        for (const stmt of splitDdl(sql)) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setupClient.$executeRawUnsafe(trimmed);
        }
      }

      submittalPrisma = new PrismaService(url);
      await submittalPrisma.$connect();
      evidencePrisma = new EvidencePrismaService(url);
      await evidencePrisma.$connect();
      examPrisma = new ExaminationPrismaService(url);
      await examPrisma.$connect();
      talentEvidencePrisma = new TalentEvidencePrismaService(url);
      await talentEvidencePrisma.$connect();

      const examRepo = new ExaminationRepository(examPrisma, undefined as never);
      const talentEvidenceRepo = new TalentEvidenceRepository(talentEvidencePrisma);
      const evidenceRepo = new EvidenceRepository(evidencePrisma, examRepo, talentEvidenceRepo);
      repo = new SubmittalRepository(submittalPrisma, evidenceRepo, examRepo, makeMockLogger());

      // Seed all the examinations the tests need.
      await seedExamination(setupClient, { id: ENT_EXAM_ID, tenant_id: TENANT_A, tier: 'ENTRUSTABLE', lifecycle_state: 'active' });
      await seedExamination(setupClient, { id: WC_EXAM_ID, tenant_id: TENANT_A, tier: 'WORTH_CONSIDERING', lifecycle_state: 'active' });
      await seedExamination(setupClient, { id: STRETCH_EXAM_ID, tenant_id: TENANT_A, tier: 'STRETCH', lifecycle_state: 'active' });
      await seedExamination(setupClient, { id: ARCHIVED_EXAM_ID, tenant_id: TENANT_A, tier: 'ENTRUSTABLE', lifecycle_state: 'archived' });
      await seedExamination(setupClient, { id: TENANT_B_EXAM_ID, tenant_id: TENANT_B, tier: 'ENTRUSTABLE', lifecycle_state: 'active' });
    }, 180_000);

    afterAll(async () => {
      await setupClient?.$disconnect();
      await submittalPrisma?.$disconnect();
      await evidencePrisma?.$disconnect();
      await examPrisma?.$disconnect();
      await talentEvidencePrisma?.$disconnect();
      await container?.stop();
    });

    it('successful create: TalentSubmittalRecord row in draft state + cross-schema package row', async () => {
      const view = await repo.createSubmittal(makeInput({ examination_id: ENT_EXAM_ID }));
      expect(view.state).toBe('draft');
      expect(view.tenant_id).toBe(TENANT_A);
      expect(view.pinned_examination_id).toBe(ENT_EXAM_ID);
      expect(view.confirmed_at).toBeNull();

      // Cross-schema check: TalentJobEvidencePackage row exists with all
      // six JSONB columns populated.
      const pkgRows = (await submittalPrisma.$queryRawUnsafe(
        `SELECT id, talent_identity, contact_summary, capability_summary, match_justification, recruiter_contribution, engagement_event_refs FROM evidence."TalentJobEvidencePackage" WHERE id = '${view.evidence_package_id}'::uuid`,
      )) as Array<Record<string, unknown>>;
      expect(pkgRows).toHaveLength(1);
      const pkg = pkgRows[0]!;
      expect(pkg['talent_identity']).toBeDefined();
      expect(pkg['contact_summary']).toBeDefined();
      expect(pkg['capability_summary']).toBeDefined();
      expect(pkg['match_justification']).toBeDefined();
      expect(pkg['recruiter_contribution']).toBeDefined();
      expect(pkg['engagement_event_refs']).toBeDefined();
    });

    it('Stretch refusal: throws SUBMITTAL_STRETCH_BLOCKED; no rows on either table', async () => {
      const submittalRowsBefore = await countSubmittalRowsByExam(submittalPrisma, STRETCH_EXAM_ID);
      const pkgRowsBefore = await countPackageRowsByExam(submittalPrisma, STRETCH_EXAM_ID);
      try {
        await repo.createSubmittal(makeInput({ examination_id: STRETCH_EXAM_ID }));
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AramoError);
        expect((err as AramoError).code).toBe('SUBMITTAL_STRETCH_BLOCKED');
      }
      const submittalRowsAfter = await countSubmittalRowsByExam(submittalPrisma, STRETCH_EXAM_ID);
      const pkgRowsAfter = await countPackageRowsByExam(submittalPrisma, STRETCH_EXAM_ID);
      expect(submittalRowsAfter).toBe(submittalRowsBefore);
      expect(pkgRowsAfter).toBe(pkgRowsBefore);
    });

    it('Examination not found: throws NOT_FOUND; no rows written', async () => {
      const missingId = 'ffff0000-0000-7000-8000-ffffffffffff';
      const submittalRowsBefore = await countSubmittalRowsByExam(submittalPrisma, missingId);
      try {
        await repo.createSubmittal(makeInput({ examination_id: missingId }));
        throw new Error('expected throw');
      } catch (err) {
        expect((err as AramoError).code).toBe('NOT_FOUND');
      }
      expect(await countSubmittalRowsByExam(submittalPrisma, missingId)).toBe(submittalRowsBefore);
    });

    it('Archived examination: throws NOT_FOUND; no rows written', async () => {
      const submittalRowsBefore = await countSubmittalRowsByExam(submittalPrisma, ARCHIVED_EXAM_ID);
      try {
        await repo.createSubmittal(makeInput({ examination_id: ARCHIVED_EXAM_ID }));
        throw new Error('expected throw');
      } catch (err) {
        expect((err as AramoError).code).toBe('NOT_FOUND');
      }
      expect(await countSubmittalRowsByExam(submittalPrisma, ARCHIVED_EXAM_ID)).toBe(submittalRowsBefore);
    });

    it('Worth Considering: create succeeds; justification + acknowledgments persist (not enforced)', async () => {
      const view = await repo.createSubmittal(
        makeInput({
          examination_id: WC_EXAM_ID,
          justification: 'Strong soft skills despite missing certification',
          failed_criterion_acknowledgments: [
            {
              criterion: 'rate_within_band',
              field_path: 'talent_rate.min_rate',
              observed_value: '150',
              expected_threshold: '<=180',
              acknowledged: true,
            },
          ],
        }),
      );
      expect(view.state).toBe('draft');
      expect(view.justification).toBe('Strong soft skills despite missing certification');
      expect(view.failed_criterion_acknowledgments).toHaveLength(1);
      expect(view.failed_criterion_acknowledgments?.[0]?.criterion).toBe('rate_within_band');
    });

    it('Worth Considering without justification: create still succeeds (PR-3 does NOT enforce)', async () => {
      // Second Entrustable create — uses the same exam id but distinct
      // submittal id (auto-generated). PR-3 enforces no uniqueness on
      // (tenant, exam) for submittal records.
      const view = await repo.createSubmittal(makeInput({ examination_id: WC_EXAM_ID }));
      expect(view.state).toBe('draft');
      expect(view.justification).toBeNull();
      expect(view.failed_criterion_acknowledgments).toBeNull();
    });

    it('Immutability trigger: legal draft→submitted UPDATE with confirmed_at succeeds', async () => {
      const view = await repo.createSubmittal(makeInput({ examination_id: ENT_EXAM_ID }));
      await submittalPrisma.$executeRawUnsafe(
        `UPDATE engagement."TalentSubmittalRecord"
           SET state = 'submitted'::engagement."SubmittalState",
               confirmed_at = '2026-05-23T15:00:00Z'::timestamptz
           WHERE id = '${view.id}'::uuid`,
      );
      const rereadView = await repo.findById({ tenant_id: TENANT_A, id: view.id });
      expect(rereadView?.state).toBe('submitted');
      expect(rereadView?.confirmed_at).toBeInstanceOf(Date);
    });

    it('Immutability trigger: illegal column change raises', async () => {
      const view = await repo.createSubmittal(makeInput({ examination_id: ENT_EXAM_ID }));
      // Attempt to mutate tenant_id — should be rejected by the trigger.
      await expect(
        submittalPrisma.$executeRawUnsafe(
          `UPDATE engagement."TalentSubmittalRecord"
             SET tenant_id = '${TENANT_B}'::uuid
             WHERE id = '${view.id}'::uuid`,
        ),
      ).rejects.toThrow(/column-scoped immutable per Group 2 §2.6/);
    });

    it('Tenant isolation: cross-tenant build refuses NOT_FOUND', async () => {
      // Build for TENANT_A using TENANT_B's examination — refuses.
      try {
        await repo.createSubmittal(
          makeInput({ tenant_id: TENANT_A, examination_id: TENANT_B_EXAM_ID }),
        );
        throw new Error('expected throw');
      } catch (err) {
        expect((err as AramoError).code).toBe('NOT_FOUND');
      }
    });

    it('Tenant isolation: findById is tenant-scoped', async () => {
      // TENANT_B build with its own examination; TENANT_A cannot read it.
      const tenantBView = await repo.createSubmittal(
        makeInput({ tenant_id: TENANT_B, examination_id: TENANT_B_EXAM_ID }),
      );
      const fromTenantA = await repo.findById({ tenant_id: TENANT_A, id: tenantBView.id });
      expect(fromTenantA).toBeNull();
      const fromTenantB = await repo.findById({ tenant_id: TENANT_B, id: tenantBView.id });
      expect(fromTenantB).not.toBeNull();
    });

    // =========================================================================
    // M4 PR-4 §4.10 — confirmSubmittal integration tests (8 new)
    // =========================================================================

    it('M4 PR-4: confirm happy path — Entrustable + all attestations true → state="submitted" + confirmed_at set', async () => {
      // Seed an isolated (talent, job) so the latest-snapshot check is
      // unambiguously this row (the shared TALENT_A + JOB_ID triple has
      // multiple PR-3 baseline rows that would defeat the pin check).
      const talentH = 'aaaaaaaa-0000-7000-8000-0000000a1001';
      const jobH = 'cccccccc-0000-7000-8000-0000000c1001';
      const examH = '11110000-0000-7000-8000-0000000e1001';
      await seedExamination(setupClient, {
        id: examH,
        tenant_id: TENANT_A,
        tier: 'ENTRUSTABLE',
        lifecycle_state: 'active',
        talent_id: talentH,
        job_id: jobH,
      });
      const draft = await repo.createSubmittal(
        makeInput({ examination_id: examH, talent_id: talentH, job_id: jobH }),
      );
      const view = await repo.confirmSubmittal({
        tenant_id: TENANT_A,
        submittal_id: draft.id,
        attestations: {
          talent_evidence_reviewed: true,
          constraints_reviewed: true,
          submittal_risk_acknowledged: true,
        },
        requestId: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b0001',
      });
      expect(view.state).toBe('submitted');
      expect(view.confirmed_at).toBeInstanceOf(Date);
      const reread = await repo.findById({ tenant_id: TENANT_A, id: draft.id });
      expect(reread?.state).toBe('submitted');
      expect(reread?.confirmed_at).toBeInstanceOf(Date);
    });

    it('M4 PR-4: confirm on already-submitted row → SUBMITTAL_ALREADY_CONFIRMED 409; row unchanged', async () => {
      const talentJ = 'aaaaaaaa-0000-7000-8000-0000000a1002';
      const jobJ = 'cccccccc-0000-7000-8000-0000000c1002';
      const examJ = '11110000-0000-7000-8000-0000000e1002';
      await seedExamination(setupClient, {
        id: examJ,
        tenant_id: TENANT_A,
        tier: 'ENTRUSTABLE',
        lifecycle_state: 'active',
        talent_id: talentJ,
        job_id: jobJ,
      });
      const draft = await repo.createSubmittal(
        makeInput({ examination_id: examJ, talent_id: talentJ, job_id: jobJ }),
      );
      // First confirm succeeds.
      await repo.confirmSubmittal({
        tenant_id: TENANT_A,
        submittal_id: draft.id,
        attestations: {
          talent_evidence_reviewed: true,
          constraints_reviewed: true,
          submittal_risk_acknowledged: true,
        },
        requestId: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b0002',
      });
      const before = await repo.findById({ tenant_id: TENANT_A, id: draft.id });
      // Second confirm refuses.
      try {
        await repo.confirmSubmittal({
          tenant_id: TENANT_A,
          submittal_id: draft.id,
          attestations: {
            talent_evidence_reviewed: true,
            constraints_reviewed: true,
            submittal_risk_acknowledged: true,
          },
          requestId: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b0003',
        });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as AramoError).code).toBe('SUBMITTAL_ALREADY_CONFIRMED');
      }
      const after = await repo.findById({ tenant_id: TENANT_A, id: draft.id });
      expect(after?.confirmed_at?.toISOString()).toBe(before?.confirmed_at?.toISOString());
    });

    it('M4 PR-4: pin outdated by newer snapshot → EXAMINATION_PINNED_OUTDATED 409; row unchanged', async () => {
      // Use a fresh (talent, job) pair so other tests don't contaminate
      // the "latest" computation.
      const olderId = '11111111-aaaa-7000-8000-000000000201';
      const newerId = '11111111-aaaa-7000-8000-000000000202';
      const talentX = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
      const jobX = 'ffffffff-ffff-7fff-8fff-ffffffffffff';
      await seedExamination(setupClient, {
        id: olderId,
        tenant_id: TENANT_A,
        tier: 'ENTRUSTABLE',
        lifecycle_state: 'active',
        talent_id: talentX,
        job_id: jobX,
        computed_at: '2026-05-20T09:00:00Z',
      });
      const draft = await repo.createSubmittal(
        makeInput({
          examination_id: olderId,
          talent_id: talentX,
          job_id: jobX,
        }),
      );
      // Seed a newer snapshot AFTER the draft.
      await seedExamination(setupClient, {
        id: newerId,
        tenant_id: TENANT_A,
        tier: 'ENTRUSTABLE',
        lifecycle_state: 'active',
        talent_id: talentX,
        job_id: jobX,
        computed_at: '2026-05-22T09:00:00Z',
      });
      try {
        await repo.confirmSubmittal({
          tenant_id: TENANT_A,
          submittal_id: draft.id,
          attestations: {
            talent_evidence_reviewed: true,
            constraints_reviewed: true,
            submittal_risk_acknowledged: true,
          },
          requestId: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b0004',
        });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as AramoError).code).toBe('EXAMINATION_PINNED_OUTDATED');
      }
      const reread = await repo.findById({ tenant_id: TENANT_A, id: draft.id });
      expect(reread?.state).toBe('draft');
      expect(reread?.confirmed_at).toBeNull();
    });

    it('M4 PR-4: pin lifecycle archived → EXAMINATION_PINNED_OUTDATED 409; row unchanged', async () => {
      const talentY = '88888888-7777-7777-7777-888888888888';
      const jobY = '99999999-7777-7777-7777-999999999999';
      const archivedId = '11111111-aaaa-7000-8000-000000000301';
      await seedExamination(setupClient, {
        id: archivedId,
        tenant_id: TENANT_A,
        tier: 'ENTRUSTABLE',
        lifecycle_state: 'active',
        talent_id: talentY,
        job_id: jobY,
      });
      const draft = await repo.createSubmittal(
        makeInput({
          examination_id: archivedId,
          talent_id: talentY,
          job_id: jobY,
        }),
      );
      // Archive the snapshot via raw SQL (bypassing the closed
      // markSuperseded surface — the column-scoped trigger permits
      // lifecycle-only writes).
      await setupClient.$executeRawUnsafe(
        `UPDATE examination."TalentJobExamination"
           SET lifecycle_state = 'archived'::examination."ExaminationLifecycleState",
               archived_at = '2026-05-23T00:00:00Z'::timestamptz
           WHERE id = '${archivedId}'::uuid`,
      );
      try {
        await repo.confirmSubmittal({
          tenant_id: TENANT_A,
          submittal_id: draft.id,
          attestations: {
            talent_evidence_reviewed: true,
            constraints_reviewed: true,
            submittal_risk_acknowledged: true,
          },
          requestId: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b0005',
        });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as AramoError).code).toBe('EXAMINATION_PINNED_OUTDATED');
      }
      const reread = await repo.findById({ tenant_id: TENANT_A, id: draft.id });
      expect(reread?.state).toBe('draft');
    });

    it('M4 PR-4: Stretch re-check via raw-SQL draft → SUBMITTAL_STRETCH_BLOCKED 422; row unchanged', async () => {
      // The create-time gate blocks STRETCH at the create endpoint, so
      // we bypass that gate by writing a draft directly via raw SQL to
      // exercise the confirm-time defense.
      const stretchSubmittalId = '99990000-0000-7000-8000-000000000999';
      const stretchPkgId = '99990000-0000-7000-8000-0000000010aa';
      await submittalPrisma.$executeRawUnsafe(
        `INSERT INTO evidence."TalentJobEvidencePackage"
           (id, tenant_id, talent_id, job_id, examination_id,
            talent_identity, contact_summary, capability_summary,
            match_justification, recruiter_contribution, engagement_event_refs)
         VALUES ('${stretchPkgId}'::uuid, '${TENANT_A}'::uuid,
                 '${TALENT_A}'::uuid, '${JOB_ID}'::uuid,
                 '${STRETCH_EXAM_ID}'::uuid,
                 '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
                 '{}'::jsonb, '{}'::jsonb, '[]'::jsonb)`,
      );
      await submittalPrisma.$executeRawUnsafe(
        `INSERT INTO engagement."TalentSubmittalRecord"
           (id, tenant_id, talent_id, job_id, evidence_package_id,
            pinned_examination_id, state, created_by)
         VALUES ('${stretchSubmittalId}'::uuid, '${TENANT_A}'::uuid,
                 '${TALENT_A}'::uuid, '${JOB_ID}'::uuid,
                 '${stretchPkgId}'::uuid,
                 '${STRETCH_EXAM_ID}'::uuid,
                 'draft'::engagement."SubmittalState",
                 '${RECRUITER_ID}'::uuid)`,
      );
      try {
        await repo.confirmSubmittal({
          tenant_id: TENANT_A,
          submittal_id: stretchSubmittalId,
          attestations: {
            talent_evidence_reviewed: true,
            constraints_reviewed: true,
            submittal_risk_acknowledged: true,
          },
          requestId: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b0006',
        });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as AramoError).code).toBe('SUBMITTAL_STRETCH_BLOCKED');
      }
      const reread = await repo.findById({
        tenant_id: TENANT_A,
        id: stretchSubmittalId,
      });
      expect(reread?.state).toBe('draft');
    });

    it('M4 PR-4: Worth Considering missing justification → JUSTIFICATION_REQUIRED 422; row unchanged', async () => {
      const talentZ = 'eeeeeeee-eeee-7eee-8eee-eeeeeeee1111';
      const jobZ = 'ffffffff-ffff-7fff-8fff-ffffffff1111';
      const wcExamId = '22220000-0000-7000-8000-000000000401';
      await seedExamination(setupClient, {
        id: wcExamId,
        tenant_id: TENANT_A,
        tier: 'WORTH_CONSIDERING',
        lifecycle_state: 'active',
        talent_id: talentZ,
        job_id: jobZ,
      });
      const draft = await repo.createSubmittal(
        makeInput({
          examination_id: wcExamId,
          talent_id: talentZ,
          job_id: jobZ,
          // No justification, no acknowledgments.
        }),
      );
      try {
        await repo.confirmSubmittal({
          tenant_id: TENANT_A,
          submittal_id: draft.id,
          attestations: {
            talent_evidence_reviewed: true,
            constraints_reviewed: true,
            submittal_risk_acknowledged: true,
          },
          requestId: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b0007',
        });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as AramoError).code).toBe('JUSTIFICATION_REQUIRED');
      }
      const reread = await repo.findById({ tenant_id: TENANT_A, id: draft.id });
      expect(reread?.state).toBe('draft');
    });

    it('M4 PR-4: Worth Considering missing acknowledgments → JUSTIFICATION_REQUIRED 422', async () => {
      const talentZ2 = 'eeeeeeee-eeee-7eee-8eee-eeeeeeee2222';
      const jobZ2 = 'ffffffff-ffff-7fff-8fff-ffffffff2222';
      const wcExam2 = '22220000-0000-7000-8000-000000000402';
      await seedExamination(setupClient, {
        id: wcExam2,
        tenant_id: TENANT_A,
        tier: 'WORTH_CONSIDERING',
        lifecycle_state: 'active',
        talent_id: talentZ2,
        job_id: jobZ2,
      });
      // Justification present, but acknowledgments absent.
      const draft = await repo.createSubmittal(
        makeInput({
          examination_id: wcExam2,
          talent_id: talentZ2,
          job_id: jobZ2,
          justification: 'Strong soft skills despite missing certification',
        }),
      );
      try {
        await repo.confirmSubmittal({
          tenant_id: TENANT_A,
          submittal_id: draft.id,
          attestations: {
            talent_evidence_reviewed: true,
            constraints_reviewed: true,
            submittal_risk_acknowledged: true,
          },
          requestId: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b0008',
        });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as AramoError).code).toBe('JUSTIFICATION_REQUIRED');
      }
    });

    it('M4 PR-4: cross-tenant confirm → NOT_FOUND 404 (no row visible)', async () => {
      const tenantBDraft = await repo.createSubmittal(
        makeInput({ tenant_id: TENANT_B, examination_id: TENANT_B_EXAM_ID }),
      );
      try {
        await repo.confirmSubmittal({
          tenant_id: TENANT_A,
          submittal_id: tenantBDraft.id,
          attestations: {
            talent_evidence_reviewed: true,
            constraints_reviewed: true,
            submittal_risk_acknowledged: true,
          },
          requestId: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b0009',
        });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as AramoError).code).toBe('NOT_FOUND');
      }
    });

    // =========================================================================
    // M4 PR-6 §4.8 — integration tests for the read-side endpoints (2 new)
    // =========================================================================
    //
    // The Stage 4 read endpoints (getSubmittal + getEvidencePackage) ride on
    // SubmittalRepository.findById + EvidenceRepository.findById — both
    // ready-to-consume PR-3 / PR-1 substrate (no new repository methods).
    // These tests assert the substrate behaviour PR-6's controllers depend
    // on:
    //   1. Cross-tenant access via findById returns null (NOT_FOUND in HTTP
    //      layer).
    //   2. Get-then-evidence chain: both findById calls succeed end-to-end
    //      when tenant matches; the linked package can be loaded by id.

    it('M4 PR-6: cross-tenant findById returns null (HTTP layer raises NOT_FOUND)', async () => {
      // Seed a fresh (talent, job, examination) so we don't conflict with
      // earlier tests in the suite.
      const talentP = 'aaaaaaaa-0000-7000-8000-0000000a6001';
      const jobP = 'cccccccc-0000-7000-8000-0000000c6001';
      const examP = '11110000-0000-7000-8000-0000000e6001';
      await seedExamination(setupClient, {
        id: examP,
        tenant_id: TENANT_A,
        tier: 'ENTRUSTABLE',
        lifecycle_state: 'active',
        talent_id: talentP,
        job_id: jobP,
      });
      const tenantADraft = await repo.createSubmittal(
        makeInput({ examination_id: examP, talent_id: talentP, job_id: jobP }),
      );
      // Tenant A can see it.
      const seenByA = await repo.findById({
        tenant_id: TENANT_A,
        id: tenantADraft.id,
      });
      expect(seenByA).not.toBeNull();
      // Tenant B cannot.
      const seenByB = await repo.findById({
        tenant_id: TENANT_B,
        id: tenantADraft.id,
      });
      expect(seenByB).toBeNull();
    });

    // =========================================================================
    // M4 PR-7 §4.10 — revokeSubmittal integration tests + extended
    // PR-3 immutability block.
    // =========================================================================

    it('M4 PR-7: successful revoke + state-isolation byte-identity (TalentJobEvidencePackage unchanged)', async () => {
      // Audit §M Q3 refinement — single revoke, not a 3-sequential
      // chain. Seed isolated (talent, job, examination), drive draft →
      // submitted via raw SQL through the column-scoped trigger, then
      // call repo.revokeSubmittal and assert state='revoked' +
      // evidence-package row hash byte-identical pre/post.
      const talentR = 'aaaaaaaa-0000-7000-8000-0000000a7001';
      const jobR = 'cccccccc-0000-7000-8000-0000000c7001';
      const examR = '11110000-0000-7000-8000-0000000e7001';
      await seedExamination(setupClient, {
        id: examR,
        tenant_id: TENANT_A,
        tier: 'ENTRUSTABLE',
        lifecycle_state: 'active',
        talent_id: talentR,
        job_id: jobR,
      });
      const draft = await repo.createSubmittal(
        makeInput({
          examination_id: examR,
          talent_id: talentR,
          job_id: jobR,
        }),
      );
      // Drive draft → submitted via raw SQL (Transition A through the
      // column-scoped trigger) so the row is eligible for revoke.
      await submittalPrisma.$executeRawUnsafe(
        `UPDATE engagement."TalentSubmittalRecord"
           SET state = 'submitted'::engagement."SubmittalState",
               confirmed_at = '2026-05-23T13:00:00Z'::timestamptz
           WHERE id = '${draft.id}'::uuid`,
      );

      // Capture pre-revoke evidence-package row hash.
      const preRows = (await submittalPrisma.$queryRawUnsafe(
        `SELECT * FROM evidence."TalentJobEvidencePackage" WHERE id = '${draft.evidence_package_id}'::uuid`,
      )) as Array<Record<string, unknown>>;
      const preHash = hashRow(preRows[0]!);

      const revoker = '00000000-0000-7000-8000-000000000bb2';
      const view = await repo.revokeSubmittal({
        tenant_id: TENANT_A,
        submittal_id: draft.id,
        revoked_by: revoker,
        revocation_justification: 'Hiring manager paused requisition.',
        requestId: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b7001',
      });
      expect(view.state).toBe('revoked');
      expect(view.revoked_at).toBeInstanceOf(Date);
      expect(view.revoked_by).toBe(revoker);
      expect(view.revocation_justification).toBe('Hiring manager paused requisition.');

      // Re-read the submittal directly and confirm state='revoked' +
      // metadata persisted.
      const reread = await repo.findById({ tenant_id: TENANT_A, id: draft.id });
      expect(reread?.state).toBe('revoked');
      expect(reread?.revoked_at).toBeInstanceOf(Date);
      expect(reread?.revoked_by).toBe(revoker);

      // State-isolation byte-identity: evidence-package row hash must
      // be unchanged post-revoke.
      const postRows = (await submittalPrisma.$queryRawUnsafe(
        `SELECT * FROM evidence."TalentJobEvidencePackage" WHERE id = '${draft.evidence_package_id}'::uuid`,
      )) as Array<Record<string, unknown>>;
      const postHash = hashRow(postRows[0]!);
      expect(postHash).toBe(preHash);
    });

    it('M4 PR-7: revoke on draft → REVOKE_NOT_ALLOWED 422; row unchanged', async () => {
      const talentRd = 'aaaaaaaa-0000-7000-8000-0000000a7011';
      const jobRd = 'cccccccc-0000-7000-8000-0000000c7011';
      const examRd = '11110000-0000-7000-8000-0000000e7011';
      await seedExamination(setupClient, {
        id: examRd,
        tenant_id: TENANT_A,
        tier: 'ENTRUSTABLE',
        lifecycle_state: 'active',
        talent_id: talentRd,
        job_id: jobRd,
      });
      const draft = await repo.createSubmittal(
        makeInput({
          examination_id: examRd,
          talent_id: talentRd,
          job_id: jobRd,
        }),
      );
      try {
        await repo.revokeSubmittal({
          tenant_id: TENANT_A,
          submittal_id: draft.id,
          revoked_by: '00000000-0000-7000-8000-000000000bb2',
          revocation_justification: 'should refuse on draft',
          requestId: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b7002',
        });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as AramoError).code).toBe('REVOKE_NOT_ALLOWED');
        expect((err as AramoError).statusCode).toBe(422);
        expect((err as AramoError).context.details).toMatchObject({
          current_state: 'draft',
        });
      }
      const reread = await repo.findById({ tenant_id: TENANT_A, id: draft.id });
      expect(reread?.state).toBe('draft');
      expect(reread?.revoked_at).toBeNull();
    });

    it('M4 PR-7: revoke on already-revoked → REVOKE_NOT_ALLOWED 422; row unchanged', async () => {
      const talentRr = 'aaaaaaaa-0000-7000-8000-0000000a7021';
      const jobRr = 'cccccccc-0000-7000-8000-0000000c7021';
      const examRr = '11110000-0000-7000-8000-0000000e7021';
      await seedExamination(setupClient, {
        id: examRr,
        tenant_id: TENANT_A,
        tier: 'ENTRUSTABLE',
        lifecycle_state: 'active',
        talent_id: talentRr,
        job_id: jobRr,
      });
      const draft = await repo.createSubmittal(
        makeInput({
          examination_id: examRr,
          talent_id: talentRr,
          job_id: jobRr,
        }),
      );
      // Drive draft → submitted then submitted → revoked via raw SQL.
      await submittalPrisma.$executeRawUnsafe(
        `UPDATE engagement."TalentSubmittalRecord"
           SET state = 'submitted'::engagement."SubmittalState",
               confirmed_at = '2026-05-23T13:00:00Z'::timestamptz
           WHERE id = '${draft.id}'::uuid`,
      );
      const revoker = '00000000-0000-7000-8000-000000000bb2';
      await repo.revokeSubmittal({
        tenant_id: TENANT_A,
        submittal_id: draft.id,
        revoked_by: revoker,
        revocation_justification: 'first revoke',
        requestId: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b7003',
      });
      const beforeSecond = await repo.findById({
        tenant_id: TENANT_A,
        id: draft.id,
      });
      try {
        await repo.revokeSubmittal({
          tenant_id: TENANT_A,
          submittal_id: draft.id,
          revoked_by: revoker,
          revocation_justification: 'second revoke attempt',
          requestId: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b7004',
        });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as AramoError).code).toBe('REVOKE_NOT_ALLOWED');
        expect((err as AramoError).context.details).toMatchObject({
          current_state: 'revoked',
        });
      }
      const afterSecond = await repo.findById({
        tenant_id: TENANT_A,
        id: draft.id,
      });
      expect(afterSecond?.revoked_at?.toISOString()).toBe(
        beforeSecond?.revoked_at?.toISOString(),
      );
      expect(afterSecond?.revocation_justification).toBe('first revoke');
    });

    it('M4 PR-7: post-revoke immutability — any UPDATE attempt raises check_violation', async () => {
      const talentPi = 'aaaaaaaa-0000-7000-8000-0000000a7031';
      const jobPi = 'cccccccc-0000-7000-8000-0000000c7031';
      const examPi = '11110000-0000-7000-8000-0000000e7031';
      await seedExamination(setupClient, {
        id: examPi,
        tenant_id: TENANT_A,
        tier: 'ENTRUSTABLE',
        lifecycle_state: 'active',
        talent_id: talentPi,
        job_id: jobPi,
      });
      const draft = await repo.createSubmittal(
        makeInput({
          examination_id: examPi,
          talent_id: talentPi,
          job_id: jobPi,
        }),
      );
      await submittalPrisma.$executeRawUnsafe(
        `UPDATE engagement."TalentSubmittalRecord"
           SET state = 'submitted'::engagement."SubmittalState",
               confirmed_at = '2026-05-23T13:00:00Z'::timestamptz
           WHERE id = '${draft.id}'::uuid`,
      );
      await repo.revokeSubmittal({
        tenant_id: TENANT_A,
        submittal_id: draft.id,
        revoked_by: '00000000-0000-7000-8000-000000000bb2',
        revocation_justification: 'revoke for post-immutability test',
        requestId: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b7005',
      });
      // Attempt to overwrite revocation_justification on the
      // already-revoked row — trigger refuses both transitions, so
      // raises.
      await expect(
        submittalPrisma.$executeRawUnsafe(
          `UPDATE engagement."TalentSubmittalRecord"
             SET revocation_justification = 'overwritten'
             WHERE id = '${draft.id}'::uuid`,
        ),
      ).rejects.toThrow(/column-scoped immutable per Group 2 §2.6/);
    });

    // -------------------------------------------------------------------------
    // EXTENDED PR-3 immutability test block (directive §A2 audit) —
    // covers Transition B allow + 5 new refusal cases on the column-
    // scoped trigger.
    // -------------------------------------------------------------------------

    it('M4 PR-7 trigger: Transition B allow — raw SQL submitted → revoked with all columns populated atomically', async () => {
      const talentTb = 'aaaaaaaa-0000-7000-8000-0000000a7041';
      const jobTb = 'cccccccc-0000-7000-8000-0000000c7041';
      const examTb = '11110000-0000-7000-8000-0000000e7041';
      await seedExamination(setupClient, {
        id: examTb,
        tenant_id: TENANT_A,
        tier: 'ENTRUSTABLE',
        lifecycle_state: 'active',
        talent_id: talentTb,
        job_id: jobTb,
      });
      const draft = await repo.createSubmittal(
        makeInput({
          examination_id: examTb,
          talent_id: talentTb,
          job_id: jobTb,
        }),
      );
      await submittalPrisma.$executeRawUnsafe(
        `UPDATE engagement."TalentSubmittalRecord"
           SET state = 'submitted'::engagement."SubmittalState",
               confirmed_at = '2026-05-23T13:00:00Z'::timestamptz
           WHERE id = '${draft.id}'::uuid`,
      );
      // Raw SQL submitted → revoked with all three columns atomic.
      await submittalPrisma.$executeRawUnsafe(
        `UPDATE engagement."TalentSubmittalRecord"
           SET state = 'revoked'::engagement."SubmittalState",
               revoked_at = '2026-05-23T15:00:00Z'::timestamptz,
               revoked_by = '00000000-0000-7000-8000-000000000bb2'::uuid,
               revocation_justification = 'Transition B raw allow'
           WHERE id = '${draft.id}'::uuid`,
      );
      const reread = await repo.findById({ tenant_id: TENANT_A, id: draft.id });
      expect(reread?.state).toBe('revoked');
      expect(reread?.revocation_justification).toBe('Transition B raw allow');
    });

    it('M4 PR-7 trigger: draft → revoked refuse (illegal direct jump)', async () => {
      const talentI1 = 'aaaaaaaa-0000-7000-8000-0000000a7051';
      const jobI1 = 'cccccccc-0000-7000-8000-0000000c7051';
      const examI1 = '11110000-0000-7000-8000-0000000e7051';
      await seedExamination(setupClient, {
        id: examI1,
        tenant_id: TENANT_A,
        tier: 'ENTRUSTABLE',
        lifecycle_state: 'active',
        talent_id: talentI1,
        job_id: jobI1,
      });
      const draft = await repo.createSubmittal(
        makeInput({
          examination_id: examI1,
          talent_id: talentI1,
          job_id: jobI1,
        }),
      );
      await expect(
        submittalPrisma.$executeRawUnsafe(
          `UPDATE engagement."TalentSubmittalRecord"
             SET state = 'revoked'::engagement."SubmittalState",
                 revoked_at = '2026-05-23T15:00:00Z'::timestamptz,
                 revoked_by = '00000000-0000-7000-8000-000000000bb2'::uuid,
                 revocation_justification = 'illegal direct jump'
             WHERE id = '${draft.id}'::uuid`,
        ),
      ).rejects.toThrow(/column-scoped immutable per Group 2 §2.6/);
    });

    it('M4 PR-7 trigger: revoked → submitted refuse (illegal reverse)', async () => {
      const talentI2 = 'aaaaaaaa-0000-7000-8000-0000000a7061';
      const jobI2 = 'cccccccc-0000-7000-8000-0000000c7061';
      const examI2 = '11110000-0000-7000-8000-0000000e7061';
      await seedExamination(setupClient, {
        id: examI2,
        tenant_id: TENANT_A,
        tier: 'ENTRUSTABLE',
        lifecycle_state: 'active',
        talent_id: talentI2,
        job_id: jobI2,
      });
      const draft = await repo.createSubmittal(
        makeInput({
          examination_id: examI2,
          talent_id: talentI2,
          job_id: jobI2,
        }),
      );
      await submittalPrisma.$executeRawUnsafe(
        `UPDATE engagement."TalentSubmittalRecord"
           SET state = 'submitted'::engagement."SubmittalState",
               confirmed_at = '2026-05-23T13:00:00Z'::timestamptz
           WHERE id = '${draft.id}'::uuid`,
      );
      await submittalPrisma.$executeRawUnsafe(
        `UPDATE engagement."TalentSubmittalRecord"
           SET state = 'revoked'::engagement."SubmittalState",
               revoked_at = '2026-05-23T15:00:00Z'::timestamptz,
               revoked_by = '00000000-0000-7000-8000-000000000bb2'::uuid,
               revocation_justification = 'first revoke'
           WHERE id = '${draft.id}'::uuid`,
      );
      await expect(
        submittalPrisma.$executeRawUnsafe(
          `UPDATE engagement."TalentSubmittalRecord"
             SET state = 'submitted'::engagement."SubmittalState"
             WHERE id = '${draft.id}'::uuid`,
        ),
      ).rejects.toThrow(/column-scoped immutable per Group 2 §2.6/);
    });

    it('M4 PR-7 trigger: revoked → revoked refuse (re-revoke attempt)', async () => {
      const talentI3 = 'aaaaaaaa-0000-7000-8000-0000000a7071';
      const jobI3 = 'cccccccc-0000-7000-8000-0000000c7071';
      const examI3 = '11110000-0000-7000-8000-0000000e7071';
      await seedExamination(setupClient, {
        id: examI3,
        tenant_id: TENANT_A,
        tier: 'ENTRUSTABLE',
        lifecycle_state: 'active',
        talent_id: talentI3,
        job_id: jobI3,
      });
      const draft = await repo.createSubmittal(
        makeInput({
          examination_id: examI3,
          talent_id: talentI3,
          job_id: jobI3,
        }),
      );
      await submittalPrisma.$executeRawUnsafe(
        `UPDATE engagement."TalentSubmittalRecord"
           SET state = 'submitted'::engagement."SubmittalState",
               confirmed_at = '2026-05-23T13:00:00Z'::timestamptz
           WHERE id = '${draft.id}'::uuid`,
      );
      await submittalPrisma.$executeRawUnsafe(
        `UPDATE engagement."TalentSubmittalRecord"
           SET state = 'revoked'::engagement."SubmittalState",
               revoked_at = '2026-05-23T15:00:00Z'::timestamptz,
               revoked_by = '00000000-0000-7000-8000-000000000bb2'::uuid,
               revocation_justification = 'first revoke'
           WHERE id = '${draft.id}'::uuid`,
      );
      await expect(
        submittalPrisma.$executeRawUnsafe(
          `UPDATE engagement."TalentSubmittalRecord"
             SET revocation_justification = 'second revoke'
             WHERE id = '${draft.id}'::uuid`,
        ),
      ).rejects.toThrow(/column-scoped immutable per Group 2 §2.6/);
    });

    it('M4 PR-7 trigger: submitted → submitted refuse (re-confirm attempt)', async () => {
      const talentI4 = 'aaaaaaaa-0000-7000-8000-0000000a7081';
      const jobI4 = 'cccccccc-0000-7000-8000-0000000c7081';
      const examI4 = '11110000-0000-7000-8000-0000000e7081';
      await seedExamination(setupClient, {
        id: examI4,
        tenant_id: TENANT_A,
        tier: 'ENTRUSTABLE',
        lifecycle_state: 'active',
        talent_id: talentI4,
        job_id: jobI4,
      });
      const draft = await repo.createSubmittal(
        makeInput({
          examination_id: examI4,
          talent_id: talentI4,
          job_id: jobI4,
        }),
      );
      await submittalPrisma.$executeRawUnsafe(
        `UPDATE engagement."TalentSubmittalRecord"
           SET state = 'submitted'::engagement."SubmittalState",
               confirmed_at = '2026-05-23T13:00:00Z'::timestamptz
           WHERE id = '${draft.id}'::uuid`,
      );
      // Re-set confirmed_at to a later timestamp on the already-
      // submitted row — Transition A requires OLD.confirmed_at IS NULL,
      // so the trigger refuses.
      await expect(
        submittalPrisma.$executeRawUnsafe(
          `UPDATE engagement."TalentSubmittalRecord"
             SET confirmed_at = '2026-05-23T14:00:00Z'::timestamptz
             WHERE id = '${draft.id}'::uuid`,
        ),
      ).rejects.toThrow(/column-scoped immutable per Group 2 §2.6/);
    });

    it('M4 PR-7 trigger: state-only submitted → revoked refuse (revoke columns missing)', async () => {
      const talentI5 = 'aaaaaaaa-0000-7000-8000-0000000a7091';
      const jobI5 = 'cccccccc-0000-7000-8000-0000000c7091';
      const examI5 = '11110000-0000-7000-8000-0000000e7091';
      await seedExamination(setupClient, {
        id: examI5,
        tenant_id: TENANT_A,
        tier: 'ENTRUSTABLE',
        lifecycle_state: 'active',
        talent_id: talentI5,
        job_id: jobI5,
      });
      const draft = await repo.createSubmittal(
        makeInput({
          examination_id: examI5,
          talent_id: talentI5,
          job_id: jobI5,
        }),
      );
      await submittalPrisma.$executeRawUnsafe(
        `UPDATE engagement."TalentSubmittalRecord"
           SET state = 'submitted'::engagement."SubmittalState",
               confirmed_at = '2026-05-23T13:00:00Z'::timestamptz
           WHERE id = '${draft.id}'::uuid`,
      );
      // State moves but revoke metadata stays NULL — Transition B
      // requires all three to become non-NULL atomically.
      await expect(
        submittalPrisma.$executeRawUnsafe(
          `UPDATE engagement."TalentSubmittalRecord"
             SET state = 'revoked'::engagement."SubmittalState"
             WHERE id = '${draft.id}'::uuid`,
        ),
      ).rejects.toThrow(/column-scoped immutable per Group 2 §2.6/);
    });

    it('M4 PR-7 trigger: other-column mutation refused on submitted → revoked', async () => {
      const talentI6 = 'aaaaaaaa-0000-7000-8000-0000000a70a1';
      const jobI6 = 'cccccccc-0000-7000-8000-0000000c70a1';
      const examI6 = '11110000-0000-7000-8000-0000000e70a1';
      await seedExamination(setupClient, {
        id: examI6,
        tenant_id: TENANT_A,
        tier: 'ENTRUSTABLE',
        lifecycle_state: 'active',
        talent_id: talentI6,
        job_id: jobI6,
      });
      const draft = await repo.createSubmittal(
        makeInput({
          examination_id: examI6,
          talent_id: talentI6,
          job_id: jobI6,
        }),
      );
      await submittalPrisma.$executeRawUnsafe(
        `UPDATE engagement."TalentSubmittalRecord"
           SET state = 'submitted'::engagement."SubmittalState",
               confirmed_at = '2026-05-23T13:00:00Z'::timestamptz
           WHERE id = '${draft.id}'::uuid`,
      );
      // Transition B move + simultaneous justification mutation —
      // Transition B requires OLD.justification IS NOT DISTINCT FROM
      // NEW.justification, so the trigger refuses.
      await expect(
        submittalPrisma.$executeRawUnsafe(
          `UPDATE engagement."TalentSubmittalRecord"
             SET state = 'revoked'::engagement."SubmittalState",
                 revoked_at = '2026-05-23T15:00:00Z'::timestamptz,
                 revoked_by = '00000000-0000-7000-8000-000000000bb2'::uuid,
                 revocation_justification = 'with justification mutation',
                 justification = 'illegally mutated justification'
             WHERE id = '${draft.id}'::uuid`,
        ),
      ).rejects.toThrow(/column-scoped immutable per Group 2 §2.6/);
    });

    it('M4 PR-7: tenant isolation — cross-tenant revoke returns NOT_FOUND', async () => {
      const tenantBDraft = await repo.createSubmittal(
        makeInput({ tenant_id: TENANT_B, examination_id: TENANT_B_EXAM_ID }),
      );
      await submittalPrisma.$executeRawUnsafe(
        `UPDATE engagement."TalentSubmittalRecord"
           SET state = 'submitted'::engagement."SubmittalState",
               confirmed_at = '2026-05-23T13:00:00Z'::timestamptz
           WHERE id = '${tenantBDraft.id}'::uuid`,
      );
      try {
        await repo.revokeSubmittal({
          tenant_id: TENANT_A,
          submittal_id: tenantBDraft.id,
          revoked_by: '00000000-0000-7000-8000-000000000bb2',
          revocation_justification: 'cross-tenant attempt',
          requestId: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b7006',
        });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as AramoError).code).toBe('NOT_FOUND');
      }
    });

    it('M4 PR-7: idempotency replay — IdempotencyService same-key-same-body returns prior 200; same-key-different-body returns 409', async () => {
      // Integration-level test of the IdempotencyService contract that
      // the revoke controller relies on (PR-7 directive §4.10). Applies
      // the consent migration lazily on-demand so the IdempotencyKey
      // table exists, constructs an IdempotencyService over the same
      // Postgres testcontainer, and verifies replay + conflict.
      const consentMigration = readFileSync(
        resolve(
          __dirname,
          '../../../consent/prisma/migrations/20260429164414_initial_consent_schema/migration.sql',
        ),
        'utf8',
      );
      for (const stmt of splitDdl(consentMigration)) {
        const trimmed = stmt.trim();
        if (trimmed.length === 0) continue;
        await setupClient.$executeRawUnsafe(trimmed);
      }
      const consentPrisma = new ConsentPrismaService(
        container.getConnectionUri(),
      );
      await consentPrisma.$connect();
      const idempotency = new IdempotencyService(consentPrisma);

      const tenant = TENANT_A;
      const key = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b7100';
      const requestHash = 'hash-aaa';
      const requestId = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b7101';

      // First lookup — no prior row → proceed.
      const first = await idempotency.lookup({
        tenant_id: tenant,
        key,
        request_hash: requestHash,
        requestId,
      });
      expect(first.kind).toBe('proceed');

      // Persist a 200 response with the request_hash.
      await idempotency.persist({
        tenant_id: tenant,
        key,
        request_hash: requestHash,
        response_status: 200,
        response_body: { ok: true },
      });

      // Same key + same body → replay.
      const replay = await idempotency.lookup({
        tenant_id: tenant,
        key,
        request_hash: requestHash,
        requestId,
      });
      expect(replay.kind).toBe('replay');
      if (replay.kind === 'replay') {
        expect(replay.response_status).toBe(200);
      }

      // Same key + different body → IDEMPOTENCY_KEY_CONFLICT 409.
      try {
        await idempotency.lookup({
          tenant_id: tenant,
          key,
          request_hash: 'hash-bbb',
          requestId,
        });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as AramoError).code).toBe('IDEMPOTENCY_KEY_CONFLICT');
        expect((err as AramoError).statusCode).toBe(409);
      }

      await consentPrisma.$disconnect();
    });

    it('M4 PR-6: get-then-evidence chain — both findById calls succeed when tenant matches', async () => {
      // Use an isolated (talent, job) so the chain is unambiguously this
      // draft's package row.
      const talentQ = 'aaaaaaaa-0000-7000-8000-0000000a6002';
      const jobQ = 'cccccccc-0000-7000-8000-0000000c6002';
      const examQ = '11110000-0000-7000-8000-0000000e6002';
      await seedExamination(setupClient, {
        id: examQ,
        tenant_id: TENANT_A,
        tier: 'ENTRUSTABLE',
        lifecycle_state: 'active',
        talent_id: talentQ,
        job_id: jobQ,
      });
      const draft = await repo.createSubmittal(
        makeInput({ examination_id: examQ, talent_id: talentQ, job_id: jobQ }),
      );

      // Step 1 — load the submittal via findById (the controller's first
      // call). Tenant-scoped read returns the row.
      const submittal = await repo.findById({
        tenant_id: TENANT_A,
        id: draft.id,
      });
      expect(submittal).not.toBeNull();
      expect(submittal?.evidence_package_id).toBe(draft.evidence_package_id);

      // Step 2 — load the linked evidence package via EvidenceRepository.
      // findById (the controller's second call) using the submittal's
      // evidence_package_id and the same tenant_id.
      const evidenceRepo = new EvidenceRepository(
        evidencePrisma,
        new ExaminationRepository(examPrisma, undefined as never),
        new TalentEvidenceRepository(talentEvidencePrisma),
      );
      const evidencePackage = await evidenceRepo.findById({
        tenant_id: TENANT_A,
        id: draft.evidence_package_id,
      });
      expect(evidencePackage).not.toBeNull();
      expect(evidencePackage?.id).toBe(draft.evidence_package_id);
      expect(evidencePackage?.examination_id).toBe(examQ);
      // All five JSONB payloads must be populated (PR-2 buildPackage
      // contract; PR-6 read endpoint surfaces them verbatim).
      expect(evidencePackage?.talent_identity).toBeDefined();
      expect(evidencePackage?.contact_summary).toBeDefined();
      expect(evidencePackage?.capability_summary).toBeDefined();
      expect(evidencePackage?.match_justification).toBeDefined();
      expect(evidencePackage?.recruiter_contribution).toBeDefined();
    });
  },
);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function seedExamination(
  client: PrismaService,
  opts: {
    id: string;
    tenant_id: string;
    tier: 'ENTRUSTABLE' | 'WORTH_CONSIDERING' | 'STRETCH';
    lifecycle_state: 'active' | 'archived' | 'cold_storage';
    // M4 PR-4: optional triple overrides so confirm tests can seed on a
    // fresh (talent, job) pair without contaminating the create-flow
    // tests' shared TALENT_A / JOB_ID baseline.
    talent_id?: string;
    job_id?: string;
    computed_at?: string;
  },
): Promise<void> {
  const skillMatch = { matched_count: 5, missing_count: 0, per_skill: [] };
  const experienceMatch = { years: 7, summary: 'Strong overlap' };
  const constraintChecks = { location: 'pass' };
  const strengths = ['typescript-expertise'];
  const gaps: string[] = [];
  const riskFlags: unknown[] = [];
  const confidenceIndicators = {
    evidence_strength: { level: 'high', basis: 'ingested-evidence' },
    data_completeness: { level: 'high', basis: 'profile-complete' },
    constraint_confidence: { level: 'high', basis: 'verified' },
  };
  const freshness = { profile_age_days: 14 };
  const talentId = opts.talent_id ?? TALENT_A;
  const jobId = opts.job_id ?? JOB_ID;
  const computedAt = opts.computed_at ?? '2026-05-22T09:00:00Z';
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
       '${talentId}'::uuid,
       '${jobId}'::uuid,
       '${GOLDEN_ID}'::uuid,
       'initial_match'::examination."ExaminationTrigger",
       '${opts.tier}'::examination."ExaminationTier",
       1,
       'Strong critical-skill coverage', 'sample',
       '${JSON.stringify([])}'::jsonb,
       '${JSON.stringify(skillMatch)}'::jsonb,
       '${JSON.stringify(experienceMatch)}'::jsonb,
       '${JSON.stringify(constraintChecks)}'::jsonb,
       '${JSON.stringify(strengths)}'::jsonb,
       '${JSON.stringify(gaps)}'::jsonb,
       '${JSON.stringify(riskFlags)}'::jsonb,
       '${JSON.stringify(confidenceIndicators)}'::jsonb,
       '${JSON.stringify(freshness)}'::jsonb,
       NULL,
       'v1.0', 'v1.0', 'v1.0',
       '${computedAt}'::timestamptz,
       '${opts.lifecycle_state}'::examination."ExaminationLifecycleState",
       ${opts.lifecycle_state === 'active' ? 'NULL' : `'${computedAt}'::timestamptz`},
       NULL
     )`,
  );
}

async function countSubmittalRowsByExam(
  client: PrismaService,
  examination_id: string,
): Promise<number> {
  const rows = (await client.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM engagement."TalentSubmittalRecord" WHERE pinned_examination_id = '${examination_id}'::uuid`,
  )) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

async function countPackageRowsByExam(
  client: PrismaService,
  examination_id: string,
): Promise<number> {
  const rows = (await client.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM evidence."TalentJobEvidencePackage" WHERE examination_id = '${examination_id}'::uuid`,
  )) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

// M4 PR-7 §4.10 — deterministic byte-identity hash for the
// TalentJobEvidencePackage row used in the state-isolation
// byte-identity test. Mirrors the hashRowAsJson helper in
// pact/provider/src/verify-api.ts (M4 PR-5 origin): canonicalize keys
// (sort) so adapter-side ordering wobble is normalized out, then
// sha256 the JSON.
function hashRow(row: Record<string, unknown>): string {
  const sortedKeys = Object.keys(row).sort();
  const canonical: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    const v = row[k];
    canonical[k] = v instanceof Date ? v.toISOString() : v;
  }
  const json = JSON.stringify(canonical);
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(json).digest('hex');
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
