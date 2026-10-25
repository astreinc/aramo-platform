import 'reflect-metadata';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
import { RequestMethod, ValidationPipe, type INestApplication } from '@nestjs/common';
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
import { CommercialCatalogError, CommercialCatalogService, CommercialPolicyUnavailableError } from '@aramo/subscription';

import { PlatformCommercialCatalogController } from '../app/platform/platform-commercial-catalog.controller.js';

import { generateTestKeyPair } from './test-keys.js';

// CCP-B2 — the route GATE for /platform/commercial/catalog (4 routes) through the REAL request
// chain (signed platform token → real JwtAuthGuard → real RolesGuard → consumer tripwire →
// AramoExceptionFilter), with the service mocked:
//   reads  (platform:catalog:read)   admit the 6 CCP roles; refuse super_admin before the service
//   drafts (platform:catalog:draft)  admit catalog_manager only; refuse the other 5 CCP roles
//                                    and super_admin before the service
// plus the tenant tier (403) and no token (401) on every route, the DTO 400s (no field for the
// v1 locks, the plan identity or a new term), the service-error mapping, and the structural
// proof that the controller declares NO publish, retire or apply route. The outcomes below the
// gate run on real Postgres in ccp-b2-commercial-catalog-routes.integration.spec.ts.

const READ = 'platform:catalog:read';
const DRAFT = 'platform:catalog:draft';
const ENTRY = 'platform:tenant:read';
const BUNDLES: Record<string, readonly string[]> = {
  platform_owner: [ENTRY, READ, 'platform:catalog:approve', 'platform:catalog:publish', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read'],
  finance_admin: [ENTRY, READ, 'platform:catalog:approve', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read'],
  commercial_ops: [ENTRY, READ, 'platform:subscription:read', 'platform:subscription:request', 'platform:entitlement:request', 'platform:billing:read', 'platform:billing:request', 'platform:approval:read'],
  catalog_manager: [ENTRY, READ, DRAFT, 'platform:approval:read'],
  support_admin: [ENTRY, READ, 'platform:subscription:read', 'platform:subscription:support', 'platform:billing:read', 'platform:approval:read'],
  read_only_auditor: [ENTRY, READ, 'platform:subscription:read', 'platform:billing:read', 'platform:approval:read', 'platform:commercial:audit:read'],
  super_admin: ['platform:tenant:provision', ENTRY, 'platform:admin:invite', 'platform:tenant:lifecycle:manage', 'platform:skill:read', 'platform:skill:manage', 'platform:document_template:read', 'platform:document_template:manage', 'platform:matching_policy:read', 'platform:matching_policy:write'],
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

const PLAN = '019a0000-5150-7000-8000-000000000011';
const VID = '019a0000-0000-7000-8000-00000000b201';
const NOW = new Date('2026-10-25T00:00:00.000Z');
const TERMS = { list_price_minor: 2000, currency: 'USD', billing_interval: 'MONTH', sales_model: 'SELF_SERVICE', contract_priced: false, envelopes_per_month: null, envelopes_unlimited: true, envelopes_present: true, storage_bytes: 10737418240, storage_unlimited: false, storage_present: true };
const SUMMARY = { id: VID, plan_id: PLAN, version_number: 2, status: 'DRAFT', content_checksum: 'c'.repeat(64), note: null, created_by: 'u', created_at: NOW, published_at: null, retired_at: null, terms: TERMS, pinned_subscriptions: 0, open_requests: [] };
const PLANROW = { id: PLAN, key: 'aramo-sign-standard-business-v1', product_key: 'sign', name: 'Standard Business', status: 'ACTIVE', sales_model: 'SELF_SERVICE', sellable: true, display_order: 20 };

const svcMock = {
  readCatalog: vi.fn(async () => ({ products: [{ product_key: 'sign', plans: [{ ...PLANROW, versions: [SUMMARY] }] }], publish_chain: null })),
  readVersion: vi.fn(async () => ({ version: SUMMARY, plan: PLANROW, content: { format: 1 }, pinned_tenants: [] })),
  createDraft: vi.fn(async () => SUMMARY),
  updateDraft: vi.fn(async () => SUMMARY),
};

type Route = { name: string; method: 'get' | 'post' | 'patch'; path: string; body?: object; fn: keyof typeof svcMock; ok: number; scope: string };
const BASE = '/platform/commercial/catalog';
const PATCH_BODY = { expected_content_checksum: 'c'.repeat(64), list_price_minor: 2500 };
const ROUTES: Route[] = [
  { name: 'GET catalog', method: 'get', path: BASE, fn: 'readCatalog', ok: 200, scope: READ },
  { name: 'GET version', method: 'get', path: `${BASE}/versions/${VID}`, fn: 'readVersion', ok: 200, scope: READ },
  { name: 'POST draft', method: 'post', path: `${BASE}/plans/${PLAN}/drafts`, body: { from_version_id: VID }, fn: 'createDraft', ok: 201, scope: DRAFT },
  { name: 'PATCH draft', method: 'patch', path: `${BASE}/versions/${VID}`, body: PATCH_BODY, fn: 'updateDraft', ok: 200, scope: DRAFT },
];

describe('CCP-B2 — route gate on /platform/commercial/catalog (real JwtAuthGuard + RolesGuard, service mocked)', () => {
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-b2-test';
  const saved: Record<string, string | undefined> = {};
  const resolver = new RoleBundleResolver();
  const principal = new Map<string, string>();

  async function tokenFor(role: string, consumer_type = 'platform', actor_kind = 'user'): Promise<string> {
    const k = `${role}:${consumer_type}`;
    let sub = principal.get(k);
    if (sub === undefined) {
      sub = uuidv7();
      principal.set(k, sub);
      resolver.roleOf.set(sub, role);
    }
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ consumer_type, actor_kind, tenant_id: PLATFORM_TENANT_SENTINEL_ID, authz_version: 1 })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('Aramo Core Auth')
      .setAudience(audience)
      .setSubject(sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(await importPKCS8(privatePem, 'RS256'));
  }
  async function call(r: Route, role: string, opts: { body?: object; consumer?: string; path?: string } = {}) {
    const req = request(app.getHttpServer())[r.method](opts.path ?? r.path).set('Authorization', `Bearer ${await tokenFor(role, opts.consumer)}`);
    return r.method === 'get' ? req : req.send(opts.body ?? r.body ?? {});
  }

  beforeAll(async () => {
    const keys = generateTestKeyPair();
    privatePem = keys.privatePem;
    for (const k of ['AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY']) saved[k] = process.env[k];
    process.env['AUTH_AUDIENCE'] = audience;
    process.env['AUTH_PUBLIC_KEY'] = keys.publicPem;
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, AuthorizationModule],
      controllers: [PlatformCommercialCatalogController],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: resolver },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
        { provide: CommercialCatalogService, useValue: svcMock },
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
    for (const f of Object.values(svcMock)) f.mockClear();
  });

  it('B2-RT-0 the read scope is held by exactly the 6 CCP roles, the draft scope by catalog_manager only, neither by super_admin', () => {
    expect(Object.keys(BUNDLES).filter((r) => BUNDLES[r]?.includes(READ)).sort()).toEqual([...CCP_ROLES].sort());
    expect(Object.keys(BUNDLES).filter((r) => BUNDLES[r]?.includes(DRAFT))).toEqual(['catalog_manager']);
  });

  for (const r of ROUTES) {
    const admitted = r.scope === READ ? [...CCP_ROLES] : ['catalog_manager'];
    const refused = r.scope === READ ? [] : CCP_ROLES.filter((x) => x !== 'catalog_manager');
    for (const role of admitted) {
      it(`B2-RT-${r.name} admits ${role} past the gate (service decides)`, async () => {
        const res = await call(r, role);
        expect(res.status, JSON.stringify(res.body)).toBe(r.ok);
        expect(svcMock[r.fn]).toHaveBeenCalledTimes(1);
      });
    }
    for (const role of [...refused, 'super_admin']) {
      it(`B2-RT-${r.name} refuses ${role} with 403 (missing ${r.scope}); the service is never reached`, async () => {
        const res = await call(r, role);
        expect(res.status).toBe(403);
        expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
        expect(res.body?.error?.details?.missing_scopes).toEqual([r.scope]);
        expect(svcMock[r.fn]).not.toHaveBeenCalled();
      });
    }
    it(`B2-RT-${r.name} refuses a tenant-tier token (403) and no token (401)`, async () => {
      expect((await call(r, 'catalog_manager', { consumer: 'recruiter' })).status).toBe(403);
      const base = request(app.getHttpServer())[r.method](r.path);
      const anon = r.method === 'get' ? await base : await base.send(r.body ?? {});
      expect(anon.status).toBe(401);
      expect(svcMock[r.fn]).not.toHaveBeenCalled();
    });
  }

  it('B2-RT-PATCH passes only the edited terms (absent stays absent; null = unlimited) and the actor', async () => {
    const r = ROUTES[3] as Route;
    await call(r, 'catalog_manager', { body: { expected_content_checksum: 'c'.repeat(64), envelopes_per_month: null } });
    const [actor, id, input] = svcMock.updateDraft.mock.calls[0] as unknown as [{ user_id: string; actor_kind: string; scopes: string[] }, string, { edits: object; expected_content_checksum: string }];
    expect(actor).toMatchObject({ user_id: principal.get('catalog_manager:platform'), actor_kind: 'user' });
    expect(actor.scopes).toContain(DRAFT);
    expect(id).toBe(VID);
    expect(input.edits).toEqual({ envelopes_per_month: null });
    expect(input.expected_content_checksum).toBe('c'.repeat(64));
  });

  const bad: Array<[string, Route, object]> = [
    ['draft: missing from_version_id', ROUTES[2] as Route, {}],
    ['draft: from_version_id not a uuid', ROUTES[2] as Route, { from_version_id: 'v1' }],
    ['draft: unknown field (status)', ROUTES[2] as Route, { from_version_id: VID, status: 'PUBLISHED' }],
    ['patch: missing checksum', ROUTES[3] as Route, { list_price_minor: 1 }],
    ['patch: malformed checksum', ROUTES[3] as Route, { expected_content_checksum: 'x', list_price_minor: 1 }],
    ['patch: negative price', ROUTES[3] as Route, { ...PATCH_BODY, list_price_minor: -1 }],
    ['patch: null price', ROUTES[3] as Route, { ...PATCH_BODY, list_price_minor: null }],
    ['patch: fractional envelopes', ROUTES[3] as Route, { ...PATCH_BODY, envelopes_per_month: 1.5 }],
    ['patch: v1 lock currency', ROUTES[3] as Route, { ...PATCH_BODY, currency: 'EUR' }],
    ['patch: v1 lock billing interval', ROUTES[3] as Route, { ...PATCH_BODY, billing_interval: 'YEAR' }],
    ['patch: status (no publish through edit)', ROUTES[3] as Route, { ...PATCH_BODY, status: 'PUBLISHED' }],
    ['patch: plan identity', ROUTES[3] as Route, { ...PATCH_BODY, product_key: 'ats' }],
    ['patch: seats (no backing term)', ROUTES[3] as Route, { ...PATCH_BODY, seats: 10 }],
    ['patch: raw content', ROUTES[3] as Route, { ...PATCH_BODY, content: { format: 1 } }],
  ];
  for (const [name, r, body] of bad) {
    it(`B2-RT-400 ${name}`, async () => {
      const res = await call(r, 'catalog_manager', { body });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body?.error?.code).toBe('VALIDATION_ERROR');
      expect(svcMock[r.fn]).not.toHaveBeenCalled();
    });
  }
  it('B2-RT-400 version id not a uuid', async () => {
    const res = await call(ROUTES[1] as Route, 'read_only_auditor', { path: `${BASE}/versions/v1` });
    expect(res.status).toBe(400);
  });

  const mapping: Array<[string, unknown, number, string, Record<string, unknown>]> = [
    ['not a draft (published versions are immutable)', new CommercialCatalogError('CONFLICT', 'm', { reason: 'not_draft', status: 'PUBLISHED' }), 409, 'COMMERCIAL_CATALOG_CONFLICT', { reason: 'not_draft' }],
    ['draft exists', new CommercialCatalogError('CONFLICT', 'm', { reason: 'draft_exists' }), 409, 'COMMERCIAL_CATALOG_CONFLICT', { reason: 'draft_exists' }],
    ['stale', new CommercialCatalogError('CONFLICT', 'm', { reason: 'stale' }), 409, 'COMMERCIAL_CATALOG_CONFLICT', { reason: 'stale' }],
    ['not found', new CommercialCatalogError('NOT_FOUND', 'm'), 404, 'NOT_FOUND', {}],
    ['not human', new CommercialCatalogError('NOT_HUMAN', 'm'), 403, 'INSUFFICIENT_PERMISSIONS', { reason: 'not_human' }],
    ['scope missing', new CommercialCatalogError('SCOPE_MISSING', 'm', { missing_scopes: [DRAFT] }), 403, 'INSUFFICIENT_PERMISSIONS', { reason: 'scope_missing' }],
    ['policy unavailable', new CommercialPolicyUnavailableError('MISSING'), 503, 'COMMERCIAL_POLICY_UNAVAILABLE', { reason: 'MISSING' }],
  ];
  for (const [name, err, status, code, details] of mapping) {
    it(`B2-RT-MAP ${name} → ${status} ${code}`, async () => {
      svcMock.updateDraft.mockRejectedValueOnce(err);
      const res = await call(ROUTES[3] as Route, 'catalog_manager');
      expect(res.status, JSON.stringify(res.body)).toBe(status);
      expect(res.body?.error?.code).toBe(code);
      expect(res.body?.error?.details).toMatchObject(details);
    });
  }

  it('B2-RT-NOPUB the controller declares exactly the 4 catalog routes: no publish, retire, pin or apply route (publish only through the chain)', () => {
    const proto = PlatformCommercialCatalogController.prototype as unknown as Record<string, unknown>;
    const routes = Object.getOwnPropertyNames(proto)
      .filter((n) => n !== 'constructor' && typeof proto[n] === 'function' && Reflect.getMetadata(METHOD_METADATA, proto[n] as object) !== undefined)
      .map((n) => `${RequestMethod[Reflect.getMetadata(METHOD_METADATA, proto[n] as object) as RequestMethod]} ${String(Reflect.getMetadata(PATH_METADATA, proto[n] as object))}`)
      .sort();
    expect(routes).toEqual(['GET /', 'GET versions/:versionId', 'PATCH versions/:versionId', 'POST plans/:planId/drafts']);
    expect(routes.join(' ')).not.toMatch(/publish|retire|apply|pin/i);
    // The controller and the catalog service never call the A6 apply methods.
    for (const f of ['../app/platform/platform-commercial-catalog.controller.ts', '../../../../libs/subscription/src/lib/commercial/commercial-catalog.service.ts']) {
      const src = readFileSync(resolve(__dirname, f), 'utf8');
      expect(src, f).not.toMatch(/\.(publish|retire|pinProviderPrice)\(/);
    }
  });
});
