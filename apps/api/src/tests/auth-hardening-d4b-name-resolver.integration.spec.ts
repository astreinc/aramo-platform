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

// §5 Auth-Hardening Directive 4b — name-resolver directory slice. The
// "whose-name-is-this" half of the two-jobs split: resolve user_id →
// display_name for ANY tenant user INCLUDING inactive/departed (historical
// integrity), so authorship/ownership/assignee names render even after a user
// leaves. Distinct from the active-only assignable picker (D4).
//
// GET /v1/tenant/users/directory — pure-identity (libs/identity), tenant-scoped.
//
// PROVES (directive §E):
//   D1 ALL users incl. inactive — both an active and a DEPARTED (inactive
//      membership) user resolve; alphabetical; foreign-tenant user absent.
//   D2 the distinguishing assertion — the DEPARTED user's id resolves to their
//      NAME (what separates this from the active-only picker).
//   D3 batch — ?user_ids=a,b resolves just those in one call.
//   D4 least-data — {user_id, display_name} ONLY; no admin field leaks.
//   D5 tenant-scoping — a tenant-B caller resolves only tenant-B.
//   D6 the gate — tenant:user:read:directory required (200 with / 403 without).

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');

const MIGRATIONS = [
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
  'libs/identity/prisma/migrations/20260625000000_add_tenant_allowed_domain/migration.sql',
  'libs/identity/prisma/migrations/20260626000000_add_tenant_domain_verification/migration.sql',
  'libs/identity/prisma/migrations/20260626120000_add_tenant_slug/migration.sql',
  'libs/identity/prisma/migrations/20260627000000_add_tenant_identity_provider/migration.sql',
  'libs/identity/prisma/migrations/20260624000000_add_invitation_and_invite_status/migration.sql',
  'libs/identity/prisma/migrations/20260601000000_add_site_axis/migration.sql',
  'libs/identity/prisma/migrations/20260604000000_add_authz_team_models/migration.sql',
  'libs/identity/prisma/migrations/20260619000000_add_tenant_profile/migration.sql',
  'libs/identity/prisma/migrations/20260620000000_add_site_hierarchy/migration.sql',
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
].map((p) => resolve(ROOT, p));

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-auth-hardening-d4b-spec';
const ALG = 'RS256';

const TENANT_A = '01900000-0000-7000-8000-0000000000a1';
const TENANT_B = '01900000-0000-7000-8000-0000000000b2';
const SITE_A = '33333333-3333-7333-8333-3333333333aa';

const DIRECTORY_SCOPE = 'tenant:user:read:directory';

