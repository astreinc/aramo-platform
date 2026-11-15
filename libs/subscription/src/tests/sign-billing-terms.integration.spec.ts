import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parsePlanVersionContent, planVersionChecksum, withBillingTerms } from '../lib/plan-version.js';

// Aramo Sign Monthly and Annual-Commitment Pricing Directive v1.0 (LOCKED 2026-11-15) — migration
// 20261115100000_sign_billing_terms on real Postgres 17, over the full metering + subscription chain:
//   - every existing version is untouched (no "terms" key, its checksum still verifies) and every new column
//     is NULL on existing rows (no data rewrite);
//   - a version may carry "terms" (the SQL canonicalizer agrees with the JS checksum); a non-array is refused;
//   - web pins are one per (version, provider, term slot), a NULL term being the one legacy slot; a store pin
//     never carries a term; the term CHECKs on PlanVersionPrice, CheckoutIntent and TenantSubscription.

const ROOT = resolve(__dirname, '../../../..');
const SUB_DIR = resolve(ROOT, 'libs/subscription/prisma/migrations');
const MIGRATION = '20261115100000_sign_billing_terms';
const ALL = [
  resolve(ROOT, 'libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql'),
  ...readdirSync(SUB_DIR)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(SUB_DIR, n, 'migration.sql')),
];
const STANDARD = 'aramo-sign-standard-personal-v1';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Sign billing terms migration (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let draftId = '';
  let publishedId = '';

  const pin = (version: string, provider: string, term: string | null, ref: string, interval = 'MONTH') =>
    pg.query(
      `INSERT INTO subscription."PlanVersionPrice" (id, plan_version_id, provider, provider_price_ref, interval, term, created_by, created_at)
       VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4, $5, 'test', now())`,
      [version, provider, ref, interval, term],
    );

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    pg = new Client({ connectionString: container.getConnectionUri() });
    await pg.connect();
    expect(ALL.some((m) => m.includes(MIGRATION))).toBe(true);
    for (const m of ALL) await pg.query(readFileSync(m, 'utf8'));
  }, 180_000);

  afterAll(async () => {
    await pg?.end();
    await container?.stop();
  });

  it('existing versions keep their exact content: no terms key, every checksum still verifies', async () => {
    const rows = (await pg.query<{ content: unknown; content_checksum: string }>(`SELECT content, content_checksum FROM subscription."PlanVersion"`)).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Object.keys(r.content as object)).not.toContain('terms');
      expect(planVersionChecksum(r.content)).toBe(r.content_checksum);
      expect(() => parsePlanVersionContent(r.content)).not.toThrow();
    }
  });

  it('the new columns are NULL on every existing row (no data rewrite)', async () => {
    for (const table of ['PlanVersionPrice', 'CheckoutIntent', 'TenantSubscription']) {
      const r = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM subscription."${table}" WHERE term IS NOT NULL`);
      expect(r.rows[0]?.n, table).toBe(0);
    }
  });

  it('a DRAFT may carry explicit terms: the SQL checksum agrees with the JS one; a non-array terms value is refused', async () => {
    const cur = (
      await pg.query<{ id: string; plan_id: string; content: unknown; version_number: number }>(
        `SELECT v.id, v.plan_id, v.content,
                (SELECT max(x.version_number) FROM subscription."PlanVersion" x WHERE x.plan_id = v.plan_id) AS version_number
           FROM subscription."PlanVersion" v JOIN subscription."Plan" p ON p.id = v.plan_id
          WHERE p.key = $1 AND v.status = 'PUBLISHED'`,
        [STANDARD],
      )
    ).rows[0];
    expect(cur).toBeDefined();
    publishedId = cur?.id as string;
    const two = withBillingTerms(parsePlanVersionContent(cur?.content), [
      { term: 'MONTHLY', list_price_minor: 1200, commitment_months: null },
      { term: 'ANNUAL_COMMIT', list_price_minor: 1000, commitment_months: 12 },
    ]);
    const inserted = await pg.query<{ id: string }>(
      `INSERT INTO subscription."PlanVersion" (id, plan_id, version_number, status, content, content_checksum, created_by, created_at)
       VALUES (gen_random_uuid(), $1::uuid, $2, 'DRAFT', $3::jsonb, $4, 'test', now()) RETURNING id`,
      [cur?.plan_id, (cur?.version_number ?? 0) + 1, JSON.stringify(two), planVersionChecksum(two)],
    );
    draftId = inserted.rows[0]?.id as string;
    const stored = (await pg.query<{ content: unknown; content_checksum: string }>(`SELECT content, content_checksum FROM subscription."PlanVersion" WHERE id = $1::uuid`, [draftId])).rows[0];
    expect(parsePlanVersionContent(stored?.content).terms).toEqual(two.terms);
    expect(planVersionChecksum(stored?.content)).toBe(stored?.content_checksum);

    const bad = { ...two, terms: { MONTHLY: 1200 } };
    await expect(
      pg.query(
        `INSERT INTO subscription."PlanVersion" (id, plan_id, version_number, status, content, content_checksum, created_by, created_at)
         VALUES (gen_random_uuid(), $1::uuid, $2, 'DRAFT', $3::jsonb, $4, 'test', now())`,
        [cur?.plan_id, (cur?.version_number ?? 0) + 2, JSON.stringify(bad), planVersionChecksum(bad)],
      ),
    ).rejects.toThrow(/PlanVersion_terms_shape_check/);
  });

  it('web pins: one per (version, provider, term slot); NULL is the one legacy slot; a store pin never has a term', async () => {
    expect(draftId).not.toBe('');
    await pin(draftId, 'STRIPE', 'MONTHLY', 'price_bt_monthly');
    await pin(draftId, 'STRIPE', 'ANNUAL_COMMIT', 'price_bt_annual');
    await expect(pin(draftId, 'STRIPE', 'MONTHLY', 'price_bt_monthly_2')).rejects.toThrow(/PlanVersionPrice_plan_version_id_provider_key/);
    await pin(draftId, 'STRIPE', null, 'price_bt_legacy');
    await expect(pin(draftId, 'STRIPE', null, 'price_bt_legacy_2')).rejects.toThrow(/PlanVersionPrice_plan_version_id_provider_key/);
    // A provider price still belongs to one version and slot (here: the published version's free legacy slot).
    await expect(pin(publishedId, 'STRIPE', null, 'price_bt_monthly')).rejects.toThrow(/PlanVersionPrice_provider_provider_price_ref_key/);
    await expect(pin(draftId, 'STRIPE', 'WEEKLY', 'price_bt_weekly')).rejects.toThrow(/PlanVersionPrice_term_check/);
    await expect(pin(draftId, 'APP_STORE', 'MONTHLY', 'ai.aramo.sign.bt.monthly')).rejects.toThrow(/PlanVersionPrice_term_check/);
    const rows = (await pg.query<{ term: string | null }>(`SELECT term FROM subscription."PlanVersionPrice" WHERE plan_version_id = $1::uuid ORDER BY provider_price_ref`, [draftId])).rows;
    // price_bt_annual, price_bt_legacy, price_bt_monthly
    expect(rows.map((r) => r.term)).toEqual(['ANNUAL_COMMIT', null, 'MONTHLY']);
  });

  it('the term CHECKs on CheckoutIntent and TenantSubscription admit MONTHLY, ANNUAL_COMMIT or NULL only', async () => {
    for (const [table, name] of [['CheckoutIntent', 'CheckoutIntent_term_check'], ['TenantSubscription', 'TenantSubscription_term_check']] as const) {
      const def = (
        await pg.query<{ def: string }>(
          `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'subscription' AND t.relname = $1 AND c.conname = $2`,
          [table, name],
        )
      ).rows[0]?.def;
      expect(def, name).toContain('MONTHLY');
      expect(def, name).toContain('ANNUAL_COMMIT');
      expect(def, name).toContain('IS NULL');
    }
  });

  it('re-applying the migration is a no-op (idempotent)', async () => {
    await pg.query(readFileSync(resolve(SUB_DIR, MIGRATION, 'migration.sql'), 'utf8'));
    const r = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM subscription."PlanVersionPrice" WHERE plan_version_id = $1::uuid`, [draftId]);
    expect(r.rows[0]?.n).toBe(3);
  });
});
