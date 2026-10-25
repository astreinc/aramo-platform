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
import { CommercialSubscriptionReadService, type TenantCommercialOverview, type WorkbenchRow, type WorkbenchSubscription } from '@aramo/subscription';

import { PlatformCommercialSubscriptionsController } from '../app/platform/platform-commercial-subscriptions.controller.js';

import { generateTestKeyPair } from './test-keys.js';

// CCP-B3 (PBD §5.3 row B3; pre-execution record C-1) — the two read routes behind the
// Subscriptions workbench and the tenant Commercial tab, under platform:subscription:read, for
// each of the 6 CCP platform roles and super_admin, one role per principal, through the REAL
// request chain: a signed platform token → the real JwtAuthGuard (server-side effective-scope
// resolution) → the real RolesGuard (@RequireScopes) → the controller's consumer_type tripwire →
// the filter. The service is mocked (its SQL is ccp-b3-subscription-read.integration.spec.ts).
//
// Expected (CCP A1 §4.1 :112): allowed — platform_owner, finance_admin, commercial_ops,
// support_admin, read_only_auditor; refused — catalog_manager and super_admin (no commercial
// scope, INV-1; PBD §12). Bundles restated from §4.1 (the A1/A2/D1 specs' convention). No money
// (PLATFORM-UX-1 A1-4a): neither body carries a price, amount or currency key.

const SCOPE = 'platform:subscription:read';
const ENTRY = 'platform:tenant:read';
const BUNDLES: Record<string, readonly string[]> = {
  platform_owner: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:catalog:publish', SCOPE, 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read'],
  finance_admin: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', SCOPE, 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read'],
  commercial_ops: [ENTRY, 'platform:catalog:read', SCOPE, 'platform:subscription:request', 'platform:entitlement:request', 'platform:billing:read', 'platform:billing:request', 'platform:approval:read'],
  catalog_manager: [ENTRY, 'platform:catalog:read', 'platform:catalog:draft', 'platform:approval:read'],
  support_admin: [ENTRY, 'platform:catalog:read', SCOPE, 'platform:subscription:support', 'platform:billing:read', 'platform:approval:read'],
  read_only_auditor: [ENTRY, 'platform:catalog:read', SCOPE, 'platform:billing:read', 'platform:approval:read', 'platform:commercial:audit:read'],
  super_admin: ['platform:tenant:provision', ENTRY, 'platform:admin:invite', 'platform:tenant:lifecycle:manage', 'platform:skill:read', 'platform:skill:manage', 'platform:document_template:read', 'platform:document_template:manage', 'platform:matching_policy:read', 'platform:matching_policy:write'],
};
const ALLOWED = ['platform_owner', 'finance_admin', 'commercial_ops', 'support_admin', 'read_only_auditor'] as const;
const REFUSED = ['catalog_manager', 'super_admin'] as const;
const LIST = '/platform/commercial/subscriptions';
const TENANT = '0190d1d1-0000-7000-8000-0000000000aa';
const UNKNOWN = '0190d1d1-0000-7000-8000-0000000000ff';
const OVERVIEW = `/platform/commercial/tenants/${TENANT}/commercial`;

class RoleBundleResolver implements EffectiveAuthorizationResolver {
  readonly roleOf = new Map<string, string>();
  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const role = this.roleOf.get(input.principal_id);
    const scopes = role === undefined ? [] : [...(BUNDLES[role] ?? [])];
    return { status: 'ok', scopes: filterScopesForConsumer({ consumer: input.consumer_type, scopes, tenantHasEsign: false }) };
  }
}

