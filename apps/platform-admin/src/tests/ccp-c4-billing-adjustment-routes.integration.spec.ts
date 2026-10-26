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
import { BillingCommandService, BillingWebhookInboxService, CommercialBillingAdjustmentService, CommercialChangeRequestService, CommercialRefundReportService, SubscriptionPrismaService } from '@aramo/subscription';

import { PlatformCommercialBillingAdjustmentController } from '../app/platform/platform-commercial-billing-adjustment.controller.js';
import { PlatformCommercialBillingController } from '../app/platform/platform-commercial-billing.controller.js';
import { PlatformCommercialChangeRequestController } from '../app/platform/platform-commercial-change-request.controller.js';
import { PlatformCommercialRefundReportController } from '../app/platform/platform-commercial-refund-report.controller.js';
// eslint-disable-next-line @nx/enforce-module-boundaries -- test-only real-Postgres support shared with the libs/subscription CCP specs (TD-A3-19 precedent)
import { CCP_BUNDLES, addOperator, applyCcpA6Schema } from '../../../../libs/subscription/src/tests/support/ccp-a3-database.js';
// eslint-disable-next-line @nx/enforce-module-boundaries -- test-only: the one shared C4 harness (fake Stripe, no network, no key)
import { c4Harness, refundPayload, type C4Harness } from '../../../../libs/subscription/src/tests/support/ccp-c4.js';
// eslint-disable-next-line @nx/enforce-module-boundaries -- test-only: the one shared CCP-DG policy helper
import { TEST_REFUND_KEYS, activatePolicyContent, reactivatePolicy, v1With } from '../../../../libs/subscription/src/tests/support/ccp-dg.js';

import { generateTestKeyPair } from './test-keys.js';

// CCP-C4 (PBD §5.2 row C4, §10) — POST and GET /platform/commercial/change-requests/{id}/billing-adjustment
// per role (the 6 CCP roles + super_admin, one role per principal), through the REAL guard chain and the
// REAL services on real Postgres. Stripe is a fake (no network, no key). Also: the Finance amount
// interim on the C4 routes and on the C1 billing-commands read of a C4 command; the refund designed
// disabled state as a stable 409.

const ROLES = ['platform_owner', 'finance_admin', 'commercial_ops', 'catalog_manager', 'support_admin', 'read_only_auditor'] as const;
const BASE = '/platform/commercial/change-requests';
const BUSINESS = 'aramo-sign-standard-business-v1';

class RoleBundleResolver implements EffectiveAuthorizationResolver {
  readonly roleOf = new Map<string, string>();
  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const role = this.roleOf.get(input.principal_id);
    // Merge train TD-C4P-6: the bundles are the integrated CCP_BUNDLES, which carry CCP-R3's seeded
    // grant of platform:billing:amount:read (platform_owner, finance_admin, read_only_auditor).
    const scopes = role === undefined ? [] : [...(CCP_BUNDLES[role] ?? [])];
    return { status: 'ok', scopes: filterScopesForConsumer({ consumer: input.consumer_type, scopes, tenantHasEsign: false }) };
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-C4 — the billing-adjustment routes per role (real guards + real services + real Postgres)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: SubscriptionPrismaService;
  let app: INestApplication;
  let h: C4Harness;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-c4-int';
  const saved: Record<string, string | undefined> = {};
  const resolver = new RoleBundleResolver();
  const user: Record<string, string> = {};
  let keyN = 0;
  let RELEASED: string;
  const key = () => `c4-route-key-${String(++keyN).padStart(6, '0')}`;

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

