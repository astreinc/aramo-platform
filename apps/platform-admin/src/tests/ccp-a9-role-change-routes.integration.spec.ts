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
// eslint-disable-next-line @nx/enforce-module-boundaries -- test-only real-Postgres support shared with the libs/subscription A3/A9 specs
import { CCP_BUNDLES, POLICY_V1, addOperator, revokeRole } from '../../../../libs/subscription/src/tests/support/ccp-a3-database.js';
// eslint-disable-next-line @nx/enforce-module-boundaries -- test-only real-Postgres support shared with the libs/subscription A9 spec
import { applyCcpA9Schema } from '../../../../libs/subscription/src/tests/support/ccp-a9-database.js';

import { generateTestKeyPair } from './test-keys.js';

// CCP-A9 (PBD §5.1 row A9, mandatory tests: per-role allowed/refused, super_admin refused) —
// the governed role-change endpoint (POST /platform/commercial/change-requests with
// ROLE_GRANT / ROLE_REVOKE; pre-execution C-3) and POLICY_ACTIVATE, through the REAL guard
// chain and the REAL service on real Postgres (identity chain with the A9 last-owner
// trigger + subscription chain + A2 + A3 + A9).

const ROLES = ['platform_owner', 'finance_admin', 'commercial_ops', 'catalog_manager', 'support_admin', 'read_only_auditor'] as const;
const BASE = '/platform/commercial/change-requests';
const V2 = '019a0000-0000-7000-8000-0000000cc2a2';

