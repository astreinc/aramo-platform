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
import { ProductContextError, UsageRollupService, type UsageReconciliation } from '@aramo/subscription';

import { PlatformCommercialUsageController } from '../app/platform/platform-commercial-usage.controller.js';

import { generateTestKeyPair } from './test-keys.js';

// CCP-D1 (PBD §5.4 row D1; brief "per-role read-route tests (super_admin refused)") — both
// /platform/commercial/usage routes under platform:subscription:read, for each of the 6 CCP
// platform roles and super_admin, one role per principal, through the REAL request chain: a
// signed platform token → the real JwtAuthGuard (server-side effective-scope resolution) → the
// real RolesGuard (@RequireScopes) → the controller's consumer_type tripwire → the filter.
//
// Expected (CCP A1 §4.1 :112): allowed — platform_owner, finance_admin, commercial_ops,
// support_admin, read_only_auditor; refused — catalog_manager and super_admin (no commercial
// scope, INV-1; PBD §12). Bundles restated from §4.1 (the A1/A2 specs' convention).

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
const REC = '/platform/commercial/usage/reconciliation';
const PERIODS = '/platform/commercial/usage/periods';
const TENANT = '0190d1d1-0000-7000-8000-0000000000aa';

class RoleBundleResolver implements EffectiveAuthorizationResolver {
  readonly roleOf = new Map<string, string>();
  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const role = this.roleOf.get(input.principal_id);
    const scopes = role === undefined ? [] : [...(BUNDLES[role] ?? [])];
    return { status: 'ok', scopes: filterScopesForConsumer({ consumer: input.consumer_type, scopes, tenantHasEsign: false }) };
  }
}

const COUNTS = { consumed: 3, consumed_send: 3, consumed_historical: 0, reserved: 1 };
const RECONCILED: UsageReconciliation = {
  product_key: 'sign',
  status: 'RECONCILED',
  checked_at: new Date('2026-10-25T00:00:00.000Z'),
  metrics: [
    {
      metric_key: 'sign.envelopes',
      product_key: 'sign',
      status: 'RECONCILED',
      watermark: '801',
      last_run_id: '01a1730b-0099-70ec-a374-cb6339bc34fb',
      buckets: { source: 1, rollup: 1, pending: 0, compared: 1, mismatched: 0 },
      compared_totals: { allowance_usage: COUNTS, rollup: COUNTS },
      usage_event: { event_type: 'sign.envelope.sent', tenants: 1, mismatched_tenants: 0, allowance_usage_consumed_send: 3, usage_event_quantity: 3 },
      mismatch_count: 0,
      mismatches: [],
    },
  ],
};
const PERIOD = {
  tenant_id: TENANT,
  metric_key: 'sign.envelopes',
  product_key: 'sign',
  period_start: new Date('2026-10-01T00:00:00.000Z'),
  period_end: new Date('2026-11-01T00:00:00.000Z'),
  alignment: 'ALIGNED' as const,
  subscription_id: '0190d1d2-0000-7000-8000-0000000000aa',
  plan_version_id: '0190d1d3-0000-7000-8000-0000000000aa',
  included_quantity: 100,
  unlimited: false,
  counts: COUNTS,
  stale: false,
  computed_at: new Date('2026-10-25T00:00:00.000Z'),
};

