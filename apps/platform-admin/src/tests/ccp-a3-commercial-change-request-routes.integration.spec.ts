import 'reflect-metadata';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SignJWT, importPKCS8 } from 'jose';
import { Client } from 'pg';
import request from 'supertest';
import { ARAMO_POSTGRES_TEST_IMAGE, AramoExceptionFilter, RequestIdMiddleware } from '@aramo/common';
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
  CommercialAuditRepository,
  CommercialChangeRequestService,
  CommercialOperatorRepository,
  CommercialPolicyRepository,
  SubscriptionPrismaService,
} from '@aramo/subscription';

import { PlatformCommercialChangeRequestController } from '../app/platform/platform-commercial-change-request.controller.js';
// eslint-disable-next-line @nx/enforce-module-boundaries -- test-only real-Postgres support shared with the libs/subscription A3 spec
import { CCP_BUNDLES, TENANT_1, TENANT_2, addOperator, applyCcpA3Schema, revokeAttestation } from '../../../../libs/subscription/src/tests/support/ccp-a3-database.js';

import { generateTestKeyPair } from './test-keys.js';

// CCP-A3 (PBD §5.1 row A3; brief: "per-role allowed/refused tests for every route, 6 roles +
// super_admin refused") — every /platform/commercial/change-requests route, for each CCP
// role and super_admin, through the REAL guard chain AND the REAL service on real Postgres
// (identity RBAC + subscription chain + A2 + A3). Each principal holds exactly one role, in
// the database (live eligibility) and in the token resolver (the same §4.1 bundle).

const ROLES = ['platform_owner', 'finance_admin', 'commercial_ops', 'catalog_manager', 'support_admin', 'read_only_auditor'] as const;
const BASE = '/platform/commercial/change-requests';

class RoleBundleResolver implements EffectiveAuthorizationResolver {
  readonly roleOf = new Map<string, string>();
  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const role = this.roleOf.get(input.principal_id);
    const scopes = role === undefined ? [] : [...(CCP_BUNDLES[role] ?? [])];
    return { status: 'ok', scopes: filterScopesForConsumer({ consumer: input.consumer_type, scopes, tenantHasEsign: false }) };
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-A3 — per-role outcomes on every change-request route (real guards + real service + real Postgres)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: SubscriptionPrismaService;
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-a3-int';
  const saved: Record<string, string | undefined> = {};
  const resolver = new RoleBundleResolver();
  const user: Record<string, string> = {};
  let keyN = 0;
  const key = () => `route-key-${String(++keyN).padStart(6, '0')}`;

