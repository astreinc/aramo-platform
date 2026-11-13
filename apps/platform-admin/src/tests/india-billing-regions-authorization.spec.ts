import 'reflect-metadata';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
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
import { CommercialBillingRegionReadService } from '@aramo/subscription';

import { PlatformCommercialBillingRegionsController } from '../app/platform/platform-commercial-billing-regions.controller.js';

import { generateTestKeyPair } from './test-keys.js';

// India Billing Regions + Razorpay Directive v1.0 (LOCKED) §4.10 — the route GATE of
// GET /platform/commercial/billing-regions through the real request chain (signed platform token →
// JwtAuthGuard → RolesGuard → consumer tripwire → AramoExceptionFilter), the read service mocked:
// platform:catalog:read admits the 6 CCP roles and refuses super_admin, a tenant tier and no token;
// the response maps the region read (registration and open requests included). The controller
// declares no write route (a change is a BILLING_REGION_CHANGE change request).

const READ = 'platform:catalog:read';
const ENTRY = 'platform:tenant:read';
const BUNDLES: Record<string, readonly string[]> = {
  platform_owner: [ENTRY, READ, 'platform:catalog:approve', 'platform:catalog:publish', 'platform:approval:read'],
  finance_admin: [ENTRY, READ, 'platform:catalog:approve', 'platform:billing:read', 'platform:approval:read'],
  commercial_ops: [ENTRY, READ, 'platform:subscription:request', 'platform:approval:read'],
  catalog_manager: [ENTRY, READ, 'platform:catalog:draft', 'platform:approval:read'],
  support_admin: [ENTRY, READ, 'platform:subscription:support', 'platform:approval:read'],
  read_only_auditor: [ENTRY, READ, 'platform:approval:read'],
  super_admin: ['platform:tenant:provision', ENTRY, 'platform:admin:invite', 'platform:tenant:lifecycle:manage'],
};
const CCP_ROLES = ['platform_owner', 'finance_admin', 'commercial_ops', 'catalog_manager', 'support_admin', 'read_only_auditor'] as const;

class RoleBundleResolver implements EffectiveAuthorizationResolver {
  readonly roleOf = new Map<string, string>();
  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const role = this.roleOf.get(input.principal_id);
    const scopes = role === undefined ? [] : [...(BUNDLES[role] ?? [])];
    return { status: 'ok', scopes: filterScopesForConsumer({ consumer: input.consumer_type, scopes, tenantHasEsign: false }) };
  }
}

const REQ = '019a0000-0000-7000-8000-00000000cc01';
const AT = new Date('2026-11-13T10:00:00.000Z');
const INDIA = {
  country: 'IN',
  gateway: 'RAZORPAY' as const,
  currency: 'INR',
  enabled: false,
  personal_web_enabled: false,
  business_web_enabled: false,
  price_tax_mode: 'UNSET' as const,
  selling_entity: { id: '019a0000-0000-7000-8000-0000000a1e02', key: 'aramo-in', display_name: 'Aramo India', legal_name: 'Aramo India', country: 'IN', active: false },
  gateway_configured: false,
  enable_refusal: 'gateway_not_configured' as const,
  registration: { gstin: '27AAPFU0939F1ZV' },
  open_requests: [{ id: REQ, state: 'PENDING_APPROVAL', requested_by: 'u1', created_at: AT, expires_at: null }],
};
const readMock = { listDetailed: vi.fn(async () => [INDIA]) };
const PATH = '/platform/commercial/billing-regions';

describe('India Billing §4.10 — GET /platform/commercial/billing-regions (real JwtAuthGuard + RolesGuard, service mocked)', () => {
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-india-billing-test';
  const saved: Record<string, string | undefined> = {};
  const resolver = new RoleBundleResolver();
  const principal = new Map<string, string>();

  async function tokenFor(role: string, consumer_type = 'platform'): Promise<string> {
    const k = `${role}:${consumer_type}`;
    let sub = principal.get(k);
    if (sub === undefined) {
      sub = uuidv7();
      principal.set(k, sub);
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
  const get = async (role: string, consumer?: string) => request(app.getHttpServer()).get(PATH).set('Authorization', `Bearer ${await tokenFor(role, consumer)}`);

  beforeAll(async () => {
    const keys = generateTestKeyPair();
    privatePem = keys.privatePem;
    for (const k of ['AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY']) saved[k] = process.env[k];
    process.env['AUTH_AUDIENCE'] = audience;
    process.env['AUTH_PUBLIC_KEY'] = keys.publicPem;
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, AuthorizationModule],
      controllers: [PlatformCommercialBillingRegionsController],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: resolver },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
        { provide: CommercialBillingRegionReadService, useValue: readMock },
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

  beforeEach(() => readMock.listDetailed.mockClear());

  for (const role of CCP_ROLES) {
    it(`IB-RT-1 admits ${role} (platform:catalog:read)`, async () => {
      const res = await get(role);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(readMock.listDetailed).toHaveBeenCalledTimes(1);
    });
  }

  it('IB-RT-2 refuses super_admin (no platform:catalog:read) before the service', async () => {
    const res = await get('super_admin');
    expect(res.status).toBe(403);
    expect(res.body?.error?.details?.missing_scopes).toEqual([READ]);
    expect(readMock.listDetailed).not.toHaveBeenCalled();
  });

  it('IB-RT-3 refuses a tenant-tier token (403) and no token (401)', async () => {
    expect((await get('catalog_manager', 'recruiter')).status).toBe(403);
    expect((await request(app.getHttpServer()).get(PATH)).status).toBe(401);
    expect(readMock.listDetailed).not.toHaveBeenCalled();
  });

  it('IB-RT-4 maps the region read: gateway state, G-3 refusal, registration and open requests (ISO dates)', async () => {
    const res = await get('finance_admin');
    expect(res.body).toEqual({
      regions: [{ ...INDIA, open_requests: [{ id: REQ, state: 'PENDING_APPROVAL', requested_by: 'u1', created_at: AT.toISOString(), expires_at: null }] }],
    });
  });

  it('IB-RT-5 the controller declares exactly one route, a GET (no write route; changes are change requests)', () => {
    const proto = PlatformCommercialBillingRegionsController.prototype as unknown as Record<string, unknown>;
    const handlers = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor' && Reflect.getMetadata(METHOD_METADATA, proto[n] as object) !== undefined);
    expect(handlers).toEqual(['list']);
    expect(Reflect.getMetadata(PATH_METADATA, PlatformCommercialBillingRegionsController)).toBe('platform/commercial/billing-regions');
  });
});
