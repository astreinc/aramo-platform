import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import type { SignatureProviderPort } from '@aramo/documents-contracts';
import type { EntitlementRepository } from '@aramo/entitlement';
import type { SignatureProviderKey, SignatureRoutingRepository } from '@aramo/signature-routing';
import { AllowanceService, SubscriptionPrismaService } from '@aramo/subscription';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SignatureAvailabilityService } from '../document-signing/signature-availability.service.js';
import { SignatureRoutingService } from '../document-signing/signature-routing.service.js';

// CCP-A4 (PBD §5.1 A4 row; MP-A2 N-13a) — ATS RTR and Offer sends keep spending the
// tenant's Sign allowance, with identical availability before and after A4. Real
// SignatureAvailabilityService + SignatureRoutingService.forNewSend (the RTR/Offer send
// entry, GovernedDocumentSigningService) on the in-process transport, over a REAL
// AllowanceService on Postgres 17. Tenants hold ONLY a `sign` subscription.
//
// The golden was captured on the baseline code (b0e59aa6, pre-A4 schema) with
// CCP_A4_CAPTURE=1. This run seeds the same tenants on the pre-A4 schema, applies the A4
// migration over them and must reproduce the golden exactly. The spec body is unchanged
// between the two runs: the product context lives inside the services under test.

const ROOT = resolve(__dirname, '../../../..');
const SUB_DIR = resolve(ROOT, 'libs/subscription/prisma/migrations');
const A4_NAME = '20261025140000_ccp_a4_product_dimension';
const A4 = resolve(SUB_DIR, A4_NAME, 'migration.sql');
// CCP-A5 — applied right after A4: the code under test reads limits through the pinned plan
// version, so the golden also proves A5 changes no result (plan versions + v1 backfill).
const A5 = resolve(SUB_DIR, '20261025160000_ccp_a5_plan_version', 'migration.sql');
// A plan created after A5 needs its v1 (DRAFT, then PUBLISHED) before a subscription can pin it.
const PUBLISH_V1 = `
  INSERT INTO subscription."PlanVersion" (id, plan_id, version_number, status, content, content_checksum, created_by, created_at)
  SELECT gen_random_uuid(), $1::uuid, 1, 'DRAFT', x.c, subscription.ccp_plan_version_checksum(x.c), 'test', now()
    FROM (SELECT subscription.ccp_plan_live_content($1::uuid) AS c) x`;
const PUBLISHED = (planSql: string): string => `(SELECT v.id FROM subscription."PlanVersion" v WHERE v.plan_id = ${planSql} AND v.status = 'PUBLISHED')`;
const PRE_A4 = [
  resolve(ROOT, 'libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql'),
  ...readdirSync(SUB_DIR)
    .filter((n) => /^\d/.test(n) && n < A4_NAME)
    .sort()
    .map((n) => resolve(SUB_DIR, n, 'migration.sql')),
];
const GOLDEN = resolve(__dirname, 'fixtures/ccp-a4-ats-sign-availability.golden.json');
const CAPTURE = process.env['CCP_A4_CAPTURE'] === '1';
// The services read "now"; only Date is faked, so the period is fixed.
const NOW = new Date('2026-10-18T12:00:00.000Z');
const SENDER = ['document:create', 'document:execute'];

const PLAN = { included: '019a0000-5150-7000-8000-000000000001', business: '019a0000-5150-7000-8000-000000000011' };
const T = (n: number): string => `0190a4a6-0000-7000-8000-${String(n).padStart(12, '0')}`;
// [tenant n, plan, status, grace_until, consumed this period]
const TENANTS: readonly [number, keyof typeof PLAN | null, string, string | null, number][] = [
  [1, 'included', 'ACTIVE', null, 0],
  [2, 'included', 'ACTIVE', null, 80],
  [3, 'included', 'ACTIVE', null, 99],
  [4, 'included', 'ACTIVE', null, 100],
  [5, 'business', 'ACTIVE', null, 40],
  [6, 'business', 'PAST_DUE', '2026-10-17T00:00:00Z', 0],
  [7, null, '', null, 0],
];

