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

// PR-A3 Gate 5 — ATS Batch 2 (requisition + assignment-visibility) integration spec.
//
// Proof matrix:
//   A) A2-style three-axis gating proofs (entitlement / authz / site /
//      recruiter-delete divergence) applied to /v1/requisitions — the
//      pattern reuse verification.
//   B) THE assignment-visibility proof (directive Ruling 4 — A3's
//      load-bearing gate). Demonstrates that the visibility filter is a
//      QUERY PREDICATE, not a guard rejection:
//        - recruiter assigned to req-1 → list includes req-1; GET 200.
//        - recruiter NOT assigned to req-2 → list excludes req-2;
//          GET 404 (NOT 403 — the recruiter holds requisition:read).
//        - tenant_admin (requisition:read:all) → list includes BOTH;
//          GET 200 on each.
//   C) Recruiter divergence on assign/unassign — the assign routes
//      require requisition:assign (tenant_admin only — HK-IDENT-SCOPES
//      retires the prior edit+delete superset expedient). Recruiter
//      assign → 403; admin → 201.
//
// Skipped unless ARAMO_RUN_INTEGRATION=1.

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');

const ENTITLEMENT_INIT = resolve(
  ROOT,
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
);
const REQUISITION_INIT = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260602100000_init_requisition_model/migration.sql',
);
// PR-A8-1 — additive back-reference column on Requisition. The Prisma
// client's RETURNING projection includes import_batch_id; absent in DB
// → 500 INTERNAL_ERROR on POST create.
const REQUISITION_IMPORT_BACK_REF = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260603140100_add_import_batch_id_to_requisition/migration.sql',
);
// Compensation-Field Modeling v1.1 — adds 2 enums + 10 nullable
// comp columns. Prisma's RETURNING projection covers them; absent in
// DB → 500 INTERNAL_ERROR on every requisition write/read.
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
// New Requisition (Requisition Record Spec Amendment v1.0) — rate_type +
// allow_subcontractors + run_match_on_create. Additive; applied last.
const REQUISITION_RATE_TYPE_SUBK = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260618120000_add_rate_type_subk_runmatch/migration.sql',
);
// PR-A1 Requisition-Gating Rework — DROPs the legacy rate_max/salary columns.
// Must apply AFTER the init migration that created them (and after the comp
// fields migration) so the column-existence proof below reflects the drop.
const REQUISITION_DROP_LEGACY_COMP = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260612120000_drop_legacy_requisition_comp/migration.sql',
);

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-ats-batch2-requisition-spec';
const ALG = 'RS256';

const TENANT_ATS = '01900000-0000-7000-8000-000000000001';
const TENANT_NOT_ATS = '22222222-2222-7222-8222-222222222222';
const SITE_A = '33333333-3333-7333-8333-3333333333aa';
const SITE_B = '44444444-4444-7444-8444-4444444444bb';

const RECRUITER_A = '00000000-0000-7000-8000-000000000bb1';
const RECRUITER_B = '00000000-0000-7000-8000-000000000bb2';
const TENANT_ADMIN = '00000000-0000-7000-8000-000000000aa1';

// Recruiter scopes — read (assigned-only) + create. PR-A1 Requisition-Gating
// Rework: recruiter is now READ-ONLY on requisitions — requisition:edit
// REMOVED (a recruiter PATCH is rejected 403 by the in-service status-edit
// gate). NO delete, NO read:all (the visibility filter keys off the absence
// of :read:all).
const RECRUITER_SCOPES = [
  'requisition:read',
  'requisition:create',
];

// PR-A1 — the status-only edit tier (delivery_manager): read (assigned-only)
// + requisition:edit:status, but NOT requisition:edit. May PATCH only the
// status field; any other field → 403 (the restrict-to-subset gate).
const STATUS_ONLY_SCOPES = [
  'requisition:read',
  'requisition:edit:status',
];
const STATUS_ONLY_ACTOR = '00000000-0000-7000-8000-000000000dd1';

