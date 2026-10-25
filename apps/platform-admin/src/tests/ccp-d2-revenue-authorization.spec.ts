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
import { BillingRevenueReportService, type RevenueReport } from '@aramo/subscription';

import { PlatformCommercialRevenueController } from '../app/platform/platform-commercial-revenue.controller.js';

import { generateTestKeyPair } from './test-keys.js';

// CCP-D2 (PBD §5.4 row D2; A0-C6 / PLATFORM-UX-1 A1-4a; Architect disposition 2026-10-25 on
// TD-C3-5 / TD-C6-1 / TD-D3-13; draft CCP-A1 Finance amount scope FA-3 / FA-6) — the revenue route
// for each of the 6 CCP platform roles and super_admin, one role per principal, through the REAL
// request chain: a signed platform token → the real JwtAuthGuard (server-side effective-scope
// resolution) → the real RolesGuard (@RequireScopes) → the controller's tier tripwire →
// AramoExceptionFilter.
//
// The service is a stub returning KNOWN amounts (distinctive values). CCP-R3 (Aramo-CCP-A1-
// Amendment-A1-Finance-Amount-Scope-v1_0 LOCKED, FA-1 / FA-5 / FA-6): the 3 holders of
// platform:billing:read AND platform:billing:amount:read receive exactly those amounts; the other 2
// billing readers receive the counts with FINANCE_SCOPE_REQUIRED and none of the amounts anywhere in
// the body; catalog_manager and super_admin are refused.

const SCOPE = 'platform:billing:read';
const ENTRY = 'platform:tenant:read';
// CCP-R3 — CCP-A1 Amendment A1 (LOCKED) FA-2: the amount scope's 3 holders.
const AMOUNT = 'platform:billing:amount:read';
const AMOUNT_HOLDERS = ['platform_owner', 'finance_admin', 'read_only_auditor'] as const;
const NON_HOLDERS = ['commercial_ops', 'support_admin'] as const;
const BUNDLES: Record<string, readonly string[]> = {
  platform_owner: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:catalog:publish', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', SCOPE, 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read', AMOUNT],
  finance_admin: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', SCOPE, 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read', AMOUNT],
  commercial_ops: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:request', 'platform:entitlement:request', SCOPE, 'platform:billing:request', 'platform:approval:read'],
  catalog_manager: [ENTRY, 'platform:catalog:read', 'platform:catalog:draft', 'platform:approval:read'],
  support_admin: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:support', SCOPE, 'platform:approval:read'],
  read_only_auditor: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', SCOPE, 'platform:approval:read', 'platform:commercial:audit:read', AMOUNT],
  super_admin: ['platform:tenant:provision', ENTRY, 'platform:admin:invite', 'platform:tenant:lifecycle:manage', 'platform:skill:read', 'platform:skill:manage', 'platform:document_template:read', 'platform:document_template:manage', 'platform:matching_policy:read', 'platform:matching_policy:write'],
};
const CCP_ROLES = ['platform_owner', 'finance_admin', 'commercial_ops', 'catalog_manager', 'support_admin', 'read_only_auditor'] as const;
const READERS = ['platform_owner', 'finance_admin', 'commercial_ops', 'support_admin', 'read_only_auditor'] as const;
const REFUSED = ['catalog_manager', 'super_admin'] as const;
const REVENUE = '/platform/commercial/finance/revenue';

class RoleBundleResolver implements EffectiveAuthorizationResolver {
  readonly roleOf = new Map<string, string>();
  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const role = this.roleOf.get(input.principal_id);
    const scopes = role === undefined ? [] : [...(BUNDLES[role] ?? [])];
    return { status: 'ok', scopes: filterScopesForConsumer({ consumer: input.consumer_type, scopes, tenantHasEsign: false }) };
  }
}

