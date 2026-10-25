import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CommercialApplyFailedError } from '../lib/commercial/commercial-apply-records.js';
import { CommercialApplyRefusedError } from '../lib/commercial/commercial-approval-eligibility.js';
import { type CommercialActionType } from '../lib/commercial/commercial-change-request.js';
import { CommercialChangeRequestError } from '../lib/commercial/commercial-change-request.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { addOperator, applyCcpA6Schema } from './support/ccp-a3-database.js';
import { A6_CTX, INCLUDED, a6Harness, as, newTenant, publishedVersion, rawSubscription, type A6Harness } from './support/ccp-a6.js';

// CCP-B2-backend (Architect disposition TD-A6-13, 2026-10-25; PBD §5.3 row B2) — the governed
// apply of the catalog lifecycle (PLAN_VERSION_PUBLISH, PLAN_RETIRE) on the CCP-A6 apply
// infrastructure, on real Postgres 17. Test IDs are cited by
// doc/ccp/slices/CCP-B2-backend-acceptance.md.

const T0 = new Date('2026-10-25T12:00:00.000Z');

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-B2-backend catalog apply (real Postgres 17)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let h: A6Harness;
  let faultAt: string | null = null;
  let CAT: string;
  let FA: string;
  let PO: string;
  let keyN = 0;
  const key = () => `b2-key-${String(++keyN).padStart(6, '0')}`;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    await applyCcpA6Schema(pg);
    prisma = new PrismaService(url);
    await prisma.$connect();
    h = a6Harness(prisma, () => T0, undefined, (point) => {
      if (point === faultAt) throw new Error(`injected catalog fault at ${point}`);
    });
    CAT = await addOperator(pg, ['catalog_manager']);
    FA = await addOperator(pg, ['finance_admin']);
    PO = await addOperator(pg, ['platform_owner']);
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  /** A test-only operator plan (copy of the included plan's live rows), published as v1. */
  async function testPlan(): Promise<{ plan_id: string; key: string; v1: string }> {
    const plan_id = randomUUID();
    const k = `aramo-sign-b2-${plan_id.slice(0, 8)}`;
    await pg.query(
      `INSERT INTO subscription."Plan" (id, key, name, sellable, description, tenant_kind, sales_model, status, display_order, product_key)
       SELECT $1::uuid, $2, 'B2 test', false, description, tenant_kind, sales_model, 'ACTIVE', 970, product_key FROM subscription."Plan" WHERE key = $3`,
      [plan_id, k, INCLUDED],
    );
    await pg.query(`INSERT INTO subscription."PlanAllowance" (plan_id, allowance_key, included_quantity, unlimited, period) VALUES ($1, 'sign.envelopes', 100, false, 'MONTHLY')`, [plan_id]);
    const v1 = (await h.versions.createDraftFromLive({ plan_id, created_by: 'b2-test' })).id;
    await h.versions.publish(v1, T0);
    return { plan_id, key: k, v1 };
  }
  async function draftV2(plan_id: string, quantity = 300): Promise<string> {
    const live = await h.versions.liveContent(plan_id);
    const content = { ...live, allowances: live.allowances.map((a) => ({ ...a, included_quantity: quantity })) };
    return (await h.versions.createDraft({ plan_id, content, created_by: 'b2-test' })).id;
  }
  /** catalog_manager requests; finance_admin then platform_owner approve (Finance → Owner). */
  async function approved(action_type: CommercialActionType, payload: Record<string, unknown>, requester = CAT): Promise<string> {
    const r = await h.changeRequests.create(as(requester, 'catalog_manager'), { action_type, payload, reason: 'catalog lifecycle', idempotency_key: key() }, A6_CTX);
    expect((r.request.required_chain as { rule: string }).rule).toBe('FINANCE_THEN_OWNER');
    await h.changeRequests.submit(as(requester, 'catalog_manager'), r.request.id, A6_CTX);
    await h.changeRequests.approve(as(FA, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
    const a = await h.changeRequests.approve(as(PO, 'platform_owner'), r.request.id, { step_index: 1 }, A6_CTX);
    expect(a.request.state).toBe('APPROVED');
    return r.request.id;
  }
  const applyAs = (id: string, user = CAT, role = 'catalog_manager') => h.apply.apply(as(user, role), id, A6_CTX);
  async function outcome(p: Promise<unknown>): Promise<string> {
    try {
      await p;
      return 'APPLIED';
    } catch (e) {
      if (e instanceof CommercialApplyFailedError) return `FAILED:${e.code}`;
      if (e instanceof CommercialApplyRefusedError) return `REFUSED:${e.reason}`;
      if (e instanceof CommercialChangeRequestError) return `ERROR:${e.code}`;
      throw e;
    }
  }
  const status = async (id: string) => (await pg.query(`SELECT status FROM subscription."PlanVersion" WHERE id = $1`, [id])).rows[0].status as string;
  const request = async (id: string) => (await pg.query(`SELECT state, apply_attempts FROM subscription."CommercialChangeRequest" WHERE id = $1`, [id])).rows[0];
  const subsJson = async () => (await pg.query(`SELECT row_to_json(s)::text j FROM subscription."TenantSubscription" s ORDER BY id`)).rows.map((r) => r.j);
  const pins = async (version: string) => (await pg.query(`SELECT provider_price_ref FROM subscription."PlanVersionPrice" WHERE plan_version_id = $1`, [version])).rows.map((r) => r.provider_price_ref);
  async function raises(sql: string, params: unknown[] = []): Promise<string> {
    try {
      await pg.query(sql, params);
    } catch (e) {
      try {
        await pg.query('ROLLBACK');
      } catch {
        /* not in a transaction */
      }
      return (e as Error).message;
    }
    throw new Error(`expected the statement to raise: ${sql}`);
  }

  it('B2-PUB-1 an approved PLAN_VERSION_PUBLISH publishes the DRAFT (the previous PUBLISHED version retires), pins the provider price in the same transaction, records the catalog application and audit; no subscription moves', async () => {
    const p = await testPlan();
    const t = await newTenant(pg);
    await rawSubscription(pg, t, { source: 'MANUAL', plan: p.key }); // a subscriber on v1
    const v2 = await draftV2(p.plan_id);
    const before = await subsJson();
    const id = await approved('PLAN_VERSION_PUBLISH', { plan_version_id: v2, provider_price_ref: 'price_b2_v2' });
    const out = await applyAs(id);
    expect(out).toMatchObject({ replayed: false, application: null, request: { state: 'APPLIED', apply_attempts: 1 } });
    expect(out.catalog_application).toMatchObject({ action_type: 'PLAN_VERSION_PUBLISH', plan_id: p.plan_id, plan_version_id: v2, retired_plan_version_id: p.v1, provider_price_ref: 'price_b2_v2', attempt: 1, applied_by: CAT });
    expect([await status(p.v1), await status(v2)]).toEqual(['RETIRED', 'PUBLISHED']);
    expect(await pins(v2)).toEqual(['price_b2_v2']);
    // TD-A5-1 (ratified) — publishing never moves a subscription: every row byte-identical, the v1 subscriber keeps 100.
    expect(await subsJson()).toEqual(before);
    expect(await h.allowance.getStatus(t, 'sign', 'sign.envelopes', T0)).toMatchObject({ limit: 100 });
    const events = (await pg.query(`SELECT event_type, payload FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 ORDER BY created_at, id`, [id])).rows;
    expect(events.map((e) => e.event_type).slice(-2)).toEqual(['COMMERCIAL_PLAN_VERSION_PUBLISHED', 'COMMERCIAL_CHANGE_REQUEST_APPLIED']);
    expect(events[events.length - 1].payload).toMatchObject({ outcome: 'APPLIED', requested_by: CAT, from_status: 'DRAFT', to_status: 'PUBLISHED', retired_plan_version_id: p.v1, effective_at: T0.toISOString() });
    expect(events[events.length - 1].payload.approvals).toHaveLength(2);
    // Idempotent replay.
    const again = await applyAs(id);
    expect(again).toMatchObject({ replayed: true, catalog_application: { id: out.catalog_application?.id } });
  });

  it('B2-RET-1 an approved PLAN_RETIRE retires a PUBLISHED version; its subscribers are grandfathered (rows byte-identical); a later open on it is refused (not PUBLISHED)', async () => {
    const p = await testPlan();
    const t = await newTenant(pg);
    await rawSubscription(pg, t, { source: 'MANUAL', plan: p.key });
    const before = await subsJson();
    const id = await approved('PLAN_RETIRE', { plan_version_id: p.v1 });
    const out = await applyAs(id);
    expect(out.catalog_application).toMatchObject({ action_type: 'PLAN_RETIRE', plan_version_id: p.v1, retired_plan_version_id: null, provider_price_ref: null });
    expect(await status(p.v1)).toBe('RETIRED');
    expect(await subsJson()).toEqual(before);
    expect(await h.allowance.getStatus(t, 'sign', 'sign.envelopes', T0)).toMatchObject({ limit: 100 });
    expect((await h.lifecycle.catalog('sign')).map((c) => c.key)).not.toContain(p.key);
  });

  it('B2-FAIL-1 substance failures roll back and record APPLY_FAILED with a stable code + explanation: VERSION_NOT_DRAFT, VERSION_NOT_PUBLISHED, VERSION_NOT_FOUND, PRICE_PIN_CONFLICT (no partial pin, version stays DRAFT)', async () => {
    const p = await testPlan();
    expect(await outcome(applyAs(await approved('PLAN_VERSION_PUBLISH', { plan_version_id: p.v1 })))).toBe('FAILED:VERSION_NOT_DRAFT');
    const v2 = await draftV2(p.plan_id);
    expect(await outcome(applyAs(await approved('PLAN_RETIRE', { plan_version_id: v2 })))).toBe('FAILED:VERSION_NOT_PUBLISHED');
    expect(await outcome(applyAs(await approved('PLAN_RETIRE', { plan_version_id: randomUUID() })))).toBe('FAILED:VERSION_NOT_FOUND');
    await h.versions.pinProviderPrice({ plan_version_id: v2, provider: 'STRIPE', provider_price_ref: 'price_b2_existing', created_by: 'b2-test' });
    const conflict = await approved('PLAN_VERSION_PUBLISH', { plan_version_id: v2, provider_price_ref: 'price_b2_other' });
    let explanation = '';
    try {
      await applyAs(conflict);
    } catch (e) {
      expect((e as CommercialApplyFailedError).code).toBe('PRICE_PIN_CONFLICT');
      explanation = (e as CommercialApplyFailedError).explanation;
    }
    expect(explanation).toMatch(/already pinned/);
    expect([await status(v2), await status(p.v1)]).toEqual(['DRAFT', 'PUBLISHED']);
    expect(await pins(v2)).toEqual(['price_b2_existing']);
    expect(await request(conflict)).toMatchObject({ state: 'APPLY_FAILED', apply_attempts: 1 });
    const audit = (await pg.query(`SELECT payload FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 AND event_type = 'COMMERCIAL_CHANGE_REQUEST_APPLY_FAILED'`, [conflict])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toMatchObject({ failure: 'PRICE_PIN_CONFLICT', attempt: 1 });
  });

  it('B2-FAULT-1 a fault after the catalog write rolls back the publish (v1 still PUBLISHED, v2 DRAFT, no pin); the retry applies', async () => {
    const p = await testPlan();
    const v2 = await draftV2(p.plan_id);
    const id = await approved('PLAN_VERSION_PUBLISH', { plan_version_id: v2, provider_price_ref: 'price_b2_fault' });
    faultAt = 'after_catalog_write';
    try {
      expect(await outcome(applyAs(id))).toBe('FAILED:UNEXPECTED');
    } finally {
      faultAt = null;
    }
    expect([await status(p.v1), await status(v2)]).toEqual(['PUBLISHED', 'DRAFT']);
    expect(await pins(v2)).toEqual([]);
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialCatalogApplication" WHERE change_request_id = $1`, [id])).rows[0].n).toBe(0);
    const retry = await applyAs(id);
    expect(retry.request).toMatchObject({ state: 'APPLIED', apply_attempts: 2 });
    expect([await status(p.v1), await status(v2)]).toEqual(['RETIRED', 'PUBLISHED']);
  });

  it('B2-AUTH-1 the same TD-A6-3 rules: only the original requester (NOT_REQUESTER), a person, with the requester scope; an unapproved request is NOT_APPROVED; each refusal one audit row, nothing changes', async () => {
    const p = await testPlan();
    const v2 = await draftV2(p.plan_id);
    const id = await approved('PLAN_VERSION_PUBLISH', { plan_version_id: v2 });
    expect(await outcome(applyAs(id, PO, 'platform_owner'))).toBe('ERROR:NOT_REQUESTER');
    expect(await outcome(h.apply.apply(as(CAT, 'catalog_manager', { actor_kind: 'service_account' }), id, A6_CTX))).toBe('ERROR:NOT_HUMAN');
    expect(await outcome(applyAs(id, CAT, 'read_only_auditor'))).toBe('ERROR:REQUESTER_SCOPE_MISSING');
    expect([await status(v2), await status(p.v1)]).toEqual(['DRAFT', 'PUBLISHED']);
    const refusals = (await pg.query(`SELECT payload->>'refusal' r FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 AND event_type = 'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED' ORDER BY created_at, id`, [id])).rows.map((x) => x.r);
    expect(refusals).toEqual(['NOT_REQUESTER', 'NOT_HUMAN', 'REQUESTER_SCOPE_MISSING']);
    const pending = await h.changeRequests.create(as(CAT, 'catalog_manager'), { action_type: 'PLAN_RETIRE', payload: { plan_version_id: p.v1 }, reason: 'pending', idempotency_key: key() }, A6_CTX);
    expect(await outcome(applyAs(pending.request.id))).toBe('REFUSED:NOT_APPROVED');
    // Payload schemas are enforced at create.
    await expect(h.changeRequests.create(as(CAT, 'catalog_manager'), { action_type: 'PLAN_RETIRE', payload: { plan_version_id: 'v1' }, reason: 'bad', idempotency_key: key() }, A6_CTX)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await applyAs(id)).toMatchObject({ request: { state: 'APPLIED' } });
  });

  it('B2-SM-DB the guard branch for the catalog actions: APPROVED → APPLIED refused; APPLYING must count and never commits; APPLIED needs its catalog application; APPLIED is frozen', async () => {
    const p = await testPlan();
    const v2 = await draftV2(p.plan_id);
    const id = await approved('PLAN_VERSION_PUBLISH', { plan_version_id: v2 });
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLIED', applied_at = now() WHERE id = $1`, [id])).toBe('CommercialChangeRequest state APPROVED -> APPLIED is not allowed');
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING' WHERE id = $1`, [id])).toBe('CommercialChangeRequest APPLYING must count the attempt (apply_attempts 0 -> 0)');
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', apply_attempts = 1 WHERE id = $1`, [id])).toBe(`CommercialChangeRequest ${id} cannot commit in APPLYING (the apply is one transaction)`);
    await pg.query('BEGIN');
    await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', apply_attempts = 1 WHERE id = $1`, [id]);
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLIED', applied_at = now() WHERE id = $1`, [id])).toBe('CommercialChangeRequest cannot be APPLIED without its CommercialCatalogApplication');
    await applyAs(id);
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLY_FAILED' WHERE id = $1`, [id])).toBe('CommercialChangeRequest in terminal state APPLIED is immutable');
    expect(await raises(`DELETE FROM subscription."CommercialCatalogApplication" WHERE change_request_id = $1`, [id])).toBe('CommercialCatalogApplication is append-only (DELETE rejected)');
  });
});
