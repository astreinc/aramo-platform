import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
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
import { TalentEvidenceRepository } from '../lib/talent-evidence.repository.js';
import { TalentSkillCanonicalizationService } from '../lib/talent-skill-canonicalization.service.js';

// SKILL-TAX-1G — Talent skill canonical reconciliation (real Postgres 17, BOTH
// schemas skills_taxonomy + talent_evidence). Proves: additive canonical
// resolution over stored evidence; explicit status/method; legacy skill_id +
// legacy years map untouched; canonical interval-union projection (§19);
// idempotency; re-resolution after an alias lands; tenant isolation.
//
// MIGRATIONS list:
//   skills_taxonomy: 20260915140000_init_skill_registry, 20260915150000_skill_alias_version, 20260915160000_skill_relationship
//   talent_evidence: 20260519170000_init_talent_evidence_model, 20260714120000_tr7_b1_education_certification,
//                    20260915120000_hf1_resume_provenance, 20260915170000_hf2_experience_intelligence,
//                    20260915180000_skill_tax_1g_canonical_reconciliation
const SKILLS_MIGRATIONS = [
  '20260915140000_init_skill_registry',
  '20260915150000_skill_alias_version',
  '20260915160000_skill_relationship',
].map((n) => resolve(__dirname, `../../../skills-taxonomy/prisma/migrations/${n}/migration.sql`));
const TE_MIGRATIONS = [
  '20260519170000_init_talent_evidence_model',
  '20260714120000_tr7_b1_education_certification',
  '20260915120000_hf1_resume_provenance',
  '20260915170000_hf2_experience_intelligence',
  '20260915180000_skill_tax_1g_canonical_reconciliation',
].map((n) => resolve(__dirname, `../../prisma/migrations/${n}/migration.sql`));

const ACTOR = { id: '30000000-0000-7000-8000-000000000001', type: 'platform_admin' };
const TENANT = '10000000-0000-7000-8000-000000000001';
const TENANT2 = '10000000-0000-7000-8000-000000000002';
const TALENT_A = '20000000-0000-7000-8000-00000000000a';
const TALENT_B = '20000000-0000-7000-8000-00000000000b';
// Legacy (surface-derived) skill_id values — asserted UNCHANGED after 1G.
const SK = {
  kube1: '40000000-0000-7000-8000-00000000e001',
  kube2: '40000000-0000-7000-8000-00000000e002',
  java1: '40000000-0000-7000-8000-00000000e003',
  java2: '40000000-0000-7000-8000-00000000e004',
  foo: '40000000-0000-7000-8000-00000000e005',
  iso: '40000000-0000-7000-8000-00000000e0ff',
};
const SNAP = '50000000-0000-7000-8000-000000000001';

