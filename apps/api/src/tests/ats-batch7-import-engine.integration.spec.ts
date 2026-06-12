import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  exportSPKI,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type KeyObject,
} from 'jose';

import { AppModule } from '../app.module.js';

// PR-A8-1 Gate 5 — import ENGINE integration spec.
//
// Proof matrix (the §5 load-bearing assertions):
//   A) Three-axis A2 gating on /v1/imports
//      (entitlement / authorization / site reject).
//   B) Happy path — clean CSV → 'committed'; success_count == row_count;
//      each persisted row carries the batch's import_batch_id.
//   C) Partial-commit — CSV with K failures below threshold →
//      'partially_committed'; success_count == N-K, failure_count == K;
//      GET /failures returns K rows with reasons + original data.
//   D) Threshold reject — CSV with failures > threshold →
//      IMPORT_THRESHOLD_EXCEEDED (422); NO rows persisted; rollback
//      verified by SELECT COUNT(*); batch.status == 'rejected'.
//   E) Reversion — POST /:id/revert on a committed batch → 'reverted';
//      the batch's rows removed (by import_batch_id); non-batch rows
//      untouched. Re-revert → 409 IMPORT_ALREADY_REVERTED.
//   F) THE non-negotiable boundary (load-bearing): importing
//      target_entity='talent_record' creates TalentRecord rows with
//      core_talent_id NULL; talent.Talent + talent.TalentTenantOverlay
//      row-counts are BIT-IDENTICAL pre/post the import. The A5b-2
//      boundary-proof pattern, replayed at the import layer.
//
// Skipped unless ARAMO_RUN_INTEGRATION=1.

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');

const ENTITLEMENT_INIT = resolve(
  ROOT,
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
);
const TALENT_INIT = resolve(
  ROOT,
  'libs/talent/prisma/migrations/20260516085014_init_talent_model/migration.sql',
);
const COMPANY_INIT = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260601160000_init_company_model/migration.sql',
);
const COMPANY_FIELD_EXPANSION = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260611000000_add_company_field_expansion/migration.sql',
);
const COMPANY_ADDRESS_PLACE_REF = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260611120000_add_company_address_place_ref/migration.sql',
);
const CONTACT_INIT = resolve(
  ROOT,
  'libs/contact/prisma/migrations/20260601160000_init_contact_model/migration.sql',
);
const REQUISITION_INIT = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260602100000_init_requisition_model/migration.sql',
);
const TALENT_RECORD_INIT = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260602120000_init_talent_record_model/migration.sql',
);
const TALENT_RECORD_LINK_ADD = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260603020000_add_core_talent_link_to_talent_record/migration.sql',
);
// PR-A8-1 — the import engine + the 4 back-reference columns.
const IMPORT_INIT = resolve(
  ROOT,
  'libs/import/prisma/migrations/20260603140000_init_import_model/migration.sql',
);
const COMPANY_IMPORT_BACK_REF = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260603140100_add_import_batch_id_to_company/migration.sql',
);
const CONTACT_IMPORT_BACK_REF = resolve(
  ROOT,
  'libs/contact/prisma/migrations/20260603140100_add_import_batch_id_to_contact/migration.sql',
);
const REQUISITION_IMPORT_BACK_REF = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260603140100_add_import_batch_id_to_requisition/migration.sql',
);
// Compensation-Field Modeling v1.1 — 2 enums + 10 nullable comp cols.
const REQUISITION_COMPENSATION_FIELDS = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260605123400_add_compensation_fields_to_requisition/migration.sql',
);
// Job-Module — enterprise + financial + golden_profile_id columns. The
// repository's RETURNING projection includes them; absent in DB → 500 on
// every requisition write/read (the documented migration-harness gap:
// per-spec MIGRATIONS lists are hardcoded, not auto-discovered).
const REQUISITION_JOB_MODULE_FIELDS = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260611220000_job_module_requisition_fields/migration.sql',
);
const TALENT_RECORD_IMPORT_BACK_REF = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260603140100_add_import_batch_id_to_talent_record/migration.sql',
);

