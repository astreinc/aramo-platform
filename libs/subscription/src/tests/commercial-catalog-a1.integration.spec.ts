import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AllowanceService } from '../lib/allowance.service.js';
import type { BillingProviderPort, ProviderSubscriptionState } from '../lib/billing/billing-provider.port.js';
import type { PlanEligibilityPort } from '../lib/billing/plan-eligibility.port.js';
import { BillingRefusedError, SubscriptionLifecycleService } from '../lib/billing/subscription-lifecycle.service.js';
import { CapacityService } from '../lib/capacity.service.js';
import { openDevelopmentSubscription } from '../lib/development-subscription.js';
import { LEGAL_DOCUMENTS, type LegalDocumentVersion } from '../lib/legal/legal-documents.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { FakeOrganizationBillingProfile } from './fixtures/organization-billing-profile.fake.js';

// Aramo-Sign-Commercial-Plans-Legal-Framework-Amendment-A1 — on real Postgres 17:
// the canonical catalog exactly as approved; unlimited signing is explicit and
// still metered; Standard Professional is ATS-eligibility-bound and a lapse is
// surfaced, never auto-downgraded; the annual commitment is separate from the
// monthly invoice; terms evidence and the live-mode guard; storage quotas are
// concurrency-safe, typed, never refuse kept objects, and never delete anything.

const MIGRATIONS = [
  '../../../metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
  '../../prisma/migrations/20261018120000_init_subscription_allowance/migration.sql',
  '../../prisma/migrations/20261019100000_subscription_lifecycle_billing/migration.sql',
  '../../prisma/migrations/20261019140000_sign_commercial_catalog_a1/migration.sql',
  '../../prisma/migrations/20261020130300_sign_naming_keys/migration.sql',
  '../../prisma/migrations/20261022100100_billing_account_country_guard/migration.sql',
  '../../prisma/migrations/20261022110100_billing_flag_domain_reason/migration.sql',
  '../../prisma/migrations/20261023100000_sign_personal_free/migration.sql',
].map((p) => resolve(__dirname, p));

const KEY = 'sign.envelopes';
const STORAGE = 'sign.storage_bytes';
const AT = new Date('2026-10-19T12:00:00.000Z');
const BUSINESS = 'aramo-sign-standard-business-v1';
const PRO = 'aramo-sign-standard-professional-v1';
let seq = 0;
const tenant = () => `0190cccc-0000-7000-8000-${String(++seq).padStart(12, '0')}`;
const GiB = 1024 ** 3;

class FakeBilling implements BillingProviderPort {
  readonly provider = 'STRIPE' as const;
  live = false;
  subs = new Map<string, ProviderSubscriptionState>();
  last: { intent_id: string; tenant_id: string } | null = null;
  isConfigured() {
    return true;
  }
  mode(): 'test' | 'live' {
    return this.live ? 'live' : 'test';
  }
  async upsertBillingAccount(account_ref: string | null, details: { tenant_id: string }) {
    return account_ref ?? `acct_${details.tenant_id}`;
  }
  async createCheckoutSession(req: { intent_id: string; tenant_id: string }) {
    this.last = req;
    return { session_ref: `cs_${req.intent_id}`, url: `https://checkout.test/${req.intent_id}` };
  }
  async createPortalSession() {
    return { url: 'https://portal.test' };
  }
  async retrieveSubscription(ref: string) {
    const s = this.subs.get(ref);
    if (s === undefined) throw new Error('no such subscription');
    return s;
  }
  verifyWebhook(): never {
    throw new Error('not used');
  }
  complete(price_ref: string, over: Partial<ProviderSubscriptionState> = {}): ProviderSubscriptionState {
    const c = this.last!;
    const s: ProviderSubscriptionState = {
      provider: 'STRIPE',
      subscription_ref: `sub_${c.intent_id}`,
      account_ref: `acct_${c.tenant_id}`,
      provider_status: 'active',
      current_period_start: new Date('2026-10-19T00:00:00Z'),
      current_period_end: new Date('2026-11-19T00:00:00Z'),
      cancel_at_period_end: false,
      price_ref,
      tenant_id: c.tenant_id,
      intent_id: c.intent_id,
      account_country: 'US',
      ...over,
    };
    this.subs.set(s.subscription_ref, s);
    return s;
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('subscription — Commercial Plans Amendment A1 (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let billing: FakeBilling;
  let allowance: AllowanceService;
  let capacity: CapacityService;
  const atsTenants = new Set<string>();
  const eligibility: PlanEligibilityPort = { isEligible: async (t) => atsTenants.has(t) };
  const env = { ...process.env };
  const orgProfile = new FakeOrganizationBillingProfile();
  const svc = (legal?: readonly LegalDocumentVersion[]) => new SubscriptionLifecycleService(prisma, allowance, billing, capacity, eligibility, legal, orgProfile);

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    pg = new Client({ connectionString: container.getConnectionUri() });
    await pg.connect();
    for (const m of MIGRATIONS) await pg.query(readFileSync(m, 'utf8'));
    prisma = new PrismaService(container.getConnectionUri());
    await prisma.$connect();
    process.env['STRIPE_PLAN_PRICES'] = `${BUSINESS}=price_business,${PRO}=price_pro`;
  }, 180_000);

