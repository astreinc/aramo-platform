import { createHash } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BillingFinanceReportService, formatReconciliationReport, type ReconciliationReport } from '../lib/billing/billing-finance-report.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { addOperator, applyCcpA6Schema } from './support/ccp-a3-database.js';
import { A6_CTX, BUSINESS, INCLUDED, as, newTenant, publishedVersion, rawSubscription } from './support/ccp-a6.js';
import { type C1Harness, c1Harness } from './support/ccp-c1.js';

// CCP-C6 (PBD §5.2 row C6; Conversion Rule C-8) — the read-only Finance reports on real Postgres 17,
// with the real lifecycle, change-request, apply and command services and a FAKE Stripe in TEST
// mode (no network, no key). Every figure the reports return is reproduced here by an INDEPENDENT
// oracle: raw SQL over the commercial records (subscriptions, pinned plan versions, flags,
// intents, commands, inbox) and the effective entitlements (entitlement."TenantEntitlement"). Test
// IDs are cited by doc/ccp/slices/CCP-C6-acceptance.md.

const T0 = new Date('2026-10-26T12:00:00.000Z');
const DAY = 86_400_000;
const at = (days: number) => new Date(T0.getTime() + days * DAY);

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-C6 Finance reports (real Postgres 17, Stripe test mode)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let h: C1Harness;
  let reports: BillingFinanceReportService;
  let OPS: string;
  let FA: string;
  let keyN = 0;
  const key = () => `c6-key-${String(++keyN).padStart(6, '0')}`;
  const env = { ...process.env };
  const T: Record<string, string> = {};
  const S: Record<string, string> = {};

  const checkout = (tenant_id: string) =>
    h.lifecycle.startCheckout({ product_key: 'sign', tenant_id, user_id: 'owner-1', user_email: 'o@acme.test', plan_key: BUSINESS, success_url: 'https://e/ok', cancel_url: 'https://e/no', accept_terms: true });
  const lastCheckout = () => h.billing.checkouts[h.billing.checkouts.length - 1]!;
  const grant = (tenant_id: string, caps: string[]) =>
    pg.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) SELECT $1::uuid, c::entitlement."Capability" FROM unnest($2::text[]) c ON CONFLICT DO NOTHING`, [tenant_id, caps]);
  async function governedOpen(t: string): Promise<string> {
    const r = await h.changeRequests.create(
      as(OPS, 'commercial_ops'),
      { action_type: 'SUBSCRIPTION_OPEN', tenant_id: t, product_key: 'sign', payload: { plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED), replaces_subscription_id: null }, reason: 'governed open', idempotency_key: key() },
      A6_CTX,
    );
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), r.request.id, A6_CTX);
    await h.changeRequests.approve(as(FA, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
    return (await h.apply.apply(as(OPS, 'commercial_ops'), r.request.id, A6_CTX)).application.subscription_id as string;
  }
  /** A self-service row opened through checkout + the provider state (fake Stripe, test mode). */
  async function selfService(t: string, provider_status = 'active'): Promise<{ id: string; ref: string }> {
    expect(await checkout(t)).toBeDefined();
    const s = h.billing.state(t, lastCheckout().intent_id, { provider_status });
    await h.lifecycle.syncSubscription(s.subscription_ref, 'sign', at(-1));
    const r = await pg.query(`SELECT id::text FROM subscription."TenantSubscription" WHERE tenant_id = $1 AND ended_at IS NULL`, [t]);
    return { id: r.rows[0].id as string, ref: s.subscription_ref };
  }
  /** Every row of every table the reports read, hashed (the read-only oracle). */
  async function recordsHash(): Promise<string> {
    const tables = ['TenantSubscription', 'PlanVersion', 'BillingReconciliationFlag', 'CheckoutIntent', 'BillingProviderCommand', 'BillingWebhookInbox', 'BillingEvent', 'CommercialAuditEvent'];
    const parts: string[] = [];
    for (const tbl of tables) parts.push(JSON.stringify((await pg.query(`SELECT row_to_json(x)::text j FROM subscription."${tbl}" x ORDER BY 1`)).rows));
    parts.push(JSON.stringify((await pg.query(`SELECT tenant_id::text || ':' || capability::text j FROM entitlement."TenantEntitlement" ORDER BY 1`)).rows));
    return createHash('sha256').update(parts.join('\n')).digest('hex');
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    await applyCcpA6Schema(pg);
    prisma = new PrismaService(url);
    await prisma.$connect();
    process.env['STRIPE_PLAN_PRICES'] = `${BUSINESS}=price_business`;
    h = c1Harness(prisma, () => T0);
    reports = new BillingFinanceReportService(prisma, h.billing);
    OPS = await addOperator(pg, ['commercial_ops']);
    FA = await addOperator(pg, ['finance_admin']);

    // A — governed MANUAL (operator plan, no list price) through the real apply; commitment ends in 20 days.
    T['A'] = await newTenant(pg);
    S['A'] = await governedOpen(T['A']);
    await pg.query(`UPDATE subscription."TenantSubscription" SET commitment_start = $2, commitment_end = $3 WHERE id = $1`, [S['A'], at(-345), at(20)]);
    // B — self-service ACTIVE (Standard Business, USD 2000 / MONTH); the signup grant core + sign.
    T['B'] = await newTenant(pg);
    S['B'] = (await selfService(T['B'])).id;
    await grant(T['B'], ['core', 'sign']);
    // C — self-service PAST_DUE in grace; only 'core' granted (sign missing).
    T['C'] = await newTenant(pg);
    const c = await selfService(T['C']);
    S['C'] = c.id;
    h.billing.subs.set(c.ref, { ...h.billing.subs.get(c.ref)!, provider_status: 'past_due' });
    await h.lifecycle.syncSubscription(c.ref, 'sign', T0);
    await grant(T['C'], ['core']);
    // D — a HELD activation: checkout first, then the governed row, then the provider activation (A6 hold, C-7).
    T['D'] = await newTenant(pg);
    await checkout(T['D']);
    const intentD = lastCheckout().intent_id;
    S['D'] = await governedOpen(T['D']);
    const sD = h.billing.state(T['D'], intentD);
    expect((await h.lifecycle.syncSubscription(sD.subscription_ref, 'sign', T0)).outcome).toBe('IGNORED');
    T['D_ref'] = sD.subscription_ref;
    T['D_intent'] = intentD;
    // E — Sign entitled, no subscription.
    T['E'] = await newTenant(pg);
    await grant(T['E'], ['core', 'sign']);
    // G — a raw MANUAL row on Standard Business whose commitment lapsed 3 days ago; no entitlement.
    T['G'] = await newTenant(pg);
    S['G'] = await rawSubscription(pg, T['G'], { source: 'MANUAL', plan: BUSINESS });
    await pg.query(`UPDATE subscription."TenantSubscription" SET commitment_end = $2 WHERE id = $1`, [S['G'], at(-3)]);
  }, 300_000);

  afterAll(async () => {
    process.env = env;
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  // ── the independent oracle (raw SQL over the records) ─────────────────────────────────────

  async function oracleRenewals(within: number) {
    const r = await pg.query(
      `SELECT ts.id::text AS subscription_id, k.kind, k.at,
              (v.content->'plan'->>'list_price_minor')::int AS price, v.content->'plan'->>'currency' AS currency
         FROM subscription."TenantSubscription" ts
         JOIN subscription."PlanVersion" v ON v.id = ts.plan_version_id
         CROSS JOIN LATERAL (VALUES ('COMMITMENT_END', ts.commitment_end),
                                    ('PERIOD_END', CASE WHEN ts.billing_subscription_ref IS NOT NULL THEN ts.current_period_end END)) AS k(kind, at)
        WHERE ts.ended_at IS NULL AND ts.composition_role = 'BASE' AND ts.source IN ('MANUAL','SELF_SERVICE')
          AND k.at IS NOT NULL AND k.at <= $1::timestamptz
        ORDER BY k.at, ts.id, k.kind`,
      [at(within)],
    );
    return r.rows.map((x) => ({ subscription_id: x.subscription_id as string, kind: x.kind as string, at: (x.at as Date).toISOString(), amount_minor: x.currency === 'USD' ? (x.price as number | null) : null }));
  }

  async function oracleOutstanding() {
    const r = await pg.query(
      `SELECT ts.id::text AS subscription_id, ts.status, ts.grace_until, (v.content->'plan'->>'list_price_minor')::int AS price
         FROM subscription."TenantSubscription" ts JOIN subscription."PlanVersion" v ON v.id = ts.plan_version_id
        WHERE ts.ended_at IS NULL AND ts.composition_role = 'BASE' AND ts.source IN ('MANUAL','SELF_SERVICE') AND ts.status IN ('PAST_DUE','INCOMPLETE')
        ORDER BY ts.grace_until NULLS LAST, ts.id`,
    );
    return r.rows.map((x) => ({
      subscription_id: x.subscription_id as string,
      status: x.status as string,
      grace_state: x.grace_until === null ? 'NO_GRACE_DATE' : (x.grace_until as Date).getTime() > T0.getTime() ? 'IN_GRACE' : 'GRACE_ENDED',
      amount_minor: x.price as number | null,
    }));
  }

  async function oracleReconciliation() {
    const subs = await pg.query(
      `SELECT ts.id::text AS subscription_id, ts.tenant_id::text AS tenant_id, ts.source, ts.status,
              ARRAY(SELECT c FROM unnest(ARRAY['core','sign']) c WHERE NOT EXISTS (SELECT 1 FROM entitlement."TenantEntitlement" e WHERE e.tenant_id = ts.tenant_id AND e.capability::text = c) ORDER BY c) AS missing
         FROM subscription."TenantSubscription" ts WHERE ts.ended_at IS NULL AND ts.composition_role = 'BASE' ORDER BY ts.tenant_id, ts.product_key, ts.id`,
    );
    const orphan = await pg.query(
      `SELECT DISTINCT e.tenant_id::text AS tenant_id FROM entitlement."TenantEntitlement" e
        WHERE e.capability = 'sign' AND NOT EXISTS (SELECT 1 FROM subscription."TenantSubscription" ts WHERE ts.tenant_id = e.tenant_id AND ts.ended_at IS NULL AND ts.product_key = 'sign' AND ts.composition_role = 'BASE')
        ORDER BY 1`,
    );
    const held = await pg.query(
      `SELECT f.id::text AS flag_id, f.tenant_id::text AS tenant_id, f.subscription_ref, ci.status AS intent_status,
              (SELECT ts.id::text FROM subscription."TenantSubscription" ts WHERE ts.tenant_id = f.tenant_id AND ts.ended_at IS NULL AND ts.source = 'MANUAL') AS governed,
              (SELECT (v.content->'plan'->>'list_price_minor')::int FROM subscription."PlanVersion" v WHERE v.plan_id = ci.plan_id AND v.status = 'PUBLISHED') AS held_price
         FROM subscription."BillingReconciliationFlag" f LEFT JOIN subscription."CheckoutIntent" ci ON ci.id = f.intent_id
        WHERE f.resolved_at IS NULL AND f.reason = 'governed_subscription_open' ORDER BY f.detected_at, f.id`,
    );
    const bySource = await pg.query(`SELECT source, count(*)::int n FROM subscription."TenantSubscription" WHERE ended_at IS NULL AND composition_role = 'BASE' GROUP BY source ORDER BY source`);
    return { subs: subs.rows, orphan: orphan.rows.map((r) => r.tenant_id as string), held: held.rows, bySource: Object.fromEntries(bySource.rows.map((r) => [r.source, r.n])) };
  }

  // ── tests ─────────────────────────────────────────────────────────────────────────────────

  it('C6-REN-1 renewals reproduce the oracle exactly (subscription, kind, date, USD list price of the PINNED version); lapsed commitment listed', async () => {
    const r = await reports.renewals({ as_of: T0, within_days: 90 });
    expect(r.billing_provider_mode).toBe('test');
    // CCP-C5 — the designed disabled tax state on real Postgres.
    expect(r.tax).toEqual({ enabled: false, reason: 'STRIPE_TAX_NOT_REGISTERED' });
    expect(r.currency).toBe('USD');
    const got = r.items.map((i) => ({ subscription_id: i.subscription_id, kind: i.renewal_kind, at: i.renewal_at.toISOString(), amount_minor: i.list_price?.amount_minor ?? null }));
    expect(got).toEqual(await oracleRenewals(90));
    expect(r.counts.items).toBe(r.items.length);
    // Fixture facts: A (commitment +20 d, no list price), G (lapsed −3 d, USD 2000), B and C (period end 2026-11-25).
    const a = r.items.find((i) => i.subscription_id === S['A'])!;
    expect(a).toMatchObject({ renewal_kind: 'COMMITMENT_END', days_until: 20, lapsed: false, list_price: null, unpriced_reason: 'NO_LIST_PRICE', price_source: 'PINNED_PLAN_VERSION', source: 'MANUAL' });
    const g = r.items.find((i) => i.subscription_id === S['G'])!;
    expect(g).toMatchObject({ renewal_kind: 'COMMITMENT_END', days_until: -3, lapsed: true, list_price: { amount_minor: 2000, currency: 'USD', billing_interval: 'MONTH' } });
    for (const id of [S['B'], S['C']]) {
      expect(r.items.filter((i) => i.subscription_id === id && i.renewal_kind === 'PERIOD_END').map((i) => i.renewal_at.toISOString())).toEqual(['2026-11-25T00:00:00.000Z']);
    }
    expect(r.counts.lapsed).toBe(r.items.filter((i) => i.renewal_at.getTime() <= T0.getTime()).length);
    expect(r.items.every((i) => i.source === 'MANUAL' || i.source === 'SELF_SERVICE')).toBe(true);
    // A narrower horizon drops the period ends (30 d) and keeps A and G; the oracle agrees.
    const r10 = await reports.renewals({ as_of: T0, within_days: 10 });
    expect(r10.items.map((i) => ({ subscription_id: i.subscription_id, kind: i.renewal_kind, at: i.renewal_at.toISOString(), amount_minor: i.list_price?.amount_minor ?? null }))).toEqual(await oracleRenewals(10));
    expect(r10.items.some((i) => i.subscription_id === S['A'])).toBe(false);
    expect(r10.items.some((i) => i.subscription_id === S['G'])).toBe(true);
    await expect(reports.renewals({ as_of: T0, within_days: 0 })).rejects.toThrow(RangeError);
  });

  it('C6-OUT-1 outstanding payments reproduce the oracle (PAST_DUE in grace); amount due is never computed (C3 not delivered)', async () => {
    const r = await reports.outstandingPayments({ as_of: T0 });
    expect(r.tax).toEqual({ enabled: false, reason: 'STRIPE_TAX_NOT_REGISTERED' });
    expect(r.items.map((i) => ({ subscription_id: i.subscription_id, status: i.status, grace_state: i.grace_state, amount_minor: i.list_price?.amount_minor ?? null }))).toEqual(await oracleOutstanding());
    const c = r.items.find((i) => i.subscription_id === S['C'])!;
    expect(c).toMatchObject({ status: 'PAST_DUE', grace_state: 'IN_GRACE', amount_due: null, amount_due_reason: 'INVOICE_READ_NOT_DELIVERED', list_price: { amount_minor: 2000, currency: 'USD' } });
    expect(c.grace_until!.getTime()).toBeGreaterThan(T0.getTime());
    expect(r.items.every((i) => i.amount_due === null)).toBe(true);
    // Eight days later the same record is GRACE_ENDED (7-day policy grace); nothing else changes.
    const later = await reports.outstandingPayments({ as_of: at(8) });
    expect(later.items.find((i) => i.subscription_id === S['C'])!.grace_state).toBe('GRACE_ENDED');
    expect(later.counts).toMatchObject({ items: r.items.length, grace_ended: later.items.filter((i) => i.grace_state === 'GRACE_ENDED').length });
  });

  it('C6-REC-1 the reconciliation report reproduces the records and the effective entitlements', async () => {
    const r: ReconciliationReport = await reports.reconciliationReport({ as_of: T0 });
    const o = await oracleReconciliation();
    expect(r.billing_provider_mode).toBe('test');
    expect(r.tax).toEqual({ enabled: false, reason: 'STRIPE_TAX_NOT_REGISTERED' });
    expect(r.subscriptions.map((s) => ({ subscription_id: s.subscription_id, tenant_id: s.tenant_id, source: s.source, status: s.status, missing: s.entitlement.missing }))).toEqual(
      o.subs.map((s) => ({ subscription_id: s.subscription_id, tenant_id: s.tenant_id, source: s.source, status: s.status, missing: s.missing })),
    );
    expect(r.counts.open_subscriptions).toBe(o.subs.length);
    expect(r.counts.by_source).toEqual(o.bySource);
    expect(Object.values(r.counts.by_source).reduce((a, b) => a + b, 0)).toBe(r.counts.open_subscriptions);
    expect(r.entitled_without_subscription.map((e) => e.tenant_id)).toEqual(o.orphan);
    // Fixture facts.
    expect(r.subscriptions.find((s) => s.subscription_id === S['A'])).toMatchObject({ entitlement: { expected: ['core', 'sign'], present: ['core', 'sign'], missing: [] }, discrepancies: [] });
    expect(r.subscriptions.find((s) => s.subscription_id === S['B'])).toMatchObject({ discrepancies: [], list_price: { amount_minor: 2000, currency: 'USD' } });
    expect(r.subscriptions.find((s) => s.subscription_id === S['C'])).toMatchObject({ status: 'PAST_DUE', entitlement: { missing: ['sign'] }, discrepancies: ['ENTITLEMENT_MISSING'] });
    expect(r.subscriptions.find((s) => s.subscription_id === S['G'])).toMatchObject({ entitlement: { missing: ['core', 'sign'] }, discrepancies: ['ENTITLEMENT_MISSING'] });
    expect(r.entitled_without_subscription).toContainEqual(expect.objectContaining({ tenant_id: T['E'], product_key: 'sign', capabilities: ['sign'] }));
    expect(r.counts.subscriptions_with_discrepancy).toBe(r.subscriptions.filter((s) => s.discrepancies.length > 0).length);
    expect(r.counts.discrepancies).toEqual({ ENTITLEMENT_MISSING: o.subs.filter((s) => (s.missing as string[]).length > 0).length });
    expect(r.status).toBe('EXCEPTIONS');
    // The reconciliation output (acceptance evidence), tenant ids replaced by the fixture letters.
    const letter = new Map(Object.entries(T).filter(([k]) => k.length === 1).map(([k, v]) => [v, k]));
    const subLetter = new Map(Object.entries(S).map(([k, v]) => [v, `S${k}`]));
    const text = formatReconciliationReport(r).map((l) => l.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (u) => letter.get(u) ?? subLetter.get(u) ?? u));
    process.stdout.write(`${text.join('\n')}\n`);
    expect(r.counts.exceptions).toBe(r.counts.subscriptions_with_discrepancy + r.counts.entitled_without_subscription + r.counts.held_activations + r.counts.other_open_flags + r.counts.failed_commands + r.counts.failed_inbox_events);
  });

  it('C6-HELD-1 held activations are listed (Conv. C-8): the flag, the intent kept CREATED, the governed row, the held plan and its price', async () => {
    const r = await reports.reconciliationReport({ as_of: T0 });
    const o = await oracleReconciliation();
    expect(r.held_activations.map((x) => ({ flag_id: x.flag_id, tenant_id: x.tenant_id, subscription_ref: x.subscription_ref, intent_status: x.intent_status, governed: x.governed_subscription_id, held_price: x.held_price.list_price?.amount_minor ?? null }))).toEqual(
      o.held.map((x) => ({ flag_id: x.flag_id, tenant_id: x.tenant_id, subscription_ref: x.subscription_ref, intent_status: x.intent_status, governed: x.governed, held_price: x.held_price })),
    );
    expect(r.held_activations).toHaveLength(1);
    expect(r.held_activations[0]).toMatchObject({
      tenant_id: T['D'],
      product_key: 'sign',
      subscription_ref: T['D_ref'],
      intent_id: T['D_intent'],
      intent_status: 'CREATED',
      governed_subscription_id: S['D'],
      governed_plan_key: INCLUDED,
      held_plan_key: BUSINESS,
      held_price: { list_price: { amount_minor: 2000, currency: 'USD', billing_interval: 'MONTH' }, price_source: 'CURRENT_PUBLISHED_PLAN_VERSION' },
      unconfirmed_commands: [],
      resolution: 'UNRESOLVED',
    });
    // The governed row itself reconciles (granted by the apply) and carries the open flag reason.
    expect(r.subscriptions.find((s) => s.subscription_id === S['D'])).toMatchObject({ source: 'MANUAL', open_flag_reasons: ['governed_subscription_open'], discrepancies: [] });
    expect(r.counts.held_activations).toBe(1);
    expect(r.other_open_flags).toEqual([]);
  });

  it('C6-HELD-2 a held activation with a dispatched conversion command reads PENDING_PROVIDER; the flag stays listed until the provider-confirmed end (C-9, C-23)', async () => {
    // Merge train TD-MERGE-25: a C2-valid CONVERSION payload (C2 enforces the schema at create).
    const r0 = await h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type: 'CONVERSION', tenant_id: T['D'], product_key: 'sign', payload: { direction: 'TO_GOVERNED', held_subscription_ref: T['D_ref']!, governed_subscription_id: S['D']! }, reason: 'end the held self-service subscription', idempotency_key: key() }, A6_CTX);
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), r0.request.id, A6_CTX);
    await h.changeRequests.approve(as(FA, 'finance_admin'), r0.request.id, { step_index: 0 }, A6_CTX);
    await h.commands.enqueue({ change_request_id: r0.request.id, step: 'end_held', command_kind: 'SUBSCRIPTION_CANCEL', tenant_id: T['D']!, product_key: 'sign', target_ref: T['D_ref']!, mode: 'IMMEDIATE', created_by: OPS, at: T0 });
    expect((await h.commands.dispatchDue(T0)).accepted).toBe(1);
    const r = await reports.reconciliationReport({ as_of: T0, tenant_id: T['D'] });
    expect(r.held_activations).toHaveLength(1);
    expect(r.held_activations[0]!.resolution).toBe('PENDING_PROVIDER');
    expect(r.held_activations[0]!.unconfirmed_commands).toEqual([expect.objectContaining({ command_kind: 'SUBSCRIPTION_CANCEL', state: 'PENDING_PROVIDER', change_request_id: r0.request.id })]);
    // The provider-confirmed end (re-fetch) resolves the flag: the report no longer lists it.
    await h.commands.reconcilePending('sign', T0);
    const after = await reports.reconciliationReport({ as_of: T0, tenant_id: T['D'] });
    expect(after.held_activations).toEqual([]);
    expect(after.counts.unconfirmed_commands).toBe(0);
    expect(after.subscriptions.map((s) => s.subscription_id)).toEqual([S['D']]);
  });

  it('C6-FILTER-1 tenant and product filters scope every section; another tenant never appears', async () => {
    const r = await reports.reconciliationReport({ as_of: T0, tenant_id: T['C'], product_key: 'sign' });
    expect(r.subscriptions.map((s) => s.tenant_id)).toEqual([T['C']]);
    expect(r.held_activations).toEqual([]);
    expect(r.entitled_without_subscription).toEqual([]);
    const ren = await reports.renewals({ as_of: T0, tenant_id: T['G'] });
    expect(ren.items.map((i) => i.subscription_id)).toEqual([S['G']]);
    const out = await reports.outstandingPayments({ as_of: T0, tenant_id: T['B'] });
    expect(out.items).toEqual([]);
  });

  it('C6-RO-1 read-only: the reports change no record, and their transaction refuses a write', async () => {
    const before = await recordsHash();
    await reports.renewals({ as_of: T0 });
    await reports.outstandingPayments({ as_of: T0 });
    await reports.reconciliationReport({ as_of: T0 });
    expect(await recordsHash()).toBe(before);
    const readOnly = (reports as unknown as { readOnly: (fn: (tx: PrismaService) => Promise<unknown>) => Promise<unknown> }).readOnly.bind(reports);
    await expect(readOnly((tx) => tx.$executeRawUnsafe(`UPDATE subscription."TenantSubscription" SET status = status WHERE id = $1::uuid`, S['A']))).rejects.toThrow(/read-only transaction/);
    expect(await recordsHash()).toBe(before);
  });

  it('C6-USD-1 no currency other than USD is shown: a non-USD version price is withheld and flagged', async () => {
    // A fixture plan + PUBLISHED version priced in EUR, pinned by a raw MANUAL row (test database only).
    const t = await newTenant(pg);
    await pg.query(`INSERT INTO subscription."Plan" (id, key, name, product_key, sales_model, status, list_price_minor, currency, billing_interval) VALUES ('019a0000-c6c6-7000-8000-000000000001', 'c6-eur-fixture', 'EUR fixture', 'sign', 'OPERATOR', 'ACTIVE', 1900, 'EUR', 'MONTH')`);
    const content = await pg.query(`SELECT subscription.ccp_plan_live_content('019a0000-c6c6-7000-8000-000000000001'::uuid) AS c`);
    const c = content.rows[0].c;
    const { planVersionChecksum } = await import('../lib/plan-version.js');
    await pg.query(
      `INSERT INTO subscription."PlanVersion" (id, plan_id, version_number, status, content, content_checksum, created_by, created_at) VALUES ('019a0000-c6c6-7000-8000-000000000002', '019a0000-c6c6-7000-8000-000000000001', 1, 'DRAFT', $1::jsonb, $2, 'c6-spec', now())`,
      [JSON.stringify(c), planVersionChecksum(c)],
    );
    await pg.query(`UPDATE subscription."PlanVersion" SET status = 'PUBLISHED', published_at = now() WHERE id = '019a0000-c6c6-7000-8000-000000000002'`);
    const id = await rawSubscription(pg, t, { source: 'MANUAL', plan: 'c6-eur-fixture' });
    await grant(t, ['core', 'sign']);
    const r = await reports.reconciliationReport({ as_of: T0, tenant_id: t });
    expect(r.subscriptions).toEqual([expect.objectContaining({ subscription_id: id, list_price: null, unpriced_reason: 'NON_USD_CURRENCY', discrepancies: ['PRICE_NOT_USD'] })]);
    expect(JSON.stringify(r)).not.toContain('EUR');
  });

  it('TD-C6-6 (merge train, after CCP-A7) a governed revoke takes the capability out of the reconciliation: the revoked row is kept but no longer counts as present', async () => {
    const t = await newTenant(pg);
    const sub = await governedOpen(t);
    const before = await reports.reconciliationReport({ as_of: T0, tenant_id: t });
    expect(before.subscriptions).toEqual([expect.objectContaining({ subscription_id: sub, entitlement: expect.objectContaining({ present: ['core', 'sign'], missing: [] }), discrepancies: [] })]);
    const r = await h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type: 'ENTITLEMENT_REVOKE', tenant_id: t, product_key: 'sign', payload: { capabilities: ['sign'] }, reason: 'revoke sign', idempotency_key: key() }, A6_CTX);
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), r.request.id, A6_CTX);
    await h.changeRequests.approve(as(FA, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
    expect((await h.apply.apply(as(OPS, 'commercial_ops'), r.request.id, A6_CTX)).request.state).toBe('APPLIED');
    const kept = await pg.query(`SELECT revoked_at IS NOT NULL AS revoked FROM entitlement."TenantEntitlement" WHERE tenant_id = $1 AND capability = 'sign'`, [t]);
    expect(kept.rows).toEqual([{ revoked: true }]);
    const after = await reports.reconciliationReport({ as_of: T0, tenant_id: t });
    expect(after.subscriptions).toEqual([expect.objectContaining({ subscription_id: sub, entitlement: expect.objectContaining({ present: ['core'], missing: ['sign'] }), discrepancies: ['ENTITLEMENT_MISSING'] })]);
  });
});
