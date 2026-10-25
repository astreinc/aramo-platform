import { createHash, randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BillingRevenueReportService, REVENUE_EXCLUSION_REASONS, formatRevenueReport, type RevenueReport } from '../lib/billing/billing-revenue-report.service.js';
import { planVersionChecksum } from '../lib/plan-version.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { addOperator, applyCcpA6Schema } from './support/ccp-a3-database.js';
import { A6_CTX, BUSINESS, ENTERPRISE, INCLUDED, as, newTenant, publishedVersion, rawSubscription } from './support/ccp-a6.js';
import { type C1Harness, c1Harness } from './support/ccp-c1.js';

// CCP-D2 (PBD §5.4 row D2; A0-C6) — revenue reporting on real Postgres 17, with the real lifecycle,
// change-request, apply (incl. a B4 contract) services and a FAKE Stripe in TEST mode (no network, no
// key). Every figure is reproduced by an INDEPENDENT oracle: one raw SQL statement over the
// commercial records (open subscriptions, their pinned plan versions and the B4 contracts) that
// classifies, sums and buckets without any of the service's code. The figures are proven here, at
// the service level; the route withholds them (FINANCE_SCOPE_PENDING). Test IDs are cited by
// doc/ccp/slices/CCP-D2-acceptance.md.

