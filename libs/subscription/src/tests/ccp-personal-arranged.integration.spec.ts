import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BillingFinanceReportService } from '../lib/billing/billing-finance-report.service.js';
import { BillingRevenueReportService } from '../lib/billing/billing-revenue-report.service.js';
import { CommercialApplyFailedError } from '../lib/commercial/commercial-apply.service.js';
import { type CommercialActionType } from '../lib/commercial/commercial-change-request.js';
import { CommercialChangeRequestError } from '../lib/commercial/commercial-change-request.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { addOperator, applyCcpA6Schema } from './support/ccp-a3-database.js';
import { A6_CTX, BUSINESS, FREE_PERSONAL, a6Harness, as, newTenant, publishedVersion, rawSubscription, type A6Harness } from './support/ccp-a6.js';

// CCP-PERSONAL-ARRANGED-1 (Aramo-CCP-Personal-Arranged-Plan-Directive-v1_0-LOCKED §5.2) on real Postgres 17,
// every subscription migration applied whole-file (the shared A6 harness):
//   ARR-I-OPEN-*  P-1 / P-2 / P-3 — a FREE Personal row replaced by an arranged Personal Standard row;
//   ARR-I-REF-*   P-4 — the creation-time refusals;
//   ARR-I-RPT-*   P-3 — the finance and revenue reports with COMP and AGREED rows.

