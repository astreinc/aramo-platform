import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CommercialApplyFailedError, type CommercialApplyFaultPoint } from '../lib/commercial/commercial-apply.service.js';
import { CommercialApplyRefusedError } from '../lib/commercial/commercial-approval-eligibility.js';
import { type CommercialActionType } from '../lib/commercial/commercial-change-request.js';
import { CommercialChangeRequestError } from '../lib/commercial/commercial-change-request.service.js';
import { commercialPolicyChecksum } from '../lib/commercial/commercial-policy.js';
import { billingPeriodAt } from '../lib/billing-period.js';
import { type PlanVersionContent } from '../lib/plan-version.js';
import { PlanVersionRepository } from '../lib/plan-version.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { ISOLATION_TEST_PRODUCT_KEY, registerIsolationTestProduct } from './fixtures/ccp-a4.js';
import { publishTestPlanV1 } from './fixtures/ccp-a5.js';
import { seededPolicyV1 } from './fixtures/commercial-policy-seed.js';
import { POLICY_V1, activatePolicyV2, addOperator, applyCcpA6Schema, grantRole, revokeAttestation, revokeRole } from './support/ccp-a3-database.js';
import { A6_CTX, BUSINESS, ENTERPRISE, FREE_PERSONAL, INCLUDED, a6Harness, as, domainSnapshot, newTenant, publishedVersion, rawSubscription, waitForAdvisoryWaiter, type A6Harness } from './support/ccp-a6.js';

// CCP-A6 (PBD §5.1 row A6 mandatory tests; Architect A6 ruling: concurrent commands, retries,
// idempotency keys and state transitions each tested explicitly; NC-5 ratified, TD-A3-0) on
// real Postgres 17: identity + entitlement + metering + EVERY subscription migration applied
// whole-file. Test IDs are cited by doc/ccp/slices/CCP-A6-acceptance.md.

