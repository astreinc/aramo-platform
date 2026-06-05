import { Injectable } from '@nestjs/common';

import type { TenantSettingsView } from './dto/tenant-settings.view.js';
import {
  KNOWN_SETTINGS,
  KNOWN_SETTING_KEYS,
  type KnownSettingKey,
  type SettingValueOf,
} from './known-settings.js';
import { TenantSettingRepository } from './tenant-setting.repository.js';

// TenantSettingService — the S1 read seam (Gate-5 Ruling 3).
//
// Shape: read-through with default-fallback.
//   - get<K>(tenant, key) -> row-value (when present) or code-default
//     (never throws; missing key is the default-fallback, not an error)
//   - getAll(tenant)      -> materialized per-tenant view: every known-key
//                            mapped to its row-value-or-default
//
// No memoization in S1 (Gate-5 Ruling 3): config reads are cold-path; the
// D4b visibility-resolver memo pattern was driven by per-request re-resolution
// across many entities, which has no analog here. Caching is added later if
// (and only if) a hot path emerges.
//
// Parametric typing: `get<K extends KnownSettingKey>` constrains callers to
// the closed-set registry; an unknown key fails to compile rather than
// silently returning undefined. The JSONB column's `unknown` value is
// projected back through `SettingValueOf<K>` — the per-key value type the
// registry declared.
//
// READ-ONLY surface in S1 (intentional — the directive §0 "MINIMAL by
// design"). The write path + its validator + its audit-event shape land
// with S2 (the pricing-model-default key is the concrete first writer).
@Injectable()
export class TenantSettingService {
  constructor(private readonly repository: TenantSettingRepository) {}

  // Single-key read with default-fallback. Never throws.
  //
  // Behavior:
  //   - Row exists for (tenant, key): return the stored JSONB value cast
  //     to `SettingValueOf<K>` (the typed-accessor projection).
  //   - No row: return `KNOWN_SETTINGS[key].default` — the code-defined
  //     default. This is the import-config TODO-consumer pattern:
  //     env-or-default today, tenant-or-default after the future
  //     migration.
  //
  // The `as` cast at the row-value path is the typed-accessor's load-
  // bearing assumption: callers (the only callers permitted are the typed
  // `K extends KnownSettingKey`) trust that any value the system wrote
  // was the V the registry declared. S2's write path enforces this at
  // write time (the validator step); S1 only reads, so the cast is
  // sound by induction over empty writes.
  async get<K extends KnownSettingKey>(
    tenantId: string,
    key: K,
  ): Promise<SettingValueOf<K>> {
    // The empty-registry (S1) edge: when `KNOWN_SETTINGS` has no entries,
    // `K extends never` and this code path is statically unreachable. The
    // explicit cast lets the body compile against the empty registry while
    // still preserving the typed-accessor contract for S2+ callers (whose
    // `K` is a concrete key).
    const registry = KNOWN_SETTINGS as Readonly<
      Record<string, { default: unknown } | undefined>
    >;
    // By construction the entry exists — `K extends KnownSettingKey` means
    // `key` is a registered key. The explicit guard satisfies
    // noUncheckedIndexedAccess and serves as a defense-in-depth tripwire
    // (if it ever fires, a downstream contract was violated).
    const definition = registry[key];
    if (definition === undefined) {
      throw new Error(`KNOWN_SETTINGS missing entry for key '${key}'`);
    }
    const row = await this.repository.findOne(tenantId, key);
    if (row === null) {
      return definition.default as SettingValueOf<K>;
    }
    return row.value as SettingValueOf<K>;
  }

  // Materialize the full per-tenant settings view. Every registered known-key
  // appears with its row-value (when present) or its code-default (when
  // absent). DB rows for unknown-to-this-version keys are filtered out
  // (forward-compat: a newer writer's row remains harmless to an older
  // reader's view).
  //
  // In S1 the registry is EMPTY (Gate-5 Ruling 1), so the response is
  // literally `{}` for every tenant. The shape lights up as S2+ register
  // their known-keys.
  async getAll(tenantId: string): Promise<TenantSettingsView> {
    const rows = await this.repository.findAllForTenant(tenantId);
    const rowMap = new Map<string, unknown>();
    for (const r of rows) rowMap.set(r.key, r.value);

    // Same empty-registry cast as `get<K>` — the iteration is over zero
    // entries in S1, so the indexing never runs at all; the cast lets the
    // body compile against the empty registry shape.
    const registry = KNOWN_SETTINGS as Readonly<
      Record<string, { default: unknown } | undefined>
    >;
    const view: Record<string, unknown> = {};
    for (const key of KNOWN_SETTING_KEYS) {
      if (rowMap.has(key)) {
        view[key] = rowMap.get(key);
      } else {
        // Same construction-soundness reasoning as `get<K>`: `key` comes
        // from `KNOWN_SETTING_KEYS`, which is `Object.keys(KNOWN_SETTINGS)`.
        const entry = registry[key];
        if (entry === undefined) {
          throw new Error(`KNOWN_SETTINGS missing entry for key '${key}'`);
        }
        view[key] = entry.default;
      }
    }
    return view as TenantSettingsView;
  }
}
