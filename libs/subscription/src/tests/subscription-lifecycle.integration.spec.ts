import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AllowanceService } from '../lib/allowance.service.js';
import { CapacityService } from '../lib/capacity.service.js';
import type { BillingProviderPort, ProviderSubscriptionState } from '../lib/billing/billing-provider.port.js';
import { BillingProviderUnavailableError } from '../lib/billing/billing-provider.port.js';
import { BillingRefusedError, SubscriptionLifecycleService } from '../lib/billing/subscription-lifecycle.service.js';
import { AramoSignStandardBusinessPlanKey, openDevelopmentSubscription } from '../lib/development-subscription.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// Aramo Sign launch — the commercial-authority invariants on real Postgres 17:
// owner-attributed activation, replacement of an operator subscription, status +
// grace, ended-never-reopens, tenant-mismatch refusal, event idempotency, failed
// processing retried, reconciliation, and refusals (unconfigured / not sellable /
// already subscribed).

const MIGRATIONS = [
  '../../../metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
  '../../prisma/migrations/20261018120000_init_subscription_allowance/migration.sql',
  '../../prisma/migrations/20261019100000_subscription_lifecycle_billing/migration.sql',
  '../../prisma/migrations/20261019140000_sign_commercial_catalog_a1/migration.sql',
  '../../prisma/migrations/20261020130300_sign_naming_keys/migration.sql',
].map((p) => resolve(__dirname, p));

const KEY = 'sign.envelopes';
const AT = new Date('2026-10-18T12:00:00.000Z');
let seq = 0;
const tenant = () => `0190bbbb-0000-7000-8000-${String(++seq).padStart(12, '0')}`;

class FakeBilling implements BillingProviderPort {
  readonly provider = 'STRIPE' as const;
  configured = true;
  live = false;
  mode(): 'test' | 'live' {
    return this.live ? 'live' : 'test';
  }
  subs = new Map<string, ProviderSubscriptionState>();
  checkouts: { intent_id: string; tenant_id: string; account_ref: string | null }[] = [];
  failRetrieve = false;
  isConfigured() {
    return this.configured;
  }
  async createCheckoutSession(req: { intent_id: string; tenant_id: string; account_ref: string | null }) {
    this.checkouts.push(req);
    return { session_ref: `cs_${req.intent_id}`, url: `https://checkout.test/${req.intent_id}` };
  }
  async createPortalSession(account_ref: string) {
    return { url: `https://portal.test/${account_ref}` };
  }
  async retrieveSubscription(ref: string) {
    if (this.failRetrieve) throw new BillingProviderUnavailableError('down');
    const s = this.subs.get(ref);
    if (s === undefined) throw new BillingProviderUnavailableError('no such subscription');
    return s;
  }
  verifyWebhook(): never {
    throw new Error('not used');
  }
  /** Simulate the provider creating a subscription for the last checkout. */
  complete(status: string, overrides: Partial<ProviderSubscriptionState> = {}): ProviderSubscriptionState {
    const c = this.checkouts[this.checkouts.length - 1]!;
    const s: ProviderSubscriptionState = {
      provider: 'STRIPE',
      subscription_ref: `sub_${c.intent_id}`,
      account_ref: `cus_${c.tenant_id}`,
      provider_status: status,
      current_period_start: new Date('2026-10-18T00:00:00Z'),
      current_period_end: new Date('2026-11-18T00:00:00Z'),
      cancel_at_period_end: false,
      price_ref: 'price_business',
      tenant_id: c.tenant_id,
      intent_id: c.intent_id,
      ...overrides,
    };
    this.subs.set(s.subscription_ref, s);
    return s;
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('subscription — lifecycle + billing (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let billing: FakeBilling;
  let svc: SubscriptionLifecycleService;
  let allowance: AllowanceService;
  const env = { ...process.env };

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    pg = new Client({ connectionString: container.getConnectionUri() });
    await pg.connect();
    for (const m of MIGRATIONS) await pg.query(readFileSync(m, 'utf8'));
    prisma = new PrismaService(container.getConnectionUri());
    await prisma.$connect();
    process.env['STRIPE_PLAN_PRICES'] = `${AramoSignStandardBusinessPlanKey}=price_business,aramo-sign-standard-professional-v1=price_professional`;
    delete process.env['BILLING_PAST_DUE_GRACE_DAYS'];
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
    svc = new SubscriptionLifecycleService(prisma, allowance, billing, new CapacityService(prisma));
  });

