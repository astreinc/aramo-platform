import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CommercialApplyFailedError } from '../lib/commercial/commercial-apply-records.js';
import { CommercialApplyRefusedError } from '../lib/commercial/commercial-approval-eligibility.js';
import { type CommercialActionType } from '../lib/commercial/commercial-change-request.js';
import { CommercialChangeRequestError } from '../lib/commercial/commercial-change-request.service.js';
import { commercialPolicyChecksum } from '../lib/commercial/commercial-policy.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { seededPolicyV1 } from './fixtures/commercial-policy-seed.js';
import { POLICY_V1, activatePolicyV2, addOperator, applyCcpA6Schema } from './support/ccp-a3-database.js';
import { A6_CTX, INCLUDED, a6Harness, as, newTenant, publishedVersion, rawSubscription, type A6Harness } from './support/ccp-a6.js';

// CCP-A6-R — Aramo-CCP-Charter-Amendment-A1-Apply-Deadline-v1_0-LOCKED (AD-1…AD-8; SHA-256 prefix
// 58dac8ed94ccf43b) on real Postgres 17: the terminal APPLY_EXPIRED state, the deadline read from
// the request's SNAPSHOTTED policy (a v2 test fixture carries apply_expiry_hours; v1 has none),
// the half-open window, the lazy expiry at apply / create / read, and the guard. Test IDs are
// cited by doc/ccp/slices/CCP-A6-acceptance.md (A6-R).