const T0 = new Date('2026-10-26T12:00:00.000Z');
const DAY = 86_400_000;
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const PROFESSIONAL = 'aramo-sign-standard-professional-v1';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-D2 revenue reporting (real Postgres 17, Stripe test mode)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let h: C1Harness;
  let revenue: BillingRevenueReportService;
  let OPS: string;
  let FA: string;
  let keyN = 0;
  const key = () => `d2-key-${String(++keyN).padStart(6, '0')}`;
  const env = { ...process.env };
  const T: Record<string, string> = {};
  const S: Record<string, string> = {};

  const checkout = (tenant_id: string) =>
    h.lifecycle.startCheckout({ product_key: 'sign', tenant_id, user_id: 'owner-1', user_email: 'o@acme.test', plan_key: BUSINESS, success_url: 'https://e/ok', cancel_url: 'https://e/no', accept_terms: true });
  const lastCheckout = () => h.billing.checkouts[h.billing.checkouts.length - 1]!;
  async function governedOpen(t: string, plan_key: string, contract?: Record<string, unknown>): Promise<string> {
    const r = await h.changeRequests.create(
      as(OPS, 'commercial_ops'),
      { action_type: 'SUBSCRIPTION_OPEN', tenant_id: t, product_key: 'sign', payload: { plan_key, plan_version_id: await publishedVersion(pg, plan_key), replaces_subscription_id: null, ...(contract === undefined ? {} : { contract }) }, reason: 'governed open', idempotency_key: key() },
      A6_CTX,
    );
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), r.request.id, A6_CTX);
    await h.changeRequests.approve(as(FA, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
    const applied = await h.apply.apply(as(OPS, 'commercial_ops'), r.request.id, A6_CTX);
    expect(applied.request.state).toBe('APPLIED');
    return applied.application.subscription_id as string;
  }
  async function selfService(t: string, provider_status = 'active'): Promise<{ id: string; ref: string }> {
    expect(await checkout(t)).toBeDefined();
    const s = h.billing.state(t, lastCheckout().intent_id, { provider_status });
    await h.lifecycle.syncSubscription(s.subscription_ref, 'sign', at(-1));
    const r = await pg.query(`SELECT id::text FROM subscription."TenantSubscription" WHERE tenant_id = $1 AND ended_at IS NULL`, [t]);
    return { id: r.rows[0].id as string, ref: s.subscription_ref };
  }
  /** A fixture plan + PUBLISHED v1 (test database only), projected and checksummed as the catalog does. */
  async function fixturePlan(id: string, plan_key: string, price: number, currency: string, interval: string | null): Promise<void> {
    await pg.query(
      `INSERT INTO subscription."Plan" (id, key, name, product_key, sales_model, status, list_price_minor, currency, billing_interval) VALUES ($1::uuid, $2, $2, 'sign', 'OPERATOR', 'ACTIVE', $3, $4, $5)`,
      [id, plan_key, price, currency, interval],
    );
    const c = (await pg.query(`SELECT subscription.ccp_plan_live_content($1::uuid) AS c`, [id])).rows[0].c;
    const v = randomUUID();
    await pg.query(`INSERT INTO subscription."PlanVersion" (id, plan_id, version_number, status, content, content_checksum, created_by, created_at) VALUES ($1::uuid, $2::uuid, 1, 'DRAFT', $3::jsonb, $4, 'd2-spec', now())`, [v, id, JSON.stringify(c), planVersionChecksum(c)]);
    await pg.query(`UPDATE subscription."PlanVersion" SET status = 'PUBLISHED', published_at = now() WHERE id = $1::uuid`, [v]);
  }
  /** Every row of every table the report reads, hashed (the read-only oracle). */
  async function recordsHash(): Promise<string> {
    const parts: string[] = [];
    for (const tbl of ['TenantSubscription', 'Plan', 'PlanVersion', 'Contract', 'CommercialAuditEvent']) {
      parts.push(JSON.stringify((await pg.query(`SELECT row_to_json(x)::text j FROM subscription."${tbl}" x ORDER BY 1`)).rows));
    }
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
    revenue = new BillingRevenueReportService(prisma, h.billing);
    OPS = await addOperator(pg, ['commercial_ops']);
    FA = await addOperator(pg, ['finance_admin']);

    // A — governed MANUAL on the operator plan (no list price) → NO_LIST_PRICE; commitment ends in 20 days.
    T['A'] = await newTenant(pg);
    S['A'] = await governedOpen(T['A'], INCLUDED);
    await pg.query(`UPDATE subscription."TenantSubscription" SET commitment_start = $2, commitment_end = $3 WHERE id = $1`, [S['A'], at(-345), at(20)]);
    // B — self-service ACTIVE, Standard Business USD 2000 / MONTH → included; provider period end.
    T['B'] = await newTenant(pg);
    S['B'] = (await selfService(T['B'])).id;
    // C — self-service PAST_DUE (still recurring revenue) → included.
    T['C'] = await newTenant(pg);
    const c = await selfService(T['C']);
    S['C'] = c.id;
    h.billing.subs.set(c.ref, { ...h.billing.subs.get(c.ref)!, provider_status: 'past_due' });
    await h.lifecycle.syncSubscription(c.ref, 'sign', T0);
    // P — raw MANUAL Standard Professional USD 1500 / MONTH → included; commitment ends in 45 days.
    T['P'] = await newTenant(pg);
    S['P'] = await rawSubscription(pg, T['P'], { source: 'MANUAL', plan: PROFESSIONAL });
    await pg.query(`UPDATE subscription."TenantSubscription" SET commitment_end = $2 WHERE id = $1`, [S['P'], at(45)]);
    // G — raw MANUAL Standard Business whose commitment lapsed 3 days ago → included; LAPSED bucket.
    T['G'] = await newTenant(pg);
    S['G'] = await rawSubscription(pg, T['G'], { source: 'MANUAL', plan: BUSINESS });
    await pg.query(`UPDATE subscription."TenantSubscription" SET commitment_end = $2 WHERE id = $1`, [S['G'], at(-3)]);
    // K — governed open on Standard Business WITH a B4 enterprise contract → CONTRACT_PRICED (the list price is not the contract price).
    T['K'] = await newTenant(pg);
    S['K'] = await governedOpen(T['K'], BUSINESS, {
      contract_ref: 'D2-CT-0001',
      terms: ['Sign at a negotiated monthly price', 'Invoiced monthly, net 45'],
      documents: [{ name: 'Order form D2.pdf', sha256: createHash('sha256').update('d2-order-form').digest('hex') }],
    });
    // N — raw MANUAL Enterprise (CONTACT_SALES, no list price) → CONTRACT_PRICED.
    T['N'] = await newTenant(pg);
    S['N'] = await rawSubscription(pg, T['N'], { source: 'MANUAL', plan: ENTERPRISE });
    // I — raw SELF_SERVICE INCOMPLETE (provider-linked) → STATUS_NOT_REVENUE_BEARING; its period end still renews.
    T['I'] = await newTenant(pg);
    S['I'] = await rawSubscription(pg, T['I'], { source: 'SELF_SERVICE', plan: BUSINESS, ref: `sub_d2_${randomUUID()}`, status: 'INCOMPLETE' });
    await pg.query(`UPDATE subscription."TenantSubscription" SET current_period_end = $2 WHERE id = $1`, [S['I'], at(30)]);
    // E — raw MANUAL on a EUR-priced fixture version → NON_USD_CURRENCY (never converted).
    await fixturePlan('019a0000-d2d2-7000-8000-000000000001', 'd2-eur-fixture', 1900, 'EUR', 'MONTH');
    T['E'] = await newTenant(pg);
    S['E'] = await rawSubscription(pg, T['E'], { source: 'MANUAL', plan: 'd2-eur-fixture' });
    // Q — raw MANUAL on a USD price with no billing interval → NON_MONTHLY_INTERVAL (monthly only).
    await fixturePlan('019a0000-d2d2-7000-8000-000000000002', 'd2-no-interval-fixture', 900, 'USD', null);
    T['Q'] = await newTenant(pg);
    S['Q'] = await rawSubscription(pg, T['Q'], { source: 'MANUAL', plan: 'd2-no-interval-fixture' });
    // V — a DEVELOPMENT row (not commercial: neither revenue nor an exclusion).
    T['V'] = await newTenant(pg);
    S['V'] = await rawSubscription(pg, T['V'], { source: 'DEVELOPMENT', plan: INCLUDED });
    // X — an ENDED Standard Business row: not open, never counted.
    T['X'] = await newTenant(pg);
    S['X'] = await rawSubscription(pg, T['X'], { source: 'MANUAL', plan: BUSINESS });
    await pg.query(`UPDATE subscription."TenantSubscription" SET ended_at = $2 WHERE id = $1`, [S['X'], at(-10)]);
  }, 300_000);

  afterAll(async () => {
    process.env = env;
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  // ── the independent oracle: one SQL statement over the commercial records ─────────────────

  const CLASSIFY = `
    WITH open AS (
      SELECT ts.id::text AS subscription_id, ts.product_key, ts.source, ts.status, ts.commitment_end,
             CASE WHEN ts.billing_subscription_ref IS NOT NULL THEN ts.current_period_end END AS period_end,
             v.content->'plan' AS p,
             EXISTS (SELECT 1 FROM subscription."Contract" k WHERE k.tenant_subscription_id = ts.id) AS contracted
        FROM subscription."TenantSubscription" ts JOIN subscription."PlanVersion" v ON v.id = ts.plan_version_id
       WHERE ts.ended_at IS NULL AND ts.composition_role = 'BASE' AND ts.source IN ('MANUAL', 'SELF_SERVICE')
    )
    SELECT subscription_id, product_key, commitment_end, period_end,
           CASE WHEN status NOT IN ('ACTIVE', 'PAST_DUE') THEN 'STATUS_NOT_REVENUE_BEARING'
                WHEN contracted OR (p->>'list_price_minor' IS NULL AND p->>'sales_model' = 'CONTACT_SALES') THEN 'CONTRACT_PRICED'
                WHEN p->>'list_price_minor' IS NULL THEN 'NO_LIST_PRICE'
                WHEN p->>'currency' IS DISTINCT FROM 'USD' THEN 'NON_USD_CURRENCY'
                WHEN p->>'billing_interval' IS DISTINCT FROM 'MONTH' THEN 'NON_MONTHLY_INTERVAL'
           END AS reason,
           (p->>'list_price_minor')::bigint AS price
      FROM open`;

  async function oracle(as_of: Date, months: number) {
    const totals = await pg.query(
      `WITH c AS (${CLASSIFY})
       SELECT coalesce(sum(price) FILTER (WHERE reason IS NULL), 0)::bigint AS mrr,
              (coalesce(sum(price) FILTER (WHERE reason IS NULL), 0) * 12)::bigint AS arr,
              count(*)::int AS open_commercial, count(*) FILTER (WHERE reason IS NULL)::int AS included,
              count(*) FILTER (WHERE reason IS NOT NULL)::int AS excluded
         FROM c`,
    );
    const reasons = await pg.query(`WITH c AS (${CLASSIFY}) SELECT reason, count(*)::int AS n FROM c WHERE reason IS NOT NULL GROUP BY reason`);
    const rows = await pg.query(`WITH c AS (${CLASSIFY}) SELECT subscription_id, reason FROM c ORDER BY subscription_id`);
    const notCommercial = await pg.query(
      `SELECT source, count(*)::int AS n FROM subscription."TenantSubscription" WHERE ended_at IS NULL AND composition_role = 'BASE' AND source NOT IN ('MANUAL', 'SELF_SERVICE') GROUP BY source ORDER BY source`,
    );
    const pipeline = await pg.query(
      `WITH c AS (${CLASSIFY}),
            ev AS (SELECT c.*, k.kind, k.at FROM c CROSS JOIN LATERAL (VALUES ('commitment_end', c.commitment_end), ('period_end', c.period_end)) AS k(kind, at) WHERE k.at IS NOT NULL),
            b AS (SELECT CASE WHEN at <= $1::timestamptz THEN 'LAPSED' ELSE to_char(at AT TIME ZONE 'UTC', 'YYYY-MM') END AS month, kind, reason, price FROM ev),
            horizon AS (SELECT to_char(g AT TIME ZONE 'UTC', 'YYYY-MM') AS month FROM generate_series(date_trunc('month', $1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', (date_trunc('month', $1::timestamptz AT TIME ZONE 'UTC') + make_interval(months => $2::int - 1)) AT TIME ZONE 'UTC', interval '1 month') g
                        UNION ALL SELECT 'LAPSED')
       SELECT h.month,
              count(b.kind) FILTER (WHERE b.kind = 'commitment_end')::int AS commitment_end,
              count(b.kind) FILTER (WHERE b.kind = 'period_end')::int AS period_end,
              count(b.kind)::int AS events,
              count(b.kind) FILTER (WHERE b.reason IS NULL)::int AS priced_events,
              count(b.kind) FILTER (WHERE b.reason IS NOT NULL)::int AS unpriced_events,
              coalesce(sum(b.price) FILTER (WHERE b.reason IS NULL), 0)::int AS mrr_minor
         FROM horizon h LEFT JOIN b ON b.month = h.month
        GROUP BY h.month ORDER BY h.month = 'LAPSED' DESC, h.month`,
      [as_of, months],
    );
    const t = totals.rows[0];
    const [lapsed, ...by_month] = pipeline.rows.map((r) => ({ ...r }));
    return {
      mrr_minor: Number(t.mrr),
      arr_minor: Number(t.arr),
      counts: {
        open_commercial_subscriptions: t.open_commercial as number,
        included: t.included as number,
        excluded: t.excluded as number,
        excluded_by_reason: Object.fromEntries(REVENUE_EXCLUSION_REASONS.map((k) => [k, (reasons.rows.find((r) => r.reason === k)?.n as number | undefined) ?? 0])),
        not_commercial_by_source: Object.fromEntries(notCommercial.rows.map((r) => [r.source, r.n])),
      },
      rows: rows.rows.map((r) => ({ subscription_id: r.subscription_id as string, reason: (r.reason as string | null) ?? null })),
      pipeline: { lapsed, by_month },
    };
  }

  const summary = (r: RevenueReport) => ({
    mrr_minor: r.mrr_minor,
    arr_minor: r.arr_minor,
    counts: r.counts,
    rows: [...r.included.map((l) => ({ subscription_id: l.subscription_id, reason: null })), ...r.excluded.map((e) => ({ subscription_id: e.subscription_id, reason: e.reason as string | null }))].sort((a, b) => (a.subscription_id < b.subscription_id ? -1 : 1)),
    pipeline: { lapsed: r.renewal_pipeline.lapsed, by_month: r.renewal_pipeline.by_month },
  });

  // ── tests ─────────────────────────────────────────────────────────────────────────────────

  it('D2-REP-1 MRR, ARR, the per-row classification and the exclusion counts reproduce the oracle exactly', async () => {
    const r = await revenue.revenue({ as_of: T0 });
    expect(r).toMatchObject({ currency: 'USD', billing_interval: 'MONTH', basis: 'OPEN_SUBSCRIPTIONS_X_PINNED_LIST_PRICE', billing_provider_mode: 'test' });
    expect(summary(r)).toEqual(await oracle(T0, 12));
    // Fixture facts: B 2000 + C 2000 + P 1500 + G 2000.
    expect(r.mrr_minor).toBe(7500);
    expect(r.arr_minor).toBe(90000);
    expect(r.arr_minor).toBe(r.mrr_minor * 12);
    expect(r.by_product).toEqual([{ product_key: 'sign', subscriptions: 4, mrr_minor: 7500, arr_minor: 90000 }]);
    expect(r.included.map((l) => l.subscription_id).sort()).toEqual([S['B'], S['C'], S['P'], S['G']].sort());
    expect(r.included.find((l) => l.subscription_id === S['C'])).toMatchObject({ status: 'PAST_DUE', monthly_minor: 2000 });
    expect(r.included.find((l) => l.subscription_id === S['P'])).toMatchObject({ plan_key: PROFESSIONAL, monthly_minor: 1500 });
    // The output (acceptance evidence), tenant and subscription ids replaced by the fixture letters.
    const subLetter = new Map(Object.entries(S).map(([k, v]) => [v, `S${k}`]));
    process.stdout.write(`${formatRevenueReport(r).join('\n')}\n`);
    process.stdout.write(`${r.excluded.map((e) => `[revenue]   excluded ${subLetter.get(e.subscription_id) ?? e.subscription_id} ${e.source} ${e.status} plan=${e.plan_key} reason=${e.reason}`).join('\n')}\n`);
  });

  it('D2-EXC-1 exclusions are counted, each with one reason; nothing is converted or defaulted', async () => {
    const r = await revenue.revenue({ as_of: T0 });
    const reasonOf = (s: string) => r.excluded.find((e) => e.subscription_id === s)?.reason;
    expect(reasonOf(S['A']!)).toBe('NO_LIST_PRICE');
    expect(reasonOf(S['K']!)).toBe('CONTRACT_PRICED');
    expect(reasonOf(S['N']!)).toBe('CONTRACT_PRICED');
    expect(reasonOf(S['I']!)).toBe('STATUS_NOT_REVENUE_BEARING');
    expect(reasonOf(S['E']!)).toBe('NON_USD_CURRENCY');
    expect(reasonOf(S['Q']!)).toBe('NON_MONTHLY_INTERVAL');
    expect(r.counts).toEqual({
      open_commercial_subscriptions: 10,
      included: 4,
      excluded: 6,
      excluded_by_reason: { STATUS_NOT_REVENUE_BEARING: 1, PLAN_VERSION_INTEGRITY: 0, CONTRACT_PRICED: 2, NO_LIST_PRICE: 1, NON_USD_CURRENCY: 1, NON_MONTHLY_INTERVAL: 1 },
      not_commercial_by_source: { DEVELOPMENT: 1 },
    });
    // K's pinned version carries a USD list price (2000), yet a contract-linked row is never revenue at list price.
    const k = await pg.query(`SELECT (v.content->'plan'->>'list_price_minor')::int AS p FROM subscription."TenantSubscription" ts JOIN subscription."PlanVersion" v ON v.id = ts.plan_version_id WHERE ts.id = $1`, [S['K']]);
    expect(k.rows[0].p).toBe(2000);
    expect(r.included.some((l) => [S['V'], S['X']].includes(l.subscription_id)) || r.excluded.some((e) => [S['V'], S['X']].includes(e.subscription_id))).toBe(false);
    expect(JSON.stringify(r)).not.toContain('EUR');
  });

  it('D2-PIPE-1 the renewal pipeline by month reproduces the oracle (12 and 2 months)', async () => {
    const r = await revenue.revenue({ as_of: T0 });
    const o = await oracle(T0, 12);
    expect(r.renewal_pipeline).toMatchObject({ months: 12, from_month: '2026-10', through_month: '2027-09' });
    expect(r.renewal_pipeline.lapsed).toEqual(o.pipeline.lapsed);
    expect(r.renewal_pipeline.by_month).toEqual(o.pipeline.by_month);
    // Fixture facts: G lapsed (2000); A commitment 2026-11-15 (unpriced); B + C period end 2026-11-25 (2 × 2000); I period end 2026-11-25 (unpriced); P commitment 2026-12-10 (1500).
    expect(r.renewal_pipeline.lapsed).toMatchObject({ events: 1, commitment_end: 1, priced_events: 1, mrr_minor: 2000 });
    const nov = r.renewal_pipeline.by_month.find((b) => b.month === '2026-11')!;
    expect(nov).toMatchObject({ commitment_end: 1, period_end: 3, events: 4, priced_events: 2, unpriced_events: 2, mrr_minor: 4000 });
    expect(r.renewal_pipeline.by_month.find((b) => b.month === '2026-12')).toMatchObject({ commitment_end: 1, events: 1, priced_events: 1, mrr_minor: 1500 });
    const short = await revenue.revenue({ as_of: T0, months: 2 });
    expect({ lapsed: short.renewal_pipeline.lapsed, by_month: short.renewal_pipeline.by_month }).toEqual((await oracle(T0, 2)).pipeline);
    expect(short.renewal_pipeline.by_month.map((b) => b.month)).toEqual(['2026-10', '2026-11']);
    expect(short.mrr_minor).toBe(r.mrr_minor);
    await expect(revenue.revenue({ as_of: T0, months: 0 })).rejects.toThrow(RangeError);
  });

  it('D2-REP-2 the figures follow the records: a further included row changes MRR by its pinned price, and the oracle agrees', async () => {
    const before = await revenue.revenue({ as_of: T0 });
    const t = await newTenant(pg);
    const id = await rawSubscription(pg, t, { source: 'MANUAL', plan: PROFESSIONAL });
    const after = await revenue.revenue({ as_of: T0 });
    expect(after.mrr_minor - before.mrr_minor).toBe(1500);
    expect(summary(after)).toEqual(await oracle(T0, 12));
    await pg.query(`UPDATE subscription."TenantSubscription" SET ended_at = now() WHERE id = $1`, [id]);
    expect((await revenue.revenue({ as_of: T0 })).mrr_minor).toBe(before.mrr_minor);
  });

  it('D2-FILTER-1 the product filter scopes the report (sign is the whole closed registry in v1)', async () => {
    const all = await revenue.revenue({ as_of: T0 });
    const sign = await revenue.revenue({ as_of: T0, product_key: 'sign' });
    expect(summary(sign)).toEqual(summary(all));
    await expect(revenue.revenue({ as_of: T0, product_key: 'ats' as never })).rejects.toThrow();
  });

  it('D2-RO-1 no ledger and no stored figure: the report writes nothing, its transaction refuses a write, and no table stores a revenue figure', async () => {
    const before = await recordsHash();
    await revenue.revenue({ as_of: T0 });
    await revenue.revenue({ as_of: T0, months: 24 });
    expect(await recordsHash()).toBe(before);
    const readOnly = (revenue as unknown as { readOnly: (fn: (tx: PrismaService) => Promise<unknown>) => Promise<unknown> }).readOnly.bind(revenue);
    await expect(readOnly((tx) => tx.$executeRawUnsafe(`UPDATE subscription."TenantSubscription" SET status = status WHERE id = $1::uuid`, S['B']))).rejects.toThrow(/read-only transaction/);
    expect(await recordsHash()).toBe(before);
    const stored = await pg.query(
      `SELECT table_schema, table_name, column_name FROM information_schema.columns
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND (column_name ~* '(^|_)(mrr|arr|revenue)(_|$)' OR table_name ~* '(revenue|mrr)')`,
    );
    expect(stored.rows).toEqual([]);
  });
});
