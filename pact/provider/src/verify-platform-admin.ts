import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

import { ValidationPipe, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import { Verifier } from '@pact-foundation/pact';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import cookieParser from 'cookie-parser';
import { SignJWT, exportSPKI, generateKeyPair } from 'jose';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { AppModule } from '@aramo/platform-admin';

// eslint-disable-next-line @nx/enforce-module-boundaries -- test-only real-Postgres support shared with the CCP-A3 specs (TD-A3-19 precedent; CLAUDE.md "one shared test helper")
import { PLATFORM_TENANT, TENANT_2, addOperator, applyCcpA6Schema, revokeRole } from '../../../libs/subscription/src/tests/support/ccp-a3-database.js';

// CCP-A10 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.1 row A10; D11;
// PLATFORM-UX-1 Amendment A1, A1-3) — Pact provider verifier for apps/platform-admin.
//
// Consumer:  platform-web    (pact/consumers/platform-web-consumer)
// Provider:  platform-admin  (apps/platform-admin)
//
// A SEPARATE provider (mirrors verify-sign.ts / verify-ti.ts): boots the REAL
// platform-admin AppModule — real JwtAuthGuard, RolesGuard, the identity RBAC
// resolver (no resolver override) and the real CommercialChangeRequestService —
// against a Postgres testcontainer holding the identity, entitlement, metering and EVERY
// subscription migration (CCP-A2…A6: an apply writes the subscription and the entitlement
// in one transaction), applied whole-file in order by the shared CCP helper
// (libs/subscription/src/tests/support/ccp-a3-database.ts, applyCcpA6Schema). One attested
// operator per CCP role + super_admin is seeded in the platform sentinel tenant; the
// consumer's placeholder session cookie (`pact-<role>`) is rewritten to a real RS256
// token for that operator, so every allowed and refused interaction is decided by the
// production authorization path.
//
// Provider states seed through the service's OWN HTTP surface (create + submit as
// commercial_ops), so the seeded rows are exactly what production writes; each state
// gets a fresh commercial tenant (append-only rows; Q14 one open request per tenant ×
// product).
//
// CCP route coverage gate: before verifying, the verifier enumerates every route the
// booted AppModule registers under /platform/commercial and fails if any lacks an
// allowed interaction, a super_admin refusal or a tenant-tier refusal in the pact
// (the A10 HALT condition "a CCP route without a contract", made mechanical).
//
// Gated on ARAMO_RUN_PACT_PROVIDER=1 (same as verify.ts / verify-api.ts / verify-sign.ts / verify-ti.ts).

const ROOT = resolve(__dirname, '../../..');
const PACT_FILE = resolve(ROOT, 'pact/pacts/platform-web-platform-admin.json');

// MUST match pact/consumers/platform-web-consumer/src/platform-commercial.consumer.test.ts.
const OP = {
  platform_owner: 'cca10000-0000-7000-8000-000000000001',
  finance_admin: 'cca10000-0000-7000-8000-000000000002',
  commercial_ops: 'cca10000-0000-7000-8000-000000000003',
  catalog_manager: 'cca10000-0000-7000-8000-000000000004',
  support_admin: 'cca10000-0000-7000-8000-000000000005',
  read_only_auditor: 'cca10000-0000-7000-8000-000000000006',
  super_admin: 'cca10000-0000-7000-8000-000000000007',
} as const;
type Role = keyof typeof OP;
const RECRUITER_ID = 'cca10000-0000-7000-8000-000000000010';
const PLATFORM_COOKIE = 'aramo_access_token_platform';
const RECRUITER_COOKIE = 'aramo_access_token_recruiter';
const AUTH_ISSUER = 'Aramo Core Auth'; // the issuer JwtAuthGuard pins
const AUTH_AUDIENCE = 'aramo-pact-provider-platform-admin-audience';
const CCP_PREFIX = '/platform/commercial';
const UUID_SEGMENT = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi;

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
const isRole = (v: string): v is Role => Object.prototype.hasOwnProperty.call(OP, v);

// ── CCP route coverage (controller metadata vs. the pact file) ────────────────

type Ctor = abstract new (...args: never[]) => unknown;
function collectControllers(mod: unknown, seen = new Set<unknown>(), out: Ctor[] = []): Ctor[] {
  if (mod === undefined || mod === null || seen.has(mod)) return out;
  seen.add(mod);
  const ctrls = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, mod as object) ?? []) as Ctor[];
  out.push(...ctrls.filter((c) => !out.includes(c)));
  for (const child of (Reflect.getMetadata(MODULE_METADATA.IMPORTS, mod as object) ?? []) as unknown[]) {
    collectControllers((child as { module?: unknown })?.module ?? child, seen, out);
  }
  return out;
}

