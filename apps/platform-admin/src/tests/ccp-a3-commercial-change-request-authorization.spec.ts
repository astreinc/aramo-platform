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
import {
  CommercialApprovalRefusedError,
  CommercialChangeRequestCursorError,
  CommercialChangeRequestError,
  CommercialChangeRequestService,
  CommercialNotBootstrappedError,
  CommercialPolicyUnavailableError,
} from '@aramo/subscription';

import { PlatformCommercialChangeRequestController } from '../app/platform/platform-commercial-change-request.controller.js';

import { generateTestKeyPair } from './test-keys.js';

// CCP-A3 — the route GATE for /platform/commercial/change-requests (7 routes) through the
// REAL request chain (signed platform token → real JwtAuthGuard → real RolesGuard →
// consumer tripwire → AramoExceptionFilter), with the service mocked: every route admits
// the 6 CCP roles (platform:approval:read) and refuses super_admin (no commercial scope;
// INV-1, PBD §12) before the service; DTO shapes are 400s; each service refusal maps to its
// HTTP code. The per-role OUTCOME below the gate (requester scope, requester-only, the
// seven refusals) is proven on real Postgres in
// ccp-a3-commercial-change-request-routes.integration.spec.ts.

const SCOPE = 'platform:approval:read';
const ENTRY = 'platform:tenant:read';
// CCP-R3 — CCP-A1 Amendment A1 (LOCKED) FA-2: the amount scope's 3 holders.
const AMOUNT = 'platform:billing:amount:read';
const AMOUNT_HOLDERS: readonly string[] = ['platform_owner', 'finance_admin', 'read_only_auditor'];
const BUNDLES: Record<string, readonly string[]> = {
  platform_owner: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:catalog:publish', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', SCOPE, 'platform:commercial:audit:read', AMOUNT],
  finance_admin: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', SCOPE, 'platform:commercial:audit:read', AMOUNT],
  commercial_ops: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:request', 'platform:entitlement:request', 'platform:billing:read', 'platform:billing:request', SCOPE],
  catalog_manager: [ENTRY, 'platform:catalog:read', 'platform:catalog:draft', SCOPE],
  support_admin: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:support', 'platform:billing:read', SCOPE],
  read_only_auditor: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:billing:read', SCOPE, 'platform:commercial:audit:read', AMOUNT],
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

const ID = '019a0000-0000-7000-8000-00000000a301';
const NOW = new Date('2026-10-25T00:00:00.000Z');
const ROW = {
  id: ID,
  action_type: 'CREDIT',
  kind: 'NORMAL',
  state: 'DRAFT',
  tenant_id: '0190dddd-0000-7000-8000-0000000000a1',
  product_key: 'sign',
  payload: { amount_minor: 1, currency: 'USD' },
  payload_checksum: 'a'.repeat(64),
  required_chain: { format_version: 1, rule: 'FINANCE_ONLY', basis: { amount_minor: 1, currency: 'USD', credit_escalation_threshold_minor: 50000, escalates: false }, steps: [{ step_index: 0, role_key: 'finance_admin', scope_keys: ['platform:billing:approve'] }] },
  policy_version_id: '019a0000-0000-7000-8000-0000000cc201',
  policy_checksum: 'b'.repeat(64),
  requested_by: '019a0000-0000-7000-8000-00000000a3ff',
  reason: 'r',
  idempotency_key: 'k-00000001',
  created_at: NOW,
  submitted_at: null,
  expires_at: null,
  approved_at: null,
  rejected_at: null,
  rejected_by: null,
  rejection_reason: null,
  withdrawn_at: null,
  expired_at: null,
  apply_attempts: 0,
  applied_at: null,
  updated_at: NOW,
};
const APPROVAL = { id: '019a0000-0000-7000-8000-00000000a302', change_request_id: ID, step_index: 0, approver_user_id: 'u', step_role_key: 'finance_admin', step_scope_keys: ['platform:billing:approve'], approver_role_keys: ['finance_admin'], attestation_id: 'att', comment: null, created_at: NOW };

const CREATE_BODY = { action_type: 'CREDIT', tenant_id: ROW.tenant_id, product_key: 'sign', payload: { amount_minor: 1, currency: 'USD' }, reason: 'goodwill', idempotency_key: 'idem-0000001' };