const D = (s: string) => new Date(s);
const SUB: WorkbenchSubscription = {
  subscription_id: '0190d1d2-0000-7000-8000-0000000000aa',
  product_key: 'sign',
  plan: { id: '0190d1d4-0000-7000-8000-0000000000aa', key: 'sign-enterprise', name: 'Sign Enterprise', sales_model: 'CONTACT_SALES' },
  plan_version: { id: '0190d1d3-0000-7000-8000-0000000000aa', version_number: 2, status: 'PUBLISHED' },
  source: 'MANUAL',
  status: 'ACTIVE',
  started_at: D('2026-09-01T00:00:00.000Z'),
  ended_at: null,
  period_anchor: D('2026-09-01T00:00:00.000Z'),
  current_period: { start: D('2026-10-01T00:00:00.000Z'), end: D('2026-11-01T00:00:00.000Z') },
  current_period_end: null,
  grace_until: null,
  commitment_end: D('2027-09-01T00:00:00.000Z'),
  contract: { id: '0190d1d5-0000-7000-8000-0000000000aa', contract_ref: 'CT-2026-0001' },
  provider_linked: false,
  open_flags: ['governed_subscription_open'],
  active_extensions: { count: 1, exception: false },
};
const ROW: WorkbenchRow = { ...SUB, tenant: { id: TENANT, name: 'Acme', slug: 'acme' } };
const NONE_ENT = (capability: string) => ({ capability, state: 'NONE' as const, granted_source: null, granted_at: null, granted_by: null, change_request_id: null, revoked_at: null, revoked_by: null, revoke_change_request_id: null });
// CCP-C5 — every billing read carries the designed disabled tax state.
const TAX = { enabled: false, reason: 'STRIPE_TAX_NOT_REGISTERED' } as const;
const OVERVIEW_RESULT: TenantCommercialOverview = {
  as_of: D('2026-10-25T00:00:00.000Z'),
  tenant: { id: TENANT, name: 'Acme', slug: 'acme', kind: 'BUSINESS' },
  products: [
    {
      product_key: 'sign',
      registered: true,
      entitlement: { ...NONE_ENT('sign'), state: 'ACTIVE', granted_source: 'PLAN', granted_at: D('2026-09-01T00:00:00.000Z'), granted_by: '0190d1d6-0000-7000-8000-0000000000aa', change_request_id: '0190d1d7-0000-7000-8000-0000000000aa' },
      subscription: SUB,
      flags: [
        {
          id: '0190d1d8-0000-7000-8000-0000000000aa',
          reason: 'governed_subscription_open',
          provider: 'STRIPE',
          subscription_ref: 'sub_held_1',
          intent_id: null,
          detected_at: D('2026-10-20T00:00:00.000Z'),
          conversion: { change_request_id: '0190d1d9-0000-7000-8000-0000000000aa', state: 'PENDING_APPROVAL', direction: 'TO_GOVERNED' },
        },
      ],
      open_request: { id: '0190d1d9-0000-7000-8000-0000000000aa', action_type: 'CONVERSION', kind: 'SUBSCRIPTION', state: 'PENDING_APPROVAL', requested_by: '0190d1d6-0000-7000-8000-0000000000aa', created_at: D('2026-10-21T00:00:00.000Z') },
    },
    ...(['ats', 'portal', 'intelligence'] as const).map((product_key) => ({ product_key, registered: false, entitlement: NONE_ENT(product_key), subscription: null, flags: [], open_request: null })),
  ],
  tax: { ...TAX },
};

/** Every key anywhere in a JSON value (deep). */
function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) allKeys(x, out);
  else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); allKeys(x, out); }
  return out;
}

