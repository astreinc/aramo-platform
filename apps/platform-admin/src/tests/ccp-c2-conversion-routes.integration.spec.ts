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
import { CommercialChangeRequestService, CommercialConversionService, SubscriptionPrismaService } from '@aramo/subscription';

import { PlatformCommercialChangeRequestController } from '../app/platform/platform-commercial-change-request.controller.js';
import { PlatformCommercialConversionController } from '../app/platform/platform-commercial-conversion.controller.js';
// eslint-disable-next-line @nx/enforce-module-boundaries -- test-only real-Postgres support shared with the libs/subscription CCP specs (TD-A3-19 precedent)
import { CCP_BUNDLES, addOperator, applyCcpA6Schema, revokeRole } from '../../../../libs/subscription/src/tests/support/ccp-a3-database.js';
// eslint-disable-next-line @nx/enforce-module-boundaries -- test-only: the one shared C2 harness (fake Stripe, no network, no key)
import { c2Harness } from '../../../../libs/subscription/src/tests/support/ccp-c2.js';

import { generateTestKeyPair } from './test-keys.js';

// CCP-C2 (PBD §5.2 row C2) — POST /platform/commercial/change-requests/{id}/convert and
// GET /platform/commercial/change-requests/{id}/conversion per role, through the REAL guard chain and
// the REAL services on real Postgres (identity RBAC + entitlement + every subscription migration).
// Each principal holds exactly one role. Stripe is a fake (no network, no key).

const ROLES = ['platform_owner', 'finance_admin', 'commercial_ops', 'catalog_manager', 'support_admin', 'read_only_auditor'] as const;
const BASE = '/platform/commercial/change-requests';
const BUSINESS = 'aramo-sign-standard-business-v1';
const INCLUDED = 'aramo-sign-included-v1';