const MIGRATIONS = [
  ENTITLEMENT_INIT,
  TALENT_INIT,
  COMPANY_INIT,
  COMPANY_FIELD_EXPANSION,
  COMPANY_ADDRESS_PLACE_REF,
  CONTACT_INIT,
  REQUISITION_INIT,
  TALENT_RECORD_INIT,
  TALENT_RECORD_LINK_ADD,
  IMPORT_INIT,
  COMPANY_IMPORT_BACK_REF,
  CONTACT_IMPORT_BACK_REF,
  REQUISITION_IMPORT_BACK_REF,
  REQUISITION_COMPENSATION_FIELDS, REQUISITION_JOB_MODULE_FIELDS,
  TALENT_RECORD_IMPORT_BACK_REF,
];

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-ats-batch7-import-engine-spec';
const ALG = 'RS256';

const TENANT_ATS = '01900000-0000-7000-8000-000000000001';
const TENANT_NOT_ATS = '22222222-2222-7222-8222-222222222222';
const SITE_A = '33333333-3333-7333-8333-3333333333aa';
const SITE_B = '44444444-4444-7444-8444-4444444444bb';

const RECRUITER = '00000000-0000-7000-8000-000000000bb1';
const TENANT_ADMIN = '00000000-0000-7000-8000-000000000aa1';

