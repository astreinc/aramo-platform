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

// Recruiter scopes — read (assigned-only), create, edit. NO delete,
// NO read:all (the visibility filter keys off the absence of :read:all).
const RECRUITER_SCOPES = [
  'requisition:read',
  'requisition:create',
  'requisition:edit',
];

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

      for (const p of [ENTITLEMENT_INIT, REQUISITION_INIT, REQUISITION_IMPORT_BACK_REF]) {
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
  },
);
