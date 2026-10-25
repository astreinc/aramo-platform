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
import { CommercialChangeRequestError, CommercialPolicyUnavailableError, SupportExtensionService } from '@aramo/subscription';

import { PlatformCommercialSupportExtensionController } from '../app/platform/platform-commercial-support-extension.controller.js';

import { generateTestKeyPair } from './test-keys.js';

// CCP-A8 — the route GATES of /platform/commercial/support-extensions through the REAL request
// chain (signed platform token → real JwtAuthGuard → real RolesGuard → consumer tripwire →
// AramoExceptionFilter), the service mocked. Per role (the 6 CCP roles + super_admin, A1 §4.1
// bundles restated as TD-A1-7):
//   POST  platform:subscription:support → support_admin ONLY; the other 5 CCP roles and
//         super_admin are refused 403 before the service
//   GET   platform:subscription:read → platform_owner, finance_admin, commercial_ops,
//         support_admin, read_only_auditor; catalog_manager and super_admin refused 403
// The outcome below the gate (bound, breach, eligibility, refusals) is proven on real Postgres in
// libs/subscription/src/tests/ccp-a8-support-extension.integration.spec.ts and, end to end, by
// ccp-a8-support-extension-routes.integration.spec.ts.

const ENTRY = 'platform:tenant:read';
const BUNDLES: Record<string, readonly string[]> = {
  platform_owner: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:catalog:publish', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read'],
  finance_admin: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read'],
  commercial_ops: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:request', 'platform:entitlement:request', 'platform:billing:read', 'platform:billing:request', 'platform:approval:read'],
  catalog_manager: [ENTRY, 'platform:catalog:read', 'platform:catalog:draft', 'platform:approval:read'],
  support_admin: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:support', 'platform:billing:read', 'platform:approval:read'],
  read_only_auditor: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:billing:read', 'platform:approval:read', 'platform:commercial:audit:read'],
  super_admin: ['platform:tenant:provision', ENTRY, 'platform:admin:invite', 'platform:tenant:lifecycle:manage', 'platform:skill:read', 'platform:skill:manage', 'platform:document_template:read', 'platform:document_template:manage', 'platform:matching_policy:read', 'platform:matching_policy:write'],
};
const ROLES = ['platform_owner', 'finance_admin', 'commercial_ops', 'catalog_manager', 'support_admin', 'read_only_auditor', 'super_admin'] as const;

class RoleBundleResolver implements EffectiveAuthorizationResolver {
  readonly roleOf = new Map<string, string>();
  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const role = this.roleOf.get(input.principal_id);
    const scopes = role === undefined ? [] : [...(BUNDLES[role] ?? [])];
    return { status: 'ok', scopes: filterScopesForConsumer({ consumer: input.consumer_type, scopes, tenantHasEsign: false }) };
  }
}

const NOW = new Date('2026-10-26T12:00:00.000Z');
const TENANT = '0190dddd-0000-7000-8000-0000000000a1';
const SUB = '019a0000-0000-7000-8000-00000000a8a1';
const REQ_ID = '019a0000-0000-7000-8000-00000000a8a2';
const EXT_ID = '019a0000-0000-7000-8000-00000000a8a3';
const REQUEST_ROW = {
  id: REQ_ID,
  action_type: 'SUPPORT_EXTENSION',
  kind: 'EXCEPTION',
  state: 'APPLIED',
  tenant_id: TENANT,
  product_key: 'sign',
  payload: { operation: 'EXTEND', subscription_id: SUB, requested_days: 14 },
  payload_checksum: 'a'.repeat(64),
  required_chain: { format_version: 1, rule: 'BOUNDED_EXCEPTION', basis: {}, steps: [] },
  policy_version_id: '019a0000-0000-7000-8000-0000000cc201',
  policy_checksum: 'b'.repeat(64),
  requested_by: '019a0000-0000-7000-8000-00000000a8ff',
  reason: 'r',
  idempotency_key: 'k-00000001',
  created_at: NOW,
  submitted_at: NOW,
  expires_at: NOW,
  approved_at: null,
  rejected_at: null,
  rejected_by: null,
  rejection_reason: null,
  withdrawn_at: null,
  expired_at: null,
  apply_attempts: 1,
  applied_at: NOW,
  updated_at: NOW,
};
const EXT_ROW = {
  id: EXT_ID,
  tenant_id: TENANT,
  product_key: 'sign',
  subscription_id: SUB,
  change_request_id: REQ_ID,
  is_exception: true,
  days: 14,
  grace_until_at_apply: null,
  base_until: NOW,
  extends_until: new Date(NOW.getTime() + 14 * 86_400_000),
  policy_version_id: '019a0000-0000-7000-8000-0000000cc201',
  applied_by: '019a0000-0000-7000-8000-00000000a8ff',
  applied_at: NOW,
  removed_at: null,
  removed_by: null,
  remove_change_request_id: null,
};
const APPLICATION = { id: 'app', change_request_id: REQ_ID, action_type: 'SUPPORT_EXTENSION', tenant_id: TENANT, product_key: 'sign', subscription_id: SUB, replaced_subscription_id: null, from_plan_version_id: null, to_plan_version_id: null, capabilities: [], capabilities_inserted: [], attempt: 1, applied_by: EXT_ROW.applied_by, applied_at: NOW };
const DECISION = { eligible: true, within_bounds: true, breaches: [], eligibility: [], counters: { requested_days: 14, extensions_in_frequency_window: 0, cumulative_days_before: 0, cumulative_days_after: 14 }, clause: { support_extension_max_days: 14 } };

