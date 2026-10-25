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
  CommercialApplyService,
  CommercialAuditExportService,
  CommercialAuditRepository,
  CommercialChangeRequestService,
  CommercialOperatorRepository,
  CommercialOperatorRosterService,
  CommercialPolicyApplyService,
  CommercialPolicyGovernanceService,
  CommercialPolicyRepository,
  SubscriptionPrismaService,
} from '@aramo/subscription';

import { PlatformCommercialApplyController } from '../app/platform/platform-commercial-apply.controller.js';
import { PlatformCommercialAuditController } from '../app/platform/platform-commercial-audit.controller.js';
import { PlatformCommercialChangeRequestController } from '../app/platform/platform-commercial-change-request.controller.js';
import { PlatformCommercialGovernanceController } from '../app/platform/platform-commercial-governance.controller.js';
// eslint-disable-next-line @nx/enforce-module-boundaries -- test-only real-Postgres support shared with the libs/subscription A3/A9/B5 specs
import { CCP_BUNDLES, POLICY_V1, addOperator, applyCcpA6Schema, revokeRole } from '../../../../libs/subscription/src/tests/support/ccp-a3-database.js';

import { generateTestKeyPair } from './test-keys.js';

// CCP-B5 (PBD §5.3 row B5, mandatory tests: per-role allowed/refused for every action, the
// last-owner refusal surfaced, the export read-only, the POLICY_ACTIVATE apply) — the B5
// routes and the A3/A9 change-request route, through the REAL guard chain and the REAL
// services on real Postgres. CCP-B5-R: the FULL chain (applyCcpA6Schema: every identity, entitlement,
// metering and subscription migration, ending with the guard union and 20261027000200_ccp_b5r), and
// the governed apply route (PlatformCommercialApplyController) through which the requester applies an
// approved POLICY_ACTIVATE (TD-B5-1).

const ROLES = ['platform_owner', 'finance_admin', 'commercial_ops', 'catalog_manager', 'support_admin', 'read_only_auditor'] as const;
const CR = '/platform/commercial/change-requests';
const PV = '/platform/commercial/policy-versions';

class RoleBundleResolver implements EffectiveAuthorizationResolver {
  readonly roleOf = new Map<string, string>();
  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const role = this.roleOf.get(input.principal_id);
    const scopes = role === undefined ? [] : [...(CCP_BUNDLES[role] ?? [])];
    return { status: 'ok', scopes: filterScopesForConsumer({ consumer: input.consumer_type, scopes, tenantHasEsign: false }) };
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-B5 — policy, roster, export and the POLICY_ACTIVATE apply per role (real guards + real services + real Postgres)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: SubscriptionPrismaService;
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-b5-int';
  const saved: Record<string, string | undefined> = {};
  const resolver = new RoleBundleResolver();
  const user: Record<string, string> = {};
  let keyN = 0;
  const key = () => `b5-route-key-${String(++keyN).padStart(6, '0')}`;