type Route = { name: string; method: 'get' | 'post'; path: string; body?: object; fn: keyof typeof svcMock; ok: number };
const svcMock = {
  create: vi.fn(async () => ({ request: ROW, replayed: false })),
  list: vi.fn(async () => ({ requests: [ROW], next_cursor: null as string | null })),
  get: vi.fn(async () => ({ request: ROW, approvals: [], chain: ROW.required_chain, is_expired: false, chain_satisfiable: true, steps: [{ step_index: 0, role_key: 'finance_admin', scope_keys: ['platform:billing:approve'], status: 'NEXT', approval: null, caller: { eligible: true, refusal: null } }] })),
  submit: vi.fn(async () => ({ ...ROW, state: 'PENDING_APPROVAL' })),
  withdraw: vi.fn(async () => ({ ...ROW, state: 'WITHDRAWN' })),
  approve: vi.fn(async () => ({ request: { ...ROW, state: 'APPROVED' }, approval: APPROVAL })),
  reject: vi.fn(async () => ({ ...ROW, state: 'REJECTED' })),
};
const BASE = '/platform/commercial/change-requests';
const ROUTES: Route[] = [
  { name: 'POST create', method: 'post', path: BASE, body: CREATE_BODY, fn: 'create', ok: 201 },
  { name: 'GET list', method: 'get', path: BASE, fn: 'list', ok: 200 },
  { name: 'GET get', method: 'get', path: `${BASE}/${ID}`, fn: 'get', ok: 200 },
  { name: 'POST submit', method: 'post', path: `${BASE}/${ID}/submit`, fn: 'submit', ok: 200 },
  { name: 'POST withdraw', method: 'post', path: `${BASE}/${ID}/withdraw`, fn: 'withdraw', ok: 200 },
  { name: 'POST approve-step', method: 'post', path: `${BASE}/${ID}/approvals`, body: { step_index: 0 }, fn: 'approve', ok: 201 },
  { name: 'POST reject', method: 'post', path: `${BASE}/${ID}/reject`, body: { reason: 'no' }, fn: 'reject', ok: 200 },
];