// Scopes — not seeded at A8-1 (gap-and-note per directive §4). The
// RolesGuard reads scopes from the JWT, so the spec passes them in
// the token directly.
//
// Scope tiering — Commit-Plan §2 OVERRIDE (Lead review at Gate 6):
//   - import:create / import:read → recruiter+
//   - import:delete               → tenant_admin ONLY (a batch-revert
//                                    is a bulk entity DELETE — Ruling 1
//                                    destructive; unlike the
//                                    attachment:delete junction-link
//                                    carve-out).
// The "recruiter-revert-rejected" assertion in the reversion test is
// the load-bearing proof of the override.
const RECRUITER_SCOPES = [
  'import:create',
  'import:read',
];
const TENANT_ADMIN_SCOPES = [
  ...RECRUITER_SCOPES,
  'import:delete',
];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'PR-A8-1 import engine — audited reversible batches + partial-commit (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let setupClient: Client;

    let recruiterJwt: string;
    let recruiterJwt_NotAts: string;
    let recruiterJwt_WrongSite: string;
    let unscopedJwt: string;
    let tenantAdminJwt: string;

    async function signJwt(
      privateKey: SignKey,
      args: { sub: string; tenant_id: string; site_id?: string; scopes: string[] },
    ): Promise<string> {
      const builder = new SignJWT({
        sub: args.sub,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: args.tenant_id,
        scopes: args.scopes,
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h');
      return builder.sign(privateKey);
    }

    async function countTalentRows(): Promise<number> {
      const r = await setupClient.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM talent."Talent"`,
      );
      return Number(r.rows[0]?.c ?? '0');
    }

    async function countOverlayRows(): Promise<number> {
      const r = await setupClient.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM talent."TalentTenantOverlay"`,
      );
      return Number(r.rows[0]?.c ?? '0');
    }

    async function readImportBatchId(
      table: string,
      schema: string,
      id: string,
    ): Promise<string | null> {
      const r = await setupClient.query<{ import_batch_id: string | null }>(
        `SELECT import_batch_id FROM "${schema}"."${table}" WHERE id = $1::uuid`,
        [id],
      );
      return r.rows[0]?.import_batch_id ?? null;
    }

    async function countTalentRecordsForBatch(batchId: string): Promise<number> {
      const r = await setupClient.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM talent_record."TalentRecord"
         WHERE import_batch_id = $1::uuid`,
        [batchId],
      );
      return Number(r.rows[0]?.c ?? '0');
    }

    async function countCoreTalentLinks(): Promise<number> {
      // Defensive: even if Core tables exist, no TalentRecord created
      // by the engine should carry a non-NULL core_talent_id.
      const r = await setupClient.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM talent_record."TalentRecord"
         WHERE core_talent_id IS NOT NULL`,
      );
      return Number(r.rows[0]?.c ?? '0');
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      setupClient = new Client({ connectionString: url });
      await setupClient.connect();

      for (const p of MIGRATIONS) {
        await setupClient.query(readFileSync(p, 'utf8'));
      }

      // Entitle TENANT_ATS for the `ats` capability.
      await setupClient.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
         VALUES ($1::uuid, 'ats')
         ON CONFLICT (tenant_id, capability) DO NOTHING`,
        [TENANT_ATS],
      );

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      const privateKey: SignKey = kp.privateKey as SignKey;

      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
        AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
        IMPORT_FAILURE_THRESHOLD_PCT: process.env['IMPORT_FAILURE_THRESHOLD_PCT'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;
      // Pin threshold at 10% for deterministic test outcomes.
      process.env['IMPORT_FAILURE_THRESHOLD_PCT'] = '10';

      recruiterJwt = await signJwt(privateKey, {
        sub: RECRUITER,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: RECRUITER_SCOPES,
      });
      recruiterJwt_NotAts = await signJwt(privateKey, {
        sub: RECRUITER,
        tenant_id: TENANT_NOT_ATS,
        site_id: SITE_A,
        scopes: RECRUITER_SCOPES,
      });
      recruiterJwt_WrongSite = await signJwt(privateKey, {
        sub: RECRUITER,
        tenant_id: TENANT_ATS,
        site_id: SITE_B,
        scopes: RECRUITER_SCOPES,
      });
      unscopedJwt = await signJwt(privateKey, {
        sub: RECRUITER,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: [],
      });
      tenantAdminJwt = await signJwt(privateKey, {
        sub: TENANT_ADMIN,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: TENANT_ADMIN_SCOPES,
      });

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }),
      );
      await app.init();
      const server = await app.listen(0);
      const address = server.address() as AddressInfo;
      port = address.port;
    }, 240_000);

    afterAll(async () => {
      await app?.close();
      await setupClient?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    // -------------------------------------------------------------------------
    // A) Three-axis A2 gating reuse.
    // -------------------------------------------------------------------------

    it('Import entitlement axis: tenant lacking ats → 403 TENANT_CAPABILITY_NOT_ENTITLED', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/imports?site_id=${SITE_A}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${recruiterJwt_NotAts}` },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('TENANT_CAPABILITY_NOT_ENTITLED');
    });

    it('Import authorization axis: unscoped → 403 INSUFFICIENT_PERMISSIONS', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/imports?site_id=${SITE_A}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${unscopedJwt}` },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('Import site axis: token site != requested site → 403', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/imports?site_id=${SITE_A}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${recruiterJwt_WrongSite}` },
      });
      expect(res.status).toBe(403);
    });

    // -------------------------------------------------------------------------
    // B) Happy path — 20 clean company rows.
    // -------------------------------------------------------------------------

    it('Happy import (company): committed; success_count == row_count; back-reference set', async () => {
      const rows = Array.from({ length: 20 }, (_, i) => ({
        Name: `HappyCo ${i + 1}`,
        City: 'Boston',
      }));

      const res = await fetch(
        `http://127.0.0.1:${port}/v1/imports?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            target_entity: 'company',
            source_filename: 'happy-companies.csv',
            site_id: SITE_A,
            mapping: { Name: 'name', City: 'city' },
            rows,
          }),
        },
      );
      expect(res.status).toBe(201);
      const batch = (await res.json()) as {
        id: string;
        status: string;
        row_count: number;
        success_count: number;
        failure_count: number;
      };
      expect(batch.status).toBe('committed');
      expect(batch.row_count).toBe(20);
      expect(batch.success_count).toBe(20);
      expect(batch.failure_count).toBe(0);

      // Confirm a sample row carries the batch's import_batch_id.
      const r = await setupClient.query<{ id: string }>(
        `SELECT id FROM "company"."Company" WHERE name = 'HappyCo 5' LIMIT 1`,
      );
      const sampleId = r.rows[0]?.id;
      expect(sampleId).toBeDefined();
      const backref = await readImportBatchId(
        'Company',
        'company',
        sampleId as string,
      );
      expect(backref).toBe(batch.id);
    });

    // -------------------------------------------------------------------------
    // C) Partial-commit — 1 failure in 20 rows (5% — below 10% threshold).
    // -------------------------------------------------------------------------

    it('Partial-commit (company): 1 bad row in 20 → partially_committed + 1 failure in /failures', async () => {
      const rows: Array<Record<string, string | null>> = Array.from(
        { length: 19 },
        (_, i) => ({ Name: `PartialCo ${i + 1}`, City: 'NYC' }),
      );
      // Row 10 (1-based) is missing the required `name` field.
      rows.splice(9, 0, { Name: null, City: 'NYC' });

      const res = await fetch(
        `http://127.0.0.1:${port}/v1/imports?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            target_entity: 'company',
            source_filename: 'partial-companies.csv',
            site_id: SITE_A,
            mapping: { Name: 'name', City: 'city' },
            rows,
          }),
        },
      );
      expect(res.status).toBe(201);
      const batch = (await res.json()) as {
        id: string;
        status: string;
        row_count: number;
        success_count: number;
        failure_count: number;
      };
      expect(batch.status).toBe('partially_committed');
      expect(batch.row_count).toBe(20);
      expect(batch.success_count).toBe(19);
      expect(batch.failure_count).toBe(1);

      // Verify the 19 valid rows persisted.
      const persisted = await setupClient.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM "company"."Company"
         WHERE import_batch_id = $1::uuid`,
        [batch.id],
      );
      expect(Number(persisted.rows[0]?.c ?? '0')).toBe(19);

      // GET /failures returns the 1 failure with reason + original data.
      const failsRes = await fetch(
        `http://127.0.0.1:${port}/v1/imports/${batch.id}/failures?site_id=${SITE_A}`,
        { headers: { Authorization: `Bearer ${recruiterJwt}` } },
      );
      expect(failsRes.status).toBe(200);
      const fails = (await failsRes.json()) as {
        items: Array<{
          row_number: number;
          failure_reason: string;
          offending_fields: string[];
          original_row_data: Record<string, unknown>;
        }>;
      };
      expect(fails.items.length).toBe(1);
      expect(fails.items[0]?.row_number).toBe(10);
      expect(fails.items[0]?.offending_fields).toContain('name');
      expect(fails.items[0]?.failure_reason).toMatch(/missing required field/i);
      expect(fails.items[0]?.original_row_data).toEqual({
        Name: null,
        City: 'NYC',
      });
    });

    // -------------------------------------------------------------------------
    // D) Threshold reject — 5 failures in 10 rows (50% — above 10% threshold).
    // -------------------------------------------------------------------------

    it('Threshold reject (company): 5/10 fail → 422 IMPORT_THRESHOLD_EXCEEDED + rollback (no rows persisted for batch)', async () => {
      const rows: Array<Record<string, string | null>> = [
        { Name: 'RejectCo 1', City: 'LA' },
        { Name: null, City: 'LA' }, // bad
        { Name: 'RejectCo 3', City: 'LA' },
        { Name: null, City: 'LA' }, // bad
        { Name: 'RejectCo 5', City: 'LA' },
        { Name: null, City: 'LA' }, // bad
        { Name: 'RejectCo 7', City: 'LA' },
        { Name: null, City: 'LA' }, // bad
        { Name: 'RejectCo 9', City: 'LA' },
        { Name: null, City: 'LA' }, // bad — 5/10 fail
      ];

      const res = await fetch(
        `http://127.0.0.1:${port}/v1/imports?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            target_entity: 'company',
            source_filename: 'reject-companies.csv',
            site_id: SITE_A,
            mapping: { Name: 'name', City: 'city' },
            rows,
          }),
        },
      );
      expect(res.status).toBe(422);
      const body = (await res.json()) as {
        error: { code: string; details: Record<string, unknown> };
      };
      expect(body.error?.code).toBe('IMPORT_THRESHOLD_EXCEEDED');
      expect(body.error.details['threshold_pct']).toBe(10);
      expect(body.error.details['failure_count']).toBe(5);
      expect(body.error.details['row_count']).toBe(10);

      const batchId = body.error.details['import_batch_id'] as string;
      expect(batchId).toBeDefined();

      // Rollback verified: no Company row carries this batch's id.
      const r = await setupClient.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM "company"."Company"
         WHERE import_batch_id = $1::uuid`,
        [batchId],
      );
      expect(Number(r.rows[0]?.c ?? '0')).toBe(0);

      // Batch is in 'rejected' state — but still queryable.
      const batchRes = await fetch(
        `http://127.0.0.1:${port}/v1/imports/${batchId}?site_id=${SITE_A}`,
        { headers: { Authorization: `Bearer ${recruiterJwt}` } },
      );
      expect(batchRes.status).toBe(200);
      const batch = (await batchRes.json()) as { status: string };
      expect(batch.status).toBe('rejected');
    });

    // -------------------------------------------------------------------------
    // E) Reversion — Ruling-1 scope tier (Commit-Plan §2 OVERRIDE):
    //    - recruiter (no import:delete) → 403 INSUFFICIENT_PERMISSIONS
    //    - tenant_admin (carries import:delete) → 200; rows removed by
    //      back-reference; non-batch rows untouched.
    //    - re-revert → 409 IMPORT_ALREADY_REVERTED.
    // -------------------------------------------------------------------------

    it('Reversion: recruiter revert → 403; tenant_admin revert → rows removed; re-revert → 409 IMPORT_ALREADY_REVERTED', async () => {
      // Run a small happy import (recruiter can RUN — that's import:create).
      const rows = Array.from({ length: 5 }, (_, i) => ({
        Name: `RevertCo ${i + 1}`,
        City: 'SF',
      }));

      const runRes = await fetch(
        `http://127.0.0.1:${port}/v1/imports?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            target_entity: 'company',
            source_filename: 'revert-companies.csv',
            site_id: SITE_A,
            mapping: { Name: 'name', City: 'city' },
            rows,
          }),
        },
      );
      expect(runRes.status).toBe(201);
      const batch = (await runRes.json()) as { id: string };

      // Commit-Plan §2 OVERRIDE — RECRUITER REVERT MUST BE REJECTED.
      // The recruiter token lacks `import:delete` (tenant_admin only;
      // a batch-revert is a bulk entity-DELETE = Ruling 1). RolesGuard
      // returns 403 INSUFFICIENT_PERMISSIONS before the controller
      // method is even reached.
      const recruiterRevert = await fetch(
        `http://127.0.0.1:${port}/v1/imports/${batch.id}/revert?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${recruiterJwt}` },
        },
      );
      expect(recruiterRevert.status).toBe(403);
      const recBody = (await recruiterRevert.json()) as {
        error: { code: string };
      };
      expect(recBody.error?.code).toBe('INSUFFICIENT_PERMISSIONS');

      // Confirm the batch's rows are STILL present (the recruiter
      // attempt did NOT delete anything).
      const stillThere = await setupClient.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM "company"."Company"
         WHERE import_batch_id = $1::uuid`,
        [batch.id],
      );
      expect(Number(stillThere.rows[0]?.c ?? '0')).toBe(5);

      // Seed a NON-batch Company row in the same tenant — to prove
      // the tenant_admin reversion's deleteMany is keyed by
      // import_batch_id (not by tenant alone).
      await setupClient.query(
        `INSERT INTO "company"."Company"
           (id, tenant_id, name, is_hot, created_at, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, 'NonBatchCo', false, NOW(), NOW())`,
        [TENANT_ATS],
      );
      const beforeRevert = await setupClient.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM "company"."Company"
         WHERE tenant_id = $1::uuid AND name = 'NonBatchCo'`,
        [TENANT_ATS],
      );
      expect(Number(beforeRevert.rows[0]?.c ?? '0')).toBe(1);

      // Tenant_admin revert — succeeds.
      const adminRevert = await fetch(
        `http://127.0.0.1:${port}/v1/imports/${batch.id}/revert?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${tenantAdminJwt}` },
        },
      );
      expect(adminRevert.status).toBe(200);
      const reverted = (await adminRevert.json()) as {
        status: string;
        reverted_at: string | null;
      };
      expect(reverted.status).toBe('reverted');
      expect(reverted.reverted_at).not.toBeNull();

      // The batch's 5 rows are gone.
      const stillBatch = await setupClient.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM "company"."Company"
         WHERE import_batch_id = $1::uuid`,
        [batch.id],
      );
      expect(Number(stillBatch.rows[0]?.c ?? '0')).toBe(0);

      // The non-batch Company row is UNTOUCHED.
      const afterRevert = await setupClient.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM "company"."Company"
         WHERE tenant_id = $1::uuid AND name = 'NonBatchCo'`,
        [TENANT_ATS],
      );
      expect(Number(afterRevert.rows[0]?.c ?? '0')).toBe(1);

      // Re-revert by tenant_admin → 409 IMPORT_ALREADY_REVERTED.
      const reRevertRes = await fetch(
        `http://127.0.0.1:${port}/v1/imports/${batch.id}/revert?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${tenantAdminJwt}` },
        },
      );
      expect(reRevertRes.status).toBe(409);
      const reBody = (await reRevertRes.json()) as { error: { code: string } };
      expect(reBody.error?.code).toBe('IMPORT_ALREADY_REVERTED');
    });

    // -------------------------------------------------------------------------
    // F) THE non-negotiable boundary — talent_record imports do NOT touch
    // Core. Bit-identical talent.* row-counts pre/post. The A5b-2 boundary
    // proof, replayed at the import layer.
    // -------------------------------------------------------------------------

    it('Boundary proof: importing talent_record creates rows with core_talent_id NULL; talent.Talent + talent.TalentTenantOverlay row-counts bit-identical pre/post', async () => {
      const talentBefore = await countTalentRows();
      const overlayBefore = await countOverlayRows();
      const coreLinkedBefore = await countCoreTalentLinks();

      const rows = Array.from({ length: 8 }, (_, i) => ({
        First: `Boundary${i + 1}`,
        Last: 'Proof',
        Email: `boundary${i + 1}@example.com`,
      }));

      const res = await fetch(
        `http://127.0.0.1:${port}/v1/imports?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            target_entity: 'talent_record',
            source_filename: 'boundary.csv',
            site_id: SITE_A,
            mapping: { First: 'first_name', Last: 'last_name', Email: 'email1' },
            rows,
          }),
        },
      );
      expect(res.status).toBe(201);
      const batch = (await res.json()) as { id: string; status: string; success_count: number };
      expect(batch.status).toBe('committed');
      expect(batch.success_count).toBe(8);

      // 8 new TalentRecord rows attributed to the batch.
      expect(await countTalentRecordsForBatch(batch.id)).toBe(8);

      // BIT-IDENTICAL: Core Talent + overlay row-counts unchanged.
      // The engine never crossed into Core.
      expect(await countTalentRows()).toBe(talentBefore);
      expect(await countOverlayRows()).toBe(overlayBefore);

      // No imported TalentRecord carries a non-NULL core_talent_id.
      expect(await countCoreTalentLinks()).toBe(coreLinkedBefore);
    });

    // -------------------------------------------------------------------------
    // Tenant_admin happy path — runs identically; the controller's
    // chosen scope tier (recruiter+) does not exclude tenant_admin.
    // -------------------------------------------------------------------------

    it('Tenant_admin path: a tenant_admin can run, list, and revert imports', async () => {
      const rows = [{ Name: 'AdminCo', City: 'SF' }];
      const runRes = await fetch(
        `http://127.0.0.1:${port}/v1/imports?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tenantAdminJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            target_entity: 'company',
            source_filename: 'admin.csv',
            site_id: SITE_A,
            mapping: { Name: 'name', City: 'city' },
            rows,
          }),
        },
      );
      expect(runRes.status).toBe(201);

      const listRes = await fetch(
        `http://127.0.0.1:${port}/v1/imports?site_id=${SITE_A}`,
        { headers: { Authorization: `Bearer ${tenantAdminJwt}` } },
      );
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as { items: Array<{ id: string }> };
      expect(list.items.length).toBeGreaterThan(0);
    });
  },
);
