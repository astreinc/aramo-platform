import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import {
  PrismaService as ExPrismaService,
  CanonicalMatchShadowRepository,
} from '@aramo/examination';
import {
  PrismaService as TePrismaService,
  TalentCanonicalCoverageRepository,
} from '@aramo/talent-evidence';
import {
  RequisitionPrismaService,
  RequisitionSkillRequirementRepository,
} from '@aramo/requisition';

import { CanonicalMatchShadowComparator } from '../examinations/canonical-match-shadow.comparator.js';
import { CanonicalMatchShadowConfig } from '../examinations/canonical-match-shadow.config.js';

// SKILL-TAX-1E — canonical SHADOW comparator end-to-end (real Postgres 17; schemas
// examination + talent_evidence + requisition). Proves, against REAL canonical
// data + real repos: flag-on persists the correct §45-v1 classes; flag-off is inert
// (dark = zero behavior change); coverage telemetry is non-zero; SOURCE_SET_DIVERGENCE
// fires on an incongruent authored/derived critical set; the table is append-only
// (immutability trigger). The response/snapshot byte-equality + no-canonical-key
// invariants are covered by the existing examine integration specs (which run
// flag-OFF, the default) — this proves the shadow write itself.
const REPO_ROOT = resolve(__dirname, '../../../..');
const EX = [
  '20260517200000_init_examination_model',
  '20260521120000_add_live_list_index',
  '20260523180000_add_examination_override',
  '20260524080000_add_timestamptz_to_examination_override',
  '20260706240000_tr2a_b3b_reconcile_rekey_exemption',
  '20260917200000_skill_tax_1e_canonical_match_shadow',
].map((n) => resolve(REPO_ROOT, `libs/examination/prisma/migrations/${n}/migration.sql`));
const TE = [
  '20260519170000_init_talent_evidence_model',
  '20260714120000_tr7_b1_education_certification',
  '20260915120000_hf1_resume_provenance',
  '20260915170000_hf2_experience_intelligence',
  '20260915180000_skill_tax_1g_canonical_reconciliation',
].map((n) => resolve(REPO_ROOT, `libs/talent-evidence/prisma/migrations/${n}/migration.sql`));
const REQ = [
  '20260602100000_init_requisition_model',
  '20260917120000_skill_tax_1d_requisition_skill_requirement',
].map((n) => resolve(REPO_ROOT, `libs/requisition/prisma/migrations/${n}/migration.sql`));
const ALL_MIGRATIONS = [...EX, ...TE, ...REQ];

