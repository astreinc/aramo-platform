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

// PR-A8-2 Gate 5 — suggest-mapping integration spec.
//
// Proofs (the §4 load-bearing assertions for the integration layer;
// the per-target unit specs in libs/import/src/tests/ cover synonym /
// data-shape / unmatched / determinism / the no-LLM-boundary):
//   A) THREE-AXIS A2 GATING on /v1/imports/suggest-mapping
//      (entitlement / authorization / site axes reject).
//   B) END-TO-END (the §4.7 proof): suggest → take the suggestion's
//      confirmed mapping → A8-1's POST /v1/imports accepts it →
//      'committed' with success_count == row_count. The contract
//      that A8-2 feeds A8-1.
//
// MIGRATIONS list is UNCHANGED from PR-A8-1 — A8-2 adds no schema.

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
const COMPANY_OFF_LIMITS = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260616000000_add_company_off_limits/migration.sql',
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
// Segment 2 — the talent-stated availability_status + engagement_type columns
// (Prisma create RETURNING projects them; the test DB must carry them).
const TALENT_RECORD_STATED_FIELDS = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260615000000_talent_stated_fields/migration.sql',
);

const MIGRATIONS = [
  ENTITLEMENT_INIT,
  TALENT_INIT,
  COMPANY_INIT,
  COMPANY_FIELD_EXPANSION,
  COMPANY_ADDRESS_PLACE_REF,
  COMPANY_OFF_LIMITS,
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
  TALENT_RECORD_STATED_FIELDS,
];

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-ats-a8-2-suggest-mapping-spec';
const ALG = 'RS256';

const TENANT_ATS = '01900000-0000-7000-8000-000000000001';
const TENANT_NOT_ATS = '22222222-2222-7222-8222-222222222222';
const SITE_A = '33333333-3333-7333-8333-3333333333aa';
const SITE_B = '44444444-4444-7444-8444-4444444444bb';

const RECRUITER = '00000000-0000-7000-8000-000000000bb1';

