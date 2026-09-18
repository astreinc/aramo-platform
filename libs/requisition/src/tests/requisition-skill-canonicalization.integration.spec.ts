import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
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

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { RequisitionSkillRequirementRepository } from '../lib/requisition-skill-requirement.repository.js';
import { RequisitionSkillCanonicalizationService } from '../lib/requisition-skill-canonicalization.service.js';

// SKILL-TAX-1D — requisition canonical skill seam (real Postgres 17; schemas
// skills_taxonomy + job_domain + requisition). Proves the derived-from-GoldenProfile
// reconciliation: resolve matrix, GoldenProfile source preserved, version never
// inferred, unresolved-valid, idempotency, self-heal after alias, de-author
// removal, tenant guard. No matching authority is touched.
//
// MIGRATIONS: skills_taxonomy(init/alias-version/relationship) + job_domain(init)
// + requisition(init + 1D).
const SKILLS = ['20260915140000_init_skill_registry', '20260915150000_skill_alias_version', '20260915160000_skill_relationship', '20260917210000_skill_tax_1f_governance', '20260918120000_skill_tax_1f_b_governance_proposal_correction'].map(
  (n) => resolve(__dirname, `../../../skills-taxonomy/prisma/migrations/${n}/migration.sql`),
);
const JOB = [resolve(__dirname, '../../../job-domain/prisma/migrations/20260519100000_init_job_domain_model/migration.sql')];
const REQ = ['20260602100000_init_requisition_model', '20260917120000_skill_tax_1d_requisition_skill_requirement'].map(
  (n) => resolve(__dirname, `../../prisma/migrations/${n}/migration.sql`),
);
const ALL_MIGRATIONS = [...SKILLS, ...JOB, ...REQ];

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
const TENANT2 = '10000000-0000-7000-8000-000000000002';
const JOB_ID = '20000000-0000-7000-8000-0000000000a1';
const GP_ID = '40000000-0000-7000-8000-0000000000a1';
const GP2_ID = '40000000-0000-7000-8000-0000000000a2';
const REQ_ID = '50000000-0000-7000-8000-0000000000a1';

function gpContent(required: string[], preferred: string[], critical: string[]): GoldenProfileContent {
  return {
    jd_text: '',
    generated_by: 'manual',
    required_skills: required.map((name) => ({ name })),
    preferred_skills: preferred.map((name) => ({ name })),
    critical_skills: critical.map((name) => ({ name })),
    experience: { industries: [] },
    constraints: {},
  };
}