function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(
    (v) => ({ ok: v }),
    (e: { code?: string; statusCode?: number; context?: { details?: unknown } }) => ({ error: e.code ?? String(e), status: e.statusCode ?? null, details: e.context?.details ?? null }),
  );
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-A4 N-13a — ATS RTR/Offer Sign availability before/after A4 (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: SubscriptionPrismaService;
  let availability: SignatureAvailabilityService;
  let router: SignatureRoutingService;
  const observation: Record<string, unknown> = {};

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    pg = new Client({ connectionString: container.getConnectionUri() });
    await pg.connect();
    for (const m of PRE_A4) await pg.query(readFileSync(m, 'utf8'));
    for (const [n, plan, status, grace, used] of TENANTS) {
      if (plan === null) continue;
      await pg.query(
        `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, period_anchor, source, created_by, status, grace_until)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, '2026-10-01T00:00:00Z', 'MANUAL', 'ccp-a4-ats', $3, $4::timestamptz)`,
        [T(n), PLAN[plan], status, grace],
      );
      if (used > 0) {
        await pg.query(
          `INSERT INTO subscription."AllowanceUsage" (id, tenant_id, allowance_key, send_key, period_start, state, origin, reserved_at, reserved_until, finalized_at)
           SELECT gen_random_uuid(), $1::uuid, 'sign.envelopes', 'aramo-sign:envelope:seed-' || g, '2026-10-01T00:00:00Z', 'CONSUMED', 'SEND',
                  '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z' FROM generate_series(1, $2::int) g`,
          [T(n), used],
        );
      }
    }
    if (!CAPTURE) {
      await pg.query(readFileSync(A4, 'utf8'));
      await pg.query(readFileSync(A5, 'utf8'));
    }
    prisma = new SubscriptionPrismaService(container.getConnectionUri());
    await prisma.$connect();
    const routing = {
      getSelectedProvider: async () => ({ provider: 'aramo_sign' as SignatureProviderKey, explicit: false }),
      findRoute: async () => null,
      recordRoute: async () => undefined,
      recordExternalSend: async () => undefined,
    } as unknown as SignatureRoutingRepository;
    const entitlements = { getCapabilities: async () => new Set(['core', 'ats', 'sign']) } as unknown as EntitlementRepository;
    const registry = new Map<SignatureProviderKey, SignatureProviderPort>([['aramo_sign', { name: 'aramo-in-process' } as unknown as SignatureProviderPort]]);
    availability = new SignatureAvailabilityService(routing, entitlements, new AllowanceService(prisma), registry);
    router = new SignatureRoutingService(availability, routing, registry);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    for (const [n] of TENANTS) {
      const t = T(n);
      observation[t] = JSON.parse(
        JSON.stringify({
          recruiter_view: await availability.evaluate(t, SENDER),
          policy_view: await availability.evaluate(t),
          rtr_send: await outcome(async () => (await router.forNewSend(t, 'rtr-request')).provider),
          offer_send: await outcome(async () => (await router.forNewSend(t, 'offer-request')).provider),
        }),
      );
    }
    vi.useRealTimers();
    if (CAPTURE) writeFileSync(GOLDEN, `${JSON.stringify({ captured_on: process.env['CCP_A4_CAPTURED_ON'] ?? 'unknown', observation }, null, 2)}\n`);
  }, 300_000);

  afterAll(async () => {
    vi.useRealTimers();
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  it('the golden was captured on the baseline code, pre-A4', () => {
    expect((JSON.parse(readFileSync(GOLDEN, 'utf8')) as { captured_on: string }).captured_on).toMatch(/^b0e59aa6/);
  });

  it.skipIf(CAPTURE)('RTR/Offer availability and send routing equal the baseline golden byte for byte (sign-only tenants)', () => {
    expect(existsSync(A4)).toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { observation: unknown };
    expect(JSON.stringify(observation)).toBe(JSON.stringify(golden.observation));
  });

  // MP-A2 N-12 — the ATS path (signature-availability.service.ts) on a tenant that ALSO holds an
  // open BASE subscription of a second product. The second key is registered in THIS test
  // database only (Architect ruling O-2); its plan carries the same metered key with limit 7, so
  // a product-blind read would show. The ATS results must stay the golden ones.
  it.skipIf(CAPTURE)('N-12: with an open second-product subscription, the ATS RTR/Offer path still resolves the sign row', async () => {
    const ISO = 'ccp_a4_isolation_test';
    await pg.query(`
      ALTER TABLE "subscription"."Plan" DROP CONSTRAINT "Plan_product_key_registry_check";
      ALTER TABLE "subscription"."Plan" ADD CONSTRAINT "Plan_product_key_registry_check" CHECK ("product_key" IN ('sign', '${ISO}'));
      ALTER TABLE "subscription"."TenantSubscription" DROP CONSTRAINT "TenantSubscription_product_key_registry_check";
      ALTER TABLE "subscription"."TenantSubscription" ADD CONSTRAINT "TenantSubscription_product_key_registry_check" CHECK ("product_key" IN ('sign', '${ISO}'));
    `);
    const plan = '019a0000-a4a4-7000-8000-0000000000e2';
    await pg.query(`INSERT INTO subscription."Plan" (id, key, name, product_key) VALUES ($1::uuid, 'ccp-a4-iso-ats', 'iso', $2)`, [plan, ISO]);
    await pg.query(`INSERT INTO subscription."PlanAllowance" (plan_id, allowance_key, included_quantity, unlimited, period) VALUES ($1::uuid, 'sign.envelopes', 7, false, 'MONTHLY')`, [plan]);
    await pg.query(PUBLISH_V1, [plan]);
    await pg.query(`UPDATE subscription."PlanVersion" SET status = 'PUBLISHED', published_at = now() WHERE plan_id = $1::uuid`, [plan]);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { observation: Record<string, unknown> };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      for (const n of [1, 2, 4, 7]) {
        const t = T(n);
        await pg.query(
          `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, ${PUBLISHED('$2::uuid')}, $3, 'BASE', '2026-10-09T00:00:00Z', 'MANUAL', 'ccp-a4-iso')`,
          [t, plan, ISO],
        );
        const seen = JSON.parse(
          JSON.stringify({
            recruiter_view: await availability.evaluate(t, SENDER),
            policy_view: await availability.evaluate(t),
            rtr_send: await outcome(async () => (await router.forNewSend(t, 'rtr-request')).provider),
            offer_send: await outcome(async () => (await router.forNewSend(t, 'offer-request')).provider),
          }),
        );
        expect(JSON.stringify(seen)).toBe(JSON.stringify(golden.observation[t]));
      }
    } finally {
      vi.useRealTimers();
    }
  }, 120_000);
});
