import type { Capability } from './capability.js';
import { isCapability } from './capability.js';

// CCP-A6 (Recon Report §1 C3 step 5; Conversion Rule C-21) — grantCapabilitiesInTx: the
// cross-schema, IN-TRANSACTION entitlement grant. Modelled on
// libs/policy-store/src/lib/insert-decision-record.ts (insertPolicyDecisionRecordInTx): it runs
// a raw INSERT into entitlement."TenantEntitlement" on the CALLER's Prisma client, inside the
// caller's $transaction, so the grant commits IFF the caller's mutation commits. The program
// uses ONE Postgres database for every schema, owned by one role (CCP-A6 pre-execution record),
// so no second connection and no cross-client coordination is involved.
//
// Idempotent at the row level (the composite PK (tenant_id, capability); ON CONFLICT DO
// NOTHING), exactly like EntitlementRepository.grantCapabilities. Returns the capabilities this
// call newly inserted (the rest were already held). Fail closed: an unknown capability throws
// before any SQL runs.

interface PrismaRawQueryCapable {
  $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>;
}

export class UnknownCapabilityError extends Error {
  constructor(readonly capability: string) {
    super(`unknown capability ${capability}`);
    this.name = 'UnknownCapabilityError';
  }
}

export async function grantCapabilitiesInTx(
  tx: PrismaRawQueryCapable,
  args: { tenant_id: string; capabilities: readonly string[] },
): Promise<Capability[]> {
  const wanted = [...new Set(args.capabilities)];
  for (const c of wanted) if (!isCapability(c)) throw new UnknownCapabilityError(c);
  if (wanted.length === 0) return [];
  const rows = await tx.$queryRawUnsafe<Array<{ capability: string }>>(
    `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
     SELECT $1::uuid, c::entitlement."Capability" FROM unnest($2::text[]) AS c
     ON CONFLICT (tenant_id, capability) DO NOTHING
     RETURNING capability::text AS capability`,
    args.tenant_id,
    wanted,
  );
  return rows.map((r) => r.capability as Capability).sort();
}