  async function token(role: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ consumer_type: 'platform', actor_kind: 'user', tenant_id: PLATFORM_TENANT_SENTINEL_ID, authz_version: 1 })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('Aramo Core Auth')
      .setAudience(audience)
      .setSubject(user[role] as string)
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(await importPKCS8(privatePem, 'RS256'));
  }
  const post = async (role: string, path: string, body: object) => request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${await token(role)}`).send(body);
  const get = async (role: string, path: string) => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${await token(role)}`);
  const createAs = async (role: string, body: object) => post(role, BASE, { reason: 'route test', idempotency_key: key(), ...body });
  const creditBody = (amount_minor: number, tenant_id = TENANT_1) => ({ action_type: 'CREDIT', tenant_id, product_key: 'sign', payload: { amount_minor, currency: 'USD' } });
  async function pendingCredit(amount_minor = 1): Promise<string> {
    const c = await createAs('commercial_ops', creditBody(amount_minor));
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const s = await post('commercial_ops', `${BASE}/${c.body.request.id}/submit`, {});
    expect(s.status).toBe(200);
    return c.body.request.id as string;
  }
  const refusalOf = (res: request.Response) => [res.status, res.body?.error?.code, res.body?.error?.details?.refusal ?? res.body?.error?.details?.reason ?? null];

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    prisma = new SubscriptionPrismaService(url);
    await prisma.$connect();
    const audit = new CommercialAuditRepository(prisma);
    const policies = new CommercialPolicyRepository(prisma);
    const service = new CommercialChangeRequestService(prisma, audit, policies, new CommercialOperatorRepository(prisma, audit, policies));
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
        { provide: CommercialChangeRequestService, useValue: service },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: never, res: never, next: () => void) => new RequestIdMiddleware().use(req, res, next));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }, 60_000);

  beforeEach(async () => {
    await applyCcpA3Schema(pg);
    resolver.roleOf.clear();
    for (const role of [...ROLES, 'super_admin']) {
      user[role] = await addOperator(pg, [role]);
      resolver.roleOf.set(user[role] as string, role);
    }
  }, 120_000);

  it('A3-RI-CREATE per role: SUBSCRIPTION_OPEN only commercial_ops (201); catalog publish only catalog_manager; escalated extension only support_admin; POLICY_ACTIVATE only finance_admin (CCP-A9, TD-A3-5); super_admin refused at the gate', async () => {
    const sub = { action_type: 'SUBSCRIPTION_OPEN', tenant_id: TENANT_1, product_key: 'sign', payload: { plan_key: 'aramo-sign-included-v1', plan_version_id: '019a0000-0000-7000-8000-00000000a601', replaces_subscription_id: null } }; // CCP-A6 payload schema
    const out: Record<string, unknown[]> = {};
    for (const role of [...ROLES, 'super_admin']) out[role] = refusalOf(await createAs(role, sub));
    expect(out).toEqual({
      platform_owner: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      finance_admin: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      commercial_ops: [201, undefined, null],
      catalog_manager: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      support_admin: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      read_only_auditor: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      super_admin: [403, 'INSUFFICIENT_PERMISSIONS', null],
    });
    const publish = { action_type: 'PLAN_VERSION_PUBLISH', payload: { plan_version_id: '019a0000-0000-7000-8000-00000000b201' } };
    for (const role of ROLES) expect((await createAs(role, publish)).status, role).toBe(role === 'catalog_manager' ? 201 : 403);
    // CCP-A8 owns the full SUPPORT_EXTENSION payload (operation EXTEND | REMOVE); a REMOVE is
    // created here so no subscription row is needed (the overlay is checked at apply).
    const ext = { action_type: 'SUPPORT_EXTENSION', tenant_id: TENANT_2, product_key: 'sign', payload: { operation: 'REMOVE', support_extension_id: '019a0000-0000-7000-8000-00000000a8e1' } };
    for (const role of ROLES) expect((await createAs(role, ext)).status, role).toBe(role === 'support_admin' ? 201 : 403);
    // CCP-A9 re-point: the finance_admin passes the requester authority and reaches the target
    // check (v1 is already ACTIVE → 400); every other role is refused 403 requester_role_missing.
    for (const role of ROLES) {
      expect(refusalOf(await createAs(role, { action_type: 'POLICY_ACTIVATE', payload: { policy_version_id: '019a0000-0000-7000-8000-0000000cc201' } })), role).toEqual(
        role === 'finance_admin' ? [400, 'VALIDATION_ERROR', 'policy_version_already_active'] : [403, 'INSUFFICIENT_PERMISSIONS', 'requester_role_missing'],
      );
    }
    // Q14 over HTTP: a second open request for TENANT_1 × sign.
    expect(refusalOf(await createAs('commercial_ops', creditBody(5)))).toEqual([409, 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', 'open_request_exists']);
  });

  it('A3-RI-READ per role: list and get → 200 for all 6 roles; super_admin 403', async () => {
    const id = await pendingCredit();
    for (const role of ROLES) {
      expect((await get(role, BASE)).status, role).toBe(200);
      const g = await get(role, `${BASE}/${id}`);
      expect(g.status, role).toBe(200);
      expect(g.body.steps[0].caller).toEqual(role === 'finance_admin' ? { eligible: true, refusal: null } : { eligible: false, refusal: role === 'commercial_ops' ? 'SELF_APPROVAL' : 'STEP_SCOPE_MISSING' });
    }
    expect((await get('super_admin', BASE)).status).toBe(403);
    expect((await get('super_admin', `${BASE}/${id}`)).status).toBe(403);
    const mine = await get('finance_admin', `${BASE}?eligible_for_me=true`);
    expect(mine.body.requests.map((r: { id: string }) => r.id)).toEqual([id]);
    expect((await get('platform_owner', `${BASE}?eligible_for_me=true`)).body.requests).toEqual([]);
  });

  it('A3-RI-SUBMIT/WITHDRAW per role: only the requester (commercial_ops) → 200; every other role → 403 not_requester; super_admin 403', async () => {
    const c = await createAs('commercial_ops', creditBody(1));
    const id = c.body.request.id as string;
    for (const role of ROLES.filter((r) => r !== 'commercial_ops')) {
      expect(refusalOf(await post(role, `${BASE}/${id}/submit`, {})), role).toEqual([403, 'INSUFFICIENT_PERMISSIONS', 'not_requester']);
      expect(refusalOf(await post(role, `${BASE}/${id}/withdraw`, {})), role).toEqual([403, 'INSUFFICIENT_PERMISSIONS', 'not_requester']);
    }
    expect((await post('super_admin', `${BASE}/${id}/submit`, {})).status).toBe(403);
    expect((await post('super_admin', `${BASE}/${id}/withdraw`, {})).status).toBe(403);
    expect((await post('commercial_ops', `${BASE}/${id}/submit`, {})).body.request.state).toBe('PENDING_APPROVAL');
    expect(refusalOf(await post('commercial_ops', `${BASE}/${id}/submit`, {}))).toEqual([409, 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', 'state_invalid']);
    expect((await post('commercial_ops', `${BASE}/${id}/withdraw`, {})).body.request.state).toBe('WITHDRAWN');
  });

  it('A3-RI-APPROVE per role (finance-only chain): finance_admin 201; requester SELF_APPROVAL; the other 4 roles STEP_SCOPE_MISSING; super_admin 403; every attempt audited', async () => {
    const id = await pendingCredit(1);
    const out: Record<string, unknown[]> = {};
    for (const role of ROLES.filter((r) => r !== 'finance_admin')) out[role] = refusalOf(await post(role, `${BASE}/${id}/approvals`, { step_index: 0 }));
    out['super_admin'] = refusalOf(await post('super_admin', `${BASE}/${id}/approvals`, { step_index: 0 }));
    out['finance_admin'] = refusalOf(await post('finance_admin', `${BASE}/${id}/approvals`, { step_index: 0 }));
    expect(out).toEqual({
      platform_owner: [409, 'COMMERCIAL_APPROVAL_REFUSED', 'STEP_SCOPE_MISSING'],
      commercial_ops: [409, 'COMMERCIAL_APPROVAL_REFUSED', 'SELF_APPROVAL'],
      catalog_manager: [409, 'COMMERCIAL_APPROVAL_REFUSED', 'STEP_SCOPE_MISSING'],
      support_admin: [409, 'COMMERCIAL_APPROVAL_REFUSED', 'STEP_SCOPE_MISSING'],
      read_only_auditor: [409, 'COMMERCIAL_APPROVAL_REFUSED', 'STEP_SCOPE_MISSING'],
      super_admin: [403, 'INSUFFICIENT_PERMISSIONS', null],
      finance_admin: [201, undefined, null],
    });
    const ev = (await pg.query(`SELECT event_type, actor_id FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 ORDER BY created_at, id`, [id])).rows.map((r) => r.event_type);
    expect(ev).toEqual([
      'COMMERCIAL_CHANGE_REQUEST_CREATED',
      'COMMERCIAL_CHANGE_REQUEST_SUBMITTED',
      ...Array(5).fill('COMMERCIAL_APPROVAL_REFUSED'),
      'COMMERCIAL_APPROVAL_RECORDED',
      'COMMERCIAL_CHANGE_REQUEST_APPROVED',
    ]);
  });

  it('A3-RI-APPROVE-OWNER per role on the owner step (escalated credit): only platform_owner 201; finance_admin who signed step 0 → USER_ALREADY_APPROVED', async () => {
    const id = await pendingCredit(50_000);
    expect(refusalOf(await post('platform_owner', `${BASE}/${id}/approvals`, { step_index: 0 }))).toEqual([409, 'COMMERCIAL_APPROVAL_REFUSED', 'OUT_OF_ORDER']);
    expect((await post('finance_admin', `${BASE}/${id}/approvals`, { step_index: 0 })).status).toBe(201);
    const out: Record<string, unknown[]> = {};
    for (const role of ROLES.filter((r) => r !== 'platform_owner')) out[role] = refusalOf(await post(role, `${BASE}/${id}/approvals`, { step_index: 1 }));
    expect(out).toEqual({
      finance_admin: [409, 'COMMERCIAL_APPROVAL_REFUSED', 'USER_ALREADY_APPROVED'],
      commercial_ops: [409, 'COMMERCIAL_APPROVAL_REFUSED', 'SELF_APPROVAL'],
      catalog_manager: [409, 'COMMERCIAL_APPROVAL_REFUSED', 'STEP_SCOPE_MISSING'],
      support_admin: [409, 'COMMERCIAL_APPROVAL_REFUSED', 'STEP_SCOPE_MISSING'],
      read_only_auditor: [409, 'COMMERCIAL_APPROVAL_REFUSED', 'STEP_SCOPE_MISSING'],
    });
    const done = await post('platform_owner', `${BASE}/${id}/approvals`, { step_index: 1 });
    expect(done.status).toBe(201);
    expect(done.body.request.state).toBe('APPROVED');
  });

  it('A3-RI-REJECT per role: finance_admin 200 (REJECTED); requester SELF_APPROVAL; the other 4 STEP_SCOPE_MISSING; super_admin 403', async () => {
    const id = await pendingCredit(1);
    const out: Record<string, unknown[]> = {};
    for (const role of ROLES.filter((r) => r !== 'finance_admin')) out[role] = refusalOf(await post(role, `${BASE}/${id}/reject`, { reason: 'no' }));
    out['super_admin'] = refusalOf(await post('super_admin', `${BASE}/${id}/reject`, { reason: 'no' }));
    expect(out).toEqual({
      platform_owner: [409, 'COMMERCIAL_APPROVAL_REFUSED', 'STEP_SCOPE_MISSING'],
      commercial_ops: [409, 'COMMERCIAL_APPROVAL_REFUSED', 'SELF_APPROVAL'],
      catalog_manager: [409, 'COMMERCIAL_APPROVAL_REFUSED', 'STEP_SCOPE_MISSING'],
      support_admin: [409, 'COMMERCIAL_APPROVAL_REFUSED', 'STEP_SCOPE_MISSING'],
      read_only_auditor: [409, 'COMMERCIAL_APPROVAL_REFUSED', 'STEP_SCOPE_MISSING'],
      super_admin: [403, 'INSUFFICIENT_PERMISSIONS', null],
    });
    const r = await post('finance_admin', `${BASE}/${id}/reject`, { reason: 'not justified' });
    expect(r.status).toBe(200);
    expect(r.body.request).toMatchObject({ state: 'REJECTED', rejection_reason: 'not justified' });
  });

  it('A3-RI-BOOT approval returns 409 CCP_NOT_BOOTSTRAPPED when the chain has no independent eligible attested human', async () => {
    const id = await pendingCredit(1);
    await revokeAttestation(pg, user['finance_admin'] as string);
    const res = await post('finance_admin', `${BASE}/${id}/approvals`, { step_index: 0 });
    expect(refusalOf(res)).toEqual([409, 'CCP_NOT_BOOTSTRAPPED', null]);
    expect(res.body.error.details).toMatchObject({ unfillable_steps: [0], chain_rule: 'FINANCE_ONLY' });
    const g = await get('finance_admin', `${BASE}/${id}`);
    expect(g.body.chain_satisfiable).toBe(false);
  });
});
