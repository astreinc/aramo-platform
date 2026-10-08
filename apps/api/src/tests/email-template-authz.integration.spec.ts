import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey, type KeyObject } from 'jose';
import { EFFECTIVE_AUTHORIZATION_RESOLVER } from '@aramo/auth';

import { AppModule } from '../app.module.js';

import { ConfigurableTestResolver } from './support/test-auth-harness.js';
import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';

// D-EMAIL-TPL-1 (ET-4) — end-to-end authorization + tenant isolation for the
// reusable email-template management API, against a booted AppModule + real
// Postgres 17. Proves the full ET-4 bar: 403 without scope; read vs manage split;
// cross-tenant 404; invalid-merge-token 422; unknown-id 404; the code-owned
// default is never a mutable row; override wins; deactivated override falls back.
// Skipped unless ARAMO_RUN_INTEGRATION=1.

type SignKey = CryptoKey | KeyObject;
const __resolver = new ConfigurableTestResolver();
const ROOT = resolve(__dirname, '../../../..');
const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-email-template-authz-spec';
const ALG = 'RS256';

const MIGRATIONS = [
  resolve(ROOT, 'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql'),
  resolve(ROOT, 'libs/communications/prisma/migrations/20260825120000_init_communications/migration.sql'),
  resolve(ROOT, 'libs/communications/prisma/migrations/20260905130000_comm_c2b_provider_identity_email_tenant/migration.sql'),
  resolve(ROOT, 'libs/communications/prisma/migrations/20260905140000_comm_c2b_meeting_channel/migration.sql'),
  resolve(ROOT, 'libs/communications/prisma/migrations/20260921170000_comm_c4_email_content_capture/migration.sql'),
  resolve(ROOT, 'libs/communications/prisma/migrations/20260928140000_email_template/migration.sql'),
  resolve(ROOT, 'libs/communications/prisma/migrations/20260929120000_comm_interaction_template_provenance/migration.sql'),
  resolve(ROOT, 'libs/communications/prisma/migrations/20261006160000_recruiting_journey_attested_response_evidence/migration.sql'),
  resolve(ROOT, 'libs/integration/prisma/migrations/20260814170000_init_integration_connection/migration.sql'),
  // Provision the conversation_intelligence schema so the background CI-processing
  // reconciler's poll succeeds during the booted-AppModule window (else it logs a
  // TableDoesNotExist — non-fatal, but this keeps the run clean).
  resolve(ROOT, 'libs/conversation-intelligence/prisma/migrations/20260907130000_ci_requisition_analysis_context_init/migration.sql'),
  resolve(ROOT, 'libs/conversation-intelligence/prisma/migrations/20260909120000_ci_b6_processing_run/migration.sql'),
];

const TENANT_A = '01900000-0000-7000-8000-0000000000a1';
const TENANT_B = '01900000-0000-7000-8000-0000000000b2';
const ADMIN_A = '00000000-0000-7000-8000-000000000aa1';
const ADMIN_B = '00000000-0000-7000-8000-000000000aa2';

