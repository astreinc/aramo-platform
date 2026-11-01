import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AllowanceService } from '../lib/allowance.service.js';
import { CapacityService } from '../lib/capacity.service.js';
import type { BillingProviderPort, CheckoutSessionRequest, ProviderSubscriptionState } from '../lib/billing/billing-provider.port.js';
import { BillingProviderUnavailableError } from '../lib/billing/billing-provider.port.js';
import { BillingRefusedError, SubscriptionLifecycleService } from '../lib/billing/subscription-lifecycle.service.js';
import { AramoSignStandardBusinessPlanKey } from '../lib/development-subscription.js';
import { FreePersonalPlanKey, FreePersonalSubscriptionService } from '../lib/free-personal-subscription.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { FakeOrganizationBillingProfile } from './fixtures/organization-billing-profile.fake.js';
import { applyRemainingSubscriptionMigrations } from './fixtures/ccp-a8.js';
import { LEGAL_DOCUMENTS_BEFORE_TOS_V20 } from './support/legal-registry.js';

// Sign Catalog v2 §4.3 (P-4) — the Personal paid checkout on real Postgres 17: Personal-only
// eligibility (both directions), Free → Standard in place (the FREE row ends on the provider's
// confirmation), the plan-driven allowance (25 a month, no daily cap) against Free (5 a month,
// 2 a day), the US activation guard without a domain hold, and the return to Free after the
// paid subscription ends.

const BASE = [
  '../../../metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
  '../../prisma/migrations/20261018120000_init_subscription_allowance/migration.sql',
].map((p) => resolve(__dirname, p));

const KEY = 'sign.envelopes';
const STANDARD = 'aramo-sign-standard-personal-v1';
const AT = new Date('2026-11-02T12:00:00.000Z');
let seq = 0;
const tenant = () => `0190cccc-0000-7000-8000-${String(++seq).padStart(12, '0')}`;

class FakeBilling implements BillingProviderPort {
  readonly provider = 'STRIPE' as const;
  mode(): 'test' | 'live' {
    return 'test';
  }
  subs = new Map<string, ProviderSubscriptionState>();
  checkouts: CheckoutSessionRequest[] = [];
  accounts: unknown[] = [];
  isConfigured() {
    return true;
  }
  async upsertBillingAccount(account_ref: string | null, details: { tenant_id: string }) {
    this.accounts.push(details);
    return account_ref ?? `cus_${details.tenant_id}`;
  }
  async createCheckoutSession(req: CheckoutSessionRequest) {
    this.checkouts.push(req);
    return { session_ref: `cs_${req.intent_id}`, url: `https://checkout.test/${req.intent_id}` };
  }
  async createPortalSession(account_ref: string) {
    return { url: `https://portal.test/${account_ref}` };
  }
  async retrieveSubscription(ref: string) {
    const s = this.subs.get(ref);
    if (s === undefined) throw new BillingProviderUnavailableError('no such subscription');
    return s;
  }
  verifyWebhook(): never {
    throw new Error('not used');
  }
  complete(status: string, overrides: Partial<ProviderSubscriptionState> = {}): ProviderSubscriptionState {
    const c = this.checkouts[this.checkouts.length - 1]!;
    const s: ProviderSubscriptionState = {
      provider: 'STRIPE',
      subscription_ref: `sub_${c.intent_id}`,
      account_ref: c.account_ref ?? `cus_${c.tenant_id}`,
      provider_status: status,
      current_period_start: new Date('2026-11-02T00:00:00Z'),
      current_period_end: new Date('2026-12-02T00:00:00Z'),
      cancel_at_period_end: false,
      price_ref: 'price_personal',
      tenant_id: c.tenant_id,
      intent_id: c.intent_id,
      account_country: 'US',
      ...overrides,
    };
    this.subs.set(s.subscription_ref, s);
    return s;
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('subscription — Sign Personal paid checkout (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let billing: FakeBilling;
  let svc: SubscriptionLifecycleService;
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
    process.env['STRIPE_PLAN_PRICES'] = `${AramoSignStandardBusinessPlanKey}=price_business,${STANDARD}=price_personal`;
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
    billing = new FakeBilling();
    orgProfile = new FakeOrganizationBillingProfile();
    // A Personal tenant has no organization profile or domain claim: both would refuse or hold.
    orgProfile.refused = 'organization_profile_incomplete';
    orgProfile.authoritative = false;
    svc = new SubscriptionLifecycleService(prisma, new AllowanceService(prisma), billing, new CapacityService(prisma), undefined, LEGAL_DOCUMENTS_BEFORE_TOS_V20, orgProfile);
    free = new FreePersonalSubscriptionService(prisma);
  });

