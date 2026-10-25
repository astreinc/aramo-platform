import 'reflect-metadata';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { SignJWT, importPKCS8 } from 'jose';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { AramoExceptionFilter, RequestIdMiddleware } from '@aramo/common';
import {
  AuthModule,
  EFFECTIVE_AUTHORIZATION_RESOLVER,
  PLATFORM_TENANT_SENTINEL_ID,
  type EffectiveAuthorizationInput,
  type EffectiveAuthorizationResolution,
  type EffectiveAuthorizationResolver,
} from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { filterScopesForConsumer } from '@aramo/identity';
import { BillingFinanceReportService } from '@aramo/subscription';

import { PlatformCommercialFinanceController } from '../app/platform/platform-commercial-finance.controller.js';

import { generateTestKeyPair } from './test-keys.js';

// CCP-C6 (PBD §5.2 row C6; A0-C6 / PLATFORM-UX-1 A1-4a "money only on dedicated Finance screens")
// — the three Finance read routes under platform:billing:read, for each of the 6 CCP platform
// roles and super_admin, one role per principal, through the REAL request chain: a signed platform
// token → the real JwtAuthGuard (server-side effective-scope resolution) → the real RolesGuard
// (@RequireScopes) → the controller's consumer_type tripwire → AramoExceptionFilter.
//
// Expected (CCP A1 §4.1 bundles): allowed — platform_owner, finance_admin, commercial_ops,
// support_admin, read_only_auditor; refused — catalog_manager and super_admin (no commercial
// scope, INV-1; PBD §12). The bundles are restated from §4.1 as in the A1 / A2 / C1 specs.

const SCOPE = 'platform:billing:read';
const ENTRY = 'platform:tenant:read';
// CCP-R3 — CCP-A1 Amendment A1 (LOCKED) FA-2: the amount scope's 3 holders.
const AMOUNT = 'platform:billing:amount:read';
const AMOUNT_HOLDERS = ['platform_owner', 'finance_admin', 'read_only_auditor'] as const;
const BUNDLES: Record<string, readonly string[]> = {
  platform_owner: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:catalog:publish', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', SCOPE, 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read', AMOUNT],
  finance_admin: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', SCOPE, 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read', AMOUNT],
  commercial_ops: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:request', 'platform:entitlement:request', SCOPE, 'platform:billing:request', 'platform:approval:read'],
  catalog_manager: [ENTRY, 'platform:catalog:read', 'platform:catalog:draft', 'platform:approval:read'],
  support_admin: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:support', SCOPE, 'platform:approval:read'],
  read_only_auditor: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', SCOPE, 'platform:approval:read', 'platform:commercial:audit:read', AMOUNT],
  super_admin: ['platform:tenant:provision', ENTRY, 'platform:admin:invite', 'platform:tenant:lifecycle:manage', 'platform:skill:read', 'platform:skill:manage', 'platform:document_template:read', 'platform:document_template:manage', 'platform:matching_policy:read', 'platform:matching_policy:write'],
};
const ALLOWED = ['platform_owner', 'finance_admin', 'commercial_ops', 'support_admin', 'read_only_auditor'] as const;
const REFUSED = ['catalog_manager', 'super_admin'] as const;
const RENEWALS = '/platform/commercial/finance/renewals';
const OUTSTANDING = '/platform/commercial/finance/outstanding-payments';
const RECONCILIATION = '/platform/commercial/finance/reconciliation-report';
const ROUTES = [RENEWALS, OUTSTANDING, RECONCILIATION] as const;
const TENANT = '0190dddd-0000-7000-8000-000000000001';

class RoleBundleResolver implements EffectiveAuthorizationResolver {
  readonly roleOf = new Map<string, string>();
  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const role = this.roleOf.get(input.principal_id);
    const scopes = role === undefined ? [] : [...(BUNDLES[role] ?? [])];
    return { status: 'ok', scopes: filterScopesForConsumer({ consumer: input.consumer_type, scopes, tenantHasEsign: false }) };
  }
}

