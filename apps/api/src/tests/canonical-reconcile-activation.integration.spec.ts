import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  PrismaService as TePrismaService,
  TalentEvidenceRepository,
  TalentCanonicalCoverageRepository,
  TalentSkillCanonicalizationService,
} from '@aramo/talent-evidence';
import {
  RequisitionPrismaService,
  RequisitionSkillRequirementRepository,
  RequisitionSkillCanonicalizationService,
} from '@aramo/requisition';
import {
  JobDomainRepository,
  PrismaService as JobPrismaService,
  goldenProfileContentToStorage,
  type GoldenProfileContent,
} from '@aramo/job-domain';
import {
  PrismaService as SkillsPrismaService,
  SkillRepository,
  SkillAliasRepository,
  SkillVersionRepository,
  SkillRelationshipRepository,
  SkillRegistryService,
  SkillCanonicalizationService,
} from '@aramo/skills-taxonomy';
import type { CanonicalReconcileProducer } from '@aramo/canonical-reconcile';

import { CanonicalReconcileBackstop } from '../canonical-reconciliation/canonical-reconcile.backstop.js';
import { CanonicalReconcileConfig } from '../canonical-reconciliation/canonical-reconcile.config.js';
import { CanonicalReconcileCoverageService } from '../canonical-reconciliation/canonical-reconcile-coverage.service.js';

// SKILL-TAX Canonical Reconciliation Activation — the end-to-end activation proof
// (real Postgres 17; schemas skills_taxonomy + talent_evidence + job_domain +
// requisition). apps/api is the ONLY place allowed to bridge talent-evidence
// (scope:cip) and requisition (scope:ats), so the cross-domain coverage telemetry
// lives here. Proves the ACTIVATION-layer behaviours (the reconcile workers
// themselves are proven in the 1G/1D lib integration specs):
//   • the backstop RECOVERS an eligible post-watermark unreconciled talent;
//   • pre-watermark + already-reconciled rows are IGNORED (backfill guard);
//   • the far-future sentinel (unset env) makes the backstop inert (never a sweep);
//   • coverage telemetry reports NON-ZERO resolved/unresolved across BOTH domains;
//   • an unresolved skill stays a valid, counted row (never a hard failure).
const REPO_ROOT = resolve(__dirname, '../../../..');
const SKILLS = [
  '20260915140000_init_skill_registry',
  '20260915150000_skill_alias_version',
  '20260915160000_skill_relationship',
  // SKILL-TAX-1F-A — Skill.merged_into_skill_id (regen client SELECTs it). Split-safe.
  '20260917210000_skill_tax_1f_governance',
].map((n) => resolve(REPO_ROOT, `libs/skills-taxonomy/prisma/migrations/${n}/migration.sql`));
const TE = [
  '20260519170000_init_talent_evidence_model',
  '20260714120000_tr7_b1_education_certification',
  '20260915120000_hf1_resume_provenance',
  '20260915170000_hf2_experience_intelligence',
  '20260915180000_skill_tax_1g_canonical_reconciliation',
].map((n) => resolve(REPO_ROOT, `libs/talent-evidence/prisma/migrations/${n}/migration.sql`));
const JOB = [resolve(REPO_ROOT, 'libs/job-domain/prisma/migrations/20260519100000_init_job_domain_model/migration.sql')];
const REQ = [
  '20260602100000_init_requisition_model',
  '20260917120000_skill_tax_1d_requisition_skill_requirement',
].map((n) => resolve(REPO_ROOT, `libs/requisition/prisma/migrations/${n}/migration.sql`));
const ALL_MIGRATIONS = [...SKILLS, ...TE, ...JOB, ...REQ];

// Comment-blind splitter (skip ';' inside `--` lines — the splitDdl rail).
function splitDdl(sql: string): string[] {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';');
}

const ACTOR = { id: '30000000-0000-7000-8000-000000000001', type: 'platform_admin' };
const TENANT = '10000000-0000-7000-8000-000000000001';
// Never-reconciled talents used only for the watermark boundary.
const TALENT_PRE = '20000000-0000-7000-8000-0000000000f1'; // created BEFORE the watermark
const TALENT_POST = '20000000-0000-7000-8000-0000000000f2'; // created AT/AFTER the watermark
// Reconciled talent that drives non-zero coverage.
const TALENT_COV = '20000000-0000-7000-8000-0000000000c1';
const SK = {
  pre: '40000000-0000-7000-8000-0000000000f1',
  post: '40000000-0000-7000-8000-0000000000f2',
  covK: '40000000-0000-7000-8000-0000000000c1',
  covFoo: '40000000-0000-7000-8000-0000000000c2',
};
const JOB_ID = '60000000-0000-7000-8000-0000000000a1';
const GP_ID = '70000000-0000-7000-8000-0000000000a1';
const REQ_ID = '80000000-0000-7000-8000-0000000000a1';

