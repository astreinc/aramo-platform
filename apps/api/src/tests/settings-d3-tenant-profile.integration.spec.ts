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

// Settings Rebuild Directive 3 — GET/PATCH /v1/tenant/profile endpoint proof.
//
// Application-boundary proofs: the tenant:admin:profile scope-gate (200/403/
// 401), tenant-scoping (no cross-tenant read or write), GET/PATCH round-trip,
// validation (400 not 500), and the identity.tenant_profile.updated audit emit
// (no-op-no-audit). Migrations: entitlement (core read) + identity init +
// the D3 profile migration.

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
// Subdomain-Identity Directive B — additive Tenant.identity_provider column.
const IDENTITY_IDP = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260627000000_add_tenant_identity_provider/migration.sql',
);
const IDENTITY_INVITATION_MIG = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260624000000_add_invitation_and_invite_status/migration.sql',
);
const IDENTITY_PROFILE = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260619000000_add_tenant_profile/migration.sql',
);

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-settings-d3-spec';
const ALG = 'RS256';

const TENANT_A = '11111111-0000-7000-8000-aaaaaaaaaaaa';
const TENANT_B = '22222222-0000-7000-8000-bbbbbbbbbbbb';
const ADMIN_A = '00000000-0000-7000-8000-00000000aaa1';
const RECRUITER_A = '00000000-0000-7000-8000-00000000aaa2';
const ADMIN_B = '00000000-0000-7000-8000-00000000bbb1';

interface ProfileBody {
  id: string;
  name: string;
  legal_name: string | null;
  display_name: string | null;
  city: string | null;
  country_code: string | null;
  primary_contact_email: string | null;
  logo_url: string | null;
  [k: string]: unknown;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Settings Rebuild D3 — GET/PATCH /v1/tenant/profile',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    const savedEnv: Partial<Record<string, string | undefined>> = {};
    let db: Client;
    let adminAJwt: string;
    let recruiterAJwt: string;
    let adminBJwt: string;

    function signJwt(
      key: SignKey,
      args: { sub: string; tenant_id: string; scopes: string[] },
    ): Promise<string> {
      return new SignJWT({
        sub: args.sub,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: args.tenant_id,
        scopes: args.scopes,
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(key);
    }

    async function req(
      method: 'GET' | 'PATCH',
      jwt: string,
      body?: unknown,
    ): Promise<{ status: number; body: ProfileBody }> {
      const res = await fetch(`http://127.0.0.1:${port}/v1/tenant/profile`, {
        method,
        headers: {
          Authorization: `Bearer ${jwt}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const parsed = res.status === 200 ? ((await res.json()) as ProfileBody) : ({} as ProfileBody);
      return { status: res.status, body: parsed };
    }

    async function auditCount(tenantId: string): Promise<number> {
      const r = await db.query(
        `SELECT count(*)::int AS n FROM identity."IdentityAuditEvent"
         WHERE event_type = 'identity.tenant_profile.updated' AND tenant_id = $1::uuid`,
        [tenantId],
      );
      return r.rows[0].n as number;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();

      for (const p of [ENTITLEMENT_INIT, IDENTITY_INIT, IDENTITY_ALLOWED_DOMAIN, IDENTITY_DOMAIN_VERIFICATION, IDENTITY_SLUG, IDENTITY_IDP, IDENTITY_INVITATION_MIG, IDENTITY_PROFILE]) {
        await db.query(readFileSync(p, 'utf8'));
      }
      for (const t of [TENANT_A, TENANT_B]) {
        await db.query(
          `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
           VALUES ($1::uuid, 'core') ON CONFLICT (tenant_id, capability) DO NOTHING`,
          [t],
        );
        await db.query(
          `INSERT INTO identity."Tenant" (id, name, is_active, created_at, updated_at)
           VALUES ($1::uuid, $2, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
          [t, t === TENANT_A ? 'Astre A' : 'Tenant B'],
        );
      }

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      const privateKey = kp.privateKey as SignKey;

      savedEnv['DATABASE_URL'] = process.env['DATABASE_URL'];
      savedEnv['AUTH_AUDIENCE'] = process.env['AUTH_AUDIENCE'];
      savedEnv['AUTH_PUBLIC_KEY'] = process.env['AUTH_PUBLIC_KEY'];
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;

      adminAJwt = await signJwt(privateKey, { sub: ADMIN_A, tenant_id: TENANT_A, scopes: ['tenant:admin:profile'] });
      recruiterAJwt = await signJwt(privateKey, { sub: RECRUITER_A, tenant_id: TENANT_A, scopes: ['requisition:read'] });
      adminBJwt = await signJwt(privateKey, { sub: ADMIN_B, tenant_id: TENANT_B, scopes: ['tenant:admin:profile'] });

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

    // ── scope-gate ──
    it('401 — no token', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/tenant/profile`);
      expect(res.status).toBe(401);
    });
    it('403 — principal lacking tenant:admin:profile', async () => {
      const { status } = await req('GET', recruiterAJwt);
      expect(status).toBe(403);
    });

    // ── GET ──
    it('GET 200 — returns the name + (initially null) profile for the caller tenant', async () => {
      const { status, body } = await req('GET', adminAJwt);
      expect(status).toBe(200);
      expect(body.name).toBe('Astre A');
      expect(body.legal_name).toBeNull();
    });

    // ── PATCH round-trip + audit ──
    it('PATCH 200 — persists, returns the updated view, and emits exactly one audit event', async () => {
      const before = await auditCount(TENANT_A);
      const { status, body } = await req('PATCH', adminAJwt, {
        legal_name: 'Astre Consulting Services Inc.',
        city: 'Vienna',
        country_code: 'us',
        primary_contact_email: 'ops@astre.com',
        logo_url: 'https://astre.com/logo.png',
      });
      expect(status).toBe(200);
      expect(body.legal_name).toBe('Astre Consulting Services Inc.');
      expect(body.country_code).toBe('US'); // uppercased
      // Persisted (a fresh GET reflects it).
      const after = await req('GET', adminAJwt);
      expect(after.body.city).toBe('Vienna');
      // Exactly one audit event emitted for the change.
      expect(await auditCount(TENANT_A)).toBe(before + 1);
    });

    it('a no-op PATCH (same values) emits NO new audit event', async () => {
      const before = await auditCount(TENANT_A);
      const { status } = await req('PATCH', adminAJwt, { city: 'Vienna' });
      expect(status).toBe(200);
      expect(await auditCount(TENANT_A)).toBe(before);
    });

    // ── tenant-scoping (no cross-tenant read/write) ──
    it('tenant B sees its OWN profile, never tenant A edits', async () => {
      const { body } = await req('GET', adminBJwt);
      expect(body.name).toBe('Tenant B');
      expect(body.legal_name).toBeNull(); // A's PATCH did not touch B
    });
    it("tenant B's PATCH cannot write tenant A (writes its own row)", async () => {
      await req('PATCH', adminBJwt, { legal_name: 'B Legal' });
      const a = await req('GET', adminAJwt);
      expect(a.body.legal_name).toBe('Astre Consulting Services Inc.'); // unchanged
      expect(await auditCount(TENANT_B)).toBe(1);
    });

    // ── validation (400 not 500) ──
    it('400 — invalid email', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/tenant/profile`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminAJwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ primary_contact_email: 'not-an-email' }),
      });
      expect(res.status).toBe(400);
    });
    it('400 — unknown field (not the workspace name)', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/tenant/profile`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminAJwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'rename-attempt' }),
      });
      expect(res.status).toBe(400);
    });
  },
);
