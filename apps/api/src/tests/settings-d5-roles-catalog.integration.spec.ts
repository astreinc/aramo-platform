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

// Settings Rebuild Directive 5 — GET /v1/tenant/roles-catalog endpoint proof.
//
// Application-boundary proofs: the tenant:admin:user-manage scope-gate (200/
// 403/401), and that the real endpoint projects the DB Role + RoleScope into
// the catalog view — excluding the platform tier (super_admin), deriving the
// display from the description, attaching the S4 gate. The full projection /
// ordering / completeness logic is covered by the unit spec; here a focused
// representative role set proves the wiring end-to-end against real guards.

type SignKey = CryptoKey | KeyObject;
const ROOT = resolve(__dirname, '../../../..');
const ENTITLEMENT_INIT = resolve(
  ROOT,
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
);
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
const IDENTITY_INVITATION_MIG = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260624000000_add_invitation_and_invite_status/migration.sql',
);

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-settings-d5-spec';
const ALG = 'RS256';
const TENANT = '11111111-0000-7000-8000-aaaaaaaaaaaa';
const ADMIN = '00000000-0000-7000-8000-00000000aaa1';
const RECRUITER = '00000000-0000-7000-8000-00000000aaa2';

interface CatalogRole {
  key: string;
  display: string;
  description: string;
  tier: string;
  scopes: string[];
  requires_setting?: { setting_key: string; disabled_message: string };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Settings Rebuild D5 — GET /v1/tenant/roles-catalog',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    const savedEnv: Partial<Record<string, string | undefined>> = {};
    let db: Client;
    let adminJwt: string;
    let recruiterJwt: string;

    function signJwt(
      key: SignKey,
      args: { sub: string; scopes: string[] },
    ): Promise<string> {
      return new SignJWT({
        sub: args.sub,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: TENANT,
        scopes: args.scopes,
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(key);
    }

    async function scope(id: string, key: string): Promise<void> {
      await db.query(
        `INSERT INTO identity."Scope" (id, key, description)
         VALUES ($1::uuid, $2, $2) ON CONFLICT (id) DO NOTHING`,
        [id, key],
      );
    }
    async function role(id: string, key: string, description: string): Promise<void> {
      await db.query(
        `INSERT INTO identity."Role" (id, key, description, is_active, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
        [id, key, description],
      );
    }
    async function grant(id: string, roleId: string, scopeId: string): Promise<void> {
      await db.query(
        `INSERT INTO identity."RoleScope" (id, role_id, scope_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid) ON CONFLICT (id) DO NOTHING`,
        [id, roleId, scopeId],
      );
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of [ENTITLEMENT_INIT, IDENTITY_INIT, IDENTITY_ALLOWED_DOMAIN, IDENTITY_DOMAIN_VERIFICATION, IDENTITY_SLUG, IDENTITY_INVITATION_MIG]) {
        await db.query(readFileSync(p, 'utf8'));
      }
      await db.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
         VALUES ($1::uuid, 'core') ON CONFLICT (tenant_id, capability) DO NOTHING`,
        [TENANT],
      );

      // Scopes.
      const sUserManage = '50000000-0000-7000-8000-000000000001';
      const sTalentRead = '50000000-0000-7000-8000-000000000002';
      const sPlatform = '50000000-0000-7000-8000-000000000003';
      const sPortal = '50000000-0000-7000-8000-000000000004';
      const sAudit = '50000000-0000-7000-8000-000000000005';
      await scope(sUserManage, 'tenant:admin:user-manage');
      await scope(sTalentRead, 'talent:read');
      await scope(sPlatform, 'platform:tenant:provision');
      await scope(sPortal, 'portal:profile:read');
      await scope(sAudit, 'audit:read');

      // Roles (representative across tiers + the platform exclusion).
      const rAdmin = '60000000-0000-7000-8000-000000000001';
      const rRecruiter = '60000000-0000-7000-8000-000000000002';
      const rSuper = '60000000-0000-7000-8000-000000000003';
      const rCandidate = '60000000-0000-7000-8000-000000000004';
      const rAwf = '60000000-0000-7000-8000-000000000005';
      await role(rAdmin, 'tenant_admin', 'Tenant Admin — administrative operator of the tenant');
      await role(rRecruiter, 'recruiter', 'Recruiter — core operator');
      await role(rSuper, 'super_admin', 'Super Admin — platform-tier operator');
      await role(rCandidate, 'candidate', 'Candidate — portal-user role');
      await role(rAwf, 'auditor_with_financials', 'Auditor with Financials — compliance reads + see-all comp');

      let g = 0x70;
      const gid = () => `60000000-0000-7000-8000-0000000000${(g++).toString(16)}`;
      await grant(gid(), rAdmin, sUserManage);
      await grant(gid(), rRecruiter, sTalentRead);
      await grant(gid(), rSuper, sPlatform); // platform → excluded
      await grant(gid(), rCandidate, sPortal);
      await grant(gid(), rAwf, sAudit);

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      const privateKey = kp.privateKey as SignKey;
      savedEnv['DATABASE_URL'] = process.env['DATABASE_URL'];
      savedEnv['AUTH_AUDIENCE'] = process.env['AUTH_AUDIENCE'];
      savedEnv['AUTH_PUBLIC_KEY'] = process.env['AUTH_PUBLIC_KEY'];
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;

      adminJwt = await signJwt(privateKey, { sub: ADMIN, scopes: ['tenant:admin:user-manage'] });
      recruiterJwt = await signJwt(privateKey, { sub: RECRUITER, scopes: ['talent:read'] });

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;
    }, 240_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    async function get(jwt?: string): Promise<{ status: number; roles: CatalogRole[] }> {
      const res = await fetch(`http://127.0.0.1:${port}/v1/tenant/roles-catalog`, {
        headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
      });
      const body = res.status === 200 ? ((await res.json()) as { roles: CatalogRole[] }) : { roles: [] };
      return { status: res.status, roles: body.roles };
    }

    it('401 — no token', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/tenant/roles-catalog`);
      expect(res.status).toBe(401);
    });
    it('403 — principal lacking tenant:admin:user-manage', async () => {
      expect((await get(recruiterJwt)).status).toBe(403);
    });
    it('200 — a user-manage holder reads the catalog', async () => {
      expect((await get(adminJwt)).status).toBe(200);
    });

    it('EXCLUDES the platform tier (super_admin) and orders by tier', async () => {
      const { roles } = await get(adminJwt);
      const keys = roles.map((r) => r.key);
      expect(keys).not.toContain('super_admin');
      // tenant_admin (Administration) first; the rest follow by tier rank.
      expect(keys[0]).toBe('tenant_admin');
      expect(new Set(keys)).toEqual(
        new Set(['tenant_admin', 'recruiter', 'candidate', 'auditor_with_financials']),
      );
    });

    it('projects display (from description), tier and scope bundle', async () => {
      const { roles } = await get(adminJwt);
      const admin = roles.find((r) => r.key === 'tenant_admin');
      expect(admin?.display).toBe('Tenant Admin');
      expect(admin?.tier).toBe('Administration');
      expect(admin?.scopes).toContain('tenant:admin:user-manage');
    });

    it('attaches the S4 settings-gate to auditor_with_financials only', async () => {
      const { roles } = await get(adminJwt);
      expect(roles.find((r) => r.key === 'auditor_with_financials')?.requires_setting?.setting_key).toBe(
        'audit.financials_enabled',
      );
      expect(roles.find((r) => r.key === 'recruiter')?.requires_setting).toBeUndefined();
    });
  },
);
