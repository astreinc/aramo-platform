import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

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
  CommercialCatalogService,
  CommercialChangeRequestService,
  CommercialOperatorRepository,
  CommercialPolicyRepository,
  PlanVersionRepository,
  SubscriptionPrismaService,
} from '@aramo/subscription';

import { PlatformCommercialCatalogController } from '../app/platform/platform-commercial-catalog.controller.js';
import { PlatformCommercialChangeRequestController } from '../app/platform/platform-commercial-change-request.controller.js';
// eslint-disable-next-line @nx/enforce-module-boundaries -- test-only real-Postgres support shared with the CCP specs (TD-A3-19 precedent)
import { CCP_BUNDLES, TENANT_1, TENANT_2, addOperator, applyCcpCatalogSchema } from '../../../../libs/subscription/src/tests/support/ccp-a3-database.js';

import { generateTestKeyPair } from './test-keys.js';

// CCP-B2 (PBD §5.3 row B2: "Publish only through the chain; published versions read-only") —
// every /platform/commercial/catalog route, for each CCP role and super_admin, through the REAL
// guard chain AND the REAL CommercialCatalogService on real Postgres (identity RBAC +
// subscription chain + A2 + A3 + A4 + A5). The CHAIN test drives a publish and a retire
// end to end through the A3 change-request routes (catalog_manager → submit → finance_admin
// → platform_owner) and proves nothing publishes or retires: the request ends APPROVED and the
// catalog is unchanged until CCP-A6 applies it.

const ROLES = ['platform_owner', 'finance_admin', 'commercial_ops', 'catalog_manager', 'support_admin', 'read_only_auditor'] as const;
const CAT = '/platform/commercial/catalog';
const CR = '/platform/commercial/change-requests';
// The A1 catalog plan ids (migration 20261019140000) and the pre-catalog included plan.
const BUSINESS = '019a0000-5150-7000-8000-000000000011';
const PROFESSIONAL = '019a0000-5150-7000-8000-000000000012';
const ENTERPRISE = '019a0000-5150-7000-8000-000000000013';

class RoleBundleResolver implements EffectiveAuthorizationResolver {
  readonly roleOf = new Map<string, string>();
  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const role = this.roleOf.get(input.principal_id);
    const scopes = role === undefined ? [] : [...(CCP_BUNDLES[role] ?? [])];
    return { status: 'ok', scopes: filterScopesForConsumer({ consumer: input.consumer_type, scopes, tenantHasEsign: false }) };
  }
}