  async function selfService(): Promise<{ t: string; ss: string }> {
    const t = (await pg.query(`INSERT INTO identity."Tenant" (id, name, kind, updated_at) VALUES (gen_random_uuid(), 'C4 route', 'BUSINESS', now()) RETURNING id`)).rows[0].id as string;
    const ss = randomUUID();
    await pg.query(
      `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by, billing_provider, billing_account_ref, billing_subscription_ref)
       SELECT $1::uuid, $2::uuid, p.id, (SELECT v.id FROM subscription."PlanVersion" v WHERE v.plan_id = p.id AND v.status = 'PUBLISHED'), 'sign', 'BASE', now(), 'SELF_SERVICE', 'c4-route', 'STRIPE', $3, $4 FROM subscription."Plan" p WHERE p.key = $5`,
      [ss, t, `acct_${t}`, `sub_${ss}`, BUSINESS],
    );
    return { t, ss };
  }
  /** Created by commercial_ops, submitted and approved through the whole chain (Finance; Owner when escalated). */
  async function approved(action: 'CREDIT' | 'DISCOUNT' | 'REFUND', t: string, payload: Record<string, unknown>): Promise<string> {
    const c = await post('commercial_ops', BASE, { action_type: action, tenant_id: t, product_key: 'sign', payload, reason: 'c4 route test', idempotency_key: key() });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const id = c.body.request.id as string;
    expect((await post('commercial_ops', `${BASE}/${id}/submit`)).status).toBe(200);
    const a = await post('finance_admin', `${BASE}/${id}/approvals`, { step_index: 0 });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    if (a.body.request.state !== 'APPROVED') expect((await post('platform_owner', `${BASE}/${id}/approvals`, { step_index: 1 })).status).toBe(201);
    return id;
  }