const svcMock = {
  request: vi.fn(async () => ({ outcome: 'APPLIED', replayed: false, request: REQUEST_ROW, extension: EXT_ROW, application: APPLICATION, decision: DECISION }) as unknown),
  // CCP-B6: the GET route reads `overview` (the overlays + their recorded context, the open base
  // rows and the ACTIVE policy clause).
  overview: vi.fn(async () => ({
    extensions: [{ ...EXT_ROW, active: true, context: { policy_version_number: 1, clause: { support_extension_max_days: 14 }, counters: { requested_days: 14 }, roles_at_apply: ['support_admin'] } }],
    subscriptions: [{ id: SUB, product_key: 'sign', source: 'SELF_SERVICE', status: 'PAST_DUE', grace_until: NOW, current_period_end: null }],
    policy: { version_id: EXT_ROW.policy_version_id, version_number: 1, clause: { support_extension_max_days: 14 }, approval_expiry_hours: 72 },
  })),
};
const BASE = '/platform/commercial/support-extensions';
const BODY = { tenant_id: TENANT, product_key: 'sign', subscription_id: SUB, requested_days: 14, reason: 'support goodwill', idempotency_key: 'idem-a8-00001' };
type Route = { name: string; method: 'get' | 'post'; path: string; fn: keyof typeof svcMock; scope: string; allowed: readonly string[]; ok: number };
const ROUTES: Route[] = [
  { name: 'POST request', method: 'post', path: BASE, fn: 'request', scope: 'platform:subscription:support', allowed: ['support_admin'], ok: 201 },
  { name: 'GET list', method: 'get', path: `${BASE}?tenant_id=${TENANT}`, fn: 'overview', scope: 'platform:subscription:read', allowed: ['platform_owner', 'finance_admin', 'commercial_ops', 'support_admin', 'read_only_auditor'], ok: 200 },
];