const READ = ['communication:template:read'];
const MANAGE = ['communication:template:read', 'communication:template:manage'];
const NO_TEMPLATE = ['requisition:import:read'];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'D-EMAIL-TPL-1 (ET-4) email-template API — authz + tenant isolation (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let app: INestApplication;
    let module: TestingModule;
    let port: number;
    const savedEnv: Record<string, string | undefined> = {};

    let readJwt = '';
    let manageJwt = '';
    let noScopeJwt = '';
    let manageBJwt = '';

    async function signJwt(key: SignKey, args: { sub: string; tenant_id: string; scopes: string[] }): Promise<string> {
      return new SignJWT({
        sub: args.sub,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: args.tenant_id,
        authz_version: __resolver.grant(args.tenant_id, args.sub, args.scopes),
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(key);
    }

    function req(
      method: string,
      path: string,
      jwt: string,
      body?: unknown,
    ): Promise<Response> {
      return fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${jwt}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    }

    const validCreate = {
      category: 'requisition_initial_contact',
      name: 'Astre contact',
      subject_template: 'Re: {{requisition.title}}',
      body_template: 'Hi {{talent.first_name}}, about {{requisition.title}}.',
    };

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
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

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      const key: SignKey = kp.privateKey as SignKey;

      for (const k of ['DATABASE_URL', 'AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY', 'ARAMO_ENV']) {
        savedEnv[k] = process.env[k];
      }
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;
      process.env['ARAMO_ENV'] = 'itest';

      readJwt = await signJwt(key, { sub: ADMIN_A, tenant_id: TENANT_A, scopes: READ });
      manageJwt = await signJwt(key, { sub: ADMIN_A, tenant_id: TENANT_A, scopes: MANAGE });
      noScopeJwt = await signJwt(key, { sub: ADMIN_A, tenant_id: TENANT_A, scopes: NO_TEMPLATE });
      manageBJwt = await signJwt(key, { sub: ADMIN_B, tenant_id: TENANT_B, scopes: MANAGE });

      module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EFFECTIVE_AUTHORIZATION_RESOLVER)
        .useValue(__resolver)
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

    it('no template scope → 403 on every route', async () => {
      expect((await req('GET', '/v1/communications/email-templates', noScopeJwt)).status).toBe(403);
      expect((await req('POST', '/v1/communications/email-templates', noScopeJwt, validCreate)).status).toBe(403);
    });

    it('read scope may list/preview but NOT create/update/deactivate', async () => {
      expect((await req('GET', '/v1/communications/email-templates', readJwt)).status).toBe(200);
      const preview = await req('POST', '/v1/communications/email-templates/x/preview', readJwt, {
        subject_template: 'Re: {{requisition.title}}',
        body_template: 'Hi {{talent.first_name}}',
      });
      expect(preview.status).toBe(200);
      expect((await req('POST', '/v1/communications/email-templates', readJwt, validCreate)).status).toBe(403);
    });

    it('the code-owned default surfaces read-only in the list (id=null, is_system_default=true)', async () => {
      const res = await req('GET', '/v1/communications/email-templates', readJwt);
      const { items } = (await res.json()) as { items: Array<{ id: string | null; is_system_default: boolean }> };
      const sys = items.find((i) => i.is_system_default);
      expect(sys).toBeDefined();
      expect(sys?.id).toBeNull(); // no id → nothing to PATCH → cannot be mutated as a tenant row
    });

    it('manage scope can create → override WINS → deactivate → default returns', async () => {
      // create (manage) → 201
      const created = await req('POST', '/v1/communications/email-templates', manageJwt, validCreate);
      expect(created.status).toBe(201);
      const row = (await created.json()) as { id: string; is_system_default: boolean };
      expect(row.is_system_default).toBe(false);

      // list → the override wins (effective row is the tenant override, not the default)
      const listed = await (await req('GET', '/v1/communications/email-templates', readJwt)).json();
      const effective = (listed as { items: Array<{ id: string | null; is_system_default: boolean }> }).items.find(
        (i) => !i.is_system_default,
      );
      expect(effective?.id).toBe(row.id);

      // duplicate create → 409
      expect((await req('POST', '/v1/communications/email-templates', manageJwt, validCreate)).status).toBe(409);

      // update (manage) → 200
      expect(
        (await req('PATCH', `/v1/communications/email-templates/${row.id}`, manageJwt, { name: 'renamed' })).status,
      ).toBe(200);

      // deactivate (manage) → 204 → the tenant falls back to the system default
      expect((await req('POST', `/v1/communications/email-templates/${row.id}/deactivate`, manageJwt)).status).toBe(204);
      const afterList = await (await req('GET', '/v1/communications/email-templates', readJwt)).json();
      const sysAfter = (afterList as { items: Array<{ id: string | null; is_system_default: boolean }> }).items.find(
        (i) => i.is_system_default,
      );
      expect(sysAfter?.id).toBeNull();
    });

    it('invalid merge token → create AND preview rejected 422', async () => {
      const bad = { ...validCreate, subject_template: 'Hi {{talent.ssn}}' };
      expect((await req('POST', '/v1/communications/email-templates', manageJwt, bad)).status).toBe(422);
      const preview = await req('POST', '/v1/communications/email-templates/x/preview', readJwt, {
        subject_template: 'ok',
        body_template: '{{secret.value}}',
      });
      expect(preview.status).toBe(422);
    });

    it('unknown template id → 404 (fail-closed)', async () => {
      const ghost = '01900000-0000-7000-8000-0000000fffff';
      expect((await req('GET', `/v1/communications/email-templates/${ghost}`, readJwt)).status).toBe(404);
      expect((await req('PATCH', `/v1/communications/email-templates/${ghost}`, manageJwt, { name: 'x' })).status).toBe(404);
      expect((await req('POST', `/v1/communications/email-templates/${ghost}/deactivate`, manageJwt)).status).toBe(404);
    });

    it('tenant A cannot read/update/deactivate tenant B override (404, no cross-tenant)', async () => {
      const createdB = await req('POST', '/v1/communications/email-templates', manageBJwt, {
        ...validCreate,
        name: 'B contact',
      });
      expect(createdB.status).toBe(201);
      const bId = ((await createdB.json()) as { id: string }).id;

      // Tenant A (manage) tries to touch B's row → 404 (isolation, no enumeration).
      expect((await req('GET', `/v1/communications/email-templates/${bId}`, manageJwt)).status).toBe(404);
      expect((await req('PATCH', `/v1/communications/email-templates/${bId}`, manageJwt, { name: 'x' })).status).toBe(404);
      expect((await req('POST', `/v1/communications/email-templates/${bId}/deactivate`, manageJwt)).status).toBe(404);
    });
  },
);