class RoleBundleResolver implements EffectiveAuthorizationResolver {
  readonly roleOf = new Map<string, string>();
  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const role = this.roleOf.get(input.principal_id);
    const scopes = role === undefined ? [] : [...(CCP_BUNDLES[role] ?? [])];
    return { status: 'ok', scopes: filterScopesForConsumer({ consumer: input.consumer_type, scopes, tenantHasEsign: false }) };
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-C2 — the conversion routes per role (real guards + real services + real Postgres)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: SubscriptionPrismaService;
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-c2-int';
  const saved: Record<string, string | undefined> = {};
  const resolver = new RoleBundleResolver();
  const user: Record<string, string> = {};
  let keyN = 0;
  const key = () => `c2-route-key-${String(++keyN).padStart(6, '0')}`;

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
  const get = async (role: string, path: string, consumer = 'platform') => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${await token(role, consumer)}`);
  const out = (res: request.Response) => [res.status, res.body?.error?.code ?? null, res.body?.error?.details?.refusal ?? res.body?.error?.details?.failure ?? res.body?.error?.details?.reason ?? null];
  const version = async (plan: string) => (await pg.query(`SELECT v.id FROM subscription."PlanVersion" v JOIN subscription."Plan" p ON p.id = v.plan_id WHERE p.key = $1 AND v.status = 'PUBLISHED'`, [plan])).rows[0].id as string;

  async function tenant(): Promise<string> {
    const r = await pg.query(`INSERT INTO identity."Tenant" (id, name, kind, updated_at) VALUES (gen_random_uuid(), 'C2 route', 'BUSINESS', now()) RETURNING id`);
    return r.rows[0].id as string;
  }
  /** An open BASE row inserted raw: a governed MANUAL row, or a provider-linked SELF_SERVICE one. */
  async function row(t: string, source: 'MANUAL' | 'SELF_SERVICE'): Promise<string> {
    const id = randomUUID();
    await pg.query(
      `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by, billing_provider, billing_account_ref, billing_subscription_ref)
       SELECT $1::uuid, $2::uuid, p.id, (SELECT v.id FROM subscription."PlanVersion" v WHERE v.plan_id = p.id AND v.status = 'PUBLISHED'), 'sign', 'BASE', now(), $3, 'c2-route', $4, $5, $6 FROM subscription."Plan" p WHERE p.key = $7`,
      [id, t, source, source === 'SELF_SERVICE' ? 'STRIPE' : null, source === 'SELF_SERVICE' ? `acct_${t}` : null, source === 'SELF_SERVICE' ? `sub_${id}` : null, source === 'SELF_SERVICE' ? BUSINESS : INCLUDED],
    );
    return id;
  }
  async function approved(t: string, payload: Record<string, unknown>, approver = 'finance_admin'): Promise<string> {
    const c = await post('commercial_ops', BASE, { action_type: 'CONVERSION', tenant_id: t, product_key: 'sign', payload, reason: 'route test', idempotency_key: key() });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const id = c.body.request.id as string;
    expect((await post('commercial_ops', `${BASE}/${id}/submit`)).status).toBe(200);
    expect((await post(approver, `${BASE}/${id}/approvals`, { step_index: 0 })).status).toBe(201);
    return id;
  }
  const toSelfService = async (gov: string, expires = new Date(Date.now() + 24 * 3_600_000)) => ({ direction: 'TO_SELF_SERVICE', governed_subscription_id: gov, plan_key: BUSINESS, plan_version_id: await version(BUSINESS), release_expires_at: expires.toISOString() });

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    await applyCcpA6Schema(pg);
    prisma = new SubscriptionPrismaService(url);
    await prisma.$connect();
    const h = c2Harness(prisma, () => new Date());
    const keys = generateTestKeyPair();
    privatePem = keys.privatePem;
    for (const k of ['AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY']) saved[k] = process.env[k];
    process.env['AUTH_AUDIENCE'] = audience;
    process.env['AUTH_PUBLIC_KEY'] = keys.publicPem;
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, AuthorizationModule],
      controllers: [PlatformCommercialChangeRequestController, PlatformCommercialConversionController],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: resolver },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
        { provide: CommercialChangeRequestService, useValue: h.changeRequests },
        { provide: CommercialConversionService, useValue: h.conversions },
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
    for (const [alias, role] of [['commercial_ops_2', 'commercial_ops'], ['finance_admin_2', 'finance_admin']] as const) {
      user[alias] = await addOperator(pg, [role]);
      resolver.roleOf.set(user[alias] as string, role);
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

  it('C2-RI-1 POST …/convert per role: only the REQUESTER applies (200 RELEASED); every other CCP role 403 requester_scope_missing; another commercial_ops 403 not_requester; super_admin refused at the gate; a replay is 200 replayed', async () => {
    const t = await tenant();
    const id = await approved(t, await toSelfService(await row(t, 'MANUAL')));
    const results: Record<string, unknown[]> = {};
    for (const role of ['platform_owner', 'finance_admin', 'catalog_manager', 'support_admin', 'read_only_auditor', 'commercial_ops_2', 'super_admin']) results[role] = out(await post(role, `${BASE}/${id}/convert`));
    expect(results).toEqual({
      platform_owner: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      finance_admin: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      catalog_manager: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      support_admin: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      read_only_auditor: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      commercial_ops_2: [403, 'INSUFFICIENT_PERMISSIONS', 'not_requester'],
      super_admin: [403, 'INSUFFICIENT_PERMISSIONS', null],
    });
    const ok = await post('commercial_ops', `${BASE}/${id}/convert`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({
      replayed: false,
      request: { id, state: 'APPLIED' },
      conversion: { direction: 'TO_SELF_SERVICE', status: 'RELEASED', pending_provider: false, release: { state: 'RELEASED', effective_state: 'RELEASED', intent_id: null }, commands: [], application: { action_type: 'CONVERSION', attempt: 1 } },
    });
    const again = await post('commercial_ops', `${BASE}/${id}/convert`);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, conversion: { status: 'RELEASED', release: { id: ok.body.conversion.release.id } } });
  });

  it('C2-RI-2 GET …/conversion per role: the 6 CCP roles 200 (read-only); super_admin 403 at the gate; tenant tier 403; malformed id 400; unknown id 404; not a CONVERSION 409 action_not_applicable', async () => {
    const t = await tenant();
    const id = await approved(t, await toSelfService(await row(t, 'MANUAL')));
    for (const role of ROLES) {
      const r = await get(role, `${BASE}/${id}/conversion`);
      expect(r.status, role).toBe(200);
      expect(r.body, role).toMatchObject({ request: { id, state: 'APPROVED' }, conversion: { direction: 'TO_SELF_SERVICE', status: 'NOT_APPLIED', pending_provider: false, release: null, commands: [], application: null } });
    }
    expect(out(await get('super_admin', `${BASE}/${id}/conversion`))).toEqual([403, 'INSUFFICIENT_PERMISSIONS', null]);
    expect((await get('commercial_ops', `${BASE}/${id}/conversion`, 'recruiter')).status).toBe(403);
    expect((await get('commercial_ops', `${BASE}/not-a-uuid/conversion`)).status).toBe(400);
    expect(out(await get('commercial_ops', `${BASE}/${randomUUID()}/conversion`))).toEqual([404, 'NOT_FOUND', null]);
    const end = await post('commercial_ops', BASE, { action_type: 'SUBSCRIPTION_END', tenant_id: await tenant(), product_key: 'sign', payload: { subscription_id: randomUUID() }, reason: 'x', idempotency_key: key() });
    expect(out(await get('commercial_ops', `${BASE}/${end.body.request.id}/conversion`))).toEqual([409, 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', 'action_not_applicable']);
    expect(out(await post('commercial_ops', `${BASE}/${end.body.request.id}/convert`))).toEqual([409, 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', 'action_not_applicable']);
  });

  it('C2-RI-3 self-service → governed returns 200 PENDING_PROVIDER (pending_provider true; the command is pending, never reported committed); NC-5 → 409 apply_refused (request stays APPROVED); a failed check → 409 apply_failed (APPLY_FAILED); a tenant-tier token → 403', async () => {
    const t = await tenant();
    const ss = await row(t, 'SELF_SERVICE');
    const id = await approved(t, { direction: 'TO_GOVERNED', subscription_id: ss, plan_key: 'aramo-sign-enterprise-v1', plan_version_id: await version('aramo-sign-enterprise-v1') });
    const r = await post('commercial_ops', `${BASE}/${id}/convert`);
    // Enterprise carries no Business allowances: T8 refuses the downgrade before any provider command.
    expect(out(r)).toEqual([409, 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', 'USAGE_TREATMENT_UNDEFINED']);
    expect(r.body.error.details).toMatchObject({ reason: 'apply_failed', attempt: 1, request_state: 'APPLY_FAILED', kind: 'DOWNGRADE' });
    expect((await get('read_only_auditor', `${BASE}/${id}/conversion`)).body.conversion).toMatchObject({ status: 'APPLY_FAILED', commands: [] });

    // A held activation resolved self-service → governed: pending-provider until the provider confirms.
    const t2 = await tenant();
    const gov = await row(t2, 'MANUAL');
    const ref = `sub_held_${randomUUID()}`;
    await pg.query(`INSERT INTO subscription."BillingReconciliationFlag" (id, tenant_id, provider, subscription_ref, reason) VALUES (gen_random_uuid(), $1, 'STRIPE', $2, 'governed_subscription_open')`, [t2, ref]);
    const held = await approved(t2, { direction: 'TO_GOVERNED', held_subscription_ref: ref, governed_subscription_id: gov });
    const p = await post('commercial_ops', `${BASE}/${held}/convert`);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({ replayed: false, request: { state: 'APPLYING' }, conversion: { direction: 'TO_GOVERNED', status: 'PENDING_PROVIDER', pending_provider: true, application: null } });
    expect(p.body.conversion.commands).toHaveLength(1);
    expect(p.body.conversion.commands[0]).toMatchObject({ command_kind: 'SUBSCRIPTION_CANCEL', step: 'cancel_held_activation', target_ref: ref, state: 'PENDING', pending_provider: true, params: { mode: 'IMMEDIATE' } });
    expect((await post('commercial_ops', `${BASE}/${held}/convert`)).body).toMatchObject({ replayed: true, conversion: { status: 'PENDING_PROVIDER' } });

    // NC-5 through the route.
    const t3 = await tenant();
    const nc5 = await approved(t3, await toSelfService(await row(t3, 'MANUAL')), 'finance_admin_2');
    await revokeRole(pg, user['finance_admin_2'] as string, 'finance_admin');
    expect(out(await post('commercial_ops', `${BASE}/${nc5}/convert`))).toEqual([409, 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', 'APPROVER_NO_LONGER_ELIGIBLE']);
    expect((await pg.query(`SELECT state FROM subscription."CommercialChangeRequest" WHERE id = $1`, [nc5])).rows[0].state).toBe('APPROVED');
    const tenantTier = await request(app.getHttpServer()).post(`${BASE}/${nc5}/convert`).set('Authorization', `Bearer ${await token('commercial_ops', 'recruiter')}`).send({});
    expect(tenantTier.status).toBe(403);
    expect((await request(app.getHttpServer()).post(`${BASE}/not-a-uuid/convert`).set('Authorization', `Bearer ${await token('commercial_ops')}`).send({})).status).toBe(400);
  });
});
