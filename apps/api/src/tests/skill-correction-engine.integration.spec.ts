import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import {
  PrismaService as SkillsPrisma,
  SkillRepository,
  SkillAliasRepository,
  SkillVersionRepository,
  SkillRelationshipRepository,
  SkillRegistryService,
  SkillCorrectionTaskRepository,
} from '@aramo/skills-taxonomy';
import {
  PrismaService as TePrisma,
  TalentCanonicalCorrectionRepository,
} from '@aramo/talent-evidence';
import {
  RequisitionPrismaService,
  RequisitionSkillRequirementRepository,
} from '@aramo/requisition';
import type { CanonicalReconcileProducer } from '@aramo/canonical-reconcile';

import { SkillCorrectionProcessor } from '../skill-governance/skill-correction.processor.js';

// SKILL-TAX-1F-B1 — the durable correction/propagation engine end-to-end (real
// Postgres 17; schemas skills_taxonomy + talent_evidence + requisition). Proves:
// atomic task-on-merge; targeted repoint of BOTH domains; COMPLETED-gating; claim
// exclusivity; Redis-unavailable → retryable (not falsely complete); and the
// CRITICAL idempotency proof — a partial failure (talent repoint succeeds, the
// next step fails) leaves the task retryable, and a later drain CONVERGES with no
// duplicate or destructive effect.
const REPO_ROOT = resolve(__dirname, '../../../..');
const migrations = (lib: string, names: string[]) =>
  names.map((n) => resolve(REPO_ROOT, `libs/${lib}/prisma/migrations/${n}/migration.sql`));
const ALL_MIGRATIONS = [
  ...migrations('skills-taxonomy', [
    '20260915140000_init_skill_registry',
    '20260915150000_skill_alias_version',
    '20260915160000_skill_relationship',
    '20260917210000_skill_tax_1f_governance',
    '20260917211000_skill_tax_1f_audit_append_only',
    '20260918120000_skill_tax_1f_b_governance_proposal_correction',
  ]),
  ...migrations('talent-evidence', [
    '20260519170000_init_talent_evidence_model',
    '20260714120000_tr7_b1_education_certification',
    '20260915120000_hf1_resume_provenance',
    '20260915170000_hf2_experience_intelligence',
    '20260915180000_skill_tax_1g_canonical_reconciliation',
  ]),
  ...migrations('requisition', [
    '20260602100000_init_requisition_model',
    '20260917120000_skill_tax_1d_requisition_skill_requirement',
  ]),
];