const join = (...parts: string[]): string =>
  '/' + parts.flatMap((p) => p.split('/')).filter((p) => p.length > 0).join('/');

/** `METHOD /path/:param` for every route the AppModule's controllers declare. */
function declaredRoutes(): string[] {
  const routes: string[] = [];
  for (const ctrl of collectControllers(AppModule)) {
    const base = String(Reflect.getMetadata(PATH_METADATA, ctrl) ?? '');
    const proto = (ctrl as unknown as { prototype: Record<string, unknown> }).prototype;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined) continue;
      const sub = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
      routes.push(`${RequestMethod[method]} ${join(base, sub).replace(/:[A-Za-z_]+/g, ':id')}`);
    }
  }
  return routes;
}

interface PactInteraction {
  request: { method: string; path: string; headers?: Record<string, string | string[]> };
  response: { status: number };
}
const headerOf = (h: Record<string, string | string[]> | undefined, name: string): string => {
  const hit = Object.entries(h ?? {}).find(([k]) => k.toLowerCase() === name);
  return hit === undefined ? '' : Array.isArray(hit[1]) ? hit[1].join('; ') : hit[1];
};

/** Per CCP route: [allowed 2xx, super_admin refused, tenant tier refused] interaction counts. */
function pactCoverage(): Map<string, { allowed: number; superAdmin: number; tenantTier: number; total: number }> {
  const pact = JSON.parse(readFileSync(PACT_FILE, 'utf8')) as { interactions: PactInteraction[] };
  const out = new Map<string, { allowed: number; superAdmin: number; tenantTier: number; total: number }>();
  for (const i of pact.interactions) {
    const key = `${i.request.method.toUpperCase()} ${i.request.path.replace(UUID_SEGMENT, '/:id')}`;
    const row = out.get(key) ?? { allowed: 0, superAdmin: 0, tenantTier: 0, total: 0 };
    const cookie = headerOf(i.request.headers, 'cookie');
    row.total += 1;
    if (i.response.status >= 200 && i.response.status < 300) row.allowed += 1;
    if (i.response.status === 403 && cookie.includes(`${PLATFORM_COOKIE}=pact-super_admin`)) row.superAdmin += 1;
    if (i.response.status === 403 && cookie.includes(`${RECRUITER_COOKIE}=`)) row.tenantTier += 1;
    out.set(key, row);
  }
  return out;
}

