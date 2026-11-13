import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TENANT_1, TENANT_2, applyCcpA6Schema } from './support/ccp-a3-database.js';

// Aramo India Billing Regions + Razorpay Implementation Directive v1.0 (LOCKED) — WS-D migrations, applied
// with the full identity + subscription chains (real Postgres 17):
//   identity 20261113110000      TenantBillingRegionPolicy admits 'IN' beside 'US' (§4.9); nothing else.
//   subscription 20261113100300  SelfServiceBillingRequest admits RAZORPAY beside STRIPE (Q7: the owner's
//                                cancel of a Razorpay-billed subscription through Aramo's manage page).

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('India Billing WS-D migrations (real Postgres 17)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    pg = new Client({ connectionString: container.getConnectionUri() });
    await pg.connect();
    await applyCcpA6Schema(pg);
  }, 300_000);

  afterAll(async () => {
    await pg?.end();
    await container?.stop();
  }, 60_000);

  const def = async (schema: string, table: string, name: string): Promise<string> =>
    (
      await pg.query(
        `SELECT pg_get_constraintdef(c.oid) d FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = $1 AND t.relname = $2 AND c.conname = $3`,
        [schema, table, name],
      )
    ).rows[0]?.d as string;

  it('TenantBillingRegionPolicy holds a tenant to US or IN; any other region is refused', async () => {
    expect(await def('identity', 'TenantBillingRegionPolicy', 'TenantBillingRegionPolicy_region_check')).toMatch(/'US'.*'IN'/);
    await pg.query(`INSERT INTO identity."TenantBillingRegionPolicy" (tenant_id, region) VALUES ($1, 'IN')`, [TENANT_1]);
    await expect(pg.query(`INSERT INTO identity."TenantBillingRegionPolicy" (tenant_id, region) VALUES ($1, 'GB')`, [TENANT_2])).rejects.toThrow(/TenantBillingRegionPolicy_region_check/);
    await pg.query(`INSERT INTO identity."TenantBillingRegionPolicy" (tenant_id, region) VALUES ($1, 'US')`, [TENANT_2]);
  });

  it('SelfServiceBillingRequest admits RAZORPAY and STRIPE only (adjustments and usage stay Stripe-only)', async () => {
    const d = await def('subscription', 'SelfServiceBillingRequest', 'SelfServiceBillingRequest_provider_check');
    expect(d).toContain("'STRIPE'");
    expect(d).toContain("'RAZORPAY'");
    expect(d).not.toContain('APP_STORE');
    expect(await def('subscription', 'BillingProviderCommand', 'BillingProviderCommand_provider_check')).toContain("'RAZORPAY'");
  });
});
