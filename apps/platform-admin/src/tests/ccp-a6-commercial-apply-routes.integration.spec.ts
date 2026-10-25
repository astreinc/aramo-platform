import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  CommercialApplyService,
  CommercialAuditRepository,
  CommercialChangeRequestService,
  CommercialOperatorRepository,
  CommercialPolicyRepository,
  SubscriptionPrismaService,
} from '@aramo/subscription';

import { PlatformCommercialApplyController } from '../app/platform/platform-commercial-apply.controller.js';
import { PlatformCommercialChangeRequestController } from '../app/platform/platform-commercial-change-request.controller.js';
// eslint-disable-next-line @nx/enforce-module-boundaries -- test-only real-Postgres support shared with the libs/subscription CCP specs (TD-A3-19 precedent)
import { CCP_BUNDLES, addOperator, applyCcpA6Schema, revokeRole } from '../../../../libs/subscription/src/tests/support/ccp-a3-database.js';

import { generateTestKeyPair } from './test-keys.js';

// CCP-A6 (PBD §5.1 row A6) — POST /platform/commercial/change-requests/{id}/apply per role,
// through the REAL guard chain and the REAL services on real Postgres (identity RBAC +
// entitlement + every subscription migration). Each principal holds exactly one role.

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

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-A6 — the apply route per role (real guards + real services + real Postgres)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: SubscriptionPrismaService;
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-a6-int';
  const saved: Record<string, string | undefined> = {};
  const resolver = new RoleBundleResolver();
  const user: Record<string, string> = {};
  let keyN = 0;
  const key = () => `a6-route-key-${String(++keyN).padStart(6, '0')}`;

  async function token(role: string, consumer_type = 'platform'): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ consumer_type, actor_kind: 'user', tenant_id: PLATFORM_TENANT_SENTINEL_ID, authz_version: 1 })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('Aramo Core Auth')
      .setAudience(audience)
      .setSubject(user[role] as string)
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(await importPKCS8(privatePem, 'RS256'));
  }
  const post = async (role: string, path: string, body: object = {}) => request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${await token(role)}`).send(body);
  const out = (res: request.Response) => [res.status, res.body?.error?.code ?? null, res.body?.error?.details?.refusal ?? res.body?.error?.details?.failure ?? res.body?.error?.details?.reason ?? null];

  async function tenant(): Promise<string> {
    const r = await pg.query(`INSERT INTO identity."Tenant" (id, name, updated_at) VALUES (gen_random_uuid(), 'A6 route', now()) RETURNING id`);
    return r.rows[0].id as string;
  }
  async function approvedOpen(t: string, approver = 'finance_admin'): Promise<string> {
    const v = (await pg.query(`SELECT v.id FROM subscription."PlanVersion" v JOIN subscription."Plan" p ON p.id = v.plan_id WHERE p.key = 'aramo-sign-included-v1' AND v.status = 'PUBLISHED'`)).rows[0].id;
    const c = await post('commercial_ops', BASE, {
      action_type: 'SUBSCRIPTION_OPEN',
      tenant_id: t,
      product_key: 'sign',
      payload: { plan_key: 'aramo-sign-included-v1', plan_version_id: v, replaces_subscription_id: null },
      reason: 'route test',
      idempotency_key: key(),
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const id = c.body.request.id as string;
    expect((await post('commercial_ops', `${BASE}/${id}/submit`)).status).toBe(200);
    expect((await post(approver, `${BASE}/${id}/approvals`, { step_index: 0 })).status).toBe(201);
    return id;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    await applyCcpA6Schema(pg);
    prisma = new SubscriptionPrismaService(url);
    await prisma.$connect();
    const audit = new CommercialAuditRepository(prisma);
    const policies = new CommercialPolicyRepository(prisma);
    const operators = new CommercialOperatorRepository(prisma, audit, policies);
    const service = new CommercialChangeRequestService(prisma, audit, policies, operators);
    const apply = new CommercialApplyService(prisma, audit, operators, service);
    const keys = generateTestKeyPair();
    privatePem = keys.privatePem;
    for (const k of ['AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY']) saved[k] = process.env[k];
    process.env['AUTH_AUDIENCE'] = audience;
    process.env['AUTH_PUBLIC_KEY'] = keys.publicPem;
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, AuthorizationModule],
      controllers: [PlatformCommercialChangeRequestController, PlatformCommercialApplyController],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: resolver },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
        { provide: CommercialChangeRequestService, useValue: service },
        { provide: CommercialApplyService, useValue: apply },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: never, res: never, next: () => void) => new RequestIdMiddleware().use(req, res, next));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    for (const role of [...ROLES, 'super_admin']) {
      user[role] = await addOperator(pg, [role]);
      resolver.roleOf.set(user[role] as string, role);
    }
    user['finance_admin_2'] = await addOperator(pg, ['finance_admin']);
    resolver.roleOf.set(user['finance_admin_2'] as string, 'finance_admin');
  }, 300_000);

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

  it('A6-RI-APPLY per role: only the requester authority (commercial_ops) applies (200); every other CCP role 403 requester_scope_missing; super_admin refused at the gate; a replay is 200 replayed', async () => {
    const id = await approvedOpen(await tenant());
    const results: Record<string, unknown[]> = {};
    for (const role of ['platform_owner', 'finance_admin', 'catalog_manager', 'support_admin', 'read_only_auditor', 'super_admin']) results[role] = out(await post(role, `${BASE}/${id}/apply`));
    expect(results).toEqual({
      platform_owner: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      finance_admin: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      catalog_manager: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      support_admin: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      read_only_auditor: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      super_admin: [403, 'INSUFFICIENT_PERMISSIONS', null],
    });
    const ok = await post('commercial_ops', `${BASE}/${id}/apply`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ replayed: false, request: { id, state: 'APPLIED' }, application: { change_request_id: id, action_type: 'SUBSCRIPTION_OPEN', attempt: 1, capabilities: ['core', 'sign'] } });
    const again = await post('commercial_ops', `${BASE}/${id}/apply`);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, application: { id: ok.body.application.id } });
  });

  it('A6-RI-REFUSE NC-5 refusal → 409 apply_refused (request unchanged); a guard failure → 409 apply_failed (APPLY_FAILED, retryable); a non-A6 action → 409 action_not_applicable; a tenant-tier token → 403', async () => {
    const signerTenant = await tenant();
    const nc5 = await approvedOpen(signerTenant, 'finance_admin_2');
    await revokeRole(pg, user['finance_admin_2'] as string, 'finance_admin');
    expect(out(await post('commercial_ops', `${BASE}/${nc5}/apply`))).toEqual([409, 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', 'APPROVER_NO_LONGER_ELIGIBLE']);
    expect((await pg.query(`SELECT state FROM subscription."CommercialChangeRequest" WHERE id = $1`, [nc5])).rows[0].state).toBe('APPROVED');

    const t = await tenant();
    const stale = await approvedOpen(t);
    await pg.query(
      `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by)
       SELECT gen_random_uuid(), $1::uuid, p.id, (SELECT v.id FROM subscription."PlanVersion" v WHERE v.plan_id = p.id AND v.status = 'PUBLISHED'), 'sign', 'BASE', now(), 'MANUAL', 'x' FROM subscription."Plan" p WHERE p.key = 'aramo-sign-included-v1'`,
      [t],
    );
    const failed = await post('commercial_ops', `${BASE}/${stale}/apply`);
    expect(out(failed)).toEqual([409, 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', 'TARGET_STALE']);
    expect(failed.body.error.details).toMatchObject({ reason: 'apply_failed', attempt: 1, request_state: 'APPLY_FAILED' });

    const credit = await post('commercial_ops', BASE, { action_type: 'CREDIT', tenant_id: await tenant(), product_key: 'sign', payload: { amount_minor: 1, currency: 'USD' }, reason: 'credit', idempotency_key: key() });
    expect(out(await post('commercial_ops', `${BASE}/${credit.body.request.id}/apply`))).toEqual([409, 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', 'action_not_applicable']);

    const tenantTier = await request(app.getHttpServer()).post(`${BASE}/${stale}/apply`).set('Authorization', `Bearer ${await token('commercial_ops', 'recruiter')}`).send({});
    expect(tenantTier.status).toBe(403);
    expect((await request(app.getHttpServer()).post(`${BASE}/not-a-uuid/apply`).set('Authorization', `Bearer ${await token('commercial_ops')}`).send({})).status).toBe(400);
  });
});