const ACTOR = { id: '55555555-5555-7555-8555-555555555555', type: 'platform_admin' };
const TENANT = '10000000-0000-7000-8000-000000000001';
const TALENT = '20000000-0000-7000-8000-000000000001';
const REQ_ID = '30000000-0000-7000-8000-000000000001';
const GP_ID = '40000000-0000-7000-8000-000000000001';
const LOGGER = { log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'SKILL-TAX-1F-B1 correction engine — durable merge propagation (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let skillsPrisma: SkillsPrisma;
    let tePrisma: TePrisma;
    let reqPrisma: RequisitionPrismaService;
    let registry: SkillRegistryService;
    let skillRepo: SkillRepository;
    let taskRepo: SkillCorrectionTaskRepository;
    let talentCorrection: TalentCanonicalCorrectionRepository;
    let reqRepo: RequisitionSkillRequirementRepository;
    let producer: CanonicalReconcileProducer & {
      enqueueTalent: ReturnType<typeof vi.fn>;
      enqueueRequisition: ReturnType<typeof vi.fn>;
      enqueueTalentRequired: ReturnType<typeof vi.fn>;
      enqueueRequisitionRequired: ReturnType<typeof vi.fn>;
    };

    async function seedEvidence(canonical: string): Promise<void> {
      await tePrisma.$executeRawUnsafe(
        `INSERT INTO "talent_evidence"."TalentSkillEvidence"
           ("id","talent_id","tenant_id","skill_id","surface_form","source","canonical_skill_id",
            "canonicalization_status","canonicalization_method","canonicalized_at","created_at")
         VALUES (gen_random_uuid(),$1::uuid,$2::uuid,gen_random_uuid(),'Kubernetes','declared',$3::uuid,
            'RESOLVED','EXACT_CANONICAL',NOW(),NOW())`,
        TALENT, TENANT, canonical,
      );
    }
    async function seedRequirement(canonical: string): Promise<void> {
      await reqPrisma.$executeRawUnsafe(
        `INSERT INTO "requisition"."RequisitionSkillRequirement"
           ("id","tenant_id","requisition_id","golden_profile_id","requirement_type","raw_surface_form",
            "version_requirement","canonical_skill_id","canonical_version_id","canonicalization_status",
            "canonicalization_method","canonicalized_at")
         VALUES (gen_random_uuid(),$1::uuid,$2::uuid,$3::uuid,'critical','Kubernetes',NULL,$4::uuid,NULL,
            'RESOLVED','EXACT_CANONICAL',NOW())`,
        TENANT, REQ_ID, GP_ID, canonical,
      );
    }
    const talentCanonOf = async (): Promise<(string | null)[]> =>
      (await tePrisma.$queryRawUnsafe<{ canonical_skill_id: string | null }[]>(
        `SELECT "canonical_skill_id" FROM "talent_evidence"."TalentSkillEvidence" WHERE "talent_id" = '${TALENT}'::uuid`,
      )).map((r) => r.canonical_skill_id);
    const reqCanonOf = async (): Promise<(string | null)[]> =>
      (await reqPrisma.$queryRawUnsafe<{ canonical_skill_id: string | null }[]>(
        `SELECT "canonical_skill_id" FROM "requisition"."RequisitionSkillRequirement" WHERE "golden_profile_id" = '${GP_ID}'::uuid`,
      )).map((r) => r.canonical_skill_id);

    function makeProcessor(reqRepoOverride?: RequisitionSkillRequirementRepository): SkillCorrectionProcessor {
      return new SkillCorrectionProcessor(
        taskRepo,
        talentCorrection,
        reqRepoOverride ?? reqRepo,
        producer,
        LOGGER,
      );
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const db = new Client({ connectionString: url });
      await db.connect();
      for (const p of ALL_MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await db.end();

      skillsPrisma = new SkillsPrisma(url);
      await skillsPrisma.$connect();
      tePrisma = new TePrisma(url);
      await tePrisma.$connect();
      reqPrisma = new RequisitionPrismaService(url);
      await reqPrisma.$connect();

      skillRepo = new SkillRepository(skillsPrisma);
      registry = new SkillRegistryService(
        skillRepo,
        new SkillAliasRepository(skillsPrisma),
        new SkillVersionRepository(skillsPrisma),
        new SkillRelationshipRepository(skillsPrisma),
      );
      taskRepo = new SkillCorrectionTaskRepository(skillsPrisma);
      talentCorrection = new TalentCanonicalCorrectionRepository(tePrisma);
      reqRepo = new RequisitionSkillRequirementRepository(reqPrisma);
      producer = {
        enqueueTalent: vi.fn().mockResolvedValue(undefined),
        enqueueRequisition: vi.fn().mockResolvedValue(undefined),
        // The correction processor uses the REQUIRED (non-swallowing) variants.
        enqueueTalentRequired: vi.fn().mockResolvedValue(undefined),
        enqueueRequisitionRequired: vi.fn().mockResolvedValue(undefined),
      } as never;
    }, 240_000);

    // Per-test isolation: the drain processes ALL pending tasks, so each test starts
    // from an empty task queue + empty domain rows. SkillAuditEvent is append-only
    // (DELETE-rejecting trigger) and is intentionally NOT truncated; Skills persist
    // (each test uses unique canonical names).
    beforeEach(async () => {
      await skillsPrisma.$executeRawUnsafe('TRUNCATE TABLE "skills_taxonomy"."SkillCorrectionTask"');
      await tePrisma.$executeRawUnsafe('TRUNCATE TABLE "talent_evidence"."TalentSkillEvidence"');
      await reqPrisma.$executeRawUnsafe('TRUNCATE TABLE "requisition"."RequisitionSkillRequirement"');
      // Reset producer mocks to their default (resolve) so per-test rejections
      // (mockRejectedValueOnce) do not leak across tests.
      producer.enqueueTalent.mockReset().mockResolvedValue(undefined);
      producer.enqueueRequisition.mockReset().mockResolvedValue(undefined);
      (producer.enqueueTalentRequired as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(undefined);
      (producer.enqueueRequisitionRequired as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(undefined);
    });

    afterAll(async () => {
      await skillsPrisma?.$disconnect();
      await tePrisma?.$disconnect();
      await reqPrisma?.$disconnect();
      await container?.stop();
    }, 60_000);

    it('mergeSkill creates a SkillCorrectionTask(PENDING) ATOMICALLY with the mutation + audit', async () => {
      const winner = await registry.createSkill({ canonicalName: 'Kubernetes', actor: ACTOR });
      const loser = await registry.createSkill({ canonicalName: 'Kube', actor: ACTOR });
      await registry.mergeSkill(loser.id, winner.id, ACTOR);
      const tasks = await skillsPrisma.$queryRawUnsafe<{ status: string; from_canonical_skill_id: string; to_canonical_skill_id: string; correction_type: string }[]>(
        `SELECT status, from_canonical_skill_id, to_canonical_skill_id, correction_type
           FROM "skills_taxonomy"."SkillCorrectionTask" WHERE from_canonical_skill_id = '${loser.id}'::uuid`,
      );
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ status: 'PENDING', correction_type: 'SKILL_MERGE', to_canonical_skill_id: winner.id });
    });

    it('drain repoints BOTH domains loser→winner, enqueues the affected, and marks COMPLETED', async () => {
      const winner = await registry.createSkill({ canonicalName: 'PostgreSQL', actor: ACTOR });
      const loser = await registry.createSkill({ canonicalName: 'Postgres', actor: ACTOR });
      await seedEvidence(loser.id);
      await seedRequirement(loser.id);
      await registry.mergeSkill(loser.id, winner.id, ACTOR);

      const summary = await makeProcessor().drain();

      expect(summary.completed).toBeGreaterThanOrEqual(1);
      expect(await talentCanonOf()).toContain(winner.id);
      expect(await talentCanonOf()).not.toContain(loser.id);
      expect(await reqCanonOf()).toContain(winner.id);
      expect(producer.enqueueTalentRequired).toHaveBeenCalledWith(TENANT, TALENT);
      expect(producer.enqueueRequisitionRequired).toHaveBeenCalledWith(TENANT, REQ_ID, GP_ID);
    });

    it('claim is EXCLUSIVE — two concurrent claims never both get the same task', async () => {
      const w = await registry.createSkill({ canonicalName: 'Redis', actor: ACTOR });
      const l = await registry.createSkill({ canonicalName: 'RedisCache', actor: ACTOR });
      await registry.mergeSkill(l.id, w.id, ACTOR);
      const [a, b] = await Promise.all([taskRepo.claimNextPending(), taskRepo.claimNextPending()]);
      const got = [a, b].filter((t) => t !== null && t.from_canonical_skill_id === l.id);
      expect(got).toHaveLength(1); // exactly one processor claims it
    });

    it('Redis unavailable (required enqueue rejects) → task stays retryable (PENDING), NOT falsely COMPLETED', async () => {
      const w = await registry.createSkill({ canonicalName: 'Kafka', actor: ACTOR });
      const l = await registry.createSkill({ canonicalName: 'ApacheKafka', actor: ACTOR });
      await seedEvidence(l.id);
      await registry.mergeSkill(l.id, w.id, ACTOR);
      // Required enqueue throws (Redis not configured) on every attempt.
      producer.enqueueTalentRequired.mockRejectedValue(new Error('reconcile queue unavailable (REDIS_URL not configured)'));
      const summary = await makeProcessor().drain();
      expect(summary.completed).toBe(0);
      expect(summary.retried).toBeGreaterThanOrEqual(1);
      const stillPending = await skillsPrisma.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status FROM "skills_taxonomy"."SkillCorrectionTask" WHERE from_canonical_skill_id = '${l.id}'::uuid`,
      );
      expect(stillPending[0]?.status).toBe('PENDING');
    });

    it('FIX_NOW: Redis CONFIGURED but an individual enqueue CALL fails → NOT COMPLETED, retryable → next tick succeeds → COMPLETED', async () => {
      const winner = await registry.createSkill({ canonicalName: 'Ansible', actor: ACTOR });
      const loser = await registry.createSkill({ canonicalName: 'AnsibleTower', actor: ACTOR });
      await seedEvidence(loser.id);
      await seedRequirement(loser.id);
      await registry.mergeSkill(loser.id, winner.id, ACTOR);

      // Redis IS configured; the requisition enqueue queue.add fails exactly once
      // (after the repoints + the talent enqueue have already run).
      producer.enqueueRequisitionRequired.mockRejectedValueOnce(new Error('queue.add transient failure'));

      const first = await makeProcessor().drain();
      expect(first.completed).toBe(0);
      expect(first.retried).toBeGreaterThanOrEqual(1);
      // Repoints already applied (idempotent), but the task is NOT completed —
      // the failed required enqueue kept it retryable.
      expect(await talentCanonOf()).toContain(winner.id);
      expect(await reqCanonOf()).toContain(winner.id);
      const afterFirst = await skillsPrisma.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status FROM "skills_taxonomy"."SkillCorrectionTask" WHERE from_canonical_skill_id = '${loser.id}'::uuid`,
      );
      expect(afterFirst[0]?.status).toBe('PENDING');

      // Next tick: the enqueue now succeeds → repoints re-run idempotently, both
      // required enqueues accepted → COMPLETED, no duplicate/destructive effect.
      const second = await makeProcessor().drain();
      expect(second.completed).toBeGreaterThanOrEqual(1);
      const afterSecond = await skillsPrisma.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status FROM "skills_taxonomy"."SkillCorrectionTask" WHERE from_canonical_skill_id = '${loser.id}'::uuid`,
      );
      expect(afterSecond[0]?.status).toBe('COMPLETED');
      expect(producer.enqueueRequisitionRequired).toHaveBeenCalledWith(TENANT, REQ_ID, GP_ID);
    });

    it('CRITICAL: partial failure (requisition repoint throws once) → retryable → later drain CONVERGES idempotently', async () => {
      const winner = await registry.createSkill({ canonicalName: 'Terraform', actor: ACTOR });
      const loser = await registry.createSkill({ canonicalName: 'TF', actor: ACTOR });
      await seedEvidence(loser.id);
      await seedRequirement(loser.id);
      await registry.mergeSkill(loser.id, winner.id, ACTOR);

      // First drain: fail the requisition repoint AFTER the talent repoint has run.
      let throwOnce = true;
      // The processor only calls these two on the requisition repo — delegate to the
      // real repo, but fail the repoint exactly once (after the talent repoint runs).
      const flakyReqRepo = {
        repointCanonicalSkillId: async (from: string, to: string): Promise<number> => {
          if (throwOnce) { throwOnce = false; throw new Error('injected requisition repoint failure'); }
          return reqRepo.repointCanonicalSkillId(from, to);
        },
        findAffectedGoldenProfiles: (args: Parameters<RequisitionSkillRequirementRepository['findAffectedGoldenProfiles']>[0]) =>
          reqRepo.findAffectedGoldenProfiles(args),
      } as unknown as RequisitionSkillRequirementRepository;

      const first = await makeProcessor(flakyReqRepo).drain();
      expect(first.completed).toBe(0);
      expect(first.retried).toBeGreaterThanOrEqual(1);
      // Talent side already repointed on the failed attempt; requisition NOT yet.
      expect(await talentCanonOf()).toContain(winner.id);
      expect(await reqCanonOf()).toContain(loser.id);
      const afterFirst = await skillsPrisma.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status FROM "skills_taxonomy"."SkillCorrectionTask" WHERE from_canonical_skill_id = '${loser.id}'::uuid`,
      );
      expect(afterFirst[0]?.status).toBe('PENDING'); // retryable

      // Second drain (requisition now succeeds): talent repoint is idempotent (0 rows
      // still keyed to loser), requisition repoint completes → CONVERGES, COMPLETED.
      const second = await makeProcessor().drain();
      expect(second.completed).toBeGreaterThanOrEqual(1);
      expect(await talentCanonOf()).toContain(winner.id); // unchanged (no duplicate/destructive effect)
      expect(await reqCanonOf()).toContain(winner.id);
      expect(await reqCanonOf()).not.toContain(loser.id);
      const afterSecond = await skillsPrisma.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status FROM "skills_taxonomy"."SkillCorrectionTask" WHERE from_canonical_skill_id = '${loser.id}'::uuid`,
      );
      expect(afterSecond[0]?.status).toBe('COMPLETED');
    });
  },
);
