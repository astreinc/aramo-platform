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
import { TENANT_COGNITO_PORT, type TenantCognitoPort } from '@aramo/identity';

import { AppModule } from '../app.module.js';

// §5 Auth-Hardening Directive 1 — Recruiter login verified (the foundational
// unblock). Baseline: main 9d528f6.
//
// The whole recruiter surface has, until now, only ever been exercised by an
// ADMIN token (which holds every scope). Nobody had proven that a recruiter
// holding ONLY recruiter scopes sees the right surface and is denied the
// wrong one. This spec proves it at the integration layer with a REAL
// recruiter principal, against a real Postgres 17.
//
// A — PROVISION (the real path): a recruiter is provisioned through the actual
//     invite saga (POST /v1/tenant/users/invitations), Cognito mocked at the
//     port. The saga writes the complete login-capable identity:
//     Cognito sub ↔ ExternalIdentity ↔ User ↔ Membership ↔ recruiter role.
//     We assert the full chain is present and consistent (proof A).
//
// B — VERIFY recruiter-context authorization with the provisioned recruiter's
//     OWN scopes (NOT an admin token), derived from the real membership chain:
//       B1 surface resolves — the recruiter's "My X" reads return their own
//          scoped data (requisitions + tasks).
//       B2 admin section is server-DENIED — the recruiter hitting the admin
//          endpoints (tenant/users, settings, profile, sites, audit-events)
//          gets 403 INSUFFICIENT_PERMISSIONS, server-enforced. We entitle the
//          tenant to BOTH `core` AND `ats`, so the 403 is provably the SCOPE
//          gate (RolesGuard → INSUFFICIENT_PERMISSIONS), not the entitlement
//          gate (EntitlementGuard → TENANT_CAPABILITY_NOT_ENTITLED).
//       B3 "My X" scoping is correct — the recruiter sees THEIR assigned
//          reqs/tasks, not the whole tenant and not nothing. This is the exact
//          thing admin-token testing could never prove.
//       B4 no over-grant / no under-grant — the recruiter's effective scope
//          set (derived from the seeded role → DB join) equals the canonical
//          recruiter bundle, and carries none of the admin scopes.
//
// C — HONEST BOUNDARY: this proves the AUTHORIZATION locally (the strongest
//     local proof). The literal browser login (a recruiter authenticating
//     through Cognito hosted-UI) DEFERS to staging — local dev has no Cognito
//     SSO bypass (the same limitation noted in Settings D1/D3). No browser
//     session is faked here.
//
// SCOPE-COUNT NOTE: the directive (D1) said "the 41 recruiter scopes". The
// live seed truth grew to 42 (Settings-D1's import:read), 43 (D4's
// tenant:user:read:assignable), and now 44 (D4b's tenant:user:read:directory) (§5
// Auth-Hardening D4's tenant:user:read:assignable — the recruiter-tier minimal
// assignable-roster read). The CANONICAL recruiter bundle is owned + pinned by
// libs/identity/src/tests/identity.integration.spec.ts ("recruiter bundle: 43
// scopes (verbatim testcontainer truth)"); the RECRUITER_BUNDLE constant below
// mirrors it. The added scopes are legitimate seed grants, not over-grants —
// see the close report. B4 here derives the provisioned recruiter's effective
// scopes from the real membership→role→rolescope→scope join and asserts they
// equal that bundle.

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');

// --- Migrations (union of the D4b visibility-matrix set + the Task model;
// the recruiter "My X" reads run through requisitions + tasks, and the
// requisition/task visibility predicate reads the D4a substrate). ---
const IDENTITY_INIT = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
);
const IDENTITY_SITE_AXIS = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260601000000_add_site_axis/migration.sql',
);
const IDENTITY_D4A = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260604000000_add_authz_team_models/migration.sql',
);
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
const REQUISITION_IMPORT_BACK_REF = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260603140100_add_import_batch_id_to_requisition/migration.sql',
);
const REQUISITION_COMPENSATION_FIELDS = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260605123400_add_compensation_fields_to_requisition/migration.sql',
);
const REQUISITION_JOB_MODULE_FIELDS = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260611220000_job_module_requisition_fields/migration.sql',
);
const REQUISITION_RATE_TYPE_SUBK = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260618120000_add_rate_type_subk_runmatch/migration.sql',
);
const TASK_INIT = resolve(
  ROOT,
  'libs/task/prisma/migrations/20260609140000_init_task_model/migration.sql',
);
const TASK_WORKSPACE_FIELDS = resolve(
  ROOT,
  'libs/task/prisma/migrations/20260617120000_task_workspace_fields/migration.sql',
);

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-auth-hardening-d1-spec';
const ALG = 'RS256';