describe('CCP-D1 — per-role authorization on /platform/commercial/usage (real JwtAuthGuard + RolesGuard)', () => {
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-d1-test';
  const saved: Record<string, string | undefined> = {};
  const resolver = new RoleBundleResolver();
  const principal = new Map<string, string>();
  const usage = {
    reconcile: vi.fn(async () => RECONCILED),
    listPeriods: vi.fn(async () => ({ ok: true as const, reconciliation: RECONCILED, periods: [PERIOD], truncated: false })),
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
      controllers: [PlatformCommercialUsageController],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: resolver },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
        { provide: UsageRollupService, useValue: usage },
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
    usage.reconcile.mockClear();
    usage.listPeriods.mockClear();
  });

  it('D1-AUTH-0 the matrix is the §4.1 one: exactly the 5 allowed roles hold the scope; super_admin holds no commercial scope', () => {
    expect(Object.keys(BUNDLES).filter((r) => BUNDLES[r]?.includes(SCOPE)).sort()).toEqual([...ALLOWED].sort());
    expect(BUNDLES['super_admin']?.some((s) => /^platform:(commercial|catalog|subscription|entitlement|billing|approval):/.test(s))).toBe(false);
  });

  for (const role of ALLOWED) {
    it(`D1-AUTH allowed — ${role} → 200 on reconciliation and periods`, async () => {
      const r = await get(role, REC);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ product_key: 'sign', status: 'RECONCILED', checked_at: '2026-10-25T00:00:00.000Z' });
      const p = await get(role, `${PERIODS}?tenant_id=${TENANT}`);
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      expect(p.body).toEqual({
        product_key: 'sign',
        reconciliation: { status: 'RECONCILED', checked_at: '2026-10-25T00:00:00.000Z' },
        truncated: false,
        periods: [{ ...PERIOD, period_start: '2026-10-01T00:00:00.000Z', period_end: '2026-11-01T00:00:00.000Z', computed_at: '2026-10-25T00:00:00.000Z' }],
      });
    });
  }

  for (const role of REFUSED) {
    it(`D1-AUTH refused — ${role} → 403 missing ${SCOPE} on both routes; the service is never reached`, async () => {
      for (const path of [REC, PERIODS]) {
        const res = await get(role, path);
        expect(res.status).toBe(403);
        expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
        expect(res.body?.error?.details?.missing_scopes).toEqual([SCOPE]);
      }
      expect(usage.reconcile).not.toHaveBeenCalled();
      expect(usage.listPeriods).not.toHaveBeenCalled();
    });
  }

  it('D1-AUTH refused — no token → 401; a tenant-tier token for an allowed role → 403', async () => {
    expect((await request(app.getHttpServer()).get(REC)).status).toBe(401);
    const res = await get('platform_owner', PERIODS, 'recruiter');
    expect(res.status).toBe(403);
    expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    expect(usage.listPeriods).not.toHaveBeenCalled();
  });

  it('D1-RO analytics are refused 409 USAGE_ROLLUP_NOT_RECONCILED when the totals do not reconcile (and when never run)', async () => {
    const notRec: UsageReconciliation = { ...RECONCILED, status: 'NOT_RECONCILED', metrics: [{ ...RECONCILED.metrics[0]!, status: 'NOT_RECONCILED', mismatch_count: 2 }] };
    usage.listPeriods.mockResolvedValueOnce({ ok: false, reconciliation: notRec } as never);
    const res = await get('finance_admin', PERIODS);
    expect(res.status).toBe(409);
    expect(res.body?.error?.code).toBe('USAGE_ROLLUP_NOT_RECONCILED');
    expect(res.body?.error?.details).toEqual({ status: 'NOT_RECONCILED', mismatch_count: 2, checked_at: '2026-10-25T00:00:00.000Z' });
    usage.listPeriods.mockResolvedValueOnce({ ok: false, reconciliation: { ...RECONCILED, status: 'NOT_RUN', metrics: [{ ...RECONCILED.metrics[0]!, status: 'NOT_RUN' }] } } as never);
    const never = await get('finance_admin', PERIODS);
    expect([never.status, never.body?.error?.details?.status]).toEqual([409, 'NOT_RUN']);
  });

  it('passes every filter through, typed', async () => {
    const res = await get('read_only_auditor', `${PERIODS}?product_key=sign&metric_key=sign.envelopes&tenant_id=${TENANT}&from=2026-09-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z&include_daily=true&limit=25`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(usage.listPeriods).toHaveBeenCalledWith({
      product_key: 'sign',
      metric_key: 'sign.envelopes',
      tenant_id: TENANT,
      from: new Date('2026-09-01T00:00:00.000Z'),
      to: new Date('2026-11-01T00:00:00.000Z'),
      include_daily: true,
      limit: 25,
    });
  });

  const bad: Array<[string, string, string]> = [
    ['product_key outside the registry', REC, '?product_key=ats'],
    ['product_key outside the registry (periods)', PERIODS, '?product_key=ats'],
    ['tenant_id not a uuid', PERIODS, '?tenant_id=nope'],
    ['metric_key malformed', PERIODS, '?metric_key=Sign'],
    ['from not ISO-8601', PERIODS, '?from=yesterday'],
    ['include_daily not a boolean literal', PERIODS, '?include_daily=yes'],
    ['limit above 500', PERIODS, '?limit=501'],
    ['unknown parameter', PERIODS, '?price=1'],
    ['from not earlier than to', PERIODS, '?from=2026-10-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z'],
  ];
  for (const [name, path, q] of bad) {
    it(`400 VALIDATION_ERROR — ${name}`, async () => {
      const res = await get('finance_admin', `${path}${q}`);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body?.error?.code).toBe('VALIDATION_ERROR');
      expect(usage.listPeriods).not.toHaveBeenCalled();
      expect(usage.reconcile).not.toHaveBeenCalled();
    });
  }

  it('400 VALIDATION_ERROR (unknown_metric) when the metric is not registered for the product', async () => {
    usage.listPeriods.mockRejectedValueOnce(new ProductContextError('usage metric sign.storage_bytes is not registered for product sign'));
    const res = await get('finance_admin', `${PERIODS}?metric_key=sign.storage_bytes`);
    expect([res.status, res.body?.error?.code, res.body?.error?.details?.reason]).toEqual([400, 'VALIDATION_ERROR', 'unknown_metric']);
  });
});
