// Capability adapter (ADR-0024 §D10) — turns the authenticated principal's
// resolved permission SCOPES into the `principal_capabilities` boolean map the
// policy engine reads. §D10 requires ALREADY-RESOLVED BOOLEANS, never roles:
// a scope is a resolved permission (its presence in the JWT means the axis was
// granted upstream), so the mapping is a pure `present -> true`. It performs NO
// role interpretation and no policy logic; it only re-shapes `string[]` into
// `Record<string, boolean>`.

/**
 * Map granted permission scopes to the engine's capability booleans. Each
 * granted scope becomes `true`; an absent scope is simply not present (the
 * engine's `capabilities` predicate treats a missing key as not-held). The
 * empty scope set yields an empty map.
 */
export function scopesToCapabilities(scopes: readonly string[]): Record<string, boolean> {
  const capabilities: Record<string, boolean> = {};
  for (const scope of scopes) {
    capabilities[scope] = true;
  }
  return capabilities;
}