const H = 3_600_000;
const A = new Date('2026-10-25T12:00:00.000Z'); // the final-approval instant of the fixtures
const TTL_HOURS = 72; // the v2 TEST FIXTURE value (Charter Amendment A1 §2); never a code constant

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-A6-R apply deadline (real Postgres 17)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let h: A6Harness;
  let now = A;
  let OPS: string;
  let FA: string;
  let PO: string;
  let CAT: string;
  let V2: string | null = null;
  let keyN = 0;
  const key = () => `a6r-ttl-key-${String(++keyN).padStart(6, '0')}`;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    await applyCcpA6Schema(pg);
    prisma = new PrismaService(url);
    await prisma.$connect();
    h = a6Harness(prisma, () => now);
    OPS = await addOperator(pg, ['commercial_ops']);
    FA = await addOperator(pg, ['finance_admin']);
    PO = await addOperator(pg, ['platform_owner']);
    CAT = await addOperator(pg, ['catalog_manager']);
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  /** The v2 TEST FIXTURE: v1 content + apply_expiry_hours (activated raw here; in the product only by POLICY_ACTIVATE). */
  async function ensureV2(): Promise<string> {
    if (V2 === null) {
      const content = { ...(seededPolicyV1().content as Record<string, unknown>), apply_expiry_hours: TTL_HOURS };
      V2 = await activatePolicyV2(pg, content, commercialPolicyChecksum(content));
    }
    return V2;
  }
  /** Created, submitted and approved at `A` (the final approval). */
  async function approvedOpen(t: string): Promise<string> {
    now = A;
    const r = await h.changeRequests.create(
      as(OPS, 'commercial_ops'),
      { action_type: 'SUBSCRIPTION_OPEN', tenant_id: t, product_key: 'sign', payload: { plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED), replaces_subscription_id: null }, reason: 'ttl', idempotency_key: key() },
      A6_CTX,
    );
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), r.request.id, A6_CTX);
    const a = await h.changeRequests.approve(as(FA, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
    expect(a.request.approved_at?.toISOString()).toBe(A.toISOString());
    return r.request.id;
  }
  const at = (ms: number) => (now = new Date(A.getTime() + ms));
  const applyAs = (id: string, user = OPS, role = 'commercial_ops') => h.apply.apply(as(user, role), id, A6_CTX);
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
  const state = async (id: string) => (await pg.query(`SELECT state, apply_attempts FROM subscription."CommercialChangeRequest" WHERE id = $1`, [id])).rows[0];
  const events = async (id: string, type: string) => (await pg.query(`SELECT payload FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 AND event_type = $2 ORDER BY created_at, id`, [id, type])).rows.map((r) => r.payload);
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

  it('A6R-TTL-V1 (AD-2) a request snapshotted under v1 (no apply_expiry_hours) never expires: 10 000 h after approval a read keeps it APPROVED and the requester applies', async () => {
    const t = await newTenant(pg);
    const id = await approvedOpen(t);
    at(10_000 * H);
    const view = await h.changeRequests.get(as(OPS, 'commercial_ops'), id, A6_CTX);
    expect(view.request).toMatchObject({ state: 'APPROVED', policy_version_id: POLICY_V1 });
    expect(view.apply_actionable).toBe(true);
    expect(await outcome(applyAs(id))).toBe('APPLIED');
    expect(await events(id, 'COMMERCIAL_CHANGE_REQUEST_APPLY_EXPIRED')).toEqual([]);
  });

  it('A6R-TTL-B (AD-3) the half-open window under the v2 fixture: deadline − 1 ms applies; EXACTLY at the deadline the apply is refused APPLY_EXPIRED, the request becomes APPLY_EXPIRED with exactly ONE expiry event, nothing else is written', async () => {
    await ensureV2();
    const t1 = await newTenant(pg);
    const ok = await approvedOpen(t1);
    at(TTL_HOURS * H - 1);
    expect(await outcome(applyAs(ok))).toBe('APPLIED');

    const t2 = await newTenant(pg);
    const late = await approvedOpen(t2);
    at(TTL_HOURS * H);
    expect(await outcome(applyAs(late))).toBe('ERROR:APPLY_EXPIRED');
    expect(await state(late)).toEqual({ state: 'APPLY_EXPIRED', apply_attempts: 0 });
    const ev = await events(late, 'COMMERCIAL_CHANGE_REQUEST_APPLY_EXPIRED');
    expect(ev).toEqual([expect.objectContaining({ from_state: 'APPROVED', final_approved_at: A.toISOString(), apply_deadline: new Date(A.getTime() + TTL_HOURS * H).toISOString() })]);
    expect(await events(late, 'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED')).toEqual([]);
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."TenantSubscription" WHERE tenant_id = $1`, [t2])).rows[0].n).toBe(0);
    // AD-6 — the request row, payload and approvals stay as they were (only the state moved).
    const approvals = (await pg.query(`SELECT count(*)::int n FROM subscription."CommercialApproval" WHERE change_request_id = $1`, [late])).rows[0].n;
    expect(approvals).toBe(1);
    // A later apply of the expired request is an audited refusal with the same stable code.
    expect(await outcome(applyAs(late))).toBe('ERROR:APPLY_EXPIRED');
    expect((await events(late, 'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED')).map((r) => r.refusal)).toEqual(['APPLY_EXPIRED']);
    expect(await events(late, 'COMMERCIAL_CHANGE_REQUEST_APPLY_EXPIRED')).toHaveLength(1);
    // AD-5 — the Q14 slot is released: a fresh request for the same tenant × product is admitted.
    const fresh = await h.changeRequests.create(
      as(OPS, 'commercial_ops'),
      { action_type: 'SUBSCRIPTION_OPEN', tenant_id: t2, product_key: 'sign', payload: { plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED), replaces_subscription_id: null }, reason: 'fresh', idempotency_key: key() },
      A6_CTX,
    );
    expect(fresh.request.state).toBe('DRAFT');
  });

  it('A6R-TTL-R (AD-4) a retry from APPLY_FAILED is admitted only before the deadline; at the deadline APPLY_FAILED → APPLY_EXPIRED', async () => {
    await ensureV2();
    const t = await newTenant(pg);
    const id = await approvedOpen(t);
    await rawSubscription(pg, t, { source: 'MANUAL' }); // makes the open stale
    at(H);
    expect(await outcome(applyAs(id))).toBe('FAILED:TARGET_STALE');
    at(TTL_HOURS * H - 1);
    expect(await outcome(applyAs(id))).toBe('FAILED:TARGET_STALE'); // the retry is admitted
    expect(await state(id)).toEqual({ state: 'APPLY_FAILED', apply_attempts: 2 });
    at(TTL_HOURS * H);
    expect(await outcome(applyAs(id))).toBe('ERROR:APPLY_EXPIRED');
    expect(await state(id)).toEqual({ state: 'APPLY_EXPIRED', apply_attempts: 2 });
    expect(await events(id, 'COMMERCIAL_CHANGE_REQUEST_APPLY_EXPIRED')).toEqual([expect.objectContaining({ from_state: 'APPLY_FAILED' })]);
  });

  it('A6R-TTL-READ (AD-7) a read evaluates the deadline lazily: the detail read (and the list) shows APPLY_EXPIRED, apply_actionable false, one event', async () => {
    await ensureV2();
    const t = await newTenant(pg);
    const id = await approvedOpen(t);
    at(TTL_HOURS * H - 1);
    expect((await h.changeRequests.get(as(OPS, 'commercial_ops'), id, A6_CTX)).apply_actionable).toBe(true);
    at(TTL_HOURS * H + 5);
    const view = await h.changeRequests.get(as(OPS, 'commercial_ops'), id, A6_CTX);
    expect(view.request.state).toBe('APPLY_EXPIRED');
    expect(view.apply_actionable).toBe(false);
    const listed = await h.changeRequests.list(as(OPS, 'commercial_ops'), { requested_by: OPS, limit: 200 }, A6_CTX);
    expect(listed.requests.find((r) => r.id === id)?.state).toBe('APPLY_EXPIRED');
    expect(await events(id, 'COMMERCIAL_CHANGE_REQUEST_APPLY_EXPIRED')).toHaveLength(1);
  });

  it('A6R-TTL-CREATE (AD-5, AD-7) a create contending for the slot expires the lapsed approved request and is admitted', async () => {
    await ensureV2();
    const t = await newTenant(pg);
    const old = await approvedOpen(t);
    at(TTL_HOURS * H);
    const fresh = await h.changeRequests.create(
      as(OPS, 'commercial_ops'),
      { action_type: 'SUBSCRIPTION_OPEN', tenant_id: t, product_key: 'sign', payload: { plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED), replaces_subscription_id: null }, reason: 'contend', idempotency_key: key() },
      A6_CTX,
    );
    expect(fresh.request.state).toBe('DRAFT');
    expect((await state(old)).state).toBe('APPLY_EXPIRED');
    expect(await events(old, 'COMMERCIAL_CHANGE_REQUEST_APPLY_EXPIRED')).toHaveLength(1);
    // Before the deadline the slot is still held.
    const t2 = await newTenant(pg);
    await approvedOpen(t2);
    at(TTL_HOURS * H - 1);
    await expect(
      h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type: 'SUBSCRIPTION_OPEN', tenant_id: t2, product_key: 'sign', payload: { plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED), replaces_subscription_id: null }, reason: 'held', idempotency_key: key() }, A6_CTX),
    ).rejects.toMatchObject({ code: 'OPEN_REQUEST_EXISTS' });
  });

  it('A6R-TTL-B2 the catalog apply (CCP-B2-backend) is gated by the same deadline', async () => {
    await ensureV2();
    now = A;
    const plan = randomUUID();
    await pg.query(
      `INSERT INTO subscription."Plan" (id, key, name, sellable, description, tenant_kind, sales_model, status, display_order, product_key)
       SELECT $1::uuid, $2, 'TTL B2', false, description, tenant_kind, sales_model, 'ACTIVE', 990, product_key FROM subscription."Plan" WHERE key = $3`,
      [plan, `aramo-sign-ttl-${plan.slice(0, 8)}`, INCLUDED],
    );
    const v1 = (await h.versions.createDraftFromLive({ plan_id: plan, created_by: 'ttl' })).id;
    const r = await h.changeRequests.create(as(CAT, 'catalog_manager'), { action_type: 'PLAN_VERSION_PUBLISH' as CommercialActionType, payload: { plan_version_id: v1 }, reason: 'ttl publish', idempotency_key: key() }, A6_CTX);
    await h.changeRequests.submit(as(CAT, 'catalog_manager'), r.request.id, A6_CTX);
    await h.changeRequests.approve(as(FA, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
    await h.changeRequests.approve(as(PO, 'platform_owner'), r.request.id, { step_index: 1 }, A6_CTX);
    at(TTL_HOURS * H);
    expect(await outcome(applyAs(r.request.id, CAT, 'catalog_manager'))).toBe('ERROR:APPLY_EXPIRED');
    expect((await pg.query(`SELECT status FROM subscription."PlanVersion" WHERE id = $1`, [v1])).rows[0].status).toBe('DRAFT');
  });

  it('A6R-TTL-DB (AD-4) the guard: APPLYING → APPLY_EXPIRED refused (never from an apply in progress); APPLY_EXPIRED is terminal; a non-governed action cannot reach it', async () => {
    await ensureV2();
    const t = await newTenant(pg);
    const id = await approvedOpen(t);
    await pg.query('BEGIN');
    await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', apply_attempts = 1 WHERE id = $1`, [id]);
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLY_EXPIRED' WHERE id = $1`, [id])).toBe('CommercialChangeRequest state APPLYING -> APPLY_EXPIRED is not allowed');
    await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLY_EXPIRED' WHERE id = $1`, [id]);
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPROVED' WHERE id = $1`, [id])).toBe('CommercialChangeRequest in terminal state APPLY_EXPIRED is immutable');
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'PENDING_APPROVAL' WHERE id = $1`, [id])).toBe('CommercialChangeRequest in terminal state APPLY_EXPIRED is immutable');
    now = A;
    const credit = await h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type: 'CREDIT', tenant_id: await newTenant(pg), product_key: 'sign', payload: { amount_minor: 100, currency: 'USD' }, reason: 'credit', idempotency_key: key() }, A6_CTX);
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), credit.request.id, A6_CTX);
    await h.changeRequests.approve(as(FA, 'finance_admin'), credit.request.id, { step_index: 0 }, A6_CTX);
    // CCP-C4 (expectation change, TD-C4-9): CREDIT is now an applyable type (the C4 billing
    // adjustment), so AD-4 admits APPROVED -> APPLY_EXPIRED for it like every other applyable type; no
    // action type remains outside AD-4. Probed in a rolled-back transaction.
    await pg.query('BEGIN');
    await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLY_EXPIRED' WHERE id = $1`, [credit.request.id]);
    expect((await pg.query(`SELECT state FROM subscription."CommercialChangeRequest" WHERE id = $1`, [credit.request.id])).rows[0].state).toBe('APPLY_EXPIRED');
    await pg.query('ROLLBACK');
    // The state CHECK admits the new value (widened additively).
    const check = (await pg.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'CommercialChangeRequest_state_check'`)).rows[0].d as string;
    expect(check).toContain("'APPLY_EXPIRED'");
  });

  it('A6R-TTL-MAL (AD-1) a policy version that declares the key malformed fails closed: no request is created under it', async () => {
    await ensureV2();
    const bad = { ...(seededPolicyV1().content as Record<string, unknown>), apply_expiry_hours: 'seventy-two' };
    await pg.query(`INSERT INTO subscription."CommercialPolicyVersion" (id, version_number, status, content, content_checksum) VALUES ($1, 3, 'DRAFT', $2::jsonb, $3)`, [
      '019a0000-0000-7000-8000-0000000cc2a3',
      JSON.stringify(bad),
      commercialPolicyChecksum(bad),
    ]);
    await pg.query('BEGIN');
    await pg.query(`UPDATE subscription."CommercialPolicyVersion" SET status = 'RETIRED', retired_at = now() WHERE status = 'ACTIVE'`);
    await pg.query(`UPDATE subscription."CommercialPolicyVersion" SET status = 'ACTIVE', activated_at = now() WHERE id = '019a0000-0000-7000-8000-0000000cc2a3'`);
    await pg.query('COMMIT');
    now = A;
    await expect(
      h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type: 'SUBSCRIPTION_OPEN', tenant_id: await newTenant(pg), product_key: 'sign', payload: { plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED), replaces_subscription_id: null }, reason: 'bad', idempotency_key: key() }, A6_CTX),
    ).rejects.toMatchObject({ name: 'CommercialPolicyUnavailableError', reason: 'MALFORMED' });
  });
});
