import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';

import type { TenantSettingsView } from './dto/tenant-settings.view.js';
import {
  KNOWN_SETTINGS,
  KNOWN_SETTING_KEYS,
  type KnownSettingKey,
  type SettingDefinition,
  type SettingValueOf,
} from './known-settings.js';
import { PrismaService } from './prisma/prisma.service.js';
import { TenantSettingRepository } from './tenant-setting.repository.js';

// TenantSettingService — the read seam (S1) + the write seam (S2).
//
// Shape:
//   - get<K>(tenant, key)              -> row-value (when present) or
//                                          code-default (never throws)
//   - getAll(tenant)                   -> materialized per-tenant view
//   - set<K>(tenant, key, value, by)   -> {key, value, previous_value}
//                                          (read-then-upsert in $transaction;
//                                          records last_modified_by; the
//                                          validator runs before the write)
//
// Parametric typing: `K extends KnownSettingKey` constrains callers to the
// closed-set registry; an unknown key fails to compile rather than silently
// returning undefined OR silently writing to a phantom key. The JSONB
// column's `unknown` value is projected back through `SettingValueOf<K>`.
//
// S2 PRECEDENT: the validator step. Every write runs `definition.validate`
// against the incoming value (the SettingDefinition co-locates type +
// default + validator). Bad values throw VALIDATION_ERROR (400). The
// `details.reason` is fixed at `'invalid_value'` so callers can
// distinguish bad-value from unknown-key (the controller's
// `isKnownSettingKey` returns false at the boundary BEFORE `set<K>` is
// invoked; rejecting unknown keys with the same error code but a
// different `reason` keeps both halves of the closed-set-at-write
// invariant introspectable).
//
// AUDIT SEAM: the service does NOT emit identity.tenant_setting.updated —
// the controller emits it (the app-layer two-call seam, Gate-5 Ruling 1).
// This preserves the LEAF: libs/settings imports only @aramo/common
// (NO @aramo/identity), mirroring D5's field-mask interceptor placement
// (terminal lib + app-level cross-cutting wire).
@Injectable()
export class TenantSettingService {
  constructor(
    private readonly repository: TenantSettingRepository,
    private readonly prisma: PrismaService,
  ) {}

  // Single-key read with default-fallback. Never throws.
  //
  // Behavior:
  //   - Row exists for (tenant, key): return the stored JSONB value cast
  //     to `SettingValueOf<K>` (the typed-accessor projection).
  //   - No row: return `KNOWN_SETTINGS[key].default` — the code-defined
  //     default.
  //
  // The `as` cast at the row-value path is the typed-accessor's load-
  // bearing assumption: callers (the only callers permitted are the typed
  // `K extends KnownSettingKey`) trust that any value the system wrote
  // was the V the registry declared. S2's write path enforces this at
  // write time via the validator step.
  async get<K extends KnownSettingKey>(
    tenantId: string,
    key: K,
  ): Promise<SettingValueOf<K>> {
    const definition = KNOWN_SETTINGS[key];
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
  async getAll(tenantId: string): Promise<TenantSettingsView> {
    const rows = await this.repository.findAllForTenant(tenantId);
    const rowMap = new Map<string, unknown>();
    for (const r of rows) rowMap.set(r.key, r.value);

    const view: Record<string, unknown> = {};
    for (const key of KNOWN_SETTING_KEYS) {
      // INTERNAL keys (e.g. metrics.goals) are valid + writable but are not part
      // of the tenant-admin settings surface — the recruiter desk reads them
      // directly, so they're excluded from this materialized view.
      if ((KNOWN_SETTINGS[key] as SettingDefinition<unknown>).internal === true)
        continue;
      if (rowMap.has(key)) {
        view[key] = rowMap.get(key);
      } else {
        view[key] = KNOWN_SETTINGS[key].default;
      }
    }
    return view as TenantSettingsView;
  }

  // S2 write path. Read-then-upsert in a single $transaction so the
  // previous_value capture cannot race against a concurrent setter.
  //
  // Returns `{key, value, previous_value}`:
  //   - `value`           — the value the caller just set (post-validation)
  //   - `previous_value`  — the row's prior JSONB value, or `null` when
  //                         no row existed (first-set; the row was
  //                         INSERTed, not UPDATEd)
  //
  // The validator runs FIRST. A value that fails `definition.validate`
  // throws VALIDATION_ERROR (400) with `details.reason='invalid_value'`
  // and the allowed-set surfaced (when introspectable from the
  // definition). The DB is never touched on a bad-value path.
  //
  // requestId threads the AramoError context for halt-and-surface
  // observability (the consent.controller / import.controller pattern).
  async set<K extends KnownSettingKey>(
    tenantId: string,
    key: K,
    value: unknown,
    actorUserId: string,
    requestId: string,
  ): Promise<{
    key: K;
    value: SettingValueOf<K>;
    previous_value: SettingValueOf<K> | null;
  }> {
    const definition = KNOWN_SETTINGS[key];
    if (!definition.validate(value)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        `invalid value for setting '${String(key)}'`,
        400,
        {
          requestId,
          details: { reason: 'invalid_value', key },
        },
      );
    }
    // Defense-in-depth: the controller `isKnownSettingKey` guard rejects
    // unknown keys at the boundary; the typed signature here re-enforces
    // it via `K extends KnownSettingKey`. No runtime check needed past
    // the validator step.
    return this.prisma.$transaction(async (tx) => {
      const existing = await this.repository.findOneOnTx(tx, tenantId, key);
      await this.repository.upsertOnTx(tx, tenantId, key, value, actorUserId);
      return {
        key,
        value: value as SettingValueOf<K>,
        previous_value:
          existing === null ? null : (existing.value as SettingValueOf<K>),
      };
    });
  }
}