  const checkout = (tenant_id = t, user_id = 'owner-1') =>
    svc.startCheckout({ tenant_id, user_id, user_email: 'o@acme.test', plan_key: AramoSignStandardBusinessPlanKey, success_url: 'https://e/ok', cancel_url: 'https://e/no' });
  const event = (id: string, ref: string, type = 'subscription.updated') => ({ id, type, created: AT, subscription_ref: ref });

  it('the catalog: Standard Business purchasable when a price is configured; the operator plan hidden', async () => {
    const plans = await svc.catalog(t);
    expect(plans.map((p) => p.key)).toEqual(['aramo-sign-free-personal-v1', AramoSignStandardBusinessPlanKey, 'aramo-sign-standard-professional-v1', 'aramo-sign-enterprise-v1']);
    expect(plans.find((p) => p.key === AramoSignStandardBusinessPlanKey)).toMatchObject({ purchasable: true, allowances: expect.arrayContaining([{ allowance_key: KEY, included_quantity: null, unlimited: true, period: 'MONTHLY', available: true }]) });
    billing.configured = false;
    expect((await svc.catalog(t)).find((p) => p.key === AramoSignStandardBusinessPlanKey)!.purchasable).toBe(false);
  });

  it('checkout → paid → a SELF_SERVICE subscription opens, attributed to the subscribing owner', async () => {
    expect((await checkout()).url).toMatch(/^https:\/\/checkout\.test\//);
    expect((await svc.account(t, KEY, AT)).allowance.subscribed).toBe(false);
    const sub = billing.complete('active');
    const res = await svc.handleEvent({ id: 'evt_a1', type: 'checkout.session.completed', created: AT, subscription_ref: sub.subscription_ref }, AT);
    expect(res).toMatchObject({ outcome: 'APPLIED', tenant_id: t, activated_owner_user_id: 'owner-1' });
    const acct = await svc.account(t, KEY, AT);
    expect(acct.subscription).toMatchObject({ plan_key: AramoSignStandardBusinessPlanKey, source: 'SELF_SERVICE', status: 'ACTIVE', sending: true, billing_managed: true });
    expect(acct.allowance).toMatchObject({ subscribed: true, limit: null, unlimited: true, used: 0, remaining: null });
    const intent = await pg.query('SELECT status FROM subscription."CheckoutIntent" WHERE tenant_id = $1', [t]);
    expect(intent.rows[0].status).toBe('COMPLETED');
  });

  it('the same event twice is processed once; a different event for the same state does not re-activate', async () => {
    await checkout();
    const sub = billing.complete('active');
    expect((await svc.handleEvent(event('evt_b1', sub.subscription_ref), AT)).outcome).toBe('APPLIED');
    expect((await svc.handleEvent(event('evt_b1', sub.subscription_ref), AT)).outcome).toBe('DUPLICATE');
    // Operator view: the tenant's events, newest first, no payloads.
    const events = await svc.recentBillingEvents(t);
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!).sort()).toEqual(['detail', 'event_created_at', 'event_type', 'outcome', 'received_at']);
    const again = await svc.handleEvent(event('evt_b2', sub.subscription_ref), AT);
    expect(again).toMatchObject({ outcome: 'APPLIED' });
    expect('activated_owner_user_id' in again && again.activated_owner_user_id).toBeFalsy();
    const n = await pg.query('SELECT count(*)::int AS n FROM subscription."TenantSubscription" WHERE tenant_id = $1', [t]);
    expect(n.rows[0].n).toBe(1);
  });

  it('an event that concerns no subscription is recorded IGNORED', async () => {
    expect(await svc.handleEvent({ id: 'evt_n1', type: 'invoice.created', created: AT, subscription_ref: null }, AT)).toMatchObject({ outcome: 'IGNORED' });
    expect((await svc.handleEvent({ id: 'evt_n1', type: 'invoice.created', created: AT, subscription_ref: null }, AT)).outcome).toBe('DUPLICATE');
  });

  it('a provider failure is not recorded, so the redelivery is processed', async () => {
    await checkout();
    const sub = billing.complete('active');
    billing.failRetrieve = true;
    await expect(svc.handleEvent(event('evt_c1', sub.subscription_ref), AT)).rejects.toThrow(BillingProviderUnavailableError);
    billing.failRetrieve = false;
    expect((await svc.handleEvent(event('evt_c1', sub.subscription_ref), AT)).outcome).toBe('APPLIED');
  });

  it('replaces an operator-opened DEVELOPMENT subscription in the same transaction (still one open row)', async () => {
    await openDevelopmentSubscription(prisma, { tenant_id: t, created_by: 'op' }, { ARAMO_ENV: 'test' });
    await checkout();
    const sub = billing.complete('active');
    expect((await svc.syncSubscription(sub.subscription_ref, AT)).detail).toContain('ended DEVELOPMENT');
    const open = await pg.query('SELECT source FROM subscription."TenantSubscription" WHERE tenant_id = $1 AND ended_at IS NULL', [t]);
    expect(open.rows).toEqual([{ source: 'SELF_SERVICE' }]);
  });

  it('an incomplete payment never ends a working subscription and never sends', async () => {
    await openDevelopmentSubscription(prisma, { tenant_id: t, created_by: 'op' }, { ARAMO_ENV: 'test' });
    await checkout();
    const sub = billing.complete('incomplete');
    expect((await svc.syncSubscription(sub.subscription_ref, AT)).outcome).toBe('IGNORED');
    expect((await svc.account(t, KEY, AT)).subscription?.source).toBe('DEVELOPMENT');
  });

  it('past_due keeps sending through grace, then stops; recovery resumes; cancel ends and never reopens', async () => {
    await checkout();
    const sub = billing.complete('active');
    await svc.syncSubscription(sub.subscription_ref, AT);
    billing.subs.set(sub.subscription_ref, { ...sub, provider_status: 'past_due' });
    await svc.syncSubscription(sub.subscription_ref, AT);
    const inGrace = new Date(AT.getTime() + 6 * 86_400_000);
    const afterGrace = new Date(AT.getTime() + 8 * 86_400_000);
    // A second past_due sync must not extend the grace window.
    await svc.syncSubscription(sub.subscription_ref, inGrace);
    expect((await allowance.reserve({ tenant_id: t, allowance_key: KEY, send_key: 'g1', at: inGrace })).ok).toBe(true);
    const refused = await allowance.reserve({ tenant_id: t, allowance_key: KEY, send_key: 'g2', at: afterGrace });
    expect(refused).toMatchObject({ ok: false, reason: 'NOT_SUBSCRIBED', status: { state: 'PAST_DUE' } });

    billing.subs.set(sub.subscription_ref, { ...sub, provider_status: 'active' });
    const recovered = await svc.syncSubscription(sub.subscription_ref, afterGrace);
    // PAST_DUE is a lifecycle (not ended) state: the owner role was never revoked,
    // so recovery does not re-grant it.
    expect(recovered).toMatchObject({ outcome: 'APPLIED', detail: 'PAST_DUE -> ACTIVE' });
    expect('activated_owner_user_id' in recovered).toBe(false);
    expect((await allowance.reserve({ tenant_id: t, allowance_key: KEY, send_key: 'g3', at: afterGrace })).ok).toBe(true);

    billing.subs.set(sub.subscription_ref, { ...sub, provider_status: 'canceled' });
    await svc.syncSubscription(sub.subscription_ref, afterGrace);
    const acct = await svc.account(t, KEY, afterGrace);
    expect(acct.subscription).toMatchObject({ status: 'CANCELED', sending: false });
    expect(acct.allowance).toMatchObject({ subscribed: false, state: 'NONE' });
    billing.subs.set(sub.subscription_ref, { ...sub, provider_status: 'active' });
    expect((await svc.syncSubscription(sub.subscription_ref, afterGrace)).detail).toBe('subscription already ended');
    // A resubscription is a new checkout, reusing the provider billing account.
    await checkout();
    expect(billing.checkouts[billing.checkouts.length - 1]!.account_ref).toBe(`cus_${t}`);
  });

  it('refuses a provider subscription whose metadata names another tenant', async () => {
    await checkout();
    const sub = billing.complete('active', { tenant_id: tenant() });
    expect(await svc.syncSubscription(sub.subscription_ref, AT)).toMatchObject({ outcome: 'IGNORED', detail: expect.stringContaining('does not match') });
    expect((await svc.account(t, KEY, AT)).subscription).toBeNull();
  });

  it('ignores a provider subscription that no Aramo checkout started', async () => {
    billing.subs.set('sub_foreign', { ...billing.complete.call({ checkouts: [{ intent_id: 'none', tenant_id: t }], subs: new Map() } as unknown as FakeBilling, 'active'), intent_id: null, tenant_id: null, subscription_ref: 'sub_foreign' });
    expect(await svc.syncSubscription('sub_foreign', AT)).toMatchObject({ outcome: 'IGNORED', tenant_id: null });
  });

  it('refusals: billing unconfigured, unknown plan, already self-service subscribed, no billing account for the portal', async () => {
    const reason = async (p: Promise<unknown>) => p.then(() => 'OK', (e: BillingRefusedError) => e.reason);
    billing.configured = false;
    expect(await reason(checkout())).toBe('BILLING_UNAVAILABLE');
    billing.configured = true;
    expect(await reason(svc.startCheckout({ tenant_id: t, user_id: 'u', user_email: 'e', plan_key: 'aramo-sign-included-v1', success_url: 'x', cancel_url: 'y' }))).toBe('PLAN_NOT_SELLABLE');
    expect(await reason(svc.portal(t, 'https://e/settings'))).toBe('NO_BILLING_ACCOUNT');
    await checkout();
    await svc.syncSubscription(billing.complete('active').subscription_ref, AT);
    expect(await reason(checkout())).toBe('ALREADY_SUBSCRIBED');
    // A1 review: a commitment plan's portal needs an explicit configuration.
    expect(await reason(svc.portal(t, 'https://e/settings'))).toBe('PORTAL_NOT_CONFIGURED');
    process.env['STRIPE_PORTAL_CONFIGURATION'] = 'bpc_test';
    expect((await svc.portal(t, 'https://e/settings')).url).toBe(`https://portal.test/cus_${t}`);
    delete process.env['STRIPE_PORTAL_CONFIGURATION'];
  });

  it('reconcile re-fetches open provider-linked subscriptions and tolerates a provider outage', async () => {
    await checkout();
    const sub = billing.complete('active');
    await svc.syncSubscription(sub.subscription_ref, AT);
    billing.subs.set(sub.subscription_ref, { ...sub, cancel_at_period_end: true });
    // Rows from earlier cases belong to other fake providers and fail to fetch
    // here: one failure never stops the sweep.
    const r = await svc.reconcile(AT);
    expect(r.results.some((x) => x.tenant_id === t && x.outcome === 'APPLIED')).toBe(true);
    expect((await svc.account(t, KEY, AT)).subscription?.cancel_at_period_end).toBe(true);
    billing.failRetrieve = true;
    const down = await svc.reconcile(AT);
    expect(down.failed).toBe(down.checked);
  });
});
