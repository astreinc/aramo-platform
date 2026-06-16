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

// PR-A8-4 Gate 5 — ATS-domain CSV export integration spec.
//
// Proof matrix (the §3 load-bearing assertions):
//
//   A) Three-axis A2 gating on /v1/exports/:entity_type
//      (entitlement / authorization / site reject).
//
//   B) R10 STRUCTURAL seam-exclusion (the load-bearing R10 proof).
//      Mirrors the A7 reporting-spec pattern verbatim: the test
//      container is set up with ONLY the 5 ATS-schema migrations +
//      entitlement (NO engagement / submittal / examination /
//      matching / talent / job_domain). If ExportService touched
//      ANY Core schema, every export call would 500 with
//      `relation does not exist`. Every export returns 200 → the
//      service truly reads no Core schema. Additionally, every
//      CSV header row is inspected for R10-forbidden vocabulary
//      (tier / score / rank / match / examination / engagement /
//      submittal / override / reasoning) — zero matches across
//      the 5 entities.
//
//   C) A3-VISIBILITY (the load-bearing A3 proof). Seed 2 recruiters
//      with 2 requisitions (1 assigned to recruiter A, 1 assigned to
//      recruiter B). Recruiter A's export of requisitions includes
//      only their assigned row; recruiter B's row is excluded. Same
//      for the pipeline export (A3 composed by resolving visible
//      requisition_ids upstream). tenant_admin's export carries BOTH
//      rows. Export ≠ visibility-bypass — the recruiter cannot
//      export rows they couldn't see in the UI.
//
//   D) CSV correctness (RFC-4180 round-trip). A talent_record with
//      a notes field containing comma + double quote + newline
//      survives round-trip through an RFC-4180 reader — the stored
//      value is reconstructed bit-identically from the export.
//
//   E) Export speaks Talent. The talent_record export's header
//      row carries the canonical Aramo field names (first_name,
//      last_name, etc.) and contains zero "candidate" / "applicant" /
//      "joborder" tokens. The inbound vocabulary carve-out (libs/
//      import) does NOT apply outbound.
//
//   F) Column selection. A subset request (?columns=name,city)
//      returns ONLY those columns in the requested order. An
//      unknown column (?columns=name,not_a_field) → 400
//      VALIDATION_ERROR.
//
// Skipped unless ARAMO_RUN_INTEGRATION=1.

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');