const T0 = new Date('2026-11-24T12:00:00.000Z');
const STANDARD_PERSONAL = 'aramo-sign-standard-personal-v1';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-PERSONAL-ARRANGED-1 arranged Personal plans (real Postgres 17)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let h: A6Harness;
  let OPS: string;
  let FA: string;
  let keyN = 0;
  // Set by ARR-I-OPEN-1 / -2, read by the report tests.
  const arranged: { comp?: { tenant: string; sub: string }; agreed?: { tenant: string; sub: string } } = {};
  const key = () => `arr-key-${String(++keyN).padStart(6, '0')}`;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    await applyCcpA6Schema(pg);
    prisma = new PrismaService(url);
    await prisma.$connect();
    h = a6Harness(prisma, () => T0);
    OPS = await addOperator(pg, ['commercial_ops']);
    FA = await addOperator(pg, ['finance_admin']);
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  const create = (action_type: CommercialActionType, tenant_id: string, payload: Record<string, unknown>) =>
    h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type, tenant_id, product_key: 'sign', payload, reason: 'arranged by Aramo', idempotency_key: key() }, A6_CTX);
  /** Create (commercial_ops) → submit → approve (finance_admin; SUBSCRIPTION_OPEN stays Finance only, D-1 unruled). */
  async function approved(action_type: CommercialActionType, tenant_id: string, payload: Record<string, unknown>): Promise<string> {
    const r = await create(action_type, tenant_id, payload);
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), r.request.id, A6_CTX);
    const a = await h.changeRequests.approve(as(FA, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
    expect(a.request.state).toBe('APPROVED');
    return r.request.id;
  }
  const applyAs = (id: string) => h.apply.apply(as(OPS, 'commercial_ops'), id, A6_CTX);
  const refusalOf = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return 'CREATED';
    } catch (e) {
      if (e instanceof CommercialChangeRequestError) return `${e.code}:${String(e.details['reason'])}`;
      if (e instanceof CommercialApplyFailedError) return `FAILED:${e.code}`;
      throw e;
    }
  };
  const row = async (id: string) => (await pg.query(`SELECT * FROM subscription."TenantSubscription" WHERE id = $1`, [id])).rows[0];
  const openRows = async (t: string) => (await pg.query(`SELECT id, source, status, arrangement, plan_id FROM subscription."TenantSubscription" WHERE tenant_id = $1 AND ended_at IS NULL`, [t])).rows;
  const events = async (id: string) =>
    (await pg.query(`SELECT event_type, payload FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 ORDER BY created_at, id`, [id])).rows as Array<{ event_type: string; payload: Record<string, unknown> }>;
  /** A PERSONAL tenant (ACTIVE: bound) on its system-opened FREE row. */
  async function personalOnFree(): Promise<{ tenant: string; free: string }> {
    const tenant = await newTenant(pg, 'PERSONAL');
    await pg.query(`UPDATE identity."Tenant" SET status = 'ACTIVE' WHERE id = $1`, [tenant]);
    const free = await rawSubscription(pg, tenant, { source: 'FREE', plan: FREE_PERSONAL });
    return { tenant, free };
  }
  const arrangedPayload = async (free: string, extra: Record<string, unknown> = {}) => ({
    plan_key: STANDARD_PERSONAL,
    plan_version_id: await publishedVersion(pg, STANDARD_PERSONAL),
    replaces_subscription_id: free,
    ...extra,
  });

  // ---- P-1 / P-2 / P-3 — the FREE replacement --------------------------------------------

  it('ARR-I-OPEN-1 FREE → COMP Standard for a PERSONAL tenant: the FREE row is ended (recorded as replaced, source FREE); the new MANUAL row is COMP with no commitment', async () => {
    const { tenant, free } = await personalOnFree();
    const id = await approved('SUBSCRIPTION_OPEN', tenant, await arrangedPayload(free, { arrangement: 'COMP', external_ref: 'HR-2026-0042' }));
    const out = await applyAs(id);
    expect(out.request.state).toBe('APPLIED');
    const ended = await row(free);
    expect(ended.ended_at?.toISOString()).toBe(T0.toISOString());
    expect(ended.status).toBe('CANCELED');
    const opened = await openRows(tenant);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ source: 'MANUAL', status: 'ACTIVE', arrangement: 'COMP' });
    const fresh = await row(opened[0].id as string);
    // P-3 (ruling R-3): a comp carries no commitment.
    expect(fresh.commitment_start).toBeNull();
    expect(fresh.commitment_end).toBeNull();
    arranged.comp = { tenant, sub: opened[0].id as string };
    // The replace keeps the FREE row's period anchor (same period).
    expect(fresh.period_anchor.toISOString()).toBe(ended.period_anchor.toISOString());
    expect(out.application?.replaced_subscription_id).toBe(free);
    const ev = await events(id);
    const endedEvent = ev.find((e) => e.event_type === 'COMMERCIAL_SUBSCRIPTION_ENDED');
    expect(endedEvent?.payload).toMatchObject({ subscription_id: free, source: 'FREE', replaced_by: opened[0].id });
    expect(ev.find((e) => e.event_type === 'COMMERCIAL_SUBSCRIPTION_OPENED')?.payload).toMatchObject({ arrangement: 'COMP', replaced_subscription_id: free });
    // D-6: the internal reference is kept in the frozen request payload.
    expect((await pg.query(`SELECT payload FROM subscription."CommercialChangeRequest" WHERE id = $1`, [id])).rows[0].payload).toMatchObject({ arrangement: 'COMP', external_ref: 'HR-2026-0042' });
  });

  it('ARR-I-OPEN-2 FREE → AGREED Standard: the row is AGREED and keeps the plan version commitment (as any managed row)', async () => {
    const { tenant, free } = await personalOnFree();
    const id = await approved('SUBSCRIPTION_OPEN', tenant, await arrangedPayload(free, { arrangement: 'AGREED' }));
    await applyAs(id);
    const [opened] = await openRows(tenant);
    expect(opened).toMatchObject({ source: 'MANUAL', arrangement: 'AGREED' });
    const fresh = await row(opened.id as string);
    arranged.agreed = { tenant, sub: opened.id as string };
    const months = (await pg.query(`SELECT (v.content->'plan'->>'commitment_months')::int AS m FROM subscription."PlanVersion" v WHERE v.id = $1`, [fresh.plan_version_id])).rows[0].m as number | null;
    if (months === null) expect(fresh.commitment_end).toBeNull();
    else expect(fresh.commitment_end).not.toBeNull();
  });

  // ---- P-4 — refused at creation ----------------------------------------------------------

  it('ARR-I-REF-1 a FREE replacement without an arrangement is refused at creation (arrangement_required); nothing is written', async () => {
    const { tenant, free } = await personalOnFree();
    expect(await refusalOf(create('SUBSCRIPTION_OPEN', tenant, await arrangedPayload(free)))).toBe('INVALID_INPUT:arrangement_required');
    expect((await pg.query(`SELECT count(*)::int AS n FROM subscription."CommercialChangeRequest" WHERE tenant_id = $1`, [tenant])).rows[0].n).toBe(0);
    expect(await openRows(tenant)).toEqual([expect.objectContaining({ id: free, source: 'FREE' })]);
  });

  it('ARR-I-REF-2 a BUSINESS tenant: a Personal plan is refused (plan_tenant_kind_mismatch); a FREE row is never replaced for it (free_replacement_not_personal)', async () => {
    const business = await newTenant(pg, 'BUSINESS');
    expect(await refusalOf(create('SUBSCRIPTION_OPEN', business, { plan_key: STANDARD_PERSONAL, plan_version_id: await publishedVersion(pg, STANDARD_PERSONAL), replaces_subscription_id: null, arrangement: 'COMP' }))).toBe(
      'INVALID_INPUT:plan_tenant_kind_mismatch',
    );
    // A FREE row on a BUSINESS tenant does not occur in production (Personal Free v1.1); inserted raw to prove the rule.
    const odd = await newTenant(pg, 'BUSINESS');
    const free = await rawSubscription(pg, odd, { source: 'FREE', plan: FREE_PERSONAL });
    expect(await refusalOf(create('SUBSCRIPTION_OPEN', odd, { plan_key: BUSINESS, plan_version_id: await publishedVersion(pg, BUSINESS), replaces_subscription_id: free, arrangement: 'COMP' }))).toBe(
      'INVALID_INPUT:free_replacement_not_personal',
    );
  });

  it('ARR-I-REF-3 the apply re-checks the tenant kind (NC-5): an approved FREE replacement whose tenant is no longer PERSONAL fails; the FREE row stays open', async () => {
    const { tenant, free } = await personalOnFree();
    const id = await approved('SUBSCRIPTION_OPEN', tenant, await arrangedPayload(free, { arrangement: 'COMP' }));
    // The tenant stops being PERSONAL after approval (fixture only).
    await pg.query(`UPDATE identity."Tenant" SET kind = 'BUSINESS' WHERE id = $1`, [tenant]);
    try {
      expect(await refusalOf(applyAs(id))).toBe('FAILED:PLAN_TENANT_KIND_MISMATCH');
    } finally {
      await pg.query(`UPDATE identity."Tenant" SET kind = 'PERSONAL' WHERE id = $1`, [tenant]);
    }
    expect(await openRows(tenant)).toEqual([expect.objectContaining({ id: free, source: 'FREE' })]);
  });

  // ---- P-3 — the reports ------------------------------------------------------------------

  it('ARR-I-RPT-1 finance: a COMP row is "Comp ($0)" (amount 0, ARRANGEMENT_COMP) and never a renewal or an outstanding item; an AGREED row keeps its list price and renewal', async () => {
    const finance = new BillingFinanceReportService(prisma, h.billing);
    const comp = arranged.comp as { tenant: string; sub: string };
    const agreed = arranged.agreed as { tenant: string; sub: string };
    const rec = await finance.reconciliationReport({ tenant_id: comp.tenant, as_of: T0 });
    expect(rec.subscriptions).toHaveLength(1);
    expect(rec.subscriptions[0]).toMatchObject({ subscription_id: comp.sub, arrangement: 'COMP', list_price: { amount_minor: 0, currency: 'USD' }, unpriced_reason: null, price_source: 'ARRANGEMENT_COMP' });
    // Past-due, a COMP row still never shows as overdue (fixture only), nor as a renewal.
    await pg.query(`UPDATE subscription."TenantSubscription" SET status = 'PAST_DUE' WHERE id = $1`, [comp.sub]);
    try {
      expect((await finance.outstandingPayments({ tenant_id: comp.tenant, as_of: T0 })).items).toEqual([]);
    } finally {
      await pg.query(`UPDATE subscription."TenantSubscription" SET status = 'ACTIVE' WHERE id = $1`, [comp.sub]);
    }
    expect((await finance.renewals({ tenant_id: comp.tenant, as_of: T0, within_days: 365 })).items).toEqual([]);
    const agreedRec = await finance.reconciliationReport({ tenant_id: agreed.tenant, as_of: T0 });
    expect(agreedRec.subscriptions[0]).toMatchObject({ subscription_id: agreed.sub, arrangement: 'AGREED', price_source: 'PINNED_PLAN_VERSION' });
    expect(agreedRec.subscriptions[0]?.list_price?.amount_minor).toBeGreaterThan(0);
    const agreedRow = await row(agreed.sub);
    const renewals = await finance.renewals({ tenant_id: agreed.tenant, as_of: T0, within_days: 365 });
    expect(renewals.items.length).toBe(agreedRow.commitment_end !== null && agreedRow.commitment_end.getTime() <= T0.getTime() + 365 * 86_400_000 ? 1 : 0);
  });

  it('ARR-I-RPT-2 revenue: COMP rows are left out of the illustrative value and counted on their own line; AGREED rows are included at list price', async () => {
    const revenue = new BillingRevenueReportService(prisma, h.billing);
    const comp = arranged.comp as { tenant: string; sub: string };
    const agreed = arranged.agreed as { tenant: string; sub: string };
    const r = await revenue.revenue({ as_of: T0 });
    const compOpen = (
      await pg.query(`SELECT count(*)::int AS n FROM subscription."TenantSubscription" WHERE ended_at IS NULL AND composition_role = 'BASE' AND source IN ('MANUAL', 'SELF_SERVICE') AND arrangement = 'COMP'`)
    ).rows[0].n as number;
    expect(compOpen).toBeGreaterThanOrEqual(1);
    expect(r.counts.arranged_no_charge).toBe(compOpen);
    expect(r.counts.open_commercial_subscriptions).toBe(r.counts.included + r.counts.excluded + r.counts.arranged_no_charge);
    expect(r.included.some((l) => l.subscription_id === comp.sub)).toBe(false);
    expect(r.excluded.some((e) => e.subscription_id === comp.sub)).toBe(false);
    const line = r.included.find((l) => l.subscription_id === agreed.sub);
    expect(line).toBeDefined();
    const listPrice = (await pg.query(`SELECT (v.content->'plan'->>'list_price_minor')::int AS p FROM subscription."TenantSubscription" ts JOIN subscription."PlanVersion" v ON v.id = ts.plan_version_id WHERE ts.id = $1`, [agreed.sub])).rows[0].p as number;
    expect(line?.monthly_minor).toBe(listPrice);
  });
});