const T = new Date('2026-10-26T12:00:00.000Z');
const PRICE = { list_price: { amount_minor: 2000, currency: 'USD' as const, billing_interval: 'MONTH' }, unpriced_reason: null, price_source: 'PINNED_PLAN_VERSION' as const, plan_version_id: '019a0000-0000-7000-8000-0000000cc6a9' };
const RENEWALS_REPORT = {
  as_of: T,
  within_days: 90,
  currency: 'USD' as const,
  billing_provider_mode: 'test' as const,
  items: [
    {
      subscription_id: '019a0000-0000-7000-8000-0000000cc6a1', tenant_id: TENANT, tenant_name: 'Acme', product_key: 'sign', source: 'MANUAL', status: 'ACTIVE', plan_key: 'aramo-sign-standard-business-v1', plan_name: 'Standard Business',
      version_number: 1, grandfathered: false, renewal_kind: 'COMMITMENT_END' as const, renewal_at: new Date('2026-11-15T12:00:00.000Z'), days_until: 20, lapsed: false, commitment_months: 12, cancel_at_period_end: false, cancel_requested_within_commitment: false, ...PRICE,
    },
  ],
  counts: { items: 1, lapsed: 0, commitment_end: 1, period_end: 0 },
};
const OUTSTANDING_REPORT = {
  as_of: T,
  currency: 'USD' as const,
  billing_provider_mode: 'test' as const,
  items: [
    {
      subscription_id: '019a0000-0000-7000-8000-0000000cc6a2', tenant_id: TENANT, tenant_name: 'Acme', product_key: 'sign', source: 'SELF_SERVICE', status: 'PAST_DUE', plan_key: 'aramo-sign-standard-business-v1', version_number: 1,
      billing_subscription_ref: 'sub_c6', status_since: T, grace_until: new Date('2026-11-02T12:00:00.000Z'), grace_state: 'IN_GRACE' as const, current_period_end: new Date('2026-11-25T00:00:00.000Z'), amount_due: null, amount_due_reason: 'INVOICE_READ_NOT_DELIVERED' as const, ...PRICE,
    },
  ],
  counts: { items: 1, past_due: 1, incomplete: 0, in_grace: 1, grace_ended: 0, no_grace_date: 0 },
};
const RECONCILIATION_REPORT = {
  as_of: T,
  currency: 'USD' as const,
  billing_provider_mode: 'test' as const,
  status: 'EXCEPTIONS' as const,
  subscriptions: [],
  entitled_without_subscription: [],
  held_activations: [
    {
      flag_id: '019a0000-0000-7000-8000-0000000cc6a3', tenant_id: TENANT, tenant_name: 'Acme', product_key: 'sign', provider: 'STRIPE', subscription_ref: 'sub_held', detected_at: T, intent_id: '019a0000-0000-7000-8000-0000000cc6a4', intent_status: 'CREATED',
      governed_subscription_id: '019a0000-0000-7000-8000-0000000cc6a5', governed_plan_key: 'aramo-sign-included-v1', held_plan_key: 'aramo-sign-standard-business-v1', held_price: { ...PRICE, price_source: 'CURRENT_PUBLISHED_PLAN_VERSION' as const }, unconfirmed_commands: [], resolution: 'UNRESOLVED' as const,
    },
  ],
  other_open_flags: [],
  counts: { open_subscriptions: 0, by_source: {}, by_status: {}, subscriptions_with_discrepancy: 0, discrepancies: {}, entitled_without_subscription: 0, held_activations: 1, other_open_flags: 0, unconfirmed_commands: 0, failed_commands: 0, failed_inbox_events: 0, unprocessed_inbox_events: 0, exceptions: 1 },
};