const RECRUITER_SCOPES = ['import:create', 'import:read'];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'PR-A8-2 suggest-mapping — A2 gating + suggest→confirm→import e2e (real Postgres 17)',
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

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      setupClient = new Client({ connectionString: url });
      await setupClient.connect();

      for (const p of MIGRATIONS) {
        await setupClient.query(readFileSync(p, 'utf8'));
      }

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
    // A) Three-axis A2 gating on /v1/imports/suggest-mapping. Same
    //    pattern as A8-1's run endpoint — class-level
    //    @RequireCapability('ats') + route-level @RequireScopes +
    //    @RequireSiteMatch.
    // -------------------------------------------------------------------------

    it('Entitlement axis: tenant lacking ats → 403 TENANT_CAPABILITY_NOT_ENTITLED', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/imports/suggest-mapping?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterJwt_NotAts}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            target_entity: 'company',
            headers: ['Name'],
            sample_rows: [],
          }),
        },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('TENANT_CAPABILITY_NOT_ENTITLED');
    });

    it('Authorization axis: unscoped → 403 INSUFFICIENT_PERMISSIONS', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/imports/suggest-mapping?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${unscopedJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            target_entity: 'company',
            headers: ['Name'],
            sample_rows: [],
          }),
        },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('Site axis: token site != requested site → 403', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/imports/suggest-mapping?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterJwt_WrongSite}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            target_entity: 'company',
            headers: ['Name'],
            sample_rows: [],
          }),
        },
      );
      expect(res.status).toBe(403);
    });

    // -------------------------------------------------------------------------
    // B) End-to-end: suggest → take the suggestion as confirmed →
    //    POST /v1/imports → 'committed'. THE A8-2 → A8-1 contract.
    // -------------------------------------------------------------------------

    it('Suggest → confirm → import: company CSV (suggest sees "Company Name","City"; A8-1 accepts and commits)', async () => {
      // Step 1 — SUGGEST.
      const suggestRes = await fetch(
        `http://127.0.0.1:${port}/v1/imports/suggest-mapping?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            target_entity: 'company',
            headers: ['Company Name', 'City'],
            sample_rows: [
              { 'Company Name': 'E2ECo 1', City: 'Boston' },
              { 'Company Name': 'E2ECo 2', City: 'NYC' },
            ],
          }),
        },
      );
      expect(suggestRes.status).toBe(200);
      const suggested = (await suggestRes.json()) as {
        target_entity: string;
        suggestions: Array<{
          field: string;
          suggested_source_column: string | null;
          confidence: string;
          reason: string;
        }>;
        unmatched_required_fields: string[];
        reference_docs: Array<{
          field: string;
          type: string;
          required: boolean;
          example: string;
        }>;
        samples: Array<{ source_column: string; sample_values: string[] }>;
      };
      expect(suggested.target_entity).toBe('company');
      const nameSugg = suggested.suggestions.find((s) => s.field === 'name');
      expect(nameSugg?.suggested_source_column).toBe('Company Name');
      expect(nameSugg?.confidence).toBe('high');
      expect(nameSugg?.reason).toBe('synonym');
      const citySugg = suggested.suggestions.find((s) => s.field === 'city');
      expect(citySugg?.suggested_source_column).toBe('City');
      // Required `name` is matched → unmatched_required is empty.
      expect(suggested.unmatched_required_fields).toEqual([]);
      // Reference docs carry the required+type+example.
      const nameDoc = suggested.reference_docs.find((d) => d.field === 'name');
      expect(nameDoc?.required).toBe(true);
      // Samples present.
      expect(
        suggested.samples.find((s) => s.source_column === 'Company Name')
          ?.sample_values.length,
      ).toBeGreaterThan(0);

      // Step 2 — TAKE THE SUGGESTION AS A CONFIRMED MAPPING. The user
      // would normally review/correct; here we accept the suggestion
      // verbatim by collapsing { field → source_column } into A8-1's
      // ConfirmedMapping shape { source_column → field }.
      const confirmedMapping: Record<string, string> = {};
      for (const s of suggested.suggestions) {
        if (s.suggested_source_column === null) continue;
        confirmedMapping[s.suggested_source_column] = s.field;
      }
      expect(confirmedMapping).toEqual({ 'Company Name': 'name', City: 'city' });

      // Step 3 — A8-1 ACCEPTS THE CONFIRMED MAPPING.
      const rows = Array.from({ length: 3 }, (_, i) => ({
        'Company Name': `E2EConfirm ${i + 1}`,
        City: 'Boston',
      }));
      const importRes = await fetch(
        `http://127.0.0.1:${port}/v1/imports?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            target_entity: 'company',
            source_filename: 'e2e-confirm.csv',
            site_id: SITE_A,
            mapping: confirmedMapping,
            rows,
          }),
        },
      );
      expect(importRes.status).toBe(201);
      const batch = (await importRes.json()) as {
        id: string;
        status: string;
        row_count: number;
        success_count: number;
      };
      expect(batch.status).toBe('committed');
      expect(batch.row_count).toBe(3);
      expect(batch.success_count).toBe(3);

      // Confirm the rows actually persisted under the suggested
      // mapping's field choices.
      const r = await setupClient.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM "company"."Company"
         WHERE import_batch_id = $1::uuid AND name LIKE 'E2EConfirm %' AND city = 'Boston'`,
        [batch.id],
      );
      expect(Number(r.rows[0]?.c ?? '0')).toBe(3);
    });

    it('Unmatched-required surface: contact CSV missing first_name header → first_name + company_id flagged', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/imports/suggest-mapping?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            target_entity: 'contact',
            headers: ['Surname', 'Email'],
            sample_rows: [{ Surname: 'Smith', Email: 'jane@x.com' }],
          }),
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        unmatched_required_fields: string[];
        suggestions: Array<{
          field: string;
          suggested_source_column: string | null;
          confidence: string;
        }>;
      };
      // first_name + company_id are required; first_name has no
      // matching header here, company_id has empty synonyms (FK).
      expect(body.unmatched_required_fields).toContain('first_name');
      expect(body.unmatched_required_fields).toContain('company_id');
      // last_name IS matched by "Surname" (synonym 'surname').
      const lastName = body.suggestions.find((s) => s.field === 'last_name');
      expect(lastName?.suggested_source_column).toBe('Surname');
    });

    it('Bad request: target_entity not in the closed list → 400 VALIDATION_ERROR', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/imports/suggest-mapping?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            target_entity: 'not_a_target',
            headers: ['Name'],
            sample_rows: [],
          }),
        },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('VALIDATION_ERROR');
    });
  },
);
