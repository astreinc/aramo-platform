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
