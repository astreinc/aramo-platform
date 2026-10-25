import { readFileSync } from 'node:fs';

import { resolveEntitlementMigrations } from '@aramo/common';

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
  await query(
    `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
     VALUES ($1::uuid, 'ats')
     ON CONFLICT (tenant_id, capability) DO NOTHING`,
    [tenantId],
  );
}
