import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey, type KeyObject } from 'jose';
import { SECRETS_MANAGER_WRITER, type SecretsManagerWriterPort } from '@aramo/integration';
import { EFFECTIVE_AUTHORIZATION_RESOLVER } from '@aramo/auth';

import { AppModule } from '../app.module.js';

import { ConfigurableTestResolver } from './support/test-auth-harness.js';
import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';

// HF-AUTH-1 — compact tokens carry no scopes; guard resolves via this resolver.
const __authzTestResolver = new ConfigurableTestResolver();

// COMM-B2 (Aramo-COMM-V1) — HTTP-boundary authorization + tenant-safe-404 proof
// for the /v1/communications read skeleton. Exercises the REAL three-axis guard
// chain (JwtAuthGuard + EntitlementGuard + RolesGuard) against a booted AppModule
// + real Postgres 17, with the FakeVoiceProvider registered at composition.
// Skipped unless ARAMO_RUN_INTEGRATION=1.

type SignKey = CryptoKey | KeyObject;
const ROOT = resolve(__dirname, '../../../..');
const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-communications-authz-spec';
const ALG = 'RS256';

const ENTITLEMENT_INIT = resolve(ROOT, 'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql');
const COMMUNICATIONS_INIT = resolve(ROOT, 'libs/communications/prisma/migrations/20260825120000_init_communications/migration.sql');
const INTEGRATION_INIT = resolve(ROOT, 'libs/integration/prisma/migrations/20260814170000_init_integration_connection/migration.sql');
const MIGRATIONS = [ENTITLEMENT_INIT, COMMUNICATIONS_INIT, INTEGRATION_INIT];

const TENANT_A = '01900000-0000-7000-8000-0000000000a1';
const TENANT_B = '01900000-0000-7000-8000-0000000000b2';
const RECRUITER_MAPPED = '00000000-0000-7000-8000-000000000aa1';
const RECRUITER_UNMAPPED = '00000000-0000-7000-8000-000000000aa2';
const RECRUITER_TO_BIND = '00000000-0000-7000-8000-000000000aa4';
const CONNECTION = '01900000-0000-7000-8000-0000000000c1';
const INTERACTION_A = '01900000-0000-7000-8000-0000000000d1';

// The RolesGuard reads scopes from the JWT; pass them directly.
const READ_SCOPES = ['communication:read'];
const NO_COMM_SCOPES = ['requisition:import:read'];
// Admin (provider-connection configuration) scopes for the mapping-admin routes.
const ADMIN_SCOPES = ['integration:read', 'integration:write'];

