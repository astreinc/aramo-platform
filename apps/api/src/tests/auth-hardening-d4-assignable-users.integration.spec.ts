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

// §5 Auth-Hardening Directive 4 — Recruiter assignable-users endpoint.
// Baseline: main 0786136. The roster is CONTEXTUAL to the requisition (Lead
// re-ruling): active + tenant + MAPPED TO THE REQ'S CLIENT + REQ-CARRYING role
// (Recruiter / Recruiter Lead) — NOT a flat tenant-wide list.
//
// GET /v1/tenant/assignable-users (apps/api cross-schema composition):
//   • no company_id  → BROAD: all ACTIVE tenant members (non-req pickers).
//   • company_id=X   → FILTERED: active members mapped to client X
//                      (company.UserClientAssignment) AND holding a req-carrying
//                      role (the requisition-assignment picker).
//
// The access JWT carries `scopes`; the RolesGuard reads the claim, so the gate
// is exercised by signing with/without tenant:user:read:assignable. The
// role→scope SEED is reconciled in libs/identity (roleScope.count=458).
//
// PROVES (directive §F, corrected):
//   F1 BROAD — recruiter gets all active tenant members (Carol disabled
//      excluded), alphabetical (R10-neutral), not 403.
//   F2 FILTERED — for client X: active + mapped-to-X + req-carrying only
//      (Alice). Bob (mapped but account_manager → not req-carrying) EXCLUDED;
//      Zoe (req-carrying but mapped to Y, not X) EXCLUDED; Carol (mapped +
//      recruiter but DISABLED) EXCLUDED.
//   F3 cross-client no-leak — client X roster ≠ client Y roster; a client-A
//      recruiter picking for X never sees Y's set.
//   F4 least-data — ONLY {user_id, display_name}; no admin field leaks.
//   F5 tenant-scoping — a tenant-B principal sees only tenant-B (broad), and a
//      tenant-B principal filtering on a tenant-A company gets [] (the mapped
//      set is scoped to the caller's tenant). Cross-tenant impossible.
//   F6 the gate — no tenant:user:read:assignable → 403 INSUFFICIENT_PERMISSIONS;
//      and the same minimal-scope principal is STILL denied at admin
//      /v1/tenant/users (not a backdoor to the admin surface).

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');

const MIGRATIONS = [
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
  'libs/identity/prisma/migrations/20260625000000_add_tenant_allowed_domain/migration.sql',
  'libs/identity/prisma/migrations/20260624000000_add_invitation_and_invite_status/migration.sql',
  'libs/identity/prisma/migrations/20260601000000_add_site_axis/migration.sql',
  'libs/identity/prisma/migrations/20260604000000_add_authz_team_models/migration.sql',
  'libs/identity/prisma/migrations/20260619000000_add_tenant_profile/migration.sql',
  'libs/identity/prisma/migrations/20260620000000_add_site_hierarchy/migration.sql',
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
  'libs/company/prisma/migrations/20260601160000_init_company_model/migration.sql',
  'libs/company/prisma/migrations/20260611000000_add_company_field_expansion/migration.sql',
  'libs/company/prisma/migrations/20260611120000_add_company_address_place_ref/migration.sql',
  'libs/company/prisma/migrations/20260616000000_add_company_off_limits/migration.sql',
  'libs/company/prisma/migrations/20260603140100_add_import_batch_id_to_company/migration.sql',
  'libs/company/prisma/migrations/20260604000000_add_authz_assignment_ownership/migration.sql',
].map((p) => resolve(ROOT, p));

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-auth-hardening-d4-spec';
const ALG = 'RS256';

const TENANT_A = '01900000-0000-7000-8000-0000000000a1';
const TENANT_B = '01900000-0000-7000-8000-0000000000b2';
const SITE_A = '33333333-3333-7333-8333-3333333333aa';

const ASSIGNABLE_SCOPE = 'tenant:user:read:assignable';

// Role ids (seeded raw). recruiter + lead_recruiter are req-carrying;
// account_manager is NOT (work-assigning but not a req-carrying role).
const ROLE_RECRUITER = '00000000-0000-7000-8000-0000000000e1';
const ROLE_LEAD_RECRUITER = '00000000-0000-7000-8000-0000000000e2';
const ROLE_ACCOUNT_MANAGER = '00000000-0000-7000-8000-0000000000e3';

// Tenant-A users (display_name sorts Alice < Bob < Zoe).
const ALICE = '00000000-0000-7000-8000-00000000a001'; // active, recruiter, →X
const BOB = '00000000-0000-7000-8000-00000000a002'; //   active, account_manager, →X
const ZOE = '00000000-0000-7000-8000-00000000a003'; //   active, lead_recruiter, →Y
const CAROL = '00000000-0000-7000-8000-00000000a004'; // DISABLED, recruiter, →X
const DAVE = '00000000-0000-7000-8000-00000000b001'; //  tenant B, active, recruiter

