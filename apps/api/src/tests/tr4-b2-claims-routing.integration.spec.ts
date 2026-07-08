import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TalentEvidenceRepository } from '@aramo/talent-evidence';
import { TalentExtractionService } from '@aramo/talent-extraction';
import { TalentTrustService } from '@aramo/talent-trust';

import { AppModule } from '../app.module.js';

// TR-4 B2 (§5 a/c/e) — talent-extraction routes typed EMPLOYMENT/SKILL rows into
// the trust ledger as canonical CLAIMS evidence, idempotently, over real Postgres
// 17. The reconcile reads talent_evidence + writes talent_trust; no HTTP, no auth.

const ROOT = resolve(__dirname, '../../../..');
const M = (p: string): string => resolve(ROOT, p);

const MIGRATIONS = [
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
  'libs/talent-evidence/prisma/migrations/20260519170000_init_talent_evidence_model/migration.sql',
  'libs/talent-trust/prisma/migrations/20260628000000_init_talent_trust/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703120000_tr2a1_subject_anchor/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703130000_tr2a2_match_advisory/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703140000_tr2a3_advisory_resolution/migration.sql',
  'libs/talent-trust/prisma/migrations/20260705120000_add_reconcile_watermark_to_resolution_subject/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706120000_ats_ref_partial_unique/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706160000_sourcing_pool_keyset_index/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706170000_tr2a_b1_subject_anchor_source_class/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706180000_tr2a_b1_subject_anchor_source_class_unique/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706200000_tr2a_b2_advisory_reopen_provenance/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706230000_tr2a_b3b_subject_merge_operation/migration.sql',
  'libs/talent-trust/prisma/migrations/20260707120000_tr6_b1_last_matched_at/migration.sql',
  'libs/talent-trust/prisma/migrations/20260707130000_tr6_b1_merge_operation_kind/migration.sql',
  'libs/talent-trust/prisma/migrations/20260708120000_tr3_b1_verification_request/migration.sql',
  'libs/talent-trust/prisma/migrations/20260709120000_tr4_b1_evidence_link_unique/migration.sql',
  'libs/talent-trust/prisma/migrations/20260710120000_tr4_b3_last_consistency_at/migration.sql',
].map(M);

