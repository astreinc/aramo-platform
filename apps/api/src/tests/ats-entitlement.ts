import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// INC-1b (TIP-E2E) test fixture — grant the `ats` tenant capability for integration
// specs that boot AppModule and exercise the examine / submittal controllers. INC-1a/1b
// added `@RequireCapability('ats')` (EntitlementGuard) to those controllers, so a
// bootstrapped integration tenant now needs the entitlement schema + an `ats` row or
// every guarded route 403s (TENANT_CAPABILITY_NOT_ENTITLED). Applies the entitlement
// init migration (idempotent for a fresh test DB that has no entitlement schema) and
// upserts the capability. Mirrors the ats-batch* integration specs' own seed.
export async function ensureAtsEntitlement(
  query: (sql: string, params?: unknown[]) => Promise<unknown>,
  tenantId: string,
  root: string,
): Promise<void> {
  await query(
    readFileSync(
      resolve(
        root,
        'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
      ),
      'utf8',
    ),
  );
  await query(
    `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
     VALUES ($1::uuid, 'ats')
     ON CONFLICT (tenant_id, capability) DO NOTHING`,
    [tenantId],
  );
}