  beforeAll(async () => {
    delete process.env['CCP_REFUND_EXECUTION_ENABLED'];
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    await applyCcpA6Schema(pg);
    // CCP-DG (Charter Amendment A2): the ACTIVE policy declares the test refund keys (gate 2 approved),
    // so the switch (gate 1) decides; DG-RI-1 revokes it.
    RELEASED = await activatePolicyContent(pg, v1With(TEST_REFUND_KEYS));
    prisma = new SubscriptionPrismaService(url);
    await prisma.$connect();
    h = c4Harness(prisma, () => new Date());
    const keys = generateTestKeyPair();
    privatePem = keys.privatePem;
    for (const k of ['AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY']) saved[k] = process.env[k];
    process.env['AUTH_AUDIENCE'] = audience;
    process.env['AUTH_PUBLIC_KEY'] = keys.publicPem;
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, AuthorizationModule],
      controllers: [PlatformCommercialChangeRequestController, PlatformCommercialBillingAdjustmentController, PlatformCommercialBillingController, PlatformCommercialRefundReportController],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: resolver },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
        { provide: CommercialChangeRequestService, useValue: h.changeRequests },
        { provide: CommercialBillingAdjustmentService, useValue: h.adjustments },
        { provide: BillingCommandService, useValue: h.commands },
        { provide: BillingWebhookInboxService, useValue: h.inbox },
        { provide: CommercialRefundReportService, useValue: new CommercialRefundReportService(prisma) },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: never, res: never, next: () => void) => new RequestIdMiddleware().use(req, res, next));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    // Merge train TD-MERGE-41: one bound loopback port for the file (see support/ccp-d4-harness.ts).
    await app.listen(0, '127.0.0.1');
    for (const role of [...ROLES, 'super_admin']) {
      user[role] = await addOperator(pg, [role]);
      resolver.roleOf.set(user[role] as string, role);
    }
    user['commercial_ops_2'] = await addOperator(pg, ['commercial_ops']);
    resolver.roleOf.set(user['commercial_ops_2'] as string, 'commercial_ops');
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

  it('C4-RI-1 POST …/billing-adjustment per role: only the REQUESTER (commercial_ops) applies — 200 PENDING_PROVIDER with ONE command and no amount in the response; every other CCP role 403 requester_scope_missing; another commercial_ops 403 not_requester; super_admin refused at the gate; a replay is 200 replayed', async () => {
    const { t, ss } = await selfService();
    const id = await approved('CREDIT', t, { amount_minor: 35_000, currency: 'USD', subscription_id: ss });
    const results: Record<string, unknown[]> = {};
    for (const role of ['platform_owner', 'finance_admin', 'catalog_manager', 'support_admin', 'read_only_auditor', 'commercial_ops_2', 'super_admin']) results[role] = out(await post(role, `${BASE}/${id}/billing-adjustment`));
    expect(results).toEqual({
      platform_owner: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      finance_admin: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      catalog_manager: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      support_admin: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      read_only_auditor: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      commercial_ops_2: [403, 'INSUFFICIENT_PERMISSIONS', 'not_requester'],
      super_admin: [403, 'INSUFFICIENT_PERMISSIONS', null],
    });
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."BillingProviderCommand" WHERE change_request_id = $1`, [id])).rows[0].n).toBe(0);
    const ok = await post('commercial_ops', `${BASE}/${id}/billing-adjustment`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({
      replayed: false,
      request: { id, state: 'APPLYING', payload: { currency: 'USD', subscription_id: ss, amount_withheld: 'FINANCE_SCOPE_REQUIRED' }, required_chain: { rule: 'FINANCE_ONLY', basis: { amount_withheld: 'FINANCE_SCOPE_REQUIRED' } } },
      adjustment: { operation: 'CREDIT_GRANT', status: 'PENDING_PROVIDER', pending_provider: true, refund_execution_disabled: false, record: null, commands: [{ command_kind: 'CREDIT_GRANT', state: 'PENDING', pending_provider: true, params: { subscription_id: ss, currency: 'USD', amount_withheld: 'FINANCE_SCOPE_REQUIRED' } }] },
    });
    // CCP-R3 (merge train TD-MERGE-43): the requester commercial_ops does not hold
    // platform:billing:amount:read, so no tenant-specific amount is anywhere in its body.
    expect(JSON.stringify(ok.body)).not.toContain('35000');
    expect((await post('commercial_ops', `${BASE}/${id}/billing-adjustment`)).body).toMatchObject({ replayed: true });
    // The C1 billing-commands read: the C4 command's amount only for a Finance amount scope holder.
    const cmds = await get('finance_admin', `/platform/commercial/billing-commands?change_request_id=${id}`);
    expect(cmds.status).toBe(200);
    expect(cmds.body.commands[0].params).toEqual({ subscription_id: ss, currency: 'USD', amount_minor: 35_000 });
    for (const role of ['commercial_ops', 'support_admin']) {
      const other = await get(role, `/platform/commercial/billing-commands?change_request_id=${id}`);
      expect(other.body.commands[0].params, role).toEqual({ subscription_id: ss, currency: 'USD', amount_withheld: 'FINANCE_SCOPE_REQUIRED' });
      expect(JSON.stringify(other.body), role).not.toContain('35000');
    }
    // The holder's read of the adjustment carries the amount on the payload, basis and command.
    const held = await get('finance_admin', `${BASE}/${id}/billing-adjustment`);
    expect(held.body).toMatchObject({ request: { payload: { amount_minor: 35_000 } }, adjustment: { commands: [{ params: { amount_minor: 35_000 } }] } });
    expect(JSON.stringify(held.body)).not.toContain('amount_withheld');
  });

  it('C4-RI-2 GET …/billing-adjustment per role: the 6 CCP roles 200 (read-only, amounts withheld); super_admin 403 at the gate; tenant tier 403; malformed id 400; unknown id 404; not a billing adjustment 409 action_not_applicable', async () => {
    const { t } = await selfService();
    const id = await approved('DISCOUNT', t, { discount_bps: 2_000 });
    for (const role of ROLES) {
      const r = await get(role, `${BASE}/${id}/billing-adjustment`);
      expect(r.status, role).toBe(200);
      expect(r.body, role).toMatchObject({ request: { id, state: 'APPROVED', payload: { discount_bps: 2_000 }, required_chain: { rule: 'FINANCE_THEN_OWNER' } }, adjustment: { operation: 'DISCOUNT_APPLY', status: 'NOT_APPLIED', pending_provider: false, commands: [], record: null } });
    }
    expect(out(await get('super_admin', `${BASE}/${id}/billing-adjustment`))).toEqual([403, 'INSUFFICIENT_PERMISSIONS', null]);
    expect((await get('commercial_ops', `${BASE}/${id}/billing-adjustment`, 'recruiter')).status).toBe(403);
    expect((await get('commercial_ops', `${BASE}/not-a-uuid/billing-adjustment`)).status).toBe(400);
    expect(out(await get('commercial_ops', `${BASE}/${randomUUID()}/billing-adjustment`))).toEqual([404, 'NOT_FOUND', null]);
    const end = await post('commercial_ops', BASE, { action_type: 'SUBSCRIPTION_END', tenant_id: (await selfService()).t, product_key: 'sign', payload: { subscription_id: randomUUID() }, reason: 'x', idempotency_key: key() });
    expect(out(await get('commercial_ops', `${BASE}/${end.body.request.id}/billing-adjustment`))).toEqual([409, 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', 'action_not_applicable']);
    expect(out(await post('commercial_ops', `${BASE}/${end.body.request.id}/billing-adjustment`))).toEqual([409, 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', 'action_not_applicable']);
  });

  it('C4-RI-3 the refund designed disabled state: an approved REFUND → 409 apply_refused REFUND_EXECUTION_NOT_RELEASED (CCP-DG gate 1: the switch is off) with an explanation; the request stays APPROVED; no command; the read says refund_execution_disabled', async () => {
    const { t } = await selfService();
    h.billing.invoices.set('in_c4route', { account_ref: `acct_${t}` });
    const id = await approved('REFUND', t, refundPayload(4_000, 'in_c4route'));
    const res = await post('commercial_ops', `${BASE}/${id}/billing-adjustment`);
    expect(out(res)).toEqual([409, 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', 'REFUND_EXECUTION_NOT_RELEASED']);
    expect(res.body.error.details).toMatchObject({ gate_1_released: false, gate_2: 'APPROVED' });
    expect(res.body.error.details.explanation).toMatch(/refund execution has not been released/);
    // CCP-R3: read_only_auditor holds the Finance amount scope (the REFUND amount is shown); the
    // REFUND identity fields stay visible to every reader; support_admin gets the marker, no amount.
    const r = await get('read_only_auditor', `${BASE}/${id}/billing-adjustment`);
    expect(r.body).toMatchObject({ request: { state: 'APPROVED', payload: { amount_minor: 4_000, provider_invoice_ref: 'in_c4route' } }, adjustment: { operation: 'REFUND_CREATE', refund_execution_disabled: true, commands: [] } });
    const nr = await get('support_admin', `${BASE}/${id}/billing-adjustment`);
    expect(nr.body).toMatchObject({ request: { state: 'APPROVED', payload: { amount_withheld: 'FINANCE_SCOPE_REQUIRED', provider_invoice_ref: 'in_c4route' } }, adjustment: { operation: 'REFUND_CREATE', refund_execution_disabled: true, commands: [] } });
    expect(JSON.stringify(nr.body)).not.toContain('4000');
  });

  it('DG-RI-1 (CCP-DG, Charter Amendment A2) gate 2 over HTTP: the switch ON but the ACTIVE policy revoked (refund_execution_enabled false) → 409 apply_refused REFUND_POLICY_NOT_APPROVED with both gate outcomes, nothing sent; RX-8: a REFUND naming another refund policy than the ACTIVE one → 400 refund_policy_ref_mismatch', async () => {
    const { t } = await selfService();
    h.billing.invoices.set('in_dgroute', { account_ref: `acct_${t}` });
    const id = await approved('REFUND', t, refundPayload(4_000, 'in_dgroute'));
    const mismatch = await post('commercial_ops', BASE, { action_type: 'REFUND', tenant_id: (await selfService()).t, product_key: 'sign', payload: refundPayload(1, 'in_dgroute', { refund_policy_ref: 'ARAMO-COM-REFUND-POL-999@9.9' }), reason: 'dg', idempotency_key: key() });
    expect(out(mismatch)).toEqual([400, 'VALIDATION_ERROR', 'refund_policy_ref_mismatch']);
    expect(mismatch.body.error.details.codes).toEqual(['REFUND_POLICY_REF_MISMATCH']);
    const calls = h.billing.adjustmentCalls.length;
    const revoked = await activatePolicyContent(pg, v1With({ ...TEST_REFUND_KEYS, refund_execution_enabled: false }));
    process.env['CCP_REFUND_EXECUTION_ENABLED'] = '1';
    try {
      const res = await post('commercial_ops', `${BASE}/${id}/billing-adjustment`);
      expect(out(res)).toEqual([409, 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', 'REFUND_POLICY_NOT_APPROVED']);
      expect(res.body.error.details).toMatchObject({ gate_1_released: true, gate_2: 'ACTIVE_POLICY_NOT_ENABLED' });
      expect(res.body.error.details.explanation).toMatch(/refund policy has not been approved/);
      expect((await get('commercial_ops', `${BASE}/${id}/billing-adjustment`)).body).toMatchObject({ request: { state: 'APPROVED' }, adjustment: { refund_execution_disabled: true, commands: [] } });
    } finally {
      delete process.env['CCP_REFUND_EXECUTION_ENABLED'];
      await reactivatePolicy(pg, RELEASED);
    }
    expect(revoked).not.toBe(RELEASED);
    expect(h.billing.adjustmentCalls.length - calls).toBe(0);
  });

  it('C4-RI-4 a pre-command failure → 409 apply_failed (APPLY_FAILED, retryable): a tenant without a self-service subscription', async () => {
    const t = (await pg.query(`INSERT INTO identity."Tenant" (id, name, kind, updated_at) VALUES (gen_random_uuid(), 'C4 route none', 'BUSINESS', now()) RETURNING id`)).rows[0].id as string;
    const id = await approved('CREDIT', t, { amount_minor: 10, currency: 'USD' });
    expect(out(await post('commercial_ops', `${BASE}/${id}/billing-adjustment`))).toEqual([409, 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', 'TARGET_NOT_FOUND']);
    expect((await get('commercial_ops', `${BASE}/${id}/billing-adjustment`)).body).toMatchObject({ request: { state: 'APPLY_FAILED' }, adjustment: { status: 'APPLY_FAILED' } });
  });

  it('C4-RI-5 (CCP-C4-R) POST …/billing-adjustment/resolve per role: only the requester; an APPROVED refund is 409 NOT_RESOLVABLE; a refund sent nowhere (FAILED before any provider write, flag then off) is resolved 200 RESOLVED_NOT_EXECUTED (WITHDRAWN) and the slot is released; a non-REFUND is 409 action_not_applicable', async () => {
    const { t } = await selfService();
    h.billing.invoices.set('in_c4routeres', { account_ref: `acct_${t}` });
    const id = await approved('REFUND', t, refundPayload(30_000, 'in_c4routeres'));
    const path = `${BASE}/${id}/billing-adjustment/resolve`;
    expect(out(await post('commercial_ops', path))).toEqual([409, 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', 'NOT_RESOLVABLE']);
    process.env['CCP_REFUND_EXECUTION_ENABLED'] = '1';
    try {
      expect((await post('commercial_ops', `${BASE}/${id}/billing-adjustment`)).status).toBe(200);
      const [cmd] = await h.commands.forChangeRequest(id);
      h.billing.adjustmentFailures.set(cmd!.id, { kind: 'refused', times: 1 }); // refused by the provider: nothing created
      await h.commands.dispatchDue(new Date());
    } finally {
      delete process.env['CCP_REFUND_EXECUTION_ENABLED'];
    }
    const results: Record<string, unknown[]> = {};
    for (const role of ['platform_owner', 'finance_admin', 'catalog_manager', 'support_admin', 'read_only_auditor', 'commercial_ops_2', 'super_admin']) results[role] = out(await post(role, path));
    expect(results).toEqual({
      platform_owner: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      finance_admin: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      catalog_manager: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      support_admin: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      read_only_auditor: [403, 'INSUFFICIENT_PERMISSIONS', 'requester_scope_missing'],
      commercial_ops_2: [403, 'INSUFFICIENT_PERMISSIONS', 'not_requester'],
      super_admin: [403, 'INSUFFICIENT_PERMISSIONS', null],
    });
    const ok = await post('commercial_ops', path);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ resolution: 'RESOLVED_NOT_EXECUTED', outcomes: ['NOT_FOUND'], request: { id, state: 'WITHDRAWN', payload: { amount_withheld: 'FINANCE_SCOPE_REQUIRED' } }, adjustment: { status: 'RESOLVED_NOT_EXECUTED', record: null } });
    expect(JSON.stringify(ok.body)).not.toContain('30000');
    expect((await post('commercial_ops', BASE, { action_type: 'REFUND', tenant_id: t, product_key: 'sign', payload: refundPayload(1, 'in_c4routeres'), reason: 'after resolution', idempotency_key: key() })).status).toBe(201);
    const { t: t2 } = await selfService();
    const credit = await approved('CREDIT', t2, { amount_minor: 10, currency: 'USD' });
    expect(out(await post('commercial_ops', `${BASE}/${credit}/billing-adjustment/resolve`))).toEqual([409, 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', 'action_not_applicable']);
  });

  it('C4P-RI-1 GET /platform/commercial/finance/refunds per role: the five platform:billing:read roles 200, catalog_manager and super_admin 403, tenant tier 403; the amount only with platform:billing:amount:read (FAS holders), otherwise amount_withheld FINANCE_SCOPE_REQUIRED; no amount anywhere in a non-holder body', async () => {
    const { t } = await selfService();
    h.billing.invoices.set('in_c4report', { account_ref: `acct_${t}` });
    const id = await approved('REFUND', t, refundPayload(4_321, 'in_c4report'));
    const path = `/platform/commercial/finance/refunds?tenant_id=${t}`;
    // TD-C4P-6: R3's shared amountAccess, against the integrated bundles (the seeded grant).
    for (const role of ['commercial_ops', 'support_admin']) {
      const r = await get(role, path);
      expect(r.status, role).toBe(200);
      // CCP-R3-W (W-3): the category (requester-authored provenance) only on the caller's own request —
      // commercial_ops requested it; support_admin gets evidence_withheld.
      const evidence = role === 'commercial_ops' ? { category: 'R4_SERVICE_FAILURE' } : { evidence_withheld: 'FINANCE_SCOPE_REQUIRED' };
      expect(r.body, role).toEqual({ refunds: [expect.objectContaining({ change_request_id: id, refund_state: 'approved', reconciliation_status: 'NOT_SENT', ...evidence, currency: 'USD', amount_withheld: 'FINANCE_SCOPE_REQUIRED', effective_at: null, accounting_period: null })], next_cursor: null });
      if (role !== 'commercial_ops') expect(r.body.refunds[0], role).not.toHaveProperty('category');
      expect(r.body.refunds[0], role).not.toHaveProperty('amount_minor');
      expect(JSON.stringify(r.body), role).not.toContain('4321');
    }
    for (const role of ['platform_owner', 'finance_admin', 'read_only_auditor']) {
      const r = await get(role, path);
      expect(r.status, role).toBe(200);
      expect(r.body.refunds[0], role).toMatchObject({ change_request_id: id, amount_minor: 4_321 });
      expect(r.body.refunds[0], role).not.toHaveProperty('amount_withheld');
    }
    for (const role of ['catalog_manager', 'super_admin']) expect(out(await get(role, path)), role).toEqual([403, 'INSUFFICIENT_PERMISSIONS', null]);
    expect((await get('finance_admin', path, 'recruiter')).status).toBe(403);
    expect((await get('finance_admin', '/platform/commercial/finance/refunds?limit=0')).status).toBe(400);
    expect((await get('finance_admin', '/platform/commercial/finance/refunds?cursor=nope')).status).toBe(400);
  });
});
