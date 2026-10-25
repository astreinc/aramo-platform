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

import { FakeOrganizationBillingProfile, US_PROFILE } from './fixtures/organization-billing-profile.fake.js';
import { CCP_A4_MIGRATION } from './fixtures/ccp-a4.js';
import { CCP_A5_MIGRATION } from './fixtures/ccp-a5.js';

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
  '../../prisma/migrations/20261022100100_billing_account_country_guard/migration.sql',
  '../../prisma/migrations/20261022110100_billing_flag_domain_reason/migration.sql',
  '../../prisma/migrations/20261023100000_sign_personal_free/migration.sql',
].map((p) => resolve(__dirname, p)).concat(CCP_A4_MIGRATION, CCP_A5_MIGRATION);

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
  accounts: { account_ref: string | null; details: unknown; result: string }[] = [];
  isConfigured() {
    return this.configured;
  }
  async upsertBillingAccount(account_ref: string | null, details: { tenant_id: string }) {
    const result = account_ref ?? `cus_${details.tenant_id}`;
    this.accounts.push({ account_ref, details, result });
    return result;
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
      account_ref: c.account_ref ?? `cus_${c.tenant_id}`,
      provider_status: status,
      current_period_start: new Date('2026-10-18T00:00:00Z'),
      current_period_end: new Date('2026-11-18T00:00:00Z'),
      cancel_at_period_end: false,
      price_ref: 'price_business',
      tenant_id: c.tenant_id,
      intent_id: c.intent_id,
      account_country: 'US',
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
  let orgProfile: FakeOrganizationBillingProfile;
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
    orgProfile = new FakeOrganizationBillingProfile();
    svc = new SubscriptionLifecycleService(prisma, allowance, billing, new CapacityService(prisma), undefined, undefined, orgProfile);
  });

  const checkout = (tenant_id = t, user_id = 'owner-1') =>
    svc.startCheckout({ product_key: 'sign', tenant_id, user_id, user_email: 'o@acme.test', plan_key: AramoSignStandardBusinessPlanKey, success_url: 'https://e/ok', cancel_url: 'https://e/no' });
  const event = (id: string, ref: string, type = 'subscription.updated') => ({ id, type, created: AT, subscription_ref: ref });

  it('the catalog: Standard Business purchasable when a price is configured; the operator plan hidden', async () => {
    const plans = await svc.catalog('sign', t);
    expect(plans.map((p) => p.key)).toEqual(['aramo-sign-free-personal-v1', AramoSignStandardBusinessPlanKey, 'aramo-sign-standard-professional-v1', 'aramo-sign-enterprise-v1']);
    expect(plans.find((p) => p.key === AramoSignStandardBusinessPlanKey)).toMatchObject({ purchasable: true, allowances: expect.arrayContaining([{ allowance_key: KEY, included_quantity: null, unlimited: true, period: 'MONTHLY', available: true }]) });
    billing.configured = false;
    expect((await svc.catalog('sign', t)).find((p) => p.key === AramoSignStandardBusinessPlanKey)!.purchasable).toBe(false);
  });

  it('checkout → paid → a SELF_SERVICE subscription opens, attributed to the subscribing owner', async () => {
    expect((await checkout()).url).toMatch(/^https:\/\/checkout\.test\//);
    expect((await svc.account(t, 'sign', KEY, AT)).allowance.subscribed).toBe(false);
    const sub = billing.complete('active');
    const res = await svc.handleEvent({ id: 'evt_a1', type: 'checkout.session.completed', created: AT, subscription_ref: sub.subscription_ref }, 'sign', AT);
    expect(res).toMatchObject({ outcome: 'APPLIED', tenant_id: t, activated_owner_user_id: 'owner-1' });
    const acct = await svc.account(t, 'sign', KEY, AT);
    expect(acct.subscription).toMatchObject({ plan_key: AramoSignStandardBusinessPlanKey, source: 'SELF_SERVICE', status: 'ACTIVE', sending: true, billing_managed: true });
    expect(acct.allowance).toMatchObject({ subscribed: true, limit: null, unlimited: true, used: 0, remaining: null });
    const intent = await pg.query('SELECT status FROM subscription."CheckoutIntent" WHERE tenant_id = $1', [t]);
    expect(intent.rows[0].status).toBe('COMPLETED');
  });

  it('the same event twice is processed once; a different event for the same state does not re-activate', async () => {
    await checkout();
    const sub = billing.complete('active');
    expect((await svc.handleEvent(event('evt_b1', sub.subscription_ref), 'sign', AT)).outcome).toBe('APPLIED');
    expect((await svc.handleEvent(event('evt_b1', sub.subscription_ref), 'sign', AT)).outcome).toBe('DUPLICATE');
    // Operator view: the tenant's events, newest first, no payloads.
    const events = await svc.recentBillingEvents(t);
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!).sort()).toEqual(['detail', 'event_created_at', 'event_type', 'outcome', 'received_at']);
    const again = await svc.handleEvent(event('evt_b2', sub.subscription_ref), 'sign', AT);
    expect(again).toMatchObject({ outcome: 'APPLIED' });
    expect('activated_owner_user_id' in again && again.activated_owner_user_id).toBeFalsy();
    const n = await pg.query('SELECT count(*)::int AS n FROM subscription."TenantSubscription" WHERE tenant_id = $1', [t]);
    expect(n.rows[0].n).toBe(1);
  });

  it('an event that concerns no subscription is recorded IGNORED', async () => {
    expect(await svc.handleEvent({ id: 'evt_n1', type: 'invoice.created', created: AT, subscription_ref: null }, 'sign', AT)).toMatchObject({ outcome: 'IGNORED' });
    expect((await svc.handleEvent({ id: 'evt_n1', type: 'invoice.created', created: AT, subscription_ref: null }, 'sign', AT)).outcome).toBe('DUPLICATE');
  });

  it('a provider failure is not recorded, so the redelivery is processed', async () => {
    await checkout();
    const sub = billing.complete('active');
    billing.failRetrieve = true;
    await expect(svc.handleEvent(event('evt_c1', sub.subscription_ref), 'sign', AT)).rejects.toThrow(BillingProviderUnavailableError);
    billing.failRetrieve = false;
    expect((await svc.handleEvent(event('evt_c1', sub.subscription_ref), 'sign', AT)).outcome).toBe('APPLIED');
  });

  it('replaces an operator-opened DEVELOPMENT subscription in the same transaction (still one open row)', async () => {
    await openDevelopmentSubscription(prisma, { product_key: 'sign', tenant_id: t, created_by: 'op' }, { ARAMO_ENV: 'test' });
    await checkout();
    const sub = billing.complete('active');
    expect((await svc.syncSubscription(sub.subscription_ref, 'sign', AT)).detail).toContain('ended DEVELOPMENT');
    const open = await pg.query('SELECT source FROM subscription."TenantSubscription" WHERE tenant_id = $1 AND ended_at IS NULL', [t]);
    expect(open.rows).toEqual([{ source: 'SELF_SERVICE' }]);
  });

  it('an incomplete payment never ends a working subscription and never sends', async () => {
    await openDevelopmentSubscription(prisma, { product_key: 'sign', tenant_id: t, created_by: 'op' }, { ARAMO_ENV: 'test' });
    await checkout();
    const sub = billing.complete('incomplete');
    expect((await svc.syncSubscription(sub.subscription_ref, 'sign', AT)).outcome).toBe('IGNORED');
    expect((await svc.account(t, 'sign', KEY, AT)).subscription?.source).toBe('DEVELOPMENT');
  });

  it('past_due keeps sending through grace, then stops; recovery resumes; cancel ends and never reopens', async () => {
    await checkout();
    const sub = billing.complete('active');
    await svc.syncSubscription(sub.subscription_ref, 'sign', AT);
    billing.subs.set(sub.subscription_ref, { ...sub, provider_status: 'past_due' });
    await svc.syncSubscription(sub.subscription_ref, 'sign', AT);
    const inGrace = new Date(AT.getTime() + 6 * 86_400_000);
    const afterGrace = new Date(AT.getTime() + 8 * 86_400_000);
    // A second past_due sync must not extend the grace window.
    await svc.syncSubscription(sub.subscription_ref, 'sign', inGrace);
    expect((await allowance.reserve({ product_key: 'sign', tenant_id: t, allowance_key: KEY, send_key: 'g1', at: inGrace })).ok).toBe(true);
    const refused = await allowance.reserve({ product_key: 'sign', tenant_id: t, allowance_key: KEY, send_key: 'g2', at: afterGrace });
    expect(refused).toMatchObject({ ok: false, reason: 'NOT_SUBSCRIBED', status: { state: 'PAST_DUE' } });

    billing.subs.set(sub.subscription_ref, { ...sub, provider_status: 'active' });
    const recovered = await svc.syncSubscription(sub.subscription_ref, 'sign', afterGrace);
    // PAST_DUE is a lifecycle (not ended) state: the owner role was never revoked,
    // so recovery does not re-grant it.
    expect(recovered).toMatchObject({ outcome: 'APPLIED', detail: 'PAST_DUE -> ACTIVE' });
    expect('activated_owner_user_id' in recovered).toBe(false);
    expect((await allowance.reserve({ product_key: 'sign', tenant_id: t, allowance_key: KEY, send_key: 'g3', at: afterGrace })).ok).toBe(true);

    billing.subs.set(sub.subscription_ref, { ...sub, provider_status: 'canceled' });
    await svc.syncSubscription(sub.subscription_ref, 'sign', afterGrace);
    const acct = await svc.account(t, 'sign', KEY, afterGrace);
    expect(acct.subscription).toMatchObject({ status: 'CANCELED', sending: false });
    expect(acct.allowance).toMatchObject({ subscribed: false, state: 'NONE' });
    billing.subs.set(sub.subscription_ref, { ...sub, provider_status: 'active' });
    expect((await svc.syncSubscription(sub.subscription_ref, 'sign', afterGrace)).detail).toBe('subscription already ended');
    // A resubscription is a new checkout, reusing the provider billing account.
    await checkout();
    expect(billing.checkouts[billing.checkouts.length - 1]!.account_ref).toBe(`cus_${t}`);
  });

  it('refuses a provider subscription whose metadata names another tenant', async () => {
    await checkout();
    const sub = billing.complete('active', { tenant_id: tenant() });
    expect(await svc.syncSubscription(sub.subscription_ref, 'sign', AT)).toMatchObject({ outcome: 'IGNORED', detail: expect.stringContaining('does not match') });
    expect((await svc.account(t, 'sign', KEY, AT)).subscription).toBeNull();
  });

  it('ignores a provider subscription that no Aramo checkout started', async () => {
    billing.subs.set('sub_foreign', { ...billing.complete.call({ checkouts: [{ intent_id: 'none', tenant_id: t }], subs: new Map() } as unknown as FakeBilling, 'active'), intent_id: null, tenant_id: null, subscription_ref: 'sub_foreign' });
    expect(await svc.syncSubscription('sub_foreign', 'sign', AT)).toMatchObject({ outcome: 'IGNORED', tenant_id: null });
  });

  it('refusals: billing unconfigured, unknown plan, already self-service subscribed, no billing account for the portal', async () => {
    const reason = async (p: Promise<unknown>) => p.then(() => 'OK', (e: BillingRefusedError) => e.reason);
    billing.configured = false;
    expect(await reason(checkout())).toBe('BILLING_UNAVAILABLE');
    billing.configured = true;
    expect(await reason(svc.startCheckout({ product_key: 'sign', tenant_id: t, user_id: 'u', user_email: 'e', plan_key: 'aramo-sign-included-v1', success_url: 'x', cancel_url: 'y' }))).toBe('PLAN_NOT_SELLABLE');
    expect(await reason(svc.portal(t, 'sign', 'https://e/settings'))).toBe('NO_BILLING_ACCOUNT');
    await checkout();
    await svc.syncSubscription(billing.complete('active').subscription_ref, 'sign', AT);
    expect(await reason(checkout())).toBe('ALREADY_SUBSCRIBED');
    // A1 review: a commitment plan's portal needs an explicit configuration.
    expect(await reason(svc.portal(t, 'sign', 'https://e/settings'))).toBe('PORTAL_NOT_CONFIGURED');
    process.env['STRIPE_PORTAL_CONFIGURATION'] = 'bpc_test';
    expect((await svc.portal(t, 'sign', 'https://e/settings')).url).toBe(`https://portal.test/cus_${t}`);
    delete process.env['STRIPE_PORTAL_CONFIGURATION'];
  });

  it('reconcile re-fetches open provider-linked subscriptions and tolerates a provider outage', async () => {
    await checkout();
    const sub = billing.complete('active');
    await svc.syncSubscription(sub.subscription_ref, 'sign', AT);
    billing.subs.set(sub.subscription_ref, { ...sub, cancel_at_period_end: true });
    // Rows from earlier cases belong to other fake providers and fail to fetch
    // here: one failure never stops the sweep.
    const r = await svc.reconcile('sign', AT);
    expect(r.results.some((x) => x.tenant_id === t && x.outcome === 'APPLIED')).toBe(true);
    expect((await svc.account(t, 'sign', KEY, AT)).subscription?.cancel_at_period_end).toBe(true);
    billing.failRetrieve = true;
    const down = await svc.reconcile('sign', AT);
    expect(down.failed).toBe(down.checked);
  });
  // ── Sign Signup Amendment A1 (Organization Details, US only) §2.6 ──────────
  const reasonOf = async (p: Promise<unknown>) => p.then(() => 'OK', (e: BillingRefusedError) => `${e.reason}:${e.message}`);
  const flags = async (tenant_id: string) =>
    (await pg.query('SELECT subscription_ref, reason, account_country, intent_id, resolved_at FROM subscription."BillingReconciliationFlag" WHERE tenant_id = $1 ORDER BY detected_at', [tenant_id])).rows;
  const subRows = async (tenant_id: string) =>
    (await pg.query('SELECT status, ended_at FROM subscription."TenantSubscription" WHERE tenant_id = $1', [tenant_id])).rows;

  it('A1: checkout is refused without an eligible organization profile (both reasons; unbound port fails closed)', async () => {
    orgProfile.refused = 'organization_country_not_supported';
    expect(await reasonOf(checkout())).toBe('ORGANIZATION_PROFILE_REQUIRED:organization_country_not_supported');
    orgProfile.refused = 'organization_profile_incomplete';
    expect(await reasonOf(checkout())).toBe('ORGANIZATION_PROFILE_REQUIRED:organization_profile_incomplete');
    const unbound = new SubscriptionLifecycleService(prisma, allowance, billing, new CapacityService(prisma));
    expect(await reasonOf(unbound.startCheckout({ product_key: 'sign', tenant_id: t, user_id: 'o', user_email: 'e', plan_key: AramoSignStandardBusinessPlanKey, success_url: 'x', cancel_url: 'y' }))).toBe(
      'ORGANIZATION_PROFILE_REQUIRED:organization_profile_incomplete',
    );
    // Nothing was started, locked or created.
    expect(billing.checkouts).toHaveLength(0);
    expect(billing.accounts).toHaveLength(0);
    expect(orgProfile.locked).toEqual([]);
    expect((await pg.query('SELECT count(*)::int AS n FROM subscription."CheckoutIntent" WHERE tenant_id = $1', [t])).rows[0].n).toBe(0);
    expect((await pg.query('SELECT count(*)::int AS n FROM subscription."TenantBillingAccount" WHERE tenant_id = $1', [t])).rows[0].n).toBe(0);
  });

  it('A1: checkout locks the region, creates the billing account from the profile, persists the mapping and runs on it', async () => {
    await checkout();
    expect(orgProfile.locked).toEqual([t]);
    expect(billing.accounts).toEqual([{ account_ref: null, details: { tenant_id: t, legal_name: US_PROFILE.legal_name, billing_email: US_PROFILE.billing_email, address: US_PROFILE.address }, result: `cus_${t}` }]);
    expect(billing.checkouts[0]!.account_ref).toBe(`cus_${t}`);
    const map = await pg.query('SELECT provider, account_ref FROM subscription."TenantBillingAccount" WHERE tenant_id = $1', [t]);
    expect(map.rows).toEqual([{ provider: 'STRIPE', account_ref: `cus_${t}` }]);
  });

  it('A1: a second checkout reuses the mapped billing account and updates its details', async () => {
    await checkout();
    orgProfile.profile = { ...US_PROFILE, legal_name: 'Acme Renamed LLC', address: { ...US_PROFILE.address, line2: 'Suite 9' } };
    await checkout();
    expect(billing.accounts[1]).toMatchObject({ account_ref: `cus_${t}`, details: { legal_name: 'Acme Renamed LLC', address: { line2: 'Suite 9' } } });
    expect(billing.checkouts[1]!.account_ref).toBe(`cus_${t}`);
    expect((await pg.query('SELECT count(*)::int AS n FROM subscription."TenantBillingAccount" WHERE tenant_id = $1', [t])).rows[0].n).toBe(1);
  });

  it('A1: a pre-A1 subscription account is reused when no mapping exists yet', async () => {
    await checkout();
    await svc.syncSubscription(billing.complete('active').subscription_ref, 'sign', AT);
    await pg.query('DELETE FROM subscription."TenantBillingAccount" WHERE tenant_id = $1', [t]);
    // The provider subscription ends; a resubscription starts a new checkout.
    await svc.syncSubscription(billing.complete('canceled').subscription_ref, 'sign', AT);
    await checkout();
    expect(billing.accounts[1]!.account_ref).toBe(`cus_${t}`);
  });

  it('A1 guard: a non-US billing country opens nothing; the event is IGNORED evidence; one flag across repeated syncs', async () => {
    await checkout();
    const sub = billing.complete('active', { account_country: 'CA' });
    const res = await svc.handleEvent(event('evt_g1', sub.subscription_ref), 'sign', AT);
    expect(res).toEqual({ outcome: 'IGNORED', detail: 'billing_country_not_supported: held for reconciliation', tenant_id: t });
    expect('activated_owner_user_id' in res).toBe(false);
    await svc.handleEvent(event('evt_g2', sub.subscription_ref), 'sign', AT);
    await svc.syncSubscription(sub.subscription_ref, 'sign', AT);
    expect(await subRows(t)).toEqual([]);
    expect((await svc.account(t, 'sign', KEY, AT)).allowance.subscribed).toBe(false);
    const ev = await pg.query('SELECT outcome, detail FROM subscription."BillingEvent" WHERE tenant_id = $1 ORDER BY received_at', [t]);
    expect(ev.rows).toEqual([
      { outcome: 'IGNORED', detail: 'billing_country_not_supported: held for reconciliation' },
      { outcome: 'IGNORED', detail: 'billing_country_not_supported: held for reconciliation' },
    ]);
    const f = await flags(t);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ subscription_ref: sub.subscription_ref, reason: 'billing_country_not_supported', account_country: 'CA', intent_id: billing.checkouts[0]!.intent_id, resolved_at: null });
  });

  it('A1 guard: a missing billing country fails closed', async () => {
    await checkout();
    const sub = billing.complete('active', { account_country: null });
    expect((await svc.syncSubscription(sub.subscription_ref, 'sign', AT)).outcome).toBe('IGNORED');
    expect(await subRows(t)).toEqual([]);
    expect(await flags(t)).toMatchObject([{ account_country: null, resolved_at: null }]);
  });

  it('A1 guard: a later US sync opens the subscription, activates the owner and resolves the flag', async () => {
    await checkout();
    const sub = billing.complete('active', { account_country: 'GB' });
    await svc.syncSubscription(sub.subscription_ref, 'sign', AT);
    billing.subs.set(sub.subscription_ref, { ...sub, account_country: 'us' });
    const res = await svc.syncSubscription(sub.subscription_ref, 'sign', AT);
    expect(res).toMatchObject({ outcome: 'APPLIED', activated_owner_user_id: 'owner-1' });
    expect(await subRows(t)).toMatchObject([{ status: 'ACTIVE', ended_at: null }]);
    const f = await flags(t);
    expect(f).toHaveLength(1);
    expect(f[0].resolved_at).toEqual(AT);
  });

  it('A1 guard: an existing subscription is never (re)activated while non-US; cancellation still applies', async () => {
    await checkout();
    // Opened INCOMPLETE under a US country (no sending), then the country changes.
    const sub = billing.complete('incomplete');
    await svc.syncSubscription(sub.subscription_ref, 'sign', AT);
    expect(await subRows(t)).toMatchObject([{ status: 'INCOMPLETE' }]);
    billing.subs.set(sub.subscription_ref, { ...sub, provider_status: 'active', account_country: 'MX' });
    const held = await svc.syncSubscription(sub.subscription_ref, 'sign', AT);
    expect(held).toMatchObject({ outcome: 'IGNORED', detail: expect.stringContaining('billing_country_not_supported: held for reconciliation') });
    expect('activated_owner_user_id' in held).toBe(false);
    expect(await subRows(t)).toMatchObject([{ status: 'INCOMPLETE', ended_at: null }]);
    expect((await svc.account(t, 'sign', KEY, AT)).allowance.subscribed).toBe(false);
    await svc.syncSubscription(sub.subscription_ref, 'sign', AT);
    expect(await flags(t)).toHaveLength(1);
    billing.subs.set(sub.subscription_ref, { ...sub, provider_status: 'canceled', account_country: 'MX' });
    await svc.syncSubscription(sub.subscription_ref, 'sign', AT);
    expect(await subRows(t)).toMatchObject([{ status: 'CANCELED', ended_at: AT }]);
  });

  it('A1 guard: an active subscription whose country turns non-US is kept as is and flagged; US again resolves', async () => {
    await checkout();
    const sub = billing.complete('active');
    await svc.syncSubscription(sub.subscription_ref, 'sign', AT);
    billing.subs.set(sub.subscription_ref, { ...sub, account_country: 'CA' });
    expect((await svc.syncSubscription(sub.subscription_ref, 'sign', AT)).outcome).toBe('IGNORED');
    expect(await subRows(t)).toMatchObject([{ status: 'ACTIVE', ended_at: null }]);
    expect(await flags(t)).toMatchObject([{ resolved_at: null }]);
    billing.subs.set(sub.subscription_ref, { ...sub, account_country: 'US' });
    expect((await svc.syncSubscription(sub.subscription_ref, 'sign', AT))).toMatchObject({ outcome: 'APPLIED', detail: 'ACTIVE -> ACTIVE' });
    expect((await flags(t))[0].resolved_at).toEqual(AT);
  });

  // ── Domain-Enforcement P3 §4 — sending gate (ruling 5) ──────────────────────
  const DOMAIN_HELD = 'domain_verification_required: held for reconciliation';
  const COUNTRY_HELD = 'billing_country_not_supported: held for reconciliation';

  it('P3: checkout is refused while the domain claim is not AUTHORITATIVE, before any side effect', async () => {
    orgProfile.authoritative = false;
    expect(await reasonOf(checkout())).toBe('DOMAIN_VERIFICATION_REQUIRED:DOMAIN_VERIFICATION_REQUIRED');
    expect(orgProfile.domainChecks).toEqual([t]);
    expect(billing.checkouts).toHaveLength(0);
    expect(billing.accounts).toHaveLength(0);
    expect(orgProfile.locked).toEqual([]);
    expect((await pg.query('SELECT count(*)::int AS n FROM subscription."CheckoutIntent" WHERE tenant_id = $1', [t])).rows[0].n).toBe(0);
    expect((await pg.query('SELECT count(*)::int AS n FROM subscription."TenantBillingAccount" WHERE tenant_id = $1', [t])).rows[0].n).toBe(0);
    // The A1 profile check comes first.
    orgProfile.refused = 'organization_profile_incomplete';
    expect(await reasonOf(checkout())).toBe('ORGANIZATION_PROFILE_REQUIRED:organization_profile_incomplete');
    // Authoritative → checkout proceeds.
    orgProfile.refused = null;
    orgProfile.authoritative = true;
    expect(await reasonOf(checkout())).toBe('OK');
  });

  it('P3: a failing domain lookup fails closed at checkout', async () => {
    orgProfile.domainAuthoritative = async () => {
      throw new Error('identity unavailable');
    };
    expect(await reasonOf(checkout())).toBe('DOMAIN_VERIFICATION_REQUIRED:DOMAIN_VERIFICATION_REQUIRED');
    expect(billing.checkouts).toHaveLength(0);
  });

  it('P3 guard: a new subscription is not opened while not AUTHORITATIVE; IGNORED evidence; one flag across repeated syncs', async () => {
    await checkout();
    orgProfile.authoritative = false;
    const sub = billing.complete('active');
    const res = await svc.handleEvent(event('evt_d1', sub.subscription_ref), 'sign', AT);
    expect(res).toEqual({ outcome: 'IGNORED', detail: DOMAIN_HELD, tenant_id: t });
    expect('activated_owner_user_id' in res).toBe(false);
    await svc.handleEvent(event('evt_d2', sub.subscription_ref), 'sign', AT);
    await svc.syncSubscription(sub.subscription_ref, 'sign', AT);
    expect(await subRows(t)).toEqual([]);
    expect((await svc.account(t, 'sign', KEY, AT)).allowance.subscribed).toBe(false);
    const ev = await pg.query('SELECT outcome, detail FROM subscription."BillingEvent" WHERE tenant_id = $1 ORDER BY received_at', [t]);
    expect(ev.rows).toEqual([
      { outcome: 'IGNORED', detail: DOMAIN_HELD },
      { outcome: 'IGNORED', detail: DOMAIN_HELD },
    ]);
    const f = await flags(t);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ subscription_ref: sub.subscription_ref, reason: 'domain_not_authoritative', account_country: 'US', intent_id: billing.checkouts[0]?.intent_id, resolved_at: null });
  });

  it('P3 guard: a later sync once AUTHORITATIVE opens the subscription, activates the owner and resolves the flag', async () => {
    await checkout();
    orgProfile.authoritative = false;
    const sub = billing.complete('active');
    await svc.syncSubscription(sub.subscription_ref, 'sign', AT);
    orgProfile.authoritative = true;
    const res = await svc.syncSubscription(sub.subscription_ref, 'sign', AT);
    expect(res).toMatchObject({ outcome: 'APPLIED', activated_owner_user_id: 'owner-1' });
    expect(await subRows(t)).toMatchObject([{ status: 'ACTIVE', ended_at: null }]);
    const f = await flags(t);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ reason: 'domain_not_authoritative', resolved_at: AT });
  });

  it('P3 guard: an unbound profile port fails closed at activation', async () => {
    await checkout();
    const sub = billing.complete('active');
    const unbound = new SubscriptionLifecycleService(prisma, allowance, billing, new CapacityService(prisma));
    expect(await unbound.syncSubscription(sub.subscription_ref, 'sign', AT)).toEqual({ outcome: 'IGNORED', detail: DOMAIN_HELD, tenant_id: t });
    expect(await subRows(t)).toEqual([]);
  });

  it('P3 guard: an existing subscription is never (re)activated while not AUTHORITATIVE; cancellation still applies', async () => {
    await checkout();
    const sub = billing.complete('incomplete');
    await svc.syncSubscription(sub.subscription_ref, 'sign', AT);
    expect(await subRows(t)).toMatchObject([{ status: 'INCOMPLETE' }]);
    orgProfile.authoritative = false;
    billing.subs.set(sub.subscription_ref, { ...sub, provider_status: 'active' });
    const held = await svc.syncSubscription(sub.subscription_ref, 'sign', AT);
    expect(held).toMatchObject({ outcome: 'IGNORED', detail: `${DOMAIN_HELD} (INCOMPLETE -> INCOMPLETE, ACTIVE withheld)` });
    expect('activated_owner_user_id' in held).toBe(false);
    expect(await subRows(t)).toMatchObject([{ status: 'INCOMPLETE', ended_at: null }]);
    await svc.syncSubscription(sub.subscription_ref, 'sign', AT);
    expect(await flags(t)).toMatchObject([{ reason: 'domain_not_authoritative', resolved_at: null }]);
    billing.subs.set(sub.subscription_ref, { ...sub, provider_status: 'canceled' });
    await svc.syncSubscription(sub.subscription_ref, 'sign', AT);
    expect(await subRows(t)).toMatchObject([{ status: 'CANCELED', ended_at: AT }]);
  });

  it('P3 + A1 guards together: both flags raised; each resolves on its own; activation only when both pass', async () => {
    await checkout();
    orgProfile.authoritative = false;
    const sub = billing.complete('active', { account_country: 'CA' });
    expect(await svc.syncSubscription(sub.subscription_ref, 'sign', AT)).toEqual({ outcome: 'IGNORED', detail: `${COUNTRY_HELD}; ${DOMAIN_HELD}`, tenant_id: t });
    const both = await flags(t);
    expect(both.map((f) => f.reason).sort()).toEqual(['billing_country_not_supported', 'domain_not_authoritative']);
    expect(both.every((f) => f.resolved_at === null)).toBe(true);
    // Country fixed, domain still not authoritative: still held, only the country flag resolves.
    const AT2 = new Date(AT.getTime() + 60_000);
    billing.subs.set(sub.subscription_ref, { ...sub, account_country: 'US' });
    expect(await svc.syncSubscription(sub.subscription_ref, 'sign', AT2)).toEqual({ outcome: 'IGNORED', detail: DOMAIN_HELD, tenant_id: t });
    expect(await subRows(t)).toEqual([]);
    const mid = Object.fromEntries((await flags(t)).map((f) => [f.reason, f.resolved_at]));
    expect(mid).toEqual({ billing_country_not_supported: AT2, domain_not_authoritative: null });
    // Domain now authoritative: opened, owner activated, the domain flag resolves.
    const AT3 = new Date(AT.getTime() + 120_000);
    orgProfile.authoritative = true;
    expect(await svc.syncSubscription(sub.subscription_ref, 'sign', AT3)).toMatchObject({ outcome: 'APPLIED', activated_owner_user_id: 'owner-1' });
    const end = Object.fromEntries((await flags(t)).map((f) => [f.reason, f.resolved_at]));
    expect(end).toEqual({ billing_country_not_supported: AT2, domain_not_authoritative: AT3 });
    expect(await subRows(t)).toMatchObject([{ status: 'ACTIVE', ended_at: null }]);
  });

  it('P3 migration: the flag reason CHECK admits only the two guard reasons', async () => {
    const insert = (reason: string) =>
      pg.query(
        `INSERT INTO subscription."BillingReconciliationFlag" (id, tenant_id, provider, subscription_ref, reason) VALUES (gen_random_uuid(), $1, 'STRIPE', $2, $3)`,
        [t, `sub_chk_${reason}_${t}`, reason],
      );
    await insert('domain_not_authoritative');
    await insert('billing_country_not_supported');
    await expect(insert('something_else')).rejects.toThrow(/BillingReconciliationFlag_reason_check/);
  });
});
