import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AllowanceService } from '../lib/allowance.service.js';
import { CapacityService } from '../lib/capacity.service.js';
import type { BillingProviderPort, ProviderSubscriptionState, StoreBillingProviderKey } from '../lib/billing/billing-provider.port.js';
import { BillingWebhookInboxService } from '../lib/billing/billing-webhook-inbox.service.js';
import type { StoreSubscriptionReader } from '../lib/billing/store/store-billing.port.js';
import { BillingRefusedError, SubscriptionLifecycleService } from '../lib/billing/subscription-lifecycle.service.js';
import { AramoSignStandardBusinessPlanKey } from '../lib/development-subscription.js';
import { FreePersonalPlanKey, FreePersonalSubscriptionService } from '../lib/free-personal-subscription.js';
import { PlanVersionRepository, currentPublishedVersion } from '../lib/plan-version.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { FakeOrganizationBillingProfile } from './fixtures/organization-billing-profile.fake.js';
import { applyRemainingSubscriptionMigrations } from './fixtures/ccp-a8.js';
import { LEGAL_DOCUMENTS_BEFORE_TOS_V20 } from './support/legal-registry.js';

// Aramo Sign Mobile M-A12 §4 item 4 with Amendment A1-1 — the store subscription lifecycle on real
// Postgres 17, through the EXISTING status machine: the migration (widened provider CHECKs, pin
// interval, store references, the store-product trigger), the activation of a store purchase (no US
// country guard for a store, no provider billing account), monthly = no commitment and annual = the
// plan's 12 months, notifications re-fetched from the store (grace, renewal, expiry, refund) recorded
// in the inbox under the store, the Personal Free fallback, the Stripe ⇄ store refusal and the
// reconcile sweep re-fetching store rows. The store adapters are replaced by a fake reader (the store
// verification itself is covered by m-a12-store-apple.spec.ts and m-a12-store-google.spec.ts).

const BASE = [
  '../../../metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
  '../../prisma/migrations/20261018120000_init_subscription_allowance/migration.sql',
].map((p) => resolve(__dirname, p));

const KEY = 'sign.envelopes';
const STANDARD = 'aramo-sign-standard-personal-v1';
const AT = new Date('2026-11-04T12:00:00.000Z');
const DAY = 86_400_000;
const P_MONTHLY = 'ai.aramo.sign.standard.monthly';
const P_ANNUAL = 'ai.aramo.sign.standard.annual';
const B_MONTHLY = 'ai.aramo.sign.business.monthly';
let seq = 0;
const tenant = () => `0190a120-0000-7000-8000-${String(++seq).padStart(12, '0')}`;

class StripeUnused implements BillingProviderPort {
  readonly provider = 'STRIPE' as const;
  mode(): 'test' | 'live' {
    return 'test';
  }
  isConfigured() {
    return true;
  }
  async upsertBillingAccount(): Promise<string> {
    return 'cus_x';
  }
  async createCheckoutSession(): Promise<{ session_ref: string; url: string }> {
    throw new Error('a store tenant must never reach a Stripe checkout session');
  }
  async createPortalSession(): Promise<{ url: string }> {
    return { url: 'https://portal.test' };
  }
  async retrieveSubscription(): Promise<ProviderSubscriptionState> {
    throw new Error('a store subscription is never re-fetched from Stripe');
  }
  verifyWebhook(): never {
    throw new Error('not used');
  }
}

class FakeStores implements StoreSubscriptionReader {
  states = new Map<string, ProviderSubscriptionState>();
  reads: string[] = [];
  isConfigured(): boolean {
    return true;
  }
  async retrieve(_provider: StoreBillingProviderKey, ref: string): Promise<ProviderSubscriptionState> {
    this.reads.push(ref);
    const s = this.states.get(ref);
    if (s === undefined) throw new Error('unknown store subscription');
    return s;
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('subscription — Sign Mobile M-A12 store billing lifecycle (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let stores: FakeStores;
  let svc: SubscriptionLifecycleService;
  let inbox: BillingWebhookInboxService;
  let free: FreePersonalSubscriptionService;
  let orgProfile: FakeOrganizationBillingProfile;
  const env = { ...process.env };

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    pg = new Client({ connectionString: container.getConnectionUri() });
    await pg.connect();
    for (const m of BASE) await pg.query(readFileSync(m, 'utf8'));
    await applyRemainingSubscriptionMigrations(pg, BASE);
    prisma = new PrismaService(container.getConnectionUri());
    await prisma.$connect();
    const versions = new PlanVersionRepository(prisma);
    const personal = await prisma.plan.findUniqueOrThrow({ where: { key: STANDARD } });
    const business = await prisma.plan.findUniqueOrThrow({ where: { key: AramoSignStandardBusinessPlanKey } });
    const pv = (await currentPublishedVersion(prisma, personal.id))!.id;
    const bv = (await currentPublishedVersion(prisma, business.id))!.id;
    await versions.pinStoreProduct({ plan_version_id: pv, provider: 'APP_STORE', product_id: P_MONTHLY, interval: 'MONTH', created_by: 'test' });
    await versions.pinStoreProduct({ plan_version_id: pv, provider: 'APP_STORE', product_id: P_ANNUAL, interval: 'YEAR', created_by: 'test' });
    await versions.pinStoreProduct({ plan_version_id: bv, provider: 'GOOGLE_PLAY', product_id: B_MONTHLY, interval: 'MONTH', created_by: 'test' });
    delete process.env['STRIPE_PLAN_PRICES'];
  }, 240_000);