describe('CCP-C6 — per-role authorization on the Finance read routes (real JwtAuthGuard + RolesGuard)', () => {
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-c6-test';
  const saved: Record<string, string | undefined> = {};
  const resolver = new RoleBundleResolver();
  const principal = new Map<string, string>();
  const reports = {
    renewals: vi.fn(async () => RENEWALS_REPORT),
    outstandingPayments: vi.fn(async () => OUTSTANDING_REPORT),
    reconciliationReport: vi.fn(async () => RECONCILIATION_REPORT),
  };
  const calls = () => reports.renewals.mock.calls.length + reports.outstandingPayments.mock.calls.length + reports.reconciliationReport.mock.calls.length;

  async function tokenFor(role: string, consumer_type = 'platform'): Promise<string> {
    const key = `${role}:${consumer_type}`;
    let sub = principal.get(key);
    if (sub === undefined) {
      sub = uuidv7();
      principal.set(key, sub);
      resolver.roleOf.set(sub, role);
    }
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ consumer_type, actor_kind: 'user', tenant_id: PLATFORM_TENANT_SENTINEL_ID, authz_version: 1 })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('Aramo Core Auth')
      .setAudience(audience)
      .setSubject(sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(await importPKCS8(privatePem, 'RS256'));
  }
  const get = async (path: string, role: string, query = '', consumer_type = 'platform') =>
    request(app.getHttpServer()).get(`${path}${query}`).set('Authorization', `Bearer ${await tokenFor(role, consumer_type)}`);

  beforeAll(async () => {
    const keys = generateTestKeyPair();
    privatePem = keys.privatePem;
    for (const k of ['AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY']) saved[k] = process.env[k];
    process.env['AUTH_AUDIENCE'] = audience;
    process.env['AUTH_PUBLIC_KEY'] = keys.publicPem;
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, AuthorizationModule],
      controllers: [PlatformCommercialFinanceController],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: resolver },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
        { provide: BillingFinanceReportService, useValue: reports },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: never, res: never, next: () => void) => new RequestIdMiddleware().use(req, res, next));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    reports.renewals.mockClear();
    reports.outstandingPayments.mockClear();
    reports.reconciliationReport.mockClear();
  });

  it('C6-R-0 the matrix is the §4.1 one: exactly the 5 allowed roles hold platform:billing:read; super_admin holds no commercial scope', () => {
    expect(Object.keys(BUNDLES).filter((r) => BUNDLES[r]?.includes(SCOPE)).sort()).toEqual([...ALLOWED].sort());
    expect(BUNDLES['super_admin']?.some((s) => /^platform:(commercial|catalog|subscription|entitlement|billing|approval):/.test(s))).toBe(false);
  });

  for (const role of ALLOWED) {
    it(`C6-R-1 allowed — ${role} → 200 on all 3 Finance routes (USD figures, held activation listed)`, async () => {
      const ren = await get(RENEWALS, role);
      expect(ren.status, JSON.stringify(ren.body)).toBe(200);
      expect(ren.body).toMatchObject({ as_of: '2026-10-26T12:00:00.000Z', within_days: 90, currency: 'USD', billing_provider_mode: 'test', counts: { items: 1 } });
      expect(ren.body.items[0]).toMatchObject({ renewal_kind: 'COMMITMENT_END', renewal_at: '2026-11-15T12:00:00.000Z', days_until: 20, list_price: { amount_minor: 2000, currency: 'USD', billing_interval: 'MONTH' } });
      const out = await get(OUTSTANDING, role);
      expect(out.status).toBe(200);
      expect(out.body.items[0]).toMatchObject({ status: 'PAST_DUE', grace_state: 'IN_GRACE', grace_until: '2026-11-02T12:00:00.000Z', amount_due_reason: 'INVOICE_READ_NOT_DELIVERED' });
      // CCP-R3 (CCP-A1 Amendment A1, FA-5): the amount-owed field only for an amount holder.
      if ((AMOUNT_HOLDERS as readonly string[]).includes(role)) {
        expect(out.body.items[0]).toHaveProperty('amount_due', null);
        expect(out.body.items[0].amount_withheld).toBeUndefined();
      } else {
        expect('amount_due' in out.body.items[0]).toBe(false);
        expect(out.body.items[0].amount_withheld).toBe('FINANCE_SCOPE_REQUIRED');
      }
      // FA-3: the plan version's catalog list price is unchanged for every reader.
      expect(out.body.items[0].list_price).toEqual({ amount_minor: 2000, currency: 'USD', billing_interval: 'MONTH' });
      const rec = await get(RECONCILIATION, role);
      expect(rec.status).toBe(200);
      expect(rec.body).toMatchObject({ status: 'EXCEPTIONS', counts: { held_activations: 1, exceptions: 1 } });
      expect(rec.body.held_activations[0]).toMatchObject({ subscription_ref: 'sub_held', intent_status: 'CREATED', detected_at: '2026-10-26T12:00:00.000Z', resolution: 'UNRESOLVED' });
      expect(calls()).toBe(3);
    });
  }

  for (const role of REFUSED) {
    it(`C6-R-2 refused — ${role} → 403 INSUFFICIENT_PERMISSIONS (missing ${SCOPE}) on all 3 routes; no report runs`, async () => {
      for (const path of ROUTES) {
        const res = await get(path, role);
        expect(res.status).toBe(403);
        expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
        expect(res.body?.error?.details?.missing_scopes).toEqual([SCOPE]);
        expect(JSON.stringify(res.body)).not.toMatch(/amount_minor|USD/);
      }
      expect(calls()).toBe(0);
    });
  }

  it('C6-R-3 refused — no token → 401; a tenant-tier token for an allowed role → 403', async () => {
    for (const path of ROUTES) {
      expect((await request(app.getHttpServer()).get(path)).status).toBe(401);
      const res = await get(path, 'finance_admin', '', 'recruiter');
      expect(res.status).toBe(403);
      expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    }
    expect(calls()).toBe(0);
  });

  it('C6-R-4 passes every filter through, typed', async () => {
    expect((await get(RENEWALS, 'read_only_auditor', `?within_days=30&tenant_id=${TENANT}&product_key=sign`)).status).toBe(200);
    expect(reports.renewals).toHaveBeenCalledWith({ tenant_id: TENANT, product_key: 'sign', within_days: 30 });
    expect((await get(OUTSTANDING, 'read_only_auditor', `?tenant_id=${TENANT}`)).status).toBe(200);
    expect(reports.outstandingPayments).toHaveBeenCalledWith({ tenant_id: TENANT, product_key: undefined });
    expect((await get(RECONCILIATION, 'read_only_auditor', '?product_key=sign')).status).toBe(200);
    expect(reports.reconciliationReport).toHaveBeenCalledWith({ tenant_id: undefined, product_key: 'sign' });
  });

  const bad: Array<[string, string, string]> = [
    ['within_days 0', RENEWALS, '?within_days=0'],
    ['within_days above 365', RENEWALS, '?within_days=366'],
    ['within_days not an integer', RENEWALS, '?within_days=1.5'],
    ['tenant_id not a uuid', OUTSTANDING, '?tenant_id=nope'],
    ['unregistered product', RECONCILIATION, '?product_key=ats'],
    ['unknown parameter', RECONCILIATION, '?currency=EUR'],
    ['within_days on a route without it', OUTSTANDING, '?within_days=30'],
  ];
  for (const [name, path, q] of bad) {
    it(`C6-R-5 400 VALIDATION_ERROR — ${name}`, async () => {
      const res = await get(path, 'finance_admin', q);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body?.error?.code).toBe('VALIDATION_ERROR');
      expect(calls()).toBe(0);
    });
  }
});
