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

// TR-7 B1 (§5 a/c/f) — the credential-claim capture routes typed DEGREE/CERTIFICATION
// rows into the trust ledger as canonical CLAIMS evidence, idempotently, over real
// Postgres 17. THIRD_PARTY_UNVERIFIED/DOCUMENT + ai_derived (D2); the unverified
// DEGREE does NOT elevate CLAIMS past its class ceiling (D2/§5f).

const ROOT = resolve(__dirname, '../../../..');
const M = (p: string): string => resolve(ROOT, p);

const MIGRATIONS = [
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
  'libs/talent-evidence/prisma/migrations/20260519170000_init_talent_evidence_model/migration.sql',
  'libs/talent-evidence/prisma/migrations/20260714120000_tr7_b1_education_certification/migration.sql',
  'libs/talent-trust/prisma/migrations/20260628000000_init_talent_trust/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703120000_tr2a1_subject_anchor/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703130000_tr2a2_match_advisory/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703140000_tr2a3_advisory_resolution/migration.sql',
  'libs/talent-trust/prisma/migrations/20260705120000_add_reconcile_watermark_to_resolution_subject/migration.sql',
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
  'libs/talent-trust/prisma/migrations/20260711120000_tr5_b2_thinness_flags/migration.sql',
  'libs/talent-trust/prisma/migrations/20260712120000_tr8_b1_verified_control_stale/migration.sql',
  'libs/talent-trust/prisma/migrations/20260713120000_tr12_b1_verification_proposal/migration.sql',
].map(M);