type ReqRow = {
  requirement_type: string;
  raw_surface_form: string;
  version_requirement: string | null;
  canonical_skill_id: string | null;
  canonical_version_id: string | null;
  canonicalization_status: string | null;
  canonicalization_method: string | null;
};

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'RequisitionSkillCanonicalizationService — reconciliation integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let reqPrisma: PrismaService;
    let jobPrisma: JobPrismaService;
    let skillsPrisma: SkillsPrismaService;
    let jobRepo: JobDomainRepository;
    let registry: SkillRegistryService;
    let service: RequisitionSkillCanonicalizationService;
    let kubernetesId: string;
    let javaId: string;
    let firstResult: Awaited<ReturnType<RequisitionSkillCanonicalizationService['reconcileGoldenProfile']>>;

    async function rows(gpId = GP_ID): Promise<ReqRow[]> {
      return reqPrisma.requisitionSkillRequirement.findMany({
        where: { golden_profile_id: gpId },
        orderBy: [{ requirement_type: 'asc' }, { raw_surface_form: 'asc' }],
      }) as unknown as Promise<ReqRow[]>;
    }
    const find = (rs: ReqRow[], type: string, surface: string): ReqRow =>
      rs.find((r) => r.requirement_type === type && r.raw_surface_form === surface) as ReqRow;

    async function seedGoldenProfile(id: string, tenant: string, content: GoldenProfileContent): Promise<void> {
      const s = goldenProfileContentToStorage(content);
      await jobRepo.createGoldenProfile({
        id,
        tenant_id: tenant,
        job_id: JOB_ID,
        skills: s.skills,
        experience: s.experience,
        constraints: s.constraints,
        critical_skills: s.critical_skills,
      });
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const path of ALL_MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          const t = stmt.trim();
          if (t.length === 0) continue;
          await setup.$executeRawUnsafe(t);
        }
      }
      await setup.$disconnect();

      reqPrisma = new PrismaService(url);
      await reqPrisma.$connect();
      jobPrisma = new JobPrismaService(url);
      await jobPrisma.$connect();
      skillsPrisma = new SkillsPrismaService(url);
      await skillsPrisma.$connect();

      jobRepo = new JobDomainRepository(jobPrisma);
      const skillRepo = new SkillRepository(skillsPrisma);
      const aliasRepo = new SkillAliasRepository(skillsPrisma);
      const versionRepo = new SkillVersionRepository(skillsPrisma);
      registry = new SkillRegistryService(skillRepo, aliasRepo, versionRepo, new SkillRelationshipRepository(skillsPrisma));
      service = new RequisitionSkillCanonicalizationService(
        new RequisitionSkillRequirementRepository(reqPrisma),
        jobRepo,
        new SkillCanonicalizationService(skillRepo, aliasRepo, versionRepo),
      );

      // Registry: Kubernetes (+ alias K8s), Java (+ version 17).
      const k8s = await registry.createSkill({ canonicalName: 'Kubernetes', actor: ACTOR });
      kubernetesId = k8s.id;
      await registry.addAlias({ skillId: k8s.id, alias: 'K8s', aliasType: 'ABBREVIATION', actor: ACTOR });
      const java = await registry.createSkill({ canonicalName: 'Java', actor: ACTOR });
      javaId = java.id;
      await registry.addVersion({ skillId: java.id, version: '17', actor: ACTOR });

      // Authored GoldenProfile: required[Kubernetes,Java] preferred[K8s] critical[UnknownFoo].
      await seedGoldenProfile(GP_ID, TENANT, gpContent(['Kubernetes', 'Java'], ['K8s'], ['UnknownFoo']));

      firstResult = await service.reconcileGoldenProfile(TENANT, REQ_ID, GP_ID);
    }, 180_000);

    afterAll(async () => {
      await reqPrisma?.$disconnect();
      await jobPrisma?.$disconnect();
      await skillsPrisma?.$disconnect();
      await container?.stop();
    }, 60_000);

    it('derives + resolves the authored skills (summary)', () => {
      expect(firstResult.total).toBe(4);
      expect(firstResult.created).toBe(4);
      expect(firstResult.resolved).toBe(3); // Kubernetes, Java, K8s
      expect(firstResult.unresolved).toBe(1); // UnknownFoo
      expect(firstResult.deleted).toBe(0);
      expect(firstResult.golden_profile_id).toBe(GP_ID);
    });

    it('maps requirement_type + resolution correctly; preserves authored surface + never infers version', async () => {
      const rs = await rows();
      expect(rs).toHaveLength(4);

      const kube = find(rs, 'required', 'Kubernetes');
      expect(kube.canonical_skill_id).toBe(kubernetesId);
      expect(kube.canonicalization_status).toBe('RESOLVED');
      expect(kube.canonicalization_method).toBe('EXACT_CANONICAL');

      const k8s = find(rs, 'preferred', 'K8s');
      expect(k8s.canonical_skill_id).toBe(kubernetesId);
      expect(k8s.canonicalization_method).toBe('ALIAS');
      expect(k8s.raw_surface_form).toBe('K8s'); // authored text preserved

      const java = find(rs, 'required', 'Java');
      expect(java.canonical_skill_id).toBe(javaId);
      expect(java.canonicalization_method).toBe('EXACT_CANONICAL');
      // Version NEVER inferred from the registry (no authored version on GoldenProfile).
      expect(java.version_requirement).toBeNull();
      expect(java.canonical_version_id).toBeNull();

      // Unknown skill = valid, explicit UNRESOLVED row.
      const foo = find(rs, 'critical', 'UnknownFoo');
      expect(foo.canonicalization_status).toBe('UNRESOLVED');
      expect(foo.canonical_skill_id).toBeNull();
      expect(foo.canonicalization_method).toBeNull();
    });

    it('never mutates the authored GoldenProfile source', async () => {
      const gp = await jobRepo.findGoldenProfileById(GP_ID);
      const skills = gp?.skills as Record<string, unknown>;
      expect((skills['required_skills'] as Array<{ name: string }>).map((s) => s.name)).toEqual([
        'Kubernetes',
        'Java',
      ]);
      expect((skills['critical_skills'] as Array<{ name: string }>).map((s) => s.name)).toEqual(['UnknownFoo']);
    });

    it('is idempotent — re-run updates in place, no create/delete, stable rows', async () => {
      const before = await rows();
      const second = await service.reconcileGoldenProfile(TENANT, REQ_ID, GP_ID);
      expect(second.total).toBe(4);
      expect(second.created).toBe(0);
      expect(second.updated).toBe(4);
      expect(second.deleted).toBe(0);
      const after = await rows();
      expect(after).toHaveLength(4);
      const key = (r: ReqRow) => `${r.requirement_type}|${r.raw_surface_form}|${r.canonical_skill_id}|${r.canonicalization_status}`;
      expect(after.map(key).sort()).toEqual(before.map(key).sort());
    });

    it('self-heals a previously-unresolved requirement once an alias lands', async () => {
      const fooDb = await registry.createSkill({ canonicalName: 'Foo Database', actor: ACTOR });
      await registry.addAlias({ skillId: fooDb.id, alias: 'UnknownFoo', aliasType: 'ABBREVIATION', actor: ACTOR });

      await service.reconcileGoldenProfile(TENANT, REQ_ID, GP_ID);

      const foo = find(await rows(), 'critical', 'UnknownFoo');
      expect(foo.canonicalization_status).toBe('RESOLVED');
      expect(foo.canonicalization_method).toBe('ALIAS');
      expect(foo.canonical_skill_id).toBe(fooDb.id);
    });

    it('deterministically removes a de-authored requirement on re-run', async () => {
      // Re-author GoldenProfile: drop Java from required_skills.
      const s = goldenProfileContentToStorage(gpContent(['Kubernetes'], ['K8s'], ['UnknownFoo']));
      await jobPrisma.$executeRawUnsafe(
        `UPDATE "job_domain"."GoldenProfile" SET skills = $1::jsonb WHERE id = $2::uuid`,
        JSON.stringify(s.skills),
        GP_ID,
      );

      const result = await service.reconcileGoldenProfile(TENANT, REQ_ID, GP_ID);
      expect(result.deleted).toBe(1); // Java requirement removed
      const rs = await rows();
      expect(rs.find((r) => r.requirement_type === 'required' && r.raw_surface_form === 'Java')).toBeUndefined();
      expect(rs.find((r) => r.raw_surface_form === 'Kubernetes')).toBeDefined();
    });

    it('tenant-guards: a profile owned by another tenant yields no rows', async () => {
      await seedGoldenProfile(GP2_ID, TENANT2, gpContent(['Kubernetes'], [], []));
      // Reconcile GP2 under the WRONG tenant (TENANT) — buildDesired tenant-guard returns [].
      const result = await service.reconcileGoldenProfile(TENANT, REQ_ID, GP2_ID);
      expect(result.total).toBe(0);
      expect(result.created).toBe(0);
      expect(await rows(GP2_ID)).toHaveLength(0);
    });
  },
);
