import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import { IdentityAuditService } from '@aramo/identity';
import {
  isKnownSettingKey,
  KNOWN_SETTINGS,
  TenantSettingService,
  type KnownSettingKey,
  type SettingValueOf,
  type TenantSettingsView,
} from '@aramo/settings';

// TenantSettingsController — Settings S1 (GET) + S2 (PUT).
//
// Lives in apps/api (NOT in libs/settings) so the leaf-lib invariant on
// libs/settings holds: the lib imports only @aramo/common, while the
// guard-chain dependencies (@aramo/auth + @aramo/authorization +
// @aramo/entitlement) AND the audit-emission edge (@aramo/identity for
// IdentityAuditService) live at the application boundary that wires them.
// This mirrors the D5 field-mask interceptor placement (terminal lib +
// app-level cross-cutting wire).
//
// Guard chain (the A2 pattern, verbatim — matches D4aController):
//   @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
//   @RequireCapability('core')   — class-level (tenant axis); `core` is the
//                                  baseline tenant capability (every tenant
//                                  has it by virtue of being a tenant).
//   @RequireScopes('tenant:admin:settings')   — route-level (scope axis);
//                                                tenant_admin only per the
//                                                AUTHZ-1 catalog comment.
//                                                Same scope for read+write
//                                                in S2 (a :read / :write
//                                                split is over-granular for
//                                                one consumer — Gate-5
//                                                Ruling 4; revisit at S4 if
//                                                an Auditor view-only need
//                                                surfaces).
//
// Implicit-tenant pattern: every route is scoped to the authenticated
// tenant via `authContext.tenant_id`. NO URL `{tenantId}` path parameter
// that the caller could override. Per-tenant isolation is the ambient
// `WHERE tenant_id = authContext.tenant_id` baked into the repository.
//
// S2 — the WRITE PATH lands. PUT /v1/tenant/settings/:key is the
// REST-correct idempotent set (key in URL, value in body). The closed-set
// enforcement happens here BEFORE the service is invoked:
//   - unknown key  → VALIDATION_ERROR 400 with details.reason='unknown_key'
//   - bad value    → VALIDATION_ERROR 400 with details.reason='invalid_value'
//                    (delegated to the per-key validator on the
//                    SettingDefinition — the S2 PRECEDENT for S3/S4/S6+)
//
// AUDIT SEAM (Gate-5 Ruling 1 — Option A, the app-layer two-call): the
// controller injects BOTH TenantSettingService AND IdentityAuditService;
// on a successful write it calls settings.set() then audit.writeEvent()
// with identity.tenant_setting.updated. libs/settings has NO @aramo/
// identity import — the seam is here. The two-call is non-atomic by
// design (the program-wide best-effort audit posture: a failed audit
// must NEVER block the write).
@Controller('v1/tenant')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class TenantSettingsController {
  constructor(
    private readonly tenantSettings: TenantSettingService,
    private readonly audit: IdentityAuditService,
  ) {}

  // GET /v1/tenant/settings — return the materialized per-tenant settings
  // view (every known-key mapped to its row-value-or-default).
  @Get('settings')
  @RequireScopes('tenant:admin:settings')
  async getTenantSettings(
    @AuthContext() authContext: AuthContextType,
  ): Promise<TenantSettingsView> {
    return this.tenantSettings.getAll(authContext.tenant_id);
  }

  // PUT /v1/tenant/settings/:key — idempotent set of a single known-key.
  //
  // Request:  { value: <SettingValueOf<key>> }
  // Response: 200 { key, value, previous_value }
  //   previous_value is null on a first-set (no prior row); otherwise it
  //   is the value the row carried before this PUT. The audit-event
  //   payload mirrors this shape exactly.
  //
  // 200 always (never 201/204): the client requested an idempotent set;
  // they don't need to distinguish create vs. update at the HTTP layer
  // (the previous_value in the body signals which path ran).
  @Put('settings/:key')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('tenant:admin:settings')
  async setTenantSetting(
    @AuthContext() authContext: AuthContextType,
    @Param('key') rawKey: string,
    @Body() body: { value: unknown },
    @RequestId() requestId: string,
  ): Promise<{
    key: KnownSettingKey;
    value: SettingValueOf<KnownSettingKey>;
    previous_value: SettingValueOf<KnownSettingKey> | null;
  }> {
    // Boundary closed-set check (the S2 PRECEDENT, half 1 of 2). An
    // unknown URL-key fails before `set<K>` is invoked — defense-in-depth
    // for the typed-accessor `K extends KnownSettingKey` constraint
    // (which catches it at compile time for direct service callers but
    // not for raw HTTP). VALIDATION_ERROR carries the allowed-set so the
    // caller can self-correct.
    if (!isKnownSettingKey(rawKey)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        `unknown setting key '${rawKey}'`,
        400,
        {
          requestId,
          details: {
            reason: 'unknown_key',
            key: rawKey,
            allowed_keys: Object.keys(KNOWN_SETTINGS),
          },
        },
      );
    }
    const key: KnownSettingKey = rawKey;
    // Boundary value-shape check on the request envelope. A request body
    // that is not an object (or omits `value`) is malformed; reject
    // before the per-key validator (which would reject anyway, but with
    // a less specific message).
    if (typeof body !== 'object' || body === null || !('value' in body)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'request body must be { value: <T> }',
        400,
        { requestId, details: { reason: 'missing_value', key } },
      );
    }
    // The service applies the per-key validator (S2 PRECEDENT half 2 of
    // 2). Bad-value -> VALIDATION_ERROR with details.reason='invalid_value'.
    // Good-value -> read-then-upsert in a $transaction; returns the
    // atomic {key, value, previous_value}.
    const result = await this.tenantSettings.set(
      authContext.tenant_id,
      key,
      body.value,
      authContext.sub,
      requestId,
    );

    // App-layer two-call audit seam (Gate-5 Ruling 1). identity.tenant_
    // setting.updated is tenant-scoped (TENANT_SCOPED_EVENT_TYPES); the
    // subject is the setting key (one row per setting per tenant — the
    // composite PK makes the key a stable subject id for cross-event
    // correlation). Best-effort: the wrapper swallows write failures
    // and logs at warn level — the setting write already committed and
    // must not be rolled back on audit failure.
    await this.audit.writeEvent({
      event_type: 'identity.tenant_setting.updated',
      actor_type: 'user',
      actor_id: authContext.sub,
      tenant_id: authContext.tenant_id,
      subject_id: result.key,
      payload: {
        key: result.key,
        value: result.value,
        previous_value: result.previous_value,
      },
    });

    return result;
  }
}
