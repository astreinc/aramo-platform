// Reflect-metadata key used by the @RequireCapability decorator and read by
// EntitlementGuard. Defined here (not exported as a constant from the
// decorator file) so guard + decorator agree on the same string key
// without import cycles. Mirrors libs/authorization metadata convention.
export const REQUIRED_CAPABILITIES_KEY = 'aramo:entitlement:required_capabilities';
