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
import { BillingStatusQueryError, BillingStatusReadService, type BillingPortalConfigurationStatus, type TenantBillingStatus } from '@aramo/subscription';

import { PlatformCommercialBillingStatusController } from '../app/platform/platform-commercial-billing-status.controller.js';

import { generateTestKeyPair } from './test-keys.js';

// CCP-C3 (PBD §5.2 row C3; per-role tests for every new platform-admin route) —
// GET /platform/commercial/tenants/{tenant_id}/billing-status and
// GET /platform/commercial/billing-portal-configuration under platform:billing:read, for each of
// the 6 CCP platform roles and super_admin, one role per principal, through the REAL request chain:
// a signed platform token → the real JwtAuthGuard → the real RolesGuard (@RequireScopes) → the
// controller's consumer_type tripwire → AramoExceptionFilter.
//
// Expected (CCP A1 §4.1 bundles; A1 :317 reserves platform:billing:read for C3/C4): allowed —
// platform_owner, finance_admin, commercial_ops, support_admin, read_only_auditor; refused —
// catalog_manager and super_admin. The bundles are restated from §4.1 as in the A1 / C1 specs.

const SCOPE = 'platform:billing:read';
const ENTRY = 'platform:tenant:read';
// CCP-R3 — Aramo-CCP-A1-Amendment-A1-Finance-Amount-Scope-v1_0 (LOCKED) FA-2: the amount scope,
// granted to exactly platform_owner, finance_admin and read_only_auditor.
const AMOUNT = 'platform:billing:amount:read';
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
// FA-2 / FAS-1 / FAS-3: the amount holders, and the billing readers that get the booleans only.
const AMOUNT_HOLDERS = ['platform_owner', 'finance_admin', 'read_only_auditor'] as const;
const BOOLEAN_ONLY = ['commercial_ops', 'support_admin'] as const;
const REFUSED = ['catalog_manager', 'super_admin'] as const;
const TENANT = '0190dddd-0000-7000-8000-0000000c3001';
const STATUS = `/platform/commercial/tenants/${TENANT}/billing-status`;
const PORTAL = '/platform/commercial/billing-portal-configuration';

class RoleBundleResolver implements EffectiveAuthorizationResolver {
  readonly roleOf = new Map<string, string>();
  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const role = this.roleOf.get(input.principal_id);
    const scopes = role === undefined ? [] : [...(BUNDLES[role] ?? [])];
    return { status: 'ok', scopes: filterScopesForConsumer({ consumer: input.consumer_type, scopes, tenantHasEsign: false }) };
  }
}

const T = new Date('2026-10-26T12:00:00.000Z');
// CCP-C5 — every billing read carries the designed disabled tax state.
const TAX = { enabled: false, reason: 'STRIPE_TAX_NOT_REGISTERED' } as const;
const STATUS_RESULT: TenantBillingStatus = {
  tenant_id: TENANT,
  product_key: 'sign',
  availability: 'AVAILABLE',
  provider: 'STRIPE',
  mode: 'test',
  subscription: { id: '019a0000-0000-7000-8000-0000000c3a01', source: 'SELF_SERVICE', status: 'PAST_DUE', open: true, account_ref: 'acct_c3', subscription_ref: 'sub_c3' },
  provider_subscription: { provider_status: 'past_due', current_period_start: new Date('2026-10-01T00:00:00Z'), current_period_end: new Date('2026-11-01T00:00:00Z'), cancel_at_period_end: false },
  invoices: [
    {
      provider: 'STRIPE',
      invoice_ref: 'in_c3',
      number: 'A-0001',
      account_ref: 'acct_c3',
      subscription_ref: 'sub_c3',
      provider_status: 'open',
      payment_state: 'OVERDUE',
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
      hosted_url: 'https://invoice.test/in_c3',
      document_url: null,
      live: false,
    },
  ],
  tax: { ...TAX },
  detail: null,
  read_at: T,
};
const PORTAL_RESULT: BillingPortalConfigurationStatus = {
  provider: 'STRIPE',
  availability: 'AVAILABLE',
  mode: 'test',
  configuration_ref: null,
  configuration_state: 'NOT_CONFIGURED',
  configuration: null,
  detail: 'STRIPE_PORTAL_CONFIGURATION is not set (commitment plans are refused the portal)',
  read_at: T,
};

