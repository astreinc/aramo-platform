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
import { RenewalNoticeRepository, RenewalNoticeService, type RenewalNoticeMailer } from '../lib/billing/renewal-notice.js';
import { SubscriptionLifecycleService } from '../lib/billing/subscription-lifecycle.service.js';
import { AramoSignStandardBusinessPlanKey } from '../lib/development-subscription.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { FakeOrganizationBillingProfile } from './fixtures/organization-billing-profile.fake.js';
import { applyRemainingSubscriptionMigrations } from './fixtures/ccp-a8.js';

// Remaining-Work Consolidated Directive (32e5e3e1) A3 — the Aramo renewal notice on real Postgres 17
// (migration 20261102100000_sign_renewal_notice): only an open self-service subscription that is not
// set to cancel and whose commitment ends within the lead time is due; one notice per subscription
// and commitment end (a re-run sends nothing); a refused send is retried; the delivery row is
// evidence (no DELETE, no change out of SENT).

const BASE = [
  '../../../metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
  '../../prisma/migrations/20261018120000_init_subscription_allowance/migration.sql',
].map((p) => resolve(__dirname, p));

const STANDARD = 'aramo-sign-standard-personal-v1';
const AT = new Date('2026-11-02T12:00:00.000Z');
const DAY = 86_400_000;
let seq = 0;
const tenant = () => `0190dddd-0000-7000-8000-${String(++seq).padStart(12, '0')}`;

class FakeBilling implements BillingProviderPort {
  readonly provider = 'STRIPE' as const;
  mode(): 'test' | 'live' {
    return 'test';
  }
  subs = new Map<string, ProviderSubscriptionState>();
  checkouts: CheckoutSessionRequest[] = [];
  isConfigured() {
    return true;
  }
  async upsertBillingAccount(account_ref: string | null, details: { tenant_id: string }) {
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
  complete(): ProviderSubscriptionState {
    const c = this.checkouts[this.checkouts.length - 1]!;
    const s: ProviderSubscriptionState = {
      provider: 'STRIPE',
      subscription_ref: `sub_${c.intent_id}`,
      account_ref: c.account_ref ?? `cus_${c.tenant_id}`,
      provider_status: 'active',
      current_period_start: new Date('2026-11-02T00:00:00Z'),
      current_period_end: new Date('2026-12-02T00:00:00Z'),
      cancel_at_period_end: false,
      price_ref: 'price_personal',
      tenant_id: c.tenant_id,
      intent_id: c.intent_id,
      account_country: 'US',
    };
    this.subs.set(s.subscription_ref, s);
    return s;
  }
}

class FakeMailer implements RenewalNoticeMailer {
  sent: { to: string; subject: string; text?: string }[] = [];
  fail = 0;
  async send(args: { to: string; subject: string; html: string; text?: string }) {
    if (this.fail > 0) {
      this.fail--;
      throw Object.assign(new Error('throttled'), { name: 'Throttling' });
    }
    this.sent.push(args);
    return { message_id: `msg-${this.sent.length}` };
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('subscription — Sign renewal notice (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let billing: FakeBilling;
  let svc: SubscriptionLifecycleService;
  let repo: RenewalNoticeRepository;
  let mailer: FakeMailer;
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
    mailer = new FakeMailer();
    repo = new RenewalNoticeRepository(prisma);
    const orgProfile = new FakeOrganizationBillingProfile();
    orgProfile.refused = 'organization_profile_incomplete';
    orgProfile.authoritative = false;
    svc = new SubscriptionLifecycleService(prisma, new AllowanceService(prisma), billing, new CapacityService(prisma), undefined, undefined, orgProfile);
  });

  /** A paid Personal Standard subscription (12-month commitment); returns its id and commitment end. */
  async function subscribe(): Promise<{ id: string; commitment_end: Date }> {
    await svc.startCheckout({ product_key: 'sign', tenant_id: t, user_id: 'owner-p', user_email: 'p@example.test', plan_key: STANDARD, success_url: 'https://e/ok', cancel_url: 'https://e/no', accept_terms: true, tenant_kind: 'PERSONAL' });
    const sub = billing.complete();
    await svc.handleEvent({ id: `evt_${t}`, type: 'subscription.updated', created: AT, subscription_ref: sub.subscription_ref }, 'sign', AT);
    const r = await pg.query(`SELECT id, commitment_end FROM subscription."TenantSubscription" WHERE tenant_id = $1 AND source = 'SELF_SERVICE' AND ended_at IS NULL`, [t]);
    expect(r.rows).toHaveLength(1);
    return { id: r.rows[0].id as string, commitment_end: r.rows[0].commitment_end as Date };
  }