  const openFree = () => free.ensure({ tenant_id: t, product_key: 'sign', tenant_kind: 'PERSONAL', tenant_status: 'ACTIVE', mode: 'open', at: AT });
  const checkout = (plan_key = STANDARD, tenant_kind = 'PERSONAL', accept_terms = true) =>
    svc.startCheckout({ product_key: 'sign', tenant_id: t, user_id: 'owner-p', user_email: 'p@example.test', plan_key, success_url: 'https://e/ok', cancel_url: 'https://e/no', accept_terms, tenant_kind });
  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e instanceof BillingRefusedError ? e.reason : String(e);
    }
    return 'NOT_REFUSED';
  };
  const event = (id: string, ref: string) => ({ id, type: 'subscription.updated', created: AT, subscription_ref: ref });

  it('the catalog for a PERSONAL tenant: only Standard is purchasable', async () => {
    const plans = await svc.catalog('sign', t, 'PERSONAL');
    expect(plans.filter((p) => p.purchasable).map((p) => p.key)).toEqual([STANDARD]);
    expect(plans.find((p) => p.key === STANDARD)).toMatchObject({ tenant_kind: 'PERSONAL', price: { amount_minor: 1000, currency: 'USD' }, commitment_months: 12 });
    const business = await svc.catalog('sign', t, 'BUSINESS');
    expect(business.find((p) => p.key === STANDARD)!.purchasable).toBe(false);
    expect(business.find((p) => p.key === AramoSignStandardBusinessPlanKey)!.purchasable).toBe(true);
  });

  it('refuses a Business plan to a PERSONAL tenant and the Personal plan to a BUSINESS tenant', async () => {
    expect(await refusal(checkout(AramoSignStandardBusinessPlanKey, 'PERSONAL'))).toBe('PLAN_TENANT_KIND_MISMATCH');
    expect(await refusal(checkout(STANDARD, 'BUSINESS'))).toBe('PLAN_TENANT_KIND_MISMATCH');
    expect(billing.checkouts).toHaveLength(0);
  });

  it('requires the Personal Terms to be accepted, and records the accepted version', async () => {
    expect(await refusal(checkout(STANDARD, 'PERSONAL', false))).toBe('TERMS_NOT_ACCEPTED');
    await checkout();
    const r = await pg.query('SELECT document_key, version, context FROM subscription."LegalAcceptance" WHERE tenant_id = $1', [t]);
    expect(r.rows).toEqual([{ document_key: 'sign.personal_terms_of_service', version: '1.0', context: 'CHECKOUT' }]);
  });

  it('a Personal checkout needs no organization profile: the address is collected, the renewal terms disclosed', async () => {
    await openFree();
    expect((await checkout()).url).toMatch(/^https:\/\/checkout\.test\//);
    expect(billing.accounts).toHaveLength(0);
    expect(orgProfile.locked).toEqual([]);
    const req = billing.checkouts[0]!;
    expect(req).toMatchObject({ account_ref: null, collect_address: true, price_ref: 'price_personal' });
    expect(req.disclosure).toContain('$10.00 per month');
    expect(req.disclosure).toContain('12-month commitment');
    expect(req.disclosure).toContain('returns to the Free plan');
  });

  it('Free → Standard in place: the FREE row ends on the provider confirmation; 25 a month, no daily cap', async () => {
    await openFree();
    const before = await svc.account(t, 'sign', KEY, AT);
    expect(before.subscription).toMatchObject({ plan_key: FreePersonalPlanKey, source: 'FREE' });
    expect(before.allowance).toMatchObject({ subscribed: true, limit: 5, daily: { window: 'DAY', limit: 2 } });

    await checkout();
    // Nothing changes before the provider confirms the payment.
    expect((await svc.account(t, 'sign', KEY, AT)).subscription).toMatchObject({ plan_key: FreePersonalPlanKey });
    const sub = billing.complete('active');
    // No domain hold for a Personal plan; the US country guard passes.
    expect(await svc.handleEvent(event('evt_p1', sub.subscription_ref), 'sign', AT)).toMatchObject({ outcome: 'APPLIED', tenant_id: t });

    const after = await svc.account(t, 'sign', KEY, AT);
    expect(after.subscription).toMatchObject({ plan_key: STANDARD, source: 'SELF_SERVICE', status: 'ACTIVE', commitment_months: 12 });
    expect(after.allowance).toMatchObject({ subscribed: true, limit: 25, unlimited: false });
    expect((after.allowance as { daily?: unknown }).daily).toBeUndefined();
    const rows = await pg.query('SELECT source, ended_at IS NULL AS open FROM subscription."TenantSubscription" WHERE tenant_id = $1 ORDER BY started_at', [t]);
    expect(rows.rows).toEqual([
      { source: 'FREE', open: false },
      { source: 'SELF_SERVICE', open: true },
    ]);
  });

  it('a non-US billing address is held (the activation guard still applies); Free stays', async () => {
    await openFree();
    await checkout();
    const sub = billing.complete('active', { account_country: 'IN' });
    const res = await svc.handleEvent(event('evt_p2', sub.subscription_ref), 'sign', AT);
    expect(res.outcome).toBe('IGNORED');
    expect((await svc.account(t, 'sign', KEY, AT)).subscription).toMatchObject({ plan_key: FreePersonalPlanKey, source: 'FREE' });
  });

  it('after the paid subscription ends, the account returns to Free (5 a month, 2 a day)', async () => {
    await openFree();
    await checkout();
    const sub = billing.complete('active');
    await svc.handleEvent(event('evt_p3', sub.subscription_ref), 'sign', AT);
    billing.subs.set(sub.subscription_ref, { ...sub, provider_status: 'canceled', cancel_at_period_end: true });
    await svc.handleEvent(event('evt_p4', sub.subscription_ref), 'sign', AT);
    expect((await openFree()).ok).toBe(true);
    const back = await svc.account(t, 'sign', KEY, AT);
    expect(back.subscription).toMatchObject({ plan_key: FreePersonalPlanKey, source: 'FREE' });
    expect(back.allowance).toMatchObject({ subscribed: true, limit: 5, daily: { limit: 2 } });
  });

  it('a second checkout while Standard is open is refused (managed in the portal)', async () => {
    await openFree();
    await checkout();
    const sub = billing.complete('active');
    await svc.handleEvent(event('evt_p5', sub.subscription_ref), 'sign', AT);
    expect(await refusal(checkout())).toBe('ALREADY_SUBSCRIBED');
  });
});
