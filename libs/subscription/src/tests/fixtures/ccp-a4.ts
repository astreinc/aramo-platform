import { resolve } from 'node:path';

import type { Client } from 'pg';

// CCP-A4 (PBD §5.1 A4 row; MP-A2 N-9, N-12) — ONE shared helper for the specs the A4
// migration ripples into (CLAUDE.md: one helper, not N duplicated edits).

/** The A4 migration (product_key, composition_role, registry CHECKs, composite FK, index swap). */
export const CCP_A4_MIGRATION = resolve(__dirname, '../../../prisma/migrations/20261025140000_ccp_a4_product_dimension/migration.sql');

/** The recorded compensating SQL (pre-execution record §5). Executed by the A4 spec only. */
export const CCP_A4_COMPENSATING = resolve(__dirname, 'ccp-a4-compensating.sql');

/**
 * MP-A2 N-12 — the second product key, registered ONLY inside a test database (Architect
 * ruling O-2). It appears in no migration, seed or production registry; the shipped CHECKs
 * and the code registry reject it (asserted by the A4 spec).
 */
export const ISOLATION_TEST_PRODUCT_KEY = 'ccp_a4_isolation_test';

/** Widen the two registry CHECKs of THIS test database to admit the isolation key. */
export async function registerIsolationTestProduct(pg: Client): Promise<void> {
  await pg.query(`
    ALTER TABLE "subscription"."Plan" DROP CONSTRAINT "Plan_product_key_registry_check";
    ALTER TABLE "subscription"."Plan" ADD CONSTRAINT "Plan_product_key_registry_check" CHECK ("product_key" IN ('sign', '${ISOLATION_TEST_PRODUCT_KEY}'));
    ALTER TABLE "subscription"."TenantSubscription" DROP CONSTRAINT "TenantSubscription_product_key_registry_check";
    ALTER TABLE "subscription"."TenantSubscription" ADD CONSTRAINT "TenantSubscription_product_key_registry_check" CHECK ("product_key" IN ('sign', '${ISOLATION_TEST_PRODUCT_KEY}'));
  `);
}

/** Restore the shipped (sign-only) registry CHECKs of this test database. */
export async function unregisterIsolationTestProduct(pg: Client): Promise<void> {
  await pg.query(`
    ALTER TABLE "subscription"."Plan" DROP CONSTRAINT "Plan_product_key_registry_check";
    ALTER TABLE "subscription"."Plan" ADD CONSTRAINT "Plan_product_key_registry_check" CHECK ("product_key" IN ('sign'));
    ALTER TABLE "subscription"."TenantSubscription" DROP CONSTRAINT "TenantSubscription_product_key_registry_check";
    ALTER TABLE "subscription"."TenantSubscription" ADD CONSTRAINT "TenantSubscription_product_key_registry_check" CHECK ("product_key" IN ('sign'));
  `);
}
