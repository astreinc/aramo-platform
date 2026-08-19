// T2-E1-HF2 — tenant-entitlement reconciliation core.
//
// Pure orchestration (no process/env/Prisma coupling) so it is unit-testable
// with fakes. The CLI wrapper (libs/entitlement/prisma/seed-entitlements.ts)
// supplies the real dependencies, the explicit target tenant id, and the
// exit-code handling.
//
// Contract (LOCKED HF2 §7/§9):
//   - explicit target tenant id is mandatory (resolveReconcileTarget); a
//     missing/blank value fails closed. There is NO implicit default here — the
//     production Astre id is supplied only by the deploy wrapper, never baked in.
//   - the tenant MUST exist (deps.tenantExists) before any grant; absent → fail
//     closed, no write.
//   - additive only: grant ONLY the missing members of the canonical bundle via
//     deps.grantCapabilities; never delete; never touch RBAC/tenant/subscription.
//   - idempotent: a second run after convergence grants nothing.

import type { Capability } from './capability.js';

export interface EntitlementReconcileDeps {
  // True iff the tenant row exists in the identity store.
  tenantExists(tenantId: string): Promise<boolean>;
  // Capabilities currently entitled to the tenant.
  getCapabilities(tenantId: string): Promise<Set<Capability>>;
  // Grant (additive, idempotent) the given capabilities to the tenant.
  grantCapabilities(args: {
    tenant_id: string;
    capabilities: readonly Capability[];
  }): Promise<void>;
}

export interface EntitlementReconcileResult {
  tenant_id: string;
  required: readonly Capability[];
  already_present: Capability[];
  granted: Capability[];
  final: Capability[];
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolve the explicit target tenant id from a value (typically an env var).
// No implicit default: undefined/empty/whitespace fails closed; a non-UUID
// value fails closed. Returns the trimmed id.
export function resolveReconcileTarget(rawTenantId: unknown): string {
  if (typeof rawTenantId !== 'string' || rawTenantId.trim().length === 0) {
    throw new Error(
      'entitlement reconcile: an explicit target tenant id is required (no implicit default).',
    );
  }
  const tenantId = rawTenantId.trim();
  if (!UUID_RE.test(tenantId)) {
    throw new Error(
      `entitlement reconcile: target tenant id is not a valid UUID: "${tenantId}".`,
    );
  }
  return tenantId;
}

// Reconcile a single tenant's entitlements to the canonical required bundle.
// Fails closed (throws, no write) if the tenant does not exist. Grants only the
// missing members. Returns a structural summary (no secrets).
export async function reconcileTenantEntitlements(
  deps: EntitlementReconcileDeps,
  input: { tenantId: string; required: readonly Capability[] },
): Promise<EntitlementReconcileResult> {
  const tenantId = resolveReconcileTarget(input.tenantId);

  const exists = await deps.tenantExists(tenantId);
  if (!exists) {
    throw new Error(
      `entitlement reconcile: target tenant ${tenantId} does not exist — refusing to grant.`,
    );
  }

  const current = await deps.getCapabilities(tenantId);
  const alreadyPresent = input.required.filter((c) => current.has(c));
  const missing = input.required.filter((c) => !current.has(c));

  if (missing.length > 0) {
    await deps.grantCapabilities({ tenant_id: tenantId, capabilities: missing });
  }

  const after = await deps.getCapabilities(tenantId);
  return {
    tenant_id: tenantId,
    required: input.required,
    already_present: alreadyPresent,
    granted: missing,
    final: input.required.filter((c) => after.has(c)),
  };
}