  const run = (now: Date, recipient: string | null = 'p@example.test') =>
    new RenewalNoticeService({
      store: repo,
      recipients: { recipientFor: async () => (recipient === null ? null : { email: recipient }) },
      mailer,
      provider: 'stub',
      settings_base_url: 'https://sign.example.test',
      lead_days: 30,
      now: () => now,
    }).run();
  const rows = async (id: string) =>
    (await pg.query(`SELECT status, attempt_count, notice_kind, lead_days, provider, provider_message_id, error_code FROM subscription."RenewalNoticeDelivery" WHERE subscription_id = $1`, [id])).rows;

  it('not due before the lead time; due inside it: one email, recorded SENT; a re-run sends nothing', async () => {
    const s = await subscribe();
    expect(s.commitment_end).not.toBeNull();
    const early = await run(new Date(s.commitment_end.getTime() - 31 * DAY));
    expect(early.due).toBe(0);
    const r = await run(new Date(s.commitment_end.getTime() - 10 * DAY));
    expect(r).toMatchObject({ sent: 1, failed: 0, suppressed: 0 });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe('p@example.test');
    expect(mailer.sent[0]!.text).toContain('continues month to month at $10.00 per month');
    expect(mailer.sent[0]!.text).toContain('https://sign.example.test/personal/settings/billing');
    expect(mailer.sent[0]!.text).toContain('returns to the Free plan');
    expect(await rows(s.id)).toEqual([{ status: 'SENT', attempt_count: 1, notice_kind: 'COMMITMENT_END', lead_days: 30, provider: 'stub', provider_message_id: 'msg-1', error_code: null }]);
    const again = await run(new Date(s.commitment_end.getTime() - 9 * DAY));
    expect(again).toMatchObject({ sent: 0, already_done: 1 });
    expect(mailer.sent).toHaveLength(1);
    // After the commitment end it is no longer due.
    expect((await run(new Date(s.commitment_end.getTime() + DAY))).due).toBe(0);
  });

  it('a subscription set to cancel is not due', async () => {
    const s = await subscribe();
    await pg.query(`UPDATE subscription."TenantSubscription" SET cancel_at_period_end = true WHERE id = $1`, [s.id]);
    expect((await run(new Date(s.commitment_end.getTime() - 5 * DAY))).due).toBe(0);
    expect(await rows(s.id)).toEqual([]);
  });

  it('a refused send is recorded FAILED and retried on the next run; no recipient is SUPPRESSED', async () => {
    const s = await subscribe();
    mailer.fail = 1;
    expect(await run(new Date(s.commitment_end.getTime() - 10 * DAY))).toMatchObject({ failed: 1, sent: 0 });
    expect(await rows(s.id)).toMatchObject([{ status: 'FAILED', attempt_count: 1, error_code: 'Throttling' }]);
    expect(await run(new Date(s.commitment_end.getTime() - 9 * DAY))).toMatchObject({ sent: 1 });
    expect(await rows(s.id)).toMatchObject([{ status: 'SENT', attempt_count: 2, error_code: null }]);

    t = tenant();
    const other = await subscribe();
    expect(await run(new Date(other.commitment_end.getTime() - 10 * DAY), null)).toMatchObject({ suppressed: 1 });
    expect(await rows(other.id)).toMatchObject([{ status: 'SUPPRESSED', error_code: 'no_recipient' }]);
  });

  it('the delivery row is evidence: DELETE and any change out of SENT are refused', async () => {
    const s = await subscribe();
    await run(new Date(s.commitment_end.getTime() - 10 * DAY));
    await expect(pg.query(`DELETE FROM subscription."RenewalNoticeDelivery" WHERE subscription_id = $1`, [s.id])).rejects.toThrow(/cannot be deleted/);
    await expect(pg.query(`UPDATE subscription."RenewalNoticeDelivery" SET status = 'FAILED' WHERE subscription_id = $1`, [s.id])).rejects.toThrow(/terminal/);
    await expect(pg.query(`UPDATE subscription."RenewalNoticeDelivery" SET term_end = term_end + interval '1 day' WHERE subscription_id = $1`, [s.id])).rejects.toThrow(/immutable/);
    await expect(
      pg.query(
        `INSERT INTO subscription."RenewalNoticeDelivery" (id, subscription_id, tenant_id, product_key, notice_kind, term_end, lead_days, template_id, template_version, template_sha256, status)
         SELECT gen_random_uuid(), subscription_id, tenant_id, product_key, 'TERM_END', term_end, 30, 't', '1', 'x', 'PENDING' FROM subscription."RenewalNoticeDelivery" WHERE subscription_id = $1`,
        [s.id],
      ),
    ).rejects.toThrow(/notice_kind_check/);
  });
});