  afterAll(async () => {
    process.env = env;
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  let t: string;
  beforeEach(() => {
    t = tenant();
    stores = new FakeStores();
    orgProfile = new FakeOrganizationBillingProfile();
    svc = new SubscriptionLifecycleService(
      prisma,
      new AllowanceService(prisma),
      new StripeUnused(),
      new CapacityService(prisma),
      undefined,
      LEGAL_DOCUMENTS_BEFORE_TOS_V20,
      orgProfile,
      undefined,
      undefined,
      undefined,
      undefined,
      stores,
    );
    inbox = new BillingWebhookInboxService(prisma, new StripeUnused(), svc);
    free = new FreePersonalSubscriptionService(prisma);
  });

  const openFree = () => free.ensure({ tenant_id: t, product_key: 'sign', tenant_kind: 'PERSONAL', tenant_status: 'ACTIVE', mode: 'open', at: AT });

  /** A store purchase intent (what POST store/intent writes). */
  async function intent(product: string, plan_key = STANDARD, provider: StoreBillingProviderKey = 'APP_STORE'): Promise<string> {
    const plan = await prisma.plan.findUniqueOrThrow({ where: { key: plan_key } });
    const id = uuidv7();
    await prisma.checkoutIntent.create({ data: { id, tenant_id: t, user_id: 'owner-s', plan_id: plan.id, provider, store_product_id: product } });
    return id;
  }

  function state(ref: string, intent_id: string, product: string, over: Partial<ProviderSubscriptionState> = {}, provider: StoreBillingProviderKey = 'APP_STORE'): ProviderSubscriptionState {
    const s: ProviderSubscriptionState = {
      provider,
      subscription_ref: ref,
      account_ref: '',
      provider_status: 'active',
      current_period_start: new Date('2026-11-04T00:00:00Z'),
      current_period_end: new Date('2026-12-04T00:00:00Z'),
      cancel_at_period_end: false,
      price_ref: product,
      tenant_id: null,
      intent_id,
      account_country: null,
      store: { product_id: product, environment: 'Sandbox', grace_until: null },
      ...over,
    };
    stores.states.set(ref, s);
    return s;
  }

  const row = async (ref: string) =>
    (await pg.query('SELECT source, status, billing_provider, billing_account_ref, store_product_id, store_interval, store_environment, commitment_start, commitment_end, grace_until, ended_at FROM subscription."TenantSubscription" WHERE billing_subscription_ref = $1', [ref])).rows[0];

  it('migration: store pins carry an interval; a store product belongs to one plan and interval (trigger)', async () => {
    const pins = await pg.query(`SELECT provider, provider_price_ref, interval FROM subscription."PlanVersionPrice" WHERE provider <> 'STRIPE' ORDER BY provider_price_ref`);
    expect(pins.rows).toEqual([
      { provider: 'GOOGLE_PLAY', provider_price_ref: B_MONTHLY, interval: 'MONTH' },
      { provider: 'APP_STORE', provider_price_ref: P_ANNUAL, interval: 'YEAR' },
      { provider: 'APP_STORE', provider_price_ref: P_MONTHLY, interval: 'MONTH' },
    ]);
    const business = await prisma.plan.findUniqueOrThrow({ where: { key: AramoSignStandardBusinessPlanKey } });
    const bv = (await currentPublishedVersion(prisma, business.id))!.id;
    await expect(
      pg.query(`INSERT INTO subscription."PlanVersionPrice" (id, plan_version_id, provider, provider_price_ref, interval, created_by, created_at) VALUES (gen_random_uuid(), $1::uuid, 'APP_STORE', $2, 'MONTH', 'x', now())`, [bv, P_MONTHLY]),
    ).rejects.toThrow(/belongs to one plan and one interval/);
    await expect(
      pg.query(`INSERT INTO subscription."PlanVersionPrice" (id, plan_version_id, provider, provider_price_ref, interval, created_by, created_at) VALUES (gen_random_uuid(), $1::uuid, 'PAYPAL', 'p', 'MONTH', 'x', now())`, [bv]),
    ).rejects.toThrow(/PlanVersionPrice_provider_check/);
  });

  it('Personal monthly (A1-1): opens SELF_SERVICE on the App Store with no commitment, no billing account, no US guard; Free ends', async () => {
    await openFree();
    const i = await intent(P_MONTHLY);
    const r = await svc.applyProviderState(state('2000000101', i, P_MONTHLY), 'sign', AT);
    expect(r).toMatchObject({ outcome: 'APPLIED', tenant_id: t, activated_owner_user_id: 'owner-s' });
    expect(await row('2000000101')).toMatchObject({ source: 'SELF_SERVICE', status: 'ACTIVE', billing_provider: 'APP_STORE', billing_account_ref: null, store_product_id: P_MONTHLY, store_interval: 'MONTH', store_environment: 'Sandbox', commitment_start: null, commitment_end: null, ended_at: null });
    const view = await svc.account(t, 'sign', KEY, AT);
    expect(view.subscription).toMatchObject({ plan_key: STANDARD, source: 'SELF_SERVICE', status: 'ACTIVE', commitment_months: null, billing_managed: true });
    const rows = await pg.query('SELECT source, ended_at IS NULL AS open FROM subscription."TenantSubscription" WHERE tenant_id = $1 ORDER BY started_at', [t]);
    expect(rows.rows).toEqual([
      { source: 'FREE', open: false },
      { source: 'SELF_SERVICE', open: true },
    ]);
  });

  it('Personal annual (A1-1): the plan’s 12-month commitment from the period start', async () => {
    const i = await intent(P_ANNUAL);
    await svc.applyProviderState(state('2000000102', i, P_ANNUAL, { current_period_end: new Date('2027-11-04T00:00:00Z') }), 'sign', AT);
    const r = await row('2000000102');
    expect(r).toMatchObject({ store_interval: 'YEAR' });
    expect(r.commitment_start.toISOString()).toBe('2026-11-04T00:00:00.000Z');
    expect(r.commitment_end.toISOString()).toBe('2027-11-04T00:00:00.000Z');
    expect((await svc.account(t, 'sign', KEY, AT)).subscription?.commitment_months).toBe(12);
  });

  it('a monthly store row can never carry a commitment (CHECK)', async () => {
    const i = await intent(P_MONTHLY);
    await svc.applyProviderState(state('2000000103', i, P_MONTHLY), 'sign', AT);
    await expect(pg.query(`UPDATE subscription."TenantSubscription" SET commitment_start = now(), commitment_end = now() + interval '1 year' WHERE billing_subscription_ref = '2000000103'`)).rejects.toThrow(/store_monthly_no_commitment/);
  });

  it('notifications: recorded in the inbox under the store, re-fetched from the store (grace → PAST_DUE with the store grace end), at most once', async () => {
    const i = await intent(P_MONTHLY);
    await svc.applyProviderState(state('2000000104', i, P_MONTHLY), 'sign', AT);
    const grace = new Date(AT.getTime() + 6 * DAY);
    // The payload says nothing about the state; the re-fetched state is in grace.
    state('2000000104', i, P_MONTHLY, { provider_status: 'past_due', store: { product_id: P_MONTHLY, environment: 'Sandbox', grace_until: grace } });
    const evt = { provider: 'APP_STORE' as const, id: 'apple-n-104', type: 'DID_FAIL_TO_RENEW.GRACE_PERIOD', created: AT, subscription_ref: '2000000104' };
    expect(await inbox.receive(evt, 'sign', AT)).toMatchObject({ outcome: 'APPLIED', tenant_id: t });
    expect(stores.reads).toContain('2000000104');
    const r = await row('2000000104');
    expect(r).toMatchObject({ status: 'PAST_DUE', ended_at: null });
    expect(r.grace_until.toISOString()).toBe(grace.toISOString());
    const recorded = await pg.query(`SELECT provider, status, outcome FROM subscription."BillingWebhookInbox" WHERE provider_event_id = 'apple-n-104'`);
    expect(recorded.rows).toEqual([{ provider: 'APP_STORE', status: 'PROCESSED', outcome: 'APPLIED' }]);
    expect((await pg.query(`SELECT provider FROM subscription."BillingEvent" WHERE provider_event_id = 'apple-n-104'`)).rows).toEqual([{ provider: 'APP_STORE' }]);
    expect(await inbox.receive(evt, 'sign', AT)).toEqual({ outcome: 'DUPLICATE', tenant_id: null });
  });

  it('expiry → CANCELED and ended; a Personal tenant falls back to the Free plan', async () => {
    await openFree();
    const i = await intent(P_MONTHLY);
    await svc.applyProviderState(state('2000000105', i, P_MONTHLY), 'sign', AT);
    state('2000000105', i, P_MONTHLY, { provider_status: 'canceled' });
    expect(await svc.handleEvent({ provider: 'APP_STORE', id: 'apple-n-105', type: 'EXPIRED.VOLUNTARY', created: AT, subscription_ref: '2000000105' }, 'sign', AT)).toMatchObject({ outcome: 'APPLIED' });
    expect(await row('2000000105')).toMatchObject({ status: 'CANCELED' });
    expect((await row('2000000105')).ended_at).not.toBeNull();
    expect(await openFree()).toMatchObject({ ok: true, opened: true });
    expect((await svc.account(t, 'sign', KEY, AT)).subscription).toMatchObject({ plan_key: FreePersonalPlanKey, source: 'FREE' });
  });

  it('refund / revoke → ended immediately', async () => {
    const i = await intent(P_ANNUAL);
    await svc.applyProviderState(state('2000000106', i, P_ANNUAL), 'sign', AT);
    state('2000000106', i, P_ANNUAL, { provider_status: 'canceled' });
    const revokedAt = new Date(AT.getTime() + DAY);
    await svc.handleEvent({ provider: 'APP_STORE', id: 'apple-n-106', type: 'REFUND', created: revokedAt, subscription_ref: '2000000106' }, 'sign', revokedAt);
    expect((await row('2000000106')).ended_at.toISOString()).toBe(revokedAt.toISOString());
  });

  it('Stripe coexistence: an open store subscription refuses a Stripe checkout (billing_managed_elsewhere)', async () => {
    const i = await intent(P_MONTHLY);
    await svc.applyProviderState(state('2000000107', i, P_MONTHLY), 'sign', AT);
    process.env['STRIPE_PLAN_PRICES'] = `${STANDARD}=price_personal`;
    try {
      await svc.startCheckout({ product_key: 'sign', tenant_id: t, user_id: 'owner-s', user_email: 's@example.test', plan_key: STANDARD, success_url: 'https://e/ok', cancel_url: 'https://e/no', accept_terms: true, tenant_kind: 'PERSONAL' });
      throw new Error('NOT_REFUSED');
    } catch (e) {
      expect(e instanceof BillingRefusedError ? e.reason : String(e)).toBe('BILLING_MANAGED_ELSEWHERE');
    } finally {
      delete process.env['STRIPE_PLAN_PRICES'];
    }
  });

  it('Business on Google Play: the domain guard holds an unverified organization; a verified one activates', async () => {
    const i = await intent(B_MONTHLY, AramoSignStandardBusinessPlanKey, 'GOOGLE_PLAY');
    orgProfile.authoritative = false;
    expect(await svc.applyProviderState(state('play-tok-108', i, B_MONTHLY, {}, 'GOOGLE_PLAY'), 'sign', AT)).toMatchObject({ outcome: 'IGNORED' });
    orgProfile.authoritative = true;
    expect(await svc.applyProviderState(state('play-tok-108', i, B_MONTHLY, {}, 'GOOGLE_PLAY'), 'sign', AT)).toMatchObject({ outcome: 'APPLIED' });
    expect(await row('play-tok-108')).toMatchObject({ billing_provider: 'GOOGLE_PLAY', store_interval: 'MONTH', commitment_end: null });
  });

  it('reconcile re-fetches open store rows from the store (missed notifications heal)', async () => {
    const i = await intent(P_MONTHLY);
    await svc.applyProviderState(state('2000000109', i, P_MONTHLY), 'sign', AT);
    state('2000000109', i, P_MONTHLY, { cancel_at_period_end: true });
    stores.reads = [];
    await svc.reconcile('sign', AT, 500);
    expect(stores.reads).toContain('2000000109');
    expect((await pg.query(`SELECT cancel_at_period_end FROM subscription."TenantSubscription" WHERE billing_subscription_ref = '2000000109'`)).rows[0]).toEqual({ cancel_at_period_end: true });
  });
});
