// Settings S1 — the closed-set known-keys registry (Gate-5 Ruling 1).
//
// `KNOWN_SETTINGS` is the single source of truth for every valid setting key,
// its TypeScript value type, and its code-defined default. The parametric
// `TenantSettingService.get<K>(tenant, key)` projects per-key types back from
// the JSONB column, recovering pattern-(A) discrete-column type safety in
// code without the schema cost.
//
// SHIPPED EMPTY in S1 (Gate-5 Ruling 1 — the MINIMAL foundation; the
// directive §0 "ideally zero domain fields beyond the structural ones"). The
// FIRST entry lands with S2 (the pricing-model-default config + the write
// path that audits its mutations).
//
// Adding a known-key (S2 onward) is intentionally low-ceremony — register a
// `SettingDefinition` here and the typed-accessor + default-fallback pick it
// up. No migration per setting (the pattern-B win — discrete columns would
// require one schema change per known-key).
//
// Unknown keys are a COMPILE error. `TenantSettingService.get<K>` takes
// `K extends KnownSettingKey`; misspelling 'foo' fails at the type level
// rather than silently falling back to undefined at runtime.

// A per-key definition: ties a key string-literal to its runtime type via
// `T` and its code-defined default. The default is returned by
// `TenantSettingService.get` when no row exists for (tenant, key) — the
// import-config TODO-consumer pattern (env-or-default), generalized.
export interface SettingDefinition<T> {
  readonly key: string;
  readonly default: T;
}

// The closed-set registry. SHIPPED EMPTY in S1 (Ruling 1); S2's pricing-
// model-default is the first concrete entry.
//
// Shape (when populated):
//   readonly 'compensation.display_default': SettingDefinition<'spread' | 'markup' | 'both'>;
//   readonly 'import.failure_threshold_pct': SettingDefinition<number>;
//   ...
//
// `as const` preserves the keys as string-literal types so `KnownSettingKey`
// below is the precise union.
export const KNOWN_SETTINGS = {} as const satisfies Record<string, SettingDefinition<unknown>>;

// The union of every registered key. `KnownSettingKey` is `never` while
// `KNOWN_SETTINGS` is empty (S1); narrows to the registered union as S2+ add
// entries. Callers of `TenantSettingService.get<K>` are constrained to this
// union — unknown keys fail to compile.
export type KnownSettingKey = keyof typeof KNOWN_SETTINGS;

// The value type for a specific known-key. Used by
// `TenantSettingService.get<K>(tenant, key) -> Promise<SettingValueOf<K>>`
// so the call-site sees the precise per-key value type, not `unknown`.
export type SettingValueOf<K extends KnownSettingKey> =
  (typeof KNOWN_SETTINGS)[K] extends SettingDefinition<infer V> ? V : never;

// The list of registered keys (snapshot of `KNOWN_SETTINGS` keys). Used by
// `TenantSettingService.getAll` to materialize the full per-tenant settings
// view — every known-key gets its row-value-or-default; unknown DB rows
// are filtered out (forward-compatible: a row for a future-known-key
// written by a later version remains harmless to an older reader).
export const KNOWN_SETTING_KEYS: readonly KnownSettingKey[] =
  Object.freeze(Object.keys(KNOWN_SETTINGS) as KnownSettingKey[]);

// Type-narrowing guard for runtime-string -> KnownSettingKey. Useful at the
// service boundary when a request shape lands a raw string (S2 write path);
// S1 doesn't accept user-provided keys (GET-all is fixed-shape), so the
// guard exists for symmetry but isn't exercised by S1 surfaces.
export function isKnownSettingKey(value: unknown): value is KnownSettingKey {
  return (
    typeof value === 'string' &&
    (KNOWN_SETTING_KEYS as readonly string[]).includes(value)
  );
}