  async function token(who: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ consumer_type: 'platform', actor_kind: 'user', tenant_id: PLATFORM_TENANT_SENTINEL_ID, authz_version: 1 })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('Aramo Core Auth')
      .setAudience(audience)
      .setSubject(user[who] as string)
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(await importPKCS8(privatePem, 'RS256'));
  }
  const auth = async (who: string) => ({ Authorization: `Bearer ${await token(who)}` });
  const get = async (who: string, path: string) => request(app.getHttpServer()).get(path).set(await auth(who));
  const post = async (who: string, path: string, body: object) => request(app.getHttpServer()).post(path).set(await auth(who)).send(body);
  const patch = async (who: string, path: string, body: object) => request(app.getHttpServer()).patch(path).set(await auth(who)).send(body);
  const reasonOf = (res: request.Response) => [res.status, res.body?.error?.code ?? null, res.body?.error?.details?.refusal ?? res.body?.error?.details?.reason ?? null];
  const count = async (sql: string) => Number((await pg.query(sql)).rows[0].n);

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    prisma = new SubscriptionPrismaService(url);
    await prisma.$connect();
    const audit = new CommercialAuditRepository(prisma);
    const policies = new CommercialPolicyRepository(prisma);
    const operators = new CommercialOperatorRepository(prisma, audit, policies);
    const changeRequests = new CommercialChangeRequestService(prisma, audit, policies, operators);
    const keys = generateTestKeyPair();
    privatePem = keys.privatePem;
    for (const k of ['AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY']) saved[k] = process.env[k];
    process.env['AUTH_AUDIENCE'] = audience;
    process.env['AUTH_PUBLIC_KEY'] = keys.publicPem;
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, AuthorizationModule],
      controllers: [PlatformCommercialAuditController, PlatformCommercialChangeRequestController, PlatformCommercialGovernanceController, PlatformCommercialApplyController],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: resolver },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
        { provide: CommercialAuditRepository, useValue: audit },
        { provide: CommercialChangeRequestService, useValue: changeRequests },
        { provide: CommercialPolicyGovernanceService, useValue: new CommercialPolicyGovernanceService(prisma, policies, audit, operators, changeRequests) },
        {
          provide: CommercialApplyService,
          useValue: new CommercialApplyService(prisma, audit, operators, changeRequests, undefined, undefined, undefined, new CommercialPolicyApplyService(prisma, audit, operators, changeRequests)),
        },
        { provide: CommercialOperatorRosterService, useValue: new CommercialOperatorRosterService(prisma, operators, policies) },
        { provide: CommercialAuditExportService, useValue: new CommercialAuditExportService(prisma, audit, policies, operators) },
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
    await applyCcpA6Schema(pg);
    resolver.roleOf.clear();
    for (const role of [...ROLES, 'super_admin']) {
      user[role] = await addOperator(pg, [role]);
      resolver.roleOf.set(user[role] as string, role);
    }
    user['owner_2'] = await addOperator(pg, ['platform_owner']);
    resolver.roleOf.set(user['owner_2'] as string, 'platform_owner');
    user['finance_2'] = await addOperator(pg, ['finance_admin']);
    resolver.roleOf.set(user['finance_2'] as string, 'finance_admin');
  }, 120_000);

  it('B5-RI-POLICY per role: every CCP role reads the versions; only platform_owner / finance_admin draft (one DRAFT at a time); super_admin is refused at the gate', async () => {
    for (const role of ROLES) expect((await get(role, PV)).status, role).toBe(200);
    expect(reasonOf(await get('super_admin', PV))).toEqual([403, 'INSUFFICIENT_PERMISSIONS', null]);
    const callers = Object.fromEntries(await Promise.all(ROLES.map(async (r) => [r, (await get(r, PV)).body.caller] as const)));
    expect(callers).toEqual({
      platform_owner: { can_author: true, can_request_activation: false },
      finance_admin: { can_author: true, can_request_activation: true },
      commercial_ops: { can_author: false, can_request_activation: false },
      catalog_manager: { can_author: false, can_request_activation: false },
      support_admin: { can_author: false, can_request_activation: false },
      read_only_auditor: { can_author: false, can_request_activation: false },
    });
    const outcomes: Record<string, unknown> = {};
    for (const role of ['commercial_ops', 'catalog_manager', 'support_admin', 'read_only_auditor', 'super_admin', 'platform_owner', 'finance_admin']) {
      outcomes[role] = reasonOf(await post(role, PV, { source_version_id: POLICY_V1 }));
    }
    expect(outcomes).toEqual({
      commercial_ops: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_role_missing'],
      catalog_manager: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_role_missing'],
      support_admin: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_role_missing'],
      read_only_auditor: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_role_missing'],
      super_admin: [403, 'INSUFFICIENT_PERMISSIONS', null],
      platform_owner: [201, null, null],
      finance_admin: [409, 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', 'policy_draft_exists'],
    });
    const draftId = (await get('read_only_auditor', PV)).body.versions[0].id as string;
    expect(reasonOf(await patch('read_only_auditor', `${PV}/${draftId}`, { content: { approval_expiry_hours: 48 } }))).toEqual([403, 'INSUFFICIENT_PERMISSIONS', 'requester_role_missing']);
    expect(reasonOf(await patch('finance_admin', `${PV}/${draftId}`, { content: { approval_expiry_hours: 6 } }))).toEqual([400, 'VALIDATION_ERROR', 'policy_value_out_of_range']);
    const ok = await patch('finance_admin', `${PV}/${draftId}`, { content: { approval_expiry_hours: 48 } });
    expect(ok.status).toBe(200);
    expect(ok.body.version.content.approval_expiry_hours).toBe(48);
  });

  it('B5-RI-ACTIVATE the policy screen end to end over HTTP: finance requests activation, a distinct finance_admin and an owner sign (the approval applies nothing), and the REQUESTER applies it through POST …/apply (APPROVED → APPLYING → APPLIED); approvers are refused not_requester; a platform_owner cannot request it (CCP-B5-R)', async () => {
    const draft = await post('platform_owner', PV, { source_version_id: POLICY_V1 });
    const V2 = draft.body.version.id as string;
    const edited = await patch('finance_admin', `${PV}/${V2}`, { content: { approval_expiry_hours: 48 } });
    expect(reasonOf(await post('platform_owner', CR, { action_type: 'POLICY_ACTIVATE', payload: { policy_version_id: V2 }, reason: 'activate', idempotency_key: key() }))).toEqual([403, 'INSUFFICIENT_PERMISSIONS', 'requester_role_missing']);
    const created = await post('finance_admin', CR, { action_type: 'POLICY_ACTIVATE', payload: { policy_version_id: V2 }, reason: 'activate v2', idempotency_key: key() });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.request.id as string;
    // The NC-5 target snapshot is filled server-side from the draft as the requester saw it.
    expect(created.body.request.payload).toEqual({ policy_version_id: V2, target_content_checksum: edited.body.version.content_checksum });
    // The draft is locked while the request is open.
    expect(reasonOf(await post('finance_admin', `${CR}/${id}/submit`, {}))[0]).toBe(200);
    expect(reasonOf(await patch('platform_owner', `${PV}/${V2}`, { content: { approval_expiry_hours: 36 } }))).toEqual([409, 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', 'policy_version_locked']);
    const listed = await get('read_only_auditor', PV);
    expect(listed.body.open_request).toEqual({ id, state: 'PENDING_APPROVAL', policy_version_id: V2 });
    expect(reasonOf(await post('finance_admin', `${CR}/${id}/approvals`, { step_index: 0 }))).toEqual([409, 'COMMERCIAL_APPROVAL_REFUSED', 'SELF_APPROVAL']);
    expect((await post('finance_2', `${CR}/${id}/approvals`, { step_index: 0 })).status).toBe(201);
    const done = await post('platform_owner', `${CR}/${id}/approvals`, { step_index: 1 });
    expect(done.status).toBe(201);
    expect(done.body.apply).toBeNull();
    expect(done.body.request.state).toBe('APPROVED');
    expect('effect_applied_at' in done.body.request).toBe(false);
    const pending = await get('finance_admin', PV);
    expect(pending.body.active_version_id).toBe(POLICY_V1);
    expect(pending.body.versions.find((v: { id: string }) => v.id === V2).open_request).toEqual({ id, state: 'APPROVED', apply_actionable: true });
    expect((await get('finance_2', PV)).body.versions.find((v: { id: string }) => v.id === V2).open_request.apply_actionable).toBe(false);
    expect((await get('finance_admin', `${CR}/${id}`)).body.apply_actionable).toBe(true);
    // Requester-only (TD-B2-3): the approvers are refused.
    for (const who of ['platform_owner', 'finance_2']) expect(reasonOf(await post(who, `${CR}/${id}/apply`, {})), who).toEqual([403, 'INSUFFICIENT_PERMISSIONS', 'not_requester']);
    const applied = await post('finance_admin', `${CR}/${id}/apply`, {});
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body).toMatchObject({ replayed: false, application: null, catalog_application: null, request: { id, state: 'APPLIED' } });
    expect(applied.body.request.applied_at).toMatch(/Z$/);
    expect((await post('finance_admin', `${CR}/${id}/apply`, {})).body).toMatchObject({ replayed: true, request: { state: 'APPLIED' } });
    const after = await get('read_only_auditor', PV);
    expect(after.body.active_version_id).toBe(V2);
    expect(after.body.versions.map((v: { version_number: number; status: string }) => [v.version_number, v.status])).toEqual([[2, 'ACTIVE'], [1, 'RETIRED']]);
    expect(after.body.open_request).toBeNull();
    expect(after.body.versions.find((v: { id: string }) => v.id === V2).latest_request).toEqual({ id, state: 'APPLIED', applied_at: applied.body.request.applied_at });
    const detail = await get('commercial_ops', `${CR}/${id}`);
    expect(detail.body.request).toMatchObject({ state: 'APPLIED', applied_at: applied.body.request.applied_at });
  });

  it('B5-RI-ROLE the roster reads per role; the last-owner refusal is surfaced as 409 PLATFORM_LAST_OWNER; a role change is a governed request that applies only after a distinct owner signs', async () => {
    for (const role of ROLES) expect((await get(role, '/platform/commercial/operators')).status, role).toBe(200);
    expect(reasonOf(await get('super_admin', '/platform/commercial/operators'))).toEqual([403, 'INSUFFICIENT_PERMISSIONS', null]);
    let view = (await get('platform_owner', '/platform/commercial/operators')).body;
    expect(view.all_fulfillable).toBe(true);
    const sa = view.operators.find((o: { user_id: string }) => o.user_id === user['super_admin']);
    expect(sa).toMatchObject({ role_keys: ['super_admin'], commercial_role_keys: [] });
    // Grant support_admin to the auditor: a governed ROLE_GRANT, applied by a distinct owner.
    const g = await post('platform_owner', CR, { action_type: 'ROLE_GRANT', payload: { subject_user_id: user['read_only_auditor'], role_key: 'support_admin' }, reason: 'cover', idempotency_key: key() });
    expect(g.status).toBe(201);
    await post('platform_owner', `${CR}/${g.body.request.id}/submit`, {});
    view = (await get('read_only_auditor', '/platform/commercial/operators')).body;
    expect(view.operators.find((o: { user_id: string }) => o.user_id === user['read_only_auditor']).pending_role_requests).toEqual([{ id: g.body.request.id, action_type: 'ROLE_GRANT', role_key: 'support_admin', state: 'PENDING_APPROVAL' }]);
    const applied = await post('owner_2', `${CR}/${g.body.request.id}/approvals`, { step_index: 0 });
    expect(applied.body).toMatchObject({ request: { state: 'APPLIED' }, apply: { applied: true } });
    // Last owner: with owner_2 gone, revoking the only platform_owner is refused at create.
    await revokeRole(pg, user['owner_2'] as string, 'platform_owner');
    view = (await get('platform_owner', '/platform/commercial/operators')).body;
    expect(view.operators.find((o: { user_id: string }) => o.user_id === user['platform_owner']).is_last_owner).toBe(true);
    expect(view.chains.find((c: { key: string }) => c.key === 'ROLE_CHANGE')).toMatchObject({ fulfillable: false, missing: 'steps' });
    const last = await post('platform_owner', CR, { action_type: 'ROLE_REVOKE', payload: { subject_user_id: user['platform_owner'], role_key: 'platform_owner' }, reason: 'leaving', idempotency_key: key() });
    expect(reasonOf(last)).toEqual([409, 'PLATFORM_LAST_OWNER', 'platform_last_owner']);
  });

  it('B5-RI-EXPORT per role: platform_owner, finance_admin and read_only_auditor export (200, CSV, one audit event each); the other roles and super_admin are refused at the gate and write nothing', async () => {
    const before = await count(`SELECT count(*)::int AS n FROM subscription."CommercialAuditEvent"`);
    const outcomes: Record<string, number> = {};
    for (const role of [...ROLES, 'super_admin']) outcomes[role] = (await post(role, '/platform/commercial/audit-events/export', {})).status;
    expect(outcomes).toEqual({ platform_owner: 200, finance_admin: 200, commercial_ops: 403, catalog_manager: 403, support_admin: 403, read_only_auditor: 200, super_admin: 403 });
    expect(await count(`SELECT count(*)::int AS n FROM subscription."CommercialAuditEvent"`)).toBe(before + 3);
    expect(await count(`SELECT count(*)::int AS n FROM subscription."CommercialAuditEvent" WHERE event_type = 'COMMERCIAL_AUDIT_EXPORTED'`)).toBe(3);
    const res = await post('read_only_auditor', '/platform/commercial/audit-events/export', { event_type: 'COMMERCIAL_AUDIT_EXPORTED' });
    expect(res.body).toMatchObject({ row_count: 3, content_type: 'text/csv' });
    expect((res.body.csv as string).split('\r\n')[0]).toBe('id,time_utc,event,actor,roles,tenant,product,change_request,exception,detail');
    // The A2 list reads the B5 filters.
    const list = await get('finance_admin', `/platform/commercial/audit-events?event_type=COMMERCIAL_AUDIT_EXPORTED&product_key=sign`);
    expect(list.status).toBe(200);
    expect(list.body.events).toEqual([]);
  });
});
