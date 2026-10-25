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
const BUNDLES: Record<string, readonly string[]> = {
  platform_owner: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:catalog:publish', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', SCOPE, 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read'],
  finance_admin: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', SCOPE, 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read'],
  commercial_ops: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:request', 'platform:entitlement:request', SCOPE, 'platform:billing:request', 'platform:approval:read'],
  catalog_manager: [ENTRY, 'platform:catalog:read', 'platform:catalog:draft', 'platform:approval:read'],
  support_admin: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:support', SCOPE, 'platform:approval:read'],
  read_only_auditor: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', SCOPE, 'platform:approval:read', 'platform:commercial:audit:read'],
  super_admin: ['platform:tenant:provision', ENTRY, 'platform:admin:invite', 'platform:tenant:lifecycle:manage', 'platform:skill:read', 'platform:skill:manage', 'platform:document_template:read', 'platform:document_template:manage', 'platform:matching_policy:read', 'platform:matching_policy:write'],
};
const ALLOWED = ['platform_owner', 'finance_admin', 'commercial_ops', 'support_admin', 'read_only_auditor'] as const;
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

  for (const role of ALLOWED) {
    it(`C3-R-1 allowed — ${role} → 200 on both routes (invoice status mirrored; portal NOT_CONFIGURED)`, async () => {
      const s = await get(STATUS, role, '?product_key=sign');
      expect(s.status, JSON.stringify(s.body)).toBe(200);
      expect(s.body).toMatchObject({ tenant_id: TENANT, availability: 'AVAILABLE', mode: 'test', subscription: { subscription_ref: 'sub_c3', open: true }, provider_subscription: { provider_status: 'past_due', current_period_end: '2026-11-01T00:00:00.000Z' }, read_at: '2026-10-26T12:00:00.000Z' });
      expect(s.body.invoices).toEqual([
        expect.objectContaining({ invoice_ref: 'in_c3', payment_state: 'OVERDUE', provider_status: 'open', currency: 'usd', amount_remaining_minor: 4900, due_at: '2026-10-15T00:00:00.000Z', hosted_url: 'https://invoice.test/in_c3' }),
      ]);
      const p = await get(PORTAL, role);
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      expect(p.body).toMatchObject({ availability: 'AVAILABLE', configuration_ref: null, configuration_state: 'NOT_CONFIGURED', configuration: null });
      expect(status.tenantBillingStatus).toHaveBeenCalledTimes(1);
      expect(status.portalConfigurationStatus).toHaveBeenCalledTimes(1);
    });
  }

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

  it('C3-R-4 passes the tenant, product and invoice_limit through, typed', async () => {
    expect((await get(STATUS, 'read_only_auditor', '?product_key=sign&invoice_limit=25')).status).toBe(200);
    expect(status.tenantBillingStatus).toHaveBeenCalledWith(TENANT, 'sign', { invoice_limit: 25 });
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