  afterAll(async () => {
    process.env = env;
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  let t: string;
  beforeEach(() => {
    t = tenant();
    billing = new FakeBilling();
    allowance = new AllowanceService(prisma);
    capacity = new CapacityService(prisma);
  });

  const checkout = (plan_key: string, s = svc(), extra: { accept_terms?: boolean } = {}) =>
    s.startCheckout({ tenant_id: t, user_id: 'owner', user_email: 'o@acme.test', plan_key, success_url: 'https://e/ok', cancel_url: 'https://e/no', ...extra });
  const reason = (p: Promise<unknown>) => p.then(() => 'OK', (e: BillingRefusedError) => e.reason);
  async function subscribe(plan_key: string, price: string, over: Partial<ProviderSubscriptionState> = {}) {
    await checkout(plan_key);
    const sub = billing.complete(price, over);
    await svc().syncSubscription(sub.subscription_ref, AT);
    return sub;
  }

  it('the catalog matches the approved matrix exactly', async () => {
    const cat = await svc().catalog(t);
    const byKey = Object.fromEntries(cat.map((p) => [p.key, p]));
    expect(cat.map((p) => p.name)).toEqual(['Free Personal', 'Standard Business', 'Standard Professional', 'Enterprise']);

    const free = byKey['aramo-sign-free-personal-v1']!;
    expect(free).toMatchObject({ tenant_kind: 'PERSONAL', sales_model: 'FREE', status: 'INACTIVE', price: { amount_minor: 0, currency: 'USD', interval: 'MONTH' }, commitment_months: null, support_tier: 'BASIC', purchasable: false });
    expect(free.activation_note).toMatch(/Personal-product sending authorization/);
    expect(free.allowances).toEqual(expect.arrayContaining([
      { allowance_key: KEY, included_quantity: 5, unlimited: false, period: 'MONTHLY', available: true },
      { allowance_key: 'sign.forms', included_quantity: 5, unlimited: false, period: 'MONTHLY', available: false },
    ]));
    expect(free.capacities).toEqual(expect.arrayContaining([
      { capacity_key: 'sign.templates', limit: 1, unlimited: false, available: false },
      { capacity_key: STORAGE, limit: 15 * 1024 * 1024, unlimited: false, available: true },
    ]));
    expect(free.features.every((f) => !f.enabled)).toBe(true);

    for (const [key, price, storage] of [[BUSINESS, 2000, 10 * GiB], [PRO, 1500, 25 * GiB]] as const) {
      const p = byKey[key]!;
      expect(p).toMatchObject({ tenant_kind: 'BUSINESS', sales_model: 'SELF_SERVICE', status: 'ACTIVE', price: { amount_minor: price, currency: 'USD', interval: 'MONTH' }, commitment_months: 12, support_tier: 'BASIC' });
      // "$30 original" is stored, NOT shown: it is not substantiated.
      expect(p.reference_price).toBeNull();
      expect(p.allowances).toEqual(expect.arrayContaining([
        { allowance_key: KEY, included_quantity: null, unlimited: true, period: 'MONTHLY', available: true },
        { allowance_key: 'sign.forms', included_quantity: null, unlimited: true, period: 'MONTHLY', available: false },
      ]));
      expect(p.capacities).toEqual(expect.arrayContaining([
        { capacity_key: 'sign.templates', limit: null, unlimited: true, available: false },
        { capacity_key: STORAGE, limit: storage, unlimited: false, available: true },
      ]));
      // The approved ENTITLEMENT is kept; launch AVAILABILITY is separate (AI
      // assist summary is entitled but not built, so it is not available).
      expect(Object.fromEntries(p.features.map((f) => [f.feature_key, [f.enabled, f.available]]))).toEqual({
        'sign.ai_assist_summary': [true, false],
        'sign.advanced_analytics': [false, false],
        'sign.team_collaboration': [true, true],
        'sign.custom_domain': [false, false],
      });
    }
    expect(byKey[PRO]!.eligibility).toBe('ATS_SUBSCRIPTION');

    // Enterprise: contracted — nothing assumed.
    expect(byKey['aramo-sign-enterprise-v1']).toMatchObject({ sales_model: 'CONTACT_SALES', price: null, support_tier: 'CONTRACTED', allowances: [], capacities: [], features: [], purchasable: false });
    const raw = await pg.query(`SELECT reference_price_minor FROM subscription."Plan" WHERE key = $1`, [BUSINESS]);
    expect(raw.rows[0].reference_price_minor).toBe(3000);
  });

  it('Standard Business has no envelope ceiling: 150 sends all go through, and every one is metered', async () => {
    await subscribe(BUSINESS, 'price_business');
    for (let i = 0; i < 150; i += 1) {
      const r = await allowance.reserve({ tenant_id: t, allowance_key: KEY, send_key: `env:${i}`, at: AT });
      expect(r.ok).toBe(true);
    }
    const s = await allowance.getStatus(t, KEY, AT);
    expect(s).toMatchObject({ subscribed: true, limit: null, unlimited: true, used: 150, remaining: null, threshold: 'OK' });
    const rows = await pg.query(`SELECT count(*)::int AS n FROM subscription."AllowanceUsage" WHERE tenant_id = $1`, [t]);
    expect(rows.rows[0].n).toBe(150);
  }, 30_000);

  it('the pre-catalog operator plan keeps its 100 ceiling (unchanged for existing MANUAL subscriptions)', async () => {
    await openDevelopmentSubscription(prisma, { tenant_id: t, created_by: 'op' }, { ARAMO_ENV: 'test' });
    expect(await allowance.getStatus(t, KEY, AT)).toMatchObject({ limit: 100, unlimited: false });
  });

  it('Standard Professional needs a qualifying ATS entitlement; a lapse is flagged, never auto-downgraded', async () => {
    expect((await svc().catalog(t)).find((p) => p.key === PRO)!.purchasable).toBe(false);
    expect(await reason(checkout(PRO))).toBe('PLAN_NOT_ELIGIBLE');
    // No eligibility binding at all: fail closed.
    expect(await reason(new SubscriptionLifecycleService(prisma, allowance, billing, capacity).startCheckout({ tenant_id: t, user_id: 'o', user_email: 'e', plan_key: PRO, success_url: 'x', cancel_url: 'y' }))).toBe('PLAN_NOT_ELIGIBLE');

    atsTenants.add(t);
    expect((await svc().catalog(t)).find((p) => p.key === PRO)!.purchasable).toBe(true);
    await subscribe(PRO, 'price_pro');
    expect((await svc().account(t, KEY, AT)).subscription).toMatchObject({ plan_key: PRO, eligibility_state: 'OK' });

    atsTenants.delete(t);
    const r = await svc().refreshEligibility(AT);
    expect(r.lapsed).toBeGreaterThanOrEqual(1);
    const acct = await svc().account(t, KEY, AT);
    expect(acct.subscription).toMatchObject({ plan_key: PRO, eligibility_state: 'LAPSED', sending: true });
    expect((await allowance.reserve({ tenant_id: t, allowance_key: KEY, send_key: 'after-lapse', at: AT })).ok).toBe(true);
  });

  it('the annual commitment is separate from the monthly invoice; an early cancel is flagged, not treated as month-to-month', async () => {
    const sub = await subscribe(BUSINESS, 'price_business');
    const acct = await svc().account(t, KEY, AT);
    expect(acct.subscription).toMatchObject({ commitment_months: 12, current_period_end: new Date('2026-11-19T00:00:00Z'), commitment_end: new Date('2027-10-19T00:00:00Z'), cancel_requested_within_commitment: false, list_price: { amount_minor: 2000, currency: 'USD', interval: 'MONTH' } });
    billing.subs.set(sub.subscription_ref, { ...sub, cancel_at_period_end: true });
    await svc().syncSubscription(sub.subscription_ref, AT);
    expect((await svc().account(t, KEY, AT)).subscription).toMatchObject({ cancel_at_period_end: true, cancel_requested_within_commitment: true, sending: true });
  });

  it('a plan change made in the provider moves the subscription to the mapped catalog plan', async () => {
    atsTenants.add(t);
    const sub = await subscribe(BUSINESS, 'price_business');
    billing.subs.set(sub.subscription_ref, { ...sub, price_ref: 'price_pro' });
    await svc().syncSubscription(sub.subscription_ref, AT);
    expect((await svc().account(t, KEY, AT)).subscription?.plan_key).toBe(PRO);
  });

  it('terms: test mode proceeds without approved terms; live mode refuses; an approved version must be accepted and is recorded', async () => {
    expect(await reason(checkout(BUSINESS))).toBe('OK');
    billing.live = true;
    expect(await reason(checkout(BUSINESS))).toBe('TERMS_NOT_APPROVED');

    const approved: LegalDocumentVersion = { ...LEGAL_DOCUMENTS[0]!, version: '1.0.0', status: 'APPROVED', url: 'https://aramo.ai/legal/sign/terms/1.0.0' };
    const withTerms = svc([...LEGAL_DOCUMENTS, approved]);
    expect(await reason(checkout(BUSINESS, withTerms))).toBe('TERMS_NOT_ACCEPTED');
    expect(await reason(checkout(BUSINESS, withTerms, { accept_terms: true }))).toBe('OK');
    const acc = await pg.query(`SELECT document_key, version, sha256, context, context_ref FROM subscription."LegalAcceptance" WHERE tenant_id = $1`, [t]);
    expect(acc.rows).toEqual([{ document_key: 'sign.terms_of_service', version: '1.0.0', sha256: approved.sha256, context: 'CHECKOUT', context_ref: billing.last!.intent_id }]);
    const intent = await pg.query(`SELECT terms_version FROM subscription."CheckoutIntent" WHERE id = $1`, [billing.last!.intent_id]);
    expect(intent.rows[0].terms_version).toBe('1.0.0');
  });

  it('commitment plans never reach the default billing portal: an explicit portal configuration is required and passed', async () => {
    const calls: (string | undefined)[] = [];
    billing.createPortalSession = async (_a: string, _r: string, configuration?: string) => {
      calls.push(configuration);
      return { url: 'https://portal.test' };
    };
    await subscribe(BUSINESS, 'price_business');
    delete process.env['STRIPE_PORTAL_CONFIGURATION'];
    expect(await reason(svc().portal(t, 'https://e/settings'))).toBe('PORTAL_NOT_CONFIGURED');
    process.env['STRIPE_PORTAL_CONFIGURATION'] = 'bpc_commitment_terms';
    expect((await svc().portal(t, 'https://e/settings')).url).toBe('https://portal.test');
    expect(calls).toEqual(['bpc_commitment_terms']);
    delete process.env['STRIPE_PORTAL_CONFIGURATION'];
  });

  it('Free Personal and Enterprise cannot be bought', async () => {
    expect(await reason(checkout('aramo-sign-free-personal-v1'))).toBe('PLAN_NOT_SELLABLE');
    expect(await reason(checkout('aramo-sign-enterprise-v1'))).toBe('PLAN_NOT_SELLABLE');
  });

  describe('storage quota', () => {
    async function smallPlan(limit: number): Promise<void> {
      const id = uuidv7();
      await pg.query(`INSERT INTO subscription."Plan" (id, key, name) VALUES ($1, $2, 'test')`, [id, `test-${id}`]);
      await pg.query(`INSERT INTO subscription."PlanCapacity" (plan_id, capacity_key, limit_quantity, unlimited) VALUES ($1, $2, $3, false)`, [id, STORAGE, limit]);
      await pg.query(`INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, period_anchor, source, created_by) VALUES ($1, $2, $3, now(), 'MANUAL', 'test')`, [uuidv7(), t, id]);
    }

    it('concurrent uploads cannot both take the last free space; a retry of the same object counts once', async () => {
      await smallPlan(1000);
      const results = await Promise.all(Array.from({ length: 5 }, (_, i) => capacity.reserve({ tenant_id: t, capacity_key: STORAGE, ref: `doc:${i}`, quantity: 300 })));
      expect(results.filter((r) => r.ok)).toHaveLength(3);
      const refused = results.find((r) => !r.ok)!;
      expect(refused).toMatchObject({ ok: false, reason: 'CAPACITY_EXCEEDED', status: { limit: 1000, used: 900 } });
      expect(await capacity.reserve({ tenant_id: t, capacity_key: STORAGE, ref: 'doc:0', quantity: 300 })).toMatchObject({ ok: true, already: true });
      expect((await capacity.status(t, STORAGE)).used).toBe(900);
    });

    it('a release frees space; kept objects are recorded beyond the limit, never refused', async () => {
      await smallPlan(500);
      expect((await capacity.reserve({ tenant_id: t, capacity_key: STORAGE, ref: 'a', quantity: 400 })).ok).toBe(true);
      expect((await capacity.reserve({ tenant_id: t, capacity_key: STORAGE, ref: 'b', quantity: 200 })).ok).toBe(false);
      expect(await capacity.release({ tenant_id: t, capacity_key: STORAGE, ref: 'a' })).toBe(true);
      expect((await capacity.reserve({ tenant_id: t, capacity_key: STORAGE, ref: 'b', quantity: 200 })).ok).toBe(true);
      expect((await capacity.reserve({ tenant_id: t, capacity_key: STORAGE, ref: 'signed-copy', quantity: 10_000, enforce: false })).ok).toBe(true);
      expect((await capacity.status(t, STORAGE)).used).toBe(10_200);
    });

    it('no subscription refuses typed; the pre-catalog plan (no storage row) is not limited; tenants are isolated', async () => {
      expect(await capacity.reserve({ tenant_id: t, capacity_key: STORAGE, ref: 'x', quantity: 1 })).toMatchObject({ ok: false, reason: 'NOT_SUBSCRIBED' });
      await openDevelopmentSubscription(prisma, { tenant_id: t, created_by: 'op' }, { ARAMO_ENV: 'test' });
      expect(await capacity.reserve({ tenant_id: t, capacity_key: STORAGE, ref: 'x', quantity: 50 * GiB })).toMatchObject({ ok: true, status: { limit: null, unlimited: true } });
      const other = tenant();
      expect((await capacity.status(other, STORAGE)).used).toBe(0);
    });

    it('the account view reports storage used against the plan', async () => {
      await subscribe(BUSINESS, 'price_business');
      await capacity.reserve({ tenant_id: t, capacity_key: STORAGE, ref: 'doc', quantity: 1234 });
      expect((await svc().account(t, KEY, AT)).storage).toEqual({ capacity_key: STORAGE, limit: 10 * GiB, unlimited: false, used: 1234 });
    });
  });

  it('ending a subscription deletes nothing: usage and evidence rows stay', async () => {
    const sub = await subscribe(BUSINESS, 'price_business');
    await allowance.reserve({ tenant_id: t, allowance_key: KEY, send_key: 'kept', at: AT });
    await capacity.reserve({ tenant_id: t, capacity_key: STORAGE, ref: 'kept-doc', quantity: 10 });
    billing.subs.set(sub.subscription_ref, { ...sub, provider_status: 'canceled' });
    await svc().syncSubscription(sub.subscription_ref, AT);
    const u = await pg.query(`SELECT (SELECT count(*)::int FROM subscription."AllowanceUsage" WHERE tenant_id = $1) AS a, (SELECT count(*)::int FROM subscription."CapacityUsage" WHERE tenant_id = $1 AND state = 'ACTIVE') AS c`, [t]);
    expect(u.rows[0]).toEqual({ a: 1, c: 1 });
    const acct = await svc().account(t, KEY, AT);
    expect(acct.subscription).toMatchObject({ status: 'CANCELED', export_access_until: null });
    process.env['SIGN_POST_TERMINATION_EXPORT_DAYS'] = '90';
    const withWindow = await svc().account(t, KEY, AT);
    expect(withWindow.subscription!.export_access_until!.getTime()).toBe(withWindow.subscription!.ended_at!.getTime() + 90 * 86_400_000);
    delete process.env['SIGN_POST_TERMINATION_EXPORT_DAYS'];
  });
});