const TENANT_A = '01900000-0000-7000-8000-0000000007a1';
const TENANT_B = '01900000-0000-7000-8000-0000000007b2';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-7 B1 — credential-claim routing into the ledger (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: Client;
    const savedEnv: Partial<Record<string, string | undefined>> = {};
    let evidence: TalentEvidenceRepository;
    let extraction: TalentExtractionService;
    let trust: TalentTrustService;

    async function seedEducation(
      tenant: string,
      talent: string,
      opts: { institution: string; degree: string; field?: string; conferred?: Date },
    ): Promise<string> {
      const id = uuidv7();
      await evidence.createTalentEducationEntry({
        id,
        talent_id: talent,
        tenant_id: tenant,
        institution_name: opts.institution,
        degree_name: opts.degree,
        source: 'resume',
        ...(opts.field !== undefined ? { field_of_study: opts.field } : {}),
        ...(opts.conferred !== undefined ? { conferred_date: opts.conferred } : {}),
        created_at: new Date(),
      });
      return id;
    }

    async function seedCertification(
      tenant: string,
      talent: string,
      opts: { name: string; issuer?: string; issued?: Date; expiry?: Date },
    ): Promise<string> {
      const id = uuidv7();
      await evidence.createTalentCertificationEntry({
        id,
        talent_id: talent,
        tenant_id: tenant,
        certification_name: opts.name,
        source: 'resume',
        ...(opts.issuer !== undefined ? { issuer_name: opts.issuer } : {}),
        ...(opts.issued !== undefined ? { issued_date: opts.issued } : {}),
        ...(opts.expiry !== undefined ? { expiry_date: opts.expiry } : {}),
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
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));

      savedEnv['DATABASE_URL'] = process.env['DATABASE_URL'];
      savedEnv['AUTH_AUDIENCE'] = process.env['AUTH_AUDIENCE'];
      savedEnv['AUTH_PUBLIC_KEY'] = process.env['AUTH_PUBLIC_KEY'];
      savedEnv['MAILER_PROVIDER'] = process.env['MAILER_PROVIDER'];
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = 'aramo-tr7-b1-spec';
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
      for (const t of ['TalentEducationEntry', 'TalentCertificationEntry']) {
        await db.query(`TRUNCATE TABLE talent_evidence."${t}" CASCADE`);
      }
      for (const t of ['EvidenceRecord', 'TrustState', 'ResolutionSubjectRef', 'ResolutionSubject']) {
        await db.query(`TRUNCATE TABLE talent_trust."${t}" CASCADE`);
      }
    });

    // ---- (a) happy path per class -------------------------------------------

    it('(a) routes DEGREE + CERTIFICATION into canonical CLAIMS evidence (ai_derived, source_ref both ways)', async () => {
      const talent = uuidv7();
      const eduId = await seedEducation(TENANT_A, talent, {
        institution: 'MIT',
        degree: 'BSc',
        field: 'Computer Science',
        conferred: new Date('2018-05-01'),
      });
      const certId = await seedCertification(TENANT_A, talent, {
        name: 'CKA',
        issuer: 'CNCF',
        issued: new Date('2021-03-01'),
      });

      const r = await extraction.routeDeclaredEvidenceToLedger({ tenant_id: TENANT_A, talent_id: talent });
      expect(r.education_written).toBe(1);
      expect(r.certification_written).toBe(1);
      expect(r.skipped).toBe(0);

      const deg = await db.query(
        `SELECT dimension, source_class, method, ai_derived, created_by, assertion_payload, source_ref
         FROM talent_trust."EvidenceRecord" WHERE assertion_type = 'DEGREE'`,
      );
      expect(deg.rows).toHaveLength(1);
      expect(deg.rows[0]).toMatchObject({
        dimension: 'CLAIMS',
        source_class: 'THIRD_PARTY_UNVERIFIED',
        method: 'DOCUMENT',
        ai_derived: true,
        created_by: 'talent-extraction',
      });
      expect(deg.rows[0].assertion_payload).toMatchObject({
        institution_raw: 'MIT',
        degree_raw: 'BSc',
        field_raw: 'Computer Science',
        conferred_date: '2018-05-01',
      });
      expect(deg.rows[0].source_ref).toMatchObject({ talent_evidence_id: eduId, kind: 'education' });

      const cert = await db.query(
        `SELECT assertion_payload, source_ref FROM talent_trust."EvidenceRecord" WHERE assertion_type = 'CERTIFICATION'`,
      );
      expect(cert.rows[0].assertion_payload).toMatchObject({
        name_raw: 'CKA',
        issuer_raw: 'CNCF',
        issued_date: '2021-03-01',
      });
      expect(cert.rows[0].source_ref).toMatchObject({ talent_evidence_id: certId, kind: 'certification' });
    });

    // ---- (f) the elevation truth (over real recompute) ----------------------

    it('(f) an unverified DEGREE moves CLAIMS off NOT_ESTABLISHED but does NOT reach the top bands', async () => {
      const talent = uuidv7();
      await seedEducation(TENANT_A, talent, { institution: 'State U', degree: 'MA' });
      await extraction.routeDeclaredEvidenceToLedger({ tenant_id: TENANT_A, talent_id: talent });

      const state = await trust.getTrustState({
        tenant_id: TENANT_A,
        ref_type: 'ATS_TALENT_RECORD',
        ref_id: talent,
      });
      expect(state?.claims_band).toBe('SELF_ASSERTED');
      expect(state?.claims_band).not.toBe('INDEPENDENTLY_VERIFIED');
      expect(state?.claims_band).not.toBe('AUTHORITATIVE');
    });

    // ---- (c) idempotence + backfill -----------------------------------------

    it('(c) a forced re-run writes zero duplicate credential evidence', async () => {
      const talent = uuidv7();
      await seedEducation(TENANT_A, talent, { institution: 'MIT', degree: 'PhD' });
      await seedCertification(TENANT_A, talent, { name: 'PMP' });

      const first = await extraction.routeDeclaredEvidenceToLedger({ tenant_id: TENANT_A, talent_id: talent });
      expect(first.education_written + first.certification_written).toBe(2);
      expect(await ledgerCount(talent)).toBe(2);

      const second = await extraction.routeDeclaredEvidenceToLedger({ tenant_id: TENANT_A, talent_id: talent });
      expect(second.education_written).toBe(0);
      expect(second.certification_written).toBe(0);
      expect(second.skipped).toBe(2);
      expect(await ledgerCount(talent)).toBe(2);
    });

    it('(c) backfill routes credential rows with counts; second run = 0; other tenant untouched', async () => {
      const a1 = uuidv7();
      const b1 = uuidv7();
      await seedEducation(TENANT_A, a1, { institution: 'MIT', degree: 'BSc' });
      await seedCertification(TENANT_A, a1, { name: 'CKA' });
      await seedEducation(TENANT_B, b1, { institution: 'Oxford', degree: 'MA' }); // other tenant

      const r1 = await extraction.backfillLedgerForTenant(TENANT_A);
      expect(r1.talents).toBe(1);
      expect(r1.education_written).toBe(1);
      expect(r1.certification_written).toBe(1);
      expect(r1.skipped).toBe(0);
      expect(await ledgerCount(b1)).toBe(0); // tenant scoping

      const r2 = await extraction.backfillLedgerForTenant(TENANT_A);
      expect(r2.education_written).toBe(0);
      expect(r2.certification_written).toBe(0);
      expect(r2.skipped).toBe(2);

      const tenants = await extraction.listTenantIdsWithEvidence();
      expect(tenants.sort()).toEqual([TENANT_A, TENANT_B].sort());
    });
  },
);
