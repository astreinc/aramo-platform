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
import { BILLING_PROVIDER_READ_PORT, SubscriptionPrismaService, UsageRollupService, type BillingProviderReadPort, type ProviderInvoiceState, type ProviderPortalConfigurationState, type ProviderSubscriptionState } from '@aramo/subscription';

// eslint-disable-next-line @nx/enforce-module-boundaries -- test-only real-Postgres support shared with the CCP-A3 specs (TD-A3-19 precedent; CLAUDE.md "one shared test helper")
import { PLATFORM_TENANT, TENANT_2, addOperator, applyCcpA6Schema, revokeRole } from '../../../libs/subscription/src/tests/support/ccp-a3-database.js';
// eslint-disable-next-line @nx/enforce-module-boundaries -- test-only real-Postgres support shared with the CCP-D1 specs (same precedent)
import { seedUsageTenant } from '../../../libs/subscription/src/tests/support/ccp-d1-database.js';

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
// subscription migration (CCP-A2…A6, A8: an apply writes the subscription and the entitlement
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
// CCP-B5 adds two provider states for the policy screen (one DRAFT may exist at a time,
// globally): 'no draft commercial policy version exists' moves any DRAFT out of DRAFT using
// only the transitions the A2 policy trigger permits (the DRAFT is activated and retired,
// and v1 is re-activated, so v1 keeps its id, content and checksum); and 'a draft commercial
// policy version exists' returns the DRAFT's id, creating one through the HTTP surface as
// finance_admin when none exists.
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
// CCP-C6 — MUST match the consumer's FIN_* tenants.
const FIN = {
  renewal: 'cca10000-0000-7000-8000-0000000006a1',
  outstanding: 'cca10000-0000-7000-8000-0000000006a2',
  held: 'cca10000-0000-7000-8000-0000000006a3',
} as const;
const PLATFORM_COOKIE = 'aramo_access_token_platform';
const RECRUITER_COOKIE = 'aramo_access_token_recruiter';
const AUTH_ISSUER = 'Aramo Core Auth'; // the issuer JwtAuthGuard pins
const AUTH_AUDIENCE = 'aramo-pact-provider-platform-admin-audience';
const CCP_PREFIX = '/platform/commercial';
// CCP-D1 — MUST match the consumer's USAGE_TENANT / USAGE_SUBSCRIPTION.
const USAGE_TENANT = 'cca10000-0000-7000-8000-0000000000d1';
const USAGE_SUBSCRIPTION = 'cca10000-0000-7000-8000-0000000000d2';
// CCP-B3 — MUST match the consumer's B3_TENANT.
const B3_TENANT = 'cca10000-0000-7000-8000-0000000003b1';
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
    let usagePrisma: SubscriptionPrismaService;
    let usage: UsageRollupService;
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
    /**
     * CCP-B2-backend — an APPROVED PLAN_VERSION_PUBLISH of a fresh DRAFT version (a test-only plan
     * copied from the included plan's live rows, its v1 PUBLISHED), requested by catalog_manager and
     * approved finance_admin → platform_owner, through the service's own HTTP surface.
     */
    async function approvedPublish(): Promise<string> {
      const plan = randomUUID();
      await db.query(
        `INSERT INTO subscription."Plan" (id, key, name, sellable, description, tenant_kind, sales_model, status, display_order, product_key)
         SELECT $1::uuid, $2, 'Pact B2', false, description, tenant_kind, sales_model, 'ACTIVE', 980, product_key FROM subscription."Plan" WHERE key = 'aramo-sign-included-v1'`,
        [plan, `aramo-sign-pact-b2-${plan.slice(0, 8)}`],
      );
      for (const [n, status] of [[1, 'PUBLISHED'], [2, 'DRAFT']] as const) {
        const v = await db.query(
          `INSERT INTO subscription."PlanVersion" (id, plan_id, version_number, status, content, content_checksum, created_by, created_at)
           SELECT gen_random_uuid(), $1::uuid, $2, 'DRAFT', x.c, subscription.ccp_plan_version_checksum(x.c), 'pact', now()
             FROM (SELECT subscription.ccp_plan_live_content($1::uuid) AS c) x RETURNING id`,
          [plan, n],
        );
        if (status === 'PUBLISHED') await db.query(`UPDATE subscription."PlanVersion" SET status = 'PUBLISHED', published_at = now() WHERE id = $1`, [v.rows[0].id]);
        else {
          const out = await asRole<{ request: { id: string } }>('catalog_manager', 'POST', '/platform/commercial/change-requests', {
            action_type: 'PLAN_VERSION_PUBLISH',
            payload: { plan_version_id: v.rows[0].id },
            reason: 'Publish version 2 of the plan',
            idempotency_key: `pact-b2-state-${String(++seq).padStart(4, '0')}`,
          });
          const id = out.request.id;
          await asRole('catalog_manager', 'POST', `/platform/commercial/change-requests/${id}/submit`);
          await asRole('finance_admin', 'POST', `/platform/commercial/change-requests/${id}/approvals`, { step_index: 0 });
          await asRole('platform_owner', 'POST', `/platform/commercial/change-requests/${id}/approvals`, { step_index: 1 });
          return id;
        }
      }
      throw new Error('unreachable');
    }

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

    /**
     * CCP-B2 — a fresh Sign plan (its own key, so one-DRAFT-per-plan never collides across
     * interactions) with a monthly envelope allowance and a storage capacity, and its v1
     * published from the live rows (DRAFT then PUBLISHED, as the A5 guard trigger requires).
     */
    async function freshPlan(): Promise<{ planId: string; versionId: string; checksum: string }> {
      const planId = randomUUID();
      const n = String(++seq).padStart(4, '0');
      await db.query(
        `INSERT INTO subscription."Plan" (id, key, name, product_key, sales_model, status, sellable, list_price_minor, currency, billing_interval, display_order)
         VALUES ($1, $2, $3, 'sign', 'SELF_SERVICE', 'ACTIVE', false, 1900, 'USD', 'MONTH', 500)`,
        [planId, `pact-b2-plan-${n}`, `Pact Plan ${n}`],
      );
      await db.query(`INSERT INTO subscription."PlanAllowance" (plan_id, allowance_key, included_quantity, unlimited, period) VALUES ($1, 'sign.envelopes', 100, false, 'MONTHLY')`, [planId]);
      await db.query(`INSERT INTO subscription."PlanCapacity" (plan_id, capacity_key, limit_quantity, unlimited) VALUES ($1, 'sign.storage_bytes', 5368709120, false)`, [planId]);
      const v = await db.query<{ id: string; content_checksum: string }>(
        `INSERT INTO subscription."PlanVersion" (id, plan_id, version_number, status, content, content_checksum, created_by, created_at)
         SELECT gen_random_uuid(), $1::uuid, 1, 'DRAFT', x.c, subscription.ccp_plan_version_checksum(x.c), 'pact', now()
           FROM (SELECT subscription.ccp_plan_live_content($1::uuid) AS c) x
         RETURNING id, content_checksum`,
        [planId],
      );
      const row = v.rows[0]!;
      await db.query(`UPDATE subscription."PlanVersion" SET status = 'PUBLISHED', published_at = now() WHERE id = $1`, [row.id]);
      return { planId, versionId: row.id, checksum: row.content_checksum };
    }

    /**
     * CCP-B4 — an enterprise contract recorded through the governed path: an APPLIED
     * SUBSCRIPTION_OPEN carrying a `contract` block, on a fresh tenant (created and submitted by
     * commercial_ops, approved by finance_admin, applied by commercial_ops).
     */
    async function recordedContract(tenant_id_in?: string): Promise<string> {
      const tenant_id = await commercialTenant(tenant_id_in);
      const v = await db.query(`SELECT v.id FROM subscription."PlanVersion" v JOIN subscription."Plan" p ON p.id = v.plan_id WHERE p.key = 'aramo-sign-included-v1' AND v.status = 'PUBLISHED'`);
      const n = String(++seq).padStart(4, '0');
      const out = await asRole<{ request: { id: string } }>('commercial_ops', 'POST', '/platform/commercial/change-requests', {
        action_type: 'SUBSCRIPTION_OPEN',
        tenant_id,
        product_key: 'sign',
        payload: {
          plan_key: 'aramo-sign-included-v1',
          plan_version_id: v.rows[0].id,
          replaces_subscription_id: null,
          contract: {
            contract_ref: `CT-PACT-${n}`,
            terms: ['Invoiced monthly, net 30'],
            documents: [{ name: 'Order form OF-8034.pdf', sha256: 'a'.repeat(63) + (seq % 10), byte_size: 1024, media_type: 'application/pdf' }],
            evidence_ref: 'Order form OF-8034',
          },
        },
        reason: 'Record the enterprise contract with the governed open',
        idempotency_key: `pact-b4-state-${n}`,
      });
      const id = out.request.id;
      await asRole('commercial_ops', 'POST', `/platform/commercial/change-requests/${id}/submit`);
      await asRole('finance_admin', 'POST', `/platform/commercial/change-requests/${id}/approvals`, { step_index: 0 });
      await asRole('commercial_ops', 'POST', `/platform/commercial/change-requests/${id}/apply`);
      const c = await db.query(`SELECT id FROM subscription."Contract" WHERE recorded_by_change_request_id = $1`, [id]);
      return c.rows[0].id as string;
    }

    /** CCP-C2 — an open governed (MANUAL) BASE row of the tenant, raw (a pre-existing subscription). */
    async function governedRow(tenant_id: string): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by)
         SELECT $1::uuid, $2::uuid, p.id, (SELECT v.id FROM subscription."PlanVersion" v WHERE v.plan_id = p.id AND v.status = 'PUBLISHED'), 'sign', 'BASE', now(), 'MANUAL', 'pact-c2' FROM subscription."Plan" p WHERE p.key = 'aramo-sign-included-v1'`,
        [id, tenant_id],
      );
      return id;
    }

    /** CCP-C2 — an APPROVED CONVERSION on `tenant_id` through the HTTP surface (commercial_ops requests, finance_admin approves). */
    async function approvedConversion(tenant_id: string, payload: Record<string, unknown>): Promise<string> {
      const out = await asRole<{ request: { id: string } }>('commercial_ops', 'POST', '/platform/commercial/change-requests', {
        action_type: 'CONVERSION',
        tenant_id,
        product_key: 'sign',
        payload,
        reason: 'Convert the Aramo Sign subscription',
        idempotency_key: `pact-c2-state-${String(++seq).padStart(4, '0')}`,
      });
      const id = out.request.id;
      await asRole('commercial_ops', 'POST', `/platform/commercial/change-requests/${id}/submit`);
      await asRole('finance_admin', 'POST', `/platform/commercial/change-requests/${id}/approvals`, { step_index: 0 });
      return id;
    }

    /**
     * CCP-A8 — a commercial tenant holding a Stripe-owned (SELF_SERVICE, provider-linked) Sign row,
     * PAST_DUE, whose grace ended a day ago: the target of a support extension. Fixed ids from the
     * consumer (its request body names them).
     */
    async function pastDueStripeRow(tenant_id: string, subscription_id: string): Promise<void> {
      await commercialTenant(tenant_id);
      await db.query(
        `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by, status, grace_until, billing_provider, billing_account_ref, billing_subscription_ref)
         SELECT $1::uuid, $2::uuid, p.id, (SELECT v.id FROM subscription."PlanVersion" v WHERE v.plan_id = p.id AND v.status = 'PUBLISHED'), p.product_key, 'BASE', now() - interval '20 days', 'SELF_SERVICE', 'pact-a8', 'PAST_DUE', now() - interval '1 day', 'STRIPE', $3, $4
           FROM subscription."Plan" p WHERE p.key = 'aramo-sign-standard-business-v1'
         ON CONFLICT (id) DO NOTHING`,
        [subscription_id, tenant_id, `acct_${tenant_id}`, `sub_${subscription_id}`],
      );
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      // identity + metering + subscription (A2, A3) whole-file, plus the platform sentinel
      // tenant, two commercial tenants and the CCP A1 §4.1 role/scope catalog.
      await applyCcpA6Schema(db);
      // CCP-D1 — the usage tenant (MANUAL Sign subscription with ledger usage) and the worker
      // the usage provider states drive (the AppModule's own worker stays off: unset env).
      await seedUsageTenant(db, USAGE_TENANT, USAGE_SUBSCRIPTION);
      usagePrisma = new SubscriptionPrismaService(url);
      await usagePrisma.$connect();
      usage = new UsageRollupService(usagePrisma);
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
        CCP_USAGE_ROLLUP_ENABLED: undefined,
        // CCP-C3 — set by the 'a billing portal configuration is set' state.
        STRIPE_PORTAL_CONFIGURATION: undefined,
        // CCP-D3 — the alert scanner stays off; the alert states below seed the register.
        CCP_ALERTS_ENABLED: undefined,
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
      await usagePrisma?.$disconnect();
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
          // CCP-B2-backend — the catalog publish through the same apply route.
          'an approved plan-version publish change request exists': async () => ({ requestId: await approvedPublish() }),
          // CCP-C1 — a FAILED Stripe command (an approved CONVERSION request on a fresh tenant,
          // through the HTTP surface; the command row through its own state machine).
          'a failed billing command exists': async () => {
            const tenant_id = await commercialTenant();
            const out = await asRole<{ request: { id: string } }>('commercial_ops', 'POST', '/platform/commercial/change-requests', {
              action_type: 'CONVERSION',
              tenant_id,
              product_key: 'sign',
              // CCP-C2 — a structurally valid CONVERSION payload (the C2 schema is enforced at create).
              payload: { direction: 'TO_GOVERNED', subscription_id: randomUUID(), plan_key: 'aramo-sign-included-v1', plan_version_id: randomUUID() },
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
          // CCP-C6 — the Finance fixtures, one fixed tenant each (idempotent: seeded once):
          //   renewal      a MANUAL Standard Business row whose commitment ends in 20 days;
          //   outstanding  a SELF_SERVICE Standard Business row PAST_DUE, in grace;
          //   held         a governed MANUAL row + a CREATED checkout intent + the open
          //                governed_subscription_open flag (Conv. C-7 hold), core + sign granted.
          // Rows are written as the lifecycle and the A6 hold write them (raw: the provider has no
          // billing key, so no provider activation can run here).
          'finance records exist': async () => {
            const seeded = await db.query(`SELECT 1 FROM identity."Tenant" WHERE id = $1`, [FIN.held]);
            if (seeded.rowCount !== 0) return undefined;
            for (const [k, id] of Object.entries(FIN)) {
              await db.query(`INSERT INTO identity."Tenant" (id, name, updated_at) VALUES ($1, $2, now())`, [id, `Pact Finance ${k}`]);
            }
            const sub = (tenant: string, plan: string, source: string, extra: { status?: string; ref?: string | null; commitment_end?: string; grace?: string; period_end?: string }) =>
              db.query(
                `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by, status, billing_provider, billing_account_ref, billing_subscription_ref,
                                                              commitment_start, commitment_end, grace_until, current_period_end, provider_state_at)
                 SELECT $1::uuid, $2::uuid, p.id, (SELECT v.id FROM subscription."PlanVersion" v WHERE v.plan_id = p.id AND v.status = 'PUBLISHED'), p.product_key, 'BASE', now() - interval '345 days', $3, 'pact-c6', $4,
                        CASE WHEN $5::text IS NULL THEN NULL ELSE 'STRIPE' END, CASE WHEN $5::text IS NULL THEN NULL ELSE 'acct_pact_c6' END, $5::text,
                        CASE WHEN $6::text IS NULL THEN NULL ELSE now() - interval '345 days' END, now() + ($6::text)::interval, now() + ($7::text)::interval, now() + ($8::text)::interval,
                        CASE WHEN $5::text IS NULL THEN NULL ELSE now() END
                   FROM subscription."Plan" p WHERE p.key = $9`,
                [randomUUID(), tenant, source, extra.status ?? 'ACTIVE', extra.ref ?? null, extra.commitment_end ?? null, extra.grace ?? null, extra.period_end ?? null, plan],
              );
            await sub(FIN.renewal, 'aramo-sign-standard-business-v1', 'MANUAL', { commitment_end: '20 days' });
            await sub(FIN.outstanding, 'aramo-sign-standard-business-v1', 'SELF_SERVICE', { status: 'PAST_DUE', ref: 'sub_pact_c6_outstanding', grace: '5 days', period_end: '20 days' });
            await sub(FIN.held, 'aramo-sign-included-v1', 'MANUAL', {});
            await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1, 'core'), ($1, 'sign') ON CONFLICT DO NOTHING`, [FIN.held]);
            const intent = randomUUID();
            await db.query(
              `INSERT INTO subscription."CheckoutIntent" (id, tenant_id, user_id, plan_id, provider, provider_session_ref) SELECT $1::uuid, $2::uuid, 'pact-owner', p.id, 'STRIPE', 'cs_pact_c6_held' FROM subscription."Plan" p WHERE p.key = 'aramo-sign-standard-business-v1'`,
              [intent, FIN.held],
            );
            await db.query(
              `INSERT INTO subscription."BillingReconciliationFlag" (id, tenant_id, provider, subscription_ref, intent_id, reason, account_country) VALUES ($1, $2, 'STRIPE', 'sub_pact_c6_held', $3, 'governed_subscription_open', 'US')`,
              [randomUUID(), FIN.held, intent],
            );
            return undefined;
          },
          // CCP-D3 — an OPEN alert row (the register's INSERT rule: OPEN, one detection). The
          // scanner is off in the verifier, so the row is what the route reads.
          'an open billing alert exists': async () => {
            await db.query(
              `INSERT INTO subscription."CommercialOperationalAlert" (id, alert_type, family, subject_kind, subject_id, tenant_id, product_key, status, detail, evidence, detection_count, first_detected_at, last_detected_at, updated_at)
               VALUES ($1, 'COMMAND_FAILED', 'BILLING', 'billing_command', $2, $3, 'sign', 'OPEN', 'SUBSCRIPTION_CANCEL FAILED PROVIDER_REFUSED after 1 attempt(s)', '{"state":"FAILED","failure_code":"PROVIDER_REFUSED"}', 1, now(), now(), now())`,
              [randomUUID(), randomUUID(), await commercialTenant()],
            );
            return undefined;
          },
          'an open approval alert exists': async () => {
            await db.query(
              `INSERT INTO subscription."CommercialOperationalAlert" (id, alert_type, family, subject_kind, subject_id, tenant_id, product_key, status, detail, evidence, detection_count, first_detected_at, last_detected_at, updated_at)
               VALUES ($1, 'APPLY_FAILED', 'APPROVAL', 'change_request', $2, $3, 'sign', 'OPEN', 'SUBSCRIPTION_OPEN apply failed after 1 attempt(s); retryable', '{"state":"APPLY_FAILED","apply_attempts":1}', 1, now(), now(), now())`,
              [randomUUID(), randomUUID(), await commercialTenant()],
            );
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
          // CCP-D1 — a REBUILD makes the derived roll-ups equal the ledger again (each state sets itself).
          'usage roll-ups are reconciled': async () => {
            const r = await usage.run({ rebuild: true });
            if (r.status !== 'COMPLETED' || r.metrics[0]?.reconciliation !== 'RECONCILED') throw new Error(`usage roll-ups did not reconcile: ${JSON.stringify(r)}`);
            return undefined;
          },
          'usage roll-ups do not reconcile': async () => {
            await usage.run({ rebuild: true });
            await db.query(`UPDATE subscription."UsageRollupPeriod" SET reserved_count = reserved_count + 1 WHERE tenant_id = $1::uuid AND period_start = '2026-10-01T00:00:00Z'`, [USAGE_TENANT]);
            return undefined;
          },
          // CCP-B2 — the catalog. The A5 migration publishes v1 of every A1 catalog plan.
          'the Sign catalog holds its published v1 versions': async () => undefined,
          'a published plan version with a pinned subscription exists': async () => {
            const plan = await freshPlan();
            const tenant = await commercialTenant();
            await db.query(
              `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by)
               VALUES ($1, $2, $3, $4, 'sign', 'BASE', now(), 'MANUAL', 'pact')`,
              [randomUUID(), tenant, plan.planId, plan.versionId],
            );
            return { versionId: plan.versionId, checksum: plan.checksum };
          },
          'a plan without a draft version exists': async () => {
            const plan = await freshPlan();
            return { planId: plan.planId, versionId: plan.versionId };
          },
          'a draft plan version exists': async () => {
            const plan = await freshPlan();
            const out = await asRole<{ version: { id: string; content_checksum: string } }>('catalog_manager', 'POST', `/platform/commercial/catalog/plans/${plan.planId}/drafts`, { from_version_id: plan.versionId });
            return { planId: plan.planId, versionId: out.version.id, checksum: out.version.content_checksum, publishedVersionId: plan.versionId };
          },
          // CCP-B5 — the policy screen states (see the header).
          'no draft commercial policy version exists': async () => {
            const drafts = (await db.query(`SELECT id FROM subscription."CommercialPolicyVersion" WHERE status = 'DRAFT'`)).rows as Array<{ id: string }>;
            for (const d of drafts) {
              await db.query('BEGIN');
              const prev = (await db.query(`UPDATE subscription."CommercialPolicyVersion" SET status = 'RETIRED', retired_at = now() WHERE status = 'ACTIVE' RETURNING id`)).rows[0] as { id: string };
              await db.query(`UPDATE subscription."CommercialPolicyVersion" SET status = 'ACTIVE', activated_at = now() WHERE id = $1`, [d.id]);
              await db.query(`UPDATE subscription."CommercialPolicyVersion" SET status = 'RETIRED', retired_at = now() WHERE id = $1`, [d.id]);
              await db.query(`UPDATE subscription."CommercialPolicyVersion" SET status = 'ACTIVE', activated_at = now(), retired_at = NULL WHERE id = $1`, [prev.id]);
              await db.query('COMMIT');
            }
            return undefined;
          },
          'a draft commercial policy version exists': async () => {
            const existing = (await db.query(`SELECT id FROM subscription."CommercialPolicyVersion" WHERE status = 'DRAFT'`)).rows[0] as { id: string } | undefined;
            if (existing !== undefined) return { versionId: existing.id };
            const out = await asRole<{ version: { id: string } }>('finance_admin', 'POST', '/platform/commercial/policy-versions', { source_version_id: '019a0000-0000-7000-8000-0000000cc201' });
            return { versionId: out.version.id };
          },
          // CCP-B4 — enterprise contract records.
          'an enterprise contract exists': async () => ({ contractId: await recordedContract() }),
          // CCP-B3 — the Commercial tab fixture (seeded once; every read is read-only): a governed
          // MANUAL Sign row with its contract (SUBSCRIPTION_OPEN + contract, through the HTTP
          // surface; the plan grants core + sign as PLAN), a HELD activation (an older checkout
          // intent + an open governed_subscription_open flag, Conv. C-7/C-8), and a PENDING_APPROVAL
          // self-service → governed CONVERSION naming the held subscription (the open request).
          'a tenant with a governed Sign subscription and a held activation exists': async () => {
            const seeded = await db.query(`SELECT 1 FROM subscription."TenantSubscription" WHERE tenant_id = $1`, [B3_TENANT]);
            if (seeded.rowCount !== 0) return undefined;
            const contractId = await recordedContract(B3_TENANT);
            const gov = (await db.query(`SELECT tenant_subscription_id::text AS id FROM subscription."Contract" WHERE id = $1`, [contractId])).rows[0].id as string;
            const intent = randomUUID();
            await db.query(
              `INSERT INTO subscription."CheckoutIntent" (id, tenant_id, user_id, plan_id, provider, provider_session_ref) SELECT $1::uuid, $2::uuid, 'pact-owner', p.id, 'STRIPE', 'cs_pact_b3_held' FROM subscription."Plan" p WHERE p.key = 'aramo-sign-standard-business-v1'`,
              [intent, B3_TENANT],
            );
            await db.query(
              `INSERT INTO subscription."BillingReconciliationFlag" (id, tenant_id, provider, subscription_ref, intent_id, reason, account_country) VALUES ($1, $2, 'STRIPE', 'sub_pact_b3_held', $3, 'governed_subscription_open', 'US')`,
              [randomUUID(), B3_TENANT, intent],
            );
            const out = await asRole<{ request: { id: string } }>('commercial_ops', 'POST', '/platform/commercial/change-requests', {
              action_type: 'CONVERSION',
              tenant_id: B3_TENANT,
              product_key: 'sign',
              payload: { direction: 'TO_GOVERNED', held_subscription_ref: 'sub_pact_b3_held', governed_subscription_id: gov },
              reason: 'Release the held activation to the governed subscription',
              idempotency_key: 'pact-b3-state-conversion',
            });
            await asRole('commercial_ops', 'POST', `/platform/commercial/change-requests/${out.request.id}/submit`);
            return undefined;
          },
          // CCP-C2 — an APPROVED governed → self-service conversion (release not yet applied).
          'an approved governed-to-self-service conversion exists': async () => {
            const tenant_id = await commercialTenant();
            const gov = await governedRow(tenant_id);
            const v = await db.query(`SELECT v.id FROM subscription."PlanVersion" v JOIN subscription."Plan" p ON p.id = v.plan_id WHERE p.key = 'aramo-sign-standard-business-v1' AND v.status = 'PUBLISHED'`);
            const requestId = await approvedConversion(tenant_id, {
              direction: 'TO_SELF_SERVICE',
              governed_subscription_id: gov,
              plan_key: 'aramo-sign-standard-business-v1',
              plan_version_id: v.rows[0].id,
              release_expires_at: new Date(Date.now() + 24 * 3_600_000).toISOString(),
            });
            return { requestId };
          },
          // CCP-C2 — a self-service → governed conversion of a HELD activation, applied by its
          // requester: the durable provider cancel is enqueued and not dispatched (no provider is
          // configured in the harness), so the request is pending-provider.
          'a self-service-to-governed conversion is pending at the provider': async () => {
            const tenant_id = await commercialTenant();
            const gov = await governedRow(tenant_id);
            const ref = `sub_pact_c2_${String(++seq).padStart(4, '0')}`;
            await db.query(`INSERT INTO subscription."BillingReconciliationFlag" (id, tenant_id, provider, subscription_ref, reason) VALUES ($1, $2, 'STRIPE', $3, 'governed_subscription_open')`, [randomUUID(), tenant_id, ref]);
            const requestId = await approvedConversion(tenant_id, { direction: 'TO_GOVERNED', held_subscription_ref: ref, governed_subscription_id: gov });
            await asRole('commercial_ops', 'POST', `/platform/commercial/change-requests/${requestId}/convert`);
            return { requestId };
          },
          // CCP-A8 — the support exception overlay.
          'a tenant with a past-due Stripe-owned Sign subscription exists': async (params?: unknown) => {
            const p = params as { tenant_id?: unknown; subscription_id?: unknown } | undefined;
            if (typeof p?.tenant_id !== 'string' || typeof p.subscription_id !== 'string') throw new Error('provider state needs { tenant_id, subscription_id }');
            await pastDueStripeRow(p.tenant_id, p.subscription_id);
            return undefined;
          },
          'a support extension has been applied': async (params?: unknown) => {
            const tenant_id = (params as { tenant_id?: unknown } | undefined)?.tenant_id;
            if (typeof tenant_id !== 'string') throw new Error('provider state needs { tenant_id }');
            const subscription_id = randomUUID();
            await pastDueStripeRow(tenant_id, subscription_id);
            // Through the service's own HTTP surface, as support_admin (an in-bound extension).
            const out = await asRole<{ extension: { id: string } }>('support_admin', 'POST', '/platform/commercial/support-extensions', {
              tenant_id,
              product_key: 'sign',
              subscription_id,
              requested_days: 7,
              reason: 'Support goodwill: billing contact on leave',
              idempotency_key: `pact-a8-state-${String(++seq).padStart(4, '0')}`,
            });
            // CCP-B6: the removal interaction names the overlay.
            return { extensionId: out.extension.id };
          },
          // CCP-B6 — an out-of-bound extension (20 days) escalated by support_admin and approved by
          // finance_admin (Q7): its requester applies it.
          'an approved escalated support extension exists': async (params?: unknown) => {
            const tenant_id = (params as { tenant_id?: unknown } | undefined)?.tenant_id;
            if (typeof tenant_id !== 'string') throw new Error('provider state needs { tenant_id }');
            const subscription_id = randomUUID();
            await pastDueStripeRow(tenant_id, subscription_id);
            const out = await asRole<{ request: { id: string } }>('support_admin', 'POST', '/platform/commercial/support-extensions', {
              tenant_id,
              product_key: 'sign',
              subscription_id,
              requested_days: 20,
              reason: 'Support goodwill: billing contact on leave',
              idempotency_key: `pact-b6-state-${String(++seq).padStart(4, '0')}`,
            });
            await asRole('finance_admin', 'POST', `/platform/commercial/change-requests/${out.request.id}/approvals`, { step_index: 0 });
            return { requestId: out.request.id };
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