// Distinctive amounts: none of these numbers may appear anywhere in a response.
const MRR = 7_654_321;
const BUCKET_MRR = 8_765_432;
const LAPSED_MRR = 9_876_543;
const LINE = 6_543_219;
const AMOUNTS = [MRR, MRR * 12, BUCKET_MRR, LAPSED_MRR, LINE];
const T = new Date('2026-10-26T12:00:00.000Z');
const bucket = (month: string, mrr_minor: number) => ({ month, commitment_end: 1, period_end: 1, events: 2, priced_events: 1, unpriced_events: 1, mrr_minor });
const REPORT: RevenueReport = {
  as_of: T,
  currency: 'USD',
  billing_interval: 'MONTH',
  basis: 'OPEN_SUBSCRIPTIONS_X_PINNED_LIST_PRICE',
  billing_provider_mode: 'test',
  mrr_minor: MRR,
  arr_minor: MRR * 12,
  by_product: [{ product_key: 'sign', subscriptions: 4, mrr_minor: MRR, arr_minor: MRR * 12 }],
  included: [{ subscription_id: '019a0000-0000-7000-8000-0000000d2a01', tenant_id: '019a0000-0000-7000-8000-0000000d2a02', product_key: 'sign', source: 'MANUAL', status: 'ACTIVE', plan_key: 'aramo-sign-standard-business-v1', version_number: 1, plan_version_id: '019a0000-0000-7000-8000-0000000d2a03', monthly_minor: LINE }],
  excluded: [{ subscription_id: '019a0000-0000-7000-8000-0000000d2a04', tenant_id: '019a0000-0000-7000-8000-0000000d2a05', product_key: 'sign', source: 'MANUAL', status: 'ACTIVE', plan_key: 'aramo-sign-enterprise-v1', reason: 'CONTRACT_PRICED' }],
  counts: {
    open_commercial_subscriptions: 10,
    included: 4,
    excluded: 6,
    excluded_by_reason: { STATUS_NOT_REVENUE_BEARING: 1, PLAN_VERSION_INTEGRITY: 0, CONTRACT_PRICED: 2, NO_LIST_PRICE: 1, NON_USD_CURRENCY: 1, NON_MONTHLY_INTERVAL: 1 },
    not_commercial_by_source: { DEVELOPMENT: 1 },
  },
  renewal_pipeline: { months: 2, from_month: '2026-10', through_month: '2026-11', lapsed: bucket('LAPSED', LAPSED_MRR), by_month: [bucket('2026-10', BUCKET_MRR), bucket('2026-11', 0)] },
};

/** Every key of every object in a JSON body. */
function keysOf(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keysOf(x, out);
    }
  }
  return out;
}

