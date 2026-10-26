import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SubscriptionPrismaService, UsageRollupService } from '@aramo/subscription';

// eslint-disable-next-line @nx/enforce-module-boundaries -- test-only real-Postgres support shared with the libs/subscription CCP specs (TD-A3-19 precedent)
import { ISOLATION_TEST_PRODUCT_KEY, registerIsolationTestProduct } from '../../../../libs/subscription/src/tests/fixtures/ccp-a4.js';
// eslint-disable-next-line @nx/enforce-module-boundaries -- same precedent
import { publishTestPlanV1 } from '../../../../libs/subscription/src/tests/fixtures/ccp-a5.js';

import { CR, INCLUDED, out, startD4, type D4Harness } from './support/ccp-d4-harness.js';
import { entitle, key, pastDueRow, tenant, version } from './support/ccp-d4-scenarios.js';

// CCP-D4 (PBD §5.4 row D4; T12 tenant/product isolation; MP-A2 N-12) — tenant isolation of every
// tenant-scoped commercial read and write, through the HTTP routes of the REAL platform-admin
// AppModule (real RBAC, real services, real Postgres). Two fully populated tenants, A and B: no read
// addressed to B (path, query or body) ever returns A's data, and no write addressed to B ever
// mutates A. Cross-product: a second product key registered in THIS test database only (N-12) is
// never read or mutated through a Sign request.

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-D4 tenant and product isolation (real AppModule, real RBAC, real Postgres)', { timeout: 300_000 }, () => {
  let h: D4Harness;
  interface World {
    tenant: string;
    sub: string;
    contract: string;
    seTenant: string;
    seSub: string;
    extension: string;
    credit: string;
  }
  const w: Record<'A' | 'B', World> = {} as Record<'A' | 'B', World>;

  async function approveAndApply(id: string, requester = 'commercial_ops', route = 'apply'): Promise<{ status: number; body: Record<string, unknown> }> {
    const st = (await h.pg.query(`SELECT state FROM subscription."CommercialChangeRequest" WHERE id = $1`, [id])).rows[0].state as string;
    if (st === 'DRAFT') expect((await h.post(requester, `${CR}/${id}/submit`)).status).toBe(200);
    const a = await h.post('finance_admin', `${CR}/${id}/approvals`, { step_index: 0 });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const r = await h.post(requester, `${CR}/${id}/${route}`);
    return { status: r.status, body: r.body as Record<string, unknown> };
  }
  async function create(who: string, b: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const r = await h.post(who, CR, { reason: 'D4 isolation', idempotency_key: key('iso'), ...b });
    return { status: r.status, body: r.body as Record<string, unknown> };
  }

  /** A governed Sign open carrying an enterprise contract, applied through the HTTP surface. */
  async function contracted(name: string): Promise<{ tenant: string; sub: string; contract: string }> {
    const t = await tenant(h, name);
    const c = await create('commercial_ops', {
      action_type: 'SUBSCRIPTION_OPEN',
      tenant_id: t,
      product_key: 'sign',
      payload: {
        plan_key: INCLUDED,
        plan_version_id: await version(h, INCLUDED),
        replaces_subscription_id: null,
        contract: { contract_ref: `CT-D4-${name.slice(-1)}-${t.slice(0, 6).toUpperCase()}`, terms: ['Invoiced monthly, net 30'], documents: [{ name: 'Order form.pdf', sha256: (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 64), byte_size: 1024, media_type: 'application/pdf' }], evidence_ref: `Order form ${name}`, payment_terms: { billing_mode: 'POSTPAID', postpaid_approval: { statement: 'Postpaid per the signed order form', evidence_ref: 'Order form postpaid clause' }, currency: 'USD', timezone: 'America/New_York', obligations: [] } },
      },
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const applied = await approveAndApply((c.body['request'] as { id: string }).id);
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const sub = (applied.body['application'] as { subscription_id: string }).subscription_id;
    const contract = (await h.pg.query(`SELECT id FROM subscription."Contract" WHERE tenant_subscription_id = $1`, [sub])).rows[0].id as string;
    return { tenant: t, sub, contract };
  }

  /** Everything of a world a write could touch (the no-mutation oracle). */
  async function snapshot(x: World): Promise<string> {
    const q = async (sql: string, p: unknown[]) => (await h.pg.query(sql, p)).rows.map((r) => JSON.stringify(r));
    return JSON.stringify({
      subs: await q(`SELECT * FROM subscription."TenantSubscription" WHERE tenant_id IN ($1, $2) ORDER BY id`, [x.tenant, x.seTenant]),
      ents: await q(`SELECT tenant_id, capability, revoked_at FROM entitlement."TenantEntitlement" WHERE tenant_id IN ($1, $2) ORDER BY tenant_id, capability`, [x.tenant, x.seTenant]),
      contracts: await q(`SELECT * FROM subscription."Contract" WHERE id = $1`, [x.contract]),
      amendments: await q(`SELECT * FROM subscription."ContractAmendment" WHERE contract_id = $1`, [x.contract]),
      extensions: await q(`SELECT * FROM subscription."SupportExtension" WHERE tenant_id = $1 ORDER BY id`, [x.seTenant]),
    });
  }
  const leaks = (body: unknown, x: World): string[] => {
    const text = JSON.stringify(body);
    return Object.entries(x)
      .filter(([, v]) => text.includes(v))
      .map(([k]) => k);
  };

  beforeAll(async () => {
    h = await startD4();
    // D1: the usage reads serve only reconciled roll-ups; run the roll-up once (the AppModule worker is off).
    const prisma = new SubscriptionPrismaService(h.url);
    await prisma.$connect();
    rollup = async () => {
      await new UsageRollupService(prisma).run({ rebuild: true });
    };
    stopPrisma = () => prisma.$disconnect();
    for (const n of ['A', 'B'] as const) {
      const c = await contracted(`Tenant ${n}`);
      await entitle(h, c.tenant, 'sign');
      const seTenant = await tenant(h, `Tenant ${n} self-service`);
      const seSub = await pastDueRow(h, seTenant);
      h.reader.subs.set(`sub_${seSub}`, {
        provider: 'STRIPE', subscription_ref: `sub_${seSub}`, account_ref: `acct_${seTenant}`, provider_status: 'past_due', current_period_start: new Date(Date.now() - 20 * 86_400_000),
        current_period_end: new Date(Date.now() + 10 * 86_400_000), cancel_at_period_end: false, price_ref: 'price_business', tenant_id: seTenant, intent_id: null, account_country: 'US',
      } as never);
      const se = await h.post('support_admin', '/platform/commercial/support-extensions', { tenant_id: seTenant, subscription_id: seSub, product_key: 'sign', requested_days: 5, reason: `D4 ${n}`, idempotency_key: key('se') });
      expect(se.status, JSON.stringify(se.body)).toBe(201);
      const credit = await create('commercial_ops', { action_type: 'CREDIT', tenant_id: c.tenant, product_key: 'sign', payload: { amount_minor: 100, currency: 'USD' } });
      expect(credit.status).toBe(201);
      w[n] = { tenant: c.tenant, sub: c.sub, contract: c.contract, seTenant, seSub, extension: (se.body.extension as { id: string }).id, credit: (credit.body['request'] as { id: string }).id };
    }
  }, 600_000);
  let rollup: () => Promise<void> = async () => undefined;
  let stopPrisma: () => Promise<void> = async () => undefined;
  afterAll(async () => {
    await stopPrisma();
    await h?.stop();
  }, 120_000);

  it('D4-ISO-READ every tenant-scoped commercial read, addressed to tenant B (path or query), returns none of tenant A\'s ids; the same read addressed to A returns A\'s data (the oracle sees it)', async () => {
    const reads: Array<{ name: string; who: string; at: (x: World) => string; method?: 'GET' | 'POST'; body?: (x: World) => object; mustSee?: Array<keyof World> }> = [
      { name: 'GET /tenants/{id}/commercial', who: 'read_only_auditor', at: (x) => `/platform/commercial/tenants/${x.tenant}/commercial`, mustSee: ['sub', 'contract'] },
      { name: 'GET /tenants/{id}/billing-status', who: 'finance_admin', at: (x) => `/platform/commercial/tenants/${x.seTenant}/billing-status?product_key=sign`, mustSee: ['seSub'] },
      { name: 'GET /contracts?tenant_id', who: 'read_only_auditor', at: (x) => `/platform/commercial/contracts?tenant_id=${x.tenant}`, mustSee: ['contract'] },
      { name: 'GET /support-extensions?tenant_id', who: 'support_admin', at: (x) => `/platform/commercial/support-extensions?tenant_id=${x.seTenant}`, mustSee: ['extension', 'seSub'] },
      { name: 'GET /usage/periods?tenant_id', who: 'read_only_auditor', at: (x) => `/platform/commercial/usage/periods?tenant_id=${x.tenant}` },
      { name: 'GET /audit-events?tenant_id', who: 'read_only_auditor', at: (x) => `/platform/commercial/audit-events?tenant_id=${x.tenant}`, mustSee: ['credit'] },
      { name: 'POST /audit-events/export {tenant_id}', who: 'read_only_auditor', method: 'POST', at: () => '/platform/commercial/audit-events/export', body: (x) => ({ tenant_id: x.tenant }), mustSee: ['credit'] },
      { name: 'GET /billing-commands?tenant_id', who: 'finance_admin', at: (x) => `/platform/commercial/billing-commands?tenant_id=${x.tenant}` },
      { name: 'GET /finance/renewals?tenant_id', who: 'finance_admin', at: (x) => `/platform/commercial/finance/renewals?tenant_id=${x.tenant}` },
      { name: 'GET /finance/outstanding-payments?tenant_id', who: 'finance_admin', at: (x) => `/platform/commercial/finance/outstanding-payments?tenant_id=${x.seTenant}` },
      { name: 'GET /finance/reconciliation-report?tenant_id', who: 'finance_admin', at: (x) => `/platform/commercial/finance/reconciliation-report?tenant_id=${x.tenant}`, mustSee: ['sub'] },
      { name: 'GET /alerts/billing?tenant_id', who: 'finance_admin', at: (x) => `/platform/commercial/alerts/billing?tenant_id=${x.tenant}` },
      { name: 'GET /alerts/approvals?tenant_id', who: 'finance_admin', at: (x) => `/platform/commercial/alerts/approvals?tenant_id=${x.tenant}` },
    ];
    await rollup();
    const results: Record<string, string> = {};
    for (const r of reads) {
      const call = (x: World) => h.call(r.who, r.method ?? 'GET', r.at(x), r.body?.(x));
      h.reader.calls.length = 0;
      const b = await call(w.B);
      const readerCalls = [...h.reader.calls];
      const a = await call(w.A);
      expect(b.status, `${r.name} B ${JSON.stringify(b.body)}`).toBe(200);
      expect(a.status, `${r.name} A`).toBe(200);
      const leaked = leaks(b.body, w.A);
      const providerLeak = readerCalls.filter((c) => c.includes(w.A.seSub));
      const seen = (r.mustSee ?? []).filter((k) => !JSON.stringify(a.body).includes(w.A[k]));
      results[r.name] = `B→A leaks=[${leaked.join(',')}] provider=[${providerLeak.join(',')}] control A sees [${(r.mustSee ?? []).join(',')}]${seen.length ? ` MISSING ${seen.join(',')}` : ''}`;
      expect(leaked, r.name).toEqual([]);
      expect(providerLeak, r.name).toEqual([]);
      expect(seen, `${r.name} positive control`).toEqual([]);
    }
    console.log(`D4-ISO-READ\n${JSON.stringify(results, null, 1)}`);
    expect(Object.keys(results)).toHaveLength(13);
  });

  it('D4-ISO-WRITE every tenant-scoped write addressed to tenant B that names one of tenant A\'s rows is refused (at create, at the support route, or fail closed at apply) and tenant A is byte-unchanged', async () => {
    const before = await snapshot(w.A);
    const results: Record<string, string> = {};
    // Each write is addressed to a FRESH tenant of B's shape (Q14: one open request per tenant ×
    // product, and a refused apply keeps its APPLY_FAILED request open).
    const via = async (name: string, b: Record<string, unknown> | ((t: { tenant: string; sub: string }) => Promise<Record<string, unknown>>), route = 'apply', withRow = false) => {
      const target = withRow ? await contracted(`Tenant B${Object.keys(results).length}`) : { tenant: await tenant(h, 'Tenant B write'), sub: '' };
      const payload = typeof b === 'function' ? await b(target) : b;
      const c = await create('commercial_ops', { tenant_id: target.tenant, product_key: 'sign', ...payload });
      if (c.status !== 201) {
        results[name] = `create ${c.status} ${JSON.stringify((c.body['error'] as { details?: unknown })?.details ?? null)}`;
        // A create refusal must be about the cross-tenant target, never an unrelated slot conflict.
        expect(JSON.stringify(c.body), name).not.toContain('open_request_exists');
        expect(c.status, name).toBeGreaterThanOrEqual(400);
        return;
      }
      const r = await approveAndApply((c.body['request'] as { id: string }).id, 'commercial_ops', route);
      results[name] = `apply ${r.status} ${(r.body['error'] as { details?: { failure?: string; reason?: string } })?.details?.failure ?? (r.body['error'] as { details?: { reason?: string } })?.details?.reason ?? ''}`;
      expect(r.status, `${name} ${JSON.stringify(r.body)}`).toBeGreaterThanOrEqual(400);
    };
    await via('SUBSCRIPTION_CHANGE naming A\'s subscription', { action_type: 'SUBSCRIPTION_CHANGE', payload: { subscription_id: w.A.sub, plan_key: INCLUDED, plan_version_id: await version(h, INCLUDED) } });
    await via('SUBSCRIPTION_END naming A\'s subscription', { action_type: 'SUBSCRIPTION_END', payload: { subscription_id: w.A.sub } });
    await via('SUBSCRIPTION_OPEN replacing A\'s subscription', { action_type: 'SUBSCRIPTION_OPEN', payload: { plan_key: INCLUDED, plan_version_id: await version(h, INCLUDED), replaces_subscription_id: w.A.sub } });
    const v = await version(h, INCLUDED);
    await via('contract amendment of A\'s contract on B\'s row', async (t) => ({ action_type: 'SUBSCRIPTION_CHANGE', payload: { subscription_id: t.sub, plan_key: INCLUDED, plan_version_id: v, contract_amendment: { contract_id: w.A.contract, summary: 'Cross-tenant amendment', documents: [] } } }), 'apply', true);
    await via('SUBSCRIPTION_END of B\'s row ending A\'s contract', async (t) => ({ action_type: 'SUBSCRIPTION_END', payload: { subscription_id: t.sub, contract_end: { contract_id: w.A.contract, documents: [] } } }), 'apply', true);
    await via('CONVERSION of A\'s governed subscription', { action_type: 'CONVERSION', payload: { direction: 'TO_SELF_SERVICE', governed_subscription_id: w.A.sub, plan_key: 'aramo-sign-standard-business-v1', plan_version_id: await version(h, 'aramo-sign-standard-business-v1'), release_expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString() } }, 'convert');
    // Support extensions are addressed to the self-service tenants.
    const se = await h.post('support_admin', '/platform/commercial/support-extensions', { tenant_id: w.B.seTenant, subscription_id: w.A.seSub, product_key: 'sign', requested_days: 3, reason: 'D4 cross-tenant', idempotency_key: key('se') });
    results['support extension of A\'s row via B'] = out(se).join(' ');
    expect(se.status, JSON.stringify(se.body)).toBe(400);
    const rm = await h.post('support_admin', CR, { action_type: 'SUPPORT_EXTENSION', tenant_id: w.B.seTenant, product_key: 'sign', payload: { operation: 'REMOVE', support_extension_id: w.A.extension }, reason: 'D4 cross-tenant removal', idempotency_key: key('rm') });
    if (rm.status === 201) {
      const id = rm.body.request.id as string;
      if (rm.body.request.state === 'DRAFT') await h.post('support_admin', `${CR}/${id}/submit`);
      expect((await h.post('finance_admin', `${CR}/${id}/approvals`, { step_index: 0 })).status).toBe(201);
      const r = await h.post('support_admin', `${CR}/${id}/apply`);
      results['support extension REMOVE of A\'s overlay via B'] = `apply ${out(r).join(' ')}`;
      expect(r.status).toBeGreaterThanOrEqual(400);
    } else {
      results['support extension REMOVE of A\'s overlay via B'] = `create ${out(rm).join(' ')}`;
      expect(rm.status).toBeGreaterThanOrEqual(400);
    }
    // ENTITLEMENT_REVOKE addressed to B leaves A's entitlement alone (the payload names no tenant row).
    await h.post('commercial_ops', `${CR}/${w.B.credit}/withdraw`);
    const rev = await create('commercial_ops', { action_type: 'ENTITLEMENT_REVOKE', tenant_id: w.B.tenant, product_key: 'sign', payload: { capabilities: ['sign'] } });
    if (rev.status === 201) {
      const r = await approveAndApply((rev.body['request'] as { id: string }).id);
      results['ENTITLEMENT_REVOKE of B'] = `apply ${r.status}`;
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    } else results['ENTITLEMENT_REVOKE of B'] = `create ${rev.status} ${JSON.stringify(rev.body)}`;
    expect(rev.status).toBe(201);
    console.log(`D4-ISO-WRITE\n${JSON.stringify(results, null, 1)}`);
    expect(await snapshot(w.A)).toBe(before);
    expect(Object.keys(results)).toHaveLength(9);
  });

  it('D4-ISO-PRODUCT (MP-A2 N-12) a second product key registered in THIS test database only: a change request cannot name it; a Sign END / support extension naming its row is refused and the row is byte-unchanged; product-filtered Sign reads never return it', async () => {
    await registerIsolationTestProduct(h.pg);
    const plan = randomUUID();
    await h.pg.query(`INSERT INTO subscription."Plan" (id, key, name, sellable, sales_model, status, display_order, product_key) VALUES ($1, 'ccp-d4-iso-plan', 'ISO', false, 'OPERATOR', 'ACTIVE', 961, $2)`, [plan, ISOLATION_TEST_PRODUCT_KEY]);
    await publishTestPlanV1(h.pg, plan);
    const t = w.A.tenant; // holds an open Sign row already
    const iso = randomUUID();
    await h.pg.query(
      `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by)
       VALUES ($1, $2, $3, (SELECT id FROM subscription."PlanVersion" WHERE plan_id = $3 AND status = 'PUBLISHED'), $4, 'BASE', now() - interval '10 days', 'MANUAL', 'ccp-d4-iso')`,
      [iso, t, plan, ISOLATION_TEST_PRODUCT_KEY],
    );
    const isoRow = async () => (await h.pg.query(`SELECT row_to_json(s)::text j FROM subscription."TenantSubscription" s WHERE id = $1`, [iso])).rows[0].j as string;
    const before = await isoRow();
    const results: Record<string, string> = {};
    // The tenant's CREDIT holds its Sign slot; withdraw it first.
    await h.post('commercial_ops', `${CR}/${w.A.credit}/withdraw`);
    const named = await h.post('commercial_ops', CR, { action_type: 'SUBSCRIPTION_END', tenant_id: t, product_key: ISOLATION_TEST_PRODUCT_KEY, payload: { subscription_id: iso }, reason: 'D4 N-12', idempotency_key: key('n12') });
    results['change request naming the test product'] = out(named).join(' ');
    expect(named.status, JSON.stringify(named.body)).toBe(400);
    const end = await h.post('commercial_ops', CR, { action_type: 'SUBSCRIPTION_END', tenant_id: t, product_key: 'sign', payload: { subscription_id: iso }, reason: 'D4 N-12', idempotency_key: key('n12') });
    expect(end.status, JSON.stringify(end.body)).toBe(201);
    const applied = await approveAndApply(end.body.request.id as string);
    results['Sign END naming the test-product row'] = `apply ${applied.status} ${(applied.body['error'] as { details?: { failure?: string } })?.details?.failure ?? ''}`;
    expect(applied.status).toBe(409);
    // The refused END keeps tenant A's Sign slot (APPLY_FAILED): the support extension is addressed to
    // a fresh tenant holding only a test-product row.
    const iso2 = randomUUID();
    const seT = await tenant(h, 'N-12 support target');
    await h.pg.query(
      `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by)
       VALUES ($1, $2, $3, (SELECT id FROM subscription."PlanVersion" WHERE plan_id = $3 AND status = 'PUBLISHED'), $4, 'BASE', now() - interval '10 days', 'MANUAL', 'ccp-d4-iso')`,
      [iso2, seT, plan, ISOLATION_TEST_PRODUCT_KEY],
    );
    const se = await h.post('support_admin', '/platform/commercial/support-extensions', { tenant_id: seT, subscription_id: iso2, product_key: 'sign', requested_days: 3, reason: 'D4 N-12', idempotency_key: key('n12') });
    results['support extension naming the test-product row'] = out(se).join(' ');
    expect(se.status, JSON.stringify(se.body)).toBe(400);
    for (const path of [`/platform/commercial/subscriptions?product_key=sign`, `/platform/commercial/usage/reconciliation?product_key=sign`, `/platform/commercial/finance/reconciliation-report?tenant_id=${t}&product_key=sign`]) {
      const r = await h.get('finance_admin', path);
      results[`GET ${path.split('?')[0]} (sign)`] = `${r.status} contains test row: ${JSON.stringify(r.body).includes(iso)}`;
      expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(200);
      expect(JSON.stringify(r.body).includes(iso), path).toBe(false);
    }
    expect(await isoRow()).toBe(before);
    console.log(`D4-ISO-PRODUCT\n${JSON.stringify(results, null, 1)}`);
    expect(Object.keys(results)).toHaveLength(6);
  });
});