// Clients (companies) in tenant A.
const CLIENT_X = '00000000-0000-7000-8000-0000000000c1';
const CLIENT_Y = '00000000-0000-7000-8000-0000000000c2';
const CLIENT_B = '00000000-0000-7000-8000-0000000000c3'; // tenant B company

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  '§5 Auth-Hardening D4 — recruiter assignable-users endpoint (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let db: Client;
    let privateKey: SignKey;

    async function signJwt(args: {
      sub: string;
      tenant_id: string;
      scopes: string[];
    }): Promise<string> {
      return new SignJWT({
        sub: args.sub,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: args.tenant_id,
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

    async function seedRole(id: string, key: string): Promise<void> {
      await db.query(
        `INSERT INTO identity."Role" (id, key, description, is_active, updated_at)
         VALUES ($1::uuid, $2, $2, true, CURRENT_TIMESTAMP)
         ON CONFLICT (id) DO NOTHING`,
        [id, key],
      );
    }

    // Seed a User + an (active|inactive) membership + a single role assignment.
    async function seedMember(args: {
      userId: string;
      email: string;
      displayName: string;
      tenantId: string;
      active: boolean;
      roleId: string;
    }): Promise<void> {
      await db.query(
        `INSERT INTO identity."User" (id, email, display_name, is_active, updated_at)
         VALUES ($1::uuid, $2, $3, true, CURRENT_TIMESTAMP)
         ON CONFLICT (id) DO NOTHING`,
        [args.userId, args.email, args.displayName],
      );
      const membershipId = uuidv7();
      await db.query(
        `INSERT INTO identity."UserTenantMembership"
           (id, user_id, tenant_id, is_active, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, CURRENT_TIMESTAMP)`,
        [membershipId, args.userId, args.tenantId, args.active],
      );
      await db.query(
        `INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        [uuidv7(), membershipId, args.roleId],
      );
    }

    async function seedCompany(
      id: string,
      tenantId: string,
      name: string,
    ): Promise<void> {
      await db.query(
        `INSERT INTO company."Company" (id, tenant_id, name, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (id) DO NOTHING`,
        [id, tenantId, name],
      );
    }

    async function mapUserToClient(
      tenantId: string,
      userId: string,
      companyId: string,
    ): Promise<void> {
      await db.query(
        `INSERT INTO company."UserClientAssignment" (id, tenant_id, user_id, company_id)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid)`,
        [tenantId, userId, companyId],
      );
    }

    async function get(
      path: string,
      jwt: string,
    ): Promise<{ status: number; json: () => Promise<unknown> }> {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      return { status: res.status, json: () => res.json() };
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();

      for (const p of MIGRATIONS) {
        await db.query(readFileSync(p, 'utf8'));
      }

      for (const [id, name] of [
        [TENANT_A, 'D4 Tenant A'],
        [TENANT_B, 'D4 Tenant B'],
      ]) {
        await db.query(
          `INSERT INTO identity."Tenant" (id, name, updated_at)
           VALUES ($1::uuid, $2, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`,
          [id, name],
        );
        await db.query(
          `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
           VALUES ($1::uuid, 'core') ON CONFLICT (tenant_id, capability) DO NOTHING`,
          [id],
        );
      }

      await seedRole(ROLE_RECRUITER, 'recruiter');
      await seedRole(ROLE_LEAD_RECRUITER, 'lead_recruiter');
      await seedRole(ROLE_ACCOUNT_MANAGER, 'account_manager');

      // Tenant A members.
      await seedMember({ userId: ALICE, email: 'alice@a.dev', displayName: 'Alice', tenantId: TENANT_A, active: true, roleId: ROLE_RECRUITER });
      await seedMember({ userId: BOB, email: 'bob@a.dev', displayName: 'Bob', tenantId: TENANT_A, active: true, roleId: ROLE_ACCOUNT_MANAGER });
      await seedMember({ userId: ZOE, email: 'zoe@a.dev', displayName: 'Zoe', tenantId: TENANT_A, active: true, roleId: ROLE_LEAD_RECRUITER });
      await seedMember({ userId: CAROL, email: 'carol@a.dev', displayName: 'Carol', tenantId: TENANT_A, active: false, roleId: ROLE_RECRUITER });
      // Tenant B member.
      await seedMember({ userId: DAVE, email: 'dave@b.dev', displayName: 'Dave', tenantId: TENANT_B, active: true, roleId: ROLE_RECRUITER });

      // Clients + user↔client mappings.
      await seedCompany(CLIENT_X, TENANT_A, 'Client X');
      await seedCompany(CLIENT_Y, TENANT_A, 'Client Y');
      await seedCompany(CLIENT_B, TENANT_B, 'Client B');
      await mapUserToClient(TENANT_A, ALICE, CLIENT_X); // recruiter, active  → in X
      await mapUserToClient(TENANT_A, BOB, CLIENT_X); //   AM (not req-carry) → excluded
      await mapUserToClient(TENANT_A, CAROL, CLIENT_X); // recruiter, DISABLED → excluded
      await mapUserToClient(TENANT_A, ZOE, CLIENT_Y); //   lead_recruiter     → in Y
      await mapUserToClient(TENANT_B, DAVE, CLIENT_B);

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

    async function aliceJwt(): Promise<string> {
      return signJwt({ sub: ALICE, tenant_id: TENANT_A, scopes: [ASSIGNABLE_SCOPE] });
    }

    // F1 — BROAD (no company_id): all active tenant-A members, alphabetical,
    // role-agnostic (Carol disabled excluded).
    it('F1 — broad roster: all active tenant members, alphabetical (R10-neutral)', async () => {
      const res = await get('/v1/tenant/assignable-users', await aliceJwt());
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{ user_id: string; display_name: string | null }>;
      };
      expect(body.items.map((u) => u.display_name)).toEqual(['Alice', 'Bob', 'Zoe']);
      expect(body.items.map((u) => u.user_id)).toEqual([ALICE, BOB, ZOE]);
    });

    // F2 — FILTERED for client X: active + mapped-to-X + req-carrying ⇒ [Alice].
    it('F2 — client-filtered: active + mapped-to-client + req-carrying only', async () => {
      const res = await get(
        `/v1/tenant/assignable-users?company_id=${CLIENT_X}`,
        await aliceJwt(),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{ user_id: string }>;
      };
      // Alice: recruiter + active + mapped→X. Bob: mapped but account_manager.
      // Carol: recruiter + mapped→X but DISABLED. Zoe: lead_recruiter but →Y.
      expect(body.items.map((u) => u.user_id)).toEqual([ALICE]);
    });

    // F3 — cross-client no-leak: client Y roster is Zoe, disjoint from X.
    it('F3 — cross-client no-leak: client Y roster is disjoint from client X', async () => {
      const res = await get(
        `/v1/tenant/assignable-users?company_id=${CLIENT_Y}`,
        await aliceJwt(),
      );
      const body = (await res.json()) as { items: Array<{ user_id: string }> };
      expect(body.items.map((u) => u.user_id)).toEqual([ZOE]);
      expect(body.items.map((u) => u.user_id)).not.toContain(ALICE);
    });

    // F4 — least-data: only {user_id, display_name}.
    it('F4 — least-data: only {user_id, display_name}; no admin field leaks', async () => {
      const res = await get('/v1/tenant/assignable-users', await aliceJwt());
      const body = (await res.json()) as { items: Array<Record<string, unknown>> };
      for (const row of body.items) {
        expect(Object.keys(row).sort()).toEqual(['display_name', 'user_id']);
        for (const forbidden of ['email', 'is_active', 'role_keys', 'site_id', 'deactivated_at']) {
          expect(row).not.toHaveProperty(forbidden);
        }
      }
    });

    // F5 — tenant-scoping: tenant-B principal sees only tenant-B (broad); and
    // filtering on a tenant-A company yields [] (mapped set is tenant-scoped).
    it('F5 — cross-tenant impossible (broad + filtered on a foreign company)', async () => {
      const daveJwt = await signJwt({ sub: DAVE, tenant_id: TENANT_B, scopes: [ASSIGNABLE_SCOPE] });
      const broad = await get('/v1/tenant/assignable-users', daveJwt);
      const broadBody = (await broad.json()) as { items: Array<{ user_id: string }> };
      expect(broadBody.items.map((u) => u.user_id)).toEqual([DAVE]);

      // CLIENT_X belongs to tenant A; a tenant-B caller's mapped set for it is
      // empty (findByCompany is scoped to the caller's tenant_id).
      const foreign = await get(
        `/v1/tenant/assignable-users?company_id=${CLIENT_X}`,
        daveJwt,
      );
      const foreignBody = (await foreign.json()) as { items: unknown[] };
      expect(foreignBody.items).toEqual([]);
    });

    // F6 — the gate.
    it('F6 — without tenant:user:read:assignable → 403; admin roster still denied', async () => {
      const noScope = await signJwt({ sub: ALICE, tenant_id: TENANT_A, scopes: [] });
      const denied = await get('/v1/tenant/assignable-users', noScope);
      expect(denied.status).toBe(403);
      expect(((await denied.json()) as { error?: { code?: string } }).error?.code).toBe(
        'INSUFFICIENT_PERMISSIONS',
      );

      const admin = await get('/v1/tenant/users', await aliceJwt());
      expect(admin.status).toBe(403);
      expect(((await admin.json()) as { error?: { code?: string } }).error?.code).toBe(
        'INSUFFICIENT_PERMISSIONS',
      );
    });
  },
);
