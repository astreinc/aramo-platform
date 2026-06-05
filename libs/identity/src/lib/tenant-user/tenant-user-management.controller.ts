import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { IdentityAuditService } from '../audit/identity-audit.service.js';

import { TenantUserLifecycleService } from './tenant-user-lifecycle.service.js';

// Settings S3a — TenantUserManagementController.
//
// Tenant-tier user lifecycle endpoints: invite + disable. The seeded
// `tenant:admin:user-manage` scope's first consumers. Audited via the
// S2 app-layer two-call seam (the controller injects both the lifecycle
// service AND IdentityAuditService; on the relevant success it calls
// the lifecycle method and then the audit emitter — keeping audit at
// the app boundary rather than buried in a service).
//
// Lives in libs/identity (parallel to D4aController) per the Settings
// charter §4.2 "user-management home = libs/identity". The Cognito
// cross-store calls reach AWS via TenantCognitoPort — a TS interface
// declared in libs/identity, with the AWS-SDK adapter wired by apps/api
// (apps/api owns the @aws-sdk/* dependency; libs/identity does not).
// At CI / unit-test the port is mocked (the AUTHZ-2 posture); the live
// adapter is a readiness carry.
//
// Guard chain (the A2 pattern, verbatim — matches D4aController +
// TenantSettingsController):
//   @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
//   @RequireCapability('core')                       — class-level (tenant axis)
//   @RequireScopes('tenant:admin:user-manage')       — route-level (scope axis)
//
// IMPLICIT-TENANT PATTERN: every route derives tenant_id from
// `authContext.tenant_id`. There is NO URL `{tenantId}` parameter or
// body field that the caller could override — per-tenant isolation is
// baked into the controller, NOT trusted to the body. A tenant_admin
// in tenant A cannot disable or invite into tenant B.
//
// D5 INTEGRITY BOUNDARY (load-bearing) at INVITE: a multi-role invite
// runs through the shared RoleBundleValidator BEFORE the Cognito leg.
// An invertible role-union returns 400 VALIDATION_ERROR with
// details.reason='invertible_role_union' and never produces a Cognito
// side effect.
@Controller('v1/tenant/users')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class TenantUserManagementController {
  constructor(
    private readonly lifecycle: TenantUserLifecycleService,
    private readonly audit: IdentityAuditService,
  ) {}

  // POST /v1/tenant/users/invitations — invite a new tenant user.
  //
  // Request: { email, display_name?, role_keys: string[] (>=1) }
  // Response (201): { user_id, membership_id, cognito_sub }
  //
  // Errors:
  //   400 VALIDATION_ERROR (empty role_keys; unknown role_key; invertible
  //                         role-union)
  //   502 COGNITO_PROVISION_FAILED (AdminCreateUser upstream)
  //   500 INTERNAL_ERROR (identity-tx failure post-Cognito; Cognito
  //                       compensated via AdminDeleteUser)
  //
  // The audit events for invite are emitted INSIDE createUserFromInvitation
  // (identity.user.created + identity.external_identity.linked +
  // identity.membership.created + identity.invitation.created). No
  // additional audit emission at this controller for invite.
  @Post('invitations')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('tenant:admin:user-manage')
  async invite(
    @AuthContext() authContext: AuthContextType,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ): Promise<{
    user_id: string;
    membership_id: string;
    cognito_sub: string;
  }> {
    const parsed = parseInviteBody(body, requestId);
    const result = await this.lifecycle.inviteTenantUser({
      tenant_id: authContext.tenant_id,
      email: parsed.email,
      display_name: parsed.display_name,
      role_keys: parsed.role_keys,
      actor_user_id: authContext.sub,
      request_id: requestId,
    });
    return {
      user_id: result.user.id,
      membership_id: result.membership_id,
      cognito_sub: result.cognito_sub,
    };
  }

  // POST /v1/tenant/users/:user_id/disable — soft-disable a tenant user.
  //
  // Request (optional): { reason?: string }
  // Response (200): { membership_id, changed, already_disabled }
  //
  // Errors:
  //   404 NOT_FOUND (user does not exist; or has no membership in
  //                  authContext.tenant_id — per-tenant isolation)
  //   502 COGNITO_PROVISION_FAILED (AdminDisableUser failed; the
  //                                 identity flip is rolled back via
  //                                 reEnableMembership compensation)
  //
  // Emits identity.tenant_user.disabled (tenant-scoped) ONLY when the
  // saga performed a true→false transition AND the Cognito leg
  // succeeded. An idempotent re-disable (already inactive) suppresses
  // emission per the S2 no-op-no-audit precedent.
  @Post(':user_id/disable')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('tenant:admin:user-manage')
  async disable(
    @AuthContext() authContext: AuthContextType,
    @Param('user_id') userId: string,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ): Promise<{
    membership_id: string;
    changed: boolean;
    already_disabled: boolean;
  }> {
    const reason = parseOptionalReason(body, requestId);
    const result = await this.lifecycle.disableTenantUser({
      tenant_id: authContext.tenant_id,
      user_id: userId,
      actor_user_id: authContext.sub,
      reason,
      request_id: requestId,
    });

    if (result.changed === true) {
      // App-layer two-call audit seam (the S2 PRECEDENT). Best-effort —
      // the IdentityAuditService wrapper swallows failures + warns; a
      // failed audit MUST NOT roll back the disable (the disable
      // already committed in identity + Cognito, both confirmed). The
      // S2 no-op-no-audit precedent: if changed=false (idempotent
      // re-disable) we do NOT emit.
      await this.audit.writeEvent({
        event_type: 'identity.tenant_user.disabled',
        actor_type: 'user',
        actor_id: authContext.sub,
        tenant_id: authContext.tenant_id,
        subject_id: userId,
        payload: {
          membership_id: result.membership_id,
          reason,
        },
      });
    }

    return result;
  }

  // PATCH /v1/tenant/users/:user_id/roles — role-assign (Settings S3b).
  //
  // Request: { role_keys: string[] (>=1) } — the DESIRED role-set
  //   (the reconciliation computes adds/removes against the current set).
  // Response (200): {
  //   membership_id,
  //   before_role_keys, after_role_keys,
  //   added_role_keys, removed_role_keys
  // }
  //
  // Errors:
  //   400 VALIDATION_ERROR (empty role_keys; unknown role_key; INVERTIBLE
  //                         role-union — the load-bearing D5 rejection)
  //   404 NOT_FOUND        (no membership for user_id in this tenant —
  //                         per-tenant isolation)
  //
  // THE D5 INTEGRITY GATE (load-bearing) — the merged RoleBundleValidator
  // asserts the UNION of the requested role-set's scopes is non-invertible
  // BEFORE the reconcile commits. An invertible union NEVER persists. See
  // TenantUserLifecycleService.assignTenantUserRoles step 1.
  //
  // AUDIT (two-call seam — S2 precedent):
  //   - added_role_keys.length > 0 → emit identity.tenant_user.role_assigned
  //   - removed_role_keys.length > 0 → emit identity.tenant_user.role_removed
  //   - both empty (no-op PATCH; role-set unchanged) → NEITHER event emitted
  //     (the S2 no-op-no-audit precedent extended to two-event reconciles).
  // Each event's payload carries the full before/after sets so the audit
  // row reads as a coherent change-log entry on its own.
  @Patch(':user_id/roles')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('tenant:admin:user-manage')
  async assignRoles(
    @AuthContext() authContext: AuthContextType,
    @Param('user_id') userId: string,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ): Promise<{
    membership_id: string;
    before_role_keys: string[];
    after_role_keys: string[];
    added_role_keys: string[];
    removed_role_keys: string[];
  }> {
    const role_keys = parseAssignRolesBody(body, requestId);
    const result = await this.lifecycle.assignTenantUserRoles({
      tenant_id: authContext.tenant_id,
      user_id: userId,
      role_keys,
      actor_user_id: authContext.sub,
      request_id: requestId,
    });

    // App-layer two-call audit seam — per-delta gating. The S2 precedent
    // says no-op writes emit no audit; here that generalizes to per-event
    // (an assignment with only adds emits ONLY role_assigned; with only
    // removes, ONLY role_removed; with both deltas, BOTH events; with
    // neither, NEITHER).
    if (result.added_role_keys.length > 0) {
      await this.audit.writeEvent({
        event_type: 'identity.tenant_user.role_assigned',
        actor_type: 'user',
        actor_id: authContext.sub,
        tenant_id: authContext.tenant_id,
        subject_id: userId,
        payload: {
          membership_id: result.membership_id,
          added_role_keys: result.added_role_keys,
          before_role_keys: result.before_role_keys,
          after_role_keys: result.after_role_keys,
        },
      });
    }
    if (result.removed_role_keys.length > 0) {
      await this.audit.writeEvent({
        event_type: 'identity.tenant_user.role_removed',
        actor_type: 'user',
        actor_id: authContext.sub,
        tenant_id: authContext.tenant_id,
        subject_id: userId,
        payload: {
          membership_id: result.membership_id,
          removed_role_keys: result.removed_role_keys,
          before_role_keys: result.before_role_keys,
          after_role_keys: result.after_role_keys,
        },
      });
    }

    return result;
  }
}