class FakeSecretsWriter implements SecretsManagerWriterPort {
  async putSecretValue(): Promise<void> {
    /* no-op — AppModule boot must not reach AWS */
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'COMM-B2 communications HTTP authz — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: Client;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};

    let mappedJwt: string;
    let unmappedJwt: string;
    let noScopeJwt: string;
    let tenantBJwt: string;
    let adminJwt: string;

    function auth(jwt: string): RequestInit {
      return { headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' } };
    }

    async function signJwt(
      key: SignKey,
      args: { sub: string; tenant_id: string; scopes: string[] },
    ): Promise<string> {
      return new SignJWT({
        sub: args.sub,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: args.tenant_id,
        authz_version: __authzTestResolver.grant(args.tenant_id, args.sub, args.scopes),
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(key);
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await ensureWriteFreezeTenant((s) => db.query(s), TENANT_A);
      await ensureWriteFreezeTenant((s) => db.query(s), TENANT_B);
      for (const t of [TENANT_A, TENANT_B]) {
        await db.query(
          `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid, 'ats') ON CONFLICT (tenant_id, capability) DO NOTHING`,
          [t],
        );
      }
      // COMM-B3 — tenant A has a USABLE (configured) zoom_phone provider connection
      // (id = CONNECTION); tenant B intentionally has NONE (capabilities → 409).
      await db.query(
        `INSERT INTO integration."IntegrationConnection"
           (id, tenant_id, provider_key, status, secret_ref, provider_account_id, version, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'zoom_phone', 'configured', 'connector:v1:seed', 'zoom-acct-1', 0, now(), now())`,
        [CONNECTION, TENANT_A],
      );
      // Seed one interaction (tenant A) and one provider-identity mapping (tenant A, RECRUITER_MAPPED).
      await db.query(
        `INSERT INTO communications."CommunicationInteraction"
           (id, tenant_id, channel, direction, status, integration_connection_id, from_address, to_address)
         VALUES ($1::uuid, $2::uuid, 'voice', 'outbound', 'created', $3::uuid, '+15715550100', '+17035550111')`,
        [INTERACTION_A, TENANT_A, CONNECTION],
      );
      await db.query(
        `INSERT INTO communications."CommunicationProviderIdentity"
           (id, tenant_id, integration_connection_id, recruiter_id, provider_user_id, voice_enabled, sms_enabled, status)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'pv-user-1', true, false, 'active')`,
        [TENANT_A, CONNECTION, RECRUITER_MAPPED],
      );

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      const key: SignKey = kp.privateKey as SignKey;

      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
        AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
        ARAMO_ENV: process.env['ARAMO_ENV'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;
      process.env['ARAMO_ENV'] = 'itest';

      mappedJwt = await signJwt(key, { sub: RECRUITER_MAPPED, tenant_id: TENANT_A, scopes: READ_SCOPES });
      unmappedJwt = await signJwt(key, { sub: RECRUITER_UNMAPPED, tenant_id: TENANT_A, scopes: READ_SCOPES });
      noScopeJwt = await signJwt(key, { sub: RECRUITER_MAPPED, tenant_id: TENANT_A, scopes: NO_COMM_SCOPES });
      tenantBJwt = await signJwt(key, { sub: RECRUITER_MAPPED, tenant_id: TENANT_B, scopes: READ_SCOPES });
      adminJwt = await signJwt(key, { sub: RECRUITER_MAPPED, tenant_id: TENANT_A, scopes: ADMIN_SCOPES });

      module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(SECRETS_MANAGER_WRITER)
        .useValue(new FakeSecretsWriter())
        .compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
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

    const url = (p: string) => `http://127.0.0.1:${port}${p}`;

    it('capabilities: DENIED without communication:read (403)', async () => {
      const res = await fetch(url('/v1/communications/capabilities'), auth(noScopeJwt));
      expect(res.status).toBe(403);
    });

    it('capabilities: with a bound zoom_phone connection → 200 the bound adapter descriptor', async () => {
      const res = await fetch(url('/v1/communications/capabilities'), auth(mappedJwt));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { provider_key: string; capabilities: { voice: { outbound: boolean } } };
      // COMM-B3: resolves the tenant's zoom_phone connection → ZoomPhoneAdapter.
      // NEVER a default/fake fallback.
      expect(body.provider_key).toBe('zoom_phone');
      expect(body.capabilities.voice.outbound).toBe(true);
    });

    it('capabilities: tenant with NO provider connection → 409 COMMUNICATION_PROVIDER_NOT_CONFIGURED', async () => {
      const res = await fetch(url('/v1/communications/capabilities'), auth(tenantBJwt));
      expect(res.status).toBe(409);
      const err = (await res.json()) as { error?: { code?: string } };
      expect(err.error?.code).toBe('COMMUNICATION_PROVIDER_NOT_CONFIGURED');
    });

    it('provider-identities (admin list): DENIED without integration:read (403)', async () => {
      const res = await fetch(url('/v1/communications/provider-identities'), auth(mappedJwt));
      expect(res.status).toBe(403); // communication:read is not integration:read
    });

    it('provider-identities (admin list): integration:read → 200 with the tenant mappings', async () => {
      const res = await fetch(url('/v1/communications/provider-identities'), auth(adminJwt));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<{ recruiter_id: string; provider_user_id: string }> };
      expect(body.items.some((m) => m.recruiter_id === RECRUITER_MAPPED && m.provider_user_id === 'pv-user-1')).toBe(true);
    });

    it('provider-identities (admin upsert): DENIED without integration:write (403)', async () => {
      const res = await fetch(url(`/v1/communications/provider-identities/${RECRUITER_TO_BIND}`), {
        method: 'PUT',
        ...auth(mappedJwt),
        body: JSON.stringify({ provider_user_id: 'pv-user-2' }),
      });
      expect(res.status).toBe(403);
    });

    it('provider-identities (admin upsert): integration:write binds a recruiter → 200', async () => {
      const res = await fetch(url(`/v1/communications/provider-identities/${RECRUITER_TO_BIND}`), {
        method: 'PUT',
        ...auth(adminJwt),
        body: JSON.stringify({ provider_user_id: 'pv-user-2', voice_enabled: true }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { recruiter_id: string; provider_user_id: string; status: string };
      expect(body.recruiter_id).toBe(RECRUITER_TO_BIND);
      expect(body.provider_user_id).toBe('pv-user-2');
      // re-map (rebind) is an intentional update, not a duplicate error
      const again = await fetch(url(`/v1/communications/provider-identities/${RECRUITER_TO_BIND}`), {
        method: 'PUT',
        ...auth(adminJwt),
        body: JSON.stringify({ provider_user_id: 'pv-user-2b' }),
      });
      expect(again.status).toBe(200);
    });

    it('provider-identities (admin upsert): claiming another recruiter\'s provider user → 409 ALREADY_MAPPED', async () => {
      // pv-user-1 is already mapped to RECRUITER_MAPPED; mapping it to a third recruiter conflicts.
      const third = '00000000-0000-7000-8000-000000000aa3';
      const res = await fetch(url(`/v1/communications/provider-identities/${third}`), {
        method: 'PUT',
        ...auth(adminJwt),
        body: JSON.stringify({ provider_user_id: 'pv-user-1' }),
      });
      expect(res.status).toBe(409);
      const err = (await res.json()) as { error?: { code?: string } };
      expect(err.error?.code).toBe('COMMUNICATION_PROVIDER_USER_ALREADY_MAPPED');
    });

    it('me/provider-identity: mapped recruiter → 200 with provider_user_id (no secret)', async () => {
      const res = await fetch(url('/v1/communications/me/provider-identity'), auth(mappedJwt));
      expect(res.status).toBe(200);
      const raw = await res.text();
      expect(raw).not.toMatch(/secret|token|credential/i);
      const body = JSON.parse(raw) as { recruiter_id: string; provider_user_id: string; status: string };
      expect(body.recruiter_id).toBe(RECRUITER_MAPPED);
      expect(body.provider_user_id).toBe('pv-user-1');
      expect(body.status).toBe('active');
    });

    it('me/provider-identity: unmapped recruiter → 404 COMMUNICATION_USER_NOT_MAPPED', async () => {
      const res = await fetch(url('/v1/communications/me/provider-identity'), auth(unmappedJwt));
      expect(res.status).toBe(404);
      const err = (await res.json()) as { error?: { code?: string } };
      expect(err.error?.code).toBe('COMMUNICATION_USER_NOT_MAPPED');
    });

    it('interactions/:id: same-tenant read → 200', async () => {
      const res = await fetch(url(`/v1/communications/interactions/${INTERACTION_A}`), auth(mappedJwt));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; channel: string; status: string };
      expect(body.id).toBe(INTERACTION_A);
      expect(body.channel).toBe('voice');
      expect(body.status).toBe('created');
    });

    it('interactions/:id: cross-tenant read is tenant-safe 404 COMMUNICATION_INTERACTION_NOT_FOUND', async () => {
      const res = await fetch(url(`/v1/communications/interactions/${INTERACTION_A}`), auth(tenantBJwt));
      expect(res.status).toBe(404);
      const err = (await res.json()) as { error?: { code?: string } };
      expect(err.error?.code).toBe('COMMUNICATION_INTERACTION_NOT_FOUND');
    });

    it('interactions/:id: unknown id → 404 COMMUNICATION_INTERACTION_NOT_FOUND', async () => {
      const res = await fetch(
        url('/v1/communications/interactions/01900000-0000-7000-8000-0000000000ff'),
        auth(mappedJwt),
      );
      expect(res.status).toBe(404);
      const err = (await res.json()) as { error?: { code?: string } };
      expect(err.error?.code).toBe('COMMUNICATION_INTERACTION_NOT_FOUND');
    });

    it('interactions/:id: DENIED without communication:read (403)', async () => {
      const res = await fetch(url(`/v1/communications/interactions/${INTERACTION_A}`), auth(noScopeJwt));
      expect(res.status).toBe(403);
    });
  },
);
