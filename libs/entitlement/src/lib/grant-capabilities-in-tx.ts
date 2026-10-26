import type { Capability } from './capability.js';
import {
  type GovernedGrantSource,
  type PrismaRawQueryCapable,
  UnknownCapabilityError,
  revokeEntitlements,
  upsertEntitlements,
} from './entitlement-provenance.js';

// CCP-A6 (Recon Report §1 C3 step 5; Conversion Rule C-21) — grantCapabilitiesInTx: the
// cross-schema, IN-TRANSACTION entitlement grant. Modelled on
// libs/policy-store/src/lib/insert-decision-record.ts (insertPolicyDecisionRecordInTx): it runs
// raw SQL against entitlement."TenantEntitlement" on the CALLER's Prisma client, inside the
// caller's $transaction, so the grant commits IFF the caller's mutation commits. The program
// uses ONE Postgres database for every schema, owned by one role (CCP-A6 pre-execution record),
// so no second connection and no cross-client coordination is involved.
//
// CCP-A7 (Charter D1) — the grant is the shared provenance UPSERT: it records the commercial
// source (PLAN for a subscription's product bundle, MANUAL for a governed ENTITLEMENT_GRANT) and
// the change request, and — being governed — it RE-GRANTS a revoked row (clears revoked_*). An
// already active row is left exactly as it was. Returns the capabilities this call newly
// inserted or restored (sorted). Fail closed: an unknown capability throws before any SQL runs.
//
// revokeCapabilitiesInTx is the governed revoke (an ENTITLEMENT_REVOKE apply): it marks the
// active rows revoked in the caller's transaction and returns those it revoked.

export { UnknownCapabilityError };

export async function grantCapabilitiesInTx(
  tx: PrismaRawQueryCapable,
  args: {
    tenant_id: string;
    capabilities: readonly string[];
    granted_source: GovernedGrantSource;
    granted_by: string;
    change_request_id: string;
  },
): Promise<Capability[]> {
  const out = await upsertEntitlements(tx, args);
  return out.granted;
}

export async function revokeCapabilitiesInTx(
  tx: PrismaRawQueryCapable,
  args: { tenant_id: string; capabilities: readonly string[]; revoked_by: string; change_request_id: string },
): Promise<Capability[]> {
  return revokeEntitlements(tx, {
    tenant_id: args.tenant_id,
    capabilities: args.capabilities,
    revoked_by: args.revoked_by,
    revoke_change_request_id: args.change_request_id,
  });
}