const TENANT_A = '01900000-0000-7000-8000-0000000000a1';
const TENANT_B = '01900000-0000-7000-8000-0000000000b2';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-4 B2 — CLAIMS routing into the ledger (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: Client;
    const savedEnv: Partial<Record<string, string | undefined>> = {};
    let evidence: TalentEvidenceRepository;
    let extraction: TalentExtractionService;
    let trust: TalentTrustService;

    async function seedSkill(tenant: string, talent: string, surface: string): Promise<string> {
      const id = uuidv7();
      await evidence.createTalentSkillEvidence({
        id,
        talent_id: talent,
        tenant_id: tenant,
        skill_id: uuidv7(),
        surface_form: surface,
        source: 'declared',
        created_at: new Date(),
      });
      return id;
    }

    async function seedWork(
      tenant: string,
      talent: string,
      employer: string,
      role: string,
      start: Date | null,
    ): Promise<string> {
      const id = uuidv7();
      await evidence.createTalentWorkHistoryEntry({
        id,
        talent_id: talent,
        tenant_id: tenant,
        employer_name: employer,
        role_title: role,
        source: 'resume',
        ...(start !== null ? { start_date: start } : {}),
        created_at: new Date(),
      });
      return id;
    }

    async function ledgerCount(talentRecordId: string): Promise<number> {
      const r = await db.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM talent_trust."EvidenceRecord" e
         JOIN talent_trust."ResolutionSubjectRef" r ON r.subject_id = e.subject_id
         WHERE r.ref_type = 'ATS_TALENT_RECORD' AND r.ref_id = $1::uuid`,
        [talentRecordId],
      );
      return Number(r.rows[0]!.n);
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      // pg's Client runs multi-statement files directly (unlike Prisma's
      // single-statement $executeRawUnsafe), so apply each migration whole.
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));

      savedEnv['DATABASE_URL'] = process.env['DATABASE_URL'];
      savedEnv['AUTH_AUDIENCE'] = process.env['AUTH_AUDIENCE'];
      savedEnv['AUTH_PUBLIC_KEY'] = process.env['AUTH_PUBLIC_KEY'];
      savedEnv['MAILER_PROVIDER'] = process.env['MAILER_PROVIDER'];
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = 'aramo-tr4-b2-spec';
      process.env['AUTH_PUBLIC_KEY'] =
        '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEEXAMPLE\n-----END PUBLIC KEY-----';
      process.env['MAILER_PROVIDER'] = 'stub';

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = module.createNestApplication();
      await app.init();

      evidence = module.get(TalentEvidenceRepository);
      extraction = module.get(TalentExtractionService);
      trust = module.get(TalentTrustService);
    }, 300_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    beforeEach(async () => {
      await db.query('TRUNCATE TABLE talent_evidence."TalentSkillEvidence" CASCADE');
      await db.query('TRUNCATE TABLE talent_evidence."TalentWorkHistoryEntry" CASCADE');
      await db.query('TRUNCATE TABLE talent_trust."EvidenceRecord" CASCADE');
      await db.query('TRUNCATE TABLE talent_trust."TrustState" CASCADE');
      await db.query('TRUNCATE TABLE talent_trust."ResolutionSubjectRef" CASCADE');
      await db.query('TRUNCATE TABLE talent_trust."ResolutionSubject" CASCADE');
    });

    // ---- (a) happy path -----------------------------------------------------

    it('(a) routes typed rows into canonical CLAIMS ledger evidence (ai_derived, source_ref both ways); CLAIMS band moves off NOT_ESTABLISHED', async () => {
      const talent = uuidv7();
      const skillId = await seedSkill(TENANT_A, talent, 'TypeScript');
      const workId = await seedWork(TENANT_A, talent, 'Acme Inc.', 'Engineer', new Date('2020-01-15'));

      const r = await extraction.routeDeclaredEvidenceToLedger({ tenant_id: TENANT_A, talent_id: talent });
      expect(r).toEqual({ skills_written: 1, work_history_written: 1, skipped: 0 });

      // The EMPLOYMENT ledger row is canonical + ai_derived + carries source_ref.
      const emp = await db.query(
        `SELECT dimension, source_class, method, ai_derived, created_by, assertion_payload, source_ref
         FROM talent_trust."EvidenceRecord" WHERE assertion_type = 'EMPLOYMENT'`,
      );
      expect(emp.rows).toHaveLength(1);
      expect(emp.rows[0]).toMatchObject({
        dimension: 'CLAIMS',
        source_class: 'THIRD_PARTY_UNVERIFIED',
        method: 'DOCUMENT',
        ai_derived: true,
        created_by: 'talent-extraction',
      });
      expect(emp.rows[0].assertion_payload).toMatchObject({
        employer_raw: 'Acme Inc.',
        employer_norm: 'acme',
        role_title_raw: 'Engineer',
        start_date: '2020-01-15',
      });
      expect(emp.rows[0].source_ref).toMatchObject({ talent_evidence_id: workId, kind: 'work_history' });

      // The SKILL ledger row carries the parity-derived skill_id in its payload.
      const skill = await db.query(
        `SELECT assertion_payload, source_ref FROM talent_trust."EvidenceRecord" WHERE assertion_type = 'SKILL'`,
      );
      expect(skill.rows[0].assertion_payload).toMatchObject({ value_raw: 'TypeScript' });
      expect(skill.rows[0].source_ref).toMatchObject({ talent_evidence_id: skillId, kind: 'skill' });

      // Recompute fired → CLAIMS band is no longer NOT_ESTABLISHED.
      const state = await trust.getTrustState({
        tenant_id: TENANT_A,
        ref_type: 'ATS_TALENT_RECORD',
        ref_id: talent,
      });
      expect(state?.claims_band).not.toBe('NOT_ESTABLISHED');
    });

    // ---- (c) idempotence ----------------------------------------------------

    it('(c) a forced re-run writes zero duplicate evidence', async () => {
      const talent = uuidv7();
      await seedSkill(TENANT_A, talent, 'Go');
      await seedWork(TENANT_A, talent, 'Beta LLC', 'SRE', null);

      const first = await extraction.routeDeclaredEvidenceToLedger({ tenant_id: TENANT_A, talent_id: talent });
      expect(first.skills_written + first.work_history_written).toBe(2);
      expect(await ledgerCount(talent)).toBe(2);

      const second = await extraction.routeDeclaredEvidenceToLedger({ tenant_id: TENANT_A, talent_id: talent });
      expect(second).toEqual({ skills_written: 0, work_history_written: 0, skipped: 2 });
      expect(await ledgerCount(talent)).toBe(2); // no duplicates
    });

    // ---- (e) backfill: counts, second-run-zero, tenant scoping ---------------

    it('(e) backfill routes a tenant’s legacy rows with correct counts; second run = 0; other tenant untouched', async () => {
      const talentA1 = uuidv7();
      const talentA2 = uuidv7();
      const talentB1 = uuidv7();
      await seedSkill(TENANT_A, talentA1, 'Kafka');
      await seedWork(TENANT_A, talentA1, 'Gamma', 'Dev', null);
      await seedSkill(TENANT_A, talentA2, 'Rust');
      await seedSkill(TENANT_B, talentB1, 'Python'); // other tenant

      const r1 = await extraction.backfillLedgerForTenant(TENANT_A);
      expect(r1.talents).toBe(2);
      expect(r1.skills_written).toBe(2);
      expect(r1.work_history_written).toBe(1);
      expect(r1.skipped).toBe(0);

      // TENANT_B's talent was NOT routed (tenant scoping).
      expect(await ledgerCount(talentB1)).toBe(0);

      // Second run = zero writes (idempotent).
      const r2 = await extraction.backfillLedgerForTenant(TENANT_A);
      expect(r2.skills_written).toBe(0);
      expect(r2.work_history_written).toBe(0);
      expect(r2.skipped).toBe(3);

      // --all-tenants enumeration sees both tenants.
      const tenants = await extraction.listTenantIdsWithEvidence();
      expect(tenants.sort()).toEqual([TENANT_A, TENANT_B].sort());
    });
  },
);