// --- helpers --------------------------------------------------------------

interface ParsedInviteBody {
  email: string;
  display_name: string | null;
  role_keys: readonly string[];
}

function parseInviteBody(body: unknown, requestId: string): ParsedInviteBody {
  if (typeof body !== 'object' || body === null) {
    throw new AramoError('VALIDATION_ERROR', 'request body required', 400, {
      requestId,
      details: { reason: 'missing_body' },
    });
  }
  const obj = body as Record<string, unknown>;
  const email = obj['email'];
  if (typeof email !== 'string' || email.length === 0) {
    throw new AramoError('VALIDATION_ERROR', 'email is required', 400, {
      requestId,
      details: { reason: 'invalid_email' },
    });
  }
  const display_name_raw = obj['display_name'];
  const display_name =
    display_name_raw === undefined || display_name_raw === null
      ? null
      : typeof display_name_raw === 'string'
        ? display_name_raw
        : null;
  const role_keys_raw = obj['role_keys'];
  if (!Array.isArray(role_keys_raw) || role_keys_raw.length === 0) {
    throw new AramoError(
      'VALIDATION_ERROR',
      'role_keys must be a non-empty array of strings',
      400,
      { requestId, details: { reason: 'empty_role_keys' } },
    );
  }
  const role_keys: string[] = [];
  for (const rk of role_keys_raw) {
    if (typeof rk !== 'string' || rk.length === 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'role_keys must be non-empty strings',
        400,
        { requestId, details: { reason: 'invalid_role_key_item' } },
      );
    }
    role_keys.push(rk);
  }
  return { email, display_name, role_keys };
}

