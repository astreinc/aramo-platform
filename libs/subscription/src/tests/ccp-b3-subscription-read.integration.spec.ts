import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { billingPeriodAt } from '../lib/billing-period.js';
import { CommercialSubscriptionReadService, type OverviewProduct, type TenantCommercialOverview } from '../lib/commercial/commercial-subscription-read.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { ProductContextError } from '../lib/product-registry.js';

import { addOperator, applyCcpA6Schema } from './support/ccp-a3-database.js';
import { A6_CTX, BUSINESS, INCLUDED, as, publishedVersion } from './support/ccp-a6.js';
import { type C2Harness, c2Harness } from './support/ccp-c2.js';

// CCP-B3 (PBD §5.3 row B3; pre-execution record C-1) — the read-only Subscriptions workbench and
// tenant Commercial tab reads on real Postgres 17 (identity + entitlement + metering + EVERY
// subscription migration), with the fixtures written through the real governed services where a
// governed path exists (open + contract, revoke, conversion, support extension, held activation via
// the inbox) and raw rows only for Stripe-owned / historical state. No money is read or returned.
//
//   (A) MANUAL ACTIVE contract-linked row + an open governed_subscription_open flag (held
//       activation) + a withdrawn and a newer PENDING CONVERSION naming the held ref
//   (B) SELF_SERVICE PAST_DUE provider-linked row, grace in the future, a commitment_end, an
//       older ended row, an active bounded EXCEPTION support extension, an intent-less open flag
//       and a resolved flag
//   (C) only ended rows (the most recently ended one is the latest)
//   (D) governed row, `sign` revoked by a governed ENTITLEMENT_REVOKE, `ats` granted raw
//       (MIGRATION), an open (DRAFT) SUBSCRIPTION_CHANGE
//   (Z) a row whose tenant does not exist (tenant name null → ordered last)