const ENV = 'SKILL_CANONICAL_SHADOW_ENABLED';
const TENANT = '10000000-0000-7000-8000-000000000001';
const TALENT = '20000000-0000-7000-8000-000000000001';
const GP = '30000000-0000-7000-8000-000000000001';
const REQ_ID = '40000000-0000-7000-8000-000000000001';
const K8S = '50000000-0000-7000-8000-0000000000a1';
const JAVA = '50000000-0000-7000-8000-0000000000a2';
const LOGGER = { log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'CanonicalMatchShadowComparator — end-to-end (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let exPrisma: ExPrismaService;
    let tePrisma: TePrismaService;
    let reqPrisma: RequisitionPrismaService;
    let comparator: CanonicalMatchShadowComparator;
    let shadowRepo: CanonicalMatchShadowRepository;
    const savedEnv = process.env[ENV];

    async function insertRequirement(
      surface: string,
      type: string,
      canonical: string | null,
      method: string | null,
    ): Promise<void> {
      await reqPrisma.$executeRawUnsafe(
        `INSERT INTO "requisition"."RequisitionSkillRequirement"
           ("id","tenant_id","requisition_id","golden_profile_id","requirement_type","raw_surface_form",
            "version_requirement","canonical_skill_id","canonical_version_id","canonicalization_status",
            "canonicalization_method","canonicalized_at")
         VALUES (gen_random_uuid(),$1::uuid,$2::uuid,$3::uuid,$4,$5,NULL,$6::uuid,NULL,$7,$8,NOW())`,
        TENANT,
        REQ_ID,
        GP,
        type,
        surface,
        canonical,
        canonical === null ? 'UNRESOLVED' : 'RESOLVED',
        method,
      );
    }
    async function insertEvidence(
      surface: string,
      canonical: string | null,
      method: string | null,
    ): Promise<void> {
      await tePrisma.$executeRawUnsafe(
        `INSERT INTO "talent_evidence"."TalentSkillEvidence"
           ("id","talent_id","tenant_id","skill_id","surface_form","source","canonical_skill_id",
            "canonicalization_status","canonicalization_method","canonicalized_at","created_at")
         VALUES (gen_random_uuid(),$1::uuid,$2::uuid,gen_random_uuid(),$3,'declared',$4::uuid,$5,$6,
            CASE WHEN $4 IS NULL THEN NULL ELSE NOW() END, NOW())`,
        TALENT,
        TENANT,
        surface,
        canonical,
        canonical === null ? 'UNRESOLVED' : 'RESOLVED',
        method,
      );
    }
    async function observedClasses(): Promise<string[]> {
      const rows = await exPrisma.canonicalMatchShadowObservation.findMany({
        where: { tenant_id: TENANT },
        select: { match_class: true },
      });
      return rows.map((r) => r.match_class).sort();
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      // Apply each migration WHOLE via pg's Client — it runs multi-statement files
      // (including `$$`-quoted trigger bodies) directly, unlike Prisma's
      // single-statement $executeRawUnsafe which would break on the internal `;`.
      const db = new Client({ connectionString: url });
      await db.connect();
      for (const path of ALL_MIGRATIONS) await db.query(readFileSync(path, 'utf8'));
      await db.end();

      exPrisma = new ExPrismaService(url);
      await exPrisma.$connect();
      tePrisma = new TePrismaService(url);
      await tePrisma.$connect();
      reqPrisma = new RequisitionPrismaService(url);
      await reqPrisma.$connect();

      shadowRepo = new CanonicalMatchShadowRepository(exPrisma);
      comparator = new CanonicalMatchShadowComparator(
        new CanonicalMatchShadowConfig(),
        new RequisitionSkillRequirementRepository(reqPrisma),
        new TalentCanonicalCoverageRepository(tePrisma),
        shadowRepo,
        LOGGER,
      );

      // Seed: critical Kubernetes (resolved K8S) + critical Java (resolved JAVA).
      // Talent has "K8s" resolved to K8S (name DIFFERS from "Kubernetes" → the
      // authoritative matcher MISSES it, but canonical agrees → ALIAS_EQUIVALENT,
      // the key pre-cutover signal) and "Java" resolved to JAVA (name + canonical
      // agree → CANONICAL_EXACT). A non-critical 'required' row proves the
      // critical-only filter ignores it.
      await insertRequirement('Kubernetes', 'critical', K8S, 'EXACT_CANONICAL');
      await insertRequirement('Java', 'critical', JAVA, 'EXACT_CANONICAL');
      await insertRequirement('Docker', 'required', null, null); // must be ignored
      await insertEvidence('K8s', K8S, 'ALIAS'); // canonical-only match → ALIAS_EQUIVALENT
      await insertEvidence('Java', JAVA, 'EXACT_CANONICAL'); // name + canonical → CANONICAL_EXACT
    }, 240_000);

    afterAll(async () => {
      if (savedEnv === undefined) delete process.env[ENV];
      else process.env[ENV] = savedEnv;
      await exPrisma?.$disconnect();
      await tePrisma?.$disconnect();
      await reqPrisma?.$disconnect();
      await container?.stop();
    }, 60_000);

    it('flag OFF (dark) → nothing is persisted (zero behavior change)', async () => {
      delete process.env[ENV];
      const n = await comparator.observe({
        tenant_id: TENANT,
        examination_id: '90000000-0000-7000-8000-0000000000d0',
        talent_id: TALENT,
        golden_profile_id: GP,
        requisition_id: REQ_ID,
        golden_critical_skill_names: ['Kubernetes', 'Java'],
      });
      expect(n).toBe(0);
      expect(await observedClasses()).toEqual([]);
    });

    it('flag ON → ALIAS_EQUIVALENT (canonical-only match) + CANONICAL_EXACT, critical-only', async () => {
      process.env[ENV] = 'true';
      const n = await comparator.observe({
        tenant_id: TENANT,
        examination_id: '90000000-0000-7000-8000-0000000000d1',
        talent_id: TALENT,
        golden_profile_id: GP,
        requisition_id: REQ_ID,
        // Authored critical set == derived critical requirement set → NO divergence.
        golden_critical_skill_names: ['Kubernetes', 'Java'],
      });
      // Kubernetes: talent has only "K8s" → name-miss + canonical-match → ALIAS_EQUIVALENT.
      // Java: name + canonical agree → CANONICAL_EXACT. Docker(required) ignored.
      expect(n).toBe(2);
      expect(await observedClasses()).toEqual(['ALIAS_EQUIVALENT', 'CANONICAL_EXACT']);
    });

    it('coverage telemetry reports non-zero counts by class', async () => {
      const cov = await shadowRepo.coverageByClass(TENANT);
      expect(cov['ALIAS_EQUIVALENT']).toBeGreaterThanOrEqual(1);
      expect(cov['CANONICAL_EXACT']).toBeGreaterThanOrEqual(1);
    });

    it('SOURCE_SET_DIVERGENCE PREEMPTS per-skill classification (only the divergence row)', async () => {
      process.env[ENV] = 'true';
      const n = await comparator.observe({
        tenant_id: TENANT,
        examination_id: '90000000-0000-7000-8000-0000000000d2',
        talent_id: TALENT,
        golden_profile_id: GP,
        requisition_id: REQ_ID,
        golden_critical_skill_names: ['Kubernetes'], // ≠ {Kubernetes, Java} derived
      });
      expect(n).toBe(1);
      const rows = await exPrisma.canonicalMatchShadowObservation.findMany({
        where: { examination_id: '90000000-0000-7000-8000-0000000000d2' },
        select: { match_class: true },
      });
      expect(rows.map((r) => r.match_class)).toEqual(['SOURCE_SET_DIVERGENCE']);
    });

    it('the observation table is APPEND-ONLY (UPDATE rejected by trigger)', async () => {
      await expect(
        exPrisma.$executeRawUnsafe(
          `UPDATE "examination"."CanonicalMatchShadowObservation" SET "match_class" = 'CANONICAL_EXACT'`,
        ),
      ).rejects.toThrow(/append-only/i);
    });
  },
);