describe('CCP-A8 — route gates on /platform/commercial/support-extensions (real JwtAuthGuard + RolesGuard, service mocked)', () => {
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-a8-test';
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
  async function call(r: Route, role: string, opts: { body?: object; path?: string; consumer?: string } = {}) {
    const req = request(app.getHttpServer())[r.method](opts.path ?? r.path).set('Authorization', `Bearer ${await tokenFor(role, opts.consumer)}`);
    return r.method === 'post' ? req.send(opts.body ?? BODY) : req;
  }

  beforeAll(async () => {
    const keys = generateTestKeyPair();
    privatePem = keys.privatePem;
    for (const k of ['AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY']) saved[k] = process.env[k];
    process.env['AUTH_AUDIENCE'] = audience;
    process.env['AUTH_PUBLIC_KEY'] = keys.publicPem;
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, AuthorizationModule],
      controllers: [PlatformCommercialSupportExtensionController],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: resolver },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
        { provide: SupportExtensionService, useValue: svcMock },
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
    for (const f of Object.values(svcMock)) f.mockClear();
  });

  it('A8-RT-0 the POST gate scope is held by support_admin alone; the GET gate scope by 5 CCP roles; super_admin holds neither', () => {
    for (const r of ROUTES) expect(Object.keys(BUNDLES).filter((role) => BUNDLES[role]?.includes(r.scope)).sort(), r.name).toEqual([...r.allowed].sort());
  });

  for (const r of ROUTES) {
    for (const role of ROLES) {
      const allowed = r.allowed.includes(role);
      it(`A8-RT-${r.name} ${allowed ? 'admits' : 'refuses'} ${role}${allowed ? '' : ` (403, missing ${r.scope}; the service is never reached)`}`, async () => {
        const res = await call(r, role);
        if (allowed) {
          expect(res.status, JSON.stringify(res.body)).toBe(r.ok);
          expect(svcMock[r.fn]).toHaveBeenCalledTimes(1);
        } else {
          expect(res.status).toBe(403);
          expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
          expect(res.body?.error?.details?.missing_scopes).toEqual([r.scope]);
          expect(svcMock[r.fn]).not.toHaveBeenCalled();
        }
      });
    }
    it(`A8-RT-${r.name} refuses a tenant-tier token (403) and no token (401)`, async () => {
      expect((await call(r, r.allowed[0] as string, { consumer: 'recruiter' })).status).toBe(403);
      const anon = r.method === 'post' ? await request(app.getHttpServer()).post(r.path).send(BODY) : await request(app.getHttpServer()).get(r.path);
      expect(anon.status).toBe(401);
      expect(svcMock[r.fn]).not.toHaveBeenCalled();
    });
  }

  it('A8-RT-request passes the actor and the body through and serializes the APPLIED outcome; an ESCALATED outcome is 201 with no extension; a replay answers 200', async () => {
    const res = await call(ROUTES[0] as Route, 'support_admin');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ outcome: 'APPLIED', replayed: false, request: { id: REQ_ID, kind: 'EXCEPTION', required_chain: { rule: 'BOUNDED_EXCEPTION', steps: [] } }, extension: { id: EXT_ID, is_exception: true, extends_until: EXT_ROW.extends_until.toISOString() }, application: { action_type: 'SUPPORT_EXTENSION' }, decision: { within_bounds: true } });
    const [actor, input] = svcMock.request.mock.calls[0] as unknown as [{ user_id: string; scopes: string[] }, object];
    expect(actor.user_id).toBe(principal.get('support_admin:platform'));
    expect(actor.scopes).toContain('platform:subscription:support');
    expect(input).toEqual({ tenant_id: TENANT, product_key: 'sign', subscription_id: SUB, requested_days: 14, reason: 'support goodwill', idempotency_key: 'idem-a8-00001' });
    svcMock.request.mockResolvedValueOnce({ outcome: 'ESCALATED', replayed: false, request: { ...REQUEST_ROW, kind: 'NORMAL', state: 'PENDING_APPROVAL' }, decision: { ...DECISION, within_bounds: false, breaches: ['LENGTH'] } });
    const esc = await call(ROUTES[0] as Route, 'support_admin');
    expect(esc.status).toBe(201);
    expect(esc.body).toMatchObject({ outcome: 'ESCALATED', extension: null, application: null, decision: { breaches: ['LENGTH'] } });
    svcMock.request.mockResolvedValueOnce({ outcome: 'APPLIED', replayed: true, request: REQUEST_ROW, extension: EXT_ROW, application: APPLICATION, decision: null });
    expect((await call(ROUTES[0] as Route, 'support_admin')).status).toBe(200);
  });

  it('B6-RT-list serializes the overlays with their context, the open base rows and the ACTIVE policy (dates as ISO strings)', async () => {
    const res = await call(ROUTES[1] as Route, 'support_admin');
    expect(res.status).toBe(200);
    expect(svcMock.overview).toHaveBeenCalledWith(TENANT, undefined);
    expect(res.body).toEqual({
      extensions: [expect.objectContaining({ id: EXT_ID, active: true, applied_at: NOW.toISOString(), context: { policy_version_number: 1, clause: { support_extension_max_days: 14 }, counters: { requested_days: 14 }, roles_at_apply: ['support_admin'] } })],
      subscriptions: [{ id: SUB, product_key: 'sign', source: 'SELF_SERVICE', status: 'PAST_DUE', grace_until: NOW.toISOString(), current_period_end: null }],
      policy: { version_id: EXT_ROW.policy_version_id, version_number: 1, clause: { support_extension_max_days: 14 }, approval_expiry_hours: 72 },
    });
  });

  const bad: Array<[string, object]> = [
    ['tenant_id not a uuid', { ...BODY, tenant_id: 'x' }],
    ['unknown product_key', { ...BODY, product_key: 'ats' }],
    ['requested_days 0', { ...BODY, requested_days: 0 }],
    ['requested_days fractional', { ...BODY, requested_days: 1.5 }],
    ['missing subscription_id', { ...BODY, subscription_id: undefined }],
    ['empty reason', { ...BODY, reason: '' }],
    ['idempotency_key too short', { ...BODY, idempotency_key: 'short' }],
    ['unknown field (is_exception)', { ...BODY, is_exception: true }],
  ];
  for (const [name, body] of bad) {
    it(`A8-RT-400 ${name}`, async () => {
      const res = await call(ROUTES[0] as Route, 'support_admin', { body });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body?.error?.code).toBe('VALIDATION_ERROR');
      expect(svcMock.request).not.toHaveBeenCalled();
    });
  }
  it('A8-RT-400 list without tenant_id, or an unknown product_key', async () => {
    for (const path of [BASE, `${BASE}?tenant_id=${TENANT}&product_key=ats`]) {
      const res = await call(ROUTES[1] as Route, 'finance_admin', { path });
      expect(res.status, path).toBe(400);
    }
    expect(svcMock.overview).not.toHaveBeenCalled();
  });

  const mapping: Array<[string, unknown, number, string, Record<string, unknown>]> = [
    ['subscription not open', new CommercialChangeRequestError('INVALID_INPUT', 'm', { reason: 'subscription_not_open' }), 400, 'VALIDATION_ERROR', { reason: 'subscription_not_open' }],
    ['open request exists (Q14)', new CommercialChangeRequestError('OPEN_REQUEST_EXISTS', 'm', {}), 409, 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', { reason: 'open_request_exists' }],
    ['idempotency conflict', new CommercialChangeRequestError('IDEMPOTENCY_KEY_CONFLICT', 'm', {}), 409, 'IDEMPOTENCY_KEY_CONFLICT', {}],
    ['not human', new CommercialChangeRequestError('NOT_HUMAN', 'm'), 403, 'INSUFFICIENT_PERMISSIONS', { reason: 'not_human' }],
    ['tenant not found', new CommercialChangeRequestError('TENANT_NOT_FOUND', 'm', {}), 400, 'VALIDATION_ERROR', { reason: 'tenant_not_found' }],
    ['policy unavailable', new CommercialPolicyUnavailableError('MISSING'), 503, 'COMMERCIAL_POLICY_UNAVAILABLE', { reason: 'MISSING' }],
    // CCP-R3 (TD-A8-3 refined): eligibility is a refusal with a stable reason, never an escalation.
    [
      'ineligible (not PAST_DUE)',
      new CommercialChangeRequestError('SUPPORT_EXTENSION_INELIGIBLE', 'm', { reason: 'support_extension_ineligible', eligibility: ['SUBSCRIPTION_NOT_PAST_DUE'], subscription_id: SUB }),
      409,
      'COMMERCIAL_CHANGE_REQUEST_CONFLICT',
      { reason: 'support_extension_ineligible', eligibility: ['SUBSCRIPTION_NOT_PAST_DUE'] },
    ],
    [
      'ineligible (no D9 attestation)',
      new CommercialChangeRequestError('SUPPORT_EXTENSION_INELIGIBLE', 'm', { reason: 'support_extension_ineligible', eligibility: ['REQUESTER_NOT_ATTESTED'], subscription_id: SUB }),
      409,
      'COMMERCIAL_CHANGE_REQUEST_CONFLICT',
      { reason: 'support_extension_ineligible', eligibility: ['REQUESTER_NOT_ATTESTED'] },
    ],
  ];
  for (const [name, err, status, code, details] of mapping) {
    it(`A8-RT-MAP ${name} → ${status} ${code}`, async () => {
      svcMock.request.mockRejectedValueOnce(err);
      const res = await call(ROUTES[0] as Route, 'support_admin');
      expect(res.status).toBe(status);
      expect(res.body?.error?.code).toBe(code);
      expect(res.body?.error?.details).toMatchObject(details);
    });
  }
});