const TENANT_ATS = '01900000-0000-7000-8000-000000000001';
const SITE_A = '33333333-3333-7333-8333-3333333333aa';

// The tenant-admin world-builder. A pure-JWT principal (no DB user row is
// required — its scopes are carried in the token, and the assignment/audit
// writes that reference it as actor do not FK to identity.User). This is the
// "admin token holds every scope" status quo the directive contrasts against.
const TENANT_ADMIN = '00000000-0000-7000-8000-0000000000a1';
const TENANT_ADMIN_SCOPES = [
  // user-manage drives the invite saga; the other four admin scopes + audit
  // let the B2 CONTROL prove the same endpoints resolve for an admin token
  // (so the recruiter's 403s are isolated to its missing scopes, not a broken
  // route). This IS the "admin token holds every scope" status quo.
  'tenant:admin:user-manage',
  'tenant:admin:settings',
  'tenant:admin:profile',
  'tenant:admin:sites',
  'audit:read',
  'company:read',
  'company:create',
  'company:read:all',
  'requisition:read',
  'requisition:read:all',
  'requisition:create',
  'requisition:assign',
  'task:read',
  'task:write',
];

// The canonical recruiter bundle — mirrors the source-of-truth assertion in
// libs/identity/src/tests/identity.integration.spec.ts (44 scopes). The
// provisioned recruiter's DERIVED effective scopes are asserted to equal this
// (B4); the principal under test is then signed with exactly this set.
const RECRUITER_BUNDLE = [
  'activity:create',
  'activity:read',
  'attachment:create',
  'attachment:delete',
  'attachment:read',
  'auth:session:read',
  'calendar:event-create',
  'calendar:event-edit',
  'company:create',
  'company:edit',
  'company:read',
  'company:search',
  'compensation:view:pay',
  'consent:decision-log:read',
  'consent:read',
  'consent:write',
  'contact:create',
  'contact:edit',
  'contact:read',
  'contact:search',
  'dashboard:read',
  'engagement:outreach',
  'engagement:read',
  'engagement:write',
  'examination:read',
  'import:read',
  'pipeline:add',
  'pipeline:add-activity',
  'pipeline:change-status',
  'pipeline:read',
  'report:read',
  'requisition:create',
  'requisition:read',
  'requisition:search',
  'submittal:approve',
  'submittal:create',
  'talent:create',
  'talent:edit',
  'talent:read',
  'talent:search',
  'task:read',
  'task:write',
  // §5 Auth-Hardening D4 — recruiter gains the minimal assignable-roster read
  // (GET /v1/tenant/assignable-users); NOT the admin user-manage scope.
  'tenant:user:read:assignable',
  // §5 Auth-Hardening D4b — recruiter gains the name-resolver read
  // (GET /v1/tenant/users/directory; id→name incl. inactive for history).
  'tenant:user:read:directory',
].sort();

