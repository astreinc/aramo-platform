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
import { BillingStatusReadService, RefundablePaymentsService, type RefundablePayments } from '@aramo/subscription';

import { PlatformCommercialBillingStatusController } from '../app/platform/platform-commercial-billing-status.controller.js';

import { generateTestKeyPair } from './test-keys.js';

// Aramo-CCP-Console-Refund-Request-Directive-v1_0-LOCKED §2 item 1 + Amendment A2 (A2-3) —
// GET /platform/commercial/tenants/{tenant_id}/refundable-payments through the REAL request chain
// (signed platform token → JwtAuthGuard → RolesGuard → controller gate → AramoExceptionFilter), per
// role. Allowed: a Finance amount holder (platform_owner, finance_admin, read_only_auditor) and the
// refund requester (commercial_ops, platform:billing:request — the narrow FA-1 exception, this route
// only). Refused 403: support_admin (billing reader, neither scope), catalog_manager and super_admin.

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
const ALLOWED = ['platform_owner', 'finance_admin', 'read_only_auditor', 'commercial_ops'] as const;
const REFUSED_GATE = ['support_admin'] as const;
const REFUSED_ROUTE = ['catalog_manager', 'super_admin'] as const;
const TENANT = '0190dddd-0000-7000-8000-0000000c3101';
const PATH = `/platform/commercial/tenants/${TENANT}/refundable-payments`;

class RoleBundleResolver implements EffectiveAuthorizationResolver {
  readonly roleOf = new Map<string, string>();
  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const role = this.roleOf.get(input.principal_id);
    const scopes = role === undefined ? [] : [...(BUNDLES[role] ?? [])];
    return { status: 'ok', scopes: filterScopesForConsumer({ consumer: input.consumer_type, scopes, tenantHasEsign: false }) };
  }
}

const T = new Date('2026-11-16T12:00:00.000Z');
const RESULT: RefundablePayments = {
  tenant_id: TENANT,
  product_key: 'sign',
  availability: 'AVAILABLE',
  mode: 'live',
  subscription_id: '019a0000-0000-7000-8000-0000000c3b01',
  payments: [
    {
      invoice_ref: 'in_rfr1',
      number: 'ARAMO-0001',
      payment_ref: 'pi_rfr1',
      currency: 'USD',
      amount_paid_minor: 1000,
      created_at: new Date('2026-11-15T10:00:00Z'),
      period_start: new Date('2026-11-15T10:00:00Z'),
      period_end: new Date('2026-12-15T10:00:00Z'),
      refunded_minor: 0,
      reserved_minor: 0,
      disputed_lost_minor: 0,
      remainder_minor: 1000,
      refusal: null,
      live: true,
    },
  ],
  detail: null,
  read_at: T,
};

describe('Console Refund Request — per-role authorization on GET refundable-payments (real JwtAuthGuard + RolesGuard)', () => {
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-rfr-test';
  const saved: Record<string, string | undefined> = {};
  const resolver = new RoleBundleResolver();
  const principal = new Map<string, string>();
  const refundable = { list: vi.fn(async (): Promise<RefundablePayments> => RESULT) };

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
  const get = async (role: string, query = '?product_key=sign', consumer_type = 'platform') =>
    request(app.getHttpServer()).get(`${PATH}${query}`).set('Authorization', `Bearer ${await tokenFor(role, consumer_type)}`);

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
        { provide: BillingStatusReadService, useValue: { tenantBillingStatus: vi.fn(), portalConfigurationStatus: vi.fn() } },
        { provide: RefundablePaymentsService, useValue: refundable },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: never, res: never, next: () => void) => new RequestIdMiddleware().use(req, res, next));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    await app.listen(0, '127.0.0.1');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => refundable.list.mockClear());

  it('RFR-R-0 the matrix: commercial_ops alone holds platform:billing:request; the amount holders are the FA-2 three', () => {
    expect(Object.keys(BUNDLES).filter((r) => BUNDLES[r]?.includes('platform:billing:request'))).toEqual(['commercial_ops']);
    expect(Object.keys(BUNDLES).filter((r) => BUNDLES[r]?.includes(AMOUNT)).sort()).toEqual(['finance_admin', 'platform_owner', 'read_only_auditor']);
  });

  for (const role of ALLOWED) {
    it(`RFR-R-1 allowed — ${role} → 200 with the payments, ISO dates, remainder and payment ref`, async () => {
      const res = await get(role);
      expect(res.status).toBe(200);
      expect(refundable.list).toHaveBeenCalledWith(TENANT, 'sign');
      expect(res.body.payments[0]).toMatchObject({ invoice_ref: 'in_rfr1', payment_ref: 'pi_rfr1', currency: 'USD', amount_paid_minor: 1000, remainder_minor: 1000, refusal: null, created_at: '2026-11-15T10:00:00.000Z' });
      expect(res.body.read_at).toBe(T.toISOString());
    });
  }

  for (const role of REFUSED_GATE) {
    it(`RFR-R-2 refused by the controller gate — ${role} (billing reader without amount or request scope) → 403, service not reached`, async () => {
      const res = await get(role);
      expect(res.status).toBe(403);
      expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(res.body?.error?.details?.reason).toBe('refundable_payments_scope_required');
      expect(JSON.stringify(res.body)).not.toMatch(/in_rfr1|pi_rfr1|1000/);
      expect(refundable.list).not.toHaveBeenCalled();
    });
  }

  for (const role of REFUSED_ROUTE) {
    it(`RFR-R-3 refused by the route scope — ${role} → 403 (missing ${SCOPE})`, async () => {
      const res = await get(role);
      expect(res.status).toBe(403);
      expect(res.body?.error?.details?.missing_scopes).toEqual([SCOPE]);
      expect(refundable.list).not.toHaveBeenCalled();
    });
  }

  it('RFR-R-4 no token → 401; a tenant-tier token → 403; an unknown product_key → 400', async () => {
    expect((await request(app.getHttpServer()).get(`${PATH}?product_key=sign`)).status).toBe(401);
    expect((await get('commercial_ops', '?product_key=sign', 'recruiter')).status).toBe(403);
    expect((await get('commercial_ops', '?product_key=nope')).status).toBe(400);
    expect(refundable.list).not.toHaveBeenCalled();
  });
});
