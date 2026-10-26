export { EntitlementModule } from './lib/entitlement.module.js';
export { EntitlementGuard } from './lib/entitlement.guard.js';
export { EntitlementRepository } from './lib/entitlement.repository.js';
export { RequireCapability } from './lib/require-capability.decorator.js';
export { REQUIRED_CAPABILITIES_KEY } from './lib/entitlement.metadata.js';
export {
  CAPABILITY_VALUES,
  DEFAULT_TENANT_CAPABILITIES,
  isCapability,
  type Capability,
} from './lib/capability.js';
export {
  resolveReconcileTarget,
  reconcileTenantEntitlements,
  type EntitlementReconcileDeps,
  type EntitlementReconcileResult,
} from './lib/reconcile-entitlements.js';
// CCP-A6 — the in-transaction entitlement grant (raw cross-schema write on the caller's client).
export { grantCapabilitiesInTx, UnknownCapabilityError } from './lib/grant-capabilities-in-tx.js';
// CCP-A7 — provenance, the governed revoke (in-transaction) and the resurrection guard.
export { revokeCapabilitiesInTx } from './lib/grant-capabilities-in-tx.js';
export {
  COMMERCIAL_GRANTED_SOURCES,
  GRANTED_SOURCES,
  isCommercialGrantSource,
  isGrantedSource,
  type EntitlementGrantOutcome,
  type GovernedGrantSource,
  type GrantedSource,
  type UngovernedGrantSource,
} from './lib/entitlement-provenance.js';