// Settings S3b — parse PATCH role-assign body. Shape mirrors invite's
// role_keys validation (the §3 union check fires later — this just
// enforces the array shape). Empty array rejected at the controller as a
// belt-and-suspenders check; the lifecycle service also rejects empty.
function parseAssignRolesBody(
  body: unknown,
  requestId: string,
): string[] {
  if (typeof body !== 'object' || body === null) {
    throw new AramoError('VALIDATION_ERROR', 'request body required', 400, {
      requestId,
      details: { reason: 'missing_body' },
    });
  }
  const obj = body as Record<string, unknown>;
  const role_keys_raw = obj['role_keys'];
  if (!Array.isArray(role_keys_raw) || role_keys_raw.length === 0) {
    throw new AramoError(
      'VALIDATION_ERROR',
      'role_keys must be a non-empty array of strings',
      400,
      { requestId, details: { reason: 'empty_role_keys' } },
    );
  }
  const role_keys: string[] = [];
  for (const rk of role_keys_raw) {
    if (typeof rk !== 'string' || rk.length === 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'role_keys must be non-empty strings',
        400,
        { requestId, details: { reason: 'invalid_role_key_item' } },
      );
    }
    role_keys.push(rk);
  }
  return role_keys;
}

function parseOptionalReason(body: unknown, requestId: string): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body !== 'object') {
    throw new AramoError('VALIDATION_ERROR', 'request body must be an object', 400, {
      requestId,
      details: { reason: 'invalid_body' },
    });
  }
  const obj = body as Record<string, unknown>;
  if (!('reason' in obj) || obj['reason'] === undefined || obj['reason'] === null) {
    return null;
  }
  if (typeof obj['reason'] !== 'string') {
    throw new AramoError('VALIDATION_ERROR', 'reason must be a string', 400, {
      requestId,
      details: { reason: 'invalid_reason' },
    });
  }
  return obj['reason'];
}
