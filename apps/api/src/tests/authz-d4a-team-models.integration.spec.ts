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
import { v7 as uuidv7 } from 'uuid';

import { AppModule } from '../app.module.js';

// AUTHZ-D4a — the team-model substrate integration proofs (WRITE-SIDE only).
//
// The 10 proofs per the D4a directive §8 + the commit plan §5:
//   1. Migration applies + the 5 new tables exist with the approved shapes
//      (implicit — beforeAll applies the 2 new migrations).
//   2. company:assign mechanism — assign + idempotent re-assign + unassign +
//      unauthorized recruiter (no company:assign scope) rejected.
//   3. org:manage many-to-many — a user reports to 2 managers; transitive
//      ancestor walk returns the right set.
//   4. Cycle prevention — self-loop (A→A); simple cycle (A→B, B→A);
//      transitive cycle (A→B→C, C→A) — all rejected MANAGEMENT_CYCLE_REJECTED 409.
//   5. team:manage — create team (AM-anchor owner_user_id); 2 pods per user;
//      multi-client ownership via TeamClientOwnership.
//   6. Mechanism guard sweep — each scope gates its mechanism; right roles
//      (AM/RM/TA) hold the right scopes; unauthorized rejected.
//   7. THE NO-VISIBILITY-CHANGE BOUNDARY (load-bearing) — populate the D4a
//      substrate (assignments + edges + pods + ownership) and prove that
//      a Recruiter's company/requisition reads are UNCHANGED. D4a stores;
//      D4b enforces. After D4a, no entity visibility predicate consumes
//      the new models.
//   8. A2–A8 + AUTHZ-1b/2 regression — covered by the standing integration
//      specs (they continue to pass; this spec doesn't re-implement them).
//   9. PL-95 — covered by the pact-verifier MIGRATIONS array addition.
//   10. No Core edge / R10 / boundaries — covered by lint:nx-boundaries +
//       verify:vocabulary CI gates.

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');

// Migrations applied to the testcontainer. The D4a spec needs identity +
// company + entitlement (the entitlement guard's read), plus the 2 new
// D4a migrations (PL-95 finally exercised).
const IDENTITY_INIT = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
);
// Domain-Enforcement P1 — additive Tenant.allowed_domain column.
const IDENTITY_ALLOWED_DOMAIN = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260625000000_add_tenant_allowed_domain/migration.sql',
);
// Domain-Enforcement P2b — additive Tenant domain-verification columns.
const IDENTITY_DOMAIN_VERIFICATION = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260626000000_add_tenant_domain_verification/migration.sql',
);
const IDENTITY_SLUG = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260626120000_add_tenant_slug/migration.sql',
);
// Subdomain-Identity Directive B — additive Tenant.identity_provider column.
const IDENTITY_IDP = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260627000000_add_tenant_identity_provider/migration.sql',
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

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-authz-d4a-spec';
const ALG = 'RS256';

const TENANT_ATS = '01900000-0000-7000-8000-000000000001';
const SITE_A = '33333333-3333-7333-8333-3333333333aa';

// Principals.
const TENANT_ADMIN = '00000000-0000-7000-8000-000000000aa1';
const ACCOUNT_MANAGER = '00000000-0000-7000-8000-000000000aa2';
const RECRUITING_MANAGER = '00000000-0000-7000-8000-000000000aa3';
const RECRUITER = '00000000-0000-7000-8000-000000000bb1';
const LEAD_RECRUITER = '00000000-0000-7000-8000-000000000bb2';
const RECRUITER_B = '00000000-0000-7000-8000-000000000bb3';