type EvRow = {
  surface_form: string;
  version: string | null;
  skill_id: string;
  canonical_skill_id: string | null;
  canonical_version_id: string | null;
  canonicalization_status: string | null;
  canonicalization_method: string | null;
  canonicalized_at: Date | null;
};

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TalentSkillCanonicalizationService — reconciliation integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let tePrisma: PrismaService;
    let skillsPrisma: SkillsPrismaService;
    let teRepo: TalentEvidenceRepository;
    let registry: SkillRegistryService;
    let reconciler: TalentSkillCanonicalizationService;
    let kubernetesId: string;
    let javaId: string;
    let javaV17Id: string;
    let firstResult: Awaited<ReturnType<TalentSkillCanonicalizationService['reconcileTalent']>>;

    async function evidenceRows(
      tenant: string,
      talent: string,
    ): Promise<EvRow[]> {
      return tePrisma.talentSkillEvidence.findMany({
        where: { tenant_id: tenant, talent_id: talent },
        select: {
          surface_form: true,
          version: true,
          skill_id: true,
          canonical_skill_id: true,
          canonical_version_id: true,
          canonicalization_status: true,
          canonicalization_method: true,
          canonicalized_at: true,
        },
      }) as unknown as Promise<EvRow[]>;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const setup = new PrismaService(url);
      await setup.$connect();
      for (const path of [...SKILLS_MIGRATIONS, ...TE_MIGRATIONS]) {
        for (const stmt of readFileSync(path, 'utf8').split(';')) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setup.$executeRawUnsafe(trimmed);
        }
      }
      await setup.$disconnect();

      tePrisma = new PrismaService(url);
      await tePrisma.$connect();
      skillsPrisma = new SkillsPrismaService(url);
      await skillsPrisma.$connect();

      teRepo = new TalentEvidenceRepository(tePrisma);
      const skillRepo = new SkillRepository(skillsPrisma);
      const aliasRepo = new SkillAliasRepository(skillsPrisma);
      const versionRepo = new SkillVersionRepository(skillsPrisma);
      registry = new SkillRegistryService(
        skillRepo,
        aliasRepo,
        versionRepo,
        new SkillRelationshipRepository(skillsPrisma),
      );
      reconciler = new TalentSkillCanonicalizationService(
        teRepo,
        new SkillCanonicalizationService(skillRepo, aliasRepo, versionRepo),
      );

      // Seed canonical registry.
      const k8s = await registry.createSkill({ canonicalName: 'Kubernetes', actor: ACTOR });
      kubernetesId = k8s.id;
      await registry.addAlias({ skillId: k8s.id, alias: 'K8s', aliasType: 'ABBREVIATION', actor: ACTOR });
      const java = await registry.createSkill({ canonicalName: 'Java', actor: ACTOR });
      javaId = java.id;
      javaV17Id = (await registry.addVersion({ skillId: java.id, version: '17', actor: ACTOR })).id;

      // Seed existing evidence (raw — controls legacy skill_id + usage intervals).
      const ev = (
        id: string,
        skillId: string,
        surface: string,
        version: string | null,
        start: string | null,
        end: string | null,
        talent = TALENT_A,
        tenant = TENANT,
      ): string => {
        const v = version === null ? 'NULL' : `'${version}'`;
        const s = start === null ? 'NULL' : `'${start}'`;
        const e = end === null ? 'NULL' : `'${end}'`;
        return `INSERT INTO "talent_evidence"."TalentSkillEvidence" ("id","talent_id","tenant_id","skill_id","surface_form","source","version","usage_start","usage_end","created_at") VALUES ('${id}','${talent}','${tenant}','${skillId}','${surface}','declared',${v},${s},${e}, NOW())`;
      };
      await tePrisma.$executeRawUnsafe(ev(SK.kube1, SK.kube1, 'Kubernetes', null, '2022-01-01', '2025-01-01'));
      await tePrisma.$executeRawUnsafe(ev(SK.kube2, SK.kube2, 'K8s', null, '2020-01-01', '2022-01-01'));
      await tePrisma.$executeRawUnsafe(ev(SK.java1, SK.java1, 'Java', '17', '2019-01-01', '2021-01-01'));
      await tePrisma.$executeRawUnsafe(ev(SK.java2, SK.java2, 'Java', '11', '2018-01-01', '2019-01-01'));
      await tePrisma.$executeRawUnsafe(ev(SK.foo, SK.foo, 'FooDB', null, null, null));
      // Tenant-isolation control row.
      await tePrisma.$executeRawUnsafe(
        ev(SK.iso, SK.iso, 'Kubernetes', null, '2021-01-01', '2023-01-01', TALENT_B, TENANT2),
      );

      // Existing derived snapshot with a LEGACY years map (must stay untouched).
      await teRepo.createTalentDerivedSnapshot({
        id: SNAP,
        talent_id: TALENT_A,
        tenant_id: TENANT,
        skill_confidence_scores: { placeholder: true },
        estimated_years_experience_by_skill: { 'legacy-key': 3 },
        computed_at: new Date('2026-01-01'),
      });

      firstResult = await reconciler.reconcileTalent(TENANT, TALENT_A);
    }, 180_000);

    afterAll(async () => {
      await tePrisma?.$disconnect();
      await skillsPrisma?.$disconnect();
      await container?.stop();
    }, 60_000);

    it('returns a correct reconcile summary', () => {
      expect(firstResult.total).toBe(5);
      expect(firstResult.resolved).toBe(4);
      expect(firstResult.unresolved).toBe(1);
      expect(firstResult.canonical_skill_count).toBe(2); // Kubernetes + Java
      expect(firstResult.snapshot_updated).toBe(true);
    });

    it('resolves the matrix (EXACT/ALIAS/VERSION) and leaves legacy skill_id untouched', async () => {
      const rows = await evidenceRows(TENANT, TALENT_A);
      const find = (surface: string, version: string | null): EvRow =>
        rows.find((r) => r.surface_form === surface && r.version === version) as EvRow;

      const kube = find('Kubernetes', null);
      expect(kube.canonicalization_status).toBe('RESOLVED');
      expect(kube.canonicalization_method).toBe('EXACT_CANONICAL');
      expect(kube.canonical_skill_id).toBe(kubernetesId);
      expect(kube.skill_id).toBe(SK.kube1); // legacy id UNCHANGED
      expect(kube.canonicalized_at).not.toBeNull();

      const k8s = find('K8s', null);
      expect(k8s.canonicalization_status).toBe('RESOLVED');
      expect(k8s.canonicalization_method).toBe('ALIAS');
      expect(k8s.canonical_skill_id).toBe(kubernetesId);
      expect(k8s.skill_id).toBe(SK.kube2);

      const java17 = find('Java', '17');
      expect(java17.canonicalization_status).toBe('RESOLVED');
      expect(java17.canonicalization_method).toBe('VERSION');
      expect(java17.canonical_skill_id).toBe(javaId);
      expect(java17.canonical_version_id).toBe(javaV17Id);

      // Version stated but not in the registry -> skill resolves, version does NOT
      // (never inferred).
      const java11 = find('Java', '11');
      expect(java11.canonicalization_status).toBe('RESOLVED');
      expect(java11.canonical_skill_id).toBe(javaId);
      expect(java11.canonical_version_id).toBeNull();

      // Unknown skill stays valid + explicit UNRESOLVED (not silently null-only).
      const foo = find('FooDB', null);
      expect(foo.canonicalization_status).toBe('UNRESOLVED');
      expect(foo.canonical_skill_id).toBeNull();
      expect(foo.canonicalization_method).toBeNull();
      expect(foo.skill_id).toBe(SK.foo);
    });

    it('writes an ADDITIVE canonical interval-union projection; legacy years map untouched', async () => {
      const snap = await teRepo.findTalentDerivedSnapshotById(SNAP);
      // Legacy field preserved verbatim.
      expect(snap?.estimated_years_experience_by_skill).toEqual({ 'legacy-key': 3 });
      const canonical = snap?.estimated_years_experience_by_canonical_skill as Record<
        string,
        { supported_years: number; first_used: string; last_used: string; evidence_count: number }
      >;
      // Kubernetes: union(2020-2022, 2022-2025) = 2020-2025 = 5y (NOT summed buckets).
      expect(canonical[kubernetesId].supported_years).toBe(5);
      expect(canonical[kubernetesId].first_used).toBe('2020-01-01');
      expect(canonical[kubernetesId].last_used).toBe('2025-01-01');
      expect(canonical[kubernetesId].evidence_count).toBe(2);
      // Java: union(2018-2019, 2019-2021) = 2018-2021 = 3y.
      expect(canonical[javaId].supported_years).toBe(3);
    });

    it('does not touch another tenant/talent (isolation)', async () => {
      const other = await evidenceRows(TENANT2, TALENT_B);
      expect(other).toHaveLength(1);
      expect(other[0].canonical_skill_id).toBeNull();
      expect(other[0].canonicalization_status).toBeNull();
    });

    it('is idempotent — re-running converges with no duplicate rows', async () => {
      const before = await evidenceRows(TENANT, TALENT_A);
      const second = await reconciler.reconcileTalent(TENANT, TALENT_A);
      expect(second.total).toBe(5);
      expect(second.resolved).toBe(4);
      const after = await evidenceRows(TENANT, TALENT_A);
      expect(after).toHaveLength(5); // no new rows
      const key = (r: EvRow) => `${r.surface_form}|${r.version}|${r.canonical_skill_id}|${r.canonicalization_status}`;
      expect(after.map(key).sort()).toEqual(before.map(key).sort());
    });

    it('re-resolves a previously-unresolved row once an alias is added (not write-once)', async () => {
      const fooDb = await registry.createSkill({ canonicalName: 'Foo Database', actor: ACTOR });
      await registry.addAlias({ skillId: fooDb.id, alias: 'FooDB', aliasType: 'ABBREVIATION', actor: ACTOR });

      await reconciler.reconcileTalent(TENANT, TALENT_A);

      const rows = await evidenceRows(TENANT, TALENT_A);
      const foo = rows.find((r) => r.surface_form === 'FooDB') as EvRow;
      expect(foo.canonicalization_status).toBe('RESOLVED');
      expect(foo.canonicalization_method).toBe('ALIAS');
      expect(foo.canonical_skill_id).toBe(fooDb.id);
    });
  },
);