describe('CCP-C3 — per-role authorization on the read-through billing-status routes (real JwtAuthGuard + RolesGuard)', () => {
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-c3-test';
  const saved: Record<string, string | undefined> = {};
  const resolver = new RoleBundleResolver();
  const principal = new Map<string, string>();
  const status = {
    tenantBillingStatus: vi.fn(async (): Promise<TenantBillingStatus> => STATUS_RESULT),
    portalConfigurationStatus: vi.fn(async (): Promise<BillingPortalConfigurationStatus> => PORTAL_RESULT),
  };

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
      controllers: [PlatformCommercialBillingStatusController],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: resolver },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
        { provide: BillingStatusReadService, useValue: status },
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

  beforeEach(() => {
    status.tenantBillingStatus.mockClear();
    status.portalConfigurationStatus.mockClear();
  });

  it('C3-R-0 the matrix is the §4.1 one: exactly the 5 allowed roles hold platform:billing:read; super_admin holds no commercial scope', () => {
    expect(Object.keys(BUNDLES).filter((r) => BUNDLES[r]?.includes(SCOPE)).sort()).toEqual([...ALLOWED].sort());
    expect(BUNDLES['super_admin']?.some((s) => /^platform:(commercial|catalog|subscription|entitlement|billing|approval):/.test(s))).toBe(false);
  });

  it('C3-R-0b (CCP-A1 Amendment A1 FA-2) exactly platform_owner, finance_admin and read_only_auditor hold platform:billing:amount:read; each also holds platform:billing:read', () => {
    expect(Object.keys(BUNDLES).filter((r) => BUNDLES[r]?.includes(AMOUNT)).sort()).toEqual([...AMOUNT_HOLDERS].sort());
    for (const r of AMOUNT_HOLDERS) expect(BUNDLES[r]).toContain(SCOPE);
  });

  for (const role of AMOUNT_HOLDERS) {
    it(`C3-R-1 allowed, amount holder — ${role} → 200 on both routes: the invoices with their amounts and links, and payment_due / payment_overdue`, async () => {
      const s = await get(STATUS, role, '?product_key=sign');
      expect(s.status, JSON.stringify(s.body)).toBe(200);
      expect(s.body).toMatchObject({ tenant_id: TENANT, availability: 'AVAILABLE', mode: 'test', subscription: { subscription_ref: 'sub_c3', open: true }, provider_subscription: { provider_status: 'past_due', current_period_end: '2026-11-01T00:00:00.000Z' }, payment_due: true, payment_overdue: true, read_at: '2026-10-26T12:00:00.000Z' });
      expect(s.body.amount_withheld).toBeUndefined();
      // CCP-C5 — the designed disabled tax state is passed through exactly.
      expect(s.body.tax).toEqual(TAX);
      expect(s.body.invoices).toEqual([
        expect.objectContaining({ invoice_ref: 'in_c3', payment_state: 'OVERDUE', provider_status: 'open', currency: 'usd', total_minor: 4900, amount_due_minor: 4900, amount_paid_minor: 0, amount_remaining_minor: 4900, due_at: '2026-10-15T00:00:00.000Z', hosted_url: 'https://invoice.test/in_c3' }),
      ]);
      const p = await get(PORTAL, role);
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      expect(p.body).toMatchObject({ availability: 'AVAILABLE', configuration_ref: null, configuration_state: 'NOT_CONFIGURED', configuration: null });
      expect(status.tenantBillingStatus).toHaveBeenCalledTimes(1);
      expect(status.portalConfigurationStatus).toHaveBeenCalledTimes(1);
    });
  }

  for (const role of BOOLEAN_ONLY) {
    it(`C3-R-1 allowed, no amount scope — ${role} → 200: payment_due / payment_overdue only; no invoices field, no amount, currency, link, invoice ref or count (FA-4, FA-5)`, async () => {
      const s = await get(STATUS, role, '?product_key=sign');
      expect(s.status, JSON.stringify(s.body)).toBe(200);
      expect(s.body).toMatchObject({ tenant_id: TENANT, availability: 'AVAILABLE', payment_due: true, payment_overdue: true, amount_withheld: 'FINANCE_SCOPE_REQUIRED' });
      expect('invoices' in s.body).toBe(false);
      const raw = JSON.stringify(s.body);
      for (const leak of ['4900', '49.00', '"usd"', 'invoice.test', 'in_c3', 'A-0001', '_minor', 'hosted_url', 'document_url', 'currency']) expect(raw, leak).not.toContain(leak);
      const p = await get(PORTAL, role);
      expect(p.status).toBe(200);
    });
  }

  it('C3-R-6 (FA-4) the booleans: an OVERDUE invoice → due and overdue; DUE or PAYMENT_FAILED → due only; PAID / VOID / no invoice → neither; the same for every billing reader', async () => {
    const cases: Array<[string[], boolean, boolean]> = [
      [['OVERDUE'], true, true],
      [['DUE'], true, false],
      [['PAYMENT_FAILED'], true, false],
      [['PAID', 'VOID', 'DRAFT', 'UNCOLLECTIBLE'], false, false],
      [[], false, false],
    ];
    for (const [states, due, overdue] of cases) {
      const inv = STATUS_RESULT.invoices[0]!;
      status.tenantBillingStatus.mockResolvedValue({ ...STATUS_RESULT, invoices: states.map((payment_state, n) => ({ ...inv, invoice_ref: `in_${n}`, payment_state: payment_state as typeof inv.payment_state })) });
      for (const role of ALLOWED) {
        const s = await get(STATUS, role, '?product_key=sign');
        expect([s.body.payment_due, s.body.payment_overdue], `${role} ${states.join(',')}`).toEqual([due, overdue]);
      }
    }
    status.tenantBillingStatus.mockResolvedValue(STATUS_RESULT);
  });

  it('C3-R-7 (FA-6) no leakage through error text: a provider error message reaches an amount holder, never a caller without the amount scope', async () => {
    status.tenantBillingStatus.mockResolvedValue({ ...STATUS_RESULT, availability: 'PROVIDER_UNAVAILABLE', provider_subscription: null, invoices: [], detail: 'Stripe: invoice in_c3 amount_due 4900 usd could not be read' });
    const holder = await get(STATUS, 'finance_admin', '?product_key=sign');
    expect(holder.body.detail).toContain('4900');
    for (const role of BOOLEAN_ONLY) {
      const s = await get(STATUS, role, '?product_key=sign');
      expect(s.body).toMatchObject({ availability: 'PROVIDER_UNAVAILABLE', detail: 'the billing provider could not be read', amount_withheld: 'FINANCE_SCOPE_REQUIRED', payment_due: false, payment_overdue: false });
      expect(JSON.stringify(s.body)).not.toMatch(/4900|usd|in_c3/);
    }
    status.tenantBillingStatus.mockResolvedValue(STATUS_RESULT);
  });

  it('C3-R-8 (FA-6) no alternate path: invoice_limit does not change what a caller without the amount scope receives (the read window is fixed), and the 400 shape carries no figure', async () => {
    const a = await get(STATUS, 'support_admin', '?product_key=sign&invoice_limit=1');
    const b = await get(STATUS, 'support_admin', '?product_key=sign&invoice_limit=50');
    expect({ ...a.body }).toEqual({ ...b.body });
    const bad = await get(STATUS, 'support_admin', '?product_key=sign&invoice_limit=51');
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toMatch(/4900|usd/);
  });

  for (const role of REFUSED) {
    it(`C3-R-2 refused — ${role} → 403 INSUFFICIENT_PERMISSIONS (missing ${SCOPE}) on both routes; no service reached`, async () => {
      for (const [path, q] of [[STATUS, '?product_key=sign'], [PORTAL, '']] as const) {
        const res = await get(path, role, q);
        expect(res.status).toBe(403);
        expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
        expect(res.body?.error?.details?.missing_scopes).toEqual([SCOPE]);
      }
      expect(status.tenantBillingStatus).not.toHaveBeenCalled();
      expect(status.portalConfigurationStatus).not.toHaveBeenCalled();
    });
  }

  it('C3-R-3 refused — no token → 401; a tenant-tier token for an allowed role → 403', async () => {
    for (const [path, q] of [[STATUS, '?product_key=sign'], [PORTAL, '']] as const) {
      expect((await request(app.getHttpServer()).get(`${path}${q}`)).status).toBe(401);
      const res = await get(path, 'finance_admin', q, 'recruiter');
      expect(res.status).toBe(403);
      expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    }
    expect(status.tenantBillingStatus).not.toHaveBeenCalled();
    expect(status.portalConfigurationStatus).not.toHaveBeenCalled();
  });

  it('C3-R-4 passes the tenant and product through, typed; the service read window is always the max (50) and invoice_limit only trims what an amount holder receives (CCP-R3, FA-4)', async () => {
    const inv = STATUS_RESULT.invoices[0]!;
    status.tenantBillingStatus.mockResolvedValueOnce({ ...STATUS_RESULT, invoices: [inv, { ...inv, invoice_ref: 'in_2' }, { ...inv, invoice_ref: 'in_3' }] });
    const r = await get(STATUS, 'read_only_auditor', '?product_key=sign&invoice_limit=2');
    expect(r.status).toBe(200);
    expect(status.tenantBillingStatus).toHaveBeenCalledWith(TENANT, 'sign', { invoice_limit: 50 });
    expect(r.body.invoices.map((i: { invoice_ref: string }) => i.invoice_ref)).toEqual(['in_c3', 'in_2']);
  });

  it('C3-R-5 only GET exists: POST, PUT, PATCH and DELETE on both paths are 404 for an allowed role', async () => {
    const token = await tokenFor('platform_owner');
    for (const path of [STATUS, PORTAL]) {
      for (const m of ['post', 'put', 'patch', 'delete'] as const) {
        const res = await request(app.getHttpServer())[m](path).set('Authorization', `Bearer ${token}`);
        expect(res.status, `${m} ${path}`).toBe(404);
      }
    }
    expect(status.tenantBillingStatus).not.toHaveBeenCalled();
    expect(status.portalConfigurationStatus).not.toHaveBeenCalled();
  });

  const bad: Array<[string, string, string]> = [
    ['product_key missing', STATUS, ''],
    ['product_key not in the registry', STATUS, '?product_key=ats'],
    ['invoice_limit 0', STATUS, '?product_key=sign&invoice_limit=0'],
    ['invoice_limit above 50', STATUS, '?product_key=sign&invoice_limit=51'],
    ['unknown parameter', STATUS, '?product_key=sign&account_ref=acct_x'],
    ['tenant_id not a uuid', '/platform/commercial/tenants/nope/billing-status', '?product_key=sign'],
    ['unknown parameter on the portal route', PORTAL, '?configuration=bpc_x'],
  ];
  for (const [name, path, q] of bad) {
    it(`C3-R-6 400 — ${name}`, async () => {
      const res = await get(path, 'finance_admin', q);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body?.error?.code).toBe('VALIDATION_ERROR');
      expect(status.tenantBillingStatus).not.toHaveBeenCalled();
      expect(status.portalConfigurationStatus).not.toHaveBeenCalled();
    });
  }

  it('C3-R-7 400 VALIDATION_ERROR when the service refuses the query', async () => {
    status.tenantBillingStatus.mockRejectedValueOnce(new BillingStatusQueryError('INVALID_LIMIT', 'invoice_limit must be an integer 1..50'));
    const res = await get(STATUS, 'finance_admin', '?product_key=sign');
    expect(res.status).toBe(400);
    expect(res.body?.error?.details?.reason).toBe('invalid_limit');
  });
});