describe('CCP-B3 — per-role authorization on the Subscriptions workbench and tenant Commercial reads (real JwtAuthGuard + RolesGuard)', () => {
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-b3-test';
  const saved: Record<string, string | undefined> = {};
  const resolver = new RoleBundleResolver();
  const principal = new Map<string, string>();
  const reads = {
    listWorkbench: vi.fn(async () => ({ as_of: D('2026-10-25T00:00:00.000Z'), rows: [ROW] })),
    tenantOverview: vi.fn(async (tenant_id: string) => (tenant_id === TENANT ? OVERVIEW_RESULT : null)),
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
  const get = async (role: string, path: string, consumer_type = 'platform') =>
    request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${await tokenFor(role, consumer_type)}`);

  beforeAll(async () => {
    const keys = generateTestKeyPair();
    privatePem = keys.privatePem;
    for (const k of ['AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY']) saved[k] = process.env[k];
    process.env['AUTH_AUDIENCE'] = audience;
    process.env['AUTH_PUBLIC_KEY'] = keys.publicPem;
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, AuthorizationModule],
      controllers: [PlatformCommercialSubscriptionsController],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: resolver },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
        { provide: CommercialSubscriptionReadService, useValue: reads },
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
    reads.listWorkbench.mockClear();
    reads.tenantOverview.mockClear();
  });

  it('B3-AUTH-0 the matrix is the §4.1 one: exactly the 5 allowed roles hold the scope; super_admin holds no commercial scope', () => {
    expect(Object.keys(BUNDLES).filter((r) => BUNDLES[r]?.includes(SCOPE)).sort()).toEqual([...ALLOWED].sort());
    expect(BUNDLES['super_admin']?.some((s) => /^platform:(commercial|catalog|subscription|entitlement|billing|approval):/.test(s))).toBe(false);
  });

  for (const role of ALLOWED) {
    it(`B3-AUTH allowed — ${role} → 200 on the workbench and the tenant overview`, async () => {
      const l = await get(role, LIST);
      expect(l.status, JSON.stringify(l.body)).toBe(200);
      expect(l.body).toEqual({
        as_of: '2026-10-25T00:00:00.000Z',
        rows: [
          {
            ...ROW,
            started_at: '2026-09-01T00:00:00.000Z',
            period_anchor: '2026-09-01T00:00:00.000Z',
            current_period: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
            commitment_end: '2027-09-01T00:00:00.000Z',
          },
        ],
      });
      const o = await get(role, OVERVIEW);
      expect(o.status, JSON.stringify(o.body)).toBe(200);
      expect(o.body.tenant).toEqual({ id: TENANT, name: 'Acme', slug: 'acme', kind: 'BUSINESS' });
      // CCP-C5 — the designed disabled tax state is passed through exactly.
      expect(o.body.tax).toEqual(TAX);
      expect(o.body.products.map((p: { product_key: string; registered: boolean }) => [p.product_key, p.registered])).toEqual([['sign', true], ['ats', false], ['portal', false], ['intelligence', false]]);
      expect(o.body.products[0].entitlement).toMatchObject({ state: 'ACTIVE', granted_source: 'PLAN', granted_at: '2026-09-01T00:00:00.000Z', revoked_at: null });
      expect(o.body.products[0].flags[0]).toEqual({ ...OVERVIEW_RESULT.products[0]!.flags[0], detected_at: '2026-10-20T00:00:00.000Z' });
      expect(o.body.products[0].open_request).toMatchObject({ action_type: 'CONVERSION', created_at: '2026-10-21T00:00:00.000Z' });
      expect(o.body.products[1]).toEqual({ product_key: 'ats', registered: false, entitlement: NONE_ENT('ats'), subscription: null, flags: [], open_request: null });
    });
  }

  for (const role of REFUSED) {
    it(`B3-AUTH refused — ${role} → 403 missing ${SCOPE} on both routes; the service is never reached`, async () => {
      for (const path of [LIST, OVERVIEW]) {
        const res = await get(role, path);
        expect(res.status).toBe(403);
        expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
        expect(res.body?.error?.details?.missing_scopes).toContain(SCOPE);
      }
      expect(reads.listWorkbench).not.toHaveBeenCalled();
      expect(reads.tenantOverview).not.toHaveBeenCalled();
    });
  }

  it('B3-AUTH refused — no token → 401; a tenant-tier token for an allowed role → 403 on both routes', async () => {
    expect((await request(app.getHttpServer()).get(LIST)).status).toBe(401);
    for (const path of [LIST, OVERVIEW]) {
      const res = await get('platform_owner', path, 'recruiter');
      expect(res.status).toBe(403);
      expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    }
    expect(reads.listWorkbench).not.toHaveBeenCalled();
    expect(reads.tenantOverview).not.toHaveBeenCalled();
  });

  it('B3-AUTH product_key passes through; an unregistered product_key or unknown parameter is 400 VALIDATION_ERROR', async () => {
    const ok = await get('read_only_auditor', `${LIST}?product_key=sign`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(reads.listWorkbench).toHaveBeenCalledWith({ product_key: 'sign' });
    reads.listWorkbench.mockClear();
    for (const q of ['?product_key=ats', '?price=1']) {
      const res = await get('read_only_auditor', `${LIST}${q}`);
      expect([res.status, res.body?.error?.code]).toEqual([400, 'VALIDATION_ERROR']);
    }
    expect(reads.listWorkbench).not.toHaveBeenCalled();
  });

  it('B3-AUTH a malformed tenant id is 400; an unknown tenant is 404 NOT_FOUND with details.tenant_id', async () => {
    const bad = await get('commercial_ops', '/platform/commercial/tenants/not-a-uuid/commercial');
    expect(bad.status, JSON.stringify(bad.body)).toBe(400);
    expect(reads.tenantOverview).not.toHaveBeenCalled();
    const missing = await get('commercial_ops', `/platform/commercial/tenants/${UNKNOWN}/commercial`);
    expect(missing.status, JSON.stringify(missing.body)).toBe(404);
    expect(missing.body?.error?.code).toBe('NOT_FOUND');
    expect(missing.body?.error?.details).toEqual({ tenant_id: UNKNOWN });
    expect(reads.tenantOverview).toHaveBeenCalledWith(UNKNOWN);
  });

  it('B3-NO-MONEY neither body carries a price, amount or currency key anywhere (deep scan; PLATFORM-UX-1 A1-4a)', async () => {
    for (const path of [LIST, OVERVIEW]) {
      const res = await get('finance_admin', path);
      expect(res.status).toBe(200);
      const keys = allKeys(res.body);
      expect(keys.length).toBeGreaterThan(10);
      expect(keys.filter((k) => /price|amount|currency/i.test(k))).toEqual([]);
    }
  });
});
