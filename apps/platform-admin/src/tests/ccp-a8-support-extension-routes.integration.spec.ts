import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

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
  SupportExtensionService,
} from '@aramo/subscription';

import { PlatformCommercialApplyController } from '../app/platform/platform-commercial-apply.controller.js';
import { PlatformCommercialChangeRequestController } from '../app/platform/platform-commercial-change-request.controller.js';
import { PlatformCommercialSupportExtensionController } from '../app/platform/platform-commercial-support-extension.controller.js';
// eslint-disable-next-line @nx/enforce-module-boundaries -- test-only real-Postgres support shared with the libs/subscription CCP specs (TD-A3-19 precedent)
import { CCP_BUNDLES, addOperator, applyCcpA6Schema } from '../../../../libs/subscription/src/tests/support/ccp-a3-database.js';

import { generateTestKeyPair } from './test-keys.js';

// CCP-A8 (PBD §5.1 row A8) — /platform/commercial/support-extensions and the reused A6 routes
// per role (the 6 CCP roles + super_admin), through the REAL guard chain and the REAL services
// on real Postgres (identity RBAC + entitlement + every subscription migration). Each principal
// holds exactly one role.

const ROLES = ['platform_owner', 'finance_admin', 'commercial_ops', 'catalog_manager', 'support_admin', 'read_only_auditor', 'super_admin'] as const;
const SE = '/platform/commercial/support-extensions';
const CR = '/platform/commercial/change-requests';
const DAY = 86_400_000;