type Version = { id: string; version_number: number; status: string; content_checksum: string; pinned_subscriptions: number; open_requests: { id: string; action_type: string; state: string }[]; terms: Record<string, unknown> };
type Plan = { id: string; key: string; product_key: string; versions: Version[] };

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-B2 — catalog routes per role, published versions read-only, publish only through the chain (real guards + real services + real Postgres)', { timeout: 180_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: SubscriptionPrismaService;
  let versions: PlanVersionRepository;
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-b2-int';
  const saved: Record<string, string | undefined> = {};
  const resolver = new RoleBundleResolver();
  const user: Record<string, string> = {};
  let keyN = 0;
  const key = () => `b2-route-key-${String(++keyN).padStart(6, '0')}`;

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
  const http = () => request(app.getHttpServer());
  const get = async (role: string, path: string) => http().get(path).set('Authorization', `Bearer ${await token(role)}`);
  const post = async (role: string, path: string, body: object) => http().post(path).set('Authorization', `Bearer ${await token(role)}`).send(body);
  const patch = async (role: string, path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${await token(role)}`).send(body);
  const codeOf = (res: request.Response) => [res.status, res.body?.error?.code, res.body?.error?.details?.refusal ?? res.body?.error?.details?.reason ?? null];

  async function catalog(role = 'read_only_auditor'): Promise<Plan[]> {
    const res = await get(role, CAT);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.products.flatMap((p: { plans: Plan[] }) => p.plans);
  }
  const planOf = async (id: string): Promise<Plan> => (await catalog()).find((p) => p.id === id) as Plan;
  const v1Of = async (id: string): Promise<Version> => (await planOf(id)).versions.find((v) => v.version_number === 1) as Version;

  async function pinSubscription(tenant_id: string, plan_id: string, ended = false): Promise<void> {
    await pg.query(
      `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by, ended_at)
       VALUES ($1, $2, $3, (SELECT v.id FROM subscription."PlanVersion" v WHERE v.plan_id = $3::uuid AND v.status = 'PUBLISHED'), 'sign', 'BASE', now(), 'MANUAL', 'test', $4)`,
      [randomUUID(), tenant_id, plan_id, ended ? new Date() : null],
    );
  }

  async function draftOf(plan_id: string): Promise<Version> {
    const v1 = await v1Of(plan_id);
    const res = await post('catalog_manager', `${CAT}/plans/${plan_id}/drafts`, { from_version_id: v1.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.version as Version;
  }

  /** Creates and submits a catalog change request as catalog_manager. */
  async function requestCatalog(action_type: 'PLAN_VERSION_PUBLISH' | 'PLAN_RETIRE', plan_version_id: string): Promise<string> {
    const c = await post('catalog_manager', CR, { action_type, payload: { plan_version_id }, reason: 'Annual price review\n\nEvidence: Pricing review PR-2026-Q4', idempotency_key: key() });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const s = await post('catalog_manager', `${CR}/${c.body.request.id}/submit`, {});
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    return c.body.request.id as string;
  }

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
    versions = new PlanVersionRepository(prisma);
    const changeRequests = new CommercialChangeRequestService(prisma, audit, policies, operators);
    const catalogService = new CommercialCatalogService(prisma, versions, policies, audit, operators);
    const keys = generateTestKeyPair();
    privatePem = keys.privatePem;
    for (const k of ['AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY']) saved[k] = process.env[k];
    process.env['AUTH_AUDIENCE'] = audience;
    process.env['AUTH_PUBLIC_KEY'] = keys.publicPem;
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, AuthorizationModule],
      controllers: [PlatformCommercialCatalogController, PlatformCommercialChangeRequestController],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: resolver },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
        { provide: CommercialCatalogService, useValue: catalogService },
        { provide: CommercialChangeRequestService, useValue: changeRequests },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: never, res: never, next: () => void) => new RequestIdMiddleware().use(req, res, next));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    // Merge train TD-MERGE-41: one bound loopback port for the file (see support/ccp-d4-harness.ts).
    await app.listen(0, '127.0.0.1');
  }, 240_000);

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
    await applyCcpCatalogSchema(pg);
    resolver.roleOf.clear();
    for (const role of [...ROLES, 'super_admin']) {
      user[role] = await addOperator(pg, [role]);
      resolver.roleOf.set(user[role] as string, role);
    }
  }, 180_000);

  it('B2-RI-READ per role: the catalog and a version read → 200 for all 6 CCP roles; super_admin 403; the registry is sign only; every plan has its PUBLISHED v1; pin counts count open subscriptions', async () => {
    await pinSubscription(TENANT_1, BUSINESS);
    await pinSubscription(TENANT_2, BUSINESS);
    await pinSubscription(TENANT_2, PROFESSIONAL, true); // ended: not pinned
    for (const role of ROLES) {
      const res = await get(role, CAT);
      expect(res.status, role).toBe(200);
      expect(res.body.products.map((p: { product_key: string }) => p.product_key), role).toEqual(['sign']);
    }
    expect(codeOf(await get('super_admin', CAT))).toEqual([403, 'INSUFFICIENT_PERMISSIONS', null]);
    const plans = await catalog();
    expect(plans.length).toBe(5);
    for (const p of plans) {
      expect(p.product_key).toBe('sign');
      expect(p.versions.map((v) => [v.version_number, v.status])).toEqual([[1, 'PUBLISHED']]);
    }
    expect((await v1Of(BUSINESS)).pinned_subscriptions).toBe(2);
    expect((await v1Of(PROFESSIONAL)).pinned_subscriptions).toBe(0);
    const chain = (await get('finance_admin', CAT)).body.publish_chain;
    expect(chain).toMatchObject({ rule: 'FINANCE_THEN_OWNER', step_role_keys: ['finance_admin', 'platform_owner'], policy_version_number: 1, approval_expiry_hours: 72 });
    const v1 = await v1Of(BUSINESS);
    for (const role of ROLES) expect((await get(role, `${CAT}/versions/${v1.id}`)).status, role).toBe(200);
    expect((await get('super_admin', `${CAT}/versions/${v1.id}`)).status).toBe(403);
    const detail = (await get('commercial_ops', `${CAT}/versions/${v1.id}`)).body;
    expect(detail.pinned_tenants.map((t: { name: string }) => t.name)).toEqual(['Tenant One', 'Tenant Two']);
    expect(detail.version.terms).toMatchObject({ list_price_minor: 2000, currency: 'USD', billing_interval: 'MONTH', envelopes_unlimited: true, storage_bytes: 10737418240 });
    expect((await get('read_only_auditor', `${CAT}/versions/${randomUUID()}`)).status).toBe(404);
  });

  it('B2-RI-DRAFT per role: only catalog_manager creates a draft (201); the other 5 CCP roles and super_admin → 403 before the service; one DRAFT per plan; the source version must belong to the plan', async () => {
    const v1 = await v1Of(BUSINESS);
    for (const role of [...ROLES.filter((r) => r !== 'catalog_manager'), 'super_admin']) {
      const res = await post(role, `${CAT}/plans/${BUSINESS}/drafts`, { from_version_id: v1.id });
      expect(res.status, role).toBe(403);
      expect(res.body.error.details.missing_scopes, role).toEqual(['platform:catalog:draft']);
    }
    const draft = await draftOf(BUSINESS);
    expect([draft.version_number, draft.status]).toEqual([2, 'DRAFT']);
    expect(draft.content_checksum).toBe(v1.content_checksum); // a faithful copy
    expect(codeOf(await post('catalog_manager', `${CAT}/plans/${BUSINESS}/drafts`, { from_version_id: v1.id }))).toEqual([409, 'COMMERCIAL_CATALOG_CONFLICT', 'draft_exists']);
    const other = await v1Of(PROFESSIONAL);
    expect(codeOf(await post('catalog_manager', `${CAT}/plans/${BUSINESS}/drafts`, { from_version_id: other.id }))).toEqual([409, 'COMMERCIAL_CATALOG_CONFLICT', 'plan_mismatch']);
    // The published source is unchanged and still the plan's only PUBLISHED version.
    const after = await planOf(BUSINESS);
    expect(after.versions.map((v) => [v.version_number, v.status, v.content_checksum])).toEqual([
      [2, 'DRAFT', v1.content_checksum],
      [1, 'PUBLISHED', v1.content_checksum],
    ]);
    const ev = await pg.query(`SELECT event_type, actor_id, subject FROM subscription."CommercialAuditEvent" WHERE event_type LIKE 'COMMERCIAL_PLAN_VERSION_%'`);
    expect(ev.rows).toEqual([{ event_type: 'COMMERCIAL_PLAN_VERSION_DRAFTED', actor_id: user['catalog_manager'], subject: `plan_version:${draft.id}` }]);
  });

  it('B2-RI-IMMUTABLE published and retired versions are read-only: every edit is refused 409 not_draft and the content is unchanged; the DB trigger refuses a direct UPDATE too', async () => {
    const v1 = await v1Of(BUSINESS);
    const edits = [{ list_price_minor: 2500 }, { envelopes_per_month: 100 }, { storage_bytes: 1 }, {}];
    for (const e of edits) {
      expect(codeOf(await patch('catalog_manager', `${CAT}/versions/${v1.id}`, { expected_content_checksum: v1.content_checksum, ...e })), JSON.stringify(e)).toEqual([409, 'COMMERCIAL_CATALOG_CONFLICT', 'not_draft']);
    }
    for (const role of [...ROLES.filter((r) => r !== 'catalog_manager'), 'super_admin']) {
      expect((await patch(role, `${CAT}/versions/${v1.id}`, { expected_content_checksum: v1.content_checksum, list_price_minor: 1 })).status, role).toBe(403);
    }
    expect((await v1Of(BUSINESS)).content_checksum).toBe(v1.content_checksum);
    await expect(pg.query(`UPDATE subscription."PlanVersion" SET note = 'x' WHERE id = $1`, [v1.id])).rejects.toThrow();
    // RETIRED: a draft is published by the A6 apply path (simulated here with the repository;
    // the console has no route for it), which retires v1. v1 then refuses edits the same way.
    const draft = await draftOf(BUSINESS);
    await versions.publish(draft.id);
    const retired = await v1Of(BUSINESS);
    expect(retired.status).toBe('RETIRED');
    expect(codeOf(await patch('catalog_manager', `${CAT}/versions/${retired.id}`, { expected_content_checksum: retired.content_checksum, list_price_minor: 1 }))).toEqual([409, 'COMMERCIAL_CATALOG_CONFLICT', 'not_draft']);
    // And the now-PUBLISHED v2 is just as immutable.
    const v2 = (await planOf(BUSINESS)).versions.find((v) => v.version_number === 2) as Version;
    expect(codeOf(await patch('catalog_manager', `${CAT}/versions/${v2.id}`, { expected_content_checksum: v2.content_checksum, list_price_minor: 1 }))).toEqual([409, 'COMMERCIAL_CATALOG_CONFLICT', 'not_draft']);
  });

  it('B2-RI-EDIT a DRAFT edits price, envelopes and storage only; a stale checksum, a contract-priced price and a term the version lacks are refused; each edit is audited', async () => {
    const draft = await draftOf(BUSINESS);
    const ok = await patch('catalog_manager', `${CAT}/versions/${draft.id}`, { expected_content_checksum: draft.content_checksum, list_price_minor: 2400, envelopes_per_month: 750, storage_bytes: 53687091200 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.version.terms).toMatchObject({ list_price_minor: 2400, envelopes_per_month: 750, envelopes_unlimited: false, storage_bytes: 53687091200, currency: 'USD', billing_interval: 'MONTH' });
    expect(ok.body.version.content_checksum).not.toBe(draft.content_checksum);
    expect(codeOf(await patch('catalog_manager', `${CAT}/versions/${draft.id}`, { expected_content_checksum: draft.content_checksum, list_price_minor: 1 }))).toEqual([409, 'COMMERCIAL_CATALOG_CONFLICT', 'stale']);
    const unlimited = await patch('catalog_manager', `${CAT}/versions/${draft.id}`, { expected_content_checksum: ok.body.version.content_checksum, envelopes_per_month: null });
    expect(unlimited.body.version.terms).toMatchObject({ envelopes_per_month: null, envelopes_unlimited: true });
    const ent = await draftOf(ENTERPRISE);
    expect(codeOf(await patch('catalog_manager', `${CAT}/versions/${ent.id}`, { expected_content_checksum: ent.content_checksum, list_price_minor: 100 }))).toEqual([409, 'COMMERCIAL_CATALOG_CONFLICT', 'contract_priced']);
    expect(codeOf(await patch('catalog_manager', `${CAT}/versions/${ent.id}`, { expected_content_checksum: ent.content_checksum, envelopes_per_month: 100 }))).toEqual([409, 'COMMERCIAL_CATALOG_CONFLICT', 'term_missing']);
    // The plan identity and the v1 locks are never changed by an edit.
    const content = (await get('catalog_manager', `${CAT}/versions/${draft.id}`)).body.content;
    expect(content.plan).toMatchObject({ key: 'aramo-sign-standard-business-v1', product_key: 'sign', currency: 'USD', billing_interval: 'MONTH' });
    const ev = await pg.query(`SELECT event_type FROM subscription."CommercialAuditEvent" WHERE event_type LIKE 'COMMERCIAL_PLAN_VERSION_%' ORDER BY created_at, id`);
    expect(ev.rows.map((r: { event_type: string }) => r.event_type)).toEqual([
      'COMMERCIAL_PLAN_VERSION_DRAFTED',
      'COMMERCIAL_PLAN_VERSION_DRAFT_UPDATED',
      'COMMERCIAL_PLAN_VERSION_DRAFT_UPDATED',
      'COMMERCIAL_PLAN_VERSION_DRAFTED',
    ]);
  });

  it('B2-RI-CHAIN publish only through the chain: catalog_manager requests, Finance then Owner sign, the request ends APPROVED — and nothing is published by B2 (A6 applies)', async () => {
    const draft = await draftOf(BUSINESS);
    // Only catalog_manager may make a catalog request.
    for (const role of ROLES.filter((r) => r !== 'catalog_manager')) {
      const c = await post(role, CR, { action_type: 'PLAN_VERSION_PUBLISH', payload: { plan_version_id: draft.id }, reason: 'r', idempotency_key: key() });
      expect(codeOf(c), role).toEqual([403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing']);
    }
    const id = await requestCatalog('PLAN_VERSION_PUBLISH', draft.id);
    const detail = (await get('finance_admin', `${CR}/${id}`)).body;
    expect(detail.request.required_chain.rule).toBe('FINANCE_THEN_OWNER');
    expect(detail.request.required_chain.steps.map((s: { role_key: string }) => s.role_key)).toEqual(['finance_admin', 'platform_owner']);
    // The catalog shows the open request on the draft (the console disables a second request).
    expect((await planOf(BUSINESS)).versions.find((v) => v.id === draft.id)?.open_requests).toEqual([{ id, action_type: 'PLAN_VERSION_PUBLISH', state: 'PENDING_APPROVAL', expires_at: expect.any(String) }]);
    // Out of order and the wrong people are refused.
    expect(codeOf(await post('platform_owner', `${CR}/${id}/approvals`, { step_index: 0 }))).toEqual([409, 'COMMERCIAL_APPROVAL_REFUSED', 'OUT_OF_ORDER']);
    expect(codeOf(await post('read_only_auditor', `${CR}/${id}/approvals`, { step_index: 0 }))).toEqual([409, 'COMMERCIAL_APPROVAL_REFUSED', 'STEP_SCOPE_MISSING']);
    expect(codeOf(await post('catalog_manager', `${CR}/${id}/approvals`, { step_index: 0 }))).toEqual([409, 'COMMERCIAL_APPROVAL_REFUSED', 'SELF_APPROVAL']);
    expect((await post('finance_admin', `${CR}/${id}/approvals`, { step_index: 0 })).status).toBe(201);
    expect(codeOf(await post('finance_admin', `${CR}/${id}/approvals`, { step_index: 1 }))).toEqual([409, 'COMMERCIAL_APPROVAL_REFUSED', 'USER_ALREADY_APPROVED']);
    const owner = await post('platform_owner', `${CR}/${id}/approvals`, { step_index: 1 });
    expect(owner.status, JSON.stringify(owner.body)).toBe(201);
    expect(owner.body.request.state).toBe('APPROVED');
    // B2 never applies: the draft is still a DRAFT and v1 is still the PUBLISHED version.
    const plan = await planOf(BUSINESS);
    expect(plan.versions.map((v) => [v.version_number, v.status])).toEqual([[2, 'DRAFT'], [1, 'PUBLISHED']]);
    expect(plan.versions[0]?.open_requests.map((r) => r.state)).toEqual(['APPROVED']);
    const pv = await pg.query(`SELECT status FROM subscription."PlanVersion" WHERE id = $1`, [draft.id]);
    expect(pv.rows[0].status).toBe('DRAFT');
  });

  it('B2-RI-RETIRE retire uses the catalog-publish chain (TD-A3-2: Finance → Owner); the version stays PUBLISHED until applied; grandfathered pins are kept across a later publish', async () => {
    await pinSubscription(TENANT_1, PROFESSIONAL);
    const v1 = await v1Of(PROFESSIONAL);
    const id = await requestCatalog('PLAN_RETIRE', v1.id);
    const detail = (await get('platform_owner', `${CR}/${id}`)).body;
    expect(detail.request.required_chain.steps.map((s: { role_key: string }) => s.role_key)).toEqual(['finance_admin', 'platform_owner']);
    expect((await v1Of(PROFESSIONAL)).status).toBe('PUBLISHED');
    // Grandfathering view: after A6 publishes a v2 (simulated), the subscriber stays on v1.
    const draft = await draftOf(PROFESSIONAL);
    await versions.publish(draft.id);
    const plan = await planOf(PROFESSIONAL);
    expect(plan.versions.map((v) => [v.version_number, v.status, v.pinned_subscriptions])).toEqual([
      [2, 'PUBLISHED', 0],
      [1, 'RETIRED', 1],
    ]);
    const pinned = (await get('read_only_auditor', `${CAT}/versions/${v1.id}`)).body.pinned_tenants;
    expect(pinned).toEqual([{ tenant_id: TENANT_1, name: 'Tenant One' }]);
  });
});
