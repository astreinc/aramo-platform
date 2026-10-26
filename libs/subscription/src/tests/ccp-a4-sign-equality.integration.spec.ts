import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
import { SIGN_PRODUCT_KEY } from '../lib/product-registry.js';

import { CCP_A5_MIGRATION } from './fixtures/ccp-a5.js';
import { applyRemainingSubscriptionMigrations } from './fixtures/ccp-a8.js';
import { observe, rowCounts, seedCorpus, type SignOps } from './fixtures/ccp-a4-sign-corpus.js';
import { withoutDisabledTax } from './fixtures/ccp-c5.js';

// CCP-A4 (PBD §5.1 A4 row) — MP-A2 N-8 (deterministic backfill counts) and N-13 (Sign
// allowance semantics preserved), proved ACROSS the A4 migration on real Postgres 17.
//
// The golden observation was captured on the baseline code (b0e59aa6, pre-A4 schema, no
// product dimension) with CCP_A4_CAPTURE=1. This spec seeds the same corpus on the
// pre-A4 schema, records the row counts, applies the A4 migration over the populated
// tables, records the counts again, and replays the same observation sequence through
// the A4 code. The result must equal the golden byte for byte. Only the adapter below
// (the explicit product context) differs from the capture run.
// CCP-A5: the A5 migration (plan versions + v1 backfill + plan_version_id pin) is applied right
// after A4, because the code under test now reads limits through the pinned version. The
// golden therefore also proves A5 changes no Sign result (the A5 spec carries the N-19 detail).

const ROOT = resolve(__dirname, '../../../..');
const SUB_DIR = resolve(ROOT, 'libs/subscription/prisma/migrations');
const A4_NAME = '20261025140000_ccp_a4_product_dimension';
const A4 = resolve(SUB_DIR, A4_NAME, 'migration.sql');
const PRE_A4 = [
  resolve(ROOT, 'libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql'),
  ...readdirSync(SUB_DIR)
    .filter((n) => /^\d/.test(n) && n < A4_NAME)
    .sort()
    .map((n) => resolve(SUB_DIR, n, 'migration.sql')),
];
const GOLDEN = resolve(__dirname, 'fixtures/ccp-a4-sign-equality.golden.json');
const CAPTURE = process.env['CCP_A4_CAPTURE'] === '1';

const billing: BillingProviderPort = {
  provider: 'STRIPE',
  isConfigured: () => false,
  mode: () => 'test',
  upsertBillingAccount: async () => 'acct',
  createCheckoutSession: async () => ({ session_ref: 'cs', url: 'https://x' }),
  createPortalSession: async () => ({ url: 'https://x' }),
  retrieveSubscription: async () => {
    throw new Error('unused');
  },
  verifyWebhook: () => {
    throw new Error('unused');
  },
};

interface Golden {
  readonly captured_on: string;
  readonly counts: { plan: number; subscription: number; subscription_open: number };
  readonly observation: Record<string, unknown>;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-A4 — Sign allowance before/after equality across the A4 migration (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  const env = { ...process.env };
  let before: { plan: number; subscription: number; subscription_open: number };
  let after: { plan: number; subscription: number; subscription_open: number } | null = null;
  let observation: Record<string, unknown>;

  beforeAll(async () => {
    delete process.env['STRIPE_PLAN_PRICES'];
    delete process.env['BILLING_PAST_DUE_GRACE_DAYS'];
    delete process.env['SIGN_POST_TERMINATION_EXPORT_DAYS'];
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    pg = new Client({ connectionString: container.getConnectionUri() });
    await pg.connect();
    for (const m of PRE_A4) await pg.query(readFileSync(m, 'utf8'));
    await seedCorpus(pg);
    before = await rowCounts(pg);
    if (!CAPTURE) {
      await pg.query(readFileSync(A4, 'utf8'));
      after = await rowCounts(pg);
      await pg.query(readFileSync(CCP_A5_MIGRATION, 'utf8'));
      // CCP-A8: the rest of the chain, so the current allowance reader runs on the HEAD schema.
      await applyRemainingSubscriptionMigrations(pg, [...PRE_A4, A4, CCP_A5_MIGRATION]);
    }
    prisma = new PrismaService(container.getConnectionUri());
    await prisma.$connect();
    const allowance = new AllowanceService(prisma);
    const capacity = new CapacityService(prisma);
    const lifecycle = new SubscriptionLifecycleService(prisma, allowance, billing, capacity);
    // The adapter: the ONLY code that differs between the capture run and this run.
    // CCP-A4: each call now names the product explicitly (SIGN_PRODUCT_KEY).
    const P = SIGN_PRODUCT_KEY;
    const ops: SignOps = {
      getStatus: (t, k, at) => allowance.getStatus(t, P, k, at),
      reserve: (i) => allowance.reserve({ ...i, product_key: P }),
      consume: (i) => allowance.consume({ ...i, product_key: P }),
      release: (i) => allowance.release({ ...i, product_key: P }),
      staleReservations: (t, k, at) => allowance.staleReservations(t, P, k, at),
      resolveStale: (i) => allowance.resolveStale({ ...i, product_key: P }),
      recordHistorical: (i) => allowance.recordHistorical({ ...i, product_key: P }),
      capacityStatus: (t, k) => capacity.status(t, P, k),
      capacityReserve: (i) => capacity.reserve({ ...i, product_key: P }),
      capacityRelease: (i) => capacity.release({ ...i, product_key: P }),
      // CCP-C5 — the additive disabled `tax` state is checked and stripped (fixtures/ccp-c5.ts).
      account: async (t, k, at) => withoutDisabledTax(await lifecycle.account(t, P, k, at)),
      sendingOwner: (t, at) => lifecycle.sendingOwner(t, P, at),
    };
    observation = await observe(ops);
    if (CAPTURE) {
      const golden: Golden = { captured_on: process.env['CCP_A4_CAPTURED_ON'] ?? 'unknown', counts: before, observation };
      writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 2)}\n`);
    }
  }, 300_000);

  afterAll(async () => {
    process.env = env;
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  it('the golden was captured on the baseline code, pre-A4', () => {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden;
    expect(golden.captured_on).toMatch(/^b0e59aa6/);
  });

  it.skipIf(CAPTURE)('N-8: the A4 migration keeps every row; post-migration product_key = sign count equals the pre-migration total, 0 other values', async () => {
    expect(existsSync(A4)).toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden;
    expect(before).toEqual(golden.counts);
    expect(after).toEqual(before);
    const plan = await pg.query(`SELECT product_key, count(*)::int AS n FROM subscription."Plan" GROUP BY product_key ORDER BY product_key`);
    const sub = await pg.query(`SELECT product_key, composition_role, count(*)::int AS n FROM subscription."TenantSubscription" GROUP BY 1, 2 ORDER BY 1, 2`);
    expect(plan.rows).toEqual([{ product_key: 'sign', n: before.plan }]);
    expect(sub.rows).toEqual([{ product_key: 'sign', composition_role: 'BASE', n: before.subscription }]);
  });

  it.skipIf(CAPTURE)('N-13: every Sign allowance, capacity and account result equals the baseline golden byte for byte', () => {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden;
    expect(JSON.stringify(observation)).toBe(JSON.stringify(golden.observation));
  });
});