describe('CCP-A3 — route gate on /platform/commercial/change-requests (real JwtAuthGuard + RolesGuard, service mocked)', () => {
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-a3-test';
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
  async function call(r: Route, role: string, opts: { body?: object; query?: string; consumer?: string } = {}) {
    const req = request(app.getHttpServer())[r.method](`${r.path}${opts.query ?? ''}`).set('Authorization', `Bearer ${await tokenFor(role, opts.consumer)}`);
    return r.method === 'post' ? req.send(opts.body ?? r.body ?? {}) : req;
  }

  beforeAll(async () => {
    const keys = generateTestKeyPair();
    privatePem = keys.privatePem;
    for (const k of ['AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY']) saved[k] = process.env[k];
    process.env['AUTH_AUDIENCE'] = audience;
    process.env['AUTH_PUBLIC_KEY'] = keys.publicPem;
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, AuthorizationModule],
      controllers: [PlatformCommercialChangeRequestController],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: resolver },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
        { provide: CommercialChangeRequestService, useValue: svcMock },
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

  it('A3-RT-0 the gate scope is held by exactly the 6 CCP roles and never by super_admin', () => {
    expect(Object.keys(BUNDLES).filter((r) => BUNDLES[r]?.includes(SCOPE)).sort()).toEqual([...CCP_ROLES].sort());
  });

  for (const r of ROUTES) {
    for (const role of CCP_ROLES) {
      it(`A3-RT-${r.name} admits ${role} past the gate (service decides)`, async () => {
        const res = await call(r, role);
        expect(res.status, JSON.stringify(res.body)).toBe(r.ok);
        expect(svcMock[r.fn]).toHaveBeenCalledTimes(1);
        // CCP-R3 (CCP-A1 Amendment A1, FA-1 / FA-5): the CREDIT amount, in the payload and the chain
        // basis, only for a holder of platform:billing:read AND platform:billing:amount:read.
        const req = (res.body.request ?? res.body.requests?.[0]) as { payload: Record<string, unknown>; required_chain: { basis: Record<string, unknown> } };
        if (AMOUNT_HOLDERS.includes(role)) {
          expect(req.payload).toEqual({ amount_minor: 1, currency: 'USD' });
          expect(req.required_chain.basis).toMatchObject({ amount_minor: 1 });
        } else {
          expect(req.payload).toEqual({ currency: 'USD', amount_withheld: 'FINANCE_SCOPE_REQUIRED' });
          expect(req.required_chain.basis).toEqual({ currency: 'USD', credit_escalation_threshold_minor: 50000, escalates: false, amount_withheld: 'FINANCE_SCOPE_REQUIRED' });
        }
      });
    }
    it(`A3-RT-${r.name} refuses super_admin with 403 (missing ${SCOPE}); the service is never reached`, async () => {
      const res = await call(r, 'super_admin');
      expect(res.status).toBe(403);
      expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(res.body?.error?.details?.missing_scopes).toEqual([SCOPE]);
      expect(svcMock[r.fn]).not.toHaveBeenCalled();
    });
    it(`A3-RT-${r.name} refuses a tenant-tier token (403) and no token (401)`, async () => {
      expect((await call(r, 'finance_admin', { consumer: 'recruiter' })).status).toBe(403);
      const anon = r.method === 'post' ? await request(app.getHttpServer()).post(r.path).send(r.body ?? {}) : await request(app.getHttpServer()).get(r.path);
      expect(anon.status).toBe(401);
      expect(svcMock[r.fn]).not.toHaveBeenCalled();
    });
  }

  it('A3-RT-FA-1 (CCP-R3, TD-C4-7) the approvers who must see the amount to approve (finance_admin, platform_owner) hold platform:billing:amount:read: the detail and the approve response carry the CREDIT amount; commercial_ops and support_admin get the marker on list and detail', async () => {
    for (const role of ['finance_admin', 'platform_owner']) {
      expect(BUNDLES[role], role).toContain(AMOUNT);
      const detail = await call(ROUTES[2] as Route, role);
      expect(detail.body.request.payload, role).toEqual({ amount_minor: 1, currency: 'USD' });
      const approve = await call(ROUTES[5] as Route, role);
      expect(approve.body.request.payload, role).toEqual({ amount_minor: 1, currency: 'USD' });
    }
    for (const role of ['commercial_ops', 'support_admin']) {
      for (const r of [ROUTES[1], ROUTES[2]] as Route[]) {
        const res = await call(r, role);
        const req = res.body.request ?? res.body.requests[0];
        expect(req.payload, `${role} ${r.name}`).toEqual({ currency: 'USD', amount_withheld: 'FINANCE_SCOPE_REQUIRED' });
        expect(JSON.stringify(res.body)).not.toMatch(/"amount_minor"/);
      }
    }
  });

  it('A3-RT-FA-2 (CCP-R3, D-R3-7) a DISCOUNT keeps discount_bps for every reader (a percentage is not a tenant amount)', async () => {
    const discount = { ...ROW, action_type: 'DISCOUNT', payload: { discount_bps: 3000 }, required_chain: { ...ROW.required_chain, basis: { discount_bps: 3000, discount_escalation_threshold_bps: 2500, escalates: true } } };
    for (const role of ['finance_admin', 'commercial_ops']) {
      svcMock.list.mockResolvedValueOnce({ requests: [discount], next_cursor: null });
      const res = await call(ROUTES[1] as Route, role);
      expect(res.body.requests[0].payload, role).toEqual({ discount_bps: 3000 });
      expect(res.body.requests[0].required_chain.basis, role).toEqual({ discount_bps: 3000, discount_escalation_threshold_bps: 2500, escalates: true });
    }
  });

  it('A3-RT-create passes the actor (sub, actor_kind, server-resolved scopes) and the body through; a replay answers 200', async () => {
    svcMock.create.mockResolvedValueOnce({ request: ROW, replayed: true });
    const res = await call(ROUTES[0] as Route, 'commercial_ops');
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
    const [actor, input] = svcMock.create.mock.calls[0] as unknown as [{ user_id: string; actor_kind: string; scopes: string[] }, object];
    expect(actor).toMatchObject({ user_id: principal.get('commercial_ops:platform'), actor_kind: 'user' });
    expect(actor.scopes).toContain('platform:billing:request');
    expect(input).toMatchObject({ action_type: 'CREDIT', tenant_id: ROW.tenant_id, product_key: 'sign', idempotency_key: 'idem-0000001' });
  });

  const bad: Array<[string, Route, { body?: object; query?: string }]> = [
    ['unknown action_type', ROUTES[0] as Route, { body: { ...CREATE_BODY, action_type: 'MAGIC' } }],
    ['payload not an object', ROUTES[0] as Route, { body: { ...CREATE_BODY, payload: 'x' } }],
    ['idempotency_key too short', ROUTES[0] as Route, { body: { ...CREATE_BODY, idempotency_key: 'short' } }],
    ['empty reason', ROUTES[0] as Route, { body: { ...CREATE_BODY, reason: '' } }],
    ['unknown body field', ROUTES[0] as Route, { body: { ...CREATE_BODY, state: 'APPROVED' } }],
    ['list: bad state', ROUTES[1] as Route, { query: '?state=DONE' }],
    ['list: bad requester', ROUTES[1] as Route, { query: '?requester=someone' }],
    ['list: limit 201', ROUTES[1] as Route, { query: '?limit=201' }],
    ['approve: missing step_index', ROUTES[5] as Route, { body: {} }],
    ['approve: step_index negative', ROUTES[5] as Route, { body: { step_index: -1 } }],
    ['reject: missing reason', ROUTES[6] as Route, { body: {} }],
  ];
  for (const [name, r, opts] of bad) {
    it(`A3-RT-400 ${name}`, async () => {
      const res = await call(r, 'finance_admin', opts);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body?.error?.code).toBe('VALIDATION_ERROR');
      expect(svcMock[r.fn]).not.toHaveBeenCalled();
    });
  }
  it('A3-RT-400 get: id not a uuid', async () => {
    const res = await request(app.getHttpServer()).get(`${BASE}/nope`).set('Authorization', `Bearer ${await tokenFor('finance_admin')}`);
    expect(res.status).toBe(400);
  });

  it('A3-RT-list maps requester=me to the caller and eligible_for_me to a boolean', async () => {
    await call(ROUTES[1] as Route, 'finance_admin', { query: '?requester=me&eligible_for_me=true&state=PENDING_APPROVAL' });
    expect(svcMock.list.mock.calls[0]?.[1]).toMatchObject({ requested_by: principal.get('finance_admin:platform'), eligible_for_me: true, state: 'PENDING_APPROVAL' });
  });

  const mapping: Array<[string, unknown, number, string, Record<string, unknown>]> = [
    ['approval refusal', new CommercialApprovalRefusedError('SELF_APPROVAL', { requested_by: 'x' }), 409, 'COMMERCIAL_APPROVAL_REFUSED', { refusal: 'SELF_APPROVAL' }],
    ['not bootstrapped', new CommercialNotBootstrappedError({ unfillable_steps: [1] }), 409, 'CCP_NOT_BOOTSTRAPPED', { unfillable_steps: [1] }],
    ['policy unavailable', new CommercialPolicyUnavailableError('MISSING'), 503, 'COMMERCIAL_POLICY_UNAVAILABLE', { reason: 'MISSING' }],
    ['requester scope missing', new CommercialChangeRequestError('REQUESTER_SCOPE_MISSING', 'm', { missing_scopes: ['platform:billing:request'] }), 403, 'INSUFFICIENT_PERMISSIONS', { reason: 'requester_scope_missing', missing_scopes: ['platform:billing:request'] }],
    ['requester authority undefined', new CommercialChangeRequestError('REQUESTER_AUTHORITY_UNDEFINED', 'm', {}), 403, 'INSUFFICIENT_PERMISSIONS', { reason: 'requester_authority_undefined' }],
    ['not requester', new CommercialChangeRequestError('NOT_REQUESTER', 'm'), 403, 'INSUFFICIENT_PERMISSIONS', { reason: 'not_requester' }],
    ['open request exists (Q14)', new CommercialChangeRequestError('OPEN_REQUEST_EXISTS', 'm', { open_request_id: ID }), 409, 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', { reason: 'open_request_exists' }],
    ['state invalid', new CommercialChangeRequestError('STATE_INVALID', 'm', { state: 'APPROVED' }), 409, 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', { reason: 'state_invalid' }],
    ['integrity', new CommercialChangeRequestError('INTEGRITY', 'm', {}), 409, 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', { reason: 'integrity' }],
    ['idempotency conflict', new CommercialChangeRequestError('IDEMPOTENCY_KEY_CONFLICT', 'm', {}), 409, 'IDEMPOTENCY_KEY_CONFLICT', {}],
    ['not found', new CommercialChangeRequestError('NOT_FOUND', 'm', {}), 404, 'NOT_FOUND', {}],
    ['invalid input', new CommercialChangeRequestError('INVALID_INPUT', 'm', { reason: 'invalid_payload' }), 400, 'VALIDATION_ERROR', { reason: 'invalid_payload' }],
    ['cursor', new CommercialChangeRequestCursorError('bad'), 400, 'VALIDATION_ERROR', { reason: 'invalid_cursor' }],
  ];
  for (const [name, err, status, code, details] of mapping) {
    it(`A3-RT-MAP ${name} → ${status} ${code}`, async () => {
      svcMock.approve.mockRejectedValueOnce(err);
      const res = await call(ROUTES[5] as Route, 'finance_admin');
      expect(res.status, JSON.stringify(res.body)).toBe(status);
      expect(res.body?.error?.code).toBe(code);
      expect(res.body?.error?.details).toMatchObject(details);
    });
  }
});