const T0 = new Date('2026-10-25T12:00:00.000Z');
// A test-only operator plan identical to aramo-sign-included-v1 except 200 envelopes / month
// (an upgrade target for the T8 rule).
const PLAN_200 = 'aramo-sign-a6-test-200';
const PLAN_200_ID = '019a0000-5150-7000-8000-0000000a6200';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-A6 transactional apply (real Postgres 17)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let lockHolder: Client;
  let prisma: PrismaService;
  let h: A6Harness;
  let faultAt: CommercialApplyFaultPoint | null = null;
  let OPS: string;
  let FA: string;
  let FA2: string;
  let keyN = 0;
  const key = () => `a6-key-${String(++keyN).padStart(6, '0')}`;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    lockHolder = new Client({ connectionString: url });
    await lockHolder.connect();
    await applyCcpA6Schema(pg);
    prisma = new PrismaService(url);
    await prisma.$connect();
    h = a6Harness(prisma, () => T0, (point) => {
      if (point === faultAt) throw new Error(`injected fault at ${point}`);
    });
    OPS = await addOperator(pg, ['commercial_ops']);
    FA = await addOperator(pg, ['finance_admin']);
    FA2 = await addOperator(pg, ['finance_admin']);
    // PLAN_200: the included plan's live rows, envelopes 100 → 200, published as its v1.
    await pg.query(
      `INSERT INTO subscription."Plan" (id, key, name, sellable, description, tenant_kind, sales_model, status, display_order, product_key)
       SELECT $1::uuid, $2, 'A6 test 200', false, description, tenant_kind, sales_model, 'ACTIVE', 950, product_key FROM subscription."Plan" WHERE key = $3`,
      [PLAN_200_ID, PLAN_200, INCLUDED],
    );
    for (const t of ['PlanAllowance', 'PlanCapacity', 'PlanFeature', 'PlanAllowanceWindow']) {
      const cols = (await pg.query(`SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) c FROM information_schema.columns WHERE table_schema = 'subscription' AND table_name = $1 AND column_name <> 'plan_id'`, [t])).rows[0].c;
      await pg.query(`INSERT INTO subscription."${t}" (plan_id, ${cols}) SELECT $1::uuid, ${cols} FROM subscription."${t}" WHERE plan_id = (SELECT id FROM subscription."Plan" WHERE key = $2)`, [PLAN_200_ID, INCLUDED]);
    }
    await pg.query(`UPDATE subscription."PlanAllowance" SET included_quantity = 200 WHERE plan_id = $1 AND allowance_key = 'sign.envelopes'`, [PLAN_200_ID]);
    await publishTestPlanV1(pg, PLAN_200_ID);
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await lockHolder?.end();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  /** Create (commercial_ops) → submit → approve (finance_admin): an APPROVED request. */
  async function approved(action_type: CommercialActionType, tenant_id: string, payload: Record<string, unknown>, approver = FA, requester = OPS): Promise<string> {
    const r = await h.changeRequests.create(as(requester, 'commercial_ops'), { action_type, tenant_id, product_key: 'sign', payload, reason: 'governed change', idempotency_key: key() }, A6_CTX);
    await h.changeRequests.submit(as(requester, 'commercial_ops'), r.request.id, A6_CTX);
    const a = await h.changeRequests.approve(as(approver, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
    expect(a.request.state).toBe('APPROVED');
    return r.request.id;
  }
  const openPayload = async (plan = INCLUDED, replaces: string | null = null, extra: Record<string, unknown> = {}) => ({ plan_key: plan, plan_version_id: await publishedVersion(pg, plan), replaces_subscription_id: replaces, ...extra });
  const applyAs = (id: string, user = OPS, role = 'commercial_ops', extra = {}) => h.apply.apply(as(user, role, extra), id, A6_CTX);
  async function outcome(p: Promise<unknown>): Promise<string> {
    try {
      await p;
      return 'APPLIED';
    } catch (e) {
      if (e instanceof CommercialApplyFailedError) return typeof e.detail['kind'] === 'string' ? `FAILED:${e.code}:${e.detail['kind']}` : `FAILED:${e.code}`;
      if (e instanceof CommercialApplyRefusedError) return `REFUSED:${e.reason}`;
      if (e instanceof CommercialChangeRequestError) return `ERROR:${e.code}`;
      throw e;
    }
  }
  const request = async (id: string) => (await pg.query(`SELECT state, apply_attempts, applied_at FROM subscription."CommercialChangeRequest" WHERE id = $1`, [id])).rows[0];
  const events = async (id: string) => (await pg.query(`SELECT event_type FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 ORDER BY created_at, id`, [id])).rows.map((r) => r.event_type as string);
  const openRows = async (t: string) => (await pg.query(`SELECT id, source, status, plan_version_id FROM subscription."TenantSubscription" WHERE tenant_id = $1 AND ended_at IS NULL`, [t])).rows;
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

  // ---- the four Aramo-owned operations ---------------------------------------------------

  it('A6-OPEN-1 SUBSCRIPTION_OPEN: one transaction opens a MANUAL row pinned to the PUBLISHED version, grants the product capabilities, records the application and the audit events, then APPLIED', async () => {
    const t = await newTenant(pg);
    const payload = await openPayload(INCLUDED, null, { period_anchor: '2026-10-01T00:00:00.000Z' });
    const id = await approved('SUBSCRIPTION_OPEN', t, payload);
    const out = await applyAs(id);
    expect(out.replayed).toBe(false);
    expect(out.request).toMatchObject({ state: 'APPLIED', apply_attempts: 1 });
    expect(out.application).toMatchObject({ action_type: 'SUBSCRIPTION_OPEN', attempt: 1, applied_by: OPS, to_plan_version_id: payload.plan_version_id, replaced_subscription_id: null, capabilities: ['core', 'sign'], capabilities_inserted: ['core', 'sign'] });
    const rows = await openRows(t);
    expect(rows).toEqual([{ id: out.application.subscription_id, source: 'MANUAL', status: 'ACTIVE', plan_version_id: payload.plan_version_id }]);
    const anchor = (await pg.query(`SELECT period_anchor, created_by FROM subscription."TenantSubscription" WHERE id = $1`, [out.application.subscription_id])).rows[0];
    expect(anchor).toEqual({ period_anchor: new Date('2026-10-01T00:00:00.000Z'), created_by: OPS });
    expect((await domainSnapshot(pg, t)).entitlements).toEqual([`${t}:core`, `${t}:sign`]);
    expect(await events(id)).toEqual([
      'COMMERCIAL_CHANGE_REQUEST_CREATED',
      'COMMERCIAL_CHANGE_REQUEST_SUBMITTED',
      'COMMERCIAL_APPROVAL_RECORDED',
      'COMMERCIAL_CHANGE_REQUEST_APPROVED',
      'COMMERCIAL_SUBSCRIPTION_OPENED',
      'COMMERCIAL_ENTITLEMENT_GRANTED',
      'COMMERCIAL_CHANGE_REQUEST_APPLIED',
    ]);
    // The allowance reads the new governed row (the operator plan: 100 / month).
    expect(await h.allowance.getStatus(t, 'sign', 'sign.envelopes', T0)).toMatchObject({ subscribed: true, limit: 100 });
  });

  it('A6-G2-1 SUBSCRIPTION_OPEN replacing the open DEVELOPMENT row it names: the prior row ends in the same transaction; still one open BASE row', async () => {
    const t = await newTenant(pg);
    const prior = await rawSubscription(pg, t, { source: 'DEVELOPMENT' });
    const id = await approved('SUBSCRIPTION_OPEN', t, await openPayload(PLAN_200, prior));
    const out = await applyAs(id);
    expect(out.application).toMatchObject({ replaced_subscription_id: prior });
    // T8 — the replacement keeps the prior row's period anchor (same period).
    expect((await pg.query(`SELECT period_anchor FROM subscription."TenantSubscription" WHERE id = $1`, [out.application.subscription_id])).rows[0].period_anchor).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect((await openRows(t)).map((r) => r.source)).toEqual(['MANUAL']);
    expect((await pg.query(`SELECT status, ended_at IS NOT NULL AS ended FROM subscription."TenantSubscription" WHERE id = $1`, [prior])).rows[0]).toEqual({ status: 'CANCELED', ended: true });
    expect((await events(id)).filter((e) => e.startsWith('COMMERCIAL_SUBSCRIPTION'))).toEqual(['COMMERCIAL_SUBSCRIPTION_ENDED', 'COMMERCIAL_SUBSCRIPTION_OPENED']);
  });

  it('A6-G2-2 a stale open (the payload names no row, but one is open now) fails closed: APPLY_FAILED TARGET_STALE, nothing changes, retryable', async () => {
    const t = await newTenant(pg);
    const id = await approved('SUBSCRIPTION_OPEN', t, await openPayload());
    await rawSubscription(pg, t, { source: 'MANUAL' }); // opened after approval
    const before = await domainSnapshot(pg, t);
    expect(await outcome(applyAs(id))).toBe('FAILED:TARGET_STALE');
    expect(await domainSnapshot(pg, t)).toEqual(before);
    expect(await request(id)).toMatchObject({ state: 'APPLY_FAILED', apply_attempts: 1, applied_at: null });
    expect(await outcome(applyAs(id))).toBe('FAILED:TARGET_STALE');
    expect(await request(id)).toMatchObject({ state: 'APPLY_FAILED', apply_attempts: 2 });
    expect((await events(id)).filter((e) => e.includes('APPLY'))).toEqual(['COMMERCIAL_CHANGE_REQUEST_APPLY_FAILED', 'COMMERCIAL_CHANGE_REQUEST_APPLY_FAILED']);
  });

  it('A6-CHANGE-1 / A6-T3-1 SUBSCRIPTION_CHANGE re-pins the governed row to the approved version under reason CHANGE_REQUEST; the old AND new plan_version_id are recorded (application, pin history, audit) with the effective timestamp', async () => {
    const t = await newTenant(pg);
    const sub = await rawSubscription(pg, t, { source: 'MANUAL' });
    const from = await publishedVersion(pg, INCLUDED);
    const to = await publishedVersion(pg, PLAN_200);
    const id = await approved('SUBSCRIPTION_CHANGE', t, { subscription_id: sub, plan_key: PLAN_200, plan_version_id: to });
    const out = await applyAs(id);
    expect(out.application).toMatchObject({ subscription_id: sub, from_plan_version_id: from, to_plan_version_id: to });
    expect(await openRows(t)).toEqual([{ id: sub, source: 'MANUAL', status: 'ACTIVE', plan_version_id: to }]);
    const pins = (await pg.query(`SELECT reason, from_plan_version_id, to_plan_version_id FROM subscription."SubscriptionVersionPinEvent" WHERE subscription_id = $1`, [sub])).rows;
    expect(pins).toEqual([{ reason: 'CHANGE_REQUEST', from_plan_version_id: from, to_plan_version_id: to }]);
    const audit = (await pg.query(`SELECT event_type, payload FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 AND event_type IN ('COMMERCIAL_SUBSCRIPTION_CHANGED', 'COMMERCIAL_CHANGE_REQUEST_APPLIED') ORDER BY created_at, id`, [id])).rows;
    expect(audit[0].payload).toMatchObject({ from_plan_version_id: from, to_plan_version_id: to, effective_at: T0.toISOString(), period_anchor: '2026-10-01T00:00:00.000Z' });
    // T10 — requester, reason, approval evidence, old/new terms, effective timestamp, outcome.
    expect(audit[1].payload).toMatchObject({
      outcome: 'APPLIED',
      requested_by: OPS,
      reason: 'governed change',
      approvals: [expect.objectContaining({ step_index: 0, approver_user_id: FA })],
      from_plan_version_id: from,
      to_plan_version_id: to,
      effective_at: T0.toISOString(),
    });
    // The same version again is NO_CHANGE (fails closed, nothing written).
    const again = await approved('SUBSCRIPTION_CHANGE', t, { subscription_id: sub, plan_key: PLAN_200, plan_version_id: to });
    expect(await outcome(applyAs(again))).toBe('FAILED:NO_CHANGE');
  });

  it('A6-END-1 SUBSCRIPTION_END ends the governed row; the capability is kept (revoke is A7); usage rows are untouched (C-24 signing continuity)', async () => {
    const t = await newTenant(pg);
    const open = await approved('SUBSCRIPTION_OPEN', t, await openPayload());
    const sub = (await applyAs(open)).application.subscription_id as string;
    await pg.query(
      `INSERT INTO subscription."AllowanceUsage" (id, tenant_id, allowance_key, send_key, period_start, state, reserved_until, finalized_at) VALUES (gen_random_uuid(), $1, 'sign.envelopes', 'env-1', now(), 'CONSUMED', now(), now())`,
      [t],
    );
    const usage = async () => (await pg.query(`SELECT row_to_json(u)::text j FROM subscription."AllowanceUsage" u WHERE tenant_id = $1`, [t])).rows;
    const usageBefore = await usage();
    const id = await approved('SUBSCRIPTION_END', t, { subscription_id: sub });
    const out = await applyAs(id);
    expect(out.application).toMatchObject({ subscription_id: sub, capabilities: [], capabilities_inserted: [] });
    expect(await openRows(t)).toEqual([]);
    expect((await pg.query(`SELECT status FROM subscription."TenantSubscription" WHERE id = $1`, [sub])).rows[0].status).toBe('CANCELED');
    expect((await domainSnapshot(pg, t)).entitlements).toEqual([`${t}:core`, `${t}:sign`]);
    expect(await usage()).toEqual(usageBefore);
    // Ending it again: the row has ended → TARGET_STALE.
    const twice = await approved('SUBSCRIPTION_END', t, { subscription_id: sub });
    expect(await outcome(applyAs(twice))).toBe('FAILED:TARGET_STALE');
  });

  it('A6-GRANT-1 ENTITLEMENT_GRANT is idempotent at the row level and limited to the product bundle', async () => {
    const t = await newTenant(pg);
    const first = await applyAs(await approved('ENTITLEMENT_GRANT', t, { capabilities: ['sign'] }));
    expect(first.application).toMatchObject({ subscription_id: null, capabilities: ['sign'], capabilities_inserted: ['sign'] });
    const second = await applyAs(await approved('ENTITLEMENT_GRANT', t, { capabilities: ['core', 'sign'] }));
    expect(second.application).toMatchObject({ capabilities: ['core', 'sign'], capabilities_inserted: ['core'] });
    const outside = await approved('ENTITLEMENT_GRANT', t, { capabilities: ['ats'] });
    expect(await outcome(applyAs(outside))).toBe('FAILED:CAPABILITY_NOT_IN_PRODUCT');
    expect((await domainSnapshot(pg, t)).entitlements).toEqual([`${t}:core`, `${t}:sign`]);
  });

  // ---- G1 / G3 ---------------------------------------------------------------------------

  it('A6-G1-1 a Stripe-owned row is refused for open, change and end (STRIPE_OWNED); the provider row is byte-identical', async () => {
    // One tenant per case: an APPLY_FAILED request keeps the Q14 slot (one open request per tenant × product).
    const cases: Array<[string, (t: string, ss: string) => Promise<Record<string, unknown>>]> = [
      ['SUBSCRIPTION_OPEN', async (_t, ss) => openPayload(INCLUDED, ss)],
      ['SUBSCRIPTION_CHANGE', async (_t, ss) => ({ subscription_id: ss, plan_key: ENTERPRISE, plan_version_id: await publishedVersion(pg, ENTERPRISE) })],
      ['SUBSCRIPTION_END', async (_t, ss) => ({ subscription_id: ss })],
    ];
    for (const [action, payload] of cases) {
      const t = await newTenant(pg);
      const ss = await rawSubscription(pg, t, { source: 'SELF_SERVICE', ref: `sub_ss_${t}` });
      const before = await domainSnapshot(pg, t);
      const id = await approved(action as CommercialActionType, t, await payload(t, ss));
      expect(await outcome(applyAs(id)), action).toBe('FAILED:STRIPE_OWNED');
      expect(await domainSnapshot(pg, t)).toEqual(before);
    }
    // A MANUAL-sourced row that carries a provider link is Stripe-owned too.
    const t2 = await newTenant(pg);
    const linked = await rawSubscription(pg, t2, { source: 'MANUAL', ref: `sub_linked_${t2}` });
    expect(await outcome(applyAs(await approved('SUBSCRIPTION_END', t2, { subscription_id: linked })))).toBe('FAILED:STRIPE_OWNED');
  });

  it('A6-G3-1 only a PUBLISHED version of the named plan is pinned; INACTIVE / FREE plans and other tenant kinds are refused', async () => {
    const t = await newTenant(pg);
    const draft = (
      await pg.query(
        `INSERT INTO subscription."PlanVersion" (id, plan_id, version_number, status, content, content_checksum, created_by, created_at)
         SELECT gen_random_uuid(), p.id, 2, 'DRAFT', x.c, subscription.ccp_plan_version_checksum(x.c), 'test', now()
           FROM subscription."Plan" p, LATERAL (SELECT subscription.ccp_plan_live_content(p.id) AS c) x WHERE p.key = $1 RETURNING id`,
        [ENTERPRISE],
      )
    ).rows[0].id as string;
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ plan_key: ENTERPRISE, plan_version_id: draft, replaces_subscription_id: null }, 'FAILED:PLAN_VERSION_NOT_PUBLISHED'],
      [{ plan_key: ENTERPRISE, plan_version_id: await publishedVersion(pg, INCLUDED), replaces_subscription_id: null }, 'FAILED:PLAN_VERSION_MISMATCH'],
      [{ plan_key: 'aramo-sign-no-such-plan', plan_version_id: draft, replaces_subscription_id: null }, 'FAILED:PLAN_NOT_FOUND'],
      [await openPayload(FREE_PERSONAL), 'FAILED:PLAN_NOT_ASSIGNABLE'],
    ];
    for (const [payload, expected] of cases) {
      const tc = await newTenant(pg); // one tenant per case (Q14 slot held by APPLY_FAILED)
      const id = await approved('SUBSCRIPTION_OPEN', tc, payload);
      expect(await outcome(applyAs(id)), JSON.stringify(payload)).toBe(expected);
      expect(await openRows(tc)).toEqual([]);
    }
    const personal = await newTenant(pg, 'PERSONAL');
    expect(await outcome(applyAs(await approved('SUBSCRIPTION_OPEN', personal, await openPayload(ENTERPRISE))))).toBe('FAILED:PLAN_TENANT_KIND_MISMATCH');
    expect(await openRows(t)).toEqual([]);
  });

  // ---- fault injection: all-or-nothing ---------------------------------------------------

  for (const point of ['after_subscription_write', 'after_entitlement_write', 'before_applied'] as const) {
    it(`A6-FAULT-${point} a fault ${point.replace(/_/g, ' ')} rolls the whole apply back (no partial state); APPLY_FAILED; the retry applies`, async () => {
      const t = await newTenant(pg);
      const prior = await rawSubscription(pg, t, { source: 'DEVELOPMENT' });
      const id = await approved('SUBSCRIPTION_OPEN', t, await openPayload(INCLUDED, prior));
      const before = await domainSnapshot(pg, t, id);
      faultAt = point;
      try {
        expect(await outcome(applyAs(id))).toBe('FAILED:UNEXPECTED');
      } finally {
        faultAt = null;
      }
      // Nothing of the apply survived: the prior row is still open, no MANUAL row, no
      // entitlement, no application, no domain audit; approvals untouched.
      expect(await domainSnapshot(pg, t, id)).toEqual(before);
      expect(await request(id)).toMatchObject({ state: 'APPLY_FAILED', apply_attempts: 1, applied_at: null });
      const retry = await applyAs(id);
      expect(retry.request).toMatchObject({ state: 'APPLIED', apply_attempts: 2 });
      expect(retry.application.attempt).toBe(2);
      expect((await openRows(t)).map((r) => r.source)).toEqual(['MANUAL']);
      expect((await events(id)).filter((e) => e.includes('APPL'))).toEqual(['COMMERCIAL_CHANGE_REQUEST_APPLY_FAILED', 'COMMERCIAL_CHANGE_REQUEST_APPLIED']);
    });
  }

  it('A6-FAULT-DB a real database fault on the entitlement side (a raising trigger) rolls back the subscription write too', async () => {
    const t = await newTenant(pg);
    await pg.query(`CREATE FUNCTION entitlement.a6_fault() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'a6 injected entitlement fault'; END; $$ LANGUAGE plpgsql`);
    await pg.query(`CREATE TRIGGER a6_fault BEFORE INSERT ON entitlement."TenantEntitlement" FOR EACH ROW WHEN (NEW.tenant_id = '${t}'::uuid) EXECUTE FUNCTION entitlement.a6_fault()`);
    try {
      const id = await approved('SUBSCRIPTION_OPEN', t, await openPayload());
      const before = await domainSnapshot(pg, t);
      let detail = '';
      try {
        await applyAs(id);
      } catch (e) {
        expect(e).toBeInstanceOf(CommercialApplyFailedError);
        detail = String((e as CommercialApplyFailedError).detail['error']);
      }
      expect(detail).toContain('a6 injected entitlement fault');
      expect(await domainSnapshot(pg, t)).toEqual(before);
      expect(await openRows(t)).toEqual([]);
      expect(await request(id)).toMatchObject({ state: 'APPLY_FAILED', apply_attempts: 1 });
    } finally {
      await pg.query(`DROP TRIGGER a6_fault ON entitlement."TenantEntitlement"`);
      await pg.query(`DROP FUNCTION entitlement.a6_fault()`);
    }
  });

  // ---- idempotency, retries, concurrency -------------------------------------------------

  it('A6-IDEM-1 re-applying an APPLIED request replays it (the change-request id is the apply idempotency key): same application, nothing written', async () => {
    const t = await newTenant(pg);
    const id = await approved('SUBSCRIPTION_OPEN', t, await openPayload());
    const first = await applyAs(id);
    const snap = await domainSnapshot(pg, t, id);
    const audit = (await events(id)).length;
    const again = await applyAs(id);
    expect(again.replayed).toBe(true);
    expect(again.application.id).toBe(first.application.id);
    expect(await domainSnapshot(pg, t, id)).toEqual(snap);
    expect((await events(id)).length).toBe(audit);
    // The DB refuses a second application for the request (UNIQUE change_request_id).
    expect(
      await raises(
        `INSERT INTO subscription."CommercialChangeApplication" (id, change_request_id, action_type, tenant_id, product_key, subscription_id, capabilities, capabilities_inserted, attempt, applied_by, applied_at)
         SELECT gen_random_uuid(), change_request_id, action_type, tenant_id, product_key, subscription_id, capabilities, capabilities_inserted, attempt, applied_by, now() FROM subscription."CommercialChangeApplication" WHERE change_request_id = $1`,
        [id],
      ),
    ).toMatch(/CommercialChangeApplication_change_request_id_key/);
  });

  it('A6-CONC-1 five concurrent applies of one request: exactly one applies, four replay; one row, one application, one APPLIED event', async () => {
    const t = await newTenant(pg);
    const id = await approved('SUBSCRIPTION_OPEN', t, await openPayload());
    const results = await Promise.all(Array.from({ length: 5 }, () => applyAs(id)));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(4);
    expect(new Set(results.map((r) => r.application.id)).size).toBe(1);
    expect(await openRows(t)).toHaveLength(1);
    expect((await events(id)).filter((e) => e === 'COMMERCIAL_CHANGE_REQUEST_APPLIED')).toHaveLength(1);
    expect(await request(id)).toMatchObject({ state: 'APPLIED', apply_attempts: 1 });
  });

  it('A6-CONC-2 an apply and a concurrent billing writer race: the billing lock serializes them; the later one sees the earlier commit (one open row)', async () => {
    const t = await newTenant(pg);
    const a = await approved('SUBSCRIPTION_OPEN', t, await openPayload());
    // Q14 allows one open request per tenant × product, so the competing writer is a raw
    // session that takes the same billing lock and opens a row only if none is open.
    const racer = (async () => {
      const c = new Client({ connectionString: container.getConnectionUri() });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`billing:${t}`]);
        const open = await c.query(`SELECT count(*)::int n FROM subscription."TenantSubscription" WHERE tenant_id = $1 AND ended_at IS NULL`, [t]);
        if (open.rows[0].n === 0) {
          await c.query(
            `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by)
             SELECT gen_random_uuid(), $1::uuid, p.id, (SELECT v.id FROM subscription."PlanVersion" v WHERE v.plan_id = p.id AND v.status = 'PUBLISHED'), 'sign', 'BASE', now(), 'DEVELOPMENT', 'racer' FROM subscription."Plan" p WHERE p.key = $2`,
            [t, INCLUDED],
          );
        }
        await c.query('COMMIT');
        return open.rows[0].n === 0 ? 'racer-wrote' : 'racer-skipped';
      } finally {
        await c.end();
      }
    })();
    const [applied, raced] = await Promise.all([outcome(applyAs(a)), racer]);
    // Whoever took the lock second saw the first one's committed row.
    expect([`${applied}|${raced}`]).toContainEqual(expect.stringMatching(/^(APPLIED\|racer-skipped|FAILED:TARGET_STALE\|racer-wrote)$/));
    expect(await openRows(t)).toHaveLength(1);
  });

  it('A6-LOCK-1 the apply waits on the shared billing lock: while another session holds billing:<tenant>, nothing is written; on release it applies', async () => {
    const t = await newTenant(pg);
    const id = await approved('SUBSCRIPTION_OPEN', t, await openPayload());
    await lockHolder.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`billing:${t}`]);
    const pending = applyAs(id);
    try {
      await waitForAdvisoryWaiter(pg);
      expect(await request(id)).toMatchObject({ state: 'APPROVED', apply_attempts: 0 });
      expect(await openRows(t)).toEqual([]);
    } finally {
      await lockHolder.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`billing:${t}`]);
    }
    expect((await pending).request.state).toBe('APPLIED');
  });

  // ---- authority and refusals (no state change) -----------------------------------------

  it('A6-AUTH-1 refusals before any write: requester scope, a non-human, a non-A6 action, a request not approved, a tampered payload', async () => {
    const t = await newTenant(pg);
    const id = await approved('SUBSCRIPTION_OPEN', t, await openPayload());
    // CCP-A6-R (TD-A6-3) — only the ORIGINAL requester applies; then the requester scope.
    expect(await outcome(applyAs(id, FA, 'finance_admin'))).toBe('ERROR:NOT_REQUESTER');
    expect(await outcome(applyAs(id, OPS, 'read_only_auditor'))).toBe('ERROR:REQUESTER_SCOPE_MISSING');
    expect(await outcome(applyAs(id, OPS, 'commercial_ops', { actor_kind: 'service_account' }))).toBe('ERROR:NOT_HUMAN');
    expect(await outcome(applyAs(randomUUID()))).toBe('ERROR:NOT_FOUND');
    const credit = await h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type: 'CREDIT', tenant_id: await newTenant(pg), product_key: 'sign', payload: { amount_minor: 100, currency: 'USD' }, reason: 'credit', idempotency_key: key() }, A6_CTX);
    expect(await outcome(applyAs(credit.request.id))).toBe('ERROR:ACTION_NOT_APPLICABLE');
    const t2 = await newTenant(pg);
    const draft = await h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type: 'SUBSCRIPTION_OPEN', tenant_id: t2, product_key: 'sign', payload: await openPayload(), reason: 'draft', idempotency_key: key() }, A6_CTX);
    expect(await outcome(applyAs(draft.request.id))).toBe('REFUSED:NOT_APPROVED');
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), draft.request.id, A6_CTX);
    expect(await outcome(applyAs(draft.request.id))).toBe('REFUSED:NOT_APPROVED');
    expect(await request(draft.request.id)).toMatchObject({ state: 'PENDING_APPROVAL', apply_attempts: 0 });
    // Tampered payload (trigger bypassed by a superuser): integrity refusal.
    await pg.query(`ALTER TABLE subscription."CommercialChangeRequest" DISABLE TRIGGER commercial_change_request_guard_update`);
    await pg.query(`UPDATE subscription."CommercialChangeRequest" SET payload = jsonb_set(payload, '{plan_key}', '"${ENTERPRISE}"') WHERE id = $1`, [id]);
    await pg.query(`ALTER TABLE subscription."CommercialChangeRequest" ENABLE TRIGGER commercial_change_request_guard_update`);
    expect(await outcome(applyAs(id))).toBe('ERROR:INTEGRITY');
    expect(await request(id)).toMatchObject({ state: 'APPROVED', apply_attempts: 0 });
    expect(await openRows(t)).toEqual([]);
    // CCP-A6-R — every refusal on this request wrote exactly ONE audit row (NOT_REQUESTER,
    // REQUESTER_SCOPE_MISSING, NOT_HUMAN, INTEGRITY), each with its stable code and explanation.
    const refusals = (await pg.query(`SELECT payload FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 AND event_type = 'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED' ORDER BY created_at, id`, [id])).rows.map((r) => r.payload);
    expect(refusals.map((r) => r.refusal)).toEqual(['NOT_REQUESTER', 'REQUESTER_SCOPE_MISSING', 'NOT_HUMAN', 'INTEGRITY']);
    for (const r of refusals) expect(typeof r.explanation === 'string' && r.explanation.length > 10).toBe(true);
  });

  // ---- NC-5 through the real apply path (TD-A3-0, the three Architect tests) -------------

  it('A6-NC5-a role revocation between approval and apply: apply refused, fail closed, no commercial mutation; the request stays APPROVED', async () => {
    const t = await newTenant(pg);
    const signer = await addOperator(pg, ['finance_admin']);
    const id = await approved('SUBSCRIPTION_OPEN', t, await openPayload(), signer);
    await revokeRole(pg, signer, 'finance_admin');
    const before = await domainSnapshot(pg, t, id);
    expect(await outcome(applyAs(id))).toBe('REFUSED:APPROVER_NO_LONGER_ELIGIBLE');
    expect(await domainSnapshot(pg, t, id)).toEqual(before);
    expect(await request(id)).toMatchObject({ state: 'APPROVED', apply_attempts: 0, applied_at: null });
    expect((await events(id)).slice(-1)).toEqual(['COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED']);
  });

  it('A6-NC5-c after the apply refusal the original signature (CommercialApproval row) and the request row are byte-identical; the restored signer then applies with the same approval', async () => {
    const t = await newTenant(pg);
    const signer = await addOperator(pg, ['finance_admin']);
    const id = await approved('SUBSCRIPTION_OPEN', t, await openPayload(), signer);
    const rows = async () => ({
      approvals: (await pg.query(`SELECT row_to_json(a)::text j FROM subscription."CommercialApproval" a WHERE change_request_id = $1`, [id])).rows,
      request: (await pg.query(`SELECT row_to_json(c)::text j FROM subscription."CommercialChangeRequest" c WHERE id = $1`, [id])).rows,
    });
    const before = await rows();
    await revokeRole(pg, signer, 'finance_admin');
    expect(await outcome(applyAs(id))).toBe('REFUSED:APPROVER_NO_LONGER_ELIGIBLE');
    expect(await rows()).toEqual(before);
    await grantRole(pg, signer, 'finance_admin');
    const out = await applyAs(id);
    expect(out.request.state).toBe('APPLIED');
    expect((await rows()).approvals).toEqual(before.approvals);
  });

  // ---- T8 usage integrity (Architect ruling 2026-10-25) ----------------------------------

  async function consume(t: string, n: number, period_start: Date, state = 'CONSUMED'): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await pg.query(
        `INSERT INTO subscription."AllowanceUsage" (id, tenant_id, allowance_key, send_key, period_start, state, reserved_at, reserved_until, finalized_at)
         VALUES (gen_random_uuid(), $1, 'sign.envelopes', $2, $3, $4, $5, $5::timestamptz + interval '1 day', CASE WHEN $4 = 'CONSUMED' THEN $5::timestamptz ELSE NULL END)`,
        [t, `send-${randomUUID()}`, period_start, state, T0],
      );
    }
  }
  const usageRows = async (t: string) => (await pg.query(`SELECT row_to_json(u)::text j FROM subscription."AllowanceUsage" u WHERE tenant_id = $1 ORDER BY id`, [t])).rows.map((r) => r.j);

  it('A6-T8-1 a same-period immediately-effective upgrade (100 → 200 after 70 used) leaves 130 remaining: the ledger is untouched and nothing is manufactured', async () => {
    const t = await newTenant(pg);
    const sub = (await applyAs(await approved('SUBSCRIPTION_OPEN', t, await openPayload(INCLUDED, null, { period_anchor: '2026-10-01T00:00:00.000Z' })))).application.subscription_id as string;
    const period = billingPeriodAt(new Date('2026-10-01T00:00:00.000Z'), T0);
    await consume(t, 70, period.start);
    expect(await h.allowance.getStatus(t, 'sign', 'sign.envelopes', T0)).toMatchObject({ limit: 100, used: 70, remaining: 30 });
    const ledger = await usageRows(t);
    await applyAs(await approved('SUBSCRIPTION_CHANGE', t, { subscription_id: sub, plan_key: PLAN_200, plan_version_id: await publishedVersion(pg, PLAN_200) }));
    expect(await h.allowance.getStatus(t, 'sign', 'sign.envelopes', T0)).toMatchObject({ limit: 200, used: 70, remaining: 130 });
    expect(await usageRows(t)).toEqual(ledger);
  });

  it('A6-T8-2 / A6R-DR-1 (DR-A6-1, TD-A6-R-1) a same-period downgrade applies only while consumed + reserved fit the new limit (usage carried, reservations untouched); otherwise USAGE_EXCEEDS_NEW_LIMIT with nothing changed', async () => {
    const p1 = new Date('2026-10-01T00:00:00Z');
    // The Architect's example (TD-A6-R-1 CONFIRMED): 200 → 100 with 70 consumed + 10 reserved
    // applies and leaves 20 available; the ledger (consumption and reservations) byte-identical.
    const t1 = await newTenant(pg);
    const s1 = await rawSubscription(pg, t1, { source: 'MANUAL', plan: PLAN_200 });
    await consume(t1, 70, p1);
    await consume(t1, 10, p1, 'RESERVED');
    const ledger1 = await usageRows(t1);
    await applyAs(await approved('SUBSCRIPTION_CHANGE', t1, { subscription_id: s1, plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED) }));
    expect(await h.allowance.getStatus(t1, 'sign', 'sign.envelopes', T0)).toMatchObject({ limit: 100, used: 80, remaining: 20 });
    expect(await usageRows(t1)).toEqual(ledger1);
    // Boundary: consumed + reserved EXACTLY the new limit (90 + 10 = 100) applies; 0 available.
    const tb = await newTenant(pg);
    const sb = await rawSubscription(pg, tb, { source: 'MANUAL', plan: PLAN_200 });
    await consume(tb, 90, p1);
    await consume(tb, 10, p1, 'RESERVED');
    expect(await outcome(applyAs(await approved('SUBSCRIPTION_CHANGE', tb, { subscription_id: sb, plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED) })))).toBe('APPLIED');
    expect(await h.allowance.getStatus(tb, 'sign', 'sign.envelopes', T0)).toMatchObject({ limit: 100, used: 100, remaining: 0 });
    // 80 consumed + 30 reserved = 110 > 100: refused; nothing changed.
    const t2 = await newTenant(pg);
    const s2 = await rawSubscription(pg, t2, { source: 'MANUAL', plan: PLAN_200 });
    await consume(t2, 80, p1);
    await consume(t2, 30, p1, 'RESERVED');
    const b2 = { snap: await domainSnapshot(pg, t2), usage: await usageRows(t2) };
    let detail: Record<string, unknown> = {};
    try {
      await applyAs(await approved('SUBSCRIPTION_CHANGE', t2, { subscription_id: s2, plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED) }));
    } catch (e) {
      expect(e).toBeInstanceOf(CommercialApplyFailedError);
      expect((e as CommercialApplyFailedError).code).toBe('USAGE_EXCEEDS_NEW_LIMIT');
      expect((e as CommercialApplyFailedError).explanation).toMatch(/exceed the new limit/);
      detail = (e as CommercialApplyFailedError).detail;
    }
    expect(detail['exceeded']).toEqual([{ term: 'allowance:sign.envelopes', used: 110, new_limit: 100 }]);
    expect({ snap: await domainSnapshot(pg, t2), usage: await usageRows(t2) }).toEqual(b2);
    // Exactly at the limit (100 = 100) is admissible.
    const t3 = await newTenant(pg);
    const s3 = await rawSubscription(pg, t3, { source: 'MANUAL', plan: PLAN_200 });
    await consume(t3, 100, p1);
    expect(await outcome(applyAs(await approved('SUBSCRIPTION_CHANGE', t3, { subscription_id: s3, plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED) })))).toBe('APPLIED');
    expect(await h.allowance.getStatus(t3, 'sign', 'sign.envelopes', T0)).toMatchObject({ limit: 100, used: 100, remaining: 0 });
  });

  it('A6R-DR-3 (DR-A6-3) an upgrade with open reservations preserves every reservation (still counted, byte-identical); a fresh open that would strand valid reservations is RESERVATION_CONFLICT', async () => {
    const t1 = await newTenant(pg);
    const s1 = await rawSubscription(pg, t1, { source: 'MANUAL' });
    await consume(t1, 5, new Date('2026-10-01T00:00:00Z'), 'RESERVED');
    const ledger = await usageRows(t1);
    await applyAs(await approved('SUBSCRIPTION_CHANGE', t1, { subscription_id: s1, plan_key: PLAN_200, plan_version_id: await publishedVersion(pg, PLAN_200) }));
    expect(await usageRows(t1)).toEqual(ledger);
    expect(await h.allowance.getStatus(t1, 'sign', 'sign.envelopes', T0)).toMatchObject({ limit: 200, used: 5 });
    const t2 = await newTenant(pg);
    await consume(t2, 2, new Date('2026-10-01T00:00:00Z'), 'RESERVED');
    const before = { snap: await domainSnapshot(pg, t2), usage: await usageRows(t2) };
    expect(await outcome(applyAs(await approved('SUBSCRIPTION_OPEN', t2, await openPayload(INCLUDED, null, { period_anchor: '2026-10-20T00:00:00.000Z' }))))).toBe('FAILED:RESERVATION_CONFLICT');
    expect({ snap: await domainSnapshot(pg, t2), usage: await usageRows(t2) }).toEqual(before);
  });

  it('A6R-DR-2/4 (DR-A6-2, DR-A6-4) cross-period and future-dated changes fail closed with distinct stable codes; a dropped allowance has no defined treatment; nothing is APPLIED', async () => {
    const t3 = await newTenant(pg);
    const s3 = await rawSubscription(pg, t3, { source: 'DEVELOPMENT' });
    expect(await outcome(applyAs(await approved('SUBSCRIPTION_OPEN', t3, await openPayload(PLAN_200, s3, { period_anchor: '2026-10-15T00:00:00.000Z' }))))).toBe('FAILED:USAGE_CROSS_PERIOD');
    const t4 = await newTenant(pg);
    await consume(t4, 3, new Date('2026-10-01T00:00:00Z'));
    expect(await outcome(applyAs(await approved('SUBSCRIPTION_OPEN', t4, await openPayload(INCLUDED, null, { period_anchor: '2026-10-20T00:00:00.000Z' }))))).toBe('FAILED:USAGE_CROSS_PERIOD');
    const t5 = await newTenant(pg);
    const f5 = await approved('SUBSCRIPTION_OPEN', t5, await openPayload(INCLUDED, null, { period_anchor: '2026-12-01T00:00:00.000Z' }));
    expect(await outcome(applyAs(f5))).toBe('FAILED:FUTURE_EFFECTIVE_DATE');
    expect((await request(f5)).state).toBe('APPLY_FAILED'); // never APPLIED early; nothing scheduled
    for (const t of [t3, t4, t5]) expect((await openRows(t)).filter((r) => r.source === 'MANUAL')).toEqual([]);
    // A version that drops the envelope allowance: no usage treatment is defined.
    const noneId = randomUUID();
    await pg.query(
      `INSERT INTO subscription."Plan" (id, key, name, sellable, description, tenant_kind, sales_model, status, display_order, product_key)
       SELECT $1::uuid, 'aramo-sign-a6-test-none', 'A6 test none', false, description, tenant_kind, sales_model, 'ACTIVE', 951, product_key FROM subscription."Plan" WHERE key = $2`,
      [noneId, INCLUDED],
    );
    await publishTestPlanV1(pg, noneId);
    const t6 = await newTenant(pg);
    const s6 = await rawSubscription(pg, t6, { source: 'MANUAL' });
    const b6 = await domainSnapshot(pg, t6);
    expect(await outcome(applyAs(await approved('SUBSCRIPTION_CHANGE', t6, { subscription_id: s6, plan_key: 'aramo-sign-a6-test-none', plan_version_id: await publishedVersion(pg, 'aramo-sign-a6-test-none') })))).toBe('FAILED:USAGE_TREATMENT_UNDEFINED');
    expect(await domainSnapshot(pg, t6)).toEqual(b6);
    // Each failure wrote one APPLY_FAILED audit row carrying its code and explanation.
    const failed = (await pg.query(`SELECT payload FROM subscription."CommercialAuditEvent" WHERE tenant_id = ANY($1::uuid[]) AND event_type = 'COMMERCIAL_CHANGE_REQUEST_APPLY_FAILED' ORDER BY created_at, id`, [[t3, t4, t5, t6]])).rows.map((r) => r.payload);
    expect(failed.map((f) => f.failure)).toEqual(['USAGE_CROSS_PERIOD', 'USAGE_CROSS_PERIOD', 'FUTURE_EFFECTIVE_DATE', 'USAGE_TREATMENT_UNDEFINED']);
    for (const f of failed) expect(f.explanation.length).toBeGreaterThan(10);
  });

  // ---- CCP-A6-R TD-A6-3: apply-time revalidation -----------------------------------------

  it('A6R-REQ-1 (TD-B2-3) apply is REQUESTER-ONLY: another commercial_ops user (holding the requester scope), the approver and a super_admin are each refused NOT_REQUESTER with one audit row; nothing changes; the requester then applies', async () => {
    const t = await newTenant(pg);
    const id = await approved('SUBSCRIPTION_OPEN', t, await openPayload());
    const otherOps = await addOperator(pg, ['commercial_ops']);
    const superAdmin = await addOperator(pg, ['super_admin']);
    expect(await outcome(applyAs(id, otherOps, 'commercial_ops'))).toBe('ERROR:NOT_REQUESTER');
    expect(await outcome(applyAs(id, FA, 'finance_admin'))).toBe('ERROR:NOT_REQUESTER');
    expect(await outcome(applyAs(id, superAdmin, 'super_admin'))).toBe('ERROR:NOT_REQUESTER');
    expect(await openRows(t)).toEqual([]);
    expect(await request(id)).toMatchObject({ state: 'APPROVED', apply_attempts: 0 });
    const rows = (await pg.query(`SELECT actor_id, payload FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 AND event_type = 'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED' ORDER BY created_at, id`, [id])).rows;
    expect(rows.map((r) => [r.actor_id, r.payload.refusal])).toEqual([
      [otherOps, 'NOT_REQUESTER'],
      [FA, 'NOT_REQUESTER'],
      [superAdmin, 'NOT_REQUESTER'],
    ]);
    expect(await outcome(applyAs(id))).toBe('APPLIED');
  });

  it('A6R-REQ-3 a refused apply by an unauthorized actor writes exactly ONE refusal audit row even when the check runs before the apply transaction: finance_admin applying a support_admin request', async () => {
    const SA = await addOperator(pg, ['support_admin']);
    const t = await newTenant(pg);
    const r = await h.changeRequests.create(as(SA, 'support_admin'), { action_type: 'SUPPORT_EXTENSION', tenant_id: t, product_key: 'sign', payload: { operation: 'EXTEND', subscription_id: '019a0000-0000-7000-8000-0000000a6e03', requested_days: 30 }, reason: 'support', idempotency_key: key() }, A6_CTX);
    const refusedBy = async (user: string, role: string) => {
      try {
        await h.apply.apply(as(user, role), r.request.id, A6_CTX);
      } catch (e) {
        return (e as { code?: string }).code;
      }
      return 'APPLIED';
    };
    // Merge train TD-MERGE-31: CCP-A8 adds the SUPPORT_EXTENSION apply path (A8 payload schema), so
    // the same preflight now yields NOT_REQUESTER (finance_admin did not request it).
    expect(await refusedBy(FA, 'finance_admin')).toBe('NOT_REQUESTER');
    const rows = (await pg.query(`SELECT event_type, actor_id, payload FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 AND event_type LIKE 'COMMERCIAL_CHANGE_REQUEST_APPLY%' ORDER BY created_at, id`, [r.request.id])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_type: 'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED', actor_id: FA, payload: { refusal: 'NOT_REQUESTER' } });
    expect(typeof rows[0].payload.explanation).toBe('string');
  });

  it('A6R-REQ-2 (TD-B2-3) the request read exposes apply_actionable for the caller: true only for the requester of an APPROVED / APPLY_FAILED applicable request', async () => {
    const t = await newTenant(pg);
    const r = await h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type: 'SUBSCRIPTION_OPEN', tenant_id: t, product_key: 'sign', payload: await openPayload(), reason: 'actionable', idempotency_key: key() }, A6_CTX);
    const view = (user: string, role: string) => h.changeRequests.get(as(user, role), r.request.id, A6_CTX).then((v) => v.apply_actionable);
    expect(await view(OPS, 'commercial_ops')).toBe(false); // DRAFT
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), r.request.id, A6_CTX);
    expect(await view(OPS, 'commercial_ops')).toBe(false); // PENDING_APPROVAL
    await h.changeRequests.approve(as(FA, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
    expect(await view(OPS, 'commercial_ops')).toBe(true); // APPROVED, the requester
    expect(await view(FA, 'finance_admin')).toBe(false); // the approver
    expect(await view(await addOperator(pg, ['commercial_ops']), 'commercial_ops')).toBe(false); // another requester-scope holder
    expect(await view(OPS, 'read_only_auditor')).toBe(false); // the requester without the scope on this session
    await applyAs(r.request.id);
    expect(await view(OPS, 'commercial_ops')).toBe(false); // APPLIED
  });

  it('A6R-REV-1 the requester’s CURRENT authority is re-read in the apply transaction: a requester who lost commercial_ops is refused REQUESTER_NO_LONGER_AUTHORIZED (token still carries the scope); nothing changes', async () => {
    const maker = await addOperator(pg, ['commercial_ops']);
    const t = await newTenant(pg);
    const id = await approved('SUBSCRIPTION_OPEN', t, await openPayload(), FA, maker);
    await revokeRole(pg, maker, 'commercial_ops');
    const before = await domainSnapshot(pg, t, id);
    expect(await outcome(applyAs(id, maker))).toBe('ERROR:REQUESTER_NO_LONGER_AUTHORIZED');
    expect(await domainSnapshot(pg, t, id)).toEqual(before);
    expect(await request(id)).toMatchObject({ state: 'APPROVED', apply_attempts: 0 });
    await grantRole(pg, maker, 'commercial_ops');
    expect(await outcome(applyAs(id, maker))).toBe('APPLIED');
  });

  it('A6R-REV-2 NC-3 / NC-4 at apply: an approver whose D9 attestation was revoked after approving is refused (the chain is stale); the approval row is untouched', async () => {
    const signer = await addOperator(pg, ['finance_admin']);
    const t = await newTenant(pg);
    const id = await approved('SUBSCRIPTION_OPEN', t, await openPayload(), signer);
    const approvals = async () => (await pg.query(`SELECT row_to_json(a)::text j FROM subscription."CommercialApproval" a WHERE change_request_id = $1`, [id])).rows;
    const before = await approvals();
    await revokeAttestation(pg, signer);
    expect(await outcome(applyAs(id))).toBe('REFUSED:APPROVER_NO_LONGER_ELIGIBLE');
    expect(await approvals()).toEqual(before);
    expect(await openRows(t)).toEqual([]);
  });

  it('A6R-REV-3 the payload cannot change between approval and apply: the DB refuses an UPDATE of payload or checksum; a superuser bypass is caught by the bound checksum (INTEGRITY)', async () => {
    const t = await newTenant(pg);
    const id = await approved('SUBSCRIPTION_OPEN', t, await openPayload());
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET payload = payload || '{"period_anchor":"2026-10-02T00:00:00.000Z"}'::jsonb WHERE id = $1`, [id])).toBe('CommercialChangeRequest payload, chain and identity are immutable');
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET payload_checksum = repeat('0', 64) WHERE id = $1`, [id])).toBe('CommercialChangeRequest payload, chain and identity are immutable');
    await pg.query(`ALTER TABLE subscription."CommercialChangeRequest" DISABLE TRIGGER commercial_change_request_guard_update`);
    await pg.query(`UPDATE subscription."CommercialChangeRequest" SET payload = payload || '{"period_anchor":"2026-10-02T00:00:00.000Z"}'::jsonb WHERE id = $1`, [id]);
    await pg.query(`ALTER TABLE subscription."CommercialChangeRequest" ENABLE TRIGGER commercial_change_request_guard_update`);
    expect(await outcome(applyAs(id))).toBe('ERROR:INTEGRITY');
    expect(await openRows(t)).toEqual([]);
  });

  it('A6-T12-1 tenant/product isolation: Sign open, change and end never read or touch the same tenant’s row of another product', async () => {
    await registerIsolationTestProduct(pg);
    const isoPlan = randomUUID();
    await pg.query(`INSERT INTO subscription."Plan" (id, key, name, sellable, sales_model, status, display_order, product_key) VALUES ($1, 'ccp-a6-iso-plan', 'ISO', false, 'OPERATOR', 'ACTIVE', 960, $2)`, [isoPlan, ISOLATION_TEST_PRODUCT_KEY]);
    await publishTestPlanV1(pg, isoPlan);
    const t = await newTenant(pg);
    const isoRow = randomUUID();
    await pg.query(
      `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by)
       VALUES ($1, $2, $3, (SELECT id FROM subscription."PlanVersion" WHERE plan_id = $3 AND status = 'PUBLISHED'), $4, 'BASE', '2026-09-01T00:00:00Z', 'MANUAL', 'iso')`,
      [isoRow, t, isoPlan, ISOLATION_TEST_PRODUCT_KEY],
    );
    const iso = async () => (await pg.query(`SELECT row_to_json(s)::text j FROM subscription."TenantSubscription" s WHERE id = $1`, [isoRow])).rows[0].j;
    const before = await iso();
    // The Sign open names no prior row: the other product's open MANUAL row is not "the open row".
    const sub = (await applyAs(await approved('SUBSCRIPTION_OPEN', t, await openPayload()))).application.subscription_id as string;
    await applyAs(await approved('SUBSCRIPTION_CHANGE', t, { subscription_id: sub, plan_key: PLAN_200, plan_version_id: await publishedVersion(pg, PLAN_200) }));
    // The other product's row cannot be targeted through a Sign request.
    expect(await outcome(applyAs(await approved('SUBSCRIPTION_END', t, { subscription_id: isoRow })))).toBe('FAILED:TARGET_NOT_FOUND');
    expect(await iso()).toBe(before);
  });

  it('A6-PUB-1 / A6-ASTRE-1 (TD-A5-1 ratified) an Astre-shaped MANUAL ACTIVE subscription on aramo-sign-included-v1 v1, with consumption: publishing v2 (other limits) and applying A6 transitions for OTHER tenants leaves its pin, effective limits, usage and entitlements byte-unchanged', async () => {
    const astre = await newTenant(pg);
    const v1 = await publishedVersion(pg, INCLUDED);
    const astreSub = await rawSubscription(pg, astre, { source: 'MANUAL' }); // pinned to v1, anchor 2026-10-01
    for (const c of ['core', 'sign']) await pg.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_source) VALUES ($1, $2::entitlement."Capability", 'PROVISIONING')`, [astre, c]);
    await consume(astre, 42, billingPeriodAt(new Date('2026-10-01T00:00:00Z'), T0).start);
    const astreState = async () => ({
      snapshot: await domainSnapshot(pg, astre),
      usage: await usageRows(astre),
      status: JSON.stringify(await h.allowance.getStatus(astre, 'sign', 'sign.envelopes', T0)),
      capacity: JSON.stringify(await h.lifecycle.account(astre, 'sign', 'sign.envelopes', T0)),
    });
    const before = await astreState();
    expect(JSON.parse(before.status)).toMatchObject({ limit: 100, used: 42, remaining: 58 });
    // Publish v2 of the same plan with different limits (catalog act; v1 → RETIRED).
    const repo = new PlanVersionRepository(prisma);
    const planId = (await pg.query(`SELECT id FROM subscription."Plan" WHERE key = $1`, [INCLUDED])).rows[0].id as string;
    const live = await repo.liveContent(planId);
    const content: PlanVersionContent = { ...live, allowances: live.allowances.map((a) => (a.allowance_key === 'sign.envelopes' ? { ...a, included_quantity: 250 } : a)) };
    const v2 = await repo.publish((await repo.createDraft({ plan_id: planId, content, created_by: 'ccp-a6-astre' })).id);
    expect((await pg.query(`SELECT status FROM subscription."PlanVersion" WHERE id = $1`, [v1])).rows[0].status).toBe('RETIRED');
    expect(await astreState()).toEqual(before);
    // A6 transitions for OTHER tenants.
    const o1 = await newTenant(pg);
    const opened = await applyAs(await approved('SUBSCRIPTION_OPEN', o1, { plan_key: INCLUDED, plan_version_id: v2.id, replaces_subscription_id: null }));
    expect(await h.allowance.getStatus(o1, 'sign', 'sign.envelopes', T0)).toMatchObject({ limit: 250 }); // the new subscriber gets v2
    const o2 = await newTenant(pg);
    const o2sub = await rawSubscription(pg, o2, { source: 'MANUAL' }); // on v2 now
    await applyAs(await approved('SUBSCRIPTION_END', o2, { subscription_id: o2sub }));
    await applyAs(await approved('ENTITLEMENT_GRANT', await newTenant(pg), { capabilities: ['sign'] }));
    await applyAs(await approved('SUBSCRIPTION_END', o1, { subscription_id: opened.application.subscription_id as string }));
    // A v1 pin cannot be newly assigned (RETIRED): G3.
    expect(await outcome(applyAs(await approved('SUBSCRIPTION_OPEN', await newTenant(pg), { plan_key: INCLUDED, plan_version_id: v1, replaces_subscription_id: null })))).toBe('FAILED:PLAN_VERSION_NOT_PUBLISHED');
    const after = await astreState();
    expect(after).toEqual(before);
    expect((await pg.query(`SELECT plan_version_id FROM subscription."TenantSubscription" WHERE id = $1`, [astreSub])).rows[0].plan_version_id).toBe(v1);
  });

  // ---- state transitions (the DB guard; one transaction) ---------------------------------

  it('A6-SM-DB the replaced guard: APPROVED → APPLIED / APPLY_FAILED directly refused; APPLYING must count the attempt and can never commit; APPLIED needs its application; APPLIED is frozen; non-A6 actions stay unreachable', async () => {
    const t = await newTenant(pg);
    const id = await approved('SUBSCRIPTION_OPEN', t, await openPayload());
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLIED', applied_at = now() WHERE id = $1`, [id])).toBe('CommercialChangeRequest state APPROVED -> APPLIED is not allowed');
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLY_FAILED' WHERE id = $1`, [id])).toBe('CommercialChangeRequest state APPROVED -> APPLY_FAILED is not allowed');
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING' WHERE id = $1`, [id])).toBe('CommercialChangeRequest APPLYING must count the attempt (apply_attempts 0 -> 0)');
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', apply_attempts = 1 WHERE id = $1`, [id])).toBe(`CommercialChangeRequest ${id} cannot commit in APPLYING (the apply is one transaction)`);
    await pg.query('BEGIN');
    await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', apply_attempts = 1 WHERE id = $1`, [id]);
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLIED', applied_at = now() WHERE id = $1`, [id])).toBe('CommercialChangeRequest cannot be APPLIED without its CommercialChangeApplication');
    // APPLYING → APPLY_FAILED in one transaction commits; APPLY_FAILED → APPLYING is the retry.
    await pg.query('BEGIN');
    await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', apply_attempts = 1 WHERE id = $1`, [id]);
    await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLY_FAILED' WHERE id = $1`, [id]);
    await pg.query('COMMIT');
    expect(await request(id)).toMatchObject({ state: 'APPLY_FAILED', apply_attempts: 1 });
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLIED', applied_at = now() WHERE id = $1`, [id])).toBe('CommercialChangeRequest state APPLY_FAILED -> APPLIED is not allowed');
    const out = await applyAs(id);
    expect(out.request).toMatchObject({ state: 'APPLIED', apply_attempts: 2 });
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLY_FAILED' WHERE id = $1`, [id])).toBe('CommercialChangeRequest in terminal state APPLIED is immutable');
    expect(await raises(`DELETE FROM subscription."CommercialChangeApplication" WHERE change_request_id = $1`, [id])).toBe('CommercialChangeApplication is append-only (DELETE rejected)');
    expect(await raises(`UPDATE subscription."CommercialChangeApplication" SET attempt = 9 WHERE change_request_id = $1`, [id])).toBe('CommercialChangeApplication is append-only (UPDATE rejected)');
    // A CREDIT (C4) has no apply transition yet.
    const credit = await h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type: 'CREDIT', tenant_id: await newTenant(pg), product_key: 'sign', payload: { amount_minor: 100, currency: 'USD' }, reason: 'credit', idempotency_key: key() }, A6_CTX);
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), credit.request.id, A6_CTX);
    await h.changeRequests.approve(as(FA2, 'finance_admin'), credit.request.id, { step_index: 0 }, A6_CTX);
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', apply_attempts = 1 WHERE id = $1`, [credit.request.id])).toBe('CommercialChangeRequest state APPROVED -> APPLYING is not allowed');
  });

  it('A6-SM-A9 preserved from CCP-A9: ROLE_GRANT / ROLE_REVOKE still move APPROVED → APPLYING → APPLIED after the A6 migration; APPLY_FAILED stays unreachable for them', async () => {
    const owner = await addOperator(pg, ['platform_owner']);
    const att = (await pg.query(`SELECT id FROM subscription."CommercialOperatorAttestation" WHERE user_id = $1 AND revoked_at IS NULL`, [owner])).rows[0].id as string;
    for (const action of ['ROLE_GRANT', 'ROLE_REVOKE']) {
      const id = randomUUID();
      const chain = { format_version: 1, rule: 'DISTINCT_PLATFORM_OWNER', basis: {}, steps: [{ step_index: 0, role_key: 'platform_owner', scope_keys: ['platform:subscription:approve'] }] };
      await pg.query(
        `INSERT INTO subscription."CommercialChangeRequest" (id, action_type, kind, state, payload, payload_checksum, required_chain, policy_version_id, policy_checksum, requested_by, reason, idempotency_key, created_at, updated_at)
         VALUES ($1, $2, 'NORMAL', 'DRAFT', $3::jsonb, $4, $5::jsonb, $6, $4, $7, 'role change', $8, now(), now())`,
        [id, action, JSON.stringify({ subject_user_id: FA2, role_key: 'finance_admin' }), 'c'.repeat(64), JSON.stringify(chain), POLICY_V1, OPS, `a9-preserved-${action}`],
      );
      await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'PENDING_APPROVAL', submitted_at = now(), expires_at = now() + interval '72 hours' WHERE id = $1`, [id]);
      await pg.query(
        `INSERT INTO subscription."CommercialApproval" (id, change_request_id, step_index, approver_user_id, step_role_key, step_scope_keys, approver_role_keys, attestation_id, created_at) VALUES (gen_random_uuid(), $1, 0, $2, 'platform_owner', ARRAY['platform:subscription:approve'], ARRAY['platform_owner'], $3, now())`,
        [id, owner, att],
      );
      await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPROVED', approved_at = now() WHERE id = $1`, [id]);
      await pg.query('BEGIN');
      await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING' WHERE id = $1`, [id]);
      expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLY_FAILED' WHERE id = $1`, [id])).toBe('CommercialChangeRequest state APPLYING -> APPLY_FAILED is not allowed');
      await pg.query('BEGIN');
      await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING' WHERE id = $1`, [id]);
      await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLIED', applied_at = now() WHERE id = $1`, [id]);
      await pg.query('COMMIT');
      expect((await request(id)).state).toBe('APPLIED');
    }
  });

  // ---- NC-5 b (last: it activates a second policy version) -------------------------------

  it('A6-NC5-b a policy-version change after creation: the apply revalidates under the request’s snapshot (v1), never the newer ACTIVE v2', async () => {
    const t = await newTenant(pg);
    const r = await h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type: 'SUBSCRIPTION_OPEN', tenant_id: t, product_key: 'sign', payload: await openPayload(), reason: 'open', idempotency_key: key() }, A6_CTX);
    const v1 = seededPolicyV1().content as Record<string, unknown>;
    const v2content = { ...v1, approval_expiry_hours: 24 };
    const v2 = await activatePolicyV2(pg, v2content, commercialPolicyChecksum(v2content));
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), r.request.id, A6_CTX);
    await h.changeRequests.approve(as(FA, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
    const out = await applyAs(r.request.id);
    expect(out.request).toMatchObject({ state: 'APPLIED', policy_version_id: POLICY_V1 });
    const pv = (await pg.query(`SELECT DISTINCT policy_version_id FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1`, [r.request.id])).rows.map((x) => x.policy_version_id);
    expect(pv).toEqual([POLICY_V1]);
    expect(v2).not.toBe(POLICY_V1);
    // The expiry was v1's 72 h, not v2's 24 h.
    const row = (await pg.query(`SELECT submitted_at, expires_at FROM subscription."CommercialChangeRequest" WHERE id = $1`, [r.request.id])).rows[0];
    expect((row.expires_at as Date).getTime() - (row.submitted_at as Date).getTime()).toBe(72 * 3_600_000);
  });
});

// Keep BUSINESS referenced for the shared harness (used by the hold spec).
void BUSINESS;
