import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkoutCutoverReport, formatCheckoutCutoverReport } from '../lib/billing/checkout-cutover-check.js';
import { BillingRefusedError } from '../lib/billing/subscription-lifecycle.service.js';
import { CommercialApplyFailedError } from '../lib/commercial/commercial-apply.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { addOperator, applyCcpA6Schema } from './support/ccp-a3-database.js';
import { A6_CTX, BUSINESS, INCLUDED, a6Harness, as, newTenant, publishedVersion, rawSubscription, waitForAdvisoryWaiter, type A6Harness } from './support/ccp-a6.js';

// CCP-A6 — the D2/H5 hold (Conversion Rule C-1…C-10) and the C-16/C-17 read-only check, on
// real Postgres 17 with the real lifecycle, change-request and apply services. A checkout never
// ends a governed (MANUAL) row, at both points (checkout initiation and webhook application),
// including a CheckoutIntent that predates the governed row or the rule. Test IDs are cited by
// doc/ccp/slices/CCP-A6-acceptance.md.

const T0 = new Date('2026-10-25T12:00:00.000Z');
const REPO = resolve(__dirname, '../../../..');

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-A6 governed-subscription hold (real Postgres 17)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let lockHolder: Client;
  let prisma: PrismaService;
  let h: A6Harness;
  let OPS: string;
  let FA: string;
  let keyN = 0;
  const key = () => `a6-hold-key-${String(++keyN).padStart(6, '0')}`;
  const env = { ...process.env };

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
    process.env['STRIPE_PLAN_PRICES'] = `${BUSINESS}=price_business`;
    h = a6Harness(prisma, () => T0);
    OPS = await addOperator(pg, ['commercial_ops']);
    FA = await addOperator(pg, ['finance_admin']);
  }, 300_000);

  afterAll(async () => {
    process.env = env;
    await prisma?.$disconnect();
    await lockHolder?.end();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  const checkout = (tenant_id: string) =>
    h.lifecycle.startCheckout({ product_key: 'sign', tenant_id, user_id: 'owner-1', user_email: 'o@acme.test', plan_key: BUSINESS, success_url: 'https://e/ok', cancel_url: 'https://e/no', accept_terms: true });
  async function reason(p: Promise<unknown>): Promise<string> {
    try {
      await p;
      return 'OK';
    } catch (e) {
      if (e instanceof BillingRefusedError) return e.reason;
      throw e;
    }
  }
  /** A governed MANUAL row opened through the real governed path (approve + apply). */
  async function governedOpen(t: string, replaces: string | null = null): Promise<string> {
    const r = await h.changeRequests.create(
      as(OPS, 'commercial_ops'),
      { action_type: 'SUBSCRIPTION_OPEN', tenant_id: t, product_key: 'sign', payload: { plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED), replaces_subscription_id: replaces }, reason: 'governed open', idempotency_key: key() },
      A6_CTX,
    );
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), r.request.id, A6_CTX);
    await h.changeRequests.approve(as(FA, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
    return (await h.apply.apply(as(OPS, 'commercial_ops'), r.request.id, A6_CTX)).application.subscription_id as string;
  }
  async function governedEnd(t: string, subscription_id: string): Promise<void> {
    const r = await h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type: 'SUBSCRIPTION_END', tenant_id: t, product_key: 'sign', payload: { subscription_id }, reason: 'governed end', idempotency_key: key() }, A6_CTX);
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), r.request.id, A6_CTX);
    await h.changeRequests.approve(as(FA, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
    await h.apply.apply(as(OPS, 'commercial_ops'), r.request.id, A6_CTX);
  }
  /** A CheckoutIntent written raw (one that predates the governed row, or the rule itself). */
  async function rawIntent(t: string, session = true): Promise<string> {
    const id = randomUUID();
    await pg.query(
      `INSERT INTO subscription."CheckoutIntent" (id, tenant_id, user_id, plan_id, provider, provider_session_ref, created_at) SELECT $1::uuid, $2::uuid, 'owner-1', p.id, 'STRIPE', $3, $4::timestamptz FROM subscription."Plan" p WHERE p.key = $5`,
      [id, t, session ? `cs_${id}` : null, '2026-10-20T09:00:00.000Z', BUSINESS],
    );
    return id;
  }
  const rowJson = async (id: string) => (await pg.query(`SELECT row_to_json(s)::text j FROM subscription."TenantSubscription" s WHERE id = $1`, [id])).rows[0].j as string;
  const openRows = async (t: string) => (await pg.query(`SELECT source FROM subscription."TenantSubscription" WHERE tenant_id = $1 AND ended_at IS NULL ORDER BY source`, [t])).rows.map((r) => r.source as string);
  const intentStatus = async (id: string) => (await pg.query(`SELECT status FROM subscription."CheckoutIntent" WHERE id = $1`, [id])).rows[0].status as string;
  const openFlags = async (t: string) => (await pg.query(`SELECT reason FROM subscription."BillingReconciliationFlag" WHERE tenant_id = $1 AND resolved_at IS NULL ORDER BY reason`, [t])).rows.map((r) => r.reason as string);
  const allFlags = async (t: string) =>
    (await pg.query(`SELECT reason, resolved_at IS NOT NULL AS resolved FROM subscription."BillingReconciliationFlag" WHERE tenant_id = $1 ORDER BY reason, detected_at`, [t])).rows;
  const intents = async (t: string) => (await pg.query(`SELECT count(*)::int n FROM subscription."CheckoutIntent" WHERE tenant_id = $1`, [t])).rows[0].n as number;
  const webhook = (ref: string, n: string) => h.lifecycle.handleEvent({ id: `evt_${n}_${ref}`, type: 'subscription.updated', created: T0, subscription_ref: ref }, 'sign', T0);

  // ---- point 1: checkout initiation (C-1…C-5) -------------------------------------------

  it('A6-H-C1 checkout is refused GOVERNED_SUBSCRIPTION_OPEN while a governed MANUAL row is open: no intent, no provider session, no provider account call', async () => {
    const t = await newTenant(pg);
    await governedOpen(t);
    const accounts = h.billing.accounts.length;
    const sessions = h.billing.checkouts.length;
    expect(await reason(checkout(t))).toBe('GOVERNED_SUBSCRIPTION_OPEN');
    expect(await intents(t)).toBe(0);
    expect(h.billing.accounts.length).toBe(accounts);
    expect(h.billing.checkouts.length).toBe(sessions);
  });

  it('A6-H-C5 preserved: an open SELF_SERVICE row still refuses ALREADY_SUBSCRIBED (C-5); a DEVELOPMENT row is still replaceable', async () => {
    const t = await newTenant(pg);
    await rawSubscription(pg, t, { source: 'SELF_SERVICE', ref: `sub_ss_${t}` });
    expect(await reason(checkout(t))).toBe('ALREADY_SUBSCRIBED');
    const d = await newTenant(pg);
    await rawSubscription(pg, d, { source: 'DEVELOPMENT' });
    expect(await reason(checkout(d))).toBe('OK');
    const c = h.billing.checkouts[h.billing.checkouts.length - 1]!;
    const s = h.billing.state(d, c.intent_id);
    expect(await h.lifecycle.syncSubscription(s.subscription_ref, 'sign', T0)).toMatchObject({ outcome: 'APPLIED', detail: 'opened ACTIVE (ended DEVELOPMENT)' });
  });

  it('A6-H-C2 the checkout decision is taken under the billing lock: a governed row committed while the checkout waits on the lock refuses it (no intent, no session)', async () => {
    const t = await newTenant(pg);
    await lockHolder.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`billing:${t}`]);
    const sessions = h.billing.checkouts.length;
    let pending: Promise<string>;
    try {
      pending = reason(checkout(t)); // the early read sees no row; the transaction then waits
      await waitForAdvisoryWaiter(pg);
      // A governed row commits while the checkout is blocked (a raw MANUAL row: the apply
      // would itself wait on the same lock, which the test session holds).
      await rawSubscription(pg, t, { source: 'MANUAL' });
    } finally {
      await lockHolder.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`billing:${t}`]);
    }
    expect(await pending!).toBe('GOVERNED_SUBSCRIPTION_OPEN');
    expect(await intents(t)).toBe(0);
    expect(h.billing.checkouts.length).toBe(sessions);
  });

  // ---- point 2: webhook application (C-6…C-10) ------------------------------------------

  it('A6-H-W1 a checkout started before the governed row: its activation is HELD — flag raised, intent kept CREATED, event IGNORED, the governed row unchanged, no SELF_SERVICE row', async () => {
    const t = await newTenant(pg);
    expect(await reason(checkout(t))).toBe('OK'); // no governed row yet
    const c = h.billing.checkouts[h.billing.checkouts.length - 1]!;
    const gov = await governedOpen(t); // the governed row opens afterwards
    const before = await rowJson(gov);
    const s = h.billing.state(t, c.intent_id);
    const res = await webhook(s.subscription_ref, 'w1');
    expect(res).toMatchObject({ outcome: 'IGNORED', detail: expect.stringContaining('governed_subscription_open: held for reconciliation') });
    expect(await openFlags(t)).toEqual(['governed_subscription_open']);
    expect(await intentStatus(c.intent_id)).toBe('CREATED');
    expect(await rowJson(gov)).toBe(before);
    expect(await openRows(t)).toEqual(['MANUAL']);
    const evt = (await pg.query(`SELECT outcome, detail FROM subscription."BillingEvent" WHERE tenant_id = $1`, [t])).rows;
    expect(evt).toEqual([{ outcome: 'IGNORED', detail: expect.stringContaining('governed_subscription_open') }]);
    // A redelivery / later sync keeps exactly one open flag (partial unique index).
    expect((await h.lifecycle.syncSubscription(s.subscription_ref, 'sign', T0)).outcome).toBe('IGNORED');
    expect(await allFlags(t)).toEqual([{ reason: 'governed_subscription_open', resolved: false }]);
  });

  it('A6-H-W2 a CheckoutIntent that predates the rule (written before A6, with or without a session) is held the same way', async () => {
    for (const session of [true, false]) {
      const t = await newTenant(pg);
      const intent = await rawIntent(t, session);
      const gov = await rawSubscription(pg, t, { source: 'MANUAL' });
      const before = await rowJson(gov);
      const s = h.billing.state(t, intent);
      expect(await h.lifecycle.syncSubscription(s.subscription_ref, 'sign', T0)).toMatchObject({ outcome: 'IGNORED' });
      expect(await openFlags(t)).toEqual(['governed_subscription_open']);
      expect(await intentStatus(intent)).toBe('CREATED');
      expect(await rowJson(gov)).toBe(before);
      expect(await openRows(t)).toEqual(['MANUAL']);
    }
  });

  it('A6-H-W3 a non-sending provider state (incomplete) is held as well; the governed row is never ended', async () => {
    const t = await newTenant(pg);
    const intent = await rawIntent(t);
    await rawSubscription(pg, t, { source: 'MANUAL' });
    const s = h.billing.state(t, intent, { provider_status: 'incomplete' });
    expect((await h.lifecycle.syncSubscription(s.subscription_ref, 'sign', T0)).outcome).toBe('IGNORED');
    expect(await openFlags(t)).toEqual(['governed_subscription_open']);
    expect(await openRows(t)).toEqual(['MANUAL']);
  });

  it('A6-H-C10 hold reasons compose (country + domain + governed, each its own flag); C-9 a later sync resolves each only when its conflict is gone; after a governed end the activation opens', async () => {
    const t = await newTenant(pg);
    const intent = await rawIntent(t);
    const gov = await governedOpen(t);
    h.orgProfile.authoritative = false;
    try {
      const s = h.billing.state(t, intent, { account_country: 'CA' });
      const r1 = await h.lifecycle.syncSubscription(s.subscription_ref, 'sign', T0);
      expect(r1.outcome).toBe('IGNORED');
      expect(r1.detail).toContain('billing_country_not_supported');
      expect(r1.detail).toContain('domain_verification_required');
      expect(r1.detail).toContain('governed_subscription_open');
      expect(await openFlags(t)).toEqual(['billing_country_not_supported', 'domain_not_authoritative', 'governed_subscription_open']);
      // Country and domain fixed: those two resolve; the governed hold remains.
      h.orgProfile.authoritative = true;
      h.billing.state(t, intent, { account_country: 'US' });
      const r2 = await h.lifecycle.syncSubscription(s.subscription_ref, 'sign', T0);
      expect(r2).toMatchObject({ outcome: 'IGNORED', detail: expect.stringContaining('governed_subscription_open') });
      expect(r2.detail).not.toContain('billing_country_not_supported');
      expect(await openFlags(t)).toEqual(['governed_subscription_open']);
      expect(await intentStatus(intent)).toBe('CREATED');
      // A governed end of the governed row (C-9): the next sync passes C-6 and opens.
      await governedEnd(t, gov);
      const r3 = await h.lifecycle.syncSubscription(s.subscription_ref, 'sign', T0);
      expect(r3).toMatchObject({ outcome: 'APPLIED', detail: 'opened ACTIVE' });
      expect(await openFlags(t)).toEqual([]);
      expect(await allFlags(t)).toEqual([
        { reason: 'billing_country_not_supported', resolved: true },
        { reason: 'domain_not_authoritative', resolved: true },
        { reason: 'governed_subscription_open', resolved: true },
      ]);
      expect(await intentStatus(intent)).toBe('COMPLETED');
      expect(await openRows(t)).toEqual(['SELF_SERVICE']);
    } finally {
      h.orgProfile.authoritative = true;
    }
  });

  it('A6-H-C9 a webhook-confirmed end of the provider subscription resolves the governed flag and opens nothing', async () => {
    const t = await newTenant(pg);
    const intent = await rawIntent(t);
    await rawSubscription(pg, t, { source: 'MANUAL' });
    const s = h.billing.state(t, intent);
    await h.lifecycle.syncSubscription(s.subscription_ref, 'sign', T0);
    expect(await openFlags(t)).toEqual(['governed_subscription_open']);
    h.billing.state(t, intent, { provider_status: 'canceled' });
    expect((await h.lifecycle.syncSubscription(s.subscription_ref, 'sign', T0)).outcome).toBe('IGNORED');
    expect(await openFlags(t)).toEqual([]);
    expect(await openRows(t)).toEqual(['MANUAL']);
  });

  // ---- serialization: webhook and console under the one billing lock ----------------------

  it('A6-H-SER webhook activation and console apply for one tenant serialize under the billing lock; whichever commits second sees the first: never two open rows, never a governed row ended by a checkout', async () => {
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const t = await newTenant(pg);
      const intent = await rawIntent(t);
      const s = h.billing.state(t, intent);
      const r = await h.changeRequests.create(
        as(OPS, 'commercial_ops'),
        { action_type: 'SUBSCRIPTION_OPEN', tenant_id: t, product_key: 'sign', payload: { plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED), replaces_subscription_id: null }, reason: 'race', idempotency_key: key() },
        A6_CTX,
      );
      await h.changeRequests.submit(as(OPS, 'commercial_ops'), r.request.id, A6_CTX);
      await h.changeRequests.approve(as(FA, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
      await lockHolder.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`billing:${t}`]);
      let both: Promise<[string, string]>;
      try {
        both = Promise.all([
          h.apply.apply(as(OPS, 'commercial_ops'), r.request.id, A6_CTX).then(
            () => 'APPLIED',
            (e) => (e instanceof CommercialApplyFailedError ? `FAILED:${e.code}` : Promise.reject(e)),
          ),
          h.lifecycle.syncSubscription(s.subscription_ref, 'sign', T0).then((x) => x.outcome),
        ]);
        await waitForAdvisoryWaiter(pg, 2);
        // Both are blocked on the same lock: nothing has been written by either.
        expect(await openRows(t)).toEqual([]);
      } finally {
        await lockHolder.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`billing:${t}`]);
      }
      const [applied, synced] = await both!;
      const rows = await openRows(t);
      expect(rows).toHaveLength(1);
      if (rows[0] === 'MANUAL') {
        // Console first: the activation is held, the intent stays CREATED.
        expect([applied, synced]).toEqual(['APPLIED', 'IGNORED']);
        expect(await intentStatus(intent)).toBe('CREATED');
        expect(await openFlags(t)).toEqual(['governed_subscription_open']);
      } else {
        // Webhook first: the governed open finds a Stripe-owned row and fails closed (G1).
        expect([applied, synced, rows[0]]).toEqual(['FAILED:STRIPE_OWNED', 'APPLIED', 'SELF_SERVICE']);
      }
      outcomes.push(`${applied}|${synced}`);
    }
    expect(outcomes).toHaveLength(3);
  });

  // ---- C-16 / C-17 read-only pre-cutover check -------------------------------------------

  it('A6-C16 the read-only pre-cutover check lists (a)–(d), HALTs on a conflicting open intent (exit 1), writes nothing, and passes (exit 0) once none remains', async () => {
    // A fresh database holding only this fixture (the check reads every tenant).
    const c = new Client({ connectionString: container.getConnectionUri() });
    await c.connect();
    await c.query(`CREATE DATABASE a6_c16`);
    await c.end();
    const url = container.getConnectionUri().replace(/\/[^/]+$/, '/a6_c16');
    const db = new Client({ connectionString: url });
    await db.connect();
    try {
      await applyCcpA6Schema(db);
      const fx = { pg: db } as const;
      const t1 = '0190c160-0000-7000-8000-000000000001';
      const t2 = '0190c160-0000-7000-8000-000000000002';
      const t3 = '0190c160-0000-7000-8000-000000000003';
      for (const t of [t1, t2, t3]) await db.query(`INSERT INTO identity."Tenant" (id, name, updated_at) VALUES ($1, $2, now())`, [t, `C16 ${t.slice(-1)}`]);
      await rawSubscription(fx.pg, t1, { source: 'MANUAL' });
      await rawSubscription(fx.pg, t2, { source: 'MANUAL' });
      await rawSubscription(fx.pg, t3, { source: 'SELF_SERVICE', ref: 'sub_c16_3' });
      const ins = (id: string, t: string, session: string | null, status = 'CREATED') =>
        db.query(
          `INSERT INTO subscription."CheckoutIntent" (id, tenant_id, user_id, plan_id, provider, provider_session_ref, status, created_at) SELECT $1::uuid, $2::uuid, 'o', p.id, 'STRIPE', $3, $4, '2026-10-20T09:00:00.000Z' FROM subscription."Plan" p WHERE p.key = $5`,
          [id, t, session, status, BUSINESS],
        );
      await ins('0190c160-0000-7000-8000-0000000000a1', t1, 'cs_c16_1');
      await ins('0190c160-0000-7000-8000-0000000000a2', t2, null);
      await ins('0190c160-0000-7000-8000-0000000000a3', t2, 'cs_c16_3', 'EXPIRED');
      await ins('0190c160-0000-7000-8000-0000000000a4', t3, 'cs_c16_4');
      await db.query(
        `INSERT INTO subscription."BillingReconciliationFlag" (id, tenant_id, provider, subscription_ref, intent_id, reason) VALUES (gen_random_uuid(), $1, 'STRIPE', 'sub_c16_held', '0190c160-0000-7000-8000-0000000000a1', 'governed_subscription_open')`,
        [t1],
      );
      const fingerprint = async () =>
        (await db.query(`SELECT (SELECT count(*) FROM subscription."CheckoutIntent")::int a, (SELECT count(*) FROM subscription."TenantSubscription")::int b, (SELECT count(*) FROM subscription."BillingReconciliationFlag")::int c, (SELECT md5(string_agg(row_to_json(i)::text, ',' ORDER BY id)) FROM subscription."CheckoutIntent" i) d`)).rows[0];
      const before = await fingerprint();
      const reportClient = new Client({ connectionString: url });
      await reportClient.connect();
      const report = await checkoutCutoverReport(reportClient);
      await reportClient.end();
      expect(report.open_intents_with_manual).toEqual([
        { tenant_id: t1, intent_id: '0190c160-0000-7000-8000-0000000000a1', plan_key: BUSINESS, product_key: 'sign', created_at: '2026-10-20T09:00:00.000Z', has_session: true },
        { tenant_id: t2, intent_id: '0190c160-0000-7000-8000-0000000000a2', plan_key: BUSINESS, product_key: 'sign', created_at: '2026-10-20T09:00:00.000Z', has_session: false },
      ]);
      expect(report.open_subscriptions).toEqual([
        { product_key: 'sign', source: 'MANUAL', status: 'ACTIVE', n: 2 },
        { product_key: 'sign', source: 'SELF_SERVICE', status: 'ACTIVE', n: 1 },
      ]);
      expect(report.open_flags).toEqual([{ reason: 'governed_subscription_open', n: 1 }]);
      expect(report.manual_tenants.map((m) => [m.tenant_id, m.plan_key, m.status])).toEqual([
        [t1, INCLUDED, 'ACTIVE'],
        [t2, INCLUDED, 'ACTIVE'],
      ]);
      expect(report.halt).toBe(true);
      expect(await fingerprint()).toEqual(before);
      // The CLI: the dry-run output (recorded in the acceptance evidence) and the C-17 exit code.
      const run = promisify(execFile);
      const args = ['deploy/jiti-tsconfig-runner.mjs', 'libs/subscription/prisma/check-checkout-cutover.ts'];
      const halted = await run('node', args, { cwd: REPO, env: { ...process.env, DATABASE_URL: url } }).then(
        () => ({ code: 0, stdout: '' }),
        (e: { code: number; stdout: string }) => ({ code: e.code, stdout: e.stdout }),
      );
      expect(halted.code).toBe(1);
      expect(halted.stdout.trim().split('\n')).toEqual(formatCheckoutCutoverReport(report));
      console.log(`CCP-A6 C-16 dry-run output (exit ${halted.code}):\n${halted.stdout}`);
      expect(await fingerprint()).toEqual(before);
      // After the dispositions (the two intents expire), the check passes.
      await db.query(`UPDATE subscription."CheckoutIntent" SET status = 'EXPIRED' WHERE id IN ('0190c160-0000-7000-8000-0000000000a1', '0190c160-0000-7000-8000-0000000000a2')`);
      const ok = await run('node', args, { cwd: REPO, env: { ...process.env, DATABASE_URL: url } });
      expect(ok.stdout).toContain('[cutover-check] OK');
      console.log(`CCP-A6 C-16 dry-run output after dispositions (exit 0):\n${ok.stdout}`);
      // The session is READ ONLY: a write inside it is refused by Postgres.
      const ro = new Client({ connectionString: url });
      await ro.connect();
      await ro.query('BEGIN TRANSACTION READ ONLY');
      await expect(ro.query(`DELETE FROM subscription."CheckoutIntent"`)).rejects.toThrow(/read-only transaction/);
      await ro.query('ROLLBACK');
      await ro.end();
    } finally {
      await db.end();
    }
  });
});
