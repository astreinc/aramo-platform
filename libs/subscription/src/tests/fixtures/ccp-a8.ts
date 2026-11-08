import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Client } from 'pg';

// CCP-A8 — ONE shared helper for the gated specs that apply a HAND-KEPT prefix of the subscription
// chain (pre-A4 + A4 + A5 goldens, the lifecycle spec) and then run the CURRENT code (CLAUDE.md:
// one shared test helper, not N duplicated edits). From CCP-A8 the allowance reader also reads
// subscription."SupportExtension" (a PAST_DUE row past grace may be kept sending by an overlay), so
// the code under test needs the HEAD schema. This applies every subscription migration the spec has
// NOT applied, in name order, whole-file (dollar-quoted bodies). The behaviour is uniform: none of
// these specs writes an overlay, so their observed results are the pre-A8 ones (no overlay row →
// the reader is exactly the pre-A8 rule; asserted by the unchanged goldens).

const SUB_DIR = resolve(__dirname, '../../../prisma/migrations');

/** Sign Catalog v2 (directive fc755040): catalog DATA only, no schema. The A4/A5 goldens skip it. */
export const SIGN_CATALOG_V2_MIGRATION = resolve(SUB_DIR, '20261101120000_sign_catalog_v2/migration.sql');

/**
 * Sign Business per-seat pricing (directive 00225bad, Amendment A1 46ac663d): catalog DATA only (the schema
 * is the preceding 20261108100000 migration). It refuses a database that already holds a Standard Business
 * or Professional subscription (A1-3), so a spec that seeds such subscriptions first, or asserts the
 * pre-per-seat catalog, skips it.
 */
export const SIGN_BUSINESS_PER_SEAT_CATALOG_MIGRATION = resolve(SUB_DIR, '20261108100100_sign_business_per_seat_catalog/migration.sql');

/** Every subscription migration not in `applied` (absolute paths), in name order. */
export function remainingSubscriptionMigrations(applied: readonly string[]): string[] {
  const done = new Set(applied.map((p) => resolve(p)));
  return readdirSync(SUB_DIR)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(SUB_DIR, n, 'migration.sql'))
    .filter((p) => !done.has(p));
}

/** `skip`: data-only migrations a spec keeps out because it asserts the catalog as it was before them. */
export async function applyRemainingSubscriptionMigrations(pg: Client, applied: readonly string[], skip: readonly string[] = []): Promise<string[]> {
  const rest = remainingSubscriptionMigrations([...applied, ...skip]);
  for (const m of rest) await pg.query(readFileSync(m, 'utf8'));
  return rest;
}

/**
 * Sign Business per-seat pricing, Amendment A1-5 — the migration-published per-seat Standard Business /
 * Professional versions carry NO Stripe pin, and a per-seat version never sells on the env (per-account)
 * map: checkout and the plans read refuse it until a Stripe price is pinned through the governed console
 * path. A spec that sells those plans after the per-seat catalog migration does what an operator does
 * before any per-seat sale: it pins each `plan_key=price_ref` of the env map (STRIPE_PLAN_PRICES format) to
 * the plan's PUBLISHED version — only where that version is priced per seat (an ACCOUNT version keeps
 * selling on the env map unchanged). ONE shared helper (CLAUDE.md), called by each such spec. Returns the
 * number of pins written.
 */
export async function pinPerSeatTestPrices(pg: Client, prices: string = process.env['STRIPE_PLAN_PRICES'] ?? ''): Promise<number> {
  let n = 0;
  for (const entry of prices.split(',').map((e) => e.trim()).filter((e) => e !== '')) {
    const [plan_key, price_ref] = entry.split('=').map((s) => s.trim());
    if (plan_key === undefined || price_ref === undefined || plan_key === '' || price_ref === '') continue;
    const r = await pg.query(
      `INSERT INTO subscription."PlanVersionPrice" (id, plan_version_id, provider, provider_price_ref, created_by, created_at)
       SELECT gen_random_uuid(), v.id, 'STRIPE', $2, 'test:per-seat-pin', now()
         FROM subscription."PlanVersion" v JOIN subscription."Plan" p ON p.id = v.plan_id
        WHERE p.key = $1 AND v.status = 'PUBLISHED' AND v.content->>'price_unit' = 'SEAT'
          AND NOT EXISTS (SELECT 1 FROM subscription."PlanVersionPrice" x WHERE x.plan_version_id = v.id AND x.provider = 'STRIPE')`,
      [plan_key, price_ref],
    );
    n += r.rowCount ?? 0;
  }
  return n;
}