const T0 = new Date('2026-10-25T12:00:00.000Z');
const DAY = 86_400_000;
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const DOC = { name: 'Order form OF-9001.pdf', sha256: 'ab'.repeat(32) };

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-B3 commercial subscription reads (real Postgres 17)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let h: C2Harness;
  let reads: CommercialSubscriptionReadService;
  let OPS: string;
  let FA: string;
  let SA: string;
  let clock = T0;
  let keyN = 0;
  let evtN = 0;
  const key = () => `b3-key-${String(++keyN).padStart(6, '0')}`;
  const env = { ...process.env };
  const F: Record<string, string> = {};

  const one = async (sql: string, p: unknown[] = []) => (await pg.query(sql, p)).rows[0];
  async function created(action_type: string, tenant_id: string, payload: Record<string, unknown>, user = OPS, role = 'commercial_ops'): Promise<string> {
    const r = await h.changeRequests.create(as(user, role), { action_type: action_type as never, tenant_id, product_key: 'sign', payload, reason: 'b3 fixture', idempotency_key: key() }, A6_CTX);
    return r.request.id;
  }
  async function approved(action_type: string, tenant_id: string, payload: Record<string, unknown>): Promise<string> {
    const id = await created(action_type, tenant_id, payload);
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), id, A6_CTX);
    await h.changeRequests.approve(as(FA, 'finance_admin'), id, { step_index: 0 }, A6_CTX);
    return id;
  }
  async function tenant(name: string): Promise<string> {
    const id = randomUUID();
    await pg.query(`INSERT INTO identity."Tenant" (id, name, slug, kind, updated_at) VALUES ($1, $2, $3, 'BUSINESS', now())`, [id, name, name.toLowerCase().replace(/[^a-z0-9]+/g, '-')]);
    return id;
  }
  /** A raw BASE row (Stripe-owned or historical), inserted in its final state. */
  async function rawRow(tenant_id: string, o: { source: string; plan: string; status: string; ref?: string; started_at: Date; ended_at?: Date; grace_until?: Date; commitment_end?: Date; current_period_end?: Date }): Promise<string> {
    const id = randomUUID();
    await pg.query(
      `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by, status, started_at, ended_at, grace_until, commitment_end, current_period_end, billing_provider, billing_account_ref, billing_subscription_ref)
       SELECT $1::uuid, $2::uuid, p.id, (SELECT v.id FROM subscription."PlanVersion" v WHERE v.plan_id = p.id AND v.status = 'PUBLISHED'), p.product_key, 'BASE', $3, $4, 'ccp-b3-spec', $5, $3, $6, $7, $8, $9, $10, $11, $12
         FROM subscription."Plan" p WHERE p.key = $13`,
      [id, tenant_id, o.started_at, o.source, o.status, o.ended_at ?? null, o.grace_until ?? null, o.commitment_end ?? null, o.current_period_end ?? null, o.ref === undefined ? null : 'STRIPE', o.ref === undefined ? null : `acct_${tenant_id}`, o.ref ?? null, o.plan],
    );
    return id;
  }

  /** count + md5 of every table the reads touch (the READ-ONLY oracle, as C3-I-1). */
  async function fingerprint(): Promise<Record<string, string>> {
    const tables = [
      'subscription."TenantSubscription"',
      'subscription."Contract"',
      'subscription."BillingReconciliationFlag"',
      'subscription."CheckoutIntent"',
      'subscription."Plan"',
      'subscription."PlanVersion"',
      'subscription."SupportExtension"',
      'subscription."CommercialChangeRequest"',
      'subscription."CommercialAuditEvent"',
      'entitlement."TenantEntitlement"',
      'identity."Tenant"',
    ];
    const out: Record<string, string> = {};
    for (const t of tables) {
      const r = await one(`SELECT count(*)::int AS n, md5(coalesce(string_agg(row_to_json(x)::text, '|' ORDER BY row_to_json(x)::text), '')) AS h FROM ${t} x`);
      out[t] = `${r.n}:${r.h}`;
    }
    return out;
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
    h = c2Harness(prisma, () => clock);
    reads = new CommercialSubscriptionReadService(prisma);
    OPS = await addOperator(pg, ['commercial_ops']);
    FA = await addOperator(pg, ['finance_admin']);
    SA = await addOperator(pg, ['support_admin']);

    // (A) governed MANUAL + contract (SUBSCRIPTION_OPEN with a contract block), then a HELD activation.
    clock = at(-30);
    F['A'] = await tenant('B3 Alpha');
    const openA = await approved('SUBSCRIPTION_OPEN', F['A'], {
      plan_key: INCLUDED,
      plan_version_id: await publishedVersion(pg, INCLUDED),
      replaces_subscription_id: null,
      contract: { contract_ref: 'CT-B3-0001', terms: ['Sign at negotiated terms'], documents: [DOC], evidence_ref: 'Order form OF-9001' },
    });
    F['A_sub'] = (await h.apply.apply(as(OPS, 'commercial_ops'), openA, A6_CTX)).application.subscription_id as string;
    F['A_contract'] = (await one(`SELECT id::text AS id FROM subscription."Contract" WHERE tenant_subscription_id = $1`, [F['A_sub']])).id;
    F['A_intent'] = randomUUID();
    await pg.query(
      `INSERT INTO subscription."CheckoutIntent" (id, tenant_id, user_id, plan_id, provider, provider_session_ref, created_at) SELECT $1::uuid, $2::uuid, 'owner-1', p.id, 'STRIPE', $3, $4::timestamptz FROM subscription."Plan" p WHERE p.key = $5`,
      [F['A_intent'], F['A'], `cs_${F['A_intent']}`, at(-40), BUSINESS],
    );
    clock = at(-5);
    const s = h.billing.state(F['A'], F['A_intent']);
    F['A_ref'] = s.subscription_ref;
    expect(await h.inbox.receive({ id: `evt_b3_${++evtN}`, type: 'subscription.updated', created: clock, subscription_ref: s.subscription_ref }, 'sign', clock)).toMatchObject({ outcome: 'IGNORED' });
    F['A_flag'] = (await one(`SELECT id::text AS id FROM subscription."BillingReconciliationFlag" WHERE tenant_id = $1 AND resolved_at IS NULL`, [F['A']])).id;
    const held = { direction: 'TO_GOVERNED', held_subscription_ref: F['A_ref'], governed_subscription_id: F['A_sub'] };
    clock = at(-4);
    F['A_conv_old'] = await created('CONVERSION', F['A'], held);
    await h.changeRequests.withdraw(as(OPS, 'commercial_ops'), F['A_conv_old'], A6_CTX);
    clock = at(-3);
    F['A_conv'] = await created('CONVERSION', F['A'], held);
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), F['A_conv'], A6_CTX);

    // (B) Stripe-owned SELF_SERVICE PAST_DUE in grace with a commitment; an older ended row.
    F['B'] = await tenant('B3 Bravo');
    F['B_old'] = await rawRow(F['B'], { source: 'MANUAL', plan: INCLUDED, status: 'CANCELED', started_at: at(-200), ended_at: at(-1) });
    F['B_sub'] = await rawRow(F['B'], { source: 'SELF_SERVICE', plan: BUSINESS, status: 'PAST_DUE', ref: 'sub_b3_bravo', started_at: at(-60), grace_until: at(3), commitment_end: at(200), current_period_end: at(5) });
    clock = T0;
    const ext = await h.supportExtensions.request(as(SA, 'support_admin'), { tenant_id: F['B'], product_key: 'sign', subscription_id: F['B_sub'], requested_days: 5, reason: 'Support goodwill: billing contact on leave', idempotency_key: key() }, A6_CTX);
    expect(ext.outcome).toBe('APPLIED');
    await pg.query(
      `INSERT INTO subscription."BillingReconciliationFlag" (id, tenant_id, provider, subscription_ref, intent_id, reason, detected_at, resolved_at) VALUES
         (gen_random_uuid(), $1, 'STRIPE', 'sub_b3_country', NULL, 'billing_country_not_supported', $2, NULL),
         (gen_random_uuid(), $1, 'STRIPE', 'sub_b3_resolved', NULL, 'domain_not_authoritative', $2, $3)`,
      [F['B'], at(-2), at(-1)],
    );

    // (C) only ended rows.
    F['C'] = await tenant('B3 Charlie');
    F['C_older'] = await rawRow(F['C'], { source: 'MANUAL', plan: INCLUDED, status: 'CANCELED', started_at: at(-300), ended_at: at(-100) });
    F['C_sub'] = await rawRow(F['C'], { source: 'SELF_SERVICE', plan: BUSINESS, status: 'CANCELED', ref: 'sub_b3_charlie', started_at: at(-90), ended_at: at(-10) });

    // (D) governed row; `sign` revoked by a governed request; `ats` granted raw; an open SUBSCRIPTION_CHANGE.
    clock = at(-20);
    F['D'] = await tenant('B3 Delta');
    const openD = await approved('SUBSCRIPTION_OPEN', F['D'], { plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED), replaces_subscription_id: null });
    F['D_open'] = openD;
    F['D_sub'] = (await h.apply.apply(as(OPS, 'commercial_ops'), openD, A6_CTX)).application.subscription_id as string;
    clock = at(-10);
    F['D_revoke'] = await approved('ENTITLEMENT_REVOKE', F['D'], { capabilities: ['sign'] });
    await h.apply.apply(as(OPS, 'commercial_ops'), F['D_revoke'], A6_CTX);
    await pg.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1, 'ats')`, [F['D']]);
    clock = at(-1);
    F['D_change'] = await created('SUBSCRIPTION_CHANGE', F['D'], { subscription_id: F['D_sub'], plan_key: BUSINESS, plan_version_id: await publishedVersion(pg, BUSINESS) });

    // (Z) a row of a tenant id with no identity row.
    F['Z'] = randomUUID();
    F['Z_sub'] = await rawRow(F['Z'], { source: 'MANUAL', plan: INCLUDED, status: 'ACTIVE', started_at: at(-15) });
    clock = T0;
  }, 300_000);

  afterAll(async () => {
    process.env = env;
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  const product = (o: TenantCommercialOverview | null, k: string): OverviewProduct => {
    const p = o?.products.find((x) => x.product_key === k);
    if (p === undefined) throw new Error(`no product ${k}`);
    return p;
  };

  it('B3-I-1 workbench: exactly one latest BASE row per tenant × product (open wins over a later-ended row; else the most recently ended), ordered by tenant name with nulls last', async () => {
    const r = await reads.listWorkbench({ as_of: T0 });
    expect(r.as_of).toEqual(T0);
    expect(r.rows.map((x) => [x.tenant.name, x.subscription_id])).toEqual([
      ['B3 Alpha', F['A_sub']],
      ['B3 Bravo', F['B_sub']],
      ['B3 Charlie', F['C_sub']],
      ['B3 Delta', F['D_sub']],
      [null, F['Z_sub']],
    ]);
    const z = r.rows[4]!;
    expect(z.tenant).toEqual({ id: F['Z'], name: null, slug: null });
    // independent oracle: one row per tenant × product
    const n = (await one(`SELECT count(DISTINCT (tenant_id, product_key))::int AS n FROM subscription."TenantSubscription" WHERE composition_role = 'BASE'`)).n;
    expect(r.rows).toHaveLength(n);
  });

  it('B3-I-2 (A) the MANUAL contract-linked row: plan, pinned version, period at as_of, contract, not provider-linked, the held activation flag reason', async () => {
    const r = (await reads.listWorkbench({ as_of: T0 })).rows.find((x) => x.subscription_id === F['A_sub'])!;
    const db = await one(
      `SELECT ts.period_anchor, ts.started_at, p.id::text AS plan_id, p.name, p.sales_model, v.id::text AS version_id, v.version_number, v.status
         FROM subscription."TenantSubscription" ts JOIN subscription."Plan" p ON p.id = ts.plan_id JOIN subscription."PlanVersion" v ON v.id = ts.plan_version_id WHERE ts.id = $1`,
      [F['A_sub']],
    );
    expect(r).toEqual({
      subscription_id: F['A_sub'],
      tenant: { id: F['A'], name: 'B3 Alpha', slug: 'b3-alpha' },
      product_key: 'sign',
      plan: { id: db.plan_id, key: INCLUDED, name: db.name, sales_model: db.sales_model },
      plan_version: { id: db.version_id, version_number: db.version_number, status: db.status },
      source: 'MANUAL',
      status: 'ACTIVE',
      started_at: db.started_at,
      ended_at: null,
      period_anchor: db.period_anchor,
      current_period: billingPeriodAt(db.period_anchor, T0),
      current_period_end: null,
      grace_until: null,
      commitment_end: null,
      contract: { id: F['A_contract'], contract_ref: 'CT-B3-0001' },
      provider_linked: false,
      open_flags: ['governed_subscription_open'],
      active_extensions: { count: 0, exception: false },
    });
    expect(r.current_period!.start.getTime()).toBeLessThanOrEqual(T0.getTime());
    expect(r.current_period!.end.getTime()).toBeGreaterThan(T0.getTime());
  });

  it('B3-I-3 (B) the SELF_SERVICE PAST_DUE row: provider-linked, grace and commitment dates, current_period_end, the active bounded EXCEPTION extension, open flags (intent-less → sign; resolved excluded)', async () => {
    const r = (await reads.listWorkbench({ as_of: T0 })).rows.find((x) => x.tenant.id === F['B'])!;
    expect(r).toMatchObject({
      subscription_id: F['B_sub'],
      source: 'SELF_SERVICE',
      status: 'PAST_DUE',
      plan: { key: BUSINESS },
      provider_linked: true,
      grace_until: at(3),
      commitment_end: at(200),
      current_period_end: at(5),
      started_at: at(-60),
      ended_at: null,
      contract: null,
      open_flags: ['billing_country_not_supported'],
      active_extensions: { count: 1, exception: true },
    });
    expect(Object.keys(r)).not.toContain('billing_subscription_ref');
    // the extension is no longer active once as_of passes extends_until
    const until = (await one(`SELECT extends_until FROM subscription."SupportExtension" WHERE subscription_id = $1`, [F['B_sub']])).extends_until as Date;
    const later = (await reads.listWorkbench({ as_of: until })).rows.find((x) => x.tenant.id === F['B'])!;
    expect(later.active_extensions).toEqual({ count: 0, exception: false });
  });

  it('B3-I-4 (C) a tenant whose rows are all ended: the most recently ended row, current_period null', async () => {
    const r = (await reads.listWorkbench({ as_of: T0 })).rows.find((x) => x.tenant.id === F['C'])!;
    expect(r).toMatchObject({ subscription_id: F['C_sub'], status: 'CANCELED', ended_at: at(-10), current_period: null, provider_linked: true, open_flags: [] });
  });

  it('B3-I-5 product filter: sign returns the same rows; an unregistered product is refused (assertProductKey)', async () => {
    const all = await reads.listWorkbench({ as_of: T0 });
    expect((await reads.listWorkbench({ product_key: 'sign', as_of: T0 })).rows).toEqual(all.rows);
    await expect(reads.listWorkbench({ product_key: 'ats' as never, as_of: T0 })).rejects.toBeInstanceOf(ProductContextError);
  });

  it('B3-I-6 (A) overview: the held activation flag links the NEWEST conversion naming its held ref; the open request is that conversion; registered only for sign', async () => {
    const o = await reads.tenantOverview(F['A']!, { as_of: T0 });
    expect(o?.tenant).toEqual({ id: F['A'], name: 'B3 Alpha', slug: 'b3-alpha', kind: 'BUSINESS' });
    expect(o?.products.map((p) => [p.product_key, p.registered])).toEqual([
      ['sign', true],
      ['ats', false],
      ['portal', false],
      ['intelligence', false],
    ]);
    const sign = product(o, 'sign');
    const flagRow = await one(`SELECT detected_at FROM subscription."BillingReconciliationFlag" WHERE id = $1`, [F['A_flag']]);
    expect(sign.flags).toEqual([
      {
        id: F['A_flag'],
        reason: 'governed_subscription_open',
        provider: 'STRIPE',
        subscription_ref: F['A_ref'],
        intent_id: F['A_intent'],
        detected_at: flagRow.detected_at,
        conversion: { change_request_id: F['A_conv'], state: 'PENDING_APPROVAL', direction: 'TO_GOVERNED' },
      },
    ]);
    expect(sign.open_request).toEqual({ id: F['A_conv'], action_type: 'CONVERSION', kind: 'NORMAL', state: 'PENDING_APPROVAL', requested_by: OPS, created_at: at(-3) });
    expect(sign.subscription).toMatchObject({ subscription_id: F['A_sub'], contract: { contract_ref: 'CT-B3-0001' }, open_flags: ['governed_subscription_open'] });
    expect(Object.keys(sign.subscription!)).not.toContain('tenant');
    expect(sign.entitlement).toMatchObject({ capability: 'sign', state: 'ACTIVE', granted_source: 'PLAN', change_request_id: (await one(`SELECT change_request_id::text AS c FROM entitlement."TenantEntitlement" WHERE tenant_id = $1 AND capability = 'sign'`, [F['A']])).c, revoked_at: null });
    for (const k of ['ats', 'portal', 'intelligence']) {
      expect(product(o, k)).toEqual({
        product_key: k,
        registered: false,
        entitlement: { capability: k, state: 'NONE', granted_source: null, granted_at: null, granted_by: null, change_request_id: null, revoked_at: null, revoked_by: null, revoke_change_request_id: null },
        subscription: null,
        flags: [],
        open_request: null,
      });
    }
  });

  it('B3-I-7 (D) overview: sign REVOKED with its revoke provenance; ats ACTIVE (MIGRATION) without leaking into sign; the open SUBSCRIPTION_CHANGE; no flags', async () => {
    const o = await reads.tenantOverview(F['D']!, { as_of: T0 });
    const e = await one(`SELECT granted_at, revoked_at FROM entitlement."TenantEntitlement" WHERE tenant_id = $1 AND capability = 'sign'`, [F['D']]);
    const sign = product(o, 'sign');
    expect(sign.entitlement).toEqual({
      capability: 'sign',
      state: 'REVOKED',
      granted_source: 'PLAN',
      granted_at: e.granted_at,
      granted_by: OPS,
      change_request_id: F['D_open'],
      revoked_at: e.revoked_at,
      revoked_by: OPS,
      revoke_change_request_id: F['D_revoke'],
    });
    expect(sign.open_request).toMatchObject({ id: F['D_change'], action_type: 'SUBSCRIPTION_CHANGE', state: 'DRAFT', requested_by: OPS, created_at: at(-1) });
    expect(sign.flags).toEqual([]);
    expect(sign.subscription).toMatchObject({ subscription_id: F['D_sub'], source: 'MANUAL', status: 'ACTIVE' });
    const ats = product(o, 'ats');
    expect(ats).toMatchObject({ registered: false, entitlement: { capability: 'ats', state: 'ACTIVE', granted_source: 'MIGRATION', change_request_id: null }, subscription: null, flags: [], open_request: null });
  });

  it('B3-I-8 (B, C) overview: B carries the intent-less flag (no conversion) and no open request (the bounded extension is APPLIED); C has an ended latest row; entitlement NONE when no row', async () => {
    const b = product(await reads.tenantOverview(F['B']!, { as_of: T0 }), 'sign');
    expect(b.flags.map((f) => [f.reason, f.intent_id, f.conversion])).toEqual([['billing_country_not_supported', null, null]]);
    expect(b.open_request).toBeNull();
    expect(b.subscription).toMatchObject({ subscription_id: F['B_sub'], active_extensions: { count: 1, exception: true } });
    expect(b.entitlement.state).toBe('NONE');
    const c = product(await reads.tenantOverview(F['C']!, { as_of: T0 }), 'sign');
    expect(c.subscription).toMatchObject({ subscription_id: F['C_sub'], ended_at: at(-10), current_period: null });
  });

  it('B3-I-9 an unknown tenant reads null; a tenant with no commercial records reads every product empty', async () => {
    expect(await reads.tenantOverview(randomUUID(), { as_of: T0 })).toBeNull();
    const t = await tenant('B3 Echo');
    const o = await reads.tenantOverview(t, { as_of: T0 });
    expect(o?.products.every((p) => p.subscription === null && p.flags.length === 0 && p.open_request === null && p.entitlement.state === 'NONE')).toBe(true);
  });

  it('B3-I-10 READ-ONLY: count + md5 of every touched table are equal before and after both reads; no key named like price, amount or currency appears', async () => {
    const before = await fingerprint();
    const w = await reads.listWorkbench({ as_of: T0 });
    const overviews = await Promise.all([F['A'], F['B'], F['C'], F['D']].map((t) => reads.tenantOverview(t!, { as_of: T0 })));
    expect(await fingerprint()).toEqual(before);
    const keys: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === 'object' && !(v instanceof Date)) for (const [k, x] of Object.entries(v)) {
          keys.push(k);
          walk(x);
        }
    };
    walk(w);
    walk(overviews);
    expect(keys.length).toBeGreaterThan(50);
    expect(keys.filter((k) => /price|amount|currency/i.test(k))).toEqual([]);
  });
});