const ENTITLEMENT_INIT = resolve(
  ROOT,
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
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
const PIPELINE_INIT = resolve(
  ROOT,
  'libs/pipeline/prisma/migrations/20260602150000_init_pipeline_model/migration.sql',
);
// metering: PipelineRepository.transition writes a UsageEvent row in
// the same tx. We don't transition pipelines here, but the table must
// exist for the schema to be valid.
const METERING_INIT = resolve(
  ROOT,
  'libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
);
// PR-A8-1 — additive back-reference columns on the 4 ATS targets.
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

// === CORE / ENGAGEMENT / SUBMITTAL MIGRATIONS — DELIBERATELY OMITTED ===
//
// This spec applies ONLY the 5 ATS-schema migrations + entitlement +
// metering. The engagement / submittal / examination / matching /
// talent / job_domain schemas are NOT created in the test container.
// If ExportService or any controller it depends on issued a query
// against any of those schemas, the export route would 500 with
// `relation "engagement.Engagement" does not exist` (or similar). The
// fact that every export route returns 200 is the R10 seam-exclusion
// structural proof: A8-4 reads no Core schema.

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-ats-batch8-pr-a8-4-export-spec';
const ALG = 'RS256';

const TENANT_ATS = '01900000-0000-7000-8000-000000000001';
const TENANT_NOT_ATS = '22222222-2222-7222-8222-222222222222';
const SITE_A = '33333333-3333-7333-8333-3333333333aa';
const SITE_B = '44444444-4444-7444-8444-4444444444bb';

const RECRUITER_A = '00000000-0000-7000-8000-000000000bb1';
const RECRUITER_B = '00000000-0000-7000-8000-000000000bb2';
const TENANT_ADMIN = '00000000-0000-7000-8000-000000000aa1';

// Recruiter scope set — includes the read scopes needed to seed via
// existing routes, plus `export:read` (NOT seeded — the controller
// reads it from the JWT, which is the gap-and-note pattern A7 set
// for `report:read`).
const EXPORT_RECRUITER_SCOPES = [
  'export:read',
  'requisition:read',
  'company:create',
  'contact:create',
  'talent:create',
  'requisition:create',
  'requisition:assign',
  'pipeline:add',
];
const EXPORT_TENANT_ADMIN_SCOPES = [
  ...EXPORT_RECRUITER_SCOPES,
  'requisition:read:all', // tenant_admin's A3 see-all proxy
];

// R10 vocabulary anti-tokens — drawn from scripts/verify-vocabulary.sh
// and ci/scripts/verify-ats-refusal.ts. The CSV header row inspector
// asserts zero substring matches across the 5 entity exports.
const R10_FORBIDDEN_HEADER_TOKENS: readonly string[] = [
  'tier',
  'score',
  'rank',
  'match',
  'examination',
  'engagement',
  'submittal',
  'override',
  'reasoning',
];

// Outbound vocabulary anti-tokens — the inbound `candidate` /
// `applicant` carve-out in libs/import does NOT apply to export.
const OUTBOUND_ANTI_TOKENS: readonly string[] = [
  'candidate',
  'applicant',
  'joborder',
];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'PR-A8-4 Gate 5 — ATS CSV export (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let setupClient: Client;

    let recruiterAJwt: string;
    let recruiterBJwt: string;
    let recruiterJwt_NotAts: string;
    let recruiterJwt_WrongSite: string;
    let unscopedJwt: string;
    let tenantAdminJwt: string;

    // Resource ids captured at seed time.
    let reqAssignedToA = '';
    let reqAssignedToB = '';
    let talentRecordSpecialId = '';

    // The talent_record's notes field carries a payload exercising
    // every RFC-4180 escape: comma, double-quote, CR, LF.
    const SPECIAL_NOTES =
      'Recruiter said "great fit", available Q3,\r\nnext step: phone screen';

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

      // Apply ONLY the 5 ATS-schema migrations + entitlement +
      // metering. The OMISSION of engagement/submittal/examination/
      // matching/talent/job_domain is the load-bearing R10 structural
      // proof: if any Core read happened, the call would 500.
      for (const p of [
        ENTITLEMENT_INIT,
        COMPANY_INIT,
        COMPANY_FIELD_EXPANSION,
        COMPANY_ADDRESS_PLACE_REF,
        COMPANY_IMPORT_BACK_REF,
        CONTACT_INIT,
        CONTACT_IMPORT_BACK_REF,
        REQUISITION_INIT,
        REQUISITION_IMPORT_BACK_REF,
        REQUISITION_COMPENSATION_FIELDS, REQUISITION_JOB_MODULE_FIELDS,
        TALENT_RECORD_INIT,
        TALENT_RECORD_LINK_ADD,
        TALENT_RECORD_IMPORT_BACK_REF,
        TALENT_RECORD_STATED_FIELDS,
        PIPELINE_INIT,
        METERING_INIT,
      ]) {
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
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;

      recruiterAJwt = await signJwt(privateKey, {
        sub: RECRUITER_A,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: EXPORT_RECRUITER_SCOPES,
      });
      recruiterBJwt = await signJwt(privateKey, {
        sub: RECRUITER_B,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: EXPORT_RECRUITER_SCOPES,
      });
      recruiterJwt_NotAts = await signJwt(privateKey, {
        sub: RECRUITER_A,
        tenant_id: TENANT_NOT_ATS,
        site_id: SITE_A,
        scopes: EXPORT_RECRUITER_SCOPES,
      });
      recruiterJwt_WrongSite = await signJwt(privateKey, {
        sub: RECRUITER_A,
        tenant_id: TENANT_ATS,
        site_id: SITE_B,
        scopes: EXPORT_RECRUITER_SCOPES,
      });
      unscopedJwt = await signJwt(privateKey, {
        sub: RECRUITER_A,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: [],
      });
      tenantAdminJwt = await signJwt(privateKey, {
        sub: TENANT_ADMIN,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: EXPORT_TENANT_ADMIN_SCOPES,
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

      // Seed:
      //   1 company. 1 contact. 2 talent_records (one carries the
      //   RFC-4180 corner-case notes). 2 requisitions — one assigned
      //   to recruiter A, one assigned to recruiter B (A3-visibility
      //   probe). 1 pipeline on each assigned req (A3 composition
      //   probe).
      const companyA = await postJson('/v1/companies', tenantAdminJwt, {
        name: 'Co A',
        site_id: SITE_A,
      });

      await postJson('/v1/contacts', tenantAdminJwt, {
        company_id: companyA.id,
        first_name: 'Con',
        last_name: 'Tact',
        email1: 'c@x.example',
        site_id: SITE_A,
      });

      const talentNormal = await postJson('/v1/talent-records', tenantAdminJwt, {
        first_name: 'Normal',
        last_name: 'Talent',
        site_id: SITE_A,
      });
      void talentNormal;

      // The talent_record that carries the RFC-4180 round-trip payload.
      const talentSpecial = await postJson('/v1/talent-records', tenantAdminJwt, {
        first_name: 'Edge',
        last_name: 'Case',
        notes: SPECIAL_NOTES,
        site_id: SITE_A,
      });
      talentRecordSpecialId = talentSpecial.id;

      const reqA = await postJson('/v1/requisitions', tenantAdminJwt, {
        title: 'Assigned to Recruiter A',
        company_id: companyA.id,
        site_id: SITE_A,
      });
      reqAssignedToA = reqA.id;
      const reqB = await postJson('/v1/requisitions', tenantAdminJwt, {
        title: 'Assigned to Recruiter B',
        company_id: companyA.id,
        site_id: SITE_A,
      });
      reqAssignedToB = reqB.id;

      await postJson(
        `/v1/requisitions/${reqA.id}/assignments`,
        tenantAdminJwt,
        { user_id: RECRUITER_A, site_id: SITE_A },
      );
      await postJson(
        `/v1/requisitions/${reqB.id}/assignments`,
        tenantAdminJwt,
        { user_id: RECRUITER_B, site_id: SITE_A },
      );

      // One pipeline per req — to verify the A3-visibility filter on
      // the pipeline export (composed via the upstream-resolved
      // visible-requisition-id list).
      await postJson('/v1/pipelines', recruiterAJwt, {
        requisition_id: reqA.id,
        talent_record_id: talentSpecial.id,
        site_id: SITE_A,
      });
      await postJson('/v1/pipelines', recruiterBJwt, {
        requisition_id: reqB.id,
        talent_record_id: talentSpecial.id,
        site_id: SITE_A,
      });
    }, 240_000);

    async function postJson(
      path: string,
      jwt: string,
      body: unknown,
    ): Promise<{ id: string }> {
      const res = await fetch(
        `http://127.0.0.1:${port}${path}?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );
      if (res.status < 200 || res.status >= 300) {
        const text = await res.text();
        throw new Error(`POST ${path} -> ${res.status} ${text}`);
      }
      return (await res.json()) as { id: string };
    }

    async function getCsv(
      path: string,
      jwt: string,
    ): Promise<{ status: number; body: string; headers: Headers }> {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${jwt}` },
      });
      return { status: res.status, body: await res.text(), headers: res.headers };
    }

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
    // A) Three-axis A2 gating on /v1/exports/:entity_type.
    // -------------------------------------------------------------------------

    it('entitlement axis: tenant lacking ats → 403 TENANT_CAPABILITY_NOT_ENTITLED', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/exports/company?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${recruiterJwt_NotAts}` },
        },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('TENANT_CAPABILITY_NOT_ENTITLED');
    });

    it('authorization axis: unscoped → 403 INSUFFICIENT_PERMISSIONS', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/exports/company?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${unscopedJwt}` },
        },
      );
      expect(res.status).toBe(403);
    });

    it('site axis: token site != requested site → 403', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/exports/company?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${recruiterJwt_WrongSite}` },
        },
      );
      expect(res.status).toBe(403);
    });

    // -------------------------------------------------------------------------
    // B) R10 STRUCTURAL seam-exclusion. The container has NO Core
    //    migrations. Every export returns 200 → no Core schema read.
    //    Every header row is R10-vocab-clean.
    // -------------------------------------------------------------------------

    const ENTITIES = [
      'company',
      'contact',
      'requisition',
      'talent_record',
      'pipeline',
    ] as const;

    for (const entity of ENTITIES) {
      it(`R10 seam-exclusion: GET /v1/exports/${entity} returns 200 with NO Core migrations applied`, async () => {
        const r = await getCsv(
          `/v1/exports/${entity}?site_id=${SITE_A}`,
          tenantAdminJwt,
        );
        // If any Core read happened, the request would 500 with
        // `relation does not exist`. 200 = structural proof of zero
        // Core reads in the export engine.
        expect(r.status).toBe(200);
        expect(r.headers.get('content-type')).toContain('text/csv');
      });

      it(`R10 vocabulary clean: ${entity} export header contains zero R10-forbidden tokens`, async () => {
        const r = await getCsv(
          `/v1/exports/${entity}?site_id=${SITE_A}`,
          tenantAdminJwt,
        );
        expect(r.status).toBe(200);
        const headerLine = r.body.split('\r\n')[0] ?? '';
        const lcHeader = headerLine.toLowerCase();
        for (const banned of R10_FORBIDDEN_HEADER_TOKENS) {
          expect(
            lcHeader.includes(banned),
            `${entity} export header contains R10-forbidden token "${banned}": ${headerLine}`,
          ).toBe(false);
        }
      });
    }

    // -------------------------------------------------------------------------
    // C) A3-VISIBILITY (the load-bearing A3 proof).
    //
    //    Setup: reqAssignedToA → recruiter A; reqAssignedToB → recruiter B.
    //    Pipeline rows: one on each req.
    // -------------------------------------------------------------------------

    it('A3 requisition export: recruiter A exports only own-assigned req (NOT recruiter B\'s)', async () => {
      const r = await getCsv(
        `/v1/exports/requisition?site_id=${SITE_A}`,
        recruiterAJwt,
      );
      expect(r.status).toBe(200);
      expect(r.body).toContain(reqAssignedToA);
      expect(r.body).not.toContain(reqAssignedToB);
    });

    it('A3 requisition export: recruiter B exports only own-assigned req (NOT recruiter A\'s)', async () => {
      const r = await getCsv(
        `/v1/exports/requisition?site_id=${SITE_A}`,
        recruiterBJwt,
      );
      expect(r.status).toBe(200);
      expect(r.body).toContain(reqAssignedToB);
      expect(r.body).not.toContain(reqAssignedToA);
    });

    it('A3 requisition export: tenant_admin exports BOTH reqs (tenant-wide)', async () => {
      const r = await getCsv(
        `/v1/exports/requisition?site_id=${SITE_A}`,
        tenantAdminJwt,
      );
      expect(r.status).toBe(200);
      expect(r.body).toContain(reqAssignedToA);
      expect(r.body).toContain(reqAssignedToB);
    });

    it('A3 pipeline export: recruiter A sees only pipeline on own-assigned req', async () => {
      const r = await getCsv(
        `/v1/exports/pipeline?site_id=${SITE_A}`,
        recruiterAJwt,
      );
      expect(r.status).toBe(200);
      // Recruiter A's pipeline is on reqAssignedToA; recruiter B's is on reqAssignedToB.
      expect(r.body).toContain(reqAssignedToA);
      expect(r.body).not.toContain(reqAssignedToB);
    });

    it('A3 pipeline export: tenant_admin sees BOTH pipelines (tenant-wide)', async () => {
      const r = await getCsv(
        `/v1/exports/pipeline?site_id=${SITE_A}`,
        tenantAdminJwt,
      );
      expect(r.status).toBe(200);
      expect(r.body).toContain(reqAssignedToA);
      expect(r.body).toContain(reqAssignedToB);
    });

    // -------------------------------------------------------------------------
    // D) CSV correctness (RFC-4180 round-trip).
    // -------------------------------------------------------------------------

    it('RFC-4180: a field with comma + quote + newline round-trips correctly', async () => {
      const r = await getCsv(
        `/v1/exports/talent_record?site_id=${SITE_A}`,
        tenantAdminJwt,
      );
      expect(r.status).toBe(200);

      const rows = parseRfc4180Csv(r.body);
      const header = rows[0]!;
      const notesIdx = header.indexOf('notes');
      const idIdx = header.indexOf('id');
      expect(notesIdx).toBeGreaterThanOrEqual(0);
      expect(idIdx).toBeGreaterThanOrEqual(0);

      const dataRows = rows.slice(1);
      const special = dataRows.find((row) => row[idIdx] === talentRecordSpecialId);
      expect(special, 'talent_record with special notes not found in export').toBeDefined();
      expect(special![notesIdx]).toBe(SPECIAL_NOTES);
    });

    // -------------------------------------------------------------------------
    // E) Export speaks Talent — talent_record header contains canonical
    //    Aramo names, zero "candidate" / "applicant" / "joborder".
    // -------------------------------------------------------------------------

    it('talent_record export header carries canonical Aramo field names', async () => {
      const r = await getCsv(
        `/v1/exports/talent_record?site_id=${SITE_A}`,
        tenantAdminJwt,
      );
      expect(r.status).toBe(200);
      const header = parseRfc4180Csv(r.body)[0]!;
      expect(header).toContain('first_name');
      expect(header).toContain('last_name');
      expect(header).toContain('email1');
    });

    it('OUTBOUND-VOCABULARY: every entity export header is "candidate" / "applicant" / "joborder" clean', async () => {
      for (const entity of ENTITIES) {
        const r = await getCsv(
          `/v1/exports/${entity}?site_id=${SITE_A}`,
          tenantAdminJwt,
        );
        expect(r.status).toBe(200);
        const lc = (r.body.split('\r\n')[0] ?? '').toLowerCase();
        for (const banned of OUTBOUND_ANTI_TOKENS) {
          expect(
            lc.includes(banned),
            `${entity} export header carries outbound anti-token "${banned}": ${lc}`,
          ).toBe(false);
        }
      }
    });

    // -------------------------------------------------------------------------
    // F) Column selection.
    // -------------------------------------------------------------------------

    it('subset request: only the requested columns appear, in request order', async () => {
      const r = await getCsv(
        `/v1/exports/company?site_id=${SITE_A}&columns=name,city,zip`,
        tenantAdminJwt,
      );
      expect(r.status).toBe(200);
      const header = parseRfc4180Csv(r.body)[0]!;
      expect(header).toEqual(['name', 'city', 'zip']);
    });

    it('unknown column → 400 VALIDATION_ERROR', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/exports/company?site_id=${SITE_A}&columns=name,not_a_field`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${tenantAdminJwt}` },
        },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('VALIDATION_ERROR');
    });

    it('invalid entity_type → 400 VALIDATION_ERROR', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/exports/not_an_entity?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${tenantAdminJwt}` },
        },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('VALIDATION_ERROR');
    });
  },
);

/**
 * Minimal RFC-4180 parser for the round-trip proof. The same shape as
 * the unit-spec helper (libs/export/src/tests/csv-stringifier.spec.ts)
 * — kept local so the assertion is self-contained.
 */
function parseRfc4180Csv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r' && input[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 2;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