describe.skipIf(process.env['ARAMO_RUN_PACT_PROVIDER'] !== '1')(
  'pact provider verification — platform-admin (apps/platform-admin)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let module: TestingModule;
    let app: NestExpressApplication;
    let baseUrl = '';
    const tokens = new Map<string, string>();
    const savedEnv: Partial<Record<string, string | undefined>> = {};
    let seq = 0;
    let signingKey: SigningKey;

    async function signToken(sub: string, consumer_type: 'platform' | 'recruiter', tenant_id: string, key: SigningKey): Promise<string> {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ sub, actor_kind: 'user', consumer_type, tenant_id, authz_version: 1 })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
        .setIssuer(AUTH_ISSUER)
        .setAudience(AUTH_AUDIENCE)
        .setSubject(sub)
        .setIssuedAt(now)
        .setExpirationTime(now + 60 * 60)
        .sign(key);
    }

    async function asRole<T>(role: Role | { token: string }, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
      const bearer = typeof role === 'string' ? (tokens.get(role) ?? '') : role.token;
      const headers: Record<string, string> = { authorization: `Bearer ${bearer}`, accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(`${baseUrl}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const text = await res.text();
      if (res.status < 200 || res.status >= 300) throw new Error(`seed ${method} ${path} as ${role} → ${res.status} ${text}`);
      return JSON.parse(text) as T;
    }

    async function commercialTenant(id: string = randomUUID()): Promise<string> {
      await db.query(`INSERT INTO identity."Tenant" (id, name, updated_at) VALUES ($1, $2, now()) ON CONFLICT (id) DO NOTHING`, [id, `Pact Commercial ${id.slice(-4)}`]);
      return id;
    }

    /** A below-threshold USD credit (finance-only chain) on a fresh tenant, created by commercial_ops. */
    async function draftRequest(): Promise<string> {
      const tenant_id = await commercialTenant();
      const out = await asRole<{ request: { id: string } }>('commercial_ops', 'POST', '/platform/commercial/change-requests', {
        action_type: 'CREDIT',
        tenant_id,
        product_key: 'sign',
        payload: { amount_minor: 100, currency: 'USD' },
        reason: 'Goodwill credit for a service outage',
        idempotency_key: `pact-a10-state-${String(++seq).padStart(4, '0')}`,
      });
      return out.request.id;
    }

    /**
     * CCP-A6 — an APPROVED SUBSCRIPTION_OPEN on a fresh tenant, through the service's own HTTP
     * surface: created and submitted by commercial_ops, approved by `approver` (a finance_admin).
     */
    async function approvedOpen(approver: Role | { token: string } = 'finance_admin'): Promise<string> {
      const tenant_id = await commercialTenant();
      const v = await db.query(`SELECT v.id FROM subscription."PlanVersion" v JOIN subscription."Plan" p ON p.id = v.plan_id WHERE p.key = 'aramo-sign-included-v1' AND v.status = 'PUBLISHED'`);
      const out = await asRole<{ request: { id: string } }>('commercial_ops', 'POST', '/platform/commercial/change-requests', {
        action_type: 'SUBSCRIPTION_OPEN',
        tenant_id,
        product_key: 'sign',
        payload: { plan_key: 'aramo-sign-included-v1', plan_version_id: v.rows[0].id, replaces_subscription_id: null },
        reason: 'Open the governed Aramo Sign subscription',
        idempotency_key: `pact-a6-state-${String(++seq).padStart(4, '0')}`,
      });
      const id = out.request.id;
      await asRole('commercial_ops', 'POST', `/platform/commercial/change-requests/${id}/submit`);
      await asRole(approver, 'POST', `/platform/commercial/change-requests/${id}/approvals`, { step_index: 0 });
      return id;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      // identity + metering + subscription (A2, A3) whole-file, plus the platform sentinel
      // tenant, two commercial tenants and the CCP A1 §4.1 role/scope catalog.
      await applyCcpA6Schema(db);
      for (const role of Object.keys(OP) as Role[]) await addOperator(db, [role], { id: OP[role] });

      const kp = await generateKeyPair('RS256');
      signingKey = kp.privateKey;
      const env: Record<string, string | undefined> = {
        DATABASE_URL: url,
        AUTH_AUDIENCE,
        AUTH_PUBLIC_KEY: await exportSPKI(kp.publicKey),
        MAILER_PROVIDER: 'stub',
        // In-memory authorization scope cache (no Redis in the harness).
        REDIS_URL: undefined,
        // Background sweepers off: the verifier exercises the HTTP surface only.
        SIGN_PERSONAL_SIGNUP_PURGE_ENABLED: '0',
        DOMAIN_CLAIM_SWEEP_ENABLED: undefined,
        SIGN_PERSONAL_LAPSE_SWEEP_ENABLED: undefined,
      };
      for (const [k, v] of Object.entries(env)) {
        savedEnv[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      for (const role of Object.keys(OP) as Role[]) tokens.set(role, await signToken(OP[role], 'platform', PLATFORM_TENANT, kp.privateKey));
      tokens.set('recruiter', await signToken(RECRUITER_ID, 'recruiter', TENANT_2, kp.privateKey));

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = module.createNestApplication<NestExpressApplication>({ logger: ['error', 'warn'] });
      // Mirror apps/platform-admin/src/main.ts: cookie-parser, then the ValidationPipe.
      app.use(cookieParser());
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
      await app.init();
      const server = await app.listen(0);
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }, 600_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 120_000);

    it('covers every CCP route the AppModule registers (allowed + super_admin + tenant tier)', () => {
      const ccp = declaredRoutes().filter((r) => r.split(' ')[1]?.startsWith(CCP_PREFIX));
      const coverage = pactCoverage();
      const gaps = ccp.filter((r) => {
        const c = coverage.get(r);
        return c === undefined || c.allowed === 0 || c.superAdmin === 0 || c.tenantTier === 0;
      });
      expect(ccp.length).toBeGreaterThan(0);
      expect(gaps, `CCP routes without a full contract: ${gaps.join(', ')}`).toEqual([]);
    });

    it('verifies the platform-web → platform-admin pact', async () => {
      const verifier = new Verifier({
        provider: 'platform-admin',
        providerBaseUrl: baseUrl,
        pactUrls: [PACT_FILE],
        logLevel: 'warn',
        // The consumer's PLACEHOLDER session cookie names a role (`pact-<role>`); swap
        // in the real RS256 token for that seeded principal. A request without a session
        // cookie (the 401 interaction) is forwarded untouched.
        requestFilter: (req, _res, next) => {
          const cookie = req.headers['cookie'];
          if (typeof cookie === 'string') {
            const platform = new RegExp(`${PLATFORM_COOKIE}=pact-([a-z_]+)`).exec(cookie);
            if (platform !== null && platform[1] !== undefined && isRole(platform[1])) {
              req.headers['cookie'] = `${PLATFORM_COOKIE}=${tokens.get(platform[1]) ?? ''}`;
            } else if (cookie.includes(`${RECRUITER_COOKIE}=pact-recruiter`)) {
              req.headers['cookie'] = `${RECRUITER_COOKIE}=${tokens.get('recruiter') ?? ''}`;
            }
          }
          next();
        },
        stateHandlers: {
          'platform operators are provisioned': async () => undefined,
          // The CCP-A2 migration seeds the policy v1 activation audit row.
          'the commercial policy activation is audited': async () => undefined,
          'a commercial tenant without an open change request exists': async (params?: unknown) => {
            const id = (params as { tenant_id?: unknown } | undefined)?.tenant_id;
            if (typeof id !== 'string') throw new Error('provider state needs { tenant_id }');
            await commercialTenant(id);
            return undefined;
          },
          'a draft change request exists': async () => ({ requestId: await draftRequest() }),
          // CCP-A6 — the transactional apply.
          'an approved subscription-open change request exists': async () => ({ requestId: await approvedOpen() }),
          'an approved subscription-open change request whose approver lost eligibility exists': async () => {
            // A dedicated attested finance_admin signs, then loses the role (NC-5): the seeded
            // per-role operators are left untouched for every other interaction.
            const signer = await addOperator(db, ['finance_admin']);
            const requestId = await approvedOpen({ token: await signToken(signer, 'platform', PLATFORM_TENANT, signingKey) });
            await revokeRole(db, signer, 'finance_admin');
            return { requestId };
          },
          'a pending change request exists': async () => {
            const requestId = await draftRequest();
            await asRole('commercial_ops', 'POST', `/platform/commercial/change-requests/${requestId}/submit`);
            return { requestId };
          },
        },
      });
      await verifier.verifyProvider();
    }, 600_000);
  },
);
