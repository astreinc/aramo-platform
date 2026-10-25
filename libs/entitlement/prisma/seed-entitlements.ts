// T2-E1-HF2 — governed tenant-entitlement reconciliation entrypoint.
//
// Runs on a fresh/redeployed box via `npm run prisma:seed-entitlements`, wired
// into deploy/seed-prod.sh (STAGE D). Grants the canonical default capability
// bundle (DEFAULT_TENANT_CAPABILITIES = {core, ats, portal}; `sourcing`
// excluded) to an EXPLICITLY-targeted tenant, additively and idempotently.
//
// Fail-closed contract (LOCKED HF2 §7/§9):
//   - DATABASE_URL must be set.
//   - ARAMO_ENTITLEMENT_TENANT_ID is REQUIRED and has NO implicit default — the
//     production Astre id is supplied by the deploy wrapper, never baked in here.
//   - the target tenant must exist in identity.Tenant (validated before any
//     grant); absent → exit non-zero, no write.
//   - grants ONLY the missing members of the canonical bundle; never deletes;
//     never touches RBAC/tenant/subscription rows. Re-run after convergence is a
//     no-op (idempotent via the composite PK + the provenance upsert).
//   - CCP-A7: the grant is recorded with the non-commercial source PROVISIONING (D4), and
//     NEVER clears a governed revoke (no resurrection, Charter D1 / G4). A withheld capability
//     is printed; the seed-prod Gate 3 (active rows only) then fails closed. Recovery is a
//     governed re-grant, never this seed.

import { DEFAULT_TENANT_CAPABILITIES } from '../src/lib/capability.js';
import { EntitlementRepository } from '../src/lib/entitlement.repository.js';
import {
  reconcileTenantEntitlements,
  resolveReconcileTarget,
  type EntitlementReconcileDeps,
} from '../src/lib/reconcile-entitlements.js';
import { PrismaService } from '../src/lib/prisma/prisma.service.js';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url.length === 0) {
    console.error('[entitlement-seed] FATAL: DATABASE_URL is not set.');
    process.exit(1);
  }

  // Explicit target tenant id — fail closed on missing/blank/invalid.
  let tenantId: string;
  try {
    tenantId = resolveReconcileTarget(process.env['ARAMO_ENTITLEMENT_TENANT_ID']);
  } catch (err) {
    console.error(
      `[entitlement-seed] FATAL: ${(err as Error).message} Set ARAMO_ENTITLEMENT_TENANT_ID.`,
    );
    process.exit(1);
    return;
  }

  const prisma = new PrismaService(url);
  await prisma.$connect();
  const repo = new EntitlementRepository(prisma);

  const deps: EntitlementReconcileDeps = {
    // Cross-schema existence check via raw SQL on the shared connection — keeps
    // this entitlement-owned entry free of an identity library dependency.
    async tenantExists(id: string): Promise<boolean> {
      const rows = await prisma.$queryRaw<Array<{ present: boolean }>>`
        SELECT EXISTS(SELECT 1 FROM identity."Tenant" WHERE id = ${id}::uuid) AS present`;
      return rows[0]?.present === true;
    },
    getCapabilities: (id) => repo.getCapabilities(id),
    grantCapabilities: (args) => repo.grantCapabilities({ ...args, granted_source: 'PROVISIONING' }),
  };

  try {
    const result = await reconcileTenantEntitlements(deps, {
      tenantId,
      required: DEFAULT_TENANT_CAPABILITIES,
    });
    if (result.withheld_revoked.length > 0) {
      console.error(
        `[entitlement-seed] tenant ${result.tenant_id}: ${result.withheld_revoked.length} capability(ies) under a governed revoke were NOT re-granted (no resurrection; recovery is a governed re-grant): ${result.withheld_revoked.join(', ')}.`,
      );
    }
    if (result.granted.length === 0 && result.withheld_revoked.length === 0) {
      console.log(
        `[entitlement-seed] tenant ${result.tenant_id}: all ${result.required.length} canonical capabilities already present — no-op.`,
      );
    } else if (result.granted.length > 0) {
      console.log(
        `[entitlement-seed] tenant ${result.tenant_id}: granted ${result.granted.length} missing capability(ies): ${result.granted.join(', ')}.`,
      );
    }
    console.log(
      `[entitlement-seed] tenant ${result.tenant_id}: canonical bundle now [${[...result.final].sort().join(', ')}] (required: [${[...result.required].sort().join(', ')}]).`,
    );
  } finally {
    await prisma.onModuleDestroy();
  }
}

main().catch((err) => {
  console.error('[entitlement-seed] FATAL:', err);
  process.exit(1);
});
