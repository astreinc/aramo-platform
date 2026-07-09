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
import { DNS_RESOLVER_PORT, StubDnsAdapter } from '@aramo/identity';

import { AppModule } from '../app.module.js';

// Domain-Enforcement P2b §6/§9 — GET/POST /v1/tenant/domain-verification (+ /check)
// endpoint proof, through the REAL module graph + real Postgres, with the STUB
// DNS resolver primed to simulate the tenant publishing the challenge.
//
// Proves: the tenant:admin:domain scope-gate (200/403/401), tenant-scoping (no
// cross-tenant read/write), the 3-state machine end-to-end (UNVERIFIED → request
// → PENDING → check+match → VERIFIED), re-check-no-match stays PENDING, VERIFIED
// sticky, the two audit events (requested/verified, no-op-no-audit), and that
// VERIFIED GATES NOTHING (P1's allowed_domain is untouched by verification).

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
  'libs/identity/prisma/migrations/20260709130000_add_tenant_lifecycle_status/migration.sql',
);

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-domain-verification-spec';
const ALG = 'RS256';

const TENANT_A = '11111111-0000-7000-8000-aaaaaaaaaaaa';
const TENANT_B = '22222222-0000-7000-8000-bbbbbbbbbbbb';
const ADMIN_A = '00000000-0000-7000-8000-00000000aaa1';
const RECRUITER_A = '00000000-0000-7000-8000-00000000aaa2';
const ADMIN_B = '00000000-0000-7000-8000-00000000bbb1';
const DOMAIN_A = 'acme.corp';
const DOMAIN_B = 'beta.example';