// display_name sorts Anna < Zara, and the DEPARTED user (Zara) would be the
// LAST element — so if the directory wrongly excluded inactive, Zara's absence
// is immediately visible in the ordered result.
const ANNA = '00000000-0000-7000-8000-00000000a001'; //  active member, tenant A
const ZARA = '00000000-0000-7000-8000-00000000a002'; //  DEPARTED (inactive), tenant A
const FOREIGN = '00000000-0000-7000-8000-00000000b001'; // active member, tenant B

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  '§5 Auth-Hardening D4b — name-resolver directory (real Postgres 17)',
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

    async function seedMember(args: {
      userId: string;
      email: string;
      displayName: string;
      tenantId: string;
      active: boolean;
    }): Promise<void> {
      await db.query(
        `INSERT INTO identity."User" (id, email, display_name, is_active, updated_at)
         VALUES ($1::uuid, $2, $3, $4, CURRENT_TIMESTAMP)
         ON CONFLICT (id) DO NOTHING`,
        [args.userId, args.email, args.displayName, args.active],
      );
      await db.query(
        `INSERT INTO identity."UserTenantMembership"
           (id, user_id, tenant_id, is_active, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, CURRENT_TIMESTAMP)`,
        [uuidv7(), args.userId, args.tenantId, args.active],
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
        [TENANT_A, 'D4b Tenant A'],
        [TENANT_B, 'D4b Tenant B'],
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

      // Anna: active member of A. Zara: DEPARTED (inactive membership AND
      // inactive user) of A — must still resolve. Foreign: active member of B.
      await seedMember({ userId: ANNA, email: 'anna@a.dev', displayName: 'Anna', tenantId: TENANT_A, active: true });
      await seedMember({ userId: ZARA, email: 'zara@a.dev', displayName: 'Zara', tenantId: TENANT_A, active: false });
      await seedMember({ userId: FOREIGN, email: 'foreign@b.dev', displayName: 'Foreign', tenantId: TENANT_B, active: true });

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
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }),
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

    async function annaJwt(): Promise<string> {
      return signJwt({ sub: ANNA, tenant_id: TENANT_A, scopes: [DIRECTORY_SCOPE] });
    }

    // D1 + D2 — ALL tenant users incl. the DEPARTED one (the distinguishing
    // assertion vs the active-only picker), alphabetical, foreign absent.
    it('D1/D2 — resolves ALL tenant users incl. inactive/departed (history)', async () => {
      const res = await get('/v1/tenant/users/directory', await annaJwt());
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{ user_id: string; display_name: string | null }>;
      };
      // Anna (active) AND Zara (departed) both resolve; Foreign (tenant B) absent.
      expect(body.items.map((u) => u.display_name)).toEqual(['Anna', 'Zara']);
      const zara = body.items.find((u) => u.user_id === ZARA);
      expect(zara?.display_name).toBe('Zara'); // departed → name, not blank
    });

    // D3 — batch resolution in one call.
    it('D3 — batch ?user_ids resolves just the requested ids', async () => {
      const both = await get(
        `/v1/tenant/users/directory?user_ids=${ANNA},${ZARA}`,
        await annaJwt(),
      );
      expect(((await both.json()) as { items: Array<{ user_id: string }> }).items.map((u) => u.user_id))
        .toEqual([ANNA, ZARA]);

      const one = await get(
        `/v1/tenant/users/directory?user_ids=${ZARA}`,
        await annaJwt(),
      );
      expect(((await one.json()) as { items: Array<{ user_id: string }> }).items.map((u) => u.user_id))
        .toEqual([ZARA]);
    });

    // D4 — least-data.
    it('D4 — least-data: only {user_id, display_name}; no admin field leaks', async () => {
      const res = await get('/v1/tenant/users/directory', await annaJwt());
      const body = (await res.json()) as { items: Array<Record<string, unknown>> };
      for (const row of body.items) {
        expect(Object.keys(row).sort()).toEqual(['display_name', 'user_id']);
        for (const forbidden of ['email', 'is_active', 'role_keys', 'site_id', 'deactivated_at']) {
          expect(row).not.toHaveProperty(forbidden);
        }
      }
    });

    // D5 — tenant-scoping.
    it('D5 — cross-tenant impossible: a tenant-B caller resolves only tenant-B', async () => {
      const bJwt = await signJwt({ sub: FOREIGN, tenant_id: TENANT_B, scopes: [DIRECTORY_SCOPE] });
      const res = await get('/v1/tenant/users/directory', bJwt);
      const body = (await res.json()) as { items: Array<{ user_id: string }> };
      expect(body.items.map((u) => u.user_id)).toEqual([FOREIGN]);
      expect(body.items.map((u) => u.user_id)).not.toContain(ANNA);
      expect(body.items.map((u) => u.user_id)).not.toContain(ZARA);
    });

    // D6 — the gate.
    it('D6 — without tenant:user:read:directory → 403 INSUFFICIENT_PERMISSIONS', async () => {
      const noScope = await signJwt({ sub: ANNA, tenant_id: TENANT_A, scopes: [] });
      const res = await get('/v1/tenant/users/directory', noScope);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe(
        'INSUFFICIENT_PERMISSIONS',
      );
    });
  },
);
