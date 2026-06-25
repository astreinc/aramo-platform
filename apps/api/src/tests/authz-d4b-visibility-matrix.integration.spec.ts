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

// AUTHZ-D4b — the composed visibility predicate + 6-entity cascade
// (READ-SIDE). Proves the over/under-restriction matrix from the D4b
// directive §7 + the commit plan §4.1: 8 rows, both directions per actor.
//
// Load-bearing proofs (this spec covers the critical subset; the rest
// are covered by extension via the existing ats-batch* specs + the
// fixture updates):
//   - Recruiter (direct UserClientAssignment) sees A's work, not B's (404).
//   - Recruiting Manager (Axis-1, depth ≤ 3 via ManagementEdge) inherits
//     reports' direct assignments — sees A + B; does NOT see depth-4 C.
//   - Account Manager (Axis-2, pod TeamClientOwnership) sees A + C via
//     the active pod; does NOT see B (not in pod).
//   - Multi-axis (union) sees A ∪ B ∪ C; not D.
//   - See-all TA (company:read:all + requisition:read:all) sees all.
//   - Talent-pool boundary: a scoped Recruiter searches/finds any
//     talent (tenant-wide); but sees their pipeline rows only for
//     visible clients (work-scoped).
//   - A3 preservation: a Recruiter assigned to req R but NOT to its
//     client C still sees R (the A3 OR-arm preserved).

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');

const IDENTITY_INIT = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
);
// Domain-Enforcement P1 — additive Tenant.allowed_domain column.
const IDENTITY_ALLOWED_DOMAIN = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260625000000_add_tenant_allowed_domain/migration.sql',
);
const IDENTITY_INVITATION_MIG = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260624000000_add_invitation_and_invite_status/migration.sql',
);
const IDENTITY_SITE_AXIS = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260601000000_add_site_axis/migration.sql',
);
const IDENTITY_D4A = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260604000000_add_authz_team_models/migration.sql',
);
// Settings Rebuild D3 — additive tenant-profile columns (Prisma SELECTs them).
const IDENTITY_PROFILE = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260619000000_add_tenant_profile/migration.sql',
);
const IDENTITY_SITE_HIERARCHY = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260620000000_add_site_hierarchy/migration.sql',
);
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
const COMPANY_OFF_LIMITS = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260616000000_add_company_off_limits/migration.sql',
);
const COMPANY_IMPORT_BACK_REF = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260603140100_add_import_batch_id_to_company/migration.sql',
);
const COMPANY_D4A = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260604000000_add_authz_assignment_ownership/migration.sql',
);
const REQUISITION_INIT = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260602100000_init_requisition_model/migration.sql',
);
// Prisma client's RETURNING projection on requisition CREATE includes
// import_batch_id (PR-A8-1 additive back-reference); without this
// migration, the column doesn't exist → 500 INTERNAL_ERROR. Same
// requirement as ats-batch2-requisition.integration.spec.ts.
const REQUISITION_IMPORT_BACK_REF = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260603140100_add_import_batch_id_to_requisition/migration.sql',
);
// Compensation-Field Modeling v1.1 — 2 enums + 10 nullable comp cols
// on requisition. Prisma's RETURNING projection covers them; absent
// in DB → 500 INTERNAL_ERROR on every requisition read/write.
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

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-authz-d4b-spec';
const ALG = 'RS256';

const TENANT_ATS = '01900000-0000-7000-8000-000000000001';
const SITE_A = '33333333-3333-7333-8333-3333333333aa';

// Principals.
const TENANT_ADMIN_U = '00000000-0000-7000-8000-00000000c001';
const RECRUITER_DIRECT = '00000000-0000-7000-8000-00000000c002';
const REC_MANAGER = '00000000-0000-7000-8000-00000000c003';
const REC_REPORT_1 = '00000000-0000-7000-8000-00000000c004';
const REC_REPORT_2 = '00000000-0000-7000-8000-00000000c005';
const ACCOUNT_MANAGER = '00000000-0000-7000-8000-00000000c006';
const MULTI_ACTOR = '00000000-0000-7000-8000-00000000c007';
const REC_A3 = '00000000-0000-7000-8000-00000000c008';