interface DvBody {
  status: string;
  allowed_domain: string | null;
  record_name: string | null;
  record_value: string | null;
  verified_at: string | null;
  token_issued_at: string | null;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Domain-Enforcement P2b — /v1/tenant/domain-verification',
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
    let stub: StubDnsAdapter;

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
      method: 'GET' | 'POST',
      path: string,
      jwt?: string,
    ): Promise<{ status: number; body: DvBody }> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/tenant/domain-verification${path}`,
        {
          method,
          headers: jwt === undefined ? {} : { Authorization: `Bearer ${jwt}` },
        },
      );
      const body = res.status === 200 ? ((await res.json()) as DvBody) : ({} as DvBody);
      return { status: res.status, body };
    }

    async function auditCount(tenantId: string, eventType: string): Promise<number> {
      const r = await db.query(
        `SELECT count(*)::int AS n FROM identity."IdentityAuditEvent"
         WHERE event_type = $2 AND tenant_id = $1::uuid`,
        [tenantId, eventType],
      );
      return r.rows[0].n as number;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();

      for (const p of [
        ENTITLEMENT_INIT,
        IDENTITY_INIT,
        IDENTITY_ALLOWED_DOMAIN,
        IDENTITY_DOMAIN_VERIFICATION, IDENTITY_SLUG, IDENTITY_IDP,
      ]) {
        await db.query(readFileSync(p, 'utf8'));
      }
      for (const [t, name, domain] of [
        [TENANT_A, 'Astre A', DOMAIN_A],
        [TENANT_B, 'Tenant B', DOMAIN_B],
      ] as const) {
        await db.query(
          `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
           VALUES ($1::uuid, 'core') ON CONFLICT (tenant_id, capability) DO NOTHING`,
          [t],
        );
        await db.query(
          `INSERT INTO identity."Tenant" (id, name, is_active, allowed_domain, created_at, updated_at)
           VALUES ($1::uuid, $2, true, $3, now(), now()) ON CONFLICT (id) DO NOTHING`,
          [t, name, domain],
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

      adminAJwt = await signJwt(privateKey, { sub: ADMIN_A, tenant_id: TENANT_A, scopes: ['tenant:admin:domain'] });
      recruiterAJwt = await signJwt(privateKey, { sub: RECRUITER_A, tenant_id: TENANT_A, scopes: ['requisition:read'] });
      adminBJwt = await signJwt(privateKey, { sub: ADMIN_B, tenant_id: TENANT_B, scopes: ['tenant:admin:domain'] });

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      await app.init();
      // Reach the bound DNS resolver (stub in test env) to prime canned TXT.
      stub = module.get<StubDnsAdapter>(DNS_RESOLVER_PORT, { strict: false });
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
      const { status } = await req('GET', '');
      expect(status).toBe(401);
    });
    it('403 — principal lacking tenant:admin:domain', async () => {
      const { status } = await req('GET', '', recruiterAJwt);
      expect(status).toBe(403);
    });

    // ── GET (initial UNVERIFIED) ──
    it('GET 200 — UNVERIFIED with the record NAME to publish but no value yet', async () => {
      const { status, body } = await req('GET', '', adminAJwt);
      expect(status).toBe(200);
      expect(body.status).toBe('UNVERIFIED');
      expect(body.allowed_domain).toBe(DOMAIN_A);
      expect(body.record_name).toBe(`_aramo-challenge.${DOMAIN_A}`);
      expect(body.record_value).toBeNull();
    });

    // ── request → PENDING + token + audit ──
    let publishedValue = '';
    it('POST 200 — mints a token → PENDING, value is the prefixed token, emits requested', async () => {
      const before = await auditCount(TENANT_A, 'identity.domain.verification.requested');
      const { status, body } = await req('POST', '', adminAJwt);
      expect(status).toBe(200);
      expect(body.status).toBe('PENDING');
      expect(body.record_value).toMatch(/^aramo-domain-verification=.+/);
      expect(body.token_issued_at).not.toBeNull();
      publishedValue = body.record_value as string;
      expect(await auditCount(TENANT_A, 'identity.domain.verification.requested')).toBe(before + 1);
    });

    // ── check before publish → stays PENDING (not an error), no verified audit ──
    it('POST /check with nothing published — stays PENDING (DNS not propagated), no verified audit', async () => {
      const before = await auditCount(TENANT_A, 'identity.domain.verified');
      const { status, body } = await req('POST', '/check', adminAJwt);
      expect(status).toBe(200);
      expect(body.status).toBe('PENDING');
      expect(await auditCount(TENANT_A, 'identity.domain.verified')).toBe(before);
    });

    // ── publish (prime stub) → check → VERIFIED + audit ──
    it('POST /check with the matching TXT published → VERIFIED, verified_at set, emits verified', async () => {
      stub.setRecords(`_aramo-challenge.${DOMAIN_A}`, [publishedValue]);
      const before = await auditCount(TENANT_A, 'identity.domain.verified');
      const { status, body } = await req('POST', '/check', adminAJwt);
      expect(status).toBe(200);
      expect(body.status).toBe('VERIFIED');
      expect(body.verified_at).not.toBeNull();
      expect(await auditCount(TENANT_A, 'identity.domain.verified')).toBe(before + 1);
    });

    it('VERIFIED is sticky — a re-check after the record is removed stays VERIFIED, no new audit', async () => {
      stub.reset(); // record vanished
      const before = await auditCount(TENANT_A, 'identity.domain.verified');
      const { body } = await req('POST', '/check', adminAJwt);
      expect(body.status).toBe('VERIFIED');
      expect(await auditCount(TENANT_A, 'identity.domain.verified')).toBe(before);
    });

    // ── tenant-scoping ──
    it('tenant B sees its OWN domain + status, untouched by A', async () => {
      const { body } = await req('GET', '', adminBJwt);
      expect(body.allowed_domain).toBe(DOMAIN_B);
      expect(body.status).toBe('UNVERIFIED'); // A verifying did not touch B
    });

    // ── VERIFIED gates nothing (PO ruling (a)) ──
    it('VERIFIED gates NOTHING — P1 allowed_domain + tenant active are unchanged by verification', async () => {
      const r = await db.query(
        `SELECT allowed_domain, is_active FROM identity."Tenant" WHERE id = $1::uuid`,
        [TENANT_A],
      );
      expect(r.rows[0].allowed_domain).toBe(DOMAIN_A); // untouched
      expect(r.rows[0].is_active).toBe(true);
    });
  },
);