const WATERMARK = new Date('2023-01-01T00:00:00.000Z');

function fakeProducer(): CanonicalReconcileProducer & { enqueueTalent: ReturnType<typeof vi.fn> } {
  return { enqueueTalent: vi.fn().mockResolvedValue(undefined) } as never;
}
const LOGGER = { log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;

function gpContent(required: string[], critical: string[]): GoldenProfileContent {
  return {
    jd_text: '',
    generated_by: 'manual',
    required_skills: required.map((name) => ({ name })),
    preferred_skills: [],
    critical_skills: critical.map((name) => ({ name })),
    experience: { industries: [] },
    constraints: {},
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Canonical Reconciliation Activation — backstop watermark + coverage (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let tePrisma: TePrismaService;
    let reqPrisma: RequisitionPrismaService;
    let jobPrisma: JobPrismaService;
    let skillsPrisma: SkillsPrismaService;
    let coverageRepo: TalentCanonicalCoverageRepository;
    let requirementRepo: RequisitionSkillRequirementRepository;
    let coverageService: CanonicalReconcileCoverageService;

    async function insertEvidence(
      id: string,
      talent: string,
      skillId: string,
      surface: string,
      createdAt: string,
    ): Promise<void> {
      await tePrisma.$executeRawUnsafe(
        `INSERT INTO "talent_evidence"."TalentSkillEvidence"
           ("id","talent_id","tenant_id","skill_id","surface_form","source","version","usage_start","usage_end","created_at")
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,'declared',NULL,NULL,NULL,$6::timestamptz)`,
        id,
        talent,
        TENANT,
        skillId,
        surface,
        createdAt,
      );
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const setup = new TePrismaService(url);
      await setup.$connect();
      for (const path of ALL_MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          const t = stmt.trim();
          if (t.length === 0) continue;
          await setup.$executeRawUnsafe(t);
        }
      }
      await setup.$disconnect();

      tePrisma = new TePrismaService(url);
      await tePrisma.$connect();
      reqPrisma = new RequisitionPrismaService(url);
      await reqPrisma.$connect();
      jobPrisma = new JobPrismaService(url);
      await jobPrisma.$connect();
      skillsPrisma = new SkillsPrismaService(url);
      await skillsPrisma.$connect();

      const skillRepo = new SkillRepository(skillsPrisma);
      const aliasRepo = new SkillAliasRepository(skillsPrisma);
      const versionRepo = new SkillVersionRepository(skillsPrisma);
      const registry = new SkillRegistryService(
        skillRepo,
        aliasRepo,
        versionRepo,
        new SkillRelationshipRepository(skillsPrisma),
      );
      const teRepo = new TalentEvidenceRepository(tePrisma);
      const jobRepo = new JobDomainRepository(jobPrisma);
      coverageRepo = new TalentCanonicalCoverageRepository(tePrisma);
      requirementRepo = new RequisitionSkillRequirementRepository(reqPrisma);
      coverageService = new CanonicalReconcileCoverageService(coverageRepo, requirementRepo, LOGGER);

      const talentReconciler = new TalentSkillCanonicalizationService(
        teRepo,
        new SkillCanonicalizationService(skillRepo, aliasRepo, versionRepo),
      );
      const requisitionReconciler = new RequisitionSkillCanonicalizationService(
        requirementRepo,
        jobRepo,
        new SkillCanonicalizationService(skillRepo, aliasRepo, versionRepo),
      );

      // Registry: Kubernetes only (FooDB / UnknownFoo intentionally unknown).
      await registry.createSkill({ canonicalName: 'Kubernetes', actor: ACTOR });

      // Never-reconciled evidence straddling the watermark (both unreconciled).
      await insertEvidence(SK.pre, TALENT_PRE, SK.pre, 'Kubernetes', '2020-01-01T00:00:00.000Z');
      await insertEvidence(SK.post, TALENT_POST, SK.post, 'Kubernetes', '2026-06-01T00:00:00.000Z');

      // Coverage-driver talent: one resolvable (Kubernetes) + one unknown (FooDB).
      await insertEvidence(SK.covK, TALENT_COV, SK.covK, 'Kubernetes', '2026-06-01T00:00:00.000Z');
      await insertEvidence(SK.covFoo, TALENT_COV, SK.covFoo, 'FooDB', '2026-06-01T00:00:00.000Z');
      // Reconcile ONLY the coverage-driver → its rows get canonicalized_at (so it
      // no longer qualifies as backstop-eligible), while PRE/POST stay eligible.
      await talentReconciler.reconcileTalent(TENANT, TALENT_COV);

      // Requisition coverage-driver: authored GoldenProfile (Kubernetes + UnknownFoo).
      const s = goldenProfileContentToStorage(gpContent(['Kubernetes'], ['UnknownFoo']));
      await jobRepo.createGoldenProfile({
        id: GP_ID,
        tenant_id: TENANT,
        job_id: JOB_ID,
        skills: s.skills,
        experience: s.experience,
        constraints: s.constraints,
        critical_skills: s.critical_skills,
      });
      await requisitionReconciler.reconcileGoldenProfile(TENANT, REQ_ID, GP_ID);
    }, 240_000);

    afterAll(async () => {
      await tePrisma?.$disconnect();
      await reqPrisma?.$disconnect();
      await jobPrisma?.$disconnect();
      await skillsPrisma?.$disconnect();
      await container?.stop();
    }, 60_000);

    it('backstop RECOVERS the eligible post-watermark talent and IGNORES the pre-watermark one', async () => {
      const producer = fakeProducer();
      const backstop = new CanonicalReconcileBackstop(
        coverageRepo,
        producer,
        new CanonicalReconcileConfig(),
        LOGGER,
      );

      const result = await backstop.findAndEnqueueEligible(WATERMARK, 100);

      expect(result.discovered).toBe(1);
      expect(result.enqueued).toBe(1);
      expect(producer.enqueueTalent).toHaveBeenCalledTimes(1);
      expect(producer.enqueueTalent).toHaveBeenCalledWith(TENANT, TALENT_POST);
      // The pre-watermark talent is never re-driven (no de-facto historical backfill).
      expect(producer.enqueueTalent).not.toHaveBeenCalledWith(TENANT, TALENT_PRE);
      // The already-reconciled coverage talent is excluded (canonicalized_at set).
      expect(producer.enqueueTalent).not.toHaveBeenCalledWith(TENANT, TALENT_COV);
    });

    it('a wide-open watermark still excludes already-reconciled rows (idempotent eligibility)', async () => {
      const producer = fakeProducer();
      const backstop = new CanonicalReconcileBackstop(
        coverageRepo,
        producer,
        new CanonicalReconcileConfig(),
        LOGGER,
      );

      // since = epoch → PRE + POST qualify, but the reconciled coverage talent does NOT.
      const result = await backstop.findAndEnqueueEligible(new Date('1970-01-01T00:00:00.000Z'), 100);

      expect(result.enqueued).toBe(2);
      const enqueuedTalents = producer.enqueueTalent.mock.calls.map((c) => c[1]).sort();
      expect(enqueuedTalents).toEqual([TALENT_PRE, TALENT_POST].sort());
      expect(producer.enqueueTalent).not.toHaveBeenCalledWith(TENANT, TALENT_COV);
    });

    it('the far-future sentinel (env unset) makes run() inert — never a sweep', async () => {
      const prev = process.env['SKILL_CANONICAL_RECONCILE_ACTIVATED_AT'];
      delete process.env['SKILL_CANONICAL_RECONCILE_ACTIVATED_AT'];
      try {
        const producer = fakeProducer();
        const backstop = new CanonicalReconcileBackstop(
          coverageRepo,
          producer,
          new CanonicalReconcileConfig(),
          LOGGER,
        );
        const result = await backstop.run();
        expect(result.discovered).toBe(0);
        expect(result.enqueued).toBe(0);
        expect(producer.enqueueTalent).not.toHaveBeenCalled();
      } finally {
        if (prev !== undefined) process.env['SKILL_CANONICAL_RECONCILE_ACTIVATED_AT'] = prev;
      }
    });

    it('coverage telemetry reports NON-ZERO resolved + unresolved across BOTH domains', async () => {
      const report = await coverageService.report();

      // Talent: Kubernetes resolved, FooDB unresolved (both from TALENT_COV).
      expect(report.talent.resolved).toBeGreaterThanOrEqual(1);
      expect(report.talent.unresolved).toBeGreaterThanOrEqual(1);
      // The never-reconciled PRE/POST rows are counted as unattempted, not resolved.
      expect(report.talent.unattempted).toBeGreaterThanOrEqual(2);
      expect(report.talent.canonical_coverage).toBeGreaterThan(0);
      expect(report.talent.canonical_coverage).toBeLessThanOrEqual(1);

      // Requisition: Kubernetes resolved, UnknownFoo unresolved.
      expect(report.requisition.resolved).toBe(1);
      expect(report.requisition.unresolved).toBe(1);
      expect(report.requisition.canonical_coverage).toBeCloseTo(0.5, 5);
    });
  },
);