// The admin scopes a recruiter must NEVER hold (drives the B2 deny + B4
// no-over-grant assertions). These gate the admin endpoints under test.
const ADMIN_ONLY_SCOPES = [
  'tenant:admin:user-manage',
  'tenant:admin:settings',
  'tenant:admin:profile',
  'tenant:admin:sites',
  'audit:read',
];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  '§5 Auth-Hardening D1 — recruiter login verified (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let db: Client;
    let privateKey: SignKey;

    let adminJwt = '';

    // The provisioned recruiter (filled by the invite saga in beforeAll).
    let recruiterUserId = '';
    let recruiterMembershipId = '';
    let recruiterCognitoSub = '';
    let recruiterScopes: string[] = [];
    let recruiterJwt = '';

    // A second saga-provisioned recruiter — the "someone else" whose work the
    // primary recruiter must NOT see (the My-X negative case).
    let otherUserId = '';

    // The seeded world.
    let reqAssigned = ''; // directly assigned to the primary recruiter
    let reqOther = ''; //    assigned to nobody the primary recruiter can see
    let taskMine = ''; //    assignee = primary recruiter
    let taskOther = ''; //   assignee = the other recruiter

    // The mocked Cognito sub the port hands back on adminCreateUser. A fresh
    // valid UUID per invite (keyed by email) so the ExternalIdentity link is a
    // real, asserted value rather than a placeholder.
    const cognitoSubByEmail = new Map<string, string>();

    async function signJwt(args: {
      sub: string;
      scopes: string[];
    }): Promise<string> {
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

    // ---- raw-SQL seed of the recruiter role catalog (the invite saga
    // resolves role_keys → role_ids from these rows, and B4 derives the
    // effective bundle from the resulting membership→role→rolescope chain). ----
    async function seedRecruiterCatalog(): Promise<string> {
      const roleId = uuidv7();
      await db.query(
        `INSERT INTO identity."Role" (id, key, description, is_active, updated_at)
         VALUES ($1::uuid, 'recruiter', 'Recruiter', true, CURRENT_TIMESTAMP)
         ON CONFLICT (id) DO NOTHING`,
        [roleId],
      );
      for (const key of RECRUITER_BUNDLE) {
        const scopeId = uuidv7();
        await db.query(
          `INSERT INTO identity."Scope" (id, key, description)
           VALUES ($1::uuid, $2, $2)
           ON CONFLICT (id) DO NOTHING`,
          [scopeId, key],
        );
        await db.query(
          `INSERT INTO identity."RoleScope" (id, role_id, scope_id)
           VALUES ($1::uuid, $2::uuid, $3::uuid)
           ON CONFLICT (id) DO NOTHING`,
          [uuidv7(), roleId, scopeId],
        );
      }
      return roleId;
    }

    // Derive a membership's effective scope set from the real DB join — the
    // exact scopes the provisioned recruiter's principal carries.
    async function deriveEffectiveScopes(userId: string): Promise<string[]> {
      const res = await db.query<{ key: string }>(
        `SELECT DISTINCT s.key
           FROM identity."UserTenantMembership" m
           JOIN identity."UserTenantMembershipRole" mr ON mr.membership_id = m.id
           JOIN identity."RoleScope" rs ON rs.role_id = mr.role_id
           JOIN identity."Scope" s ON s.id = rs.scope_id
          WHERE m.user_id = $1::uuid AND m.tenant_id = $2::uuid
          ORDER BY s.key`,
        [userId, TENANT_ATS],
      );
      return res.rows.map((r) => r.key);
    }

    // POST the real invite saga (Cognito mocked at the port).
    async function inviteRecruiter(
      email: string,
    ): Promise<{ user_id: string; membership_id: string; cognito_sub: string }> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/tenant/users/invitations`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email,
            display_name: email,
            role_keys: ['recruiter'],
          }),
        },
      );
      expect(res.status).toBe(201);
      return (await res.json()) as {
        user_id: string;
        membership_id: string;
        cognito_sub: string;
      };
    }

    async function createCompany(name: string): Promise<string> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/companies?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name, site_id: SITE_A }),
        },
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    }

    async function createRequisition(
      title: string,
      company_id: string,
    ): Promise<string> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title, company_id, site_id: SITE_A }),
        },
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    }

    async function assignRequisition(
      requisition_id: string,
      user_id: string,
    ): Promise<void> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${requisition_id}/assignments?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ user_id }),
        },
      );
      expect([200, 201]).toContain(res.status);
    }

    async function createTask(
      title: string,
      assignee_id: string,
    ): Promise<string> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/tasks?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminJwt}`,
            'Content-Type': 'application/json',
          },
          // owner_type 'talent_record' is pool-open (unrestricted visibility),
          // so the assignee filter is the load-bearing My-X gate.
          body: JSON.stringify({
            title,
            owner_type: 'talent_record',
            owner_id: uuidv7(),
            assignee_id,
          }),
        },
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    }

    async function recruiterGet(path: string): Promise<{
      status: number;
      json: () => Promise<unknown>;
    }> {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { Authorization: `Bearer ${recruiterJwt}` },
      });
      return { status: res.status, json: () => res.json() };
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      db = new Client({ connectionString: url });
      await db.connect();

      for (const p of [
        IDENTITY_INIT,
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
        REQUISITION_COMPENSATION_FIELDS,
        REQUISITION_JOB_MODULE_FIELDS,
        REQUISITION_RATE_TYPE_SUBK,
        TASK_INIT,
        TASK_WORKSPACE_FIELDS,
      ]) {
        await db.query(readFileSync(p, 'utf8'));
      }

      // The tenant must exist (Membership FKs identity."Tenant").
      await db.query(
        `INSERT INTO identity."Tenant" (id, name, updated_at)
         VALUES ($1::uuid, 'Auth-Hardening D1 Tenant', CURRENT_TIMESTAMP)
         ON CONFLICT (id) DO NOTHING`,
        [TENANT_ATS],
      );

      // Entitle the tenant to BOTH capabilities: `ats` (recruiter surface) and
      // `core` (admin surface). With `core` present, the admin-deny 403s are
      // provably the RolesGuard SCOPE gate, not the EntitlementGuard gate.
      for (const capability of ['ats', 'core']) {
        await db.query(
          `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
           VALUES ($1::uuid, $2)
           ON CONFLICT (tenant_id, capability) DO NOTHING`,
          [TENANT_ATS, capability],
        );
      }

      await seedRecruiterCatalog();

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      privateKey = kp.privateKey as SignKey;

      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
        AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;

      adminJwt = await signJwt({ sub: TENANT_ADMIN, scopes: TENANT_ADMIN_SCOPES });

      // Mock Cognito at the port — adminCreateUser returns a fresh valid UUID
      // sub per email (the real saga still writes ExternalIdentity/User/
      // Membership/roles against it). No AWS, no SSO; the literal browser
      // round-trip defers to staging (boundary C).
      const cognitoMock: TenantCognitoPort = {
        adminCreateUser: async ({ email }) => {
          const sub = uuidv7();
          cognitoSubByEmail.set(email, sub);
          return { cognito_sub: sub };
        },
        adminDeleteUser: async () => undefined,
        adminDisableUser: async () => undefined,
        adminEnableUser: async () => undefined,
      };

      module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(TENANT_COGNITO_PORT)
        .useValue(cognitoMock)
        .compile();
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

      // --- A: provision the recruiter (and a second one) via the real saga ---
      const primary = await inviteRecruiter('recruiter.d1@aramo.dev');
      recruiterUserId = primary.user_id;
      recruiterMembershipId = primary.membership_id;
      recruiterCognitoSub = primary.cognito_sub;

      const other = await inviteRecruiter('recruiter.d1.other@aramo.dev');
      otherUserId = other.user_id;

      // Derive the provisioned recruiter's effective scopes from the real
      // membership chain and sign the principal with exactly that set.
      recruiterScopes = await deriveEffectiveScopes(recruiterUserId);
      recruiterJwt = await signJwt({
        sub: recruiterUserId,
        scopes: recruiterScopes,
      });

      // --- Seed the world (admin does all writes) ---
      const companyA = await createCompany('D1 Client A');
      const companyB = await createCompany('D1 Client B');
      reqAssigned = await createRequisition('D1 Req — assigned', companyA);
      reqOther = await createRequisition('D1 Req — not mine', companyB);
      // Direct requisition assignment to the recruiter (the A3 OR-arm). The
      // recruiter has NO client/pod/edge visibility, so they see reqAssigned
      // ONLY via this direct assignment — and never reqOther.
      await assignRequisition(reqAssigned, recruiterUserId);

      taskMine = await createTask('D1 Task — mine', recruiterUserId);
      taskOther = await createTask('D1 Task — not mine', otherUserId);
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

    // ======================================================================
    // A — the saga produced a complete, consistent, login-capable identity
    // ======================================================================
    it('A — invite saga provisions a complete recruiter identity (Cognito ↔ ExternalIdentity ↔ User ↔ Membership ↔ roles)', async () => {
      // The saga returned a cognito sub that matches what the port handed back.
      expect(recruiterCognitoSub).toBe(
        cognitoSubByEmail.get('recruiter.d1@aramo.dev'),
      );

      // User row.
      const user = await db.query<{ email: string; is_active: boolean }>(
        `SELECT email, is_active FROM identity."User" WHERE id = $1::uuid`,
        [recruiterUserId],
      );
      expect(user.rows).toHaveLength(1);
      expect(user.rows[0]?.email).toBe('recruiter.d1@aramo.dev');
      expect(user.rows[0]?.is_active).toBe(true);

      // ExternalIdentity links the Cognito sub → the User (login-capable).
      const ext = await db.query<{
        provider: string;
        provider_subject: string;
        user_id: string;
      }>(
        `SELECT provider, provider_subject, user_id
           FROM identity."ExternalIdentity"
          WHERE user_id = $1::uuid AND provider = 'cognito'`,
        [recruiterUserId],
      );
      expect(ext.rows).toHaveLength(1);
      expect(ext.rows[0]?.provider_subject).toBe(recruiterCognitoSub);

      // Membership — active, in this tenant, id matches the saga response.
      const membership = await db.query<{
        id: string;
        tenant_id: string;
        is_active: boolean;
      }>(
        `SELECT id, tenant_id, is_active
           FROM identity."UserTenantMembership"
          WHERE user_id = $1::uuid AND tenant_id = $2::uuid`,
        [recruiterUserId, TENANT_ATS],
      );
      expect(membership.rows).toHaveLength(1);
      expect(membership.rows[0]?.id).toBe(recruiterMembershipId);
      expect(membership.rows[0]?.is_active).toBe(true);

      // Exactly the recruiter role is attached to the membership.
      const roles = await db.query<{ key: string }>(
        `SELECT r.key
           FROM identity."UserTenantMembershipRole" mr
           JOIN identity."Role" r ON r.id = mr.role_id
          WHERE mr.membership_id = $1::uuid`,
        [recruiterMembershipId],
      );
      expect(roles.rows.map((r) => r.key)).toEqual(['recruiter']);
    });

    // ======================================================================
    // B4 — no over-grant / no under-grant (assert the real recruiter bundle)
    // ======================================================================
    it('B4 — the provisioned recruiter holds EXACTLY the recruiter bundle (no over/under-grant)', () => {
      // Derived from the real membership→role→rolescope→scope join.
      expect(recruiterScopes).toEqual(RECRUITER_BUNDLE);

      // None of the admin scopes leaked into the bundle.
      for (const adminScope of ADMIN_ONLY_SCOPES) {
        expect(recruiterScopes).not.toContain(adminScope);
      }
      // Nor any destructive / see-all over-grant on the owning entities.
      for (const forbidden of [
        'requisition:read:all',
        'requisition:assign',
        'company:read:all',
        'talent:delete',
        'requisition:delete',
        'org:manage',
        'team:manage',
        'company:assign',
      ]) {
        expect(recruiterScopes).not.toContain(forbidden);
      }
    });

    // ======================================================================
    // B1 + B3 — recruiter surface resolves; "My X" scoping is correct
    // ======================================================================
    it('B1/B3 — My requisitions: recruiter sees their assigned req, not the tenant-wide one, not nothing', async () => {
      const list = await recruiterGet(`/v1/requisitions?site_id=${SITE_A}`);
      expect(list.status).toBe(200);
      const body = (await list.json()) as { items: Array<{ id: string }> };
      const ids = body.items.map((r) => r.id);

      // Not nothing.
      expect(ids).toContain(reqAssigned);
      // Not the whole tenant.
      expect(ids).not.toContain(reqOther);

      // Detail: assigned → 200; not-visible → 404 (has the scope, not the row).
      expect(
        (await recruiterGet(`/v1/requisitions/${reqAssigned}?site_id=${SITE_A}`))
          .status,
      ).toBe(200);
      expect(
        (await recruiterGet(`/v1/requisitions/${reqOther}?site_id=${SITE_A}`))
          .status,
      ).toBe(404);
    });

    it('B1/B3 — My tasks: recruiter sees their assigned task, not another user’s', async () => {
      const list = await recruiterGet(`/v1/tasks?site_id=${SITE_A}`);
      expect(list.status).toBe(200);
      const body = (await list.json()) as { items: Array<{ id: string }> };
      const ids = body.items.map((t) => t.id);

      expect(ids).toContain(taskMine);
      expect(ids).not.toContain(taskOther);
    });

    // ======================================================================
    // B2 — the admin section is server-DENIED (403 INSUFFICIENT_PERMISSIONS,
    //      the scope gate — the tenant IS entitled to `core`)
    // ======================================================================
    const ADMIN_ENDPOINTS: ReadonlyArray<{ label: string; path: string }> = [
      { label: 'tenant/users', path: '/v1/tenant/users' },
      { label: 'tenant/settings', path: '/v1/tenant/settings' },
      { label: 'tenant/profile', path: '/v1/tenant/profile' },
      { label: 'tenant/sites', path: '/v1/tenant/sites' },
      { label: 'tenant/audit-events', path: '/v1/tenant/audit-events' },
    ];

    it.each(ADMIN_ENDPOINTS)(
      'B2 — recruiter is server-denied 403 (scope gate) at $label',
      async ({ path }) => {
        const res = await recruiterGet(path);
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error?: { code?: string } };
        // The SCOPE gate, not the entitlement gate (tenant has `core`).
        expect(body.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
      },
    );

    // A control: the SAME admin endpoints resolve for the admin token — proving
    // the 403s above are the recruiter's missing scopes, not a broken route.
    it('B2 (control) — the admin token is NOT denied at the same endpoints', async () => {
      for (const { path } of ADMIN_ENDPOINTS) {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          headers: { Authorization: `Bearer ${adminJwt}` },
        });
        // tenant/users, audit-events resolve 200; the others may 200 with the
        // admin's scopes. The point: NOT a 403 scope-deny for the admin.
        expect(res.status).not.toBe(403);
      }
    });
  },
);