// tenant_admin — full set incl. :read:all + :delete + :assign
// (HK-IDENT-SCOPES: requisition:assign is the proper assign-route gate).
const TENANT_ADMIN_SCOPES = [
  'requisition:read',
  'requisition:read:all',
  'requisition:create',
  'requisition:edit',
  'requisition:delete',
  'requisition:assign',
];

const COMPANY_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
// Section D — ?company_id filter constants. Two in-tenant companies for
// the narrow-vs-not split; FOREIGN_COMPANY is a UUID belonging to no req
// in TENANT_ATS (the cross-tenant isolation probe — tenant_id AND
// company_id must isolate without leak).
const FILTER_COMPANY_X = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const FILTER_COMPANY_Y = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const FOREIGN_COMPANY = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'PR-A3 ATS Batch 2 — requisition + assignment-visibility proofs (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let setupClient: Client;

    let recruiterAJwt_Ats_SiteA: string;
    let recruiterBJwt_Ats_SiteA: string;
    let recruiterAJwt_NotAts_SiteA: string;
    let recruiterAJwt_Ats_WrongSite: string;
    let unscopedJwt_Ats_SiteA: string;
    let tenantAdminJwt_Ats_SiteA: string;
    let statusOnlyJwt_Ats_SiteA: string;

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

      for (const p of [ENTITLEMENT_INIT, REQUISITION_INIT, REQUISITION_IMPORT_BACK_REF, REQUISITION_COMPENSATION_FIELDS, REQUISITION_JOB_MODULE_FIELDS, REQUISITION_DROP_LEGACY_COMP, REQUISITION_RATE_TYPE_SUBK]) {
        await setupClient.query(readFileSync(p, 'utf8'));
      }

      // Idempotent ats entitlement for TENANT_ATS (the bootstrap seed
      // already covers this; re-asserting makes the spec self-contained).
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

      recruiterAJwt_Ats_SiteA = await signJwt(privateKey, {
        sub: RECRUITER_A,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: RECRUITER_SCOPES,
      });
      recruiterBJwt_Ats_SiteA = await signJwt(privateKey, {
        sub: RECRUITER_B,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: RECRUITER_SCOPES,
      });
      statusOnlyJwt_Ats_SiteA = await signJwt(privateKey, {
        sub: STATUS_ONLY_ACTOR,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: STATUS_ONLY_SCOPES,
      });
      recruiterAJwt_NotAts_SiteA = await signJwt(privateKey, {
        sub: RECRUITER_A,
        tenant_id: TENANT_NOT_ATS,
        site_id: SITE_A,
        scopes: RECRUITER_SCOPES,
      });
      recruiterAJwt_Ats_WrongSite = await signJwt(privateKey, {
        sub: RECRUITER_A,
        tenant_id: TENANT_ATS,
        site_id: SITE_B,
        scopes: RECRUITER_SCOPES,
      });
      unscopedJwt_Ats_SiteA = await signJwt(privateKey, {
        sub: RECRUITER_A,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: [],
      });
      tenantAdminJwt_Ats_SiteA = await signJwt(privateKey, {
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
    // A) A2 pattern reuse — three-axis gating + recruiter-delete divergence.
    // -------------------------------------------------------------------------

    it('A2-reuse / entitlement axis: tenant lacking ats → 403 TENANT_CAPABILITY_NOT_ENTITLED', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${recruiterAJwt_NotAts_SiteA}` },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('TENANT_CAPABILITY_NOT_ENTITLED');
    });

    it('A2-reuse / authorization axis: user without scope → 403 INSUFFICIENT_PERMISSIONS', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${unscopedJwt_Ats_SiteA}` },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('A2-reuse / site axis: token site != requested site → 403 INSUFFICIENT_PERMISSIONS', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${recruiterAJwt_Ats_WrongSite}` },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('A2-reuse / recruiter-delete divergence: recruiter DELETE /v1/requisitions/:id → 403', async () => {
      // Admin seeds a req for the recruiter to try to delete.
      const createRes = await fetch(`http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Delete-divergence target',
          company_id: COMPANY_ID,
          site_id: SITE_A,
        }),
      });
      const req = (await createRes.json()) as { id: string };

      const res = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${req.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${recruiterAJwt_Ats_SiteA}` },
        },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('INSUFFICIENT_PERMISSIONS');

      // Tenant_admin can delete the same row.
      const adminRes = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${req.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` },
        },
      );
      expect(adminRes.status).toBe(204);
    });

    // -------------------------------------------------------------------------
    // B) THE assignment-visibility proof (Ruling 4) — the load-bearing gate.
    // -------------------------------------------------------------------------

    it('Visibility filter: recruiter sees ONLY assigned reqs in list; unassigned-by-id is 404 (not 403)', async () => {
      // Admin creates 2 reqs in tenant.
      const r1Create = await fetch(`http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Req 1 — assigned to recruiter A',
          company_id: COMPANY_ID,
          site_id: SITE_A,
        }),
      });
      const req1 = (await r1Create.json()) as { id: string };

      const r2Create = await fetch(`http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Req 2 — NOT assigned to recruiter A',
          company_id: COMPANY_ID,
          site_id: SITE_A,
        }),
      });
      const req2 = (await r2Create.json()) as { id: string };

      // Admin assigns recruiter A to req1 (NOT req2).
      const assignRes = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${req1.id}/assignments?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ user_id: RECRUITER_A }),
        },
      );
      expect(assignRes.status).toBe(201);

      // Recruiter A lists — sees ONLY req1.
      const listRes = await fetch(`http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${recruiterAJwt_Ats_SiteA}` },
      });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as { items: Array<{ id: string }> };
      const listIds = list.items.map((i) => i.id);
      expect(listIds).toContain(req1.id);
      expect(listIds).not.toContain(req2.id);

      // Recruiter A GET on req1 → 200.
      const get1 = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${req1.id}?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${recruiterAJwt_Ats_SiteA}` },
        },
      );
      expect(get1.status).toBe(200);

      // Recruiter A GET on req2 → 404 (NOT 403 — Ruling 2: the scope passed).
      const get2 = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${req2.id}?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${recruiterAJwt_Ats_SiteA}` },
        },
      );
      expect(get2.status).toBe(404);
      const body2 = (await get2.json()) as { error: { code: string } };
      expect(body2.error?.code).toBe('NOT_FOUND');

      // Recruiter B (different user, also no assignment) → list excludes
      // both, GET on either → 404. Demonstrates the predicate keys on
      // user_id (not just "no assignments at all" — recruiter B sees
      // zero rows even though req1 has assignments, because none belong
      // to recruiter B).
      const listB = await fetch(`http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${recruiterBJwt_Ats_SiteA}` },
      });
      expect(listB.status).toBe(200);
      const listBBody = (await listB.json()) as { items: Array<{ id: string }> };
      expect(listBBody.items.map((i) => i.id)).not.toContain(req1.id);
      expect(listBBody.items.map((i) => i.id)).not.toContain(req2.id);

      // Tenant_admin (requisition:read:all) sees BOTH.
      const listAdmin = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` },
        },
      );
      expect(listAdmin.status).toBe(200);
      const adminList = (await listAdmin.json()) as { items: Array<{ id: string }> };
      const adminIds = adminList.items.map((i) => i.id);
      expect(adminIds).toContain(req1.id);
      expect(adminIds).toContain(req2.id);

      // Tenant_admin GET on req2 → 200 (no visibility filter).
      const adminGet2 = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${req2.id}?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` },
        },
      );
      expect(adminGet2.status).toBe(200);
    });

    // -------------------------------------------------------------------------
    // C) Assign/unassign — recruiter rejected; tenant_admin succeeds.
    // -------------------------------------------------------------------------

    it('Assign-route divergence: recruiter assign → 403; tenant_admin → 201; unassign restores invisibility', async () => {
      // Admin seeds a req.
      const createRes = await fetch(`http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Assign-divergence target',
          company_id: COMPANY_ID,
          site_id: SITE_A,
        }),
      });
      const req = (await createRes.json()) as { id: string };

      // Recruiter (lacks requisition:assign) → cannot assign.
      const recruiterAssign = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${req.id}/assignments?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterAJwt_Ats_SiteA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ user_id: RECRUITER_A }),
        },
      );
      expect(recruiterAssign.status).toBe(403);

      // Admin assigns recruiter A.
      const adminAssign = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${req.id}/assignments?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ user_id: RECRUITER_A }),
        },
      );
      expect(adminAssign.status).toBe(201);

      // Recruiter A now sees the req (visibility flips with the assignment).
      const getAfter = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${req.id}?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${recruiterAJwt_Ats_SiteA}` },
        },
      );
      expect(getAfter.status).toBe(200);

      // Admin unassigns.
      const unassignRes = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${req.id}/assignments/${RECRUITER_A}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` },
        },
      );
      expect(unassignRes.status).toBe(204);

      // Recruiter A loses visibility — GET 404 again.
      const getRevoked = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${req.id}?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${recruiterAJwt_Ats_SiteA}` },
        },
      );
      expect(getRevoked.status).toBe(404);
    });

    // -------------------------------------------------------------------------
    // D) The ?company_id query-filter proofs (close the R3 carry).
    //    The filter is a TOP-LEVEL Prisma WHERE key, AND-ed with the existing
    //    A3 OR-arm:   tenant_id AND (site_id?) AND (company_id?) AND (D4b OR A3).
    //    The D4b-composes + A3-override-under-filter assertions live in
    //    authz-d4b-visibility-matrix.integration.spec.ts (that spec has the
    //    pod/team identity setup the directive's §1c (ii) + (iii) require);
    //    here we prove filter-narrows + A3+filter compose + no-visibility-empty
    //    + cross-tenant isolation + site+company AND-compose. Backward-compat
    //    is proven implicitly by Section A+B+C above (no ?company_id supplied).
    // -------------------------------------------------------------------------

    it('Company filter: admin ?company_id=X returns ONLY reqs at X (filter narrows)', async () => {
      const xCreate = await fetch(`http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'company-filter-narrow X',
          company_id: FILTER_COMPANY_X,
          site_id: SITE_A,
        }),
      });
      expect(xCreate.status).toBe(201);
      const reqAtX = ((await xCreate.json()) as { id: string }).id;

      const yCreate = await fetch(`http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'company-filter-narrow Y',
          company_id: FILTER_COMPANY_Y,
          site_id: SITE_A,
        }),
      });
      expect(yCreate.status).toBe(201);
      const reqAtY = ((await yCreate.json()) as { id: string }).id;

      const xRes = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}&company_id=${FILTER_COMPANY_X}`,
        { headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` } },
      );
      expect(xRes.status).toBe(200);
      const xBody = (await xRes.json()) as {
        items: Array<{ id: string; company_id: string }>;
      };
      const xIds = xBody.items.map((i) => i.id);
      expect(xIds).toContain(reqAtX);
      expect(xIds).not.toContain(reqAtY);
      expect(xBody.items.every((i) => i.company_id === FILTER_COMPANY_X)).toBe(true);
    });

    it('Company filter: recruiter A3 + ?company_id compose — only the matched-company assigned req', async () => {
      // Admin creates 2 reqs at X and Y; assigns recruiter A to BOTH.
      // The A3 OR-arm puts both in recruiter A's visibility (without
      // a filter); ?company_id=X must narrow to ONLY the X one.
      const xCreate = await fetch(`http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'company-filter-A3 X',
          company_id: FILTER_COMPANY_X,
          site_id: SITE_A,
        }),
      });
      const reqA3X = ((await xCreate.json()) as { id: string }).id;
      const yCreate = await fetch(`http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'company-filter-A3 Y',
          company_id: FILTER_COMPANY_Y,
          site_id: SITE_A,
        }),
      });
      const reqA3Y = ((await yCreate.json()) as { id: string }).id;

      for (const id of [reqA3X, reqA3Y]) {
        const r = await fetch(
          `http://127.0.0.1:${port}/v1/requisitions/${id}/assignments?site_id=${SITE_A}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ user_id: RECRUITER_A }),
          },
        );
        expect(r.status).toBe(201);
      }

      // Recruiter A's full list (no filter) — sanity: includes both.
      const baseRes = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`,
        { headers: { Authorization: `Bearer ${recruiterAJwt_Ats_SiteA}` } },
      );
      const baseBody = (await baseRes.json()) as { items: Array<{ id: string }> };
      const baseIds = baseBody.items.map((i) => i.id);
      expect(baseIds).toContain(reqA3X);
      expect(baseIds).toContain(reqA3Y);

      // ?company_id=X narrows to only the X-side assignment.
      const xRes = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}&company_id=${FILTER_COMPANY_X}`,
        { headers: { Authorization: `Bearer ${recruiterAJwt_Ats_SiteA}` } },
      );
      expect(xRes.status).toBe(200);
      const xIds = ((await xRes.json()) as { items: Array<{ id: string }> }).items.map((i) => i.id);
      expect(xIds).toContain(reqA3X);
      expect(xIds).not.toContain(reqA3Y);

      // ?company_id=Y narrows to only the Y-side assignment.
      const yRes = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}&company_id=${FILTER_COMPANY_Y}`,
        { headers: { Authorization: `Bearer ${recruiterAJwt_Ats_SiteA}` } },
      );
      expect(yRes.status).toBe(200);
      const yIds = ((await yRes.json()) as { items: Array<{ id: string }> }).items.map((i) => i.id);
      expect(yIds).toContain(reqA3Y);
      expect(yIds).not.toContain(reqA3X);
    });

    it('Company filter: recruiter B (no visibility) + ?company_id=X → empty', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}&company_id=${FILTER_COMPANY_X}`,
        { headers: { Authorization: `Bearer ${recruiterBJwt_Ats_SiteA}` } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<unknown> };
      expect(body.items).toEqual([]);
    });

    it('Company filter: ?company_id=<foreign UUID> → empty (no cross-tenant leak)', async () => {
      // Admin in TENANT_ATS can see every req in TENANT_ATS; even so,
      // ?company_id=<UUID belonging to no req in TENANT_ATS> returns
      // empty — the (tenant_id AND company_id) AND-composition isolates.
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}&company_id=${FOREIGN_COMPANY}`,
        { headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<unknown> };
      expect(body.items).toEqual([]);
    });

    it('Company filter: ?site_id + ?company_id AND-compose (both narrow at the WHERE)', async () => {
      // Every returned row matches BOTH the requested site_id and company_id.
      // (Section A already proved the wrong-site guard at the auth layer;
      // here we prove the WHERE-level AND on the matching path.)
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}&company_id=${FILTER_COMPANY_X}`,
        { headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{ id: string; site_id: string | null; company_id: string }>;
      };
      expect(body.items.length).toBeGreaterThan(0);
      for (const item of body.items) {
        expect(item.site_id).toBe(SITE_A);
        expect(item.company_id).toBe(FILTER_COMPANY_X);
      }
    });

    // -------------------------------------------------------------------------
    // E) PR-A1 Requisition-Gating Rework — legacy comp DROP + status-only gate.
    //
    //    LEGACY DROP: the rate_max/salary columns are removed by the
    //    20260612120000_drop_legacy_requisition_comp migration (applied in
    //    setup). The columns were already write-blocked + read-stripped since
    //    D-AUTHZ-COMP-WRITE-2; the drop is the cleanup. The proofs assert the
    //    columns no longer EXIST (information_schema) and that a create still
    //    succeeds when a body carries the dropped keys (plain TS-interface
    //    DTOs ignore unknown keys; the repo never reads them).
    //
    //    STATUS-ONLY GATE (the inverted restrict-to-subset gate): a holder of
    //    requisition:edit:status WITHOUT requisition:edit may PATCH only the
    //    status field; any other field → 403. A full editor is unaffected; a
    //    read-only recruiter (no edit, no edit:status) is rejected 403.
    // -------------------------------------------------------------------------

    it('LEGACY DROP: the rate_max/salary columns no longer exist on requisition."Requisition"', async () => {
      const cols = await setupClient.query(
        `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'requisition' AND table_name = 'Requisition'
             AND column_name IN ('rate_max', 'salary')`,
      );
      expect(cols.rows.length).toBe(0);
    });

    it('LEGACY DROP: recruiter create with dropped keys {salary, rate_max} → 201 (keys ignored, columns gone)', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterAJwt_Ats_SiteA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            title: 'PR-A1 legacy-drop POST probe',
            company_id: COMPANY_ID,
            site_id: SITE_A,
            // The now-dropped keys — the plain-interface DTO + the repo
            // ignore them; create still succeeds (no column to write).
            salary: '150000',
            rate_max: '85/hr',
          }),
        },
      );
      expect(res.status).toBe(201);
    });

    it('STATUS-ONLY: status-only actor PATCH {status} → 200; persisted status updated', async () => {
      const createRes = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            title: 'PR-A1 status-only PATCH target',
            company_id: COMPANY_ID,
            site_id: SITE_A,
          }),
        },
      );
      const reqId = ((await createRes.json()) as { id: string }).id;

      const patchRes = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${reqId}?site_id=${SITE_A}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${statusOnlyJwt_Ats_SiteA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ status: 'closed' }),
        },
      );
      expect(patchRes.status).toBe(200);
      const body = (await patchRes.json()) as { status: string };
      expect(body.status).toBe('closed');
    });

    it('STATUS-ONLY: status-only actor PATCH a non-status field {title} → 403 (status_only_edit_field_violation)', async () => {
      const createRes = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            title: 'PR-A1 status-only forbidden-field target',
            company_id: COMPANY_ID,
            site_id: SITE_A,
          }),
        },
      );
      const reqId = ((await createRes.json()) as { id: string }).id;

      const patchRes = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${reqId}?site_id=${SITE_A}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${statusOnlyJwt_Ats_SiteA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title: 'recruiter-renamed' }),
        },
      );
      expect(patchRes.status).toBe(403);
      const body = (await patchRes.json()) as { error?: { details?: { reason?: string } } };
      expect(body.error?.details?.reason).toBe('status_only_edit_field_violation');
    });

    it('STATUS-ONLY: full editor (tenant_admin) PATCH {status} → 200 (unaffected by the status gate)', async () => {
      const createRes = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            title: 'PR-A1 full-editor status target',
            company_id: COMPANY_ID,
            site_id: SITE_A,
          }),
        },
      );
      const reqId = ((await createRes.json()) as { id: string }).id;

      const patchRes = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${reqId}?site_id=${SITE_A}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ status: 'on_hold' }),
        },
      );
      expect(patchRes.status).toBe(200);
    });

    it('RECRUITER READ-ONLY: recruiter (no edit, no edit:status) PATCH {status} → 403 (requisition_edit_scope_missing)', async () => {
      const createRes = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            title: 'PR-A1 recruiter read-only target',
            company_id: COMPANY_ID,
            site_id: SITE_A,
          }),
        },
      );
      const reqId = ((await createRes.json()) as { id: string }).id;

      const patchRes = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${reqId}?site_id=${SITE_A}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${recruiterAJwt_Ats_SiteA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ status: 'closed' }),
        },
      );
      expect(patchRes.status).toBe(403);
      const body = (await patchRes.json()) as { error?: { details?: { reason?: string } } };
      expect(body.error?.details?.reason).toBe('requisition_edit_scope_missing');
    });

    it('Read surface gone: GET /v1/requisitions and detail GET responses have no rate_max/salary keys', async () => {
      // LIST shape — admin sees the full list; no item carries the
      // deprecated keys (the projectView projection no longer includes them).
      const listRes = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`,
        { headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` } },
      );
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as { items: Array<Record<string, unknown>> };
      expect(list.items.length).toBeGreaterThan(0);
      for (const item of list.items) {
        expect(item).not.toHaveProperty('rate_max');
        expect(item).not.toHaveProperty('salary');
      }

      // Detail shape — same assertion on a single row.
      const firstId = list.items[0]?.['id'] as string;
      expect(typeof firstId).toBe('string');
      const detail = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${firstId}?site_id=${SITE_A}`,
        { headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` } },
      );
      expect(detail.status).toBe(200);
      const detailBody = (await detail.json()) as Record<string, unknown>;
      expect(detailBody).not.toHaveProperty('rate_max');
      expect(detailBody).not.toHaveProperty('salary');
    });
  },
);