class RoleBundleResolver implements EffectiveAuthorizationResolver {
  readonly roleOf = new Map<string, string>();
  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const role = this.roleOf.get(input.principal_id);
    const scopes = role === undefined ? [] : [...(CCP_BUNDLES[role] ?? [])];
    return { status: 'ok', scopes: filterScopesForConsumer({ consumer: input.consumer_type, scopes, tenantHasEsign: false }) };
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-A8 — the support-extension routes per role (real guards + real services + real Postgres)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: SubscriptionPrismaService;
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-a8-int';
  const saved: Record<string, string | undefined> = {};
  const resolver = new RoleBundleResolver();
  const user: Record<string, string> = {};
  let keyN = 0;
  const key = () => `a8-route-key-${String(++keyN).padStart(6, '0')}`;

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
  const get = async (role: string, path: string) => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${await token(role)}`);
  const out = (res: request.Response) => [res.status, res.body?.error?.code ?? null, res.body?.error?.details?.refusal ?? res.body?.error?.details?.failure ?? res.body?.error?.details?.reason ?? null];

  /** A fresh tenant with a Stripe-owned PAST_DUE row whose grace ended a day ago. */
  async function pastDue(): Promise<{ tenant_id: string; subscription_id: string }> {
    const tenant_id = (await pg.query(`INSERT INTO identity."Tenant" (id, name, updated_at) VALUES (gen_random_uuid(), 'A8 route', now()) RETURNING id`)).rows[0].id as string;
    const subscription_id = randomUUID();
    await pg.query(
      `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by, status, grace_until, billing_provider, billing_account_ref, billing_subscription_ref)
       SELECT $1::uuid, $2::uuid, p.id, (SELECT v.id FROM subscription."PlanVersion" v WHERE v.plan_id = p.id AND v.status = 'PUBLISHED'), p.product_key, 'BASE', now() - interval '20 days', 'SELF_SERVICE', 'ccp-a8-route', 'PAST_DUE', now() - interval '1 day', 'STRIPE', 'acct_x', $3
         FROM subscription."Plan" p WHERE p.key = 'aramo-sign-standard-business-v1'`,
      [subscription_id, tenant_id, `sub_${subscription_id}`],
    );
    return { tenant_id, subscription_id };
  }
  const body = (t: { tenant_id: string; subscription_id: string }, requested_days: number) => ({ ...t, product_key: 'sign', requested_days, reason: 'Support goodwill', idempotency_key: key() });

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
    const extensions = new SupportExtensionService(prisma, audit, policies, operators, service, apply);
    const keys = generateTestKeyPair();
    privatePem = keys.privatePem;
    for (const k of ['AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY']) saved[k] = process.env[k];
    process.env['AUTH_AUDIENCE'] = audience;
    process.env['AUTH_PUBLIC_KEY'] = keys.publicPem;
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, AuthorizationModule],
      controllers: [PlatformCommercialChangeRequestController, PlatformCommercialApplyController, PlatformCommercialSupportExtensionController],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: resolver },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
        { provide: CommercialChangeRequestService, useValue: service },
        { provide: CommercialApplyService, useValue: apply },
        { provide: SupportExtensionService, useValue: extensions },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: never, res: never, next: () => void) => new RequestIdMiddleware().use(req, res, next));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    for (const role of ROLES) {
      user[role] = await addOperator(pg, [role]);
      resolver.roleOf.set(user[role] as string, role);
    }
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

  it('A8-RI-POST per role: only support_admin applies an in-bound extension (201 APPLIED, kind EXCEPTION); every other role (super_admin included) 403 at the gate, nothing written; a replay is 200', async () => {
    const results: Record<string, unknown[]> = {};
    for (const role of ROLES.filter((r) => r !== 'support_admin')) {
      const t = await pastDue();
      results[role] = out(await post(role, SE, body(t, 7)));
      expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialChangeRequest" WHERE tenant_id = $1`, [t.tenant_id])).rows[0].n, role).toBe(0);
    }
    expect(results).toEqual(Object.fromEntries(ROLES.filter((r) => r !== 'support_admin').map((r) => [r, [403, 'INSUFFICIENT_PERMISSIONS', null]])));
    const t = await pastDue();
    const b = body(t, 7);
    const ok = await post('support_admin', SE, b);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ outcome: 'APPLIED', replayed: false, request: { kind: 'EXCEPTION', state: 'APPLIED', required_chain: { rule: 'BOUNDED_EXCEPTION', steps: [] } }, extension: { is_exception: true, days: 7, subscription_id: t.subscription_id }, application: { action_type: 'SUPPORT_EXTENSION', capabilities: [] } });
    const again = await post('support_admin', SE, b);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ outcome: 'APPLIED', replayed: true, request: { id: ok.body.request.id } });
  });

  it('A8-RI-GET per role: platform_owner, finance_admin, commercial_ops, support_admin, read_only_auditor 200; catalog_manager and super_admin 403', async () => {
    const t = await pastDue();
    expect((await post('support_admin', SE, body(t, 3))).status).toBe(201);
    for (const role of ROLES) {
      const res = await get(role, `${SE}?tenant_id=${t.tenant_id}`);
      const allowed = !['catalog_manager', 'super_admin'].includes(role);
      expect(res.status, role).toBe(allowed ? 200 : 403);
      if (allowed) expect(res.body.extensions).toMatchObject([{ tenant_id: t.tenant_id, days: 3, active: true, removed_at: null }]);
    }
  });

  it('A8-RI-ESC a breach (20 days) escalates (201 ESCALATED, nothing applied); finance_admin approves; only support_admin applies through …/apply (others 403); the overlay is is_exception = false; then a REMOVE request through the same routes removes it', async () => {
    const t = await pastDue();
    const esc = await post('support_admin', SE, body(t, 20));
    expect(esc.status, JSON.stringify(esc.body)).toBe(201);
    expect(esc.body).toMatchObject({ outcome: 'ESCALATED', extension: null, request: { kind: 'NORMAL', state: 'PENDING_APPROVAL', required_chain: { rule: 'FINANCE_ONLY' } }, decision: { breaches: ['LENGTH'] } });
    const id = esc.body.request.id as string;
    expect((await post('support_admin', `${CR}/${id}/approvals`, { step_index: 0 })).status).toBe(409);
    expect((await post('finance_admin', `${CR}/${id}/approvals`, { step_index: 0 })).status).toBe(201);
    const applyResults: Record<string, unknown[]> = {};
    for (const role of ROLES.filter((r) => r !== 'support_admin')) applyResults[role] = out(await post(role, `${CR}/${id}/apply`));
    expect(applyResults).toEqual({
      platform_owner: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      finance_admin: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      commercial_ops: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      catalog_manager: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      read_only_auditor: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      super_admin: [403, 'INSUFFICIENT_PERMISSIONS', null],
    });
    const applied = await post('support_admin', `${CR}/${id}/apply`);
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body).toMatchObject({ request: { state: 'APPLIED' }, application: { action_type: 'SUPPORT_EXTENSION', subscription_id: t.subscription_id } });
    const [ext] = (await get('support_admin', `${SE}?tenant_id=${t.tenant_id}`)).body.extensions;
    expect(ext).toMatchObject({ is_exception: false, days: 20, active: true });
    expect(new Date(ext.extends_until).getTime() - new Date(ext.base_until).getTime()).toBe(20 * DAY);

    const rm = await post('support_admin', CR, { action_type: 'SUPPORT_EXTENSION', tenant_id: t.tenant_id, product_key: 'sign', payload: { operation: 'REMOVE', support_extension_id: ext.id }, reason: 'Granted in error', idempotency_key: key() });
    expect(rm.status, JSON.stringify(rm.body)).toBe(201);
    const rid = rm.body.request.id as string;
    expect((await post('support_admin', `${CR}/${rid}/submit`)).status).toBe(200);
    expect((await post('finance_admin', `${CR}/${rid}/approvals`, { step_index: 0 })).status).toBe(201);
    expect((await post('support_admin', `${CR}/${rid}/apply`)).status).toBe(200);
    expect((await get('read_only_auditor', `${SE}?tenant_id=${t.tenant_id}`)).body.extensions).toMatchObject([{ id: ext.id, active: false, remove_change_request_id: rid, removed_by: user['support_admin'] }]);
  });

  it('A8-RI-REFUSE tenant tier 403; a bounded EXCEPTION request is never applied through …/apply (409 action_not_applicable); a row of another tenant 400 subscription_not_open', async () => {
    const t = await pastDue();
    const tier = await request(app.getHttpServer()).post(SE).set('Authorization', `Bearer ${await token('support_admin', 'recruiter')}`).send(body(t, 2));
    expect(tier.status).toBe(403);
    const ok = await post('support_admin', SE, body(t, 2));
    expect(out(await post('support_admin', `${CR}/${ok.body.request.id}/apply`))).toEqual([409, 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', 'action_not_applicable']);
    const other = await pastDue();
    expect(out(await post('support_admin', SE, { ...body(t, 2), subscription_id: other.subscription_id }))).toEqual([400, 'VALIDATION_ERROR', 'subscription_not_open']);
  });
});
