// Settings S2 — the closed-set known-keys registry.
//
// `KNOWN_SETTINGS` is the single source of truth for every valid setting key,
// its TypeScript value type, its code-defined default, and (S2 onward) its
// per-key value validator. The parametric `TenantSettingService.get<K>` /
// `set<K>(tenant, key, value)` project per-key types back from the JSONB
// column, recovering pattern-(A) discrete-column type safety in code without
// the schema cost.
//
// S1 shipped the registry EMPTY (Gate-5 Ruling 1 — the MINIMAL foundation).
// S2 lights up the FIRST entry: `compensation.display_default` (the
// pricing-model display picker; the comp v1.1 forward-link).
//
// Adding a known-key (S3 onward) is intentionally low-ceremony — register a
// `SettingDefinition` here with its key, type, default, AND validator and
// the typed-accessor + default-fallback + write-path pick it up. No migration
// per setting (the pattern-B win — discrete columns would require one schema
// change per known-key).
//
// Unknown keys are a COMPILE error. `TenantSettingService.get<K>` /
// `set<K>` take `K extends KnownSettingKey`; misspelling 'foo' fails at the
// type level rather than silently falling back to undefined at runtime. The
// runtime guard `isKnownSettingKey` enforces the same closed-set at the
// controller boundary where a raw URL/body string crosses in.

// A per-key definition: ties a key string-literal to its runtime type via
// `T`, its code-defined default, and (S2 PRECEDENT) its value validator.
//
// The default is returned by `TenantSettingService.get` when no row exists
// for (tenant, key) — the import-config TODO-consumer pattern (env-or-default),
// generalized.
//
// The validator is a TypeScript type-predicate. `set<K>` invokes it at the
// service boundary; the controller invokes it at the request boundary
// (before calling `set<K>`) so bad values surface as VALIDATION_ERROR
// without touching the DB. THIS IS THE PRECEDENT for S3/S4/S6+ keys: every
// future SettingDefinition declares its own `validate` co-located with the
// type + default — the registry stays the single source of truth.
//
// Rule-of-three deferral: S2 lands exactly ONE validator (an explicit
// 3-arm enum check). When S3+ introduce more validators of the same shape
// (enum-from-a-closed-set), a `makeEnumValidator(values)` helper may be
// extracted; introducing it at S2 would speculate the future shape.
export interface SettingDefinition<T> {
  readonly key: string;
  readonly default: T;
  readonly validate: (value: unknown) => value is T;
}

// `compensation.display_default` — the FIRST registered key (S2).
//
// Picks which GRANTED compensation view renders by DEFAULT on a freshly-
// loaded surface (recruiter dashboards, talent profile views, etc.).
// The 3 values mirror the D5 compensation:view:* scope axes:
//   - 'spread'   → the rate min/max view (recruiter baseline)
//   - 'markup'   → the bill-rate view (AM derivation surface)
//   - 'both'     → render both views side-by-side (the PO-chosen default)
//
// DISPLAY-ONLY. This setting does NOT change D5 field masking — the actor
// must still HOLD the corresponding `compensation:view:*` scope to see
// either view. If the picked default is a view the actor cannot see, the
// surface falls back to whatever views the actor IS granted (graceful;
// the picker never grants extra visibility).
//
// The PO ruling at Gate-5: `both` is the out-of-box default — give every
// recruiter the full picture and let those who prefer a single-view
// workflow narrow it via the tenant-console picker (S5).
//
// The closed-set enforcement chain (the S2 PRECEDENT):
//   1. typed accessor on `set<'compensation.display_default'>` constrains
//      `value` to `CompensationDisplayDefault` at COMPILE time
//   2. the validator predicate (this one) re-checks at RUNTIME — guards
//      against (a) raw HTTP bodies + (b) any future caller that bypasses
//      the parametric type by casting
//   3. the controller boundary calls the predicate BEFORE `set<K>` so a
//      bad value never reaches the DB (VALIDATION_ERROR at 400; details
//      carry the allowed-set so callers can self-correct)
export type CompensationDisplayDefault = 'spread' | 'markup' | 'both';

const COMPENSATION_DISPLAY_DEFAULT_VALUES: readonly CompensationDisplayDefault[] =
  Object.freeze(['spread', 'markup', 'both']);

// The runtime validator co-located with the key — the S2 PRECEDENT.
// Exported so the controller can introspect the allowed-set when shaping
// the VALIDATION_ERROR `details` (rather than re-declaring the closed
// list at the boundary).
export function isCompensationDisplayDefault(
  value: unknown,
): value is CompensationDisplayDefault {
  return (
    typeof value === 'string' &&
    (COMPENSATION_DISPLAY_DEFAULT_VALUES as readonly string[]).includes(value)
  );
}

// The closed-set registry. S2 lights up the first key; S3+ register
// additional keys here with NO migration (the pattern-B win).
//
// `as const` preserves the key as a string-literal type so `KnownSettingKey`
// below is the precise union.
export const KNOWN_SETTINGS = {
  'compensation.display_default': {
    key: 'compensation.display_default',
    default: 'both' as CompensationDisplayDefault,
    validate: isCompensationDisplayDefault,
  },
} as const satisfies Record<string, SettingDefinition<unknown>>;

// The union of every registered key. As of S2: the single
// `compensation.display_default` literal. Callers of
// `TenantSettingService.get<K>` / `set<K>` are constrained to this union —
// unknown keys fail to compile.
export type KnownSettingKey = keyof typeof KNOWN_SETTINGS;

// The value type for a specific known-key. Used by `get<K>` / `set<K>` so
// the call-site sees the precise per-key value type, not `unknown`.
export type SettingValueOf<K extends KnownSettingKey> =
  (typeof KNOWN_SETTINGS)[K] extends SettingDefinition<infer V> ? V : never;

// The list of registered keys (snapshot of `KNOWN_SETTINGS` keys). Used by
// `TenantSettingService.getAll` to materialize the full per-tenant settings
// view — every known-key gets its row-value-or-default; unknown DB rows
// are filtered out (forward-compatible: a row for a future-known-key
// written by a later version remains harmless to an older reader).
export const KNOWN_SETTING_KEYS: readonly KnownSettingKey[] =
  Object.freeze(Object.keys(KNOWN_SETTINGS) as KnownSettingKey[]);

// Type-narrowing guard for runtime-string -> KnownSettingKey. Exercised at
// the controller boundary on the `PUT /v1/tenant/settings/:key` path
// parameter — an unknown URL-key fails the predicate and surfaces as
// VALIDATION_ERROR (400) BEFORE `set<K>` is invoked. The closed-set-at-
// write security property: only registered keys reach the service.
export function isKnownSettingKey(value: unknown): value is KnownSettingKey {
  return (
    typeof value === 'string' &&
    (KNOWN_SETTING_KEYS as readonly string[]).includes(value)
  );
}