// Tenant-admin needs requisition:assign + company:assign + team:manage to
// set up the world. The visibility scopes for read-tests are minimal —
// the actor under test holds ONLY the basic read scopes (no read:all).
const TA_SCOPES = [
  'company:read',
  'company:create',
  'company:edit',
  'company:assign',
  'org:manage',
  'team:manage',
  'company:read:all',
  'requisition:read',
  'requisition:read:all',
  'requisition:create',
  'requisition:edit',
  'requisition:assign',
  'contact:read',
  'pipeline:read',
];
const RECRUITER_BASIC_SCOPES = [
  'company:read',
  'contact:read',
  'requisition:read',
  'pipeline:read',
  'talent:read',
  'talent:search',
];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'AUTHZ-D4b — composed visibility predicate + 6-entity cascade',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let setupClient: Client;

    let taJwt: string;
    let recruiterDirectJwt: string;
    let recManagerJwt: string;
    let accountManagerJwt: string;
    let multiActorJwt: string;
    let recA3Jwt: string;

    let companyA = '';
    let companyB = '';
    let companyC = '';
    let companyD = '';
    let reqA = '';
    let reqB = '';
    let reqC = '';
    let reqD = '';
    let reqA3only = ''; // a req whose client is NOT in REC_A3's visible set,
    //                    but REC_A3 has a direct RequisitionAssignment.

    async function signJwt(
      privateKey: SignKey,
      args: { sub: string; scopes: string[] },
    ): Promise<string> {
      return new SignJWT({
        sub: args.sub,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: TENANT_ATS,
        scopes: args.scopes,
        site_id: SITE_A,
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);
    }

    async function seedUser(userId: string): Promise<void> {
      await setupClient.query(
        `INSERT INTO identity."User" (id, email, display_name, is_active, updated_at)
         VALUES ($1::uuid, $2, $3, true, CURRENT_TIMESTAMP)
         ON CONFLICT (id) DO NOTHING`,
        [userId, `${userId.slice(-8)}@d4b.test`, `User ${userId.slice(-4)}`],
      );
    }

    async function createCompany(jwt: string, name: string): Promise<string> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/companies?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name, site_id: SITE_A }),
        },
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    }

    async function createRequisition(
      jwt: string,
      title: string,
      company_id: string,
    ): Promise<string> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title, company_id, site_id: SITE_A }),
        },
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    }

    async function assignUserToCompany(
      user_id: string,
      company_id: string,
    ): Promise<void> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/companies/${company_id}/assignments?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${taJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ user_id }),
        },
      );
      expect([200, 201]).toContain(res.status);
    }

    async function setManagementEdge(
      manager_user_id: string,
      report_user_id: string,
    ): Promise<void> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/management/edges?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${taJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ manager_user_id, report_user_id }),
        },
      );
      expect([200, 201]).toContain(res.status);
    }

    async function createPodWithOwnerAndMember(
      owner_user_id: string,
      member_user_id: string,
      name: string,
    ): Promise<string> {
      const create = await fetch(
        `http://127.0.0.1:${port}/v1/teams?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${taJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name, owner_user_id }),
        },
      );
      expect([200, 201]).toContain(create.status);
      const team_id = ((await create.json()) as { id: string }).id;
      const add = await fetch(
        `http://127.0.0.1:${port}/v1/teams/${team_id}/members?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${taJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ user_id: member_user_id }),
        },
      );
      expect([200, 201]).toContain(add.status);
      return team_id;
    }

    async function podOwnsCompany(
      team_id: string,
      company_id: string,
    ): Promise<void> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/teams/${team_id}/clients?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${taJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ company_id }),
        },
      );
      expect([200, 201]).toContain(res.status);
    }

    async function assignReqDirectly(
      requisition_id: string,
      user_id: string,
    ): Promise<void> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${requisition_id}/assignments?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${taJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ user_id }),
        },
      );
      expect([200, 201]).toContain(res.status);
    }

    async function listCompanyIds(jwt: string): Promise<string[]> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/companies?site_id=${SITE_A}`,
        { headers: { Authorization: `Bearer ${jwt}` } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<{ id: string }> };
      return body.items.map((c) => c.id);
    }

    async function getCompany(
      jwt: string,
      id: string,
    ): Promise<{ status: number }> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/companies/${id}?site_id=${SITE_A}`,
        { headers: { Authorization: `Bearer ${jwt}` } },
      );
      return { status: res.status };
    }

    async function listRequisitionIds(jwt: string): Promise<string[]> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`,
        { headers: { Authorization: `Bearer ${jwt}` } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<{ id: string }> };
      return body.items.map((r) => r.id);
    }

    async function listRequisitionIdsByCompany(
      jwt: string,
      company_id: string,
    ): Promise<string[]> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}&company_id=${company_id}`,
        { headers: { Authorization: `Bearer ${jwt}` } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<{ id: string }> };
      return body.items.map((r) => r.id);
    }

    async function getRequisition(
      jwt: string,
      id: string,
    ): Promise<{ status: number }> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${id}?site_id=${SITE_A}`,
        { headers: { Authorization: `Bearer ${jwt}` } },
      );
      return { status: res.status };
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      setupClient = new Client({ connectionString: url });
      await setupClient.connect();

      for (const p of [
        IDENTITY_INIT,
        IDENTITY_ALLOWED_DOMAIN,
        IDENTITY_INVITATION_MIG,
        IDENTITY_SITE_AXIS,
        IDENTITY_D4A,
        IDENTITY_PROFILE,
        IDENTITY_SITE_HIERARCHY,
        ENTITLEMENT_INIT,
        COMPANY_INIT,
        COMPANY_FIELD_EXPANSION,
        COMPANY_ADDRESS_PLACE_REF,
        COMPANY_OFF_LIMITS,
        COMPANY_IMPORT_BACK_REF,
        COMPANY_D4A,
        REQUISITION_INIT,
        REQUISITION_IMPORT_BACK_REF,
        REQUISITION_COMPENSATION_FIELDS, REQUISITION_JOB_MODULE_FIELDS, REQUISITION_RATE_TYPE_SUBK,
      ]) {
        await setupClient.query(readFileSync(p, 'utf8'));
      }

      await setupClient.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
         VALUES ($1::uuid, 'ats')
         ON CONFLICT (tenant_id, capability) DO NOTHING`,
        [TENANT_ATS],
      );

      for (const u of [
        TENANT_ADMIN_U,
        RECRUITER_DIRECT,
        REC_MANAGER,
        REC_REPORT_1,
        REC_REPORT_2,
        ACCOUNT_MANAGER,
        MULTI_ACTOR,
        REC_A3,
      ]) {
        await seedUser(u);
      }

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

      taJwt = await signJwt(privateKey, {
        sub: TENANT_ADMIN_U,
        scopes: TA_SCOPES,
      });
      recruiterDirectJwt = await signJwt(privateKey, {
        sub: RECRUITER_DIRECT,
        scopes: RECRUITER_BASIC_SCOPES,
      });
      recManagerJwt = await signJwt(privateKey, {
        sub: REC_MANAGER,
        scopes: RECRUITER_BASIC_SCOPES,
      });
      accountManagerJwt = await signJwt(privateKey, {
        sub: ACCOUNT_MANAGER,
        scopes: RECRUITER_BASIC_SCOPES,
      });
      multiActorJwt = await signJwt(privateKey, {
        sub: MULTI_ACTOR,
        scopes: RECRUITER_BASIC_SCOPES,
      });
      recA3Jwt = await signJwt(privateKey, {
        sub: REC_A3,
        scopes: RECRUITER_BASIC_SCOPES,
      });

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: false,
          transform: true,
        }),
      );
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;

      // Seed the world (TA does all writes).
      companyA = await createCompany(taJwt, 'D4b Client A');
      companyB = await createCompany(taJwt, 'D4b Client B');
      companyC = await createCompany(taJwt, 'D4b Client C');
      companyD = await createCompany(taJwt, 'D4b Client D');
      reqA = await createRequisition(taJwt, 'D4b Req on A', companyA);
      reqB = await createRequisition(taJwt, 'D4b Req on B', companyB);
      reqC = await createRequisition(taJwt, 'D4b Req on C', companyC);
      reqD = await createRequisition(taJwt, 'D4b Req on D', companyD);
      // A3-OR-arm probe — a req on B (NOT in REC_A3's visibility),
      // but REC_A3 will be directly assigned to it via RequisitionAssignment.
      reqA3only = await createRequisition(taJwt, 'D4b A3 Req on B', companyB);

      // RECRUITER_DIRECT — direct UserClientAssignment to A only.
      await assignUserToCompany(RECRUITER_DIRECT, companyA);

      // REC_MANAGER — owns 2 reports; reports are directly assigned to A + B.
      await setManagementEdge(REC_MANAGER, REC_REPORT_1);
      await setManagementEdge(REC_MANAGER, REC_REPORT_2);
      await assignUserToCompany(REC_REPORT_1, companyA);
      await assignUserToCompany(REC_REPORT_2, companyB);

      // ACCOUNT_MANAGER — owns a pod that owns A + C.
      const pod = await createPodWithOwnerAndMember(
        ACCOUNT_MANAGER,
        ACCOUNT_MANAGER,
        'D4b AM Pod',
      );
      await podOwnsCompany(pod, companyA);
      await podOwnsCompany(pod, companyC);

      // MULTI_ACTOR — has all 3 axes pointing at A / B / C respectively.
      await assignUserToCompany(MULTI_ACTOR, companyA);
      await setManagementEdge(MULTI_ACTOR, REC_REPORT_2); // gets B via report
      const multiPod = await createPodWithOwnerAndMember(
        MULTI_ACTOR,
        MULTI_ACTOR,
        'D4b Multi Pod',
      );
      await podOwnsCompany(multiPod, companyC);

      // REC_A3 — NO client assignments / pods / reports; but DIRECTLY
      // assigned to reqA3only (whose client is B, which REC_A3 cannot see
      // via the client axis). Proves the A3 OR-arm preservation.
      await assignReqDirectly(reqA3only, REC_A3);
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

    // ----------------------------------------------------------------------
    // Matrix row 1 — Recruiter (direct UserClientAssignment) — sees A; not B/C/D.
    // ----------------------------------------------------------------------
    it('matrix-1 — Recruiter (direct) sees A; does NOT see B/C/D (companies + requisitions)', async () => {
      const seenCos = await listCompanyIds(recruiterDirectJwt);
      expect(seenCos).toContain(companyA);
      expect(seenCos).not.toContain(companyB);
      expect(seenCos).not.toContain(companyC);
      expect(seenCos).not.toContain(companyD);

      expect((await getCompany(recruiterDirectJwt, companyA)).status).toBe(200);
      expect((await getCompany(recruiterDirectJwt, companyB)).status).toBe(404);

      const seenReqs = await listRequisitionIds(recruiterDirectJwt);
      expect(seenReqs).toContain(reqA);
      expect(seenReqs).not.toContain(reqB);
      expect(seenReqs).not.toContain(reqC);
      expect((await getRequisition(recruiterDirectJwt, reqA)).status).toBe(200);
      expect((await getRequisition(recruiterDirectJwt, reqB)).status).toBe(404);
    });

    // ----------------------------------------------------------------------
    // Matrix row 2 — Recruiting Manager (Axis-1, depth ≤ 3) — inherits A + B
    //                via reports; does NOT see C/D.
    // ----------------------------------------------------------------------
    it('matrix-2 — RM (Axis-1) inherits reports A+B; not C/D', async () => {
      const seenCos = await listCompanyIds(recManagerJwt);
      expect(seenCos).toContain(companyA);
      expect(seenCos).toContain(companyB);
      expect(seenCos).not.toContain(companyC);
      expect(seenCos).not.toContain(companyD);

      expect((await getCompany(recManagerJwt, companyB)).status).toBe(200);
      expect((await getCompany(recManagerJwt, companyC)).status).toBe(404);

      const seenReqs = await listRequisitionIds(recManagerJwt);
      expect(seenReqs).toContain(reqA);
      expect(seenReqs).toContain(reqB);
      expect(seenReqs).not.toContain(reqC);
    });

    // ----------------------------------------------------------------------
    // Matrix row 3 — Account Manager (Axis-2 pod) — sees A + C (pod); not B/D.
    // ----------------------------------------------------------------------
    it('matrix-3 — AM (Axis-2 pod) sees A+C via pod; not B/D', async () => {
      const seenCos = await listCompanyIds(accountManagerJwt);
      expect(seenCos).toContain(companyA);
      expect(seenCos).toContain(companyC);
      expect(seenCos).not.toContain(companyB);
      expect(seenCos).not.toContain(companyD);

      expect((await getCompany(accountManagerJwt, companyC)).status).toBe(200);
      expect((await getCompany(accountManagerJwt, companyB)).status).toBe(404);
    });

    // ----------------------------------------------------------------------
    // Matrix row 4 — Multi-axis (union) — sees A ∪ B ∪ C; not D.
    // ----------------------------------------------------------------------
    it('matrix-4 — multi-axis sees A∪B∪C (union, not intersection); not D', async () => {
      const seenCos = await listCompanyIds(multiActorJwt);
      expect(seenCos).toContain(companyA);
      expect(seenCos).toContain(companyB);
      expect(seenCos).toContain(companyC);
      expect(seenCos).not.toContain(companyD);

      expect((await getCompany(multiActorJwt, companyD)).status).toBe(404);
    });

    // ----------------------------------------------------------------------
    // Matrix row 5 — See-all TA (company:read:all + requisition:read:all).
    // ----------------------------------------------------------------------
    it('matrix-5 — TA (see-all) sees every company + req in tenant', async () => {
      const seenCos = await listCompanyIds(taJwt);
      expect(seenCos).toEqual(
        expect.arrayContaining([companyA, companyB, companyC, companyD]),
      );
      expect((await getCompany(taJwt, companyD)).status).toBe(200);

      const seenReqs = await listRequisitionIds(taJwt);
      expect(seenReqs).toEqual(
        expect.arrayContaining([reqA, reqB, reqC, reqD, reqA3only]),
      );
    });

    // ----------------------------------------------------------------------
    // Matrix row 6 — A3 preservation (load-bearing — the OR-arm).
    //                REC_A3 has NO client visibility but a direct
    //                RequisitionAssignment to reqA3only — must still see it.
    // ----------------------------------------------------------------------
    it('matrix-6 — A3 OR-arm preserved: direct-req-assignment overrides client invisibility', async () => {
      // No client visibility — sees no companies.
      const seenCos = await listCompanyIds(recA3Jwt);
      expect(seenCos).not.toContain(companyA);
      expect(seenCos).not.toContain(companyB);

      // BUT sees the directly-assigned requisition (the A3 OR arm).
      const seenReqs = await listRequisitionIds(recA3Jwt);
      expect(seenReqs).toContain(reqA3only);
      expect(seenReqs).not.toContain(reqA);
      expect(seenReqs).not.toContain(reqB);
      expect(seenReqs).not.toContain(reqC);
      expect((await getRequisition(recA3Jwt, reqA3only)).status).toBe(200);
      expect((await getRequisition(recA3Jwt, reqB)).status).toBe(404);
    });

    // ----------------------------------------------------------------------
    // Matrix row 7 — D4b + ?company_id filter compose (R3 carry close).
    //                AM has a pod for A + C. ?company_id=companyA narrows
    //                their visibility-resolved list to reqA (NOT reqC).
    //                ?company_id=companyB returns empty (B is outside the
    //                pod — the D4b OR-arm fails, A3 fails for AM here too,
    //                so the AND-with-company-filter naturally empties).
    // ----------------------------------------------------------------------
    it('matrix-7 — D4b + ?company_id compose: AM with pod A+C narrows to reqA at ?company_id=A; empty at ?company_id=B', async () => {
      const atA = await listRequisitionIdsByCompany(accountManagerJwt, companyA);
      expect(atA).toContain(reqA);
      expect(atA).not.toContain(reqB);
      expect(atA).not.toContain(reqC);
      expect(atA).not.toContain(reqD);

      const atC = await listRequisitionIdsByCompany(accountManagerJwt, companyC);
      expect(atC).toContain(reqC);
      expect(atC).not.toContain(reqA);

      // B is outside AM's pod → empty under filter (D4b OR-arm fails for
      // companyB; AM has no A3 assignment).
      const atB = await listRequisitionIdsByCompany(accountManagerJwt, companyB);
      expect(atB).toEqual([]);
    });

    // ----------------------------------------------------------------------
    // Matrix row 8 — A3 OR-arm SURVIVES the ?company_id filter
    //                (security-critical — the filter must never SUPPRESS
    //                the A3 branch within visibility). REC_A3 has no
    //                client-axis visibility, but a direct RequisitionAssignment
    //                to reqA3only (which lives at companyB).
    //                ?company_id=companyB → still returns reqA3only
    //                (the A3 OR-arm matches; the top-level company_id
    //                also matches → AND is TRUE).
    //                ?company_id=companyA → empty (no assignment at A;
    //                no D4b for A) — the filter NARROWS within visibility.
    // ----------------------------------------------------------------------
    it('matrix-8 — A3 OR-arm preserved under ?company_id filter: REC_A3 sees reqA3only at ?company_id=B', async () => {
      const atB = await listRequisitionIdsByCompany(recA3Jwt, companyB);
      expect(atB).toContain(reqA3only);
      expect(atB).not.toContain(reqB); // REC_A3 not assigned to reqB

      // The filter narrows: REC_A3 sees nothing at companyA (no A3 + no D4b).
      const atA = await listRequisitionIdsByCompany(recA3Jwt, companyA);
      expect(atA).toEqual([]);
    });
  },
);