describe('CCP-D2 — the revenue route returns amounts only to a Finance amount scope holder (real JwtAuthGuard + RolesGuard)', () => {
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-d2-test';
  const saved: Record<string, string | undefined> = {};
  const resolver = new RoleBundleResolver();
  const principal = new Map<string, string>();
  const service = { revenue: vi.fn(async () => REPORT) };

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
  const get = async (role: string, query = '', consumer_type = 'platform') =>
    request(app.getHttpServer()).get(`${REVENUE}${query}`).set('Authorization', `Bearer ${await tokenFor(role, consumer_type)}`);
  const assertNoAmount = (body: unknown) => {
    const text = JSON.stringify(body);
    for (const a of AMOUNTS) expect(text).not.toContain(String(a));
    expect(keysOf(body).filter((k) => /_minor$|^amount$|^(mrr|arr)$|^list_price$|^monthly/i.test(k))).toEqual([]);
    // Per-tenant material never leaves the service (FA-1).
    expect(text).not.toMatch(/subscription_id|tenant_id|019a0000-0000-7000-8000-0000000d2a0/);
  };

  beforeAll(async () => {
    const keys = generateTestKeyPair();
    privatePem = keys.privatePem;
    for (const k of ['AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY']) saved[k] = process.env[k];
    process.env['AUTH_AUDIENCE'] = audience;
    process.env['AUTH_PUBLIC_KEY'] = keys.publicPem;
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, AuthorizationModule],
      controllers: [PlatformCommercialRevenueController],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: resolver },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
        { provide: BillingRevenueReportService, useValue: service },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: never, res: never, next: () => void) => new RequestIdMiddleware().use(req, res, next));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    // Merge train TD-MERGE-41: one bound loopback port for the file (see support/ccp-d4-harness.ts).
    await app.listen(0, '127.0.0.1');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => service.revenue.mockClear());

  it('D2-R-0 the matrix is the §4.1 one: of the 6 CCP roles exactly the 5 readers hold platform:billing:read; super_admin holds no commercial scope', () => {
    expect(CCP_ROLES.filter((r) => BUNDLES[r]?.includes(SCOPE))).toEqual([...READERS]);
    expect(BUNDLES['super_admin']?.some((s) => /^platform:(commercial|catalog|subscription|entitlement|billing|approval):/.test(s))).toBe(false);
  });

  it('D2-R-0b (CCP-A1 Amendment A1 FA-2) exactly platform_owner, finance_admin and read_only_auditor hold platform:billing:amount:read; each also holds platform:billing:read', () => {
    expect(Object.keys(BUNDLES).filter((r) => BUNDLES[r]?.includes(AMOUNT)).sort()).toEqual([...AMOUNT_HOLDERS].sort());
    for (const r of AMOUNT_HOLDERS) expect(BUNDLES[r]).toContain(SCOPE);
    expect([...AMOUNT_HOLDERS, ...NON_HOLDERS].sort()).toEqual([...READERS].sort());
  });

  const counted = (b: { month: string }) => ({ month: b.month, commitment_end: 1, period_end: 1, events: 2, priced_events: 1, unpriced_events: 1 });

  for (const role of AMOUNT_HOLDERS) {
    it(`D2-R-1 amount holder — ${role} → 200 with MRR / ARR, each product line's MRR / ARR and each bucket's MRR; no marker`, async () => {
      const res = await get(role);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({
        as_of: '2026-10-26T12:00:00.000Z',
        currency: 'USD',
        billing_interval: 'MONTH',
        basis: 'OPEN_SUBSCRIPTIONS_X_PINNED_LIST_PRICE',
        billing_provider_mode: 'test',
        tax: { enabled: false, reason: 'STRIPE_TAX_NOT_REGISTERED' },
        mrr_minor: MRR,
        arr_minor: MRR * 12,
        by_product: [{ product_key: 'sign', subscriptions: 4, mrr_minor: MRR, arr_minor: MRR * 12 }],
        counts: REPORT.counts,
        renewal_pipeline: {
          months: 2,
          from_month: '2026-10',
          through_month: '2026-11',
          lapsed: { ...counted({ month: 'LAPSED' }), mrr_minor: LAPSED_MRR },
          by_month: [{ ...counted({ month: '2026-10' }), mrr_minor: BUCKET_MRR }, { ...counted({ month: '2026-11' }), mrr_minor: 0 }],
        },
      });
      expect(JSON.stringify(res.body)).not.toContain('amount_withheld');
      // Per-tenant material never leaves the service, holder or not (FA-1: no per-tenant revenue row).
      expect(JSON.stringify(res.body)).not.toMatch(/subscription_id|tenant_id|019a0000-0000-7000-8000-0000000d2a0/);
      expect(JSON.stringify(res.body)).not.toContain(String(LINE));
      expect(service.revenue).toHaveBeenCalledTimes(1);
    });
  }

  for (const role of NON_HOLDERS) {
    it(`D2-R-1 non-holder — ${role} → 200 with the counts only: no amount anywhere, FINANCE_SCOPE_REQUIRED on every money-bearing object`, async () => {
      const res = await get(role);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      assertNoAmount(res.body);
      expect(res.body).toEqual({
        as_of: '2026-10-26T12:00:00.000Z',
        currency: 'USD',
        billing_interval: 'MONTH',
        basis: 'OPEN_SUBSCRIPTIONS_X_PINNED_LIST_PRICE',
        billing_provider_mode: 'test',
        tax: { enabled: false, reason: 'STRIPE_TAX_NOT_REGISTERED' },
        amount_withheld: 'FINANCE_SCOPE_REQUIRED',
        by_product: [{ product_key: 'sign', subscriptions: 4, amount_withheld: 'FINANCE_SCOPE_REQUIRED' }],
        counts: REPORT.counts,
        renewal_pipeline: {
          months: 2,
          from_month: '2026-10',
          through_month: '2026-11',
          lapsed: { ...counted({ month: 'LAPSED' }), amount_withheld: 'FINANCE_SCOPE_REQUIRED' },
          by_month: ['2026-10', '2026-11'].map((month) => ({ ...counted({ month }), amount_withheld: 'FINANCE_SCOPE_REQUIRED' })),
        },
      });
      expect(service.revenue).toHaveBeenCalledTimes(1);
    });
  }

  it('D2-R-1b a non-holder body equals a holder body with every amount removed and the marker added (FA-6: nothing else differs)', async () => {
    const holder = (await get('finance_admin')).body as Record<string, unknown>;
    const other = (await get('support_admin')).body as Record<string, unknown>;
    const strip = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(strip);
      if (v !== null && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        let had = false;
        for (const [k, x] of Object.entries(v)) {
          if (/_minor$/.test(k)) had = true;
          else out[k] = strip(x);
        }
        if (had) out['amount_withheld'] = 'FINANCE_SCOPE_REQUIRED';
        return out;
      }
      return v;
    };
    expect(other).toEqual(strip(holder));
  });

  for (const role of REFUSED) {
    it(`D2-R-2 refused — ${role} → 403 INSUFFICIENT_PERMISSIONS (missing ${SCOPE}); the computation never runs`, async () => {
      const res = await get(role);
      expect(res.status).toBe(403);
      expect(res.body?.error?.details?.missing_scopes).toEqual([SCOPE]);
      assertNoAmount(res.body);
      expect(JSON.stringify(res.body)).not.toMatch(/USD|FINANCE_SCOPE_REQUIRED/);
      expect(service.revenue).not.toHaveBeenCalled();
    });
  }

  it('D2-R-3 refused — no token → 401; a tenant-tier token for a reader → 403', async () => {
    expect((await request(app.getHttpServer()).get(REVENUE)).status).toBe(401);
    const res = await get('finance_admin', '', 'recruiter');
    expect(res.status).toBe(403);
    expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    expect(service.revenue).not.toHaveBeenCalled();
  });

  it('D2-R-4 passes the filters through, typed', async () => {
    expect((await get('read_only_auditor', '?product_key=sign&months=6')).status).toBe(200);
    expect(service.revenue).toHaveBeenCalledWith({ product_key: 'sign', months: 6 });
    expect((await get('read_only_auditor')).status).toBe(200);
    expect(service.revenue).toHaveBeenLastCalledWith({ product_key: undefined, months: undefined });
  });

  const bad: Array<[string, string]> = [
    ['months 0', '?months=0'],
    ['months above 24', '?months=25'],
    ['months not an integer', '?months=1.5'],
    ['unregistered product', '?product_key=ats'],
    ['a tenant filter (no per-tenant revenue)', '?tenant_id=019a0000-0000-7000-8000-0000000d2a02'],
    ['unknown parameter', '?currency=EUR'],
  ];
  for (const [name, q] of bad) {
    it(`D2-R-5 400 VALIDATION_ERROR — ${name}`, async () => {
      const res = await get('finance_admin', q);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body?.error?.code).toBe('VALIDATION_ERROR');
      expect(service.revenue).not.toHaveBeenCalled();
    });
  }
});
