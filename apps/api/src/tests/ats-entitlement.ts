import { readFileSync } from 'node:fs';

import { resolveEntitlementMigrations, seedTenantEntitlements } from '@aramo/common';

// INC-1b (TIP-E2E) test fixture — grant the `ats` tenant capability for integration
// specs that boot AppModule and exercise the examine / submittal controllers. INC-1a/1b
// added `@RequireCapability('ats')` (EntitlementGuard) to those controllers, so a
// bootstrapped integration tenant now needs the entitlement schema + an `ats` row or
// every guarded route 403s (TENANT_CAPABILITY_NOT_ENTITLED). Applies the entitlement
// migrations (CCP-A7: the full set from the shared helper — the repository reads the A7
// columns; once per fresh test DB) and upserts the capability. Mirrors the ats-batch*
// integration specs' own seed.
export async function ensureAtsEntitlement(
  query: (sql: string, params?: unknown[]) => Promise<unknown>,
  tenantId: string,
  root: string,
): Promise<void> {
  for (const migration of resolveEntitlementMigrations(root)) {
    await query(readFileSync(migration, 'utf8'));
  }
  // CCP-R1 (TD-A7-3): no DB default — the shared fixture helper requires the source.
  await seedTenantEntitlements(query, { tenant_id: tenantId, capabilities: ['ats'], granted_source: 'PROVISIONING' });
}