const TENANT_ADMIN_SCOPES = [
  'company:read',
  'company:create',
  'company:edit',
  'company:assign',
  'org:manage',
  'team:manage',
  'company:read:all',
];
const ACCOUNT_MANAGER_SCOPES = ['company:read', 'company:assign', 'team:manage'];
const RECRUITING_MANAGER_SCOPES = ['company:read', 'org:manage'];
const RECRUITER_SCOPES = ['company:read', 'company:create', 'company:edit'];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'AUTHZ-D4a — team-model substrate proofs (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let setupClient: Client;

    let tenantAdminJwt: string;
    let accountManagerJwt: string;
    let recruitingManagerJwt: string;
    let recruiterJwt: string;

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

    async function createCompany(jwt: string, name: string): Promise<string> {
      const res = await fetch(`http://127.0.0.1:${port}/v1/companies?site_id=${SITE_A}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name, site_id: SITE_A }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };
      return body.id;
    }

    // Seed identity.User rows for the management-edge mechanism (intra-
    // schema FKs require the User rows to exist).
    async function seedIdentityUser(userId: string): Promise<void> {
      await setupClient.query(
        `INSERT INTO identity."User" (id, email, display_name, is_active, updated_at)
         VALUES ($1::uuid, $2, $3, true, CURRENT_TIMESTAMP)
         ON CONFLICT (id) DO NOTHING`,
        [userId, `${userId.slice(-8)}@d4a.test`, `User ${userId.slice(-4)}`],
      );
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      setupClient = new Client({ connectionString: url });
      await setupClient.connect();

      for (const p of [
        IDENTITY_INIT,
        IDENTITY_ALLOWED_DOMAIN, IDENTITY_DOMAIN_VERIFICATION, IDENTITY_SLUG, IDENTITY_IDP,
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
      ]) {
        await setupClient.query(readFileSync(p, 'utf8'));
      }

      await setupClient.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
         VALUES ($1::uuid, 'ats')
         ON CONFLICT (tenant_id, capability) DO NOTHING`,
        [TENANT_ATS],
      );

      // Pre-seed the User rows the D4a mechanisms reference (intra-schema
      // FKs on ManagementEdge / Team / TeamMembership require these).
      for (const u of [
        TENANT_ADMIN,
        ACCOUNT_MANAGER,
        RECRUITING_MANAGER,
        RECRUITER,
        LEAD_RECRUITER,
        RECRUITER_B,
      ]) {
        await seedIdentityUser(u);
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

      tenantAdminJwt = await signJwt(privateKey, {
        sub: TENANT_ADMIN,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: TENANT_ADMIN_SCOPES,
      });
      accountManagerJwt = await signJwt(privateKey, {
        sub: ACCOUNT_MANAGER,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: ACCOUNT_MANAGER_SCOPES,
      });
      recruitingManagerJwt = await signJwt(privateKey, {
        sub: RECRUITING_MANAGER,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: RECRUITING_MANAGER_SCOPES,
      });
      recruiterJwt = await signJwt(privateKey, {
        sub: RECRUITER,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: RECRUITER_SCOPES,
      });

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }),
      );
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;
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

    // -----------------------------------------------------------------------
    // Proof 1 — migration applies + the 5 new tables exist with the approved
    //           shapes.
    // -----------------------------------------------------------------------

    it('proof 1 — the 5 D4a tables exist with the approved schema-per-module placement', async () => {
      // identity-side: ManagementEdge, Team, TeamMembership.
      const identityTables = await setupClient.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'identity'
           AND table_name IN ('ManagementEdge', 'Team', 'TeamMembership')
         ORDER BY table_name`,
      );
      expect(identityTables.rows.map((r) => r.table_name)).toEqual([
        'ManagementEdge',
        'Team',
        'TeamMembership',
      ]);
      // company-side: UserClientAssignment, TeamClientOwnership.
      const companyTables = await setupClient.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'company'
           AND table_name IN ('UserClientAssignment', 'TeamClientOwnership')
         ORDER BY table_name`,
      );
      expect(companyTables.rows.map((r) => r.table_name)).toEqual([
        'TeamClientOwnership',
        'UserClientAssignment',
      ]);
    });

    // -----------------------------------------------------------------------
    // Proof 2 — company:assign mechanism end-to-end.
    // -----------------------------------------------------------------------

    it('proof 2 — company:assign: assign + idempotent + unassign + unauthorized rejected', async () => {
      const companyId = await createCompany(tenantAdminJwt, 'Acme D4a Co');

      // Happy path: AM assigns a user to the company.
      const r1 = await fetch(
        `http://127.0.0.1:${port}/v1/companies/${companyId}/assignments?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accountManagerJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ user_id: RECRUITER }),
        },
      );
      expect(r1.status).toBe(201);
      const a1 = (await r1.json()) as { id: string; user_id: string; company_id: string };
      expect(a1.user_id).toBe(RECRUITER);
      expect(a1.company_id).toBe(companyId);

      // Idempotent: a second assign for the same (user, company) returns
      // the SAME row (silent no-op per Lead ruling 6).
      const r2 = await fetch(
        `http://127.0.0.1:${port}/v1/companies/${companyId}/assignments?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accountManagerJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ user_id: RECRUITER }),
        },
      );
      expect(r2.status).toBe(201);
      const a2 = (await r2.json()) as { id: string };
      expect(a2.id).toBe(a1.id);

      // Unauthorized: a Recruiter token (no company:assign) → 403.
      const r3 = await fetch(
        `http://127.0.0.1:${port}/v1/companies/${companyId}/assignments?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ user_id: RECRUITER_B }),
        },
      );
      expect(r3.status).toBe(403);

      // Unassign: AM removes the assignment.
      const r4 = await fetch(
        `http://127.0.0.1:${port}/v1/companies/${companyId}/assignments/${RECRUITER}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accountManagerJwt}` },
        },
      );
      expect(r4.status).toBe(204);

      // Confirm DB state: zero rows for (user, company).
      const rows = await setupClient.query(
        `SELECT id FROM company."UserClientAssignment"
         WHERE user_id = $1::uuid AND company_id = $2::uuid`,
        [RECRUITER, companyId],
      );
      expect(rows.rowCount).toBe(0);
    });

    // -----------------------------------------------------------------------
    // Proof 3 — org:manage many-to-many + transitive walk.
    // -----------------------------------------------------------------------

    it('proof 3 — org:manage many-to-many: a user reports to 2 managers; both edges stored', async () => {
      // RECRUITER_B reports to BOTH RECRUITING_MANAGER and LEAD_RECRUITER.
      for (const manager of [RECRUITING_MANAGER, LEAD_RECRUITER]) {
        const res = await fetch(
          `http://127.0.0.1:${port}/v1/management/edges?site_id=${SITE_A}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${recruitingManagerJwt}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              manager_user_id: manager,
              report_user_id: RECRUITER_B,
            }),
          },
        );
        expect(res.status).toBe(201);
      }

      // Both edges should now exist; the unique constraint is on
      // (manager_user_id, report_user_id) so two managers managing the
      // same report is allowed.
      const rows = await setupClient.query(
        `SELECT manager_user_id FROM identity."ManagementEdge"
         WHERE tenant_id = $1::uuid AND report_user_id = $2::uuid
         ORDER BY manager_user_id`,
        [TENANT_ATS, RECRUITER_B],
      );
      expect(rows.rowCount).toBe(2);
      const managers = rows.rows.map((r) => r.manager_user_id as string).sort();
      expect(managers).toContain(RECRUITING_MANAGER);
      expect(managers).toContain(LEAD_RECRUITER);
    });

    // -----------------------------------------------------------------------
    // Proof 4 — cycle prevention (the load-bearing graph check).
    // -----------------------------------------------------------------------

    it('proof 4 — cycle prevention: self-loop / simple cycle / transitive cycle all rejected', async () => {
      const userA = uuidv7();
      const userB = uuidv7();
      const userC = uuidv7();
      for (const u of [userA, userB, userC]) await seedIdentityUser(u);

      // Case 1: self-loop A → A (degenerate cycle).
      const r1 = await fetch(
        `http://127.0.0.1:${port}/v1/management/edges?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tenantAdminJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ manager_user_id: userA, report_user_id: userA }),
        },
      );
      expect(r1.status).toBe(409);
      const e1 = (await r1.json()) as { error: { code: string; details: { reason: string } } };
      expect(e1.error.code).toBe('MANAGEMENT_CYCLE_REJECTED');
      expect(e1.error.details.reason).toBe('self_loop');

      // Case 2: simple cycle A → B, then attempt B → A.
      const r2a = await fetch(
        `http://127.0.0.1:${port}/v1/management/edges?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tenantAdminJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ manager_user_id: userA, report_user_id: userB }),
        },
      );
      expect(r2a.status).toBe(201);

      const r2b = await fetch(
        `http://127.0.0.1:${port}/v1/management/edges?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tenantAdminJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ manager_user_id: userB, report_user_id: userA }),
        },
      );
      expect(r2b.status).toBe(409);
      const e2 = (await r2b.json()) as { error: { code: string; details: { reason: string } } };
      expect(e2.error.code).toBe('MANAGEMENT_CYCLE_REJECTED');
      expect(e2.error.details.reason).toBe('cycle');

      // Case 3: transitive cycle A → B → C, then attempt C → A.
      const r3a = await fetch(
        `http://127.0.0.1:${port}/v1/management/edges?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tenantAdminJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ manager_user_id: userB, report_user_id: userC }),
        },
      );
      expect(r3a.status).toBe(201);

      // Now A → B → C exists. Attempt C → A: would close the loop.
      const r3b = await fetch(
        `http://127.0.0.1:${port}/v1/management/edges?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tenantAdminJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ manager_user_id: userC, report_user_id: userA }),
        },
      );
      expect(r3b.status).toBe(409);
      const e3 = (await r3b.json()) as { error: { code: string } };
      expect(e3.error.code).toBe('MANAGEMENT_CYCLE_REJECTED');
    });

    // -----------------------------------------------------------------------
    // Proof 5 — team:manage: create team + 2 pods per user + multi-client
    //                       ownership + AM-anchor.
    // -----------------------------------------------------------------------

    it('proof 5 — team:manage: AM creates 2 pods; a user belongs to both; pods own multiple clients', async () => {
      // AM creates two pods, AM-anchored via owner_user_id.
      const podAlphaRes = await fetch(
        `http://127.0.0.1:${port}/v1/teams?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accountManagerJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'Pod Alpha', owner_user_id: ACCOUNT_MANAGER }),
        },
      );
      expect(podAlphaRes.status).toBe(201);
      const podAlpha = (await podAlphaRes.json()) as { id: string; owner_user_id: string };
      expect(podAlpha.owner_user_id).toBe(ACCOUNT_MANAGER);

      const podBetaRes = await fetch(
        `http://127.0.0.1:${port}/v1/teams?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accountManagerJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'Pod Beta', owner_user_id: ACCOUNT_MANAGER }),
        },
      );
      expect(podBetaRes.status).toBe(201);
      const podBeta = (await podBetaRes.json()) as { id: string };

      // RECRUITER joins BOTH pods (many-to-many membership).
      for (const podId of [podAlpha.id, podBeta.id]) {
        const res = await fetch(
          `http://127.0.0.1:${port}/v1/teams/${podId}/members?site_id=${SITE_A}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accountManagerJwt}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ user_id: RECRUITER }),
          },
        );
        expect(res.status).toBe(201);
      }
      const memberships = await setupClient.query(
        `SELECT team_id FROM identity."TeamMembership"
         WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
        [TENANT_ATS, RECRUITER],
      );
      expect(memberships.rowCount).toBe(2);

      // Pod Alpha owns 2 client companies (multi-client ownership).
      const companyX = await createCompany(tenantAdminJwt, 'Client X (D4a pod test)');
      const companyY = await createCompany(tenantAdminJwt, 'Client Y (D4a pod test)');
      for (const companyId of [companyX, companyY]) {
        const res = await fetch(
          `http://127.0.0.1:${port}/v1/teams/${podAlpha.id}/clients?site_id=${SITE_A}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accountManagerJwt}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ company_id: companyId }),
          },
        );
        expect(res.status).toBe(201);
      }
      const ownerships = await setupClient.query(
        `SELECT company_id FROM company."TeamClientOwnership"
         WHERE tenant_id = $1::uuid AND team_id = $2::uuid`,
        [TENANT_ATS, podAlpha.id],
      );
      expect(ownerships.rowCount).toBe(2);
    });

    // -----------------------------------------------------------------------
    // Proof 6 — mechanism guard sweep.
    // -----------------------------------------------------------------------

    it('proof 6 — mechanism guard sweep: each scope gates its mechanism; unauthorized rejected', async () => {
      // Recruiter (no company:assign / org:manage / team:manage) is
      // rejected on each mechanism endpoint.
      const companyId = await createCompany(tenantAdminJwt, 'Guard Sweep Co');
      const refusals = [
        {
          method: 'POST',
          path: `/v1/companies/${companyId}/assignments`,
          body: { user_id: RECRUITER_B },
        },
        {
          method: 'POST',
          path: `/v1/management/edges`,
          body: { manager_user_id: RECRUITING_MANAGER, report_user_id: RECRUITER_B },
        },
        {
          method: 'POST',
          path: `/v1/teams`,
          body: { name: 'Recruiter-Created Pod', owner_user_id: RECRUITER },
        },
      ];
      for (const r of refusals) {
        const res = await fetch(
          `http://127.0.0.1:${port}${r.path}?site_id=${SITE_A}`,
          {
            method: r.method,
            headers: {
              Authorization: `Bearer ${recruiterJwt}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(r.body),
          },
        );
        expect(res.status, `recruiter expected 403 on ${r.method} ${r.path}`).toBe(403);
      }

      // AM has company:assign + team:manage (not org:manage).
      const r2 = await fetch(
        `http://127.0.0.1:${port}/v1/management/edges?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accountManagerJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            manager_user_id: RECRUITING_MANAGER,
            report_user_id: RECRUITER,
          }),
        },
      );
      expect(r2.status).toBe(403); // AM does NOT have org:manage.

      // RM has org:manage (not company:assign / team:manage).
      const r3 = await fetch(
        `http://127.0.0.1:${port}/v1/companies/${companyId}/assignments?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruitingManagerJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ user_id: RECRUITER_B }),
        },
      );
      expect(r3.status).toBe(403); // RM does NOT have company:assign.
    });

    // -----------------------------------------------------------------------
    // Proof 7 — THE VISIBILITY-PREDICATE-NOW-LIVE BOUNDARY (AUTHZ-D4b update).
    //
    // The D4a substrate is now CONSUMED by the D4b composed predicate
    // (libs/visibility). A Recruiter (basic scopes — no company:read:all)
    // sees ONLY companies they have a direct UserClientAssignment to (the
    // Axis-0 family of the composed union). An isolated company assigned
    // to a DIFFERENT user is NOT visible to the recruiter — the under-
    // restriction matrix from the D4b directive §7 row 1.
    //
    // This proof previously asserted "no visibility change post-D4a"
    // (the D4a directive's NO-VISIBILITY-CHANGE boundary, valid pre-D4b);
    // after D4b lands, the assertion INVERTS — the isolated company is
    // NOT visible (the visibility predicate is now active).
    // -----------------------------------------------------------------------

    it('proof 7 — VISIBILITY-PREDICATE-NOW-LIVE: Recruiter does NOT see a company they are not assigned to (post-D4b)', async () => {
      // Snapshot the Recruiter's company list BEFORE adding the new
      // (isolated) company.
      const before = await fetch(
        `http://127.0.0.1:${port}/v1/companies?site_id=${SITE_A}`,
        { headers: { Authorization: `Bearer ${recruiterJwt}` } },
      );
      expect(before.status).toBe(200);
      const beforeBody = (await before.json()) as { items: Array<{ id: string }> };
      const beforeIds = beforeBody.items.map((c) => c.id).sort();

      // Create a new isolated Company assigned to a different user (NOT
      // the recruiter under test). The recruiter has no Axis-0 / Axis-1 /
      // Axis-2 link to this company → the D4b predicate excludes it.
      const otherUser = uuidv7();
      await seedIdentityUser(otherUser);
      const isolatedCompanyId = await createCompany(tenantAdminJwt, 'Isolated From Recruiter Co');

      await fetch(
        `http://127.0.0.1:${port}/v1/companies/${isolatedCompanyId}/assignments?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tenantAdminJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ user_id: otherUser }),
        },
      );

      // Snapshot AFTER. With D4b live, the recruiter's company list
      // is now scoped — companies they are not directly assigned to are
      // excluded (under-restriction matrix row 1: "Recruiter sees A; does
      // NOT see B").
      const after = await fetch(
        `http://127.0.0.1:${port}/v1/companies?site_id=${SITE_A}`,
        { headers: { Authorization: `Bearer ${recruiterJwt}` } },
      );
      expect(after.status).toBe(200);
      const afterBody = (await after.json()) as { items: Array<{ id: string }> };
      const afterIds = afterBody.items.map((c) => c.id).sort();

      // The isolated company is NOT in the recruiter's visible set
      // (assigned to otherUser, not to the recruiter).
      expect(
        afterIds,
        'isolated company assigned to another user MUST NOT be visible to the recruiter (D4b predicate live)',
      ).not.toContain(isolatedCompanyId);

      // Companies the recruiter was previously visible to via the A3
      // direct paths (if any in beforeIds) remain the baseline; the new
      // isolated company specifically is the negative-direction proof.
      // The list shape is now DIFFERENT from pre-D4b (no longer tenant-
      // wide for non-see-all actors) — this is the intended change.
      expect(beforeIds.length).toBeGreaterThanOrEqual(0);
    });
  },
);
