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
import { BILLING_PROVIDER_READ_PORT, type BillingProviderReadPort, type ProviderInvoiceState, type ProviderPortalConfigurationState, type ProviderSubscriptionState } from '@aramo/subscription';

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
// CCP-C3 — the read-through billing-status routes read the provider through
// BILLING_PROVIDER_READ_PORT. The verifier overrides that port with an in-memory, Aramo-shaped
// reader (PactBillingReader below): no Stripe, no network, no key. The GET-only Stripe adapter and
// its wire translation are proved separately (libs/subscription stripe-wire.spec.ts C3-W-4/5 and
// ccp-c3-billing-read.spec.ts). Every other port is the real one.
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

/** CCP-C3 — the in-memory read port (READ methods only; the provider states load it). */
class PactBillingReader implements BillingProviderReadPort {
  readonly provider = 'STRIPE' as const;
  readonly subs = new Map<string, ProviderSubscriptionState>();
  readonly invoices = new Map<string, ProviderInvoiceState[]>();
  readonly portals = new Map<string, ProviderPortalConfigurationState>();
  isConfigured(): boolean {
    return true;
  }
  mode(): 'test' | 'live' {
    return 'test';
  }
  async retrieveSubscription(ref: string): Promise<ProviderSubscriptionState> {
    const s = this.subs.get(ref);
    if (s === undefined) throw new Error(`pact reader: no subscription ${ref}`);
    return s;
  }
  async listSubscriptionInvoices(ref: string, limit: number): Promise<ProviderInvoiceState[]> {
    return (this.invoices.get(ref) ?? []).slice(0, limit);
  }
  async retrievePortalConfiguration(ref: string): Promise<ProviderPortalConfigurationState | null> {
    return this.portals.get(ref) ?? null;
  }
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
    const billingReader = new PactBillingReader();

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
        // CCP-C3 — set by the 'a billing portal configuration is set' state.
        STRIPE_PORTAL_CONFIGURATION: undefined,
      };
      for (const [k, v] of Object.entries(env)) {
        savedEnv[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      for (const role of Object.keys(OP) as Role[]) tokens.set(role, await signToken(OP[role], 'platform', PLATFORM_TENANT, kp.privateKey));
      tokens.set('recruiter', await signToken(RECRUITER_ID, 'recruiter', TENANT_2, kp.privateKey));

      module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(BILLING_PROVIDER_READ_PORT).useValue(billingReader).compile();
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
          // CCP-C1 — a FAILED Stripe command (an approved CONVERSION request on a fresh tenant,
          // through the HTTP surface; the command row through its own state machine).
          'a failed billing command exists': async () => {
            const tenant_id = await commercialTenant();
            const out = await asRole<{ request: { id: string } }>('commercial_ops', 'POST', '/platform/commercial/change-requests', {
              action_type: 'CONVERSION',
              tenant_id,
              product_key: 'sign',
              payload: { pact_fixture: 'self_service_to_governed' },
              reason: 'Convert the self-service subscription to a governed one',
              idempotency_key: `pact-c1-state-${String(++seq).padStart(4, '0')}`,
            });
            const id = out.request.id;
            await asRole('commercial_ops', 'POST', `/platform/commercial/change-requests/${id}/submit`);
            await asRole('finance_admin', 'POST', `/platform/commercial/change-requests/${id}/approvals`, { step_index: 0 });
            const cmd = randomUUID();
            await db.query(
              `INSERT INTO subscription."BillingProviderCommand" (id, provider, command_kind, change_request_id, step, idempotency_key, tenant_id, product_key, target_ref, params, state, attempts, created_by, created_at, updated_at)
               VALUES ($1, 'STRIPE', 'SUBSCRIPTION_CANCEL', $2::uuid, 'end_self_service', 'aramo-ccp-' || $2::text || '-end_self_service', $3, 'sign', 'sub_pact_c1', '{"mode":"IMMEDIATE"}', 'PENDING', 0, $4, now(), now())`,
              [cmd, id, tenant_id, OP.commercial_ops],
            );
            await db.query(`UPDATE subscription."BillingProviderCommand" SET state = 'DISPATCHING', attempts = 1, lease_until = now() + interval '5 minutes', updated_at = now() WHERE id = $1`, [cmd]);
            await db.query(
              `UPDATE subscription."BillingProviderCommand" SET state = 'FAILED', failed_at = now(), lease_until = NULL, last_error_code = 'PROVIDER_REFUSED', last_error_detail = 'billing provider unavailable: No such subscription', updated_at = now() WHERE id = $1`,
              [cmd],
            );
            return undefined;
          },
          // CCP-C1 — a FAILED webhook inbox event (its own state machine: RECEIVED → PROCESSING → FAILED).
          'a failed billing webhook event exists': async () => {
            const row = randomUUID();
            await db.query(
              `INSERT INTO subscription."BillingWebhookInbox" (id, provider, provider_event_id, event_type, event_created_at, subscription_ref, product_key, status, attempts, received_at, updated_at)
               VALUES ($1, 'STRIPE', $2, 'invoice.paid', now(), 'sub_pact_c1', 'sign', 'RECEIVED', 0, now(), now())`,
              [row, `evt_pact_c1_${String(++seq).padStart(4, '0')}`],
            );
            await db.query(`UPDATE subscription."BillingWebhookInbox" SET status = 'PROCESSING', attempts = 1, lease_until = now() + interval '5 minutes', updated_at = now() WHERE id = $1`, [row]);
            await db.query(
              `UPDATE subscription."BillingWebhookInbox" SET status = 'FAILED', lease_until = NULL, last_error = 'billing provider unavailable: down', next_attempt_at = now() + interval '1 minute', updated_at = now() WHERE id = $1`,
              [row],
            );
            return undefined;
          },
          // CCP-C3 — a Stripe-owned (SELF_SERVICE) row for the consumer's tenant, and the provider's
          // view of it in the in-memory read port (an open invoice past its due date, and a paid one).
          'a tenant with a Stripe-owned subscription and invoices exists': async (params?: unknown) => {
            const tenant_id = (params as { tenant_id?: unknown } | undefined)?.tenant_id;
            if (typeof tenant_id !== 'string') throw new Error('provider state needs { tenant_id }');
            await commercialTenant(tenant_id);
            const ref = 'sub_pact_c3';
            const account = 'acct_pact_c3';
            await db.query(
              `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by, status, billing_provider, billing_account_ref, billing_subscription_ref)
               SELECT 'cca10000-0000-7000-8000-0000000000d3'::uuid, $1::uuid, p.id, (SELECT v.id FROM subscription."PlanVersion" v WHERE v.plan_id = p.id AND v.status = 'PUBLISHED'), p.product_key, 'BASE', '2026-10-01T00:00:00Z', 'SELF_SERVICE', 'pact-c3', 'PAST_DUE', 'STRIPE', $2, $3
                 FROM subscription."Plan" p WHERE p.key = 'aramo-sign-standard-business-v1'
               ON CONFLICT (id) DO NOTHING`,
              [tenant_id, account, ref],
            );
            billingReader.subs.set(ref, {
              provider: 'STRIPE',
              subscription_ref: ref,
              account_ref: account,
              provider_status: 'past_due',
              current_period_start: new Date('2026-10-01T00:00:00Z'),
              current_period_end: new Date('2026-11-01T00:00:00Z'),
              cancel_at_period_end: false,
              price_ref: 'price_pact_business',
              tenant_id,
              intent_id: null,
              account_country: 'US',
            });
            const invoice = (o: Partial<ProviderInvoiceState>): ProviderInvoiceState => ({
              provider: 'STRIPE',
              invoice_ref: 'in_pact_c3',
              number: 'PACT-0001',
              account_ref: account,
              subscription_ref: ref,
              provider_status: 'open',
              currency: 'usd',
              total_minor: 4900,
              amount_due_minor: 4900,
              amount_paid_minor: 0,
              amount_remaining_minor: 4900,
              created_at: new Date('2026-10-01T00:00:00Z'),
              due_at: new Date('2026-10-15T00:00:00Z'),
              period_start: new Date('2026-09-01T00:00:00Z'),
              period_end: new Date('2026-10-01T00:00:00Z'),
              attempt_count: 2,
              next_attempt_at: null,
              hosted_url: 'https://invoice.test/in_pact_c3',
              document_url: null,
              live: false,
              ...o,
            });
            billingReader.invoices.set(ref, [invoice({}), invoice({ invoice_ref: 'in_pact_c3_0', number: 'PACT-0000', provider_status: 'paid', amount_paid_minor: 4900, amount_remaining_minor: 0 })]);
            return undefined;
          },
          'a billing portal configuration is set': async () => {
            process.env['STRIPE_PORTAL_CONFIGURATION'] = 'bpc_pact_c3';
            billingReader.portals.set('bpc_pact_c3', {
              provider: 'STRIPE',
              configuration_ref: 'bpc_pact_c3',
              active: true,
              is_default: false,
              live: false,
              invoice_history_enabled: true,
              payment_method_update_enabled: true,
              subscription_cancel_enabled: true,
              subscription_cancel_mode: 'at_period_end',
              subscription_update_enabled: false,
            });
            return undefined;
          },
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