class RoleBundleResolver implements EffectiveAuthorizationResolver {
  readonly roleOf = new Map<string, string>();
  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const role = this.roleOf.get(input.principal_id);
    const scopes = role === undefined ? [] : [...(CCP_BUNDLES[role] ?? [])];
    return { status: 'ok', scopes: filterScopesForConsumer({ consumer: input.consumer_type, scopes, tenantHasEsign: false }) };
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-A9 — governed role change + POLICY_ACTIVATE per role (real guards + real service + real Postgres)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: SubscriptionPrismaService;
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-a9-int';
  const saved: Record<string, string | undefined> = {};
  const resolver = new RoleBundleResolver();
  const user: Record<string, string> = {};
  let keyN = 0;
  const key = () => `a9-route-key-${String(++keyN).padStart(6, '0')}`;

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
  const post = async (who: string, path: string, body: object) => request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${await token(who)}`).send(body);
  const createAs = async (who: string, body: object) => post(who, BASE, { reason: 'a9 route test', idempotency_key: key(), ...body });
  const refusalOf = (res: request.Response) => [res.status, res.body?.error?.code, res.body?.error?.details?.refusal ?? res.body?.error?.details?.reason ?? null];
  const grant = (subject: string, role_key = 'finance_admin') => ({ action_type: 'ROLE_GRANT', payload: { subject_user_id: user[subject], role_key } });
  async function pendingGrant(subject = 'subject', role_key = 'finance_admin'): Promise<string> {
    const c = await createAs('platform_owner', grant(subject, role_key));
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect((await post('platform_owner', `${BASE}/${c.body.request.id}/submit`, {})).status).toBe(200);
    return c.body.request.id as string;
  }
  const rolesOf = async (who: string): Promise<string[]> =>
    (
      await pg.query(
        `SELECT r.key FROM identity."UserTenantMembershipRole" mr JOIN identity."UserTenantMembership" m ON m.id = mr.membership_id JOIN identity."Role" r ON r.id = mr.role_id WHERE m.user_id = $1 ORDER BY r.key`,
        [user[who]],
      )
    ).rows.map((r) => r.key as string);

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
    // Merge train TD-MERGE-41: one bound loopback port for the file (see support/ccp-d4-harness.ts).
    await app.listen(0, '127.0.0.1');
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
    await applyCcpA9Schema(pg);
    resolver.roleOf.clear();
    for (const role of [...ROLES, 'super_admin']) {
      user[role] = await addOperator(pg, [role]);
      resolver.roleOf.set(user[role] as string, role);
    }
    // A second, distinct platform_owner (the checker) and a role-change subject (an existing
    // platform admin holding no CCP role; attested).
    user['owner_2'] = await addOperator(pg, ['platform_owner']);
    resolver.roleOf.set(user['owner_2'] as string, 'platform_owner');
    user['subject'] = await addOperator(pg, []);
    await pg.query(`INSERT INTO subscription."CommercialPolicyVersion" (id, version_number, status, content, content_checksum) SELECT $1, 2, 'DRAFT', content, content_checksum FROM subscription."CommercialPolicyVersion" WHERE id = $2`, [V2, POLICY_V1]);
  }, 120_000);

  it('A9-RI-CREATE per role: ROLE_GRANT and ROLE_REVOKE only platform_owner (201); POLICY_ACTIVATE only finance_admin (201); every other role 403 requester_role_missing; super_admin refused at the gate', async () => {
    const bodies = {
      ROLE_GRANT: grant('subject', 'support_admin'),
      ROLE_REVOKE: { action_type: 'ROLE_REVOKE', payload: { subject_user_id: user['catalog_manager'], role_key: 'catalog_manager' } },
      POLICY_ACTIVATE: { action_type: 'POLICY_ACTIVATE', payload: { policy_version_id: V2 } },
    } as const;
    const requester = { ROLE_GRANT: 'platform_owner', ROLE_REVOKE: 'platform_owner', POLICY_ACTIVATE: 'finance_admin' } as const;
    for (const [action, body] of Object.entries(bodies) as Array<[keyof typeof bodies, object]>) {
      const out: Record<string, unknown[]> = {};
      for (const who of [...ROLES, 'super_admin']) out[who] = refusalOf(await createAs(who, body));
      const expected: Record<string, unknown[]> = {};
      for (const who of ROLES) expected[who] = who === requester[action] ? [201, undefined, null] : [403, 'INSUFFICIENT_PERMISSIONS', 'requester_role_missing'];
      expected['super_admin'] = [403, 'INSUFFICIENT_PERMISSIONS', null];
      expect(out, action).toEqual(expected);
    }
  });

  it('A9-RI-APPROVE per role on a ROLE_GRANT: only a DISTINCT platform_owner → 201 and the grant applies (state APPLIED, apply.applied); the requesting owner SELF_APPROVAL; the 5 other roles STEP_SCOPE_MISSING; super_admin 403', async () => {
    const id = await pendingGrant();
    const out: Record<string, unknown[]> = {};
    for (const who of [...ROLES, 'super_admin']) out[who] = refusalOf(await post(who, `${BASE}/${id}/approvals`, { step_index: 0 }));
    expect(out).toEqual({
      platform_owner: [409, 'COMMERCIAL_APPROVAL_REFUSED', 'SELF_APPROVAL'],
      finance_admin: [409, 'COMMERCIAL_APPROVAL_REFUSED', 'STEP_SCOPE_MISSING'],
      commercial_ops: [409, 'COMMERCIAL_APPROVAL_REFUSED', 'STEP_SCOPE_MISSING'],
      catalog_manager: [409, 'COMMERCIAL_APPROVAL_REFUSED', 'STEP_SCOPE_MISSING'],
      support_admin: [409, 'COMMERCIAL_APPROVAL_REFUSED', 'STEP_SCOPE_MISSING'],
      read_only_auditor: [409, 'COMMERCIAL_APPROVAL_REFUSED', 'STEP_SCOPE_MISSING'],
      super_admin: [403, 'INSUFFICIENT_PERMISSIONS', null],
    });
    expect(await rolesOf('subject')).toEqual([]);
    const done = await post('owner_2', `${BASE}/${id}/approvals`, { step_index: 0 });
    expect(done.status).toBe(201);
    expect(done.body.request).toMatchObject({ state: 'APPLIED', action_type: 'ROLE_GRANT' });
    expect(typeof done.body.request.applied_at).toBe('string');
    expect(done.body.apply).toEqual({ applied: true, reason: null, detail: {} });
    expect(await rolesOf('subject')).toEqual(['finance_admin']);
  });

  it('A9-RI-SUBJECT the subject of a role change cannot approve it even when they hold platform_owner (SELF_APPROVAL)', async () => {
    const id = await pendingGrant('owner_2', 'finance_admin');
    expect(refusalOf(await post('owner_2', `${BASE}/${id}/approvals`, { step_index: 0 }))).toEqual([409, 'CCP_NOT_BOOTSTRAPPED', null]);
    const third = await addOperator(pg, ['platform_owner']);
    user['owner_3'] = third;
    resolver.roleOf.set(third, 'platform_owner');
    expect(refusalOf(await post('owner_2', `${BASE}/${id}/approvals`, { step_index: 0 }))).toEqual([409, 'COMMERCIAL_APPROVAL_REFUSED', 'SELF_APPROVAL']);
    expect((await post('owner_3', `${BASE}/${id}/approvals`, { step_index: 0 })).body.request.state).toBe('APPLIED');
  });

  it('A9-RI-BOOT before the chain is satisfiable (the only other owner gone) → 409 CCP_NOT_BOOTSTRAPPED naming the action type and the chain', async () => {
    const id = await pendingGrant();
    await revokeRole(pg, user['owner_2'] as string, 'platform_owner');
    const res = await post('finance_admin', `${BASE}/${id}/approvals`, { step_index: 0 });
    expect(refusalOf(res)).toEqual([409, 'CCP_NOT_BOOTSTRAPPED', null]);
    expect(res.body.error.details).toMatchObject({ action_type: 'ROLE_GRANT', chain_rule: 'DISTINCT_PLATFORM_OWNER', unfillable_steps: [0] });
  });

  it('A9-RI-LAST revoking the last effective platform_owner is refused 409 PLATFORM_LAST_OWNER', async () => {
    await revokeRole(pg, user['owner_2'] as string, 'platform_owner');
    const res = await createAs('platform_owner', { action_type: 'ROLE_REVOKE', payload: { subject_user_id: user['platform_owner'], role_key: 'platform_owner' } });
    expect(refusalOf(res)).toEqual([409, 'PLATFORM_LAST_OWNER', 'platform_last_owner']);
  });

  it('A9-RI-400 the role-change payload is validated: super_admin is not grantable; unknown keys are refused', async () => {
    expect(refusalOf(await createAs('platform_owner', grant('subject', 'super_admin')))).toEqual([400, 'VALIDATION_ERROR', 'invalid_payload']);
    expect(refusalOf(await createAs('platform_owner', { action_type: 'ROLE_GRANT', payload: { subject_user_id: user['subject'], role_key: 'finance_admin', email: 'x@aramo.ai' } }))).toEqual([
      400,
      'VALIDATION_ERROR',
      'invalid_payload',
    ]);
  });
});
