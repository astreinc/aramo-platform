import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AllowanceService } from '../lib/allowance.service.js';
import type { BillingProviderPort } from '../lib/billing/billing-provider.port.js';
import { SubscriptionLifecycleService } from '../lib/billing/subscription-lifecycle.service.js';
import { CapacityService } from '../lib/capacity.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// A1 review — ordered migration replay of the UPGRADE path: a database that
// applied the ORIGINAL 20261019100000 (which seeded the superseded
// aramo-sign-business-v1, 100/month, sellable) and has a subscription on it.
// After A1: the migration succeeds, the legacy plan is non-sellable, inactive
// and out of the public catalog, the public catalog is exactly the four approved
// plans, and the existing subscription and its 100/month allowance are kept.

const ORIGINAL_M2 = resolve(__dirname, 'fixtures/20261019100000_subscription_lifecycle_billing.c7aab66b.sql');
const MIGRATIONS = [
  '../../../metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
  '../../prisma/migrations/20261018120000_init_subscription_allowance/migration.sql',
].map((p) => resolve(__dirname, p));
const A1 = resolve(__dirname, '../../prisma/migrations/20261019140000_sign_commercial_catalog_a1/migration.sql');
// Sign naming unification — the A1 keys esign.* are renamed sign.* by this later migration.
const SIGN_NAMING = resolve(__dirname, '../../prisma/migrations/20261020130300_sign_naming_keys/migration.sql');
const CURRENT_M2 = resolve(__dirname, '../../prisma/migrations/20261019100000_subscription_lifecycle_billing/migration.sql');
const TENANT = '0190dddd-0000-7000-8000-000000000001';
const SUB = '0190dddd-0000-7000-8000-0000000000aa';
const FOUR = ['aramo-sign-free-personal-v1', 'aramo-sign-standard-business-v1', 'aramo-sign-standard-professional-v1', 'aramo-sign-enterprise-v1'];

const billing: BillingProviderPort = {
  provider: 'STRIPE',
  isConfigured: () => true,
  mode: () => 'test',
  createCheckoutSession: async () => ({ session_ref: 'cs', url: 'https://x' }),
  createPortalSession: async () => ({ url: 'https://x' }),
  retrieveSubscription: async () => {
    throw new Error('unused');
  },
  verifyWebhook: () => {
    throw new Error('unused');
  },
};

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('subscription — A1 upgrade over the original single-plan seed (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    pg = new Client({ connectionString: container.getConnectionUri() });
    await pg.connect();
    for (const m of MIGRATIONS) await pg.query(readFileSync(m, 'utf8'));
    await pg.query(readFileSync(ORIGINAL_M2, 'utf8'));
    // A tenant already on the superseded plan.
    await pg.query(
      `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, period_anchor, source, created_by) VALUES ($1, $2, '019a0000-5150-7000-8000-000000000002', '2026-10-01T00:00:00Z', 'MANUAL', 'op')`,
      [SUB, TENANT],
    );
    await pg.query(readFileSync(A1, 'utf8'));
    await pg.query(readFileSync(SIGN_NAMING, 'utf8'));
    prisma = new PrismaService(container.getConnectionUri());
    await prisma.$connect();
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  it('the original seed really had the legacy plan as sellable (the fixture is the old revision)', () => {
    expect(readFileSync(ORIGINAL_M2, 'utf8')).toContain("'aramo-sign-business-v1', 'Aramo Sign Business', true");
    expect(readFileSync(CURRENT_M2, 'utf8')).not.toContain('aramo-sign-business-v1');
  });

  it('A1 retires the legacy plan: non-sellable, inactive, operator, out of the catalog', async () => {
    const r = await pg.query(`SELECT sellable, status, sales_model, display_order FROM subscription."Plan" WHERE key = 'aramo-sign-business-v1'`);
    expect(r.rows).toEqual([{ sellable: false, status: 'INACTIVE', sales_model: 'OPERATOR', display_order: 900 }]);
    const sellable = await pg.query(`SELECT key FROM subscription."Plan" WHERE sellable ORDER BY key`);
    expect(sellable.rows.map((x) => x.key)).toEqual(['aramo-sign-standard-business-v1', 'aramo-sign-standard-professional-v1']);
  });

  it('the public catalog is exactly the four approved plans', async () => {
    const svc = new SubscriptionLifecycleService(prisma, new AllowanceService(prisma), billing, new CapacityService(prisma));
    expect((await svc.catalog()).map((p) => p.key)).toEqual(FOUR);
  });

  it('the existing subscription and its 100/month allowance are preserved', async () => {
    const sub = await pg.query(`SELECT plan_id, ended_at, status FROM subscription."TenantSubscription" WHERE id = $1`, [SUB]);
    expect(sub.rows).toEqual([{ plan_id: '019a0000-5150-7000-8000-000000000002', ended_at: null, status: 'ACTIVE' }]);
    expect(await new AllowanceService(prisma).getStatus(TENANT, 'sign.envelopes', new Date('2026-10-19T00:00:00Z'))).toMatchObject({ subscribed: true, plan_key: 'aramo-sign-business-v1', limit: 100, unlimited: false });
  });
});
