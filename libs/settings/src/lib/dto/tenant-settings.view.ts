import type { KnownSettingKey, SettingValueOf } from '../known-settings.js';

// The materialized per-tenant settings view returned by
// `TenantSettingService.getAll` and serialized by the
// `GET /v1/tenant/settings` endpoint.
//
// Shape: every key registered in `KNOWN_SETTINGS` maps to its row-value (when
// a row exists for the tenant) or its code-defined default (when no row
// exists — the default-fallback). Unknown-to-the-server keys present in the
// database (forward-compatibility: an older reader against a newer writer)
// are filtered out — the view contains exactly the keys this version of the
// registry knows about.
//
// In S1 the registry is EMPTY (Gate-5 Ruling 1 — the minimal foundation),
// so a literal `{}` is the universal response body. The shape lights up as
// S2+ register known-keys.
export type TenantSettingsView = {
  readonly [K in KnownSettingKey]: SettingValueOf<K>;
};
